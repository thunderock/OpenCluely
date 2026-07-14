---
phase: 03-local-engine-cloud-removal
plan: 04
subsystem: infra
tags: [ollama, service-supervisor, model-lifecycle, ipc, preflight, local-llm, qwen3-vl]

# Dependency graph
requires:
  - phase: 03-01
    provides: "config.llm.local ({ host, model, keepAlive, curatedModels }) + require()-safe ollama npm client"
  - phase: 01-foundation
    provides: "generic ServiceSupervisor (adopt-if-present/own-if-started, HTTP health, SIGTERM→SIGKILL, DI spawn seam)"
provides:
  - "LocalModelManager: configures ServiceSupervisor (adopt:true) for the Ollama daemon — adopts a running one, spawns only when absent, never kills a foreign daemon"
  - "ensureModel/pullModel: resumable, checksummed model pull with structured { status, percent, completed, total } progress; cache stays at Ollama's default (~/.ollama/models)"
  - "warmUp keep_alive:-1 (resident regardless of adopt/own) + serve env when owned"
  - "preflight: disk/RAM warn-not-block (friendly failure)"
  - "getStatus: owned-vs-adopted + three-level health (serverUp / modelPresent / modelResponds)"
  - "local-engine IPC surface (download-model, get-model-status, list-installed-models, model-preflight, recover-model, test-provider-connection) + model-pull-progress stream + preload bridges"
affects: [03-05, 03-06, 03-07, 03-08]

# Tech tracking
tech-stack:
  added: []  # ollama npm client was installed in 03-01; this plan consumes it (no new deps — honored)
  patterns:
    - "First real ServiceSupervisor consumer: a thin configurator (adopt:true + HTTP health on 11434) over the Phase-1 supervisor"
    - "Structured IPC progress twin of the whisper download-progress pattern: { status, percent } over 'model-pull-progress' (vs whisper's opaque log lines)"
    - "Three-level health fusion (supervisor lifecycle state + serverUp + modelPresent + modelResponds) as distinct fields for distinct UI messages"
    - "DI-seam manager (supervisor/ollama/spawn/config/logger injectable, default to real singletons) — network-free unit-testable"

key-files:
  created:
    - src/core/local-model.manager.js
    - test/local-model-manager.test.js
  modified:
    - main.js
    - preload.js

key-decisions:
  - "LocalModelManager is a thin configurator over ServiceSupervisor (adopt:true, HTTP health on 11434) — no bespoke lifecycle; SIGTERM→SIGKILL on the owned child is the locked mechanism (no tree-kill/get-port/execa)"
  - "keep_alive:-1 delivered belt-and-suspenders: OLLAMA_KEEP_ALIVE env when WE spawn + an always-on warm-up generate({ keep_alive:-1 }) that also holds for an adopted daemon (RESEARCH Open Q1)"
  - "_ownsSupervisor guard: the start() 'binary-not-found → not-installed' check only fires when the manager built its own supervisor, so an injected supervisor (tests, future DI) is trusted and adopt/own is provable network-free"
  - "IPC handlers are provider-neutral/local-named (download-model, get-model-status, recover-model, test-provider-connection) so they survive the PROV-07 Gemini removal"
  - "recover-model 'restart' only restarts a daemon WE own; an adopted daemon isn't ours to restart (surface status so the UI guides the user)"

patterns-established:
  - "Pattern: adopt/own service manager = ServiceSupervisor def + three-level app-level health on top of the generic HTTP probe"
  - "Pattern: structured progress IPC (percent + status) mirroring an existing opaque-log progress channel"

# Metrics
duration: 11min
completed: 2026-07-14
---

# Phase 3 Plan 4: LocalModelManager Summary

**LocalModelManager adopts/owns Ollama via the Phase-1 ServiceSupervisor (never killing a foreign daemon), pulls qwen3-vl:8b with resumable structured progress, keeps it resident (keep_alive:-1), warn-not-block preflights disk/RAM, and reports owned-vs-adopted + three-level health — wired into app lifecycle and a provider-neutral IPC surface.**

## Performance

