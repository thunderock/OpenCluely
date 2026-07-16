---
phase: 04-continuous-hearing-resident-stt-ambient-listening
plan: 06
subsystem: stt
tags: [ambient-listening, powermonitor, sleep-wake, rewarm, devicechange, getusermedia, re-entrancy-guard, degrade-never-crash, node-test, openwhispr-766]

# Dependency graph
requires:
  - phase: 04-04
    provides: "Two independent per-channel pipelines (mic + system) with per-channel VadSegmenter + inFlight/pendingFlush/pendingFinal flush serialization; handleSystemAudioChunk + setSystemChannelEnabled — the re-attach reset + wake re-warm reuse this per-channel state"
  - phase: 04-05
    provides: "SystemAudioTapManager (isSupported()/start()/stop()/getStatus() with grant/deny persistence + one uniform degrade path) — the wake re-warm reopens it respecting the persisted grant"
  - phase: 04-03
    provides: "WhisperServerManager injected into speechService (setWhisperServerManager) + pre-warm/start lifecycle — the wake re-warm re-probes/restarts it"
  - phase: 04-01
    provides: "WhisperServerManager re-picks a free port on every start() (orphan EADDRINUSE guard) — makes the wake restart safe"
provides:
  - "main.js ambient auto-listen (STT-03/SC3): _ensureAmbientListening() auto-starts recording from launch, NON-BLOCKING + DEFERRED until the engine reports ready (first-run model download), re-invoked from the speech-'status' handler + onboarding-complete; skipped while onboarding is up"
  - "Interim on/off via the EXISTING mic control: _ambientDesired records the user's last intent (mic button IPC + Alt+R toggle set it) so a status event / wake re-warm never auto-resumes a paused session — no new Phase-6 indicator/kill-switch UI"
  - "src/core/wake-rewarm.js — a pure (Electron-free) guarded re-warm orchestrator: settle → re-probe/restart whisper-server (only when DOWN) → reopen the system tap (only if it was running/granted) → replay the last ambient state; unit-testable + degrade-never-crash"
  - "main.js powerMonitor.on('resume') → onWakeFromSleep() (openwhispr #766), armed early in onAppReady (does not wait on the slow LLM warmup), re-entrancy-guarded via _rewarmInFlight; never interrupts a healthy in-flight transcription"
  - "src/ui/main-window.js navigator.mediaDevices 'devicechange' re-attach (AirPods in/out): debounced teardown + getUserMedia re-acquire, crash-safe, notifies main on failure"
  - "speechService.resetChannelForReattach(source) — drops a channel's truncated partial + resets its VAD on re-attach while leaving in-flight flush serialization intact (no double-flush / no stranded segment); speech-reattach-channel IPC + preload bridge"
affects:
  - "04-08 (validation gate): the real sleep/wake + AirPods-swap exercise runs there on the mic-only baseline; this plan wires + re-entrancy-guards + proves no-crash-on-simulated-resume"
  - "04-09 (Azure removal): startRecording/stopRecording copy + the ambient wiring live above the still-present Azure branches — the removal must preserve the ambient/interim-stop entry points"
  - "Phase 6 (relevance gate / auto-answer-on-pause): consumes the always-open ambient stream this plan opens (launch→quit) + the persistent trust indicator / one-click kill switch that supersede this interim mic-control stop"

# Tech tracking
tech-stack:
  added:
    - "electron powerMonitor 'resume' (already bundled; newly consumed) — sleep/wake re-warm hook"
    - "navigator.mediaDevices 'devicechange' (renderer Web API; newly consumed) — mic hot-swap re-attach"
  patterns:
    - "Pure Electron-free orchestrator for a main-process concern (src/core/wake-rewarm.js): main.js injects the managers + a settle delay + a re-entrancy flag getter/setter, so the guarded sequence is unit-testable under bare node (mirrors vad-segmenter / service-supervisor extraction)"
    - "Single-intent ambient state (_ambientDesired): every on/off entry point (launch, mic button, Alt+R, wake, status) funnels through one flag + one _ensureAmbientListening() guard, so auto-start is idempotent and never overrides a user pause"
    - "Deferred-until-ready auto-start: a capability that needs a not-yet-ready engine returns immediately and is re-invoked by the existing 'status' event — launch is never blocked, first-run model download is honored without a bespoke wait loop"
    - "Re-attach-safe channel reset: resetChannelForReattach drops the truncated partial + resets VAD but DELIBERATELY leaves inFlight/pending* untouched so a running flush completes (no double-flush), reusing the 04-04 per-channel serialization"

key-files:
  created:
    - src/core/wake-rewarm.js
    - test/wake-rewarm.test.js
    - test/speech-reattach.test.js
  modified:
    - main.js
    - preload.js
    - src/services/speech.service.js
    - src/ui/main-window.js

