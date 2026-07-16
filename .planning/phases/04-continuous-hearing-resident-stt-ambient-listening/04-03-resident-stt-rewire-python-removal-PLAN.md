---
phase: 04-continuous-hearing-resident-stt-ambient-listening
plan: 03
type: execute
wave: 2
depends_on: ["04-01", "04-02"]
files_modified:
  - src/services/speech.service.js
  - main.js
  - preload.js
  - src/core/whisper-installer.js
  - scripts/smoke-whisper.js
autonomous: true

must_haves:
  truths:
    - "Each VAD segment transcribes against the resident whisper-server via POST /inference with NO per-utterance process/model spawn or cold-start (STT-01/SC1)"
    - "The Python-Whisper subprocess path is deleted: _transcribeWhisperFile/_resolveWhisperCommand/probes + whisper-installer.js venv machinery are gone (STT-01/SC1)"
    - "whisper-server starts pre-warmed after app.whenReady() non-blocking + non-fatal, and stops on quit; engine-down shows inline 'voice unavailable' + retry (typing/screenshot unaffected)"
    - "The keyless loopback smoke transcribes a known WAV over /inference?response_format=verbose_json and logs latency + no_speech_prob"
  artifacts:
    - path: "src/services/speech.service.js"
      provides: "_flushWhisperSegment rewired to whisperServerManager.transcribe(); Python transcribe/probe/venv path deleted; _isHallucinatedTranscript still applied at the flush site"
      contains: "transcribe"
    - path: "scripts/smoke-whisper.js"
      provides: "Keyless loopback STT smoke (start manager → POST known WAV verbose_json → assert non-empty transcript + log latency/no_speech_prob)"
      min_lines: 60
    - path: "main.js"
      provides: "getWhisperServerManager() lazy getter; start in onAppReady (non-fatal) + stop in onWillQuit; whisper-server IPC (status/recover/ggml-download) + Python-IPC removed"
      contains: "getWhisperServerManager"
  key_links:
    - from: "src/services/speech.service.js:_flushWhisperSegment"
      to: "src/core/whisper-server.manager.js:transcribe"
      via: "injected manager.transcribe(wavBuffer,{language}) replacing _transcribeWhisperBuffer"
      pattern: "transcribe"
    - from: "main.js:onAppReady"
      to: "getWhisperServerManager().start()"
      via: "non-blocking non-fatal pre-warm, mirroring getLocalModelManager().start()"
      pattern: "getWhisperServerManager"
    - from: "main.js download-whisper-model IPC"
      to: "src/core/whisper-model-downloader.js"
      via: "streams structured progress to install-progress"
      pattern: "whisper-model-downloader"
---

<objective>
Replace the per-utterance Python-Whisper subprocess with the resident whisper-server (STT-01/SC1). Rewire `speech.service.js` `_flushWhisperSegment` to call `WhisperServerManager.transcribe()` over `POST /inference`, delete the entire Python STT path, wire the manager into `main.js` (pre-warmed, non-blocking, non-fatal; stop on quit), rewire the download IPC to the 04-02 ggml downloader, remove the Python installer IPC + `whisper-installer.js`, and add a keyless loopback smoke.

