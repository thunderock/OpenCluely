---
phase: 04-continuous-hearing-resident-stt-ambient-listening
plan: 04
type: execute
wave: 3
depends_on: ["04-03"]
files_modified:
  - src/services/speech.service.js
  - main.js
autonomous: true

must_haves:
  truths:
    - "SpeechService holds per-channel state (segmenter/buffers/bytes/inFlight/pendingFlush/pendingFinal/source), so mic and system transcribe independently (STT-04 separate-channel prerequisite)"
    - "A new handleSystemAudioChunk(buffer) ingest path drives a SECOND VadSegmenter + segment pipeline → whisper-server → transcript tagged source:'system'"
    - "Each transcript carries {text, source:'mic'|'system'} end-to-end through emit → handleTranscriptionFragment → session, without overloading addUserInput's input-kind param"
    - "Both channels share ONE VAD tuning block (two VadSegmenter instances, same tuning)"
  artifacts:
    - path: "src/services/speech.service.js"
      provides: "Per-channel struct + routed _ingestWhisperAudio/_flushWhisperSegment/_endUtteranceFlush/_startSegmentWatchdog; handleSystemAudioChunk; emit {text,source}"
      contains: "handleSystemAudioChunk"
    - path: "main.js"
      provides: "Transcript sink threads the source tag: on('transcription',{text,source}) → handleTranscriptionFragment({text,source}) → broadcast + session metadata"
      contains: "source"
  key_links:
    - from: "src/services/speech.service.js:_flushWhisperSegment"
      to: "main.js:handleTranscriptionFragment"
      via: "emit('transcription',{text,source}) then on('transcription', ({text,source})=>...)"
      pattern: "source"
    - from: "main.js:handleTranscriptionFragment"
      to: "sessionManager.addUserInput"
      via: "channel tag as separate metadata (NOT overloading the source='speech' input-kind param)"
      pattern: "addUserInput"
---

<objective>
Refactor `SpeechService` from single-channel to per-channel pipelines so mic and system audio transcribe independently, and thread a `source:'mic'|'system'` tag end-to-end through the transcript sink. This is the biggest structural change in the service and the prerequisite for wiring the macOS system-audio channel (04-05).

Purpose: STT-04 "separate channel" — two independent `VadSegmenter` + segment pipelines (mic renderer path + a new `handleSystemAudioChunk` main-process path), each POSTing to the same resident whisper-server, each tagging its transcript. Phase 6 consumes the tag; Phase 4 only preserves it. The two segmenters SHARE one tuning block (locked).
Output: per-channel `SpeechService` + source-tagged sink.
</objective>

<execution_context>
@~/.claude/get-shit-done/workflows/execute-plan.md
@~/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/phases/04-continuous-hearing-resident-stt-ambient-listening/04-CONTEXT.md
@.planning/phases/04-continuous-hearing-resident-stt-ambient-listening/04-RESEARCH.md
@.planning/phases/04-continuous-hearing-resident-stt-ambient-listening/04-03-SUMMARY.md

# Live seams (verified):
@src/services/speech.service.js
@src/core/vad-segmenter.js
@src/managers/session.manager.js
</context>

<tasks>

<task type="auto">
  <name>Task 1: Factor single-channel state into per-channel pipelines + add handleSystemAudioChunk</name>
  <files>src/services/speech.service.js</files>
  <action>