key-decisions:
  - "Ambient auto-listen DEFERS (never blocks) when the engine isn't ready: on first run the ggml model is still downloading so isAvailable() is false — _ensureAmbientListening() returns immediately and the speech-'status' handler (fired by setWhisperServerManager after the model download + server start) re-invokes it once ready. Verified in a headless boot: with the model absent it logged 'Voice model not downloaded yet' and did NOT force-start (no crash, launch not blocked)."
  - "Interim on/off = the EXISTING mic control (mic button IPC + Alt+R → toggleSpeechRecognition), NOT a new UI. _ambientDesired records intent so a concurrent status/wake re-warm can't auto-resume a paused session. The Phase-6 persistent trust indicator + one-click kill switch are explicitly OUT OF SCOPE."
  - "powerMonitor is armed EARLY in onAppReady (right after setupGlobalShortcuts), not at the end after the manager starts, so the wake handler + re-warm are ready promptly and do NOT wait on the (observed-slow) qwen3-vl LLM warmup. onWakeFromSleep lazily resolves the managers, so it needs nothing pre-started."
  - "Wake re-warm restarts the whisper-server ONLY when it is actually DOWN (a healthy server is left alone) so it does not interrupt an in-flight transcription; the system tap is reopened ONLY if it was running/granted (respects the 04-05 persisted grant — never force-opens a tap the user never allowed)."
  - "The re-warm orchestration is a PURE module (src/core/wake-rewarm.js) injected with managers + settle delay so it is fully unit-testable under bare node — main.js's onWakeFromSleep is a thin adapter. The renderer mic re-acquire is a recording-started replay (renderer tears down + re-acquires getUserMedia) so the main-process VAD/in-flight state is never disturbed."

patterns-established:
  - "Simulated-event verification without booting the full GUI end-to-end: a temporary env-gated (OPENCLUELY_SIMULATE_RESUME) hook fired powerMonitor 'resume' twice in the real main process to PROVE the handler is wired + re-entrancy-guarded + crash-free, then was reverted (never committed) — the durable coverage is the pure node:test suite."
  - "macOS stealth-rename gotcha for headless smoke: the app renames its process to 'Terminal ' (trailing space), so `pkill -f electron` misses the disguised main process and it keeps the single-instance lock (next boot silently quits as a second instance with only import-time logs). Kill leftover mains by PID / the disguised title before re-booting."

# Metrics
duration: ~15 min
completed: 2026-07-16
---

# Phase 4 Plan 6: Ambient Listening + Resilience Summary