- **Duration:** 11 min
- **Started:** 2026-07-14T20:48:35Z
- **Completed:** 2026-07-14T21:00:19Z
- **Tasks:** 3
- **Files modified:** 4 (2 created, 2 modified)

## Accomplishments
- `src/core/local-model.manager.js` (PROV-05): first real ServiceSupervisor consumer. Adopt-if-present / own-if-started with `adopt:true` + HTTP health on 11434; `ensureModel`/`pullModel` (resumable + sha256-verified for free, cache at Ollama default) emitting structured `{ status, percent, completed, total }`; `warmUp` keep_alive:-1; `preflight` disk/RAM warn-not-block; `getStatus` fusing owned/adopted with three-level health (serverUp / modelPresent / modelResponds); `_resolveOllamaBin` guide-install fallback. All graceful — no method throws.
- Lifecycle wiring in `main.js`: `getLocalModelManager()` lazy getter, `start()` in `onAppReady` (isolated try/catch so it never blocks startup), `stop()` fire-and-forget in `onWillQuit` (no-op if adopted).
- Provider-neutral local-engine IPC in `main.js` (`download-model`, `get-model-status`, `list-installed-models`, `model-preflight`, `recover-model`, `test-provider-connection`) + `model-pull-progress` stream, mirroring the whisper download-progress pattern; whisper IPC untouched.
- `preload.js` bridges (`pullModel`, `getModelStatus`, `listInstalledModels`, `modelPreflight`, `recoverModel`, `testProviderConnection`, `onModelPullProgress`).
- 8-test network-free suite proving adopt/own (real supervisor + dummy-service fixture via the DI spawn seam), structured pull progress, warn-not-block preflight, three-level status, server-down short-circuit, and the guide-install path.

## Task Commits

Each task was committed atomically (explicit pathspec — no sibling files swept in):

1. **Task 1: LocalModelManager (supervisor config, ensureModel/pull, warm-up, preflight, health, status)** - `ee0829f` (feat)
2. **Task 2: Wire lifecycle + local-engine IPC (mirror whisper download-progress)** - `e7b5fb0` (feat)
3. **Task 3: DI-seam lifecycle + pull-progress + preflight unit test** - `448cfbc` (test)

**Plan metadata:** this SUMMARY.md commit (docs). STATE.md intentionally NOT touched (parallel run with 03-03; delta returned to orchestrator).

## Files Created/Modified
- `src/core/local-model.manager.js` (created) - LocalModelManager: adopt/own Ollama, resumable pull + structured progress, resident warm-up, preflight, three-level health/status, ollama-bin resolution.
- `test/local-model-manager.test.js` (created) - 8 network-free tests (real ServiceSupervisor + dummy-service for adopt/own; fake ollama for pull/preflight/status).
- `main.js` (modified) - `getLocalModelManager()` getter; `start()` in `onAppReady`, `stop()` in `onWillQuit`; 6 local-engine IPC handlers + structured `model-pull-progress`.
- `preload.js` (modified) - 7 renderer bridges for the local-engine IPC surface.

## Decisions Made
- **Thin configurator over ServiceSupervisor.** No bespoke process management; the manager just builds the RESEARCH Flag-3 Ollama def (`adopt:true`, HTTP health on 11434, capped backoff, 30s startup) and injects the spawn seam. SIGTERM→SIGKILL on the owned child is the locked mechanism — no `tree-kill`/`get-port`/`execa`.
- **keep_alive:-1 belt-and-suspenders.** `OLLAMA_KEEP_ALIVE` env is applied only when the app spawns the daemon; an adopted daemon keeps its own env, so `warmUp()` always sends `generate({ keep_alive: -1 })` too (RESEARCH Open Q1). Resident behavior holds regardless of adopt/own.
- **`_ownsSupervisor` guard (design reconciliation).** The plan's `start()` returns `{ ok:false, reason:'not-installed' }` when the ollama binary is absent. Applied unconditionally, that would prevent the adopt/own tests (which inject a real ServiceSupervisor pointing at a dummy service) from ever calling `supervisor.start()`. Resolution: the not-installed guard fires only when the manager built its own supervisor (`!supervisor` at construction). An explicitly injected supervisor is trusted, keeping adopt/own provable fully network-free while preserving the guide-install UX on the production path.
- **Provider-neutral IPC names.** `download-model` / `get-model-status` / `recover-model` / `test-provider-connection` (not `gemini-*`) so the surface survives the PROV-07 Gemini deletion (03-08).
- **`recover-model` respects ownership.** `'restart'` only restarts a daemon we own; an adopted daemon down → surface status so the UI guides the user to restart their own Ollama (never kill/restart a foreign daemon).
- **Optional `logger` DI + host/version probe via built-in `fetch`.** Added a `logger` option (defaults to `createServiceLogger('MODEL')`) so tests inject a noop logger and keep output clean; `_probeVersion()` uses timeout-bounded `fetch` per the plan's `detect()` spec (stubbable in tests).

