---
phase: 04-continuous-hearing-resident-stt-ambient-listening
plan: 03
subsystem: stt
tags: [whisper, whisper-server, inference, verbose_json, no_speech, python-removal, venv-removal, di, ipc, node-test, degrade-never-crash]

# Dependency graph
requires:
  - phase: 04-01
    provides: WhisperServerManager (transcribe() over POST /inference verbose_json + no_speech>0.6 gate, three-level health, ServiceSupervisor own-only) + built whisper-server binary + collapsed speech.whisper config
  - phase: 04-02
    provides: WhisperModelDownloader (resumable HTTP Range + SHA256 verify into <userData>/.whisper-models/, structured progress)
  - phase: 03
    provides: LocalModelManager lazy-getter + onAppReady(non-fatal)/onWillQuit lifecycle template; local-transport nodeFetch; showLocalUnavailable inline-recovery UX pattern
provides:
  - "speech.service.js _flushWhisperSegment rewired to whisperServerManager.transcribe() — resident transcription, NO per-utterance process/model spawn/cold-start (STT-01/SC1)"
  - "The entire Python-Whisper subprocess + venv path DELETED (transcribe/probe/candidate/parse methods + whisper-installer.js); the three-gate composition (VAD → no_speech>0.6 → phrase-list) preserved at the flush site"
  - "main.js getWhisperServerManager()/getWhisperModelDownloader() lazy getters; whisper-server pre-warmed non-blocking/non-fatal in onAppReady + injected into speechService; stopped on quit"
  - "whisper IPC: get-whisper-status + whisper-recover added (mirror get-model-status/recover-model); download-whisper-model rewired to the 04-02 ggml downloader; Python detect/install IPC removed"
  - "scripts/smoke-whisper.js — keyless loopback STT smoke over /inference verbose_json (latency + no_speech_prob)"
affects:
  - "04-04 (two-channel refactor): both mic + system channels flush through this same manager.transcribe() seam"
  - "04-06 (ambient resilience): builds on the non-fatal pre-warm + get-whisper-status/whisper-recover recovery IPC"
  - "04-07 (onboarding/settings STT UI): consumes get-whisper-status/whisper-recover + the structured install-progress download; must update onboarding.js (detectWhisper/installWhisper calls now dead) + env.example (stale Python seed, see deferred-items.md)"
  - "04-08 (validation gate): runs scripts/smoke-whisper.js against a REAL downloaded model for the live transcript"
  - "04-09 (azure removal): the Azure polyfill + all speech.provider/azure branches are UNTOUCHED here (prove-then-remove)"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "DI injection of a started singleton: main.js hands the pre-warmed WhisperServerManager to speechService.setWhisperServerManager() after app-ready; the manager is NEVER constructed at speech.service import (tests/imports must not spawn a server)"
    - "Synchronous three-level health accessor (_whisperResidentHealth) reads the manager's sync surface (binaryPath / modelPresent() / supervisor.getStatus().state) so isAvailable()/getStatus() stay sync; the async level-4 responding probe is reserved for testConnection()"
    - "whisper-server pre-warm guarded on modelPresent() — unlike the Ollama daemon, whisper-server cannot start without its model file, so the spawn is skipped when the ggml model is absent (first-run download is onboarding-driven), avoiding a futile backoff/retry storm"
    - "Keyless loopback smoke lives in scripts/ (excluded from the test/*.test.js CI glob), degrades with eyeballable exit codes, and WAIVES the live transcript when the model is absent — substituting a real-loopback-HTTP wiring proof"

key-files:
  created:
    - scripts/smoke-whisper.js
  modified:
    - src/services/speech.service.js
    - main.js
    - preload.js
    - src/core/first-run.js
  deleted:
    - src/core/whisper-installer.js

key-decisions:
  - "Inline the resident transcribe in _flushWhisperSegment (build WAV via _createWavBuffer → manager.transcribe(wav,{language}) → .text) rather than a helper, so the transcriptionInFlight/pendingFlush serialization + Buffer.concat framing + the _isHallucinatedTranscript gate stay byte-for-byte at the flush site"
  - "Availability = serverUp && modelPresent, recomputed LIVE each isAvailable() call (not cached), so a mid-session engine-down flips the mic to unavailable; typing + screenshot are unaffected"
  - "Reuse the existing speech-status/speech-error channels for the inline voice messages (the plan's sanctioned option) — the rewired _initializeWhisperClient emits three distinct strings (build binary / download model / retry) that the existing broadcast plumbing carries; added get-whisper-status + whisper-recover IPC for the overlay's query + one-click retry"
  - "Guard the whisper-server pre-warm on modelPresent() (skip spawn when the model is absent) — whisper-server needs its model to launch at all; the first-run download is onboarding/settings-driven (04-07), mirroring the LocalModelManager 'daemon first, pull later' sequencing"
  - "Azure polyfill (lines 1-380) + every Azure method/branch left byte-identical (prove-then-remove; 04-09). Kept node-record-lpcm16 (Linux mic) + spawnSync (_audioProgramExists); dropped now-unused os/path/spawn requires"

