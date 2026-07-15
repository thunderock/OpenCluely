---
slug: ollama-not-detected
status: resolved
trigger: |
  DATA_START
  Onboarding "Step 3 of 3 — Set up your local model engine" shows "Ollama engine —
  not found / Not running" and blocks Continue, even though Ollama IS installed and
  running (qwen3-vl:8b already pulled). Clicking "Re-check" does not detect the
  running engine. "why do I still see [this] when ollama is already installed".
  DATA_END
created: 2026-07-14
updated: 2026-07-14
tags: [phase-03, local-engine, onboarding, macos, electron, fetch, transport]
---

# Debug: Ollama not detected in onboarding (Step 3)

## Symptoms

- **Expected:** On the onboarding `ollama` screen, with Ollama installed and the daemon running, detection reports the engine found/running and unblocks Continue.
- **Actual:** Screen shows "Ollama engine — not found" + status "Not running"; Continue stays disabled. Re-check does not flip it.
- **Error/on-screen:** ollama-screen "not found" (onboarding.js:504) + "Not running" pill (onboarding.js:505) — BOTH are driven by the single boolean `state.ollamaDetected = !!getModelStatus().serverUp` (onboarding.js:492-493), gated by `canAdvance()` (onboarding.js:165). (The `:271` "not found" is the unrelated whisper screen.)
- **Timeline:** First run of the Phase-3 local-engine onboarding (new feature, 03-06). Never worked on this machine.
- **Reproduction:** Launch via `npm start` (dev Electron), reach Step 3 with Ollama installed + daemon running on 127.0.0.1:11434, click Re-check → still "not found / Not running".
- **Environment:** macOS Darwin 25.5 (Apple Silicon arm64), Ollama 0.32.0, launched via `npm start`. `ollama` on shell PATH at `/opt/homebrew/bin/ollama` and `/usr/local/bin/ollama`.

## Current Focus

