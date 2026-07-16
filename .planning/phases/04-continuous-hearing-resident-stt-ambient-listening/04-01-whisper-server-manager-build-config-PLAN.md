---
phase: 04-continuous-hearing-resident-stt-ambient-listening
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - scripts/build-whisper-server.js
  - src/core/whisper-server.manager.js
  - src/core/config.js
  - test/whisper-server-manager.test.js
  - package.json
autonomous: true

must_haves:
  truths:
    - "A resident whisper-server transcribes a WAV segment over POST /inference with no per-utterance process spawn (STT-01/SC1)"
    - "Transcription requests use response_format=verbose_json and segments with no_speech_prob > 0.6 are dropped before concatenation (SC5 second gate)"
    - "whisper-server builds from source (whisper.cpp v1.9.1, Metal) into resources/bin on darwin and is a no-op off-darwin (STT-01 packaging prereq)"
    - "The speech config collapses to a single local whisper-server block (host/port/model=small.en/threads/noSpeechThreshold + shared VAD knobs)"
  artifacts:
    - path: "src/core/whisper-server.manager.js"
      provides: "WhisperServerManager: binary resolution + Mach-O verify, free-port select, ServiceSupervisor(adopt:false,pidFile,SIGTERM grace), 3-level health, transcribe(wav) via verbose_json + no_speech gate"
      min_lines: 120
    - path: "scripts/build-whisper-server.js"
      provides: "CMake build of whisper-server v1.9.1 (Metal) into resources/bin, source-hash cache, arch verify, exit-0 no-op off-darwin"
      min_lines: 60
    - path: "src/core/config.js"
      provides: "Collapsed speech.whisper whisper-server config block"
      contains: "noSpeechThreshold"
    - path: "test/whisper-server-manager.test.js"
      provides: "node:test suite: free-port, 3-level health, verbose_json segments[] parse + no_speech gate, arch verify — fake spawn/HTTP"
      min_lines: 80
  key_links:
    - from: "src/core/whisper-server.manager.js"
      to: "src/core/service-supervisor.js"
      via: "new ServiceSupervisor(def,{spawn}) with {healthCheck:{type:'port',port},adopt:false,pidFile,terminate:{sigtermGraceMs:5000}}"
      pattern: "ServiceSupervisor"
    - from: "src/core/whisper-server.manager.js"
      to: "whisper-server POST /inference"
      via: "verbose_json multipart transcribe over Node http / nodeFetch (never global fetch)"
      pattern: "verbose_json"
---

<objective>
Build the resident STT engine's supervised process manager and its from-source binary build, and collapse the speech config to a single local whisper-server block. This is the foundation the whole phase stands on: a `WhisperServerManager` (mirroring `LocalModelManager`'s DI shape) that supervises a from-source-built `whisper-server` via the Phase-1 `ServiceSupervisor`, selects a free port at start, exposes three-level health, and transcribes a WAV buffer over `POST /inference?response_format=verbose_json` — dropping segments whose `no_speech_prob > 0.6` (the SC5 second gate) before returning concatenated text.

Purpose: Replace the per-utterance Python-Whisper subprocess with a resident engine (STT-01/SC1) and provide the probabilistic silence gate (SC5). No speech.service.js edits here — this plan produces the reusable, unit-testable pieces; the flush rewire lands in 04-03.
Output: `WhisperServerManager`, `scripts/build-whisper-server.js`, collapsed `speech.whisper` config, and a node:test suite.
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

# Reuse targets (verified live 2026-07-15/16):
@src/core/service-supervisor.js
@src/core/local-model.manager.js
@src/core/local-transport.js
@src/core/config.js
@test/service-supervisor.test.js
</context>

<tasks>

<task type="auto">
  <name>Task 1: Build whisper-server from source into resources/bin</name>
  <files>scripts/build-whisper-server.js, package.json</files>
  <action>