patterns-established:
  - "setWhisperServerManager(mgr) re-runs _initializeWhisperClient so availability + status refresh the instant the started manager lands (the singleton constructor ran at import, before any manager existed)"
  - "Recovery IPC symmetry: whisper-recover('download'|'restart') mirrors recover-model, (re)starting the owned server + re-injecting into speechService so the mic recovers without a relaunch"

# Metrics
duration: 16min
completed: 2026-07-16
---

# Phase 4 Plan 3: Resident STT Rewire + Python Removal Summary

**`_flushWhisperSegment` now transcribes each VAD segment against the resident whisper-server via the injected `WhisperServerManager.transcribe()` (POST /inference verbose_json, no per-utterance spawn) — the entire Python-Whisper subprocess + venv path (transcribe/probe/candidate/parse methods + `whisper-installer.js`) is deleted, the three-gate composition is preserved, and the manager is pre-warmed non-blocking/non-fatal in main.js + stopped on quit.**

## Performance

- **Duration:** 16 min
- **Started:** 2026-07-16T16:45:04Z
- **Completed:** 2026-07-16T17:01:15Z
- **Tasks:** 3
- **Files modified:** 6 (1 created, 4 modified, 1 deleted) — net **−557 lines** (529 insertions, 1086 deletions)

## Accomplishments
- **STT-01/SC1 met:** `_flushWhisperSegment` (`speech.service.js`) builds the 16 kHz mono WAV via the retained `_createWavBuffer` and `await whisperServerManager.transcribe(wav, { language })`, taking `.text` — the resident engine transcribes with **no per-utterance process/model spawn or cold-start**. The `transcriptionInFlight`/`pendingFlush`/`pendingFinal` serialization + `Buffer.concat` framing are unchanged, and the **three-gate composition is intact**: VAD segmenter → `no_speech_prob > 0.6` (inside `manager.transcribe`) → `_isHallucinatedTranscript` phrase-list still guards `emit('transcription')` at the flush site.
- **Python STT path deleted:** `_transcribeWhisperBuffer`, `_transcribeWhisperFile`, `_resolveWhisperCommand`, `_getUserDataWhisperCandidate`, `_probeWhisperModuleFast`, `_probeWhisperCandidate`, `_expandConfiguredWhisperCandidates`, `_parseCommand`, `_getUserDataModelDir`, `_getWhisperModelDir`, `_removeTempDir`, the `this.whisperCommand` state + the `os`/`path`/`spawn` requires — all gone. `src/core/whisper-installer.js` (624-line venv/pip module) deleted. `_initializeWhisperClient`/`isAvailable`/`getStatus`/`testConnection` now read the manager's three-level health instead of `this.whisperCommand`.
- **main.js wiring:** lazy `getWhisperServerManager()` + `getWhisperModelDownloader()` getters; the whisper-server is pre-warmed in `onAppReady` **non-blocking + non-fatal** (skipped when the model is absent) then injected into `speechService`; `getWhisperServerManager().stop()` fire-and-forget in `onWillQuit`. `download-whisper-model` rewired to the 04-02 ggml downloader (structured `{ percent, … }` progress on the existing `install-progress` channel); `get-whisper-status` + `whisper-recover` added; `detect-whisper` + `install-whisper` + `getWhisperInstaller()` removed. preload gains `getWhisperStatus`/`recoverWhisper`, loses `detectWhisper`/`installWhisper`.
- **Keyless loopback smoke** (`scripts/smoke-whisper.js`): starts the manager, POSTs a known WAV through `manager.transcribe()` + a raw verbose_json probe, logs wall-clock latency + per-segment `no_speech_prob`; graceful exit codes (0/1/2/3/4); NOT a test-glob file (never in CI).
- **Gates green:** `make lint` exit 0, `make run_tests` **116/116**; headless electron boots clean when the model is absent (non-fatal pre-warm skip, no crash); `test/vad-segmenter.test.js` (SC5 anchor) still 6/6.