Today `SpeechService` holds ONE set of channel state: `this.segmentBuffers`, `this.segmentBytes`, `this.transcriptionInFlight`, `this.pendingFlush`, `this.pendingFinal`, `this._segmenter`, plus the VAD scalars (`vadSpeaking`, `vadSpeechMs`, `vadLastChunkAt`). Factor these into a small per-channel object created twice:
```
_makeChannel(source) {
  return { source, segmenter: new VadSegmenter(), buffers: [], bytes: 0,
           inFlight: false, pendingFlush: false, pendingFinal: false,
           vadSpeaking: false, vadSpeechMs: 0, vadLastChunkAt: 0 };
}
this._channels = { mic: this._makeChannel('mic'), system: this._makeChannel('system') };
```
Route the per-utterance methods by channel (pass the channel object, default `mic` for back-compat):
- `_ingestWhisperAudio(buffer, channel = this._channels.mic)` — read the SHARED tuning via the existing getters (both channels use one tuning block: `_getVadEnergyFloor`/`_getSilenceHangoverMs`/`_getMinUtteranceMs`/`_getMaxUtteranceMs`/`_getPreRollMs`). Push/flush/discard against `channel.buffers`/`channel.bytes`.
- `_endUtteranceFlush(channel)`, `_flushWhisperSegment({ final }, channel)` — keep the `inFlight`/`pendingFlush`/`pendingFinal` serialization PER CHANNEL (so a mic flush in-flight doesn't strand a system utterance and vice-versa). Each channel POSTs independently to `whisperServerManager.transcribe()` (the server serializes internally — fine for Phase 4).
- `_startSegmentWatchdog` — iterate both channels (or run per-channel timers); apply the stall/too-long backstop per channel.
- `handleAudioChunkFromRenderer(chunk)` — routes to `this._channels.mic`.
- ADD `handleSystemAudioChunk(buffer)` — the new main-process ingest path: gate on recording + a `systemChannelEnabled` flag; `_ingestWhisperAudio(Buffer.from(buffer), this._channels.system)`. This is the hook 04-05's SystemAudioTapManager feeds.
- On flush success, `this.emit('transcription', { text: clean, source: channel.source })` (was a bare string) — see Task 2 for the sink update.
- `_resetVadState`/`_cleanup`/`startRecording`/`stopRecording` reset BOTH channels.
Keep `VadSegmenter` verbatim (it is already dependency-free; two instances of the same tuning is correct — note in a comment that system/line-level audio MAY want a per-channel `vadEnergyFloor` override in a future tuning pass, but do NOT diverge now).
Do NOT touch the Azure polyfill/methods (04-09).
  </action>
  <verify>`npx eslint src/services/speech.service.js` clean. `grep -n "handleSystemAudioChunk\|_channels\|source:" src/services/speech.service.js` shows the per-channel struct + system ingest + tagged emit. The mic path still routes through `handleAudioChunkFromRenderer` → `_channels.mic`. `node --test test/vad-segmenter.test.js` still green (VadSegmenter unchanged).</verify>
  <done>SpeechService drives two independent per-channel pipelines sharing one tuning block; handleSystemAudioChunk exists; flush emits {text, source}; the mic path is unchanged in behavior.</done>
</task>

<task type="auto">
  <name>Task 2: Thread the source tag through the transcript sink</name>
  <files>main.js</files>
  <action>
Update the sink wiring (verified `:372-374`, `:1226-1249`):
- `speechService.on('transcription', ...)` (`:372`): accept the object — `({ text, source }) => this.handleTranscriptionFragment({ text, source })`. Be tolerant of a bare string too (defensive) during the transition.
- `handleTranscriptionFragment({ text, source })` (`:1226-1249`): destructure; keep the existing coalescing/utterance-buffer logic. Broadcast `transcription-received { text, source }` to all windows (so the UI can later label mic vs other party — minimal; Phase 6 consumes it). Carry the channel tag into the session as SEPARATE metadata — do NOT overload `sessionManager.addUserInput(fragment, 'speech')`'s second param (that param is the input-KIND `chat|speech|llm_input`, `session.manager.js:111`). If passing channel through requires a new optional arg or a metadata object, add it minimally and back-compat (existing callers unchanged). Keep `addUserInput(fragment, 'speech')` for the kind; attach `source` alongside.
Phase 4 only needs the tag PRESERVED end-to-end; do not build any mic/system fusion or dedup (deferred).
  </action>
  <verify>`grep -n "source" main.js | grep -iE "transcription|handleTranscriptionFragment"` shows the threaded tag. `npx eslint main.js` clean. App boots headless without throwing. A unit-level sanity: emitting `{text:'hi',source:'system'}` from a fake speechService reaches `handleTranscriptionFragment` and broadcasts `transcription-received {text:'hi',source:'system'}` (trace by log or a minimal harness).</verify>
  <done>The transcript sink threads {text, source} from emit through handleTranscriptionFragment to the window broadcast + session metadata, without overloading addUserInput's input-kind param.</done>
</task>

</tasks>

<verification>
- `make run_tests` green (vad-segmenter + all existing); `make lint` exits 0.
- Two independent per-channel pipelines exist (mic + system) sharing one tuning block.
- `handleSystemAudioChunk` is present as the system ingest hook for 04-05.
- Transcripts carry `{text, source}` end-to-end; addUserInput's input-kind param is not overloaded.
</verification>

<success_criteria>
- STT-04 prerequisite: SpeechService transcribes mic and system as independent, separately-tagged channels sharing one VAD tuning block.
- The source tag is preserved end-to-end (mic path behavior unchanged; system hook ready for the tap).
</success_criteria>

<output>
After completion, create `.planning/phases/04-continuous-hearing-resident-stt-ambient-listening/04-04-SUMMARY.md`
</output>
