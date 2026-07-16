---
phase: 04-continuous-hearing-resident-stt-ambient-listening
plan: 09
subsystem: stt
tags: [whisper, speech, cloud-removal, polyfill, ollama, nodeFetch, cleanup]

# Dependency graph
requires:
  - phase: 04-08
    provides: "validation gate — resident whisper.cpp engine proven on the mic baseline (keyless proof accepted; real-world run deferred to pre-ship/Phase 8)"
  - phase: 04-03
    provides: "_flushWhisperSegment rewired to the resident whisper-server manager; Python path already deleted"
  - phase: 04-04
    provides: "two independent per-channel pipelines (mic + system) + source-tagged transcription"
provides:
  - "Cloud STT SDK (microsoft-cognitiveservices-speech-sdk) fully uninstalled (9 packages) + lockfile refreshed"
  - "The ~380-line browser-DOM polyfill deleted — the main process never clobbers global.URL/Blob/File at module load"
  - "STT collapsed to the single resident whisper engine — no provider selection, no cloud UI/env/config"
  - "ensureNativeGlobalURL fully retired (definition + export + 4 call sites + 3 tests) while nodeFetch is KEPT"
  - "LLM path verified green post-removal (145/145 tests + keyless LocalProvider wiring check)"
affects: [phase-06-relevance-gate, phase-08-signing-packaging, phase-09-website]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Single-engine collapse: a provider-selection surface (config + UI + env + service branches) removed wholesale once the sole survivor is proven — mirrors Phase 3's Gemini removal"
    - "nodeFetch decoupled from the polyfill it originally shipped beside — kept as a standalone Electron-main loopback fix"
key-files:
  created: []
  modified:
    - src/services/speech.service.js
    - src/core/config.js
    - package.json
    - main.js
    - onboarding.js
    - onboarding.html
    - settings.html
    - src/ui/settings-window.js
    - src/core/first-run.js
    - env.example
    - src/core/local-transport.js
    - src/core/local-model.manager.js
    - src/services/providers/local.provider.js
    - src/core/whisper-server.manager.js
    - test/local-transport.test.js
    - test/local-model-manager.test.js
    - test/local-provider.test.js

key-decisions:
  - "Prove-then-remove gate (Task 1) was human-approved at the orchestrator level (2026-07-16, 'Approved — delete Azure') on the 04-08 keyless proof; recorded as approved, not re-run"
  - "recognizeFromFile deleted entirely (cloud-only method with no repo call sites; the whisper branch was dead code reachable through no caller)"
  - "_getConfiguredProvider deleted and provider hardcoded to 'whisper' (no selection remains)"
  - "dangerouslyAllowBrowser KEPT in LocalProvider as harmless/defensive per plan — not expanded scope"
  - "The manager/provider poison-simulation tests were converted to plain reachable-daemon / network-free wiring tests (option b), not deleted, preserving serverUp + client-init coverage"

patterns-established:
  - "When retiring a shared helper, grep the WHOLE repo by symbol — the plan's 2 call sites were actually 4 (whisper-server.manager.js added one after the blast-radius snapshot)"

# Metrics
duration: 27min
completed: 2026-07-16
---

# Phase 4 Plan 09: Cloud STT Removal + Polyfill Retirement Summary

**The cloud Speech SDK, its ~380-line browser-DOM polyfill, every cloud speech code path/UI/env, and the ensureNativeGlobalURL workaround are all removed — STT collapses to the single resident whisper.cpp engine, nodeFetch is kept, and the LLM path stays green (145/145 tests).**

## Performance