## Task Commits

Each task was committed atomically with an explicit pathspec:

1. **Task 1: Rewire flush seam to the resident engine + delete the Python STT path** - `39412b0` (feat)
2. **Task 2: main.js manager wiring + whisper IPC + retire the Python installer** - `a5d9896` (feat)
3. **Task 3: Keyless loopback smoke + confirm VAD suite green** - `5e52583` (test)

**Plan metadata:** _(final docs commit — see git log)_

## Files Created/Modified
- `src/services/speech.service.js` (modified, −401 net) - Flush seam rewired to `manager.transcribe()`; `setWhisperServerManager` DI setter + `_whisperResidentHealth` sync three-level accessor; Python transcribe/probe/candidate/parse path deleted; Azure polyfill + branches untouched; `_getWhisperModel` default `turbo`→`small.en`.
- `main.js` (modified) - Lazy whisper getters; `onAppReady` pre-warm (non-blocking/non-fatal, model-guarded) + inject; `onWillQuit` stop; `download-whisper-model` → ggml downloader; `get-whisper-status`/`whisper-recover` added; Python detect/install IPC + `getWhisperInstaller()` removed; crash-guard comment de-staled.
- `preload.js` (modified) - Added `getWhisperStatus`/`recoverWhisper`; removed `detectWhisper`/`installWhisper` (kept `downloadWhisperModel`/`onInstallProgress`).
- `src/core/first-run.js` (modified) - `.env` fallback template: dropped stale `venv`/`WHISPER_COMMAND`/`WHISPER_MODEL_DIR`/`turbo` (Rule 3, below).
- `src/core/whisper-installer.js` (**deleted**, −624) - The venv/pip installer module (replaced by the 04-02 downloader).
- `scripts/smoke-whisper.js` (created, 242 lines) - Keyless loopback STT smoke.