**Turned the proven per-channel STT engine into an always-on ambient listener: auto-listen from launch (NON-BLOCKING, deferred-until-ready) with the existing mic control + Alt+R as the interim on/off, plus the LOCKED resilience — a re-entrancy-guarded `powerMonitor.on('resume')` re-warm (re-probe/restart whisper-server + reopen the tap, openwhispr #766) and a `devicechange` mic re-attach (AirPods in/out) that survives without crashing.**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-07-16T18:49Z (approx)
- **Completed:** 2026-07-16T19:04Z
- **Tasks:** 2 of 2
- **Files modified:** 7 (3 created, 4 modified)

## Accomplishments

- **Ambient auto-listen from launch → quit (STT-03/SC3).** `main.js` gained a single guarded `_ensureAmbientListening()` that auto-starts recording after `whenReady()` — NON-BLOCKING and idempotent. When the engine isn't ready yet (first-run: the ggml model is still downloading, so `isAvailable()` is false) it DEFERS and the existing speech-`'status'` handler re-invokes it the moment the engine reports ready (also fired on `onboarding-complete`, and skipped while the onboarding wizard is up so we never grab the mic mid-setup). Verified in a headless boot: with the model absent it logged `Voice model not downloaded yet` and correctly deferred — no forced start, no crash, launch not blocked.
- **Interim on/off via the EXISTING mic control (no new UI).** The mic button (IPC `start`/`stop-speech-recognition`) and Alt+R (`toggleSpeechRecognition`) now record the user's intent in `_ambientDesired`, so a concurrent `'status'` event or a wake re-warm never auto-resumes a session the user paused. The `startRecording`/`stopRecording` double-start/double-stop guards + both-channel (mic + system) start/stop from 04-04 are documented as the ambient idempotency contract. The Phase-6 persistent trust indicator + one-click kill switch were deliberately NOT built.
- **Sleep/wake re-warm (openwhispr #766).** New pure `src/core/wake-rewarm.js` orchestrates the guarded sequence: short settle → re-probe/restart the whisper-server **only when DOWN** (never interrupts a healthy in-flight transcription; the manager re-picks a free port) → reopen the system tap **only if it was running/granted** (respects the 04-05 persisted grant) → replay the LAST ambient state (re-acquire the mic only if the user was listening). `main.js` wires `powerMonitor.on('resume')` → `onWakeFromSleep()`, re-entrancy-guarded by `_rewarmInFlight`, armed EARLY in `onAppReady` so it doesn't wait on the slow LLM warmup.
- **Mic-device-change re-attach (AirPods in/out).** `src/ui/main-window.js` adds a `navigator.mediaDevices 'devicechange'` handler that, while recording, debounces then tears down + re-acquires the `getUserMedia` stream — wrapped in try/catch so a transient device error never crashes the renderer, and it notifies main via `stopSpeechRecognition` on re-acquire failure. It first resets the mic VAD channel (`resetChannelForReattach` via a new `speech-reattach-channel` IPC + preload bridge) so the truncated partial from the dead device is dropped without double-flushing a segment.
- **Proven no-crash on a simulated resume + green gates.** A temporary env-gated hook fired `powerMonitor 'resume'` twice in the real main process: the rapid second emit returned `skipped: 'reentrant'` (the `_rewarmInFlight` guard) and the first completed the full re-warm ~1.5s later (settle delay) — zero uncaught exceptions — then the hook was reverted (never committed). `make run_tests` **145/145** (+16 new), `make lint` exit **0**.

## Task Commits

Each task was committed atomically (explicit pathspec — sole executor, hygiene):

1. **Task 1: Ambient auto-listen from launch + interim mic-control stop** — `18f4458` (feat)
2. **Task 2: Sleep/wake re-warm + mic-device-change re-attach resilience** — `3c5ded8` (feat)

**Plan metadata:** _(final docs commit — see git log; this SUMMARY + STATE)_

## Files Created/Modified

- `src/core/wake-rewarm.js` (created) — pure Electron-free `rewarmAfterWake(deps)` orchestrator: re-entrancy skip, settle delay, whisper re-probe/restart-only-when-down, tap reopen-only-if-was-on, ambient replay; degrade-never-crash; always clears the in-flight flag in `finally`.
- `test/wake-rewarm.test.js` (created) — 12 node:test cases: re-entrancy skip, null-manager degrade, whisper healthy-noop / down-restart+reinject / no-model / probe-error, tap reopened / was-off / unsupported / degraded, mic replay, and the full settle→whisper→tap→mic ordering + flag reset.
- `test/speech-reattach.test.js` (created) — 4 node:test cases on the REAL SpeechService singleton (isolated process): clears mic buffers + VAD, preserves in-flight flush serialization (no double-flush), per-channel isolation, degrade-never-throw on an unknown channel.
- `main.js` (modified) — `_ambientDesired` + `_rewarmInFlight`/`_powerMonitorWired` state; `_ensureAmbientListening()`; `_setupPowerMonitor()` (armed early); `onWakeFromSleep()` (thin adapter over `wake-rewarm`); `_reacquireAmbientMic()`; ambient wiring at launch / speech-`'status'` / `complete-first-run`; `_ambientDesired` in the 4 start/stop speech IPC handlers + `toggleSpeechRecognition` (ambient copy); `speech-reattach-channel` IPC; `powerMonitor` added to the electron require.
- `src/services/speech.service.js` (modified) — `resetChannelForReattach(source)` (re-attach-safe single-channel reset); ambient/idempotency/both-channel docs on `startRecording`/`stopRecording`; recording status copy → "Ambient listening started".
- `src/ui/main-window.js` (modified) — `_deviceChangeTimer` state; `'devicechange'` listener; `_handleAudioDeviceChange()` (debounced) + `_reacquireMicAfterDeviceChange()` (reset → re-acquire → notify-main-on-failure); device-change timer cleared in `_stopRendererAudioCapture`.
- `preload.js` (modified) — `reattachSpeechChannel(source)` bridge.

## Decisions Made

- **Ambient auto-listen DEFERS, never blocks** (see key-decisions). First-run/model-downloading is handled by the existing `'status'` re-invoke, not a bespoke wait — launch is never held.
- **Interim on/off reuses the existing mic control**; `_ambientDesired` is the single intent flag. No Phase-6 indicator/kill-switch UI.
- **powerMonitor armed early** (right after `setupGlobalShortcuts`) so wake-handling isn't gated on the slow qwen3-vl LLM warmup; the handler lazily resolves managers.
- **Re-warm restarts whisper ONLY when down** (never interrupts a healthy in-flight transcription) and **reopens the tap ONLY if it was running/granted** (respects the persisted grant).
- **Re-warm orchestration is a PURE module** injected with managers + a settle delay → fully unit-testable under bare node; the mic re-acquire is a `recording-started` replay so the main-process VAD/in-flight state is never disturbed.

## Deviations from Plan

**1. [Rule 3 - Blocking] Armed `powerMonitor` early in `onAppReady` instead of after the manager starts**
- **Found during:** Task 2 (headless simulated-resume verification)
- **Issue:** The plan's structure implied wiring resilience after the whisper/tap/LLM starts. But `await getLocalModelManager().start()` blocks `onAppReady` on the qwen3-vl warmup (observed to run tens of seconds — the known STATE latency concern), so `powerMonitor` (and the launch ambient call) would not be armed until the warmup finished. The simulated-resume verification fired before registration and saw nothing.
- **Fix:** Moved `this._setupPowerMonitor()` to right after `setupGlobalShortcuts()` (before the manager starts). `onWakeFromSleep` lazily resolves the managers via the existing getters, so it needs nothing pre-started; the wake handler is now armed promptly and independent of the LLM warmup. (`_ensureAmbientListening('launch')` stays after the tap start; it defers cleanly on a slow/absent engine and the `'status'` handler re-invokes it.)
- **Files modified:** main.js
- **Verification:** Re-boot with `OPENCLUELY_SIMULATE_RESUME=1` reached `powerMonitor wired` + two `Wake-from-sleep re-warm complete` (one `skipped:'reentrant'`, one full) with zero uncaught exceptions.
- **Committed in:** `3c5ded8` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking).
**Impact on plan:** The move makes the resilience handler correctly independent of the unrelated LLM warmup — a robustness improvement, no scope creep. All other work matched the plan as written.

## Issues Encountered

- **The headless simulated-resume boot repeatedly showed only import-time logs then silence.** Root cause: the app renames its process to `Terminal ` (trailing space) for stealth, so `pkill -f electron` missed the disguised main process from a prior boot; it kept the single-instance lock and each new boot silently quit as a second instance (import-time `[SESSION]`/`[LOCAL]` logs, then nothing). Resolved by killing the leftover mains by PID / the disguised title before re-booting — captured as a durable macOS-stealth smoke-test gotcha. (Mirrors the Phase-3 lesson that macOS/Electron code changes require a full app QUIT, not a window close.)
- **qwen3-vl LLM warmup makes `onAppReady` slow**, which is what surfaced the powerMonitor-arming ordering (see Deviation 1). This is the pre-existing latency concern already tracked in STATE, not introduced here; it is out of scope for this plan (Phase 6 default-model decision).

## User Setup Required

None — no external service configuration required. (The real sleep/wake + AirPods-swap exercise happens at the 04-08 validation gate on an attended machine; here the handlers are wired + re-entrancy-guarded + proven crash-free on a simulated resume.)

## Next Phase Readiness

- **04-08 (validation gate):** the always-open ambient stream (launch→quit), the interim mic-control stop, the `powerMonitor` re-warm, and the `devicechange` re-attach are all wired + guarded — ready for the real sleep/wake + AirPods-swap exercise on the mic-only baseline.
- **04-09 (Azure removal):** the ambient/interim-stop entry points sit above the still-present Azure branches (prove-then-remove); the removal must preserve `startRecording`/`stopRecording` + the ambient wiring.
- **Phase 6:** consumes this always-open stream for auto-answer-on-pause; the persistent trust indicator + one-click kill switch will supersede this interim mic-control stop.
- **Concern (carried, honest):** the real sleep/wake + AirPods swap is NOT exercised here (04-08 owns that on an attended machine). This plan proves the handlers are wired, re-entrancy-guarded, and crash-free on a SIMULATED resume + the pure orchestrator's unit tests — not a live GPU-eviction recovery.

---
*Phase: 04-continuous-hearing-resident-stt-ambient-listening*
*Completed: 2026-07-16*

## Self-Check: PASSED

- FOUND: src/core/wake-rewarm.js (pure re-warm orchestrator)
- FOUND: test/wake-rewarm.test.js (12 cases) + test/speech-reattach.test.js (4 cases)
- FOUND: main.js / preload.js / src/services/speech.service.js / src/ui/main-window.js (modified)
- FOUND: commit 18f4458 (Task 1, feat — ambient auto-listen + interim stop)
- FOUND: commit 3c5ded8 (Task 2, feat — sleep/wake re-warm + devicechange re-attach)
- FOUND: powerMonitor.on('resume') wiring in main.js; devicechange handler in main-window.js; resetChannelForReattach in speech.service.js
- GATES: `make run_tests` 145/145 (+16 new); `make lint` exit 0
- VERIFIED (headless boot): ambient DEFERS cleanly when the engine isn't ready (model absent, no forced start, no crash); simulated `powerMonitor 'resume'` x2 → one `skipped:'reentrant'` + one full re-warm, zero uncaught exceptions (temp env-gated hook reverted, not committed)