- **Duration:** 27 min
- **Started:** 2026-07-16T21:06:07Z
- **Completed:** 2026-07-16T21:33:29Z
- **Tasks:** 4 (Task 1 human-approved gate; Tasks 2–4 executed)
- **Files modified:** 20 (incl. package-lock.json; 3 collateral fixes beyond the plan's declared set)

## Accomplishments
- Deleted the browser-DOM polyfill (speech.service.js dropped 1648 → 918 lines) — no `window`/`document`/`navigator`/`AudioContext`/`global.URL` clobber remains in the main process.
- Uninstalled `microsoft-cognitiveservices-speech-sdk` (+8 transitive deps) and refreshed the lockfile; kept `node-record-lpcm16` (Linux mic).
- Removed the entire cloud surface: config `speech.provider`/`speech.azure`, main.js getters/env writes, onboarding choice-card + key panel, settings dropdown + fields + dead Python CLI inputs, first-run `.env` template + status fields, and env.example keys + stale Python seed.
- Retired `ensureNativeGlobalURL` completely (definition + export + **4** call sites + 3 poison tests) while keeping `nodeFetch` as the standalone Electron-main loopback fix.
- Verified green: `make run_tests` 145/145, `make lint` exit 0, keyless LocalProvider wiring check passes, headless boot degrades to mic cleanly with no uncaught exceptions.

## Task Commits

Each task was committed atomically (explicit pathspec, Conventional Commits):

1. **Task 1: Prove-then-remove gate** — human-approved at the orchestrator level (2026-07-16, "Approved — delete Azure"); NOT re-run. The 04-08 gate passed on keyless proof (145/145, loopback inference smoke, latency/memory/silence spot-check), with the real-world run deferred to pre-ship/Phase 8 by explicit human decision.
2. **Task 2: Delete the polyfill + SDK + all cloud code paths (+ config + dep)** — `b0780dc` (feat)
3. **Task 3: Remove the cloud surface — main getters/env, onboarding + settings UI, first-run + env.example** — `dec5a55` (feat)
4. **Task 4: Retire ensureNativeGlobalURL (+ update 3 poison tests) + verify the LLM path green** — `cd5b383` (refactor)

**Plan metadata:** (final docs commit — this SUMMARY + STATE)

## Files Created/Modified
- `src/services/speech.service.js` — removed the polyfill, SDK require, all cloud methods/branches (`_initializeAzureClient`, `_startAzureRecording`, `recognizeFromFile`, the cloud `testConnection` branch, `_getConfiguredProvider`, push-stream ingest, cloud state); collapsed to always-whisper. 1648 → 918 lines.
- `src/core/config.js` — dropped `speech.provider` + `speech.azure`; `speech.whisper` is the only speech config.
- `package.json` / `package-lock.json` — removed the cloud SDK dependency; refreshed lockfile.
- `main.js` — dropped cloud key getters/env writes + the provider-change re-init; getSettings/saveSettings surface only whisper-server knobs.
- `onboarding.js` / `onboarding.html` — removed the cloud choice-card + key/region panel/inputs + state + handlers + save persistence + summary row; speech step is local-whisper-or-skip; fixed stale "Requires Python" copy.
- `settings.html` / `src/ui/settings-window.js` — removed the provider dropdown, cloud fields + note, and dead Python CLI inputs + their refs/load/save/change-listeners/`updateSpeechFieldStates`; kept the whisper status/model/repair panel + Local-model panel.
- `src/core/first-run.js` — removed cloud/whisper `.env` template seed, dead `getStatus` fields, and the now-orphaned `_readEnv` + `parseEnv` import.
- `env.example` — removed cloud keys + the stale Python-whisper seed; left whisper-server knobs as commented overrides.
- `src/core/local-transport.js` — removed `ensureNativeGlobalURL` (definition + export); kept `nodeFetch` + native `URL` + `normalizeHeaders`; rewrote the header docs to describe nodeFetch as a standalone loopback fix.
- `src/core/local-model.manager.js`, `src/services/providers/local.provider.js`, `src/core/whisper-server.manager.js` — removed the `ensureNativeGlobalURL` import + call site (whisper-server.manager was the 4th, undocumented call site); kept `nodeFetch` and the defensive `dangerouslyAllowBrowser`.
- `src/core/whisper-model-downloader.js`, `src/core/vad-segmenter.js` — scrubbed stale comments referencing the removed polyfill / global.URL clobber.
- `test/local-transport.test.js`, `test/local-model-manager.test.js`, `test/local-provider.test.js` — updated the 3 poison-simulation tests (deleted the restore-poisoned-URL test; converted the manager + provider poison tests to plain reachable-daemon / network-free wiring tests); kept nodeFetch native-URL + stream-close coverage.

## Decisions Made
- **Task 1 recorded as human-approved, not re-presented.** The orchestrator confirmed the human response "Approved — delete Azure" on the 04-08 keyless proof; the executor proceeded directly to Task 2.
- **`recognizeFromFile` deleted whole** rather than kept as whisper-only: it is a cloud-era method with zero repo call sites (its whisper branch was unreachable dead code).
- **`_getConfiguredProvider` deleted, provider hardcoded to `'whisper'`** — with the cloud engine gone there is no selection to compute.
- **Poison tests converted, not deleted** (plan option b) so `serverUp`-reachable and network-free client-init coverage is preserved without simulating a defense that no longer exists.
- **`dangerouslyAllowBrowser` kept** in LocalProvider (harmless/defensive) per plan — scope not expanded.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Retired ensureNativeGlobalURL at a 4th, undocumented call site (whisper-server.manager.js)**
- **Found during:** Task 4 (retire ensureNativeGlobalURL)
- **Issue:** The plan named 2 call sites (local-model.manager.js, local.provider.js) from a pre-04-01 blast-radius snapshot. 04-01's `WhisperServerManager` added a 3rd import + call (`src/core/whisper-server.manager.js:33,80`). Removing the export from local-transport.js without fixing this would leave a broken import + a `TypeError` at manager construction, breaking STT startup.
- **Fix:** Removed the `ensureNativeGlobalURL` import + constructor call from whisper-server.manager.js (identical retirement to the two named sites); kept `nodeFetch`. Verified the manager constructs network-free.
- **Files modified:** src/core/whisper-server.manager.js
- **Verification:** `grep -rn ensureNativeGlobalURL src/ test/` returns nothing; WhisperServerManager constructs OK; 145/145 tests.
- **Committed in:** cd5b383 (Task 4 commit)

**2. [Rule 3 - Blocking] Scrubbed stale global.URL / polyfill comments the plan's own verify greps require clean**
- **Found during:** Task 4 (final `grep global.URL src/` verification)
- **Issue:** Comments in `whisper-server.manager.js`, `local-model.manager.js:241`, `whisper-model-downloader.js:26`, and `vad-segmenter.js` still narrated the now-removed polyfill and literally contained `global.URL` / "Azure" — tripping the plan's `grep -rniE "global\.URL" src/` and `grep azure` gates.
- **Fix:** Reworded each comment to describe the native-URL rationale without referencing the deleted polyfill; corrected vad-segmenter's stale "SpeechService mutates global.window / try/requires the Azure SDK" description (no longer true after Task 2).
- **Files modified:** src/core/whisper-server.manager.js, src/core/local-model.manager.js, src/core/whisper-model-downloader.js, src/core/vad-segmenter.js
- **Verification:** `grep -rniE "global\.URL|typeof window ===" src/ main.js` and `grep -rniE "azure|polyfill" src/core src/services/providers` both clean.
- **Committed in:** cd5b383 (Task 4 commit)

**3. [Rule 1 - Bug] Removed a now-unused `fs` require left by deleting recognizeFromFile**
- **Found during:** Task 2 (eslint gate)
- **Issue:** `recognizeFromFile` was `fs`'s only consumer; deleting it left `const fs = require('fs')` unused → `no-unused-vars` eslint error.
- **Fix:** Removed the `fs` require from speech.service.js.
- **Files modified:** src/services/speech.service.js
- **Verification:** `npx eslint src/services/speech.service.js` exit 0.
- **Committed in:** b0780dc (Task 2 commit)

---

**Total deviations:** 3 auto-fixed (2 blocking, 1 bug). All within the plan's directly-touched code (retiring the shared helper + deleting the cloud method surfaced them). No scope creep — the `main-window.js` renderer `AudioContext` (real Web Audio API for mic capture) was correctly left untouched.
**Impact on plan:** All auto-fixes required for the plan's own verifications to pass. The 4th call-site fix was essential — without it STT construction would throw.

## Issues Encountered
- The stale env.example Python-Whisper seed (re-assigned to this plan from 04-07 via deferred-items.md) was removed as part of Task 3's holistic env cleanup — closed.
- No functional issues; the LLM path had only defensive coupling to the polyfill (`ensureNativeGlobalURL` + `dangerouslyAllowBrowser`), so removal strictly helped it.

## User Setup Required
None - no external service configuration required. (Removal only; nothing new to configure.)

## Next Phase Readiness
- **STT-05/SC6 complete:** cloud STT + polyfill fully removed; STT is the single local whisper engine end-to-end. This was the final plan of Phase 4.
- **Phase 4 is code-complete.** Remaining deferred items (unchanged by this plan): the 04-05 system-audio signing spike and the 04-08 real-world validation run, both → Phase 8 (signing/packaging); cosmetic marketing "Azure" copy in `webapp/index.html:345` left as low-priority (→ Phase 9 website), noted below.
- **Cosmetic residue (optional, non-functional):** `webapp/index.html:345` still mentions "Azure Speech" in marketing copy — out of this plan's scope (not in files_modified), safe to leave for the Phase-9 website pass.
- Ready for the Phase-4 → main merge (human performs the merge + push; never auto).

---
*Phase: 04-continuous-hearing-resident-stt-ambient-listening*
*Completed: 2026-07-16*

## Self-Check: PASSED

- FOUND: 04-09-SUMMARY.md
- FOUND commits: b0780dc (Task 2), dec5a55 (Task 3), cd5b383 (Task 4)
- CONFIRMED: microsoft-cognitiveservices-speech-sdk removed from node_modules + lockfile
- CONFIRMED: ensureNativeGlobalURL retired (0 refs in src/ + test/); nodeFetch kept
- CONFIRMED: `make run_tests` 145/145, `make lint` exit 0, keyless LocalProvider wiring check passes, headless boot clean
