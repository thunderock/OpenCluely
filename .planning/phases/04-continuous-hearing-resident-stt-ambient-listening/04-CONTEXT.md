# Phase 4: Continuous Hearing — Resident STT + Ambient Listening - Context

**Gathered:** 2026-07-15
**Status:** Ready for planning

<domain>
## Phase Boundary

Replace the **per-utterance Python-Whisper subprocess** (`_transcribeWhisperFile` +
`.venv-whisper`) with a **resident whisper.cpp engine** that transcribes each VAD segment
with **no per-utterance process/model spawn or cold-start**; keep the audio stream open
**launch → quit** (**ambient listening**), reusing the existing `VadSegmenter` +
hallucination filter; on macOS capture the **other party's system audio as a separate
channel** from the mic; **download/cache the STT model on first run with visible progress**;
and **fully remove the Azure Speech SDK + its ~380-line browser-DOM polyfill** once the
resident engine replaces it.

Requirements delivered: **STT-01, STT-02, STT-03, STT-04, STT-05**.

**In scope for this phase:**
- **Resident `whisper-server`** (whisper.cpp's built-in HTTP server) supervised by the
  Phase 1 `ServiceSupervisor`; the per-utterance Python subprocess + venv path is **deleted**.
- **Ambient listening**: stream open from launch (pre-warmed, non-blocking), transcribing on
  VAD-detected pauses via the **existing** `VadSegmenter` + hallucination filter + a new
  whisper.cpp `no_speech` gate.
- **macOS system-audio** capture via **Core Audio Process Tap** (macOS 14.2+) as a **second,
  separately-tagged channel** from the mic.
- **First-run STT model download** (`ggml-small.en`) with visible resumable progress, reusing
  the existing download-progress IPC + onboarding/settings UI.
- **Azure removal (STT-05)** behind a **hard manual checkpoint** after the resident engine is
  proven — SDK + polyfill + the `ensureNativeGlobalURL()` workaround it forced.
- **Config/settings/onboarding** updated so STT collapses to the single local whisper engine
  (no more azure|whisper provider selection / auto-detect).

**Explicitly NOT in scope (deferred — do not pull in):**
- Pause-triggered **orchestrator**, **relevance gate**, ephemeral streamed suggestions —
  **Phase 6** (CONT-01/02/03).
- Full **listening/watching trust indicator** + one-click **pause/kill switch** — **Phase 6**
  (CONT-06/07). *Phase 4 ships only an interim on/off by repurposing the existing mic control.*
- **Continuous screen capture** (throttle/downscale/frame-diff) + **md-context** + **DOMPurify**
  / **TCC-recovery** / **IPC scoping** — **Phase 5**.
- **CLI backup providers** (Claude/Codex) — **Phase 7**.
- **DMG CI / `asarUnpack` finalization / `xattr` docs / dead-code + license cleanup** —
  **Phase 8** (Phase 4 only needs the whisper.cpp binary + Swift tap helper resolvable in dev).
- **mic+system fusion / bleed-dedup**, **diarization**, **Windows/Linux system audio** — later
  (STT-04 is macOS-only, separate-channel; fusion is a Phase 6 / v2 concern).
- **Full sustained-load** TTFT/memory validation — **Phase 6**; Phase 4 does only a rough smoke.

## Locked (do not re-ask / do not re-litigate)

From ROADMAP SC + REQUIREMENTS + STACK/OPENWHISPR/PITFALLS research + this discussion:
- **Engine:** supervised, out-of-process **whisper.cpp `whisper-server`** on `127.0.0.1` —
  **NOT** in-process `smart-whisper` (avoids the app's first native addon + the Electron-29
  ABI risk; reuses `ServiceSupervisor`, which **already pre-specs** the whisper-server config).
- **Supervision shape:** the `ServiceSupervisor` header's whisper-server config —
  `{ healthCheck:{type:'port', port}, adopt:false, pidFile, terminate:{sigtermGraceMs:5000} }`
  (app-private, own-only, PID-sidecar orphan reaping — unlike Ollama's `adopt:true`).
- **Resident, pre-warmed:** start after `app.whenReady()` **non-blocking + non-fatal +
  lazy-fallback**; the engine stays resident for the session.
- **whisper.cpp is now the SOLE STT** (Azure removed, Python path deleted) → **degrade, never
  crash**: engine-down shows an **inline "voice unavailable" + one-click retry/repair**, and
  **typing + screenshot keep working** (mirror Phase 3's Local-down recovery UX).
- **macOS system audio = Core Audio Process Tap** (`AudioHardwareCreateProcessTap`,
  **macOS 14.2+**); **< 14.2 → mic-only**. ⚠ This **supersedes** the ROADMAP SC#4 /
  REQUIREMENTS **STT-04 wording ("ScreenCaptureKit")** — same capability, lighter mechanism
  (`NSAudioCaptureUsageDescription`, no Screen-Recording TCC bucket, no persistent recording
  indicator — right for a stealth overlay). **Update the STT-04 wording** (doc follow-up).
- **Ambient start:** **auto-listen from launch**; repurpose the **existing mic-button /
  recording control** as an **interim stop** (the full Phase 6 indicator/kill-switch is NOT
  built here).
- **Channels:** mic + system transcribe **independently**, each **tagged `source:'mic'|'system'`**
  into the transcript; **no dedup/fusion** this phase (per STT-04 "separate channel").
- **Silence defense (SC5):** **keep** the existing tuned `VadSegmenter`
  (`src/core/vad-segmenter.js`) + `_isHallucinatedTranscript` filter **as the primary gate**,
  **AND add** a whisper.cpp **`no_speech` probability gate** as a probabilistic second filter.
- **Model:** default **`ggml-small.en`** (English-only; matches today's `en` default + the
  English hallucination list). Multilingual is a v2 item.
- **First-run download:** **reuse** the existing download-progress IPC + onboarding/settings
  UI; **auto-download on first run** with **visible, resumable** progress; **cache in app
  userData** (like today's `.whisper-models`); **drop** the venv/pip machinery.
- **Azure removal is a HARD MANUAL CHECKPOINT** (prove-then-remove, mirror Phase 3): remove
  the SDK + ~380-line DOM polyfill **only after** the resident engine is proven on both
  channels; retire the `ensureNativeGlobalURL()` workaround the polyfill forced.

Tech constraints carried from Phases 1–3 (still binding):
- **CommonJS + vanilla JS**, no bundler / TypeScript / framework; match existing conventions
  (incl. the `assests/` misspelling).
- **Reuse `ServiceSupervisor`** (`src/core/service-supervisor.js`) — whisper-server is its
  **second consumer** after `LocalModelManager` (Ollama).
- **Logging:** `require('./core/logger').createServiceLogger('<TAG>')`; never interpolate
  variable data into the message. **Error philosophy:** degrade gracefully, never crash.
- **Tests:** Node's built-in `node:test` / `node --test`; no new framework. Keep pure logic
  (VAD, filters, WAV framing) unit-testable like `vad-segmenter.test.js`.
- **`get-port@7` / `execa@9` / `node-fetch@3` are ESM-only** — cannot be `require()`d in this
  CJS app; use `net.createServer` port probe / `node:child_process` / global `fetch`.

</domain>

<decisions>
## Implementation Decisions

### STT engine architecture
- **Supervised `whisper-server`** (whisper.cpp built-in HTTP server), bound to `127.0.0.1`,
  managed by `ServiceSupervisor` with the header's pre-spec'd whisper-server config
  (`adopt:false` + `pidFile` + SIGTERM→SIGKILL grace). **No native addon** → no Electron-29
  ABI exposure.
- **Pre-warm** the server after `app.whenReady()` — **non-blocking, non-fatal, lazy-fallback**
  (openwhispr's pattern) so the first utterance has no cold start.
- **Sole STT + degrade-never-crash:** engine-down → **inline "voice unavailable" + one-click
  restart/repair**, typing + screenshot unaffected. Distinguish "server up" vs "model ready"
  vs "responding" (three checks, three messages — Pitfall 4).
- Transcription over whisper-server's native **`POST /inference`** (multipart WAV + language +
  `response_format=json`); the capture path already yields **16 kHz mono PCM**, so WAV framing
  reuses the existing `_createWavBuffer` helper.

### macOS system audio (STT-04)
- **Core Audio Process Tap** (macOS **14.2+**), implemented as a **compiled Swift helper**
  spawned as a child process streaming **16 kHz mono PCM to stdout** + line-JSON status on
  stderr (openwhispr `macos-audio-tap.swift` is the MIT reference). **Not** ScreenCaptureKit.
- **< macOS 14.2 → mic-only** (system-audio is the 14.2+ bonus; app stays fully functional).
- **Consent at first ambient-listen**; **deny → mic-only** with a clear note; **persist
  grant/deny** to a file so it doesn't re-prompt each launch.
- System audio is a **second channel**: its own `VadSegmenter` instance + segment pipeline →
  whisper-server → transcript tagged `source:'system'`.

### Ambient-listening posture (STT-03)
- **Auto-listen from launch → quit**; repurpose the **existing mic control** as the **interim
  on/off** (full trust indicator + kill switch = Phase 6).
- **Separate, tagged channels** (mic/system), **no dedup** this phase.
- **Resilience (always-on must survive a full session):** on **`powerMonitor` resume**
  re-warm/reopen the stream (openwhispr issue #766: GPU/stream eviction on sleep); on
  **mic-device change** (AirPods in/out) **re-attach without crashing**; guard re-entrancy.

### STT model & first-run download (STT-02)
- **Default `ggml-small.en`** (~500 MB) — accuracy/speed/RAM sweet spot for **conversational
  English** on Apple Silicon, sized to **coexist with the resident VLM** in the 32 GB budget
  (Pitfall 2). English-only `.en`.
- **Silence defense:** existing `VadSegmenter` + `_isHallucinatedTranscript` **primary gate**
  **+ whisper.cpp `no_speech` gate** (drop high-no-speech segments) → hardens SC5 (2 min
  silence → zero transcripts) under always-on.
- **First-run:** **reuse** `whisper-installer.js`'s download-progress IPC + onboarding/settings
  progress UI (drop venv/pip); **auto-download** `ggml-small.en` on first run, **resumable**,
  **checksum-verify before "installed"** (Pitfall 5), **cache in userData**; friendly
  offline/disk-full messaging.

### Config / settings / onboarding cleanup
- STT config collapses from `{azure, whisper}` + `_getConfiguredProvider` auto-detect to a
  **single local whisper engine** block (host/port, model, language, VAD/`no_speech` knobs).
- Settings UI: replace the **azure|whisper provider dropdown + Azure fields** with the local
  whisper engine's status/model/repair (mirror the Phase 3 "minimal switcher" spirit).
- Onboarding STT step: swap `detectWhisper()`/`installWhisper()` (Python) for the whisper.cpp
  binary presence check + `ggml-small.en` download.

### Claude's Discretion
Within the locked decisions, planner/researcher decide:
- Exact module paths/names (e.g. a `WhisperServerManager` in `src/core/` mirroring the
  `LocalModelManager` DI shape; a `SystemAudioTapManager` for the Swift helper).
- whisper.cpp **binary sourcing** (which upstream prebuilt release + pinned tag for darwin
  arm64/x64; whether a Metal/CoreML build is worth it) and dev-vs-packaged path resolution —
  **build-time fetch into `resources/bin`** per openwhispr; Phase 8 finalizes `asarUnpack`/DMG.
- Port selection (free-port scan vs fixed), health-poll cadence, and how the manager reports
  state, reusing `ServiceSupervisor` statics (`probePort`, `computeBackoffDelay`).
- Whether two `VadSegmenter` pipelines share tuning or diverge per channel.
- Exact `no_speech` threshold, the whisper-server request params, and thread auto-tuning.
- Settings-UI layout + concrete config key names for the collapsed whisper block.
- The Swift helper's build wiring (`xcrun swiftc`, arch-verify, no-op on non-darwin).

</decisions>

<specifics>
## Specific Ideas & Reusable Assets (grounded — from the code scout)

**Reuse / keep:**
- `src/core/vad-segmenter.js` (153 lines) — `VadSegmenter.ingest(buffer, tuning) → {type,
  buffers}`; keep verbatim, instantiate **once per channel**. Tests: `test/vad-segmenter.test.js`.
- `_isHallucinatedTranscript` (`src/services/speech.service.js:1643-1665`) + its application
  at flush (`:1620-1624`) — carries to the resident engine.
- Renderer mic capture (`src/ui/main-window.js:954-1005`, `getUserMedia` →
  `AudioContext(16000)` → Int16 PCM → `sendAudioChunk`) + the `audio-chunk` IPC →
  `handleAudioChunkFromRenderer` (`speech.service.js:766-775`) → `_ingestWhisperAudio`
  (`:783-820`). Keep the mic path; add the system channel alongside it.
- `_createWavBuffer` / WAV framing (`speech.service.js:1737-1760`) for `POST /inference`.
- `ServiceSupervisor` (`src/core/service-supervisor.js`, 271 lines) — copy the
  `LocalModelManager` consumer pattern (`src/core/local-model.manager.js:58-72`); stop on quit
  via `main.js:1511-1521` (`onWillQuit`). Header pre-specs the whisper-server config.
- Transcript sink is unchanged: `emit('transcription')` → `handleTranscriptionFragment`
  (`main.js:1226-1249`) → `sessionManager.addUserInput(fragment,'speech')`. Add the
  `source` tag through this path.
- Download-progress IPC + onboarding/settings UI from `whisper-installer.js` (624 lines) +
  `onboarding.js` (`main.js:711-761`) — reuse the **progress/UX**, drop venv/pip internals.

**Delete (STT-01 + STT-05):**
- Per-utterance Python spawn `_transcribeWhisperFile` (`:1679-1735`), buffer/file helpers
  (`:1667-1677`), venv command cascade `_resolveWhisperCommand`/`_getUserDataWhisperCandidate`
  (`:1200-1257`), probes (`:1267-1370`); `whisper-installer.js` venv/pip path; `WHISPER_COMMAND`
  / `WHISPER_MODEL_DIR` env.
- Azure: SDK import (`:392-396`) + `microsoft-cognitiveservices-speech-sdk` dep; the ~380-line
  polyfill (`:1-380`); `_initializeAzureClient` (`:459-510`), `_startAzureRecording`
  (`:574-671`), `recognizeFromFile` (`:965-991`), `testConnection` (`:1000-1015`); `speech.azure`
  config (`config.js:63-69`); `azureKey/azureRegion` settings + `AZURE_SPEECH_*` env.
- ⚠ The polyfill clobbers `global.URL` → **retire `ensureNativeGlobalURL()`** once gone
  (referenced: `local-model.manager.js:29-34`, `local-transport.js:5-22`, `local.provider.js:56`,
  `test/local-provider.test.js:170`) — verify no LLM regression after removal.

**References:**
- **openwhispr** (MIT) is the code-level reference for both the supervised `whisper-server`
  (`src/helpers/whisperServer.js`) and the macOS Core Audio Tap (`resources/macos-audio-tap.swift`,
  `src/helpers/audioTapManager.js`) — see `.planning/research/OPENWHISPR-NOTES.md`.
- Pitfalls 6 (whisper hallucination/VAD), 2 (OOM/memory budget), 11 (binary packaging), 3 (TCC),
  4 (service lifecycle), 5 (first-run download) — `.planning/research/PITFALLS.md`.

</specifics>

<deferred>
## Deferred Ideas

- **In-process `smart-whisper`** — declined (native-addon ABI risk vs Electron 29; whisper-server
  chosen). Revisit only if whisper-server latency proves unacceptable.
- **ScreenCaptureKit fallback for < macOS 14.2** — declined; mic-only below the floor.
- **mic↔system bleed-dedup** (openwhispr `dedupeMicAgainstSystem`) — deferred; separate channels
  this phase, fusion is a Phase 6 concern. [[phase-6-pause-orchestrator]]
- **Windows (WASAPI) / Linux (PipeWire) system audio** — v2 (STT-V2-01); macOS-only here.
- **Multilingual STT** + language-aware hallucination list — v2.
- **whisper-server built-in Silero `--vad`** — not used; JS `VadSegmenter` remains the gate
  (so the Silero VAD model likely need not ship — confirm in research).
- **Speaker diarization** (who-said-what) — v2 (FEAT-V2-01).
- **Full listening indicator + kill switch** — Phase 6 (CONT-06/07); interim mic-control stop only.

</deferred>

<research_flags>
## Research Flags (carry into /gsd:plan-phase → gsd-phase-researcher)

1. **whisper.cpp `whisper-server` REST contract** — confirm the `POST /inference` params +
   response for our use, and specifically **whether it exposes a per-segment `no_speech`
   probability** (needed for the `no_speech` gate). If not, how to obtain it (e.g. response
   fields / a flag) — otherwise the gate falls back to VAD + phrase list only.
2. **whisper.cpp binary sourcing** — the upstream prebuilt release + **pinned tag** for
   darwin arm64/x64, whether a **Metal/CoreML** build meaningfully helps Apple-Silicon latency,
   and dev-vs-packaged path resolution (`resources/bin`; Phase 8 finalizes `asarUnpack`).
3. **Core Audio Process Tap** — **empirically verify** the TCC bucket + whether
   relaunch-after-grant is needed on the **target macOS build** (research flagged bucketing has
   shifted on newest OS); confirm `NSAudioCaptureUsageDescription` suffices; the Swift-helper
   build (`xcrun swiftc`, arch-verify). Confirm 16 kHz mono PCM output to feed
   `_ingestWhisperAudio` unchanged.
4. **Two-channel plumbing** — reconcile the **renderer-`getUserMedia` mic** path with the
   **main-process Swift-tap system** path: confirm two independent `VadSegmenter`+segment
   pipelines → whisper-server, tagged `source`, both landing via the existing transcript sink.
5. **Rough STT smoke** — `ggml-small.en` per-utterance latency + accuracy on the target 32 GB
   Apple Silicon (Metal), **coexisting with the resident VLM** (memory budget — Pitfall 2).
   Enough to prove near-real-time, not the Phase 6 sustained-load run.
6. **Model download** — `ggml-small.en` source (e.g. HF `ggerganov/whisper.cpp` `resolve`) +
   **checksum**; wire to the existing download-progress IPC; **resumable**; userData cache;
   offline/disk-full handling.
7. **Azure-removal blast radius** — re-confirm Azure is STT-only and enumerate every reference
   (incl. the `global.URL` polyfill + `ensureNativeGlobalURL()` workaround) so the manual-
   checkpoint deletion is clean and the LLM path is verified post-removal.

</research_flags>

---

*Phase: 04-continuous-hearing-resident-stt-ambient-listening*
*Context gathered: 2026-07-15*
