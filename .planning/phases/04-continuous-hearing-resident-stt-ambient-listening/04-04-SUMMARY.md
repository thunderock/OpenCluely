---
phase: 04-continuous-hearing-resident-stt-ambient-listening
plan: 04
subsystem: stt
tags: [speech, vad, two-channel, system-audio, source-tag, whisper-server, session-metadata, node-test, degrade-never-crash]

# Dependency graph
requires:
  - phase: 04-03
    provides: "SpeechService flush seam rewired to whisperServerManager.transcribe() (resident /inference verbose_json + no_speech>0.6 gate); setWhisperServerManager DI setter; the three-gate composition (VAD → no_speech → phrase-list) preserved at the flush site"
  - phase: 04-01
    provides: "WhisperServerManager.transcribe() — the shared resident engine both channels POST to (server serializes internally)"
  - phase: 01
    provides: "Pure VadSegmenter (action-return VAD state machine) that each channel now instantiates independently"
provides:
  - "SpeechService factored into two independent per-channel pipelines (_channels.mic + _channels.system) via _makeChannel; each holds its own VadSegmenter + buffers/bytes + inFlight/pendingFlush/pendingFinal serialization + vad* scalars, so a mic flush in-flight never strands a system utterance and vice-versa (STT-04 separate-channel prerequisite)"
  - "handleSystemAudioChunk(buffer): the main-process system-audio ingest hook (04-05's SystemAudioTapManager feeds it), gated on recording + systemChannelEnabled, driving the SECOND VadSegmenter → whisper-server → transcript tagged source:'system'"
  - "The flush now emits { text, source:'mic'|'system' } (was a bare string); the tag threads emit → on('transcription') → handleTranscriptionFragment → transcription-received broadcast + session metadata"
  - "sessionManager.addUserInput(text, kind, extraMetadata={}) — optional third arg carries the audio channel as SEPARATE metadata ({ channel }); the input-KIND param (chat|speech|llm_input) is NOT overloaded"
  - "setSystemChannelEnabled(enabled) — the flag setter 04-05 flips to activate the system pipeline"
affects:
  - "04-05 (system-audio tap): calls setSystemChannelEnabled(true) + feeds PCM into handleSystemAudioChunk; the whole system pipeline is already wired and independently tested"
  - "04-06 (ambient resilience): both channels reset together on start/stop/cleanup; sleep/wake + device-change handling builds on the per-channel reset helpers"
  - "Phase 6 (relevance gate / self-speech suppression): consumes the source:'mic'|'system' tag (now preserved end-to-end) to distinguish the user's own speech from the other party; Phase 4 only PRESERVES the tag (no fusion/dedup)"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Per-channel pipeline struct: _makeChannel(source) returns { source, segmenter, buffers, bytes, inFlight, pendingFlush, pendingFinal, vad* }; the per-utterance methods take a `channel = this._channels.mic` param (mic default = byte-for-byte back-compat) and mutate that channel's state only"
    - "One shared VAD tuning block, two segmenter instances: both channels read the SAME _getVadEnergyFloor/_getSilenceHangoverMs/_getMinUtteranceMs/_getMaxUtteranceMs/_getPreRollMs getters each chunk — tuning is locked identical for Phase 4 (comment flags a possible future per-channel vadEnergyFloor override; do NOT diverge now)"
    - "Per-channel flush serialization: inFlight/pendingFlush/pendingFinal live ON the channel, so the flush-in-flight coalescing that stops overlapping transcriptions is now independent per channel"
    - "Tag threaded, not overloaded: the wire/broadcast tag is `source:'mic'|'system'`; at the session boundary it lands as metadata.channel (a SEPARATE key) because metadata.source is already the pre-existing input-KIND — the value is preserved end-to-end, only the key differs to avoid the collision"
    - "Defensive emit tolerance: on('transcription') accepts either { text, source } or a bare string (Azure path / any legacy emit) → bare string treated as source:'mic'"

key-files:
  created: []
  modified:
    - src/services/speech.service.js
    - main.js
    - src/managers/session.manager.js

