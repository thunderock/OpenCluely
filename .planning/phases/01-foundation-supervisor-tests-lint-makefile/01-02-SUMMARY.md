---
phase: 01-foundation-supervisor-tests-lint-makefile
plan: 02
subsystem: testing
tags: [vad, speech, whisper, audio, node-test, pure-logic]

# Dependency graph
requires:
  - phase: none (Phase 1, wave 1, depends_on [])
    provides: existing SpeechService VAD state machine (extraction source)
provides:
  - Pure VadSegmenter state machine (src/core/vad-segmenter.js) — energy/hysteresis/noise-floor/pre-roll/accumulation, returning accumulate|flush|discard|noop actions
  - SpeechService delegates the VAD-enabled ingest path, watchdog checks, reset, and end-of-utterance to the segmenter (VAD-disabled legacy path byte-identical)
  - Deterministic node:test suite (test/vad-segmenter.test.js) pinning the VAD state machine without booting the app
affects: [04-stt-whisper-server, 01-04-lint-makefile, speech-pipeline, testing]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pure-logic extraction: lift a state machine out of an un-requireable self-initializing singleton and delegate via an action object"
    - "node:test + node:assert/strict with deterministic constant-amplitude PCM fixtures"

key-files:
  created:
    - src/core/vad-segmenter.js
    - test/vad-segmenter.test.js
  modified:
    - src/services/speech.service.js

key-decisions:
  - "VAD decision state extracted as a pure module; buffer storage + Whisper flush stay in SpeechService via accumulate|flush|discard|noop actions"
  - "Tuning passed per ingest() call (getters re-read each chunk) so the module imports no config/process.env/child_process"
  - "VAD-disabled legacy ingest path and legacy watchdog branch left byte-identical; only VAD-enabled paths route through this._segmenter"
  - "Deterministic tests use constant-amplitude PCM (RMS == amplitude/32768) with a tiny tuning so transitions are reached in a few chunks"

patterns-established:
  - "Pure-logic extraction from a singleton, delegating via an action return value"
  - "Unit-test suites require ONLY the extracted pure module, never the app singleton"

# Metrics
duration: 6min
completed: 2026-07-14
---

# Phase 1 Plan 2: VAD Segmenter Extraction Summary

**Pure VadSegmenter state machine (energy/hysteresis/noise-floor/pre-roll) lifted verbatim out of the 1847-line SpeechService singleton, delegated via accumulate|flush|discard|noop actions, and pinned by a deterministic node:test suite.**

## Performance

- **Duration:** 6 min
- **Started:** 2026-07-14T02:29:53Z
- **Completed:** 2026-07-14T02:35:35Z
- **Tasks:** 2
- **Files modified:** 3 (2 created, 1 modified)

## Accomplishments
- Extracted the VAD decision logic into `src/core/vad-segmenter.js` as a pure module (no config/process.env/child_process/electron requires) — now requireable and testable without the Electron app.
- Rewired `SpeechService` to construct `this._segmenter` and delegate the VAD-enabled `_ingestWhisperAudio` path, the VAD-enabled watchdog checks, `_resetVadState`, and `_endUtteranceFlush`, while leaving the VAD-disabled legacy path and legacy watchdog branch byte-identical.
- Removed the now-orphaned `_chunkRmsEnergy` method and `vadSilenceMs/vadNoiseFloor/vadNoiseInit/vadPreRoll/vadPreRollMs` fields; `_chunkDurationMs` now delegates to `VadSegmenter.chunkDurationMs`.
- Added a 6-case deterministic `node:test` suite proving onset/pre-roll, flush-on-pause, discard-noise, max-utterance flush, endUtterance reset, and the static energy/duration helpers.

## Task Commits

Each task was committed atomically:

1. **Task 1: Create vad-segmenter.js and delegate SpeechService** - `26a08fb` (feat)
2. **Task 2: Deterministic node:test suite for VadSegmenter** - `51d3b3a` (test)

**Plan metadata:** see final `docs(01-02)` commit.

## Files Created/Modified
- `src/core/vad-segmenter.js` - Pure VAD segmentation state machine (class `VadSegmenter`, static `rmsEnergy`/`chunkDurationMs`, `reset`/`endUtterance`/`ingest`).
- `test/vad-segmenter.test.js` - 6 `node:test` cases covering the state machine and static helpers; requires only the extracted module.
- `src/services/speech.service.js` - Requires + constructs `VadSegmenter`; delegates VAD-enabled ingest/watchdog/reset/end-of-utterance; legacy path unchanged; orphaned helper/fields removed.

## Decisions Made
- **Action-object delegation:** `ingest(buffer, tuning)` returns `{ type, buffers }` (accumulate|flush|discard|noop). The segmenter owns only VAD-decision state; buffer storage and the Whisper spawn/flush stay in `SpeechService`. On `discard` the segmenter returns empty buffers and the caller clears its own segment — net-identical to the original push-then-clear.
- **Per-call tuning:** thresholds are passed into each `ingest()` call (built from the existing getters each chunk), preserving the original per-chunk settings re-read and keeping the module free of config/env imports.
- **Faithful legacy preservation:** the VAD-disabled branch of `_ingestWhisperAudio` and the legacy watchdog branch are byte-identical to the original; only the VAD-enabled paths route through `this._segmenter`.

## Deviations from Plan

None - plan executed exactly as written. The plan's referenced line numbers (VAD block 700-907, getters 1200-1266) matched the live file exactly, so the mechanical translation applied cleanly with no bugs, missing functionality, or blocking issues to auto-fix.

## Issues Encountered
None. Executed on the shared phase branch in parallel with plans 01-01 and 01-03; no git index-lock contention was hit (a retry guard was in place regardless). A sibling `test/env-file.test.js` from a parallel plan is present and the full `node --test test/*.test.js` glob passes (22 tests, 0 failures).

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Third FND-01 pure-logic target (VAD segmentation) is complete and pinned, contributing to Success Criterion 2's pure-logic coverage.
- `src/core/vad-segmenter.js` and its test are lint-ready (2-space, single-quote, no unused/undefined vars) for the ESLint config landing in plan 01-04.
- The VAD state machine is now independently testable, de-risking the Phase 4 STT/Whisper server work that builds on this speech pipeline.

---
*Phase: 01-foundation-supervisor-tests-lint-makefile*
*Completed: 2026-07-14*

## Self-Check: PASSED

- FOUND: src/core/vad-segmenter.js
- FOUND: test/vad-segmenter.test.js
- FOUND: src/services/speech.service.js
- FOUND: .planning/phases/01-foundation-supervisor-tests-lint-makefile/01-02-SUMMARY.md
- FOUND commit: 26a08fb (Task 1)
- FOUND commit: 51d3b3a (Task 2)