Purpose: STT-01/SC1 — resident transcription with no per-utterance spawn/cold-start; the Python subprocess + venv path is deleted. Engine-down degrades gracefully (inline "voice unavailable" + retry; typing + screenshot keep working — mirror Phase 3's Local-down UX). This is the first end-to-end proof of the mic path.
Output: rewired speech.service.js + main.js, deleted whisper-installer.js, `scripts/smoke-whisper.js`.
</objective>

<execution_context>
@~/.claude/get-shit-done/workflows/execute-plan.md
@~/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/04-continuous-hearing-resident-stt-ambient-listening/04-CONTEXT.md
@.planning/phases/04-continuous-hearing-resident-stt-ambient-listening/04-RESEARCH.md
@.planning/phases/04-continuous-hearing-resident-stt-ambient-listening/04-01-SUMMARY.md
@.planning/phases/04-continuous-hearing-resident-stt-ambient-listening/04-02-SUMMARY.md

# Live seams (verified 2026-07-15/16):
@src/services/speech.service.js
@src/core/local-model.manager.js
@scripts/smoke-local.js
</context>

<tasks>

<task type="auto">
  <name>Task 1: Rewire the flush seam to the resident engine + delete the Python STT path</name>
  <files>src/services/speech.service.js</files>
  <action>
Accept the `WhisperServerManager` via DI: add an optional setter/inject (e.g. `setWhisperServerManager(mgr)` or a lazy `require`) so main.js hands the started singleton in; keep the module export as the singleton (`module.exports = new SpeechService()`), matching today. Do NOT construct the manager at import time (tests must not spawn).

Rewire the flush seam (verified lines):
- `_flushWhisperSegment` (`:1593-1635`): keep the `transcriptionInFlight`/`pendingFlush`/`pendingFinal` serialization and the `Buffer.concat(this.segmentBuffers, this.segmentBytes)` framing EXACTLY. Replace the `await this._transcribeWhisperBuffer(audioBuffer)` call with: build the WAV via the retained `_createWavBuffer(audioBuffer)` (`:1737-1760`) and `await whisperServerManager.transcribe(wav, { language })`. Take `.text` from the result. KEEP the existing gate application at `:1620-1624`: `if (clean && !this._isHallucinatedTranscript(clean)) this.emit('transcription', clean)` — so the three gates compose (VAD segmenter → no_speech_prob>0.6 inside manager.transcribe → phrase-list `_isHallucinatedTranscript` here). If the manager is unavailable/engine-down, log + degrade (no crash), do NOT fall back to Python.
- Rewire `_initializeWhisperClient` (`:512-537`): drop `_resolveWhisperCommand`; set `this.available` from the manager's health (server up + model present) instead of `this.whisperCommand`. Keep `provider='whisper'` semantics (the resident engine IS the whisper provider). Emit the same status strings.
- Rewire `isAvailable()`/`getStatus()`/`testConnection()` whisper branches to read the manager status (three-level: server up / model present / responding → three messages, Pitfall 4) instead of `this.whisperCommand`. Keep the Azure branches intact (prove-then-remove — 04-09 removes them).
- Keep verbatim: `VadSegmenter` usage, `_resetVadState`, `_startSegmentWatchdog` (`:733-760`), `handleAudioChunkFromRenderer` (`:766-775`), `_ingestWhisperAudio` (`:783-820`), `_endUtteranceFlush` (`:823-830`), `_isHallucinatedTranscript` (`:1643-1665`), `_createWavBuffer` (`:1737-1760`), renderer-capture gating (`useRendererCapture`).

DELETE the Python STT path entirely (STT-01/SC1, research Flag 7 "delete" rows): `_transcribeWhisperBuffer` (`:1667-1677`), `_transcribeWhisperFile` (`:1679-1735`), `_resolveWhisperCommand` (`:1216-1257`), `_getUserDataWhisperCandidate` (`:1200-1214`), `_probeWhisperModuleFast` (`:1267-1292`), `_probeWhisperCandidate` (`:1298-1370`), `_expandConfiguredWhisperCandidates` (`:1372-1428`), `_parseCommand` (`:1430-1447`), `_getUserDataModelDir` (`:1135-1142`), `_removeTempDir` (if now unused), and the Python-oriented getters (`_getWhisperModelDir`, `_getWhisperSegmentMs` if now unused; keep `_getWhisperModel`/`_getWhisperLanguage` but simplify to read the collapsed config — model default `small.en`). Remove `this.whisperCommand` state + the `spawn/spawnSync` requires if now unused. Do NOT touch the Azure polyfill (`:1-380`) or Azure methods yet (04-09). Keep `node-record-lpcm16` (Linux mic).
  </action>
  <verify>`npx eslint src/services/speech.service.js` clean (no undefined refs after deletions). `grep -n "_transcribeWhisperFile\|_resolveWhisperCommand\|_probeWhisperCandidate\|venv" src/services/speech.service.js` returns nothing. `grep -n "whisperServerManager\|\.transcribe(" src/services/speech.service.js` shows the rewired flush. The three-gate composition (`_isHallucinatedTranscript` still applied) is intact at the flush site.</verify>
  <done>_flushWhisperSegment transcribes via the injected resident manager; the entire Python transcribe/probe/venv-candidate path is deleted; the phrase-list gate still guards emit('transcription'); Azure code untouched.</done>
</task>

<task type="auto">
  <name>Task 2: main.js manager wiring + whisper IPC + retire the Python installer</name>
  <files>main.js, preload.js, src/core/whisper-installer.js</files>
  <action>
main.js:
- Add a lazy `getWhisperServerManager()` (mirror `getLocalModelManager()` at `:1546-1552`): `require('./src/core/whisper-server.manager')`, construct once. Lazy so import/tests never spawn.
- In `onAppReady` (`:283-296`, right after the LocalModelManager start), start the whisper-server manager in an isolated try/catch — NON-BLOCKING + NON-FATAL (same shape): `await getWhisperServerManager().start()`; log status; a failure is logged and the app continues (the inline "voice unavailable" UX surfaces recovery). Then inject it into the speech service (`speechService.setWhisperServerManager(getWhisperServerManager())`).
- In `onWillQuit` (`:1511-1528`, alongside the LocalModelManager stop): fire-and-forget `getWhisperServerManager().stop()`.
- IPC: ADD `get-whisper-status` (returns the manager's 3-level health) and `whisper-recover` (restart the owned server / re-download the model) handlers + preload bridges (mirror `get-model-status`/`recover-model`). REWIRE the existing `download-whisper-model` handler (`:738-752`) to call the 04-02 `WhisperModelDownloader.download('small.en', { onProgress })` streaming structured `{percent,...}` to `install-progress` (keep the channel name the onboarding/settings UI already listens on). DELETE the Python IPC handlers `detect-whisper` (`:709-717`) and `install-whisper` (`:721-735`) and the `getWhisperInstaller()` lazy getter (`:1530-1541`).
- The three-health → three inline UI messages: reuse the Phase-3 `showLocalUnavailable`-style pattern for voice: "voice engine down" (server down) / "voice model missing — download" (model absent) / "voice engine not responding — repair" (responding false). Wire a `voice-unavailable` broadcast (or reuse the speech-status/speech-error channels) so the overlay can show the inline panel + one-click retry; typing + screenshot are unaffected.

preload.js: add `getWhisperStatus`/`recoverWhisper` bridges (mirror `getModelStatus`/`recoverModel`); leave `downloadWhisperModel`/`onInstallProgress` (reused, now ggml). Remove `detectWhisper`/`installWhisper` bridges (their handlers are gone) — the onboarding renderer stops calling them in 04-07.

DELETE `src/core/whisper-installer.js` (the entire venv/pip module — replaced by the 04-02 downloader; STT-01 "delete .venv-whisper path"). Ensure no remaining `require('./src/core/whisper-installer')` anywhere (`grep`).
  </action>
  <verify>`grep -rn "whisper-installer\|getWhisperInstaller\|detect-whisper\|install-whisper" main.js preload.js src/` returns nothing (module + IPC + getter gone). `grep -n "getWhisperServerManager" main.js` shows lazy getter + start + stop + inject. `npx eslint main.js preload.js` clean. App boots headless without throwing on the missing binary/model (non-fatal): `env -u ELECTRON_RUN_AS_NODE timeout 20 npx electron . 2>&1 | grep -iE "whisper|voice|started"` shows the manager start attempt logged, no crash.</verify>
  <done>WhisperServerManager is lazily constructed, pre-warmed non-blocking/non-fatal in onAppReady, injected into speechService, and stopped on quit; download-whisper-model streams the ggml downloader; the Python detect/install IPC + whisper-installer.js are deleted; three-level health drives three inline UI messages.</done>
</task>

<task type="auto">
  <name>Task 3: Keyless loopback smoke + confirm VAD suite green</name>
  <files>scripts/smoke-whisper.js</files>
  <action>
Create `scripts/smoke-whisper.js` modeled on `scripts/smoke-local.js` (keyless, network-free/loopback-only, NOT a test-glob file so it never runs in CI). Behavior:
1. Construct + `start()` the `WhisperServerManager` (reads config).
2. Generate or load a known short 16 kHz mono WAV containing a simple spoken phrase (bundle a tiny fixture WAV under `test/fixtures/` OR synthesize a deterministic tone + document that a real phrase WAV is needed for an accuracy check; the wiring assertion is the primary goal per the "keyless wiring check, waive un-runnable live checks" memory rule).
3. `POST` it via `manager.transcribe(wav, { language:'en' })` (which uses `/inference?response_format=verbose_json`).
4. Assert a non-empty transcript (or, if the fixture is a synthetic tone, assert the round-trip succeeds + segments[] parsed); LOG wall-clock latency + the returned `no_speech_prob` values.
5. Exit codes like smoke-local (0 = wiring/latency OK; non-zero = engine unreachable / model missing — eyeballable, never blocks CI). Print an actionable message if the binary/model are absent ("run `node scripts/build-whisper-server.js` and download ggml-small.en first").
Also re-run and confirm `test/vad-segmenter.test.js` (SC5 anchor) still passes unchanged.
  </action>
  <verify>`node scripts/smoke-whisper.js` — with the binary built (04-01) + a model present, prints a non-empty transcript + latency + no_speech_prob and exits 0; without them, prints the actionable message + non-zero (does NOT crash). If a full run is un-runnable in this environment, WAIVE the live transcript and confirm the keyless wiring (manager constructs, start attempted, transcribe path reachable) + document it. `node --test test/vad-segmenter.test.js` passes. `npx eslint scripts/smoke-whisper.js` clean.</verify>
  <done>A keyless loopback smoke proves (or waives-with-wiring-check) the mic /inference path end-to-end and logs latency + no_speech_prob; vad-segmenter.test.js still green.</done>
</task>

</tasks>

<verification>
- `make run_tests` green; `make lint` exits 0.
- No `whisper-installer`, `getWhisperInstaller`, `detect-whisper`, `install-whisper`, `_transcribeWhisperFile`, `_resolveWhisperCommand`, or `venv` references remain in main.js/preload.js/src.
- App boots headless without crashing when the binary/model are absent (non-fatal pre-warm; inline "voice unavailable" path).
- `scripts/smoke-whisper.js` proves (or waives-with-wiring-check) the resident /inference mic path.
</verification>

<success_criteria>
- STT-01/SC1: each VAD segment transcribes against the resident whisper-server with no per-utterance process/model spawn; the Python subprocess + venv path is deleted.
- Engine-down degrades gracefully (inline "voice unavailable" + retry; typing/screenshot unaffected).
- The keyless smoke logs latency + no_speech_prob for the mic path.
</success_criteria>

<output>
After completion, create `.planning/phases/04-continuous-hearing-resident-stt-ambient-listening/04-03-SUMMARY.md`
</output>