## Deviations from Plan

None - plan executed exactly as written. All method behaviors, signatures, IPC channel names, and the supervisor def match the plan verbatim. The `_ownsSupervisor` guard and optional `logger` option are within-scope refinements that preserve the specified behavior (graceful degrade, DI-seam testability) rather than changes to it; they add no dependencies and alter no planned semantics. Two tests beyond the plan's five (server-down health short-circuit, guide-install not-installed) strengthen coverage of behaviors the plan requires.

## Issues Encountered
- **Commit pathspec syntax.** First Task-1 commit attempt used `git commit -- <files> -m "..."`; git parsed `-m` as a pathspec. Corrected to `-m "..." -- <files>` (message before the `--` separator). No content impact.
- **Parallel-run hygiene.** Sibling executor 03-03 had `src/services/providers/index.js` + `test/local-provider.test.js` in flight in the shared tree. Every commit used explicit pathspec on only this plan's files; `git show --stat` confirmed zero cross-contamination. By suite time both executors' tests were green together (83/83).

## User Setup Required
None - no external service configuration required for this plan. (Runtime Ollama install + `qwen3-vl:8b` pull are exercised at the 03-07 boot smoke, not here — this plan is proven network-free.)

## Verification
- `node --test test/local-model-manager.test.js` → 8/8 pass.
- Full suite `node --test test/*.test.js` → 83/83 pass (63 pre-existing + 8 this plan + 12 sibling 03-03).
- `npx eslint .` → exit 0 (whole repo).
- Task-1 construct-with-fakes verify: four methods are functions, no real process spawned.
- Task-2 anchors: all IPC handlers + preload bridges + `start()`/`stop()` lifecycle hooks present.
- Boot smoke (does `start()` actually adopt/spawn a real Ollama) is deferred to 03-07 (needs real Ollama).

## Next Phase Readiness
- **03-05 (settings Model section):** `getStatus()`, `listInstalledModels()`, `pullModel()`, `preflight()` + their IPC/bridges are ready to render status, the curated + "any installed" picker, and a re-download/repair button.
- **03-06 (onboarding + Local-down UX):** `recoverModel(action)`, `onModelPullProgress`, and owned-vs-adopted status drive the first-run pull screen and one-click recovery (restart owned / re-pull / guide adopted).
- **03-07 (boot smoke / "Local proven"):** `start()` in `onAppReady` will adopt/spawn Ollama at runtime; the manager is the surface the smoke measures against.
- **03-08 (PROV-07 removal):** IPC surface is provider-neutral, so it survives the Gemini deletion untouched.

## Self-Check: PASSED

- Files created exist: `src/core/local-model.manager.js`, `test/local-model-manager.test.js`, `.planning/phases/03-local-engine-cloud-removal/03-04-SUMMARY.md` — all FOUND.
- Modified-file anchors present: `main.js` (`getLocalModelManager`), `preload.js` (`onModelPullProgress`) — FOUND.
- Commits exist: `ee0829f` (Task 1), `e7b5fb0` (Task 2), `448cfbc` (Task 3) — all FOUND.

---
*Phase: 03-local-engine-cloud-removal*
*Completed: 2026-07-14*