key-decisions:
  - "channel = mic default on every routed method (_ingestWhisperAudio/_endUtteranceFlush/_flushWhisperSegment) so the renderer + native mic paths behave byte-for-byte as before; system is opt-in via handleSystemAudioChunk"
  - "Session metadata key is `channel` (not `source`) because metadata.source already holds the input-KIND (speech|chat|llm_input); the plan's 'do NOT overload the input-kind param' constraint is honored by using a distinct key — the tag VALUE ('mic'|'system') is unchanged end-to-end"
  - "_finalizeWhisperStop flushes BOTH channels (Promise.all); the system channel returns immediately when empty (tap disabled), so the mic final-flush behavior is unchanged while the system channel finalizes correctly once active"
  - "Watchdog iterates both channels (extracted to _watchdogTickChannel); the system channel is skipped until systemChannelEnabled, so the mic backstop timing is identical to before"
  - "Kept VadSegmenter verbatim — two instances of the same dependency-free class is correct; test/vad-segmenter.test.js stays green (6/6)"
  - "Azure polyfill (lines 1-380) + every Azure method/branch left byte-identical (prove-then-remove; 04-09). The Azure recognized-handler still emits a bare string — tolerated by the sink"

patterns-established:
  - "setSystemChannelEnabled(enabled) + systemChannelEnabled flag: the single gate 04-05 flips; handleSystemAudioChunk + the watchdog + finalize are all no-ops for the system channel until it is set"
  - "addUserInput's optional third `extraMetadata` arg is the general pattern for attaching call-site metadata (here the audio channel) without touching the input-KIND param — existing 2-arg callers unchanged"

# Metrics
duration: 17min
completed: 2026-07-16
---

# Phase 4 Plan 4: Two-Channel Refactor + Source Tag Summary