- root_cause (CONFIRMED): `getStatus().serverUp` is computed by `_probeVersion()` (local-model.manager.js:146,216-228), which probes the daemon with the **ambient global `fetch`**. In the Electron **main process**, that global `fetch` is Chromium-`net`-backed and FAILS for the loopback Ollama daemon — whereas Node's `http` transport reaches the same daemon fine. So a running, HTTP-reachable daemon is reported `serverUp:false`, which blocks Continue. This is NOT a binary-PATH problem and NOT "serverUp probes the binary" — those parts of the original hypothesis are eliminated below.
- proof: application-2026-07-14.log 17:56:15 "Local model manager started" logs `state:'adopted', adopted:true` (the supervisor's Node-`http` `probeHttp` to 127.0.0.1:11434 SUCCEEDED → it adopted the running daemon) **and** `serverUp:false` in the SAME object / same instant / same process. Two probes to the same host at the same moment: Node `http` succeeds, global `fetch` fails.
- test: RED regression test added — test/local-model-manager.test.js test #8 ("getStatus().serverUp stays true when the daemon is HTTP-reachable but global fetch is broken"). Network-free: real loopback `http` daemon + `globalThis.fetch` stubbed to throw (faithful proxy for the Electron-main condition). Confirmed **RED** against current code: `false !== true` at test:287.
- next_action: DONE — [GREEN] applied: `_probeVersion()` now probes `/api/version` via `ServiceSupervisor.probeHttp` (Node `http`), dropping the global-`fetch` dependency. Regression test #8 flipped RED→GREEN; both whole-repo gates green (`node --test test/*.test.js` 84/84; `npx eslint .` clean). Fix+test+debug-file committed atomically (explicit pathspec). See ## Resolution.

## Evidence

- timestamp: 2026-07-14 — Daemon IS reachable: `curl -s http://127.0.0.1:11434/api/version` and `/api/tags` both return HTTP 200. So "Not running" is a FALSE negative.
- timestamp: 2026-07-14 — Onboarding gate: the ollama screen's "not found" (onboarding.js:504) AND "Not running" pill (onboarding.js:505) are BOTH set from one value — `state.ollamaDetected = !!s.serverUp`, `s = getModelStatus()` (onboarding.js:492-493); `canAdvance('ollama')` returns `state.ollamaDetected` (onboarding.js:165). IPC `get-model-status` → `LocalModelManager.getStatus()` (main.js:809-815).
- timestamp: 2026-07-14 — `_probeVersion()` is ALREADY a pure HTTP probe to `this.host` (`fetch(\`${host}/api/version\`)`, local-model.manager.js:216-228); it does NOT touch the binary. So "make serverUp a pure HTTP probe" was already true — the defect is the fetch TRANSPORT, not a spawn/PATH check.
- timestamp: 2026-07-14 — SMOKING GUN: application-2026-07-14.log 17:56:15 — `Local model manager started { state:'adopted', adopted:true, serverUp:false, ... }`. The supervisor's `probeHttp` (Node `http`) adopted the daemon at the same instant `_probeVersion` (global `fetch`) returned false. Same host, same moment, opposite results ⇒ transport-specific failure.
- timestamp: 2026-07-14 — Transport diff: `ServiceSupervisor.probeHttp` uses `http.get` (service-supervisor.js:59-68); `_probeVersion` uses the global `fetch` (local-model.manager.js:221). Electron's main-process global `fetch` is Chromium-`net`-backed and fails for loopback where Node `http` works — the classic Electron-main fetch gotcha.
- timestamp: 2026-07-14 — Live repro (daemon up): under system node v26 AND `ELECTRON_RUN_AS_NODE=1` (Electron's Node v20, pure **undici** — NOT the Chromium-net path) with full PATH, `_probeVersion()`=true, `getStatus().serverUp`=true, `ollamaBin=/opt/homebrew/bin/ollama`. The bug does NOT reproduce in pure-Node undici; it is specific to the full Electron main process's Chromium-net `fetch` — consistent with the on-device log.
- timestamp: 2026-07-14 — Secondary (NOT the gate): earlier 07-14 entries (15:48–16:39) logged `reason:'not-installed', installed:false` from `start()` (ollamaBin null). The onboarding gate is `serverUp` from `getStatus()` (not `start()`), and the 17:56 run resolved the binary (adopted) yet STILL reported `serverUp:false` — so the fetch-transport defect is the real, persistent blocker independent of binary resolution. Fixing `_probeVersion` also flips both ollama-screen labels (both read `serverUp`). Binary-resolve hardening is therefore out of scope for the minimal fix.
- timestamp: 2026-07-14 — Test seams (network-free): `test/local-model-manager.test.js` injects fake `ollama`/`supervisor`/`spawn` via constructor DI and stubs `manager._probeVersion`; the new test #8 instead runs the REAL `_probeVersion` against a loopback `http` server with `globalThis.fetch` stubbed to throw — proving `serverUp` must not depend on the global fetch.

## Eliminated

- ELIMINATED — "serverUp is gated on resolving/spawning the ollama binary via PATH." `getStatus().serverUp` calls `_probeVersion()`, a pure HTTP probe that never touches the binary. Proven by the 17:56 log (binary resolved → adopted) where serverUp was still false.
- ELIMINATED — "macOS GUI/Electron reduced PATH is the gate cause." The reduced PATH only affects `_resolveOllamaBin` (which/where); `fs.existsSync` fallbacks resolve `/opt/homebrew/bin/ollama` regardless of PATH, and the 17:56 run adopted the daemon with the binary resolved — yet serverUp stayed false. The blocker is the fetch transport, not PATH.
- ELIMINATED — proxy/host env redirection (`OLLAMA_BASE_URL`/`HTTP(S)_PROXY`/`NO_PROXY` all unset); wrong host (config resolves `http://127.0.0.1:11434`); `/api/version` path (curl + undici repro both 200); IPv6/`localhost` resolution (host is literal IPv4 `127.0.0.1`).

## Resolution

- root_cause: `getStatus().serverUp` came from `_probeVersion()` (local-model.manager.js:216-228), which probed `${host}/api/version` with the **ambient global `fetch`**. In the Electron **main** process that global `fetch` is Chromium-`net`-backed and returns a false negative for the loopback Ollama daemon, whereas Node's `http` transport reaches the same daemon fine. Proof: application-2026-07-14.log 17:56:15 logged `state:'adopted', adopted:true` (supervisor Node-`http` `probeHttp` succeeded) **and** `serverUp:false` in the same object/instant/process. Both onboarding labels ("not found" + "Not running" pill, onboarding.js:504-505) and the Continue gate (`canAdvance('ollama')`, onboarding.js:165) are driven by that single boolean, so the false negative blocked Continue.
- fix: Rewrote `_probeVersion()` to probe `/api/version` over Node `http` via `ServiceSupervisor.probeHttp` — the same deterministic transport the supervisor already uses to adopt the daemon — dropping the global-`fetch` dependency. Parses `this.host` with `URL` for host/port, keeps it timeout-bounded (`timeoutMs`, default 1000), and stays graceful (returns `false` on any error). No unrelated code touched. Fixing this one method flips both ollama-screen labels and the Continue gate, since all read `serverUp`.
- verification:
  - RED→GREEN: `node --test test/local-model-manager.test.js` — test #8 "getStatus().serverUp stays true when the daemon is HTTP-reachable but global fetch is broken" (real loopback `http` daemon + `globalThis.fetch` stubbed to throw) now PASSES; was failing `false !== true` at test:287 before the fix. All 9 tests in the file pass.
  - Whole-repo gate 1: `node --test test/*.test.js` → 84 tests, 84 pass, 0 fail.
  - Whole-repo gate 2: `npx eslint .` → exit 0, clean (`URL` is a Node global; `ServiceSupervisor` already imported; `catch (_)` exempt).
- files_changed:
  - src/core/local-model.manager.js — `_probeVersion()` now uses `ServiceSupervisor.probeHttp` (Node `http`) instead of the global `fetch`.
  - test/local-model-manager.test.js — added regression test #8 (RED→GREEN) proving `serverUp` must not depend on the global fetch.