## Decisions Made
- **Inline resident transcribe in the flush** rather than a helper — keeps the serialization/framing/gate lines byte-for-byte at the flush site (minimal diff to the load-bearing logic).
- **Live availability** (`serverUp && modelPresent`, recomputed each call) so a mid-session engine-down flips the mic off; typing + screenshot unaffected.
- **Reused `speech-status`/`speech-error`** (the plan's sanctioned option) for the three inline voice messages, plus added `get-whisper-status`/`whisper-recover` IPC for the overlay's query + retry — no speculative new broadcast channel.
- **Pre-warm guarded on `modelPresent()`** — whisper-server cannot start without its model, so skip the spawn when absent (onboarding drives the first download); mirrors the Ollama "daemon first, model later" sequencing without a futile retry storm.
- **Azure untouched** (polyfill + all branches compile) — prove-then-remove; 04-09 owns Azure removal.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Cleaned stale Python-Whisper seed in the first-run `.env` fallback template**
- **Found during:** Task 2 (the "grep `venv` gone from src" verification in the critical execution notes)
- **Issue:** `src/core/first-run.js._readTemplate()`'s in-code fallback `.env` still emitted `WHISPER_COMMAND=whisper`, a `.venv-whisper` comment, `WHISPER_MODEL_DIR=`, and `WHISPER_MODEL=turbo` — a dangling leftover of the deleted Python path that tripped the plan's own "`venv` gone from `main.js/preload.js/src`" gate.
- **Fix:** Rewrote the template's speech block to the resident engine (no Python/CLI/venv; `WHISPER_MODEL=small.en`). Azure lines untouched (prove-then-remove).
- **Files modified:** src/core/first-run.js
- **Verification:** `grep -rn "venv" main.js preload.js src/` now returns only comments that *assert the absence* of venv/pip; `npx eslint src/core/first-run.js` clean.
- **Committed in:** `a5d9896` (Task 2 commit)

**2. [Rule 3 - Blocking] Pre-warm guarded on model presence (skip spawn when the ggml model is absent)**
- **Found during:** Task 2 (onAppReady wiring)
- **Issue:** A literal "mirror `getLocalModelManager().start()`" would call `whisperServerManager.start()` unconditionally. Unlike the Ollama daemon (which runs model-less), `whisper-server` launches as `whisper-server -m <model>` and cannot start without the model file, so on a model-absent boot (the common first-run state) the supervisor would spawn→exit→back off up to 8 times (~60 s of futile retries) on every launch.
- **Fix:** Guard the pre-warm on `whisperMgr.modelPresent()` — skip the spawn (log + inject only, surfacing the "voice model missing" inline status) when the model is absent; still pre-warm when present. Matches the LocalModelManager "daemon first, pull later" sequencing (onboarding/04-07 drives the visible download).
- **Files modified:** main.js
- **Verification:** Headless electron boot logs "Voice model not downloaded yet; skipping whisper-server pre-warm" with no spawn/crash.
- **Committed in:** `a5d9896` (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (both Rule 3 - blocking). No architectural changes.
**Impact on plan:** #1 is required to pass the plan's own `venv`-gone grep gate; #2 is the correct whisper-analogue of the Ollama pre-warm (prevents a boot-time retry storm) and preserves the non-fatal contract. No scope creep beyond the declared files, except the surgical `first-run.js` template line (necessary for the grep gate).

## Issues Encountered
- **Live transcript WAIVED (model absent) — substituted a real-loopback-HTTP wiring proof.** The 488 MB `ggml-small.en.bin` is not downloaded in this environment, so a full live `/inference` transcription is un-runnable. Per the repo rule (waive un-runnable live checks, substitute a keyless wiring check): (a) `node scripts/smoke-whisper.js` correctly detects the built binary and takes the graceful "MODEL MISSING → exit 3" path (no crash); (b) a real-loopback-HTTP round-trip proved `manager.transcribe()` POSTs multipart to `/inference`, parses `verbose_json`, drops a `no_speech_prob 0.92` segment (>0.6 gate), and concatenates survivors → "the quick brown fox" (dropped 1/3); (c) the 04-01 manager unit tests (13 network-free cases) + a Task-1 network-free DI round-trip (fake manager → `transcribe` → `emit('transcription')`, hallucination filter dropping "thank you") cover the rest. The **04-08 validation gate** runs the smoke against a real downloaded model for the live transcript.
- **Transient onboarding renderer dead calls (by design, → 04-07).** `onboarding.js` still calls `detectWhisper()`/`installWhisper()`/`downloadWhisperModel('turbo')`; the first two bridges are now removed and the third returns an `unknown-model` struct. All are inside `try/catch` (degrade to a status line, no crash). The plan explicitly defers the onboarding renderer rework to 04-07.

## User Setup Required
None - no external service configuration required. (The real ~488 MB ggml model download + live transcription happen at onboarding / the 04-08 validation gate; this plan ships the network-free rewire + the keyless smoke.)

## Next Phase Readiness
- **04-04** (two-channel refactor) can route both mic + system channels through the same `manager.transcribe()` flush seam — the resident path is proven and the shared VAD knobs are already in `speech.whisper`.
- **04-07** (onboarding/settings STT UI) has the IPC surface it needs (`get-whisper-status`, `whisper-recover`, structured `download-whisper-model`) and MUST: (1) update `onboarding.js` to stop calling `detectWhisper`/`installWhisper` and to pass `small.en` (not `turbo`) + consume structured progress; (2) update `env.example` (stale Python seed — logged to `deferred-items.md`); (3) render the rich inline voice-unavailable panel (the messages already flow over `speech-status`).
- **04-09** (Azure removal): the Azure polyfill + `speech.provider`/`speech.azure` branches are intact and compiling — ready for prove-then-remove.
- **Concern:** the live end-to-end transcript is still unproven on real audio (model not downloaded here) — deferred to 04-08.

---
*Phase: 04-continuous-hearing-resident-stt-ambient-listening*
*Completed: 2026-07-16*

## Self-Check: PASSED

- FOUND: scripts/smoke-whisper.js
- FOUND: src/services/speech.service.js (rewired, Python path deleted)
- FOUND: main.js (whisper wiring + IPC)
- FOUND: preload.js (getWhisperStatus/recoverWhisper)
- FOUND: src/core/first-run.js (stale venv template cleaned)
- CONFIRMED DELETED: src/core/whisper-installer.js
- FOUND: .planning/phases/04-.../04-03-SUMMARY.md
- FOUND: commit 39412b0 (Task 1, feat — flush rewire + Python deletion)
- FOUND: commit a5d9896 (Task 2, feat — main.js wiring + installer retirement)
- FOUND: commit 5e52583 (Task 3, test — keyless loopback smoke)
- GATES: make lint exit 0; make run_tests 116/116; headless boot non-fatal (model absent); vad-segmenter 6/6