Create `scripts/build-whisper-server.js` mirroring openwhispr's `build-macos-audio-tap.js` philosophy (compile at build time, verify Mach-O arch, no-op off-darwin). Behavior:
- On non-darwin: `process.exit(0)` immediately (no-op) — Windows/Linux system-audio + STT are out of scope this phase.
- On darwin: clone/checkout whisper.cpp pinned to tag `v1.9.1` (into a build cache dir, e.g. `resources/.whisper-cpp-src` or a temp dir), then `cmake -B build -DCMAKE_BUILD_TYPE=Release` and `cmake --build build --target whisper-server -j`. Metal is ON by default on Apple Silicon — do NOT pass a flag to disable it. Copy `build/bin/whisper-server` → `resources/bin/whisper-server` (create dirs).
- Cache by a source signature (tag + a marker file) so a second run is a fast no-op if the binary already exists and matches.
- Verify the produced Mach-O magic (`0xfeedfacf`) + cpu-type before accepting it (arm64/x64 guard), same as the LocalModelManager `_resolveOllamaBin` / openwhispr arch-verify pattern.
- Use `node:child_process` (execFileSync/spawnSync) and `node:fs`; log via `require('../src/core/logger').createServiceLogger('WHISPER-BUILD')` (never interpolate variable data into the message).
Add an npm script `"compile:whisper-server": "node scripts/build-whisper-server.js"` to package.json (additive — do not touch the microsoft-cognitiveservices-speech-sdk dep; that is 04-09's job).
Phase 8 owns the final asarUnpack/DMG/CI fetch-vs-build decision; this plan only needs the binary resolvable in dev at `resources/bin/whisper-server`.
  </action>
  <verify>On this darwin machine: `node scripts/build-whisper-server.js` exits 0 and `resources/bin/whisper-server` exists and is an arm64 Mach-O (`file resources/bin/whisper-server` shows Mach-O arm64; `resources/bin/whisper-server --help` prints usage). If Xcode CLT/CMake are missing, the script must fail with a clear actionable message (not a stack trace). Simulate off-darwin by forcing platform → exits 0 no-op. `npx eslint scripts/build-whisper-server.js` clean.</verify>
  <done>whisper-server v1.9.1 (Metal) is built into resources/bin on darwin with an arch-verified Mach-O; the script is a clean exit-0 no-op off-darwin; npm script wired.</done>
</task>

<task type="auto">
  <name>Task 2: WhisperServerManager + config collapse</name>
  <files>src/core/whisper-server.manager.js, src/core/config.js</files>
  <action>
Create `src/core/whisper-server.manager.js` exporting `WhisperServerManager`, mirroring `local-model.manager.js` DI shape EXACTLY: `constructor({ supervisor, spawn, config, logger, fetchImpl } = {})`, default to real singletons, every method returns a status/struct instead of throwing (degrade, never crash). Logger tag `'WHISPER'`.

It owns:
- **Binary resolution** (mirror `LocalModelManager._resolveOllamaBin` + openwhispr `resolveBinary()`): dev `<appRoot>/resources/bin/whisper-server`; packaged `process.resourcesPath/bin/whisper-server`. Verify Mach-O magic (`0xfeedfacf`) + cpu-type before trusting (arm64/x64 guard). Null → not-installed status (guide/build UX), never throw.
- **Model file resolution**: `<userData>/.whisper-models/ggml-${model}.bin` (model from `config.get('speech.whisper.model')`, default `small.en`; reuse the same dir the downloader/installer use). `modelPresent()` = fs.existsSync.
- **Free-port selection at start()**: bind `net.createServer().listen(0)`, read `.address().port`, close, pass to `whisper-server --host 127.0.0.1 --port <p> -m <modelPath> -t <threads>` AND to the supervisor `healthCheck.port`. get-port is ESM-banned — use `net`. On restart, RE-PICK the port (a fixed port could be orphan-held → EADDRINUSE).
- **Thread auto-tuning**: `threads = clamp(Math.floor(os.availableParallelism()*0.5), 2, 8)` (conservative — leave cores for the resident VLM, Pitfall 2). Overridable via `WHISPER_THREADS` / `config.get('speech.whisper.threads')` (0 = auto).
- **Supervision**: `new ServiceSupervisor(def, { spawn })` with `def = { name:'whisper-server', command:<bin>, args:[...], healthCheck:{ type:'port', port }, adopt:false, pidFile:<userData>/.whisper-server.pid, terminate:{ sigtermGraceMs:5000 }, backoff:{ initialDelayMs:500, multiplier:2, maxDelayMs:15000, maxRetries:8 }, startupTimeoutMs:30000 }`. `_ownsSupervisor` guard like LocalModelManager (so an injected supervisor is trusted in tests).
- **Lifecycle**: `async start()` (build args with the freshly-picked port + threads, then `supervisor.start()`; non-fatal — return status), `async stop()` (`supervisor.stop()`).
- **Three-level health** (`getStatus()`, Pitfall 4): (1) server up = supervisor healthy / port open (`ServiceSupervisor.probePort`); (2) model ready = `.bin` present on disk; (3) responding = a tiny `/inference` probe or `probePort`-plus-flag. Return `{ binaryPresent, modelPresent, serverUp, responding, state, pid }`. Never let a responding-probe failure flip serverUp (mirror the LocalModelManager guard).
- **transcribe(wavBuffer, { language })**: `POST http://127.0.0.1:<port>/inference`, multipart/form-data, field `file` = the WAV (filename `segment.wav`), `response_format=verbose_json` (**REQUIRED** — `no_speech_prob` exists ONLY in verbose_json; `json` omits it), `language` = language || `config.get('speech.whisper.language')` || `'en'`, `temperature=0`. Parse the JSON: iterate `segments[]`, DROP any segment with `no_speech_prob > noSpeechThreshold` (`config.get('speech.whisper.noSpeechThreshold')`, default 0.6), concatenate surviving `segment.text`, trim, and return `{ text, dropped, total }`. If a build returns no `segments[]`, fall back to top-level `.text` (gate degrades to VAD + phrase-list only — still correct). **Transport: use Node http or the existing `nodeFetch` (local-transport.js) — NEVER the ambient global `fetch`** (Electron-main Chromium-net false-negatives loopback; project memory rule). Build the multipart body by hand (no ESM form-data dep) or with a tiny boundary writer.
- No server `--vad` (VAD stays in JS — locked; avoids double-VAD).

Then collapse `src/core/config.js` `speech.whisper` to the whisper-server block, ADDING the new keys and keeping the existing VAD knobs (now shared by both channels — 04-04):
```
whisper: {
  host: '127.0.0.1',
  port: 0,                 // 0 = auto-pick a free port at start()
  model: 'small.en',       // → filename ggml-${model}.bin  (was 'turbo')
  language: 'en',
  threads: 0,              // 0 = auto (clamp 50% cores, [2,8])
  noSpeechThreshold: 0.6,  // drop segment if no_speech_prob > this
  vadEnabled: true, silenceHangoverMs: 700, minUtteranceMs: 350,
  maxUtteranceMs: 15000, preRollMs: 300, vadEnergyFloor: 0.008,
}
```
Leave `speech.provider` and `speech.azure` UNTOUCHED here (prove-then-remove: 04-09 removes them behind the checkpoint). Keep `segmentMs` if present as a harmless legacy backstop, or fold into maxUtteranceMs — do not break `_getWhisperSegmentMs` callers (04-03 owns that rewrite).
  </action>
  <verify>`node -e "const M=require('./src/core/whisper-server.manager'); const m=new M({supervisor:{start:async()=>({state:'healthy'}),stop:async()=>{},getStatus:()=>({state:'idle',owned:true,pid:null})}}); console.log(typeof m.transcribe, typeof m.getStatus, typeof m.start)"` prints `function function function` (constructs network-free, no throw). `node -e "console.log(require('./src/core/config').get('speech.whisper').noSpeechThreshold, require('./src/core/config').get('speech.whisper').model)"` prints `0.6 small.en`. `npx eslint src/core/whisper-server.manager.js src/core/config.js` clean.</verify>
  <done>WhisperServerManager constructs network-free with the exact supervisor config, auto-picks a free port, clamps threads conservatively, exposes 3-level health, and transcribes via verbose_json with the no_speech_prob>0.6 gate; config.speech.whisper is the collapsed whisper-server block with model=small.en.</done>
</task>

<task type="auto">
  <name>Task 3: node:test suite for WhisperServerManager (fake spawn + fake HTTP)</name>
  <files>test/whisper-server-manager.test.js</files>
  <action>
Model on `test/service-supervisor.test.js` (fake spawn) and `test/local-model-manager.test.js` (injected supervisor + fake client). No Electron, no real process, no network — pure node:test. Cover the pure logic that must be provably correct:
- **verbose_json segments[] parser + no_speech gate**: given a canned verbose_json body with several segments (some `no_speech_prob` 0.9, some 0.1), `transcribe()` drops the > 0.6 segments and concatenates only the survivors' text; returns the dropped/total counts. Inject a fake `fetchImpl`/http returning the canned body so no server is needed.
- **degrade path**: a body with no `segments[]` falls back to top-level `.text`.
- **free-port selection**: `start()` picks a numeric port and passes it to both the spawn args and the supervisor healthCheck (assert via an injected supervisor capturing its def, or a spawn spy capturing `--port`).
- **three-level health**: with an injected supervisor reporting healthy + a present/absent model file (fake fs or a temp file), `getStatus()` returns the right `{serverUp, modelPresent, responding}` combination and never flips serverUp false on a responding-probe failure.
- **thread clamp**: `clamp(floor(availableParallelism*0.5),2,8)` boundaries (assert the computed `-t` value for a couple of core counts by injecting/stubbing).
- **Mach-O arch verify**: a fake binary with a wrong/garbage magic is rejected (not-installed), a valid arm64 magic is accepted (use a small fixture buffer).
Keep it fast and deterministic; do NOT require speech.service.js (it mutates globals).
  </action>
  <verify>`node --test test/whisper-server-manager.test.js` — all tests pass. `make run_tests` stays green overall (whole suite). `make lint` clean.</verify>
  <done>The segments[] parser + no_speech_prob>0.6 gate, free-port selection, three-level health, thread clamp, and arch verify are all covered by passing node:test cases.</done>
</task>

</tasks>

<verification>
- `make run_tests` green (new suite + all existing 96+).
- `make lint` exits 0.
- On darwin: `resources/bin/whisper-server --help` runs (built, arch-verified). Off-darwin build script is a no-op exit 0.
- `config.get('speech.whisper')` returns the collapsed block with `model:'small.en'`, `noSpeechThreshold:0.6`, `port:0`, `threads:0` and the shared VAD knobs.
- WhisperServerManager constructs network-free and never throws when the binary/model/server are absent.
</verification>

<success_criteria>
- STT-01/SC1 foundation: a resident whisper-server can be supervised (adopt:false, pidFile, SIGTERM grace) and transcribe a WAV over POST /inference with no per-utterance spawn.
- SC5 second gate: verbose_json segments with no_speech_prob > 0.6 are dropped before concatenation, unit-proven.
- Config collapsed to the single whisper-server block (speech.provider/azure deferred to 04-09).
- whisper-server builds from source (v1.9.1, Metal) into resources/bin, no-op off-darwin.
</success_criteria>

<output>
After completion, create `.planning/phases/04-continuous-hearing-resident-stt-ambient-listening/04-01-SUMMARY.md`
</output>