**SpeechService is now two independent per-channel pipelines (mic renderer path + a new `handleSystemAudioChunk` system path) sharing one locked VAD tuning block, each tagging its transcript `source:'mic'|'system'`, and that tag is threaded end-to-end through `emit('transcription', {text, source})` → `handleTranscriptionFragment` → the window broadcast + session metadata (as a separate `channel` key, never overloading `addUserInput`'s input-kind param).**

## Performance

- **Duration:** 17 min
- **Started:** 2026-07-16T17:07:21Z
- **Completed:** 2026-07-16T17:24:52Z
- **Tasks:** 2
- **Files modified:** 3 (all modified; 0 created, 0 deleted) — +195 / −88 lines

## Accomplishments
- **STT-04 separate-channel prerequisite met:** `SpeechService` was factored from ONE set of channel state (`segmentBuffers`/`segmentBytes`/`transcriptionInFlight`/`pendingFlush`/`pendingFinal`/`_segmenter` + the `vad*` scalars) into `this._channels = { mic, system }`, each built by `_makeChannel(source)` with its own `VadSegmenter`, buffers, byte counter, flush serialization, and VAD scalars. `_ingestWhisperAudio`, `_endUtteranceFlush`, `_flushWhisperSegment`, and the watchdog are all routed by a `channel = this._channels.mic` param; `_resetVadState`/`_resetChannelBuffers`/`_cleanup`/`_startWhisperRecording`/`_finalizeWhisperStop` reset/flush **both** channels. A network-free DI round-trip proved the two channels transcribe independently (feeding only mic never touches the system buffer, and vice-versa).
- **`handleSystemAudioChunk(buffer)` system ingest hook** added — gated on `recording + systemChannelEnabled`, it drives the SECOND `VadSegmenter` + segment pipeline into `whisperServerManager.transcribe()` and tags the result `source:'system'`. `setSystemChannelEnabled(enabled)` is the flag 04-05 flips; until then the mic-only path is byte-for-byte unchanged (system watchdog/finalize/ingest all no-op).
- **One shared VAD tuning block, two instances:** both channels read the SAME `_get*()` tuning getters each chunk (locked; a comment flags a possible future per-channel `vadEnergyFloor` override but does NOT diverge). `VadSegmenter` is untouched — `test/vad-segmenter.test.js` stays 6/6.
- **Source tag threaded end-to-end** (Task 2): the flush emits `{ text, source }`; `on('transcription')` accepts the object (tolerant of a bare string → `mic`) and forwards to `handleTranscriptionFragment({ text, source })`, which resolves the channel, broadcasts `transcription-received { text, source }` to all windows, and calls `sessionManager.addUserInput(fragment, 'speech', { channel })`. `addUserInput` gained an optional third `extraMetadata` arg so the channel rides as a SEPARATE `metadata.channel` key — the input-KIND param (`'speech'`) is never overloaded. A real-module harness proved the session metadata separation, the bare-string tolerance, and the channel resolution.
- **Gates green:** `npx eslint .` exit 0 (whole repo); `make run_tests` **116/116**; headless electron boot clean (session + LLM init, renderer windows spawned, zero uncaught exceptions — the transcription wiring installs without throwing).

## Task Commits

Each task was committed atomically with an explicit pathspec (a sibling 04-07 executor runs concurrently on this branch; commits were scoped to my files only):

1. **Task 1: Factor single-channel state into per-channel pipelines + add handleSystemAudioChunk** - `f0b29a6` (feat)
2. **Task 2: Thread the source tag through the transcript sink** - `ad3e2a4` (feat)

**Plan metadata:** _(final docs commit — see git log)_

## Files Created/Modified
- `src/services/speech.service.js` (modified, +169/−79) - `_makeChannel(source)` + `this._channels = { mic, system }`; `setSystemChannelEnabled` + `systemChannelEnabled` flag; `handleSystemAudioChunk`; all per-utterance methods routed by channel; `_resetChannelBuffers` + `_watchdogTickChannel` helpers; `_finalizeWhisperStop` flushes both channels; flush emits `{ text, source }`. Azure polyfill/methods untouched.
- `main.js` (modified) - `on('transcription')` accepts `{ text, source }` (bare-string tolerant); `handleTranscriptionFragment({ text, source })` resolves the channel, broadcasts `transcription-received { text, source }`, and passes `{ channel }` to `addUserInput`.
- `src/managers/session.manager.js` (modified) - `addUserInput(text, source='chat', extraMetadata={})` — optional third arg merges into metadata AFTER `source`/`textLength`; back-compat for existing 2-arg callers.

## Decisions Made
- **`channel` metadata key, not `source`:** honored the plan's "do NOT overload the input-kind param" constraint by storing the audio channel under a distinct `metadata.channel` key (the tag VALUE 'mic'/'system' is preserved end-to-end; only the session-boundary key differs to avoid colliding with the pre-existing `metadata.source` = input-kind).
- **`mic` default on every routed method** so the renderer + native mic paths are byte-for-byte unchanged; the system channel is strictly opt-in.
- **Flush both channels on stop** via `Promise.all`; the empty system channel is a no-op when its tap is disabled, preserving the mic final-flush behavior exactly.
- **Kept VadSegmenter verbatim** (two identical instances, one shared tuning block) — locked, per the plan; SC5 anchor test stays green.

## Deviations from Plan

No Rule 1-4 deviations (no bugs, missing-critical, blocking, or architectural issues encountered). Two minor in-scope choices worth flagging for transparency:

**1. [Plan-sanctioned] Modified `src/managers/session.manager.js` (not in the plan's `files_modified` frontmatter)**
- **Found during:** Task 2
- **Detail:** The plan's frontmatter `files_modified` lists only `speech.service.js` + `main.js`, but Task 2's `<action>` explicitly instructs: *"If passing channel through requires a new optional arg or a metadata object, add it minimally and back-compat (existing callers unchanged)."* Threading the channel without overloading `addUserInput`'s input-kind param requires exactly that change, so `session.manager.js` was modified as the plan text directs. The frontmatter file list was simply incomplete.
- **Change:** `addUserInput` gained an optional third `extraMetadata = {}` arg (spread into metadata after `source`/`textLength`). Fully back-compat — the two existing 2-arg callers (`'chat'`, `'llm_input'`) are unchanged.
- **Committed in:** `ad3e2a4` (Task 2 commit).

**2. [Rule 2 - Missing Critical, minor] Added `setSystemChannelEnabled(enabled)` setter**
- **Found during:** Task 1
- **Detail:** The plan specifies gating `handleSystemAudioChunk` on "a `systemChannelEnabled` flag" and frames it as "the hook 04-05's SystemAudioTapManager feeds." A documented hook needs an operable enable mechanism; the setter lets 04-05 activate the system pipeline without reaching into SpeechService internals.
- **Change:** `setSystemChannelEnabled(enabled) { this.systemChannelEnabled = !!enabled; }` + the `systemChannelEnabled = false` default in the constructor.
- **Committed in:** `f0b29a6` (Task 1 commit).

---

**Total deviations:** 0 Rule-based (bug/blocking/architectural). 2 minor in-scope additions (1 plan-sanctioned session.manager.js change, 1 hook-enabler setter).
**Impact on plan:** Both are necessary to satisfy the plan's own instructions (thread the tag without overloading the kind param; make the 04-05 hook operable). No scope creep — the mic path is behaviorally unchanged, Azure is untouched, and no fusion/dedup was built (correctly deferred to Phase 6).

## Issues Encountered
- **Live GUI transcript not driven through a window here.** `main.js` is the Electron entry (self-instantiates `ApplicationController` under the single-instance lock) and cannot be `require()`d standalone, and this environment has no attended GUI/audio to speak into. Per the repo rule (waive un-runnable live checks, substitute keyless wiring proofs), the sink was verified by: (a) a **real-module** harness proving `sessionManager.addUserInput('hi','speech',{channel:'system'})` yields `metadata.source==='speech'` (kind intact) + `metadata.channel==='system'` (separate), the `on('transcription')` binding logic is bare-string tolerant, and the channel resolution defaults to `mic`; (b) a **real-singleton** harness driving the actual `SpeechService` VAD pipeline for both channels (loud→silent PCM) and asserting the emitted objects are `{text,source:'mic'}` and `{text,source:'system'}`, that channels are independent, that the `systemChannelEnabled` gate drops chunks when off, and that the hallucination filter still suppresses `'thank you'`; (c) a **headless electron boot** confirming main.js loads and the wiring installs with no uncaught exception. The full mic+system end-to-end on real audio is exercised at the **04-08 validation gate** (with a downloaded model) and when **04-05** lands the real tap.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- **04-05 (system-audio tap):** the entire system pipeline is wired and independently tested — the tap only needs to `speechService.setSystemChannelEnabled(true)` and feed 16 kHz mono 16-bit PCM into `handleSystemAudioChunk(buffer)`. Transcripts will flow out tagged `source:'system'` with no further sink work.
- **04-06 (ambient resilience):** per-channel reset helpers (`_resetChannelBuffers`/`_resetVadState`) reset both channels together on start/stop/cleanup — the foundation for sleep/wake + mic-device-change handling.
- **Phase 6 (relevance gate):** the `source:'mic'|'system'` tag is now preserved end-to-end (emit → broadcast → session `metadata.channel`) for self-speech suppression / other-party distinction. Phase 4 built no fusion or dedup (deferred, as planned).
- **Concern:** live mic+system transcription on real audio is still unproven here (no attended GUI/audio + model not downloaded) — deferred to 04-05 (real tap) and 04-08 (validation gate).

---
*Phase: 04-continuous-hearing-resident-stt-ambient-listening*
*Completed: 2026-07-16*

## Self-Check: PASSED

- FOUND: src/services/speech.service.js (per-channel struct + handleSystemAudioChunk + tagged emit)
- FOUND: main.js ({ text, source } sink threading)
- FOUND: src/managers/session.manager.js (addUserInput optional extraMetadata)
- FOUND: .planning/phases/04-.../04-04-SUMMARY.md
- FOUND: commit f0b29a6 (Task 1, feat — per-channel pipelines + system ingest)
- FOUND: commit ad3e2a4 (Task 2, feat — source tag threaded through the sink)
- ANCHORS: handleSystemAudioChunk, emit { text, source }, addUserInput(...,{ channel }) all present
- GATES: npx eslint . exit 0 (whole repo); make run_tests 116/116; test/vad-segmenter.test.js 6/6; headless electron boot clean (no uncaught exception)
- MUST-HAVES: 4/4 truths satisfied (per-channel state, handleSystemAudioChunk→system tag, {text,source} end-to-end without kind overload, one shared VAD tuning block / two instances)
