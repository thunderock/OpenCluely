# Phase 4: Continuous Hearing — Resident STT + Ambient Listening - Research

**Researched:** 2026-07-15
**Domain:** Resident whisper.cpp STT over HTTP, macOS Core Audio Process Tap system-audio capture, ambient VAD listening, first-run model download, Azure SDK removal — inside an Electron 29 (CommonJS, no bundler) stealth overlay.
**Confidence:** HIGH on the code-level reuse map, whisper-server REST contract, model source/checksums, and the Azure blast radius (all verified against live code + upstream source). MEDIUM-with-a-named-risk on macOS system-audio capture (the Core Audio tap TCC prompt requires a signing identity OpenCluely does not currently have — see Flag 3, this is the phase's biggest risk).

## Summary

Everything the planner needs to reuse already exists and is in good shape: the `VadSegmenter` is a pure, per-channel state machine; `ServiceSupervisor` already pre-specs the exact whisper-server config in its header and exports the `probePort`/`probeHttp`/`computeBackoffDelay` statics; `LocalModelManager` is a clean DI template to mirror; and `_createWavBuffer` produces exactly the 16 kHz mono WAV `whisper-server` wants. The per-utterance transcription (`_flushWhisperSegment` → `_transcribeWhisperBuffer` → `_transcribeWhisperFile`) is a tidy seam: swap the Python-CLI spawn for a `POST /inference` multipart call and the rest of the pipeline (ingest → VAD → hallucination filter → `emit('transcription')` → `handleTranscriptionFragment`) is unchanged.

Two upstream facts change locked implementation details and must flow into the plan. **(1) The `no_speech` gate requires `response_format=verbose_json`, not `json`** — the basic `json` format returns only `{"text": ...}`; `no_speech_prob` (and `avg_logprob`, per-segment timing) exist **only** in `verbose_json`. **(2) whisper.cpp ships no prebuilt macOS binary** — v1.9.1's release assets are Linux + Windows + an Apple *xcframework* (a library, not a CLI/server). openwhispr sidesteps this by building its own fork and publishing `whisper-server-darwin-*` binaries; OpenCluely should instead build `whisper-server` from source at build time (CMake, Metal on by default) into `resources/bin`, which is self-contained, reproducible, matches the repo's "compile the Swift helper at build time" philosophy, and avoids trusting a third-party fork's release cadence.

The dominant risk is **STT-04 (system audio)**: the Core Audio Process Tap TCC prompt is keyed to a stable code-signing identity and **does not fire on unsigned builds** (silent capture failure). OpenCluely currently ships unsigned (`hardenedRuntime:false`, no Developer ID). Mic capture (getUserMedia + `NSMicrophoneUsageDescription`) is unaffected and works unsigned, so the guaranteed baseline is mic-only ambient listening; system audio should be built behind a clean degrade-to-mic path and its "verified working" gate treated as conditional on a signing spike done early.

**Primary recommendation:** Build a `WhisperServerManager` (mirroring `LocalModelManager`'s DI shape) that supervises a from-source-built `whisper-server` via `ServiceSupervisor` with the header's pre-spec'd `adopt:false`/`pidFile`/SIGTERM-grace config on a start-time-selected free port; rewire `_flushWhisperSegment` to `POST /inference` with `response_format=verbose_json`; gate on `no_speech_prob > 0.6` as the probabilistic second filter behind the existing VAD + phrase list; add a `SystemAudioTapManager` spawning a `swiftc`-compiled tap helper (deployment target **14.4**, not 14.2) as an independent second `VadSegmenter` pipeline tagged `source:'system'`; download `ggml-small.en.bin` (487,614,201 bytes, pinned SHA256 below) resumably to userData with checksum-verify; and remove Azure last, behind the manual checkpoint.

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions (do NOT re-litigate — research these, not alternatives)
- **Engine:** supervised out-of-process whisper.cpp `whisper-server` on `127.0.0.1` — **NOT** in-process `smart-whisper` (avoids first native addon + Electron-29 ABI risk; reuses `ServiceSupervisor`).
- **Supervision shape:** `ServiceSupervisor` header's whisper-server config — `{ healthCheck:{type:'port', port}, adopt:false, pidFile, terminate:{sigtermGraceMs:5000} }` (app-private, own-only, PID-sidecar orphan reaping — unlike Ollama's `adopt:true`).
- **Resident, pre-warmed:** start after `app.whenReady()` non-blocking + non-fatal + lazy-fallback; resident for the session.
- **whisper.cpp is the SOLE STT** (Azure removed, Python path deleted) → degrade, never crash: engine-down shows inline "voice unavailable" + one-click retry/repair; typing + screenshot keep working.
- **macOS system audio = Core Audio Process Tap** (`AudioHardwareCreateProcessTap`, macOS 14.2+); < floor → mic-only. SUPERSEDES ROADMAP SC#4 / STT-04 "ScreenCaptureKit" wording (`NSAudioCaptureUsageDescription`, no Screen-Recording TCC bucket, no persistent recording indicator). Update STT-04 wording (doc follow-up).
- **Ambient start:** auto-listen from launch; repurpose the existing mic-button/recording control as an interim stop (full Phase 6 indicator/kill-switch NOT built here).
- **Channels:** mic + system transcribe independently, each tagged `source:'mic'|'system'`; no dedup/fusion this phase.
- **Silence defense (SC5):** keep the tuned `VadSegmenter` (`src/core/vad-segmenter.js`) + `_isHallucinatedTranscript` as the primary gate, AND add a whisper.cpp `no_speech` probability gate as a probabilistic second filter.
- **Model:** default `ggml-small.en` (English-only; matches today's `en` default + the English hallucination list). Multilingual is v2.
- **First-run download:** reuse the existing download-progress IPC + onboarding/settings UI; auto-download on first run with visible, resumable progress; cache in app userData (like today's `.whisper-models`); drop the venv/pip machinery.
- **Azure removal is a HARD MANUAL CHECKPOINT** (prove-then-remove, mirror Phase 3): remove SDK + ~380-line DOM polyfill only after the resident engine is proven on both channels; retire the `ensureNativeGlobalURL()` workaround the polyfill forced.
- **Tech constraints (binding from Phases 1–3):** CommonJS + vanilla JS, no bundler/TS/framework; match existing conventions (incl. the `assests/` misspelling). Reuse `ServiceSupervisor`. Logging via `require('./core/logger').createServiceLogger('<TAG>')`, never interpolate variable data into the message. Degrade gracefully, never crash. Tests via Node `node:test` / `node --test`, no new framework; keep pure logic unit-testable. `get-port@7` / `execa@9` / `node-fetch@3` are ESM-only — cannot be `require()`d; use `net.createServer` port probe / `node:child_process` / global `fetch` (or the existing `nodeFetch`).

### Claude's Discretion (research & recommend — answered in "Recommended Module/Architecture Shape")
Module paths/names; whisper.cpp binary sourcing + pinned tag + Metal/CoreML; port selection + health cadence + state reporting + reusing `ServiceSupervisor` statics; whether the two VAD pipelines share tuning; exact `no_speech` threshold + request params + thread auto-tuning; settings-UI layout + config key names; Swift-helper build wiring.

### Deferred Ideas (OUT OF SCOPE — ignore)
Pause-triggered orchestrator / relevance gate / streamed suggestions (Phase 6); full trust indicator + kill switch (Phase 6; interim mic-control stop only); continuous screen capture + md-context + DOMPurify/TCC-recovery/IPC-scoping (Phase 5); CLI backup providers (Phase 7); DMG CI / `asarUnpack` finalization / license cleanup (Phase 8 — Phase 4 only needs binary + Swift-helper resolvable in dev); mic+system fusion / bleed-dedup / diarization / Windows-Linux system audio; full sustained-load TTFT/memory validation (Phase 6 — Phase 4 does a rough smoke only).
</user_constraints>

---

## Research Flag 1 — whisper-server REST contract + `no_speech` probability

**Confidence: HIGH** (verified against `examples/server/server.cpp` and `examples/server/README.md` on `ggml-org/whisper.cpp` master).

**The contract:**
- Endpoint: `POST /inference`, `Content-Type: multipart/form-data`. Default bind `127.0.0.1:8080`.
- Form fields: `file` (the audio — confirmed field name), `response_format`, `language` (default `"en"`), `temperature` (default `0.0`), `temperature_inc` (default `0.2`), `prompt`, `carry_initial_prompt`.
- Audio: the server accepts a **16 kHz mono 16-bit WAV directly** — no ffmpeg needed. `--convert` (which *does* require ffmpeg on the server) is only for non-WAV inputs. OpenCluely already yields 16 kHz mono PCM and frames it with `_createWavBuffer`, so this is a byte-for-byte fit.
- A `POST /load` endpoint exists to swap the model at runtime (multipart `model=<path>`). **Not needed** for Phase 4 (single model set by `-m` at launch).

**The `no_speech` gate — decision-changing finding:**
`no_speech_prob` is emitted **only when `response_format=verbose_json`**. The basic `json` format returns just `{"text": ...}` with no segment detail. The `verbose_json` path in `server.cpp` assigns, per segment:
```cpp
segment["no_speech_prob"] = whisper_full_get_segment_no_speech_prob(ctx, i);
```
`verbose_json` segment keys: `id`, `text`, `start`, `end`, `tokens`, `temperature`, `avg_logprob`, `no_speech_prob` (+ `speaker` if diarization, `words[]` if word timestamps). Top level: `task`, `language`, `duration`, `text`, `segments[]`.

→ **The CONTEXT's plan to use `response_format=json` will NOT surface `no_speech_prob`. Use `verbose_json`.** Parse `segments[]`, gate client-side on `no_speech_prob` (recommended drop threshold `> 0.6`, matching Whisper's default `no_speech_threshold` and Pitfall 6), and concatenate surviving segments' text. If for any reason a build returns no segments, the gate degrades to VAD + phrase-list only (still correct, just less selective).

Related server flags (informational — we do the VAD in JS, so we do **not** pass `--vad`): `-nth/--no-speech-thold` (default `0.60`, server-side segment suppression), `-sns/--suppress-nst`, and a full `--vad*` family. Keeping VAD in JS (locked) avoids double-VAD; the server is used purely for transcription + the `no_speech_prob` signal.

---

## Research Flag 2 — whisper.cpp binary sourcing, pinned tag, Metal/Core ML, path resolution

**Confidence: HIGH** on availability (verified the GitHub release asset list); **recommendation is prescriptive.**

**Finding that changes the plan:** whisper.cpp **v1.9.1 (released 2026-06-19, the current latest)** ships **no macOS/darwin CLI or server binary**. Release assets are: `whisper-bin-ubuntu-arm64.tar.gz`, `whisper-bin-ubuntu-x64.tar.gz`, `whisper-bin-Win32.zip`, `whisper-bin-x64.zip`, `whisper-blas-bin-*`, `whisper-cublas-*`, and `whisper-v1.9.1-xcframework.zip` (an Apple **framework/library**, not a runnable `whisper-server`). openwhispr works around this by building its **own fork** (`OpenWhispr/whisper.cpp`) and publishing `whisper-server-darwin-arm64.zip` / `whisper-server-darwin-x64.zip` assets that its `download-whisper-cpp.js` fetches into `resources/bin` (version via `WHISPER_CPP_VERSION` env, else latest).

**Recommendation: build `whisper-server` from source at build time (primary), pinned to tag `v1.9.1`.**
- Rationale: self-contained + reproducible; no trust dependency on a third-party fork's release cadence; matches the repo's existing "compile the Swift helper at build time, verify Mach-O arch, no-op off-darwin" pattern (openwhispr `scripts/build-macos-audio-tap.js`). whisper.cpp compiles in ~1–2 min.
- Build: `cmake -B build -DCMAKE_BUILD_TYPE=Release` then `cmake --build build --target whisper-server -j` → binary at `build/bin/whisper-server`, copied to `resources/bin/whisper-server`. **Metal is ON by default on Apple Silicon** (no flag needed) and meaningfully helps latency (30–60%+ speedup vs CPU on this model class — see Flag 5); do not disable it.
- **Core ML: skip for Phase 4.** The ANE/Core ML encoder path needs a one-time per-model `.mlmodelc` conversion (Python + coremltools) and only speeds the *encoder*; small.en is already 22–34× real-time on Metal (Flag 5). Not worth the build complexity now; note as a possible later optimization.
- Fallback (if a from-source build is impractical for the dev spike): fetch openwhispr's fork binary or publish a first-party OpenCluely release asset — **Phase 8 finalizes** the CI fetch-vs-build decision, `asarUnpack`, and DMG.

**Path resolution (dev vs packaged), mirror `LocalModelManager._resolveOllamaBin` + openwhispr's ordered `resolveBinary()`:**
- Dev: `<appRoot>/resources/bin/whisper-server`.
- Packaged: `process.resourcesPath/bin/whisper-server` (must be `asarUnpack`'d — binaries inside asar cannot be spawned; Pitfall 11). Phase 8 owns the `asarUnpack`/`extraResources` wiring; Phase 4 only needs it resolvable in dev.
- Verify the Mach-O magic (`0xfeedfacf` + cpu-type) before trusting it (arm64/x64 mismatch guard), as openwhispr's `audioTapManager.js` does.
- The current `build.files` glob excludes `.venv-whisper`/`.whisper-models`; add `resources/bin/**` handling in Phase 8.

---

## Research Flag 3 — Core Audio Process Tap: TCC bucket, signing, relaunch, output format

**Confidence: HIGH on the mechanism and the signing constraint; this is the phase's PRIMARY RISK.**

**TCC bucket (confirms the locked choice):** `AudioHardwareCreateProcessTap` / `CATapDescription` uses the **`NSAudioCaptureUsageDescription`** TCC category — its own bucket, **separate from both Microphone and Screen Recording**. No Screen-Recording ("Screen & System Audio Recording") grant, no `com.apple.security.device.audio-input`-style entitlement needed for the tap itself. The capture indicator is a **purple dot** (less obtrusive than the orange mic dot) — acceptable for a stealth overlay. So the CONTEXT's rationale for Process Tap over ScreenCaptureKit holds.

**Deployment-target correction: use 14.4, not 14.2.** Process Taps arrived in 14.2, but the authoritative 2026 writeups say a deployment target **≥ 14.4** "keeps you in the right TCC category"; earlier targets land in a different category with divergent prompt copy. Recommend gating `isSupported()` on **macOS ≥ 14.4** (below → mic-only), and compiling the Swift helper with `-target arm64-apple-macosx14.4` / `x86_64-apple-macosx14.4`. `insidegui/AudioCap` (the canonical Apple-aligned reference) is explicitly "macOS 14.4+".

**Signing is a hard blocker on the current build posture — flag loudly:**
- "TCC's permission record is keyed off [the signing identity]. Unsigned xcodebuild builds compile fine but can't actually exercise audio capture — **the prompt won't fire**" — capture then silently returns zero samples (there is a real-world corroborating bug: hermes-desktop #819 "records silent audio → empty transcript").
- **Ad-hoc signing is reported insufficient** for this use case (no stable TeamIdentifier; grants also don't survive rebuilds — ties into Pitfall 3). A **real Developer ID / stable signing identity** appears necessary for the tap prompt to fire reliably.
- OpenCluely ships **unsigned** today (`hardenedRuntime:false`, `gatekeeperAssess:false`, no Developer account — Pitfall 3). **Conclusion: system-audio capture via Core Audio Tap is unlikely to work on an unsigned/ad-hoc OpenCluely build.** The mic path (renderer `getUserMedia` + `NSMicrophoneUsageDescription`) is unaffected and works unsigned.
- **Planner guidance:** (a) run a **signing spike EARLY** — build the Swift tap helper, ad-hoc sign it AND the app, and empirically check whether the `NSAudioCaptureUsageDescription` prompt fires and samples flow; if not, try a self-generated Developer ID. (b) Treat mic-only ambient listening as the guaranteed STT-04-adjacent deliverable; build system audio behind a clean `isSupported()`/consent/degrade-to-mic path (same code path as the <14.4 fallback). (c) The "system audio transcribes as a separate channel" success criterion may need to be gated on the signing outcome, or verified on a locally Developer-ID-signed dev build with a note that shipping it depends on Phase 8 signing.

**Swift helper contract (borrow openwhispr `resources/macos-audio-tap.swift` verbatim as the MIT reference):**
- `CATapDescription` with `processes=[]` + exclusive → whole-system mix; wrap in a private aggregate device (`AudioHardwareCreateAggregateDevice`, `kAudioAggregateDeviceTapListKey`, `isPrivate:true`); drive with `AudioDeviceCreateIOProcIDWithBlock` (NOT AVAudioEngine — it silently ignores aggregate-device retargeting); convert via `AVAudioConverter`.
- **Output 16 kHz mono 16-bit PCM raw to stdout** (openwhispr defaults to 24 kHz — set 16 kHz so it feeds `_ingestWhisperAudio`/`_createWavBuffer` unchanged), line-delimited JSON status on stderr (`{"type":"start"|"stop"|"error"}`). Treat the first `{"type":"start"}` as "permission granted + tap live"; `kAudioHardwareIllegalOperationError` → `permission_denied`.
- Gotchas to encode (all hide under `noErr`): the aggregate device needs a **real output device as the main sub-device** (a tap-only aggregate silently produces silence); `isExclusive` is directional (mis-setting inverts include/exclude semantics).
- **Persist grant/deny to a userData file** (openwhispr `userData/.system-audio-permission`) so it doesn't re-prompt each launch; consent at first ambient-listen; deny → mic-only with a clear note.
- Build: `xcrun swiftc` (fallback bare `swiftc`), per-arch targets then `lipo` to a universal binary, cache by source hash, verify Mach-O arch, **exit 0 no-op on non-darwin**. Whether an app relaunch is required after granting is unconfirmed in the sources → verify during the spike.

---

## Research Flag 4 — Two-channel plumbing (mic renderer path + system Swift-tap path)

**Confidence: HIGH** (grounded in the live capture/ingest/sink code).

Two capture sources, both landing in the **main process**, each with its **own** `VadSegmenter` + segment buffer + in-flight flag, each POSTing to the same `whisper-server`, each tagging its transcript:

- **Mic (existing, unchanged capture):** renderer `main-window.js:_startRendererAudioCapture` (verified `src/ui/main-window.js:954-1005`) → `getUserMedia` → `AudioContext(16000)` → `createScriptProcessor(4096)` → Int16 PCM → `window.electronAPI.sendAudioChunk(buffer)` → preload `audio-chunk` IPC (`preload.js:12`) → `main.js` `ipcMain.on('audio-chunk')` (verified `main.js:434-438`) → `speechService.handleAudioChunkFromRenderer(buffer)` (verified `src/services/speech.service.js:766-775`) → `_ingestWhisperAudio` (`:783-820`). This is the `source:'mic'` pipeline.
- **System (new):** `SystemAudioTapManager` spawns the Swift helper; its stdout 16 kHz mono PCM is fed to a **second** ingest path (e.g. `speechService.handleSystemAudioChunk(buffer)`) driving a **second** `VadSegmenter` instance and a **second** segment buffer → `POST /inference` → transcript tagged `source:'system'`. No renderer/`getUserMedia` involvement (main-process only).

**Refactor the single-channel state into a per-channel struct.** Today `SpeechService` holds one `this._segmenter`, `this.segmentBuffers`, `this.segmentBytes`, `this.transcriptionInFlight`, `this.pendingFlush/Final`. For two channels, factor these into a small per-channel object (`{ segmenter, buffers, bytes, inFlight, pendingFlush, pendingFinal, source }`) and route `_ingestWhisperAudio`/`_flushWhisperSegment`/`_endUtteranceFlush` by channel. This is the single biggest structural change in the service and should be its own task.

**Transcript sink — thread the `source` tag through:** today `_flushWhisperSegment` calls `this.emit('transcription', clean)` (a bare string, `:1621`), wired to `main.js:372` `speechService.on('transcription', text => this.handleTranscriptionFragment(text))` → `sessionManager.addUserInput(fragment, 'speech')` (verified `main.js:1233`, `session.manager.js:111` `addUserInput(text, source='chat')`) + broadcast `transcription-received {text}` to all windows. Minimal change: emit `{ text, source }`, update `handleTranscriptionFragment({text, source})` to broadcast the source (so the UI can label mic vs other party) and carry the tag into the session. Note `addUserInput`'s `source` param currently means input-kind (`chat|speech|llm_input`), so add the channel tag as separate metadata rather than overloading it. Phase 6 consumes the tag; Phase 4 only needs to preserve it end-to-end.

**Concurrency note:** `whisper-server` transcribes serially (single context, mutex-locked); concurrent mic+system POSTs queue on the server. Fine for Phase 4's rough smoke (utterances are short and pauses are staggered). If contention shows up later, options are `-p`/processors or a second server instance — out of scope now.

---

## Research Flag 5 — Rough STT smoke: `ggml-small.en` latency/accuracy + memory budget

**Confidence: MEDIUM-HIGH** (benchmark aggregates from multiple 2026 sources; exact numbers vary by chip).

- **Latency:** `ggml-small.en` on Apple-Silicon Metal runs **~22–34× real-time**; an M2 transcribes a 10 s clip in **~0.4–0.8 s**. For a typical 1–4 s VAD utterance that's roughly **~0.1–0.4 s** of transcription — comfortably near-real-time, well inside the "feels live" budget. Even base M1 beats real-time on small. Metal vs CPU is a 30–60%+ speedup (keep Metal on).
- **Accuracy:** small.en is the accuracy/speed/RAM sweet spot for **conversational English** (the STT bar here is "transcribe speech," not diarize a podcast — Pitfall 2/6). Matches today's `en` default and the English-only `_isHallucinatedTranscript` list.
- **Memory (Pitfall 2 budget):** weights are **487,614,201 bytes (~465 MiB / 488 MB)** on disk; resident RAM ~0.6–1 GB with Metal buffers + KV. It coexists with the resident VLM (`qwen3-vl:8b` ≈ 6 GB) + Electron/Chromium inside the 32 GB budget (reserve ~8 GB for OS/Chromium; ~75% GPU-wired cap). small.en is deliberately the low-RAM STT choice vs `large-v3-turbo` (~1.5 GB+) precisely to leave headroom for the VLM.
- **Smoke harness:** model `scripts/smoke-local.js` (the Phase-3 keyless local smoke). A `scripts/smoke-whisper.js`: start `WhisperServerManager`, POST a known short WAV to `/inference?response_format=verbose_json`, assert a non-empty transcript, and log wall-clock latency + the returned `no_speech_prob`. Keyless and network-free (loopback only) — safe to run without any cloud credentials, consistent with the "waive un-runnable live checks, keep the keyless wiring check" memory rule. Full sustained-load TTFT/memory validation is Phase 6.

---

## Research Flag 6 — Model download: source, checksum, resume, cache, offline/disk-full

**Confidence: HIGH** (URLs + sizes + SHA256 verified live; the SHA256 values are the authoritative git-LFS OIDs).

- **Source (canonical):** `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin`. Note the split: the **GitHub org renamed to `ggml-org`**, but the **Hugging Face *model* repo is still `ggerganov/whisper.cpp`** — that's what whisper.cpp's own `models/download-ggml-model.sh` uses (base URL `https://huggingface.co/ggerganov/whisper.cpp`, prefix `resolve/main/ggml`). `ggml-org/whisper.cpp` on HF returns 401 (not a public model repo). CONTEXT's "HF `ggerganov/whisper.cpp` resolve" is correct — keep it.
- **Resumable:** HF serves the file with `Accept-Ranges` (verified 302→CDN→`200`, `Content-Length: 487614201`) → HTTP `Range` resume works. Download to a `.part`/temp path, `Range: bytes=<existing>-` on resume, atomic-rename only after checksum passes (Pitfall 5). Do **not** let a partial file masquerade as installed.
- **Checksums — OpenCluely must pin them (the upstream script does NO verification):** verify SHA256 before marking "installed":

  | Model | Size (bytes) | SHA256 |
  |---|---|---|
  | `ggml-small.en.bin` (default) | 487,614,201 | `c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d` |
  | `ggml-base.en.bin` (fallback/low-RAM) | 147,964,211 | `a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002` |
  | `ggml-tiny.en.bin` (tests/CI) | 77,704,715 | `921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f` |

- **Cache:** `<userData>/.whisper-models/ggml-small.en.bin` — the same location `WhisperInstaller.modelDir` / `speech.service._getUserDataModelDir()` already use (verified `whisper-installer.js:152-154`, `speech.service.js:1135-1142`). Reuse it; just store `.bin` (ggml) instead of `.pt` (openai-whisper).
- **IPC/UI reuse:** the existing `install-progress` streaming channel + onboarding/settings progress UI already exists (`preload.js:47-53` `downloadWhisperModel`/`onInstallProgress`; `main.js:738-752` `download-whisper-model` handler streaming to `sender.send("install-progress", line)`). Swap the payload from log-lines to structured `{percent, downloadedBytes, totalBytes}` (throttle to ~100 ms) or keep line-based — either works; the structured form mirrors the Ollama `model-pull-progress` pattern (`main.js:758-769`) and is cleaner. Use a global `fetch`/`nodeFetch` byte stream (ESM `node-fetch` is banned — Constraints).
- **Failure UX (Pitfall 5):** detect offline on first launch → "connect once to download the ~488 MB voice model; after that OpenCluely works offline"; handle disk-full mid-download (reuse `LocalModelManager.preflight`'s `statfs` pattern, `local-model.manager.js:190-220`); resumable Retry; friendly messaging. Drop all venv/pip/Python machinery.

---

## Research Flag 7 — Azure-removal blast radius (Azure is STT-only; LLM path verified post-removal)

**Confidence: HIGH** (full-tree grep + reading the polyfill consumers).

**Azure is STT-only — confirmed.** `microsoft-cognitiveservices-speech-sdk` is `require`d in exactly one place (`src/services/speech.service.js:393`; dep at `package.json:37`). No LLM/other consumer. The only cross-cutting effect is the browser-DOM polyfill clobbering `global.URL`/`global.Blob`/`global.File` at module load — and that effect *harms* the LLM path (hence the `ensureNativeGlobalURL`/`nodeFetch` defenses). Removing it strictly helps.

**The cert-verify bypass is already gone** (Pitfall 12's global-startup concern resolved in Phase 3): `main.js:setupNetworkConfiguration` (verified `:306-317`) is provider-delegated and `LocalProvider` needs none — no global cert/UA code to clean up. Azure removal does not touch network config.

**Every reference to delete/edit (verified line numbers):**

| File | What | Verified lines |
|---|---|---|
| `src/services/speech.service.js` | Browser-DOM polyfill (the `if (typeof window === 'undefined')` block incl. the fake `URL` class `:293-308` and `global.URL=` clobber `:354`) | 1–380 |
| ″ | `require('microsoft-cognitiveservices-speech-sdk')` | 392–396 |
| ″ | `_initializeAzureClient` | 459–510 |
| ″ | `_startAzureRecording` | 574–671 |
| ″ | Azure branches: `initializeClient` (444-447), `startRecording` (556-558), `stopRecording` (848-864), `recognizeFromFile` (965-990), `testConnection` (1001-1015), `getStatus` (1047/1052/1061), `isAvailable` (1069-1071), `updateSettings` speechKeys (1081), `_getConfiguredProvider` (1098-1113), `_handleAudioChunk` azure branch (1579-1586) | as noted |
| ″ | **Python-CLI STT path to delete** (STT-01): `_getUserDataWhisperCandidate` (1200-1214), `_resolveWhisperCommand` (1216-1257), `_probeWhisperModuleFast` (1267-1292), `_probeWhisperCandidate` (1298-1370), `_expandConfiguredWhisperCandidates` (1372-1428), `_parseCommand` (1430-1447), `_transcribeWhisperBuffer` (1667-1677), `_transcribeWhisperFile` (1679-1735), `_getUserDataModelDir` (1135-1142), python-oriented getters | as noted |
| ″ | **KEEP & reuse:** `_ingestWhisperAudio` (783-820), `_flushWhisperSegment` (1593-1635, rewire to `/inference`), `_endUtteranceFlush` (823-830), `_isHallucinatedTranscript` (1643-1665, applied at 1620-1624), `_createWavBuffer` (1737-1760), `_startSegmentWatchdog` (733-760), `VadSegmenter` usage, renderer/native capture | as noted |
| `package.json` | remove `microsoft-cognitiveservices-speech-sdk` dep (keep `node-record-lpcm16` — Linux mic, not Azure) | 37 |
| `src/core/config.js` | remove `speech.provider:'azure'` + `speech.azure` block; collapse `speech.whisper` to the whisper-server block | 63–95 |
| `main.js` | `getSettings` azureKey/azureRegion/azureConfigured (1567/1568/1581) + `speechProvider` default (1566); `saveSettings` azure + whisper env updates (1618-1637); whisper installer IPCs `detect-whisper`/`install-whisper`/`download-whisper-model` (708-752) → replace with binary-presence check + ggml download | as noted |
| `onboarding.js` / `onboarding.html` | azure choice-card + `azurePanel` + `azureKey`/`azureRegion` (js 45-47,146-186,596-660; html 797-833); swap `detectWhisper()`/`installWhisper()` (Python) for whisper-server binary check + `ggml-small.en` download; `.venv-whisper` copy (304-322) | as noted |
| `settings.html` / `src/ui/settings-window.js` | provider dropdown azure option + `azureFields` + `azureKey`/`azureRegion` (html 384-448; js 10-11,93-94,170-171,192-213,287-288) → replace with local-whisper status/model/repair (Phase-3 minimal-switcher mirror) | as noted |
| `src/core/first-run.js` | `azureConfigured` (84), `whisperConfigured` (85), `.env` template azure/whisper comments (115-126) | as noted |
| `env.example` | remove `AZURE_SPEECH_KEY`/`AZURE_SPEECH_REGION` (10-11) + `WHISPER_COMMAND`/`WHISPER_MODEL`/`WHISPER_MODEL_DIR`/`WHISPER_LANGUAGE`/`WHISPER_SEGMENT_MS` (18-25) → add whisper-server knobs | as noted |
| `src/core/whisper-installer.js` | gut/replace the venv/pip/`downloadModel` Python machinery (624 lines) with a ggml model downloader; keep the streaming/`onProgress` UX shape | whole file |
| `webapp/index.html` | marketing copy mentions Azure (345) — cosmetic docs, low priority | 345 |

**`ensureNativeGlobalURL()` retirement + LLM-path verification (the manual-checkpoint core):**
- After the polyfill is gone, `global.URL` is never clobbered, so `ensureNativeGlobalURL()` (`src/core/local-transport.js:38`) is a permanent idempotent no-op. Consumers: `local-model.manager.js:22,34`, `local.provider.js:22,61`.
- **KEEP `nodeFetch`** — it is needed for an *independent* reason (Electron main's Chromium-net ambient `fetch` false-negatives the loopback daemon; `local-transport.js:22-25`), unrelated to Azure. Do NOT remove it.
- **Retire `ensureNativeGlobalURL`** per CONTEXT: remove the two call sites + the definition + the export, and update the three tests that *simulate* the poison in isolation and would otherwise assert a defense that no longer exists: `test/local-transport.test.js:57` ("restores a poisoned global.URL"), `test/local-model-manager.test.js:318` ("serverUp stays true when the Azure polyfill has poisoned global.URL"), `test/local-provider.test.js:169` ("robustness vs the Azure browser-DOM polyfill"). (Alternative low-churn option: leave it as a documented no-op — but CONTEXT says retire.)
- **Regression check:** Azure removal *cannot* regress the LLM path — the LLM's only coupling to Azure was defensive (working around the poison). After removal, verify with `make run_tests` (all `node:test` suites) + a keyless LocalProvider wiring check (client constructs, `ollama.list()` shape works) per the "keyless wiring check + golden parity, waive un-runnable live checks" memory rule. Confirm no residual `window`/`AudioContext`/`global.URL` references remain in the main process (Pitfall 12 warning sign).

**Sequencing (locked, mirror Phase 3):** prove the resident engine on both channels FIRST → then Azure removal is the final task behind the HARD MANUAL CHECKPOINT.

---

## Reusable Assets — verified (corrected file:line vs CONTEXT)

CONTEXT's line numbers were accurate; corrections/additions noted. Paths corrected: config is `src/core/config.js` (not root `config.js`); provider is `src/services/providers/local.provider.js` (not `src/providers/…`).

| Asset | File:line (verified) | Reuse note |
|---|---|---|
| `VadSegmenter` (pure state machine, `ingest(buffer, tuning)→{type,buffers}`) | `src/core/vad-segmenter.js:14-153` | **Instantiate one per channel** — no change needed; it's already dependency-free. `rmsEnergy`/`chunkDurationMs` are statics. |
| VAD test template | `test/vad-segmenter.test.js` | Model new pure-logic tests on this. |
| Hallucination filter | `src/services/speech.service.js:1643-1665` (`_isHallucinatedTranscript`); applied at `:1620-1624` | Keep as primary gate; add `no_speech_prob>0.6` as the second gate at the same site. |
| Renderer mic capture | `src/ui/main-window.js:954-1005` (`_startRendererAudioCapture`); trigger `handleRecordingStarted` `:919-938`; stop `:1007-1032` | Unchanged. getUserMedia→AudioContext(16000)→ScriptProcessor(4096)→Int16→`sendAudioChunk`. |
| Mic IPC → ingest | `preload.js:12` (`sendAudioChunk`) → `main.js:434-438` (`ipcMain.on('audio-chunk')`) → `speech.service.js:766-775` (`handleAudioChunkFromRenderer`) → `:783-820` (`_ingestWhisperAudio`) | The `source:'mic'` pipeline. |
| WAV framing | `src/services/speech.service.js:1737-1760` (`_createWavBuffer`) | 16 kHz mono 16-bit → exactly what `/inference` wants. Reuse for both channels. |
| Flush seam (rewire target) | `src/services/speech.service.js:1593-1635` (`_flushWhisperSegment`) | Replace `_transcribeWhisperBuffer` call with `POST /inference` (verbose_json). Keep the `transcriptionInFlight`/`pendingFlush` serialization (now per-channel). |
| `ServiceSupervisor` (+ statics) | `src/core/service-supervisor.js:78-271`; header pre-specs whisper-server config at `:17`; exports `probePort:269`, `probeHttp:270`, `computeBackoffDelay:271` | Configure with `{healthCheck:{type:'port',port}, adopt:false, pidFile, terminate:{sigtermGraceMs:5000}}`. `spawn` DI seam at `:87`. |
| Supervisor test template | `test/service-supervisor.test.js` | Model `WhisperServerManager` tests (fake `spawn`). |
| DI/manager template | `src/core/local-model.manager.js:27-73` (constructor/DI), `:77-98` (start/stop), `:157-188` (three-level `getStatus`), `:190-220` (disk/RAM preflight), `:313-337` (`_resolveOllamaBin` → binary resolution pattern) | **Mirror this shape for `WhisperServerManager`.** |
| Startup pre-warm placement | `main.js:283-296` (`onAppReady`: windows created first, then `await getLocalModelManager().start()` in try/catch, non-fatal) | Add whisper-server + system-tap start here, same non-fatal shape. |
| Quit teardown | `main.js:1511-1528` (`onWillQuit` → fire-and-forget `getLocalModelManager().stop()`) | Add `whisperServerManager.stop()` + `systemAudioTap.stop()`. |
| Lazy getter pattern | `main.js:1530-1552` (`getWhisperInstaller`, `getLocalModelManager`) | Add `getWhisperServerManager()` / `getSystemAudioTapManager()` (lazy so import/tests don't spawn). |
| Transcript sink | `main.js:372-374` (`on('transcription')`) → `:1226-1249` (`handleTranscriptionFragment`) → `sessionManager.addUserInput(fragment,'speech')` `:1233`; `session.manager.js:111` | Thread `source` tag through (Flag 4). |
| Interim stop control | mic button `src/ui/main-window.js:314` (click), `:919-947` (started/stopped); `main.js:941-969` (`toggleSpeechRecognition`), `340` (Alt+R) | Repurpose as the interim ambient on/off (no Phase-6 kill switch). |
| Download progress IPC/UI | `preload.js:47-53` (`downloadWhisperModel`/`onInstallProgress`); `main.js:738-752`; onboarding/settings progress UI | Reuse channel; swap payload to ggml download progress. |
| Model cache dir | `src/services/speech.service.js:1135-1142`; `src/core/whisper-installer.js:152-154` | `<userData>/.whisper-models/`. |
| Node-http fetch (keep) | `src/core/local-transport.js:72-142` (`nodeFetch`) | Loopback-safe fetch; usable for the whisper-server POST if the ambient fetch misbehaves on loopback (it did for Ollama). |
| Smoke template | `scripts/smoke-local.js` | Model `scripts/smoke-whisper.js`. |
| Test runner | `Makefile` `run_tests: node --test test/*.test.js`; `lint: npx eslint .` | No new framework; `test/fixtures/**` excluded. |

---

## Recommended Module / Architecture Shape (Claude's-Discretion answers)

**Modules (mirror existing DI shape: export the class, deps via an options object, default to real singletons, every method returns a status/struct instead of throwing):**
- `src/core/whisper-server.manager.js` → `WhisperServerManager` (mirrors `LocalModelManager`). Owns: binary resolution + Mach-O arch verify, free-port selection, `ServiceSupervisor` with the whisper-server config, three-level health, model-file presence check, `transcribe(wavBuffer, {language})` doing the `POST /inference?response_format=verbose_json`. Logger tag e.g. `'WHISPER'`.
- `src/core/system-audio-tap.manager.js` → `SystemAudioTapManager` (mirrors openwhispr `audioTapManager.js`). Owns: `isSupported()` (darwin && ≥14.4), helper spawn, stderr-JSON status parsing, grant/deny persistence, emits PCM chunks. Logger tag e.g. `'SYSAUDIO'`.
- `resources/mac/system-audio-tap.swift` (source) → compiled to `resources/bin/system-audio-tap` by `scripts/build-macos-audio-tap.js`.
- `scripts/build-whisper-server.js` (CMake build → `resources/bin/whisper-server`, no-op off-darwin) OR the fetch fallback; `scripts/smoke-whisper.js` (keyless smoke).
- STT model downloader: either gut `src/core/whisper-installer.js` in place or add `src/core/whisper-model-downloader.js` (resumable + SHA256-verify). Recommend a focused new module + delete the venv/pip file, to avoid confusion.

**Port selection:** pick a **free port at `start()`** — bind `net.createServer().listen(0)`, read `.address().port`, close, pass to `whisper-server --port <p>` and to the supervisor's `healthCheck.port` (get-port is ESM-banned; use `net`). On restart, **re-pick** the port (a fixed port could be orphan-held; re-pick sidesteps EADDRINUSE). Small TOCTOU race is acceptable on own-only loopback; the supervisor's backoff covers a rare collision. (openwhispr scans a fixed `8178-8199` range — either is fine; ephemeral is simpler and collision-free.)

**Health cadence / state:** reuse `ServiceSupervisor` port-probe (100 ms during startup, then the crash monitor). Expose **three health levels** (Pitfall 4): (1) *server up* = supervisor `healthy` / port open; (2) *model ready* = model `.bin` present on disk (checked pre-launch) — whisper-server loads `-m` at launch so "up" ≈ "model loaded", but keep the file check for the "download needed" message; (3) *responding* = a tiny `/inference` probe succeeds. Three distinct UI messages: "voice engine down" / "voice model missing — download" / "voice engine not responding — repair".

**Request params (per utterance):** `POST http://127.0.0.1:<port>/inference`, multipart: `file`=`_createWavBuffer(pcm)` (filename `segment.wav`), `response_format`=`verbose_json` (**required** for `no_speech_prob`), `language`=`en`, `temperature`=`0`. Parse `segments[]`; drop segments with `no_speech_prob > noSpeechThreshold` (default `0.6`), concatenate survivors, then apply `_isHallucinatedTranscript`. No server `--vad` (VAD stays in JS).

**Thread auto-tuning:** launch `whisper-server -t <n>` with `n = clamp(floor(os.availableParallelism()*0.5), 2, 8)` — deliberately **more conservative than openwhispr's 75%/[4,12]** to leave cores for the resident VLM (Pitfall 2). Make it overridable via `WHISPER_THREADS`.

**Two VadSegmenter pipelines — SHARE tuning (one config block), diverge later if needed.** The tuning is speaker-agnostic energy/hysteresis; two instances of the same tuning is correct for Phase 4. Caveat to note for a future tuning pass: system/line-level audio has a different noise profile than a room mic, so `vadEnergyFloor` may want a per-channel override eventually — but do not diverge now.

**Config collapse (`src/core/config.js`), concrete keys:**
```
speech: {
  whisper: {
    host: '127.0.0.1',            // whisper-server bind host
    port: 0,                      // 0 = auto-pick a free port at start()
    model: 'small.en',            // → filename ggml-${model}.bin
    language: 'en',
    threads: 0,                   // 0 = auto (clamp 50% cores, [2,8])
    noSpeechThreshold: 0.6,       // drop segment if no_speech_prob > this
    // existing VAD knobs, unchanged, now shared by both channels:
    vadEnabled: true, silenceHangoverMs: 700, minUtteranceMs: 350,
    maxUtteranceMs: 15000, preRollMs: 300, vadEnergyFloor: 0.008,
  }
}
```
Drop `speech.provider` and `speech.azure` entirely. Settings UI: replace the `azure|whisper` dropdown + Azure fields with a status/model/repair panel (Phase-3 "minimal switcher" mirror) — the provider choice is gone (single engine).

**Swift-helper build wiring:** `xcrun swiftc resources/mac/system-audio-tap.swift -O -target arm64-apple-macosx14.4 -o <tmp-arm64>` (+ `x86_64-apple-macosx14.4`), `lipo -create` to `resources/bin/system-audio-tap`, cache by source-hash+mtime, verify Mach-O arch, `process.exit(0)` no-op on non-darwin. Ad-hoc `codesign -s -` the helper + app for the spike (see Flag 3 risk).

---

## Standard Stack (this phase)

| Component | Choice / version | Why |
|---|---|---|
| STT engine | whisper.cpp `whisper-server`, tag **`v1.9.1`** (built from source, Metal on) | Locked; out-of-process, no native addon, crash-isolated, reuses `ServiceSupervisor`. |
| STT model | `ggml-small.en.bin` (487,614,201 B) from HF `ggerganov/whisper.cpp` | Locked; conversational-English sweet spot, low RAM, near-real-time on Metal. |
| Response format | `verbose_json` | Only format exposing `no_speech_prob` (Flag 1). |
| System audio (macOS ≥ **14.4**) | Core Audio Process Tap Swift helper (openwhispr MIT reference) | Locked; `NSAudioCaptureUsageDescription` bucket, no Screen-Recording TCC. |
| Supervision | `ServiceSupervisor` `adopt:false` + `pidFile` + SIGTERM(5s)→SIGKILL | Locked; own-only, orphan-reaping. |
| Transport | global `fetch` / existing `nodeFetch` + `net`/`child_process` | ESM `get-port`/`execa`/`node-fetch` banned in this CJS app. |
| Tests | `node --test test/*.test.js` | No new framework. |

## Don't Hand-Roll

| Problem | Don't build | Use instead |
|---|---|---|
| Resumable large download | custom retry loop | HTTP `Range` on the HF URL (`Accept-Ranges` confirmed) + temp-file + atomic rename |
| Process supervision/backoff/health | new supervisor | `ServiceSupervisor` (already pre-specs whisper-server) |
| VAD segmentation | new energy/hysteresis logic | `VadSegmenter` (one instance per channel) |
| WAV framing | new header writer | `_createWavBuffer` |
| Port probe | `get-port` (ESM) | `net.createServer().listen(0)` + `ServiceSupervisor.probePort` |
| System-audio Swift | write from scratch | port openwhispr `macos-audio-tap.swift` (set 16 kHz, target 14.4) |
| Silence hallucination | expand the phrase list only | phrase list + `no_speech_prob>0.6` (verbose_json) + VAD (three gates) |

## Common Pitfalls (this phase; full detail in `.planning/research/PITFALLS.md`)

- **#4 Service lifecycle:** distinguish server-up vs model-ready vs responding (three messages). Re-pick the port on restart; reap orphans via the PID sidecar. Own-only (`adopt:false`) — never touch a foreign process.
- **#6 Silence hallucination under always-on:** the whole reason for the `no_speech` gate. SC5 = 2 min silence → zero transcripts. Verify with the existing phrase list + `no_speech_prob>0.6` + VAD, and re-run `vad-segmenter.test.js`.
- **#2 OOM/memory:** small.en (~465 MiB resident) is the low-RAM choice precisely to coexist with `qwen3-vl:8b` + Electron in 32 GB. Conservative thread count leaves cores for the VLM.
- **#5 First-run download:** resume + SHA256-verify before "installed"; offline/disk-full messaging; drop venv/pip.
- **#3 TCC + unsigned (system audio):** the phase's top risk — the tap prompt won't fire unsigned (Flag 3).
- **#11 Binary packaging:** `asarUnpack` the whisper-server + Swift helper (can't spawn from asar); resolve via `process.resourcesPath` with a dev fallback; Mach-O arch verify. Phase 8 finalizes.
- **#12 Removal-last:** prove the engine, then delete Azure — never removal-first.

---

## Risks / Open Questions for the Planner

1. **[HIGH — likely blocks STT-04 on the shipped build] Core Audio tap needs a signing identity OpenCluely lacks.** The `NSAudioCaptureUsageDescription` prompt does not fire on unsigned (and reportedly not on ad-hoc) builds → silent zero-sample capture. Mitigation: an **early signing spike** (ad-hoc, then self-Developer-ID) to determine what actually makes the prompt fire; build system audio behind a clean degrade-to-mic path; treat the "system audio transcribes as a separate channel" success criterion as verified on a locally-signed dev build, with shipping it gated on Phase 8 signing. Mic-only ambient listening is the guaranteed baseline.
2. **[MEDIUM] Deployment floor 14.4, not 14.2.** Sources say ≥14.4 is needed for the correct TCC category. Update `isSupported()` and the Swift `-target` to 14.4; confirm the target macOS support range tolerates this.
3. **[MEDIUM] whisper-server macOS binary provenance.** No upstream prebuilt exists. Recommendation is build-from-source (needs Xcode CLT + CMake on the build box) into `resources/bin`. Confirm the dev machine has the toolchain; Phase 8 decides CI fetch-vs-build. Fallback: openwhispr fork / first-party release.
4. **[MEDIUM] `response_format=verbose_json` (not `json`).** The CONTEXT said `json`; that omits `no_speech_prob`. Planner must specify `verbose_json` and a `segments[]` parser. Confirm the built v1.9.1 server emits `no_speech_prob` in your build (it does on master; verify in the smoke).
5. **[MEDIUM] Transcript `source` tagging touches the sink signature.** `emit('transcription', text)` → `handleTranscriptionFragment(text)` → `addUserInput(text,'speech')` all assume a bare string. Threading `{text, source}` is small but crosses main.js + session.manager; keep the change minimal (Phase 6 consumes the tag).
6. **[LOW-MEDIUM] Relaunch-after-grant for the tap** is unconfirmed in sources — verify in the signing spike; if required, the UX must instruct a restart after the audio-capture grant.
7. **[LOW] Per-channel state refactor scope.** Making `SpeechService` two-channel (per-channel segmenter/buffer/in-flight) is the biggest structural change; give it its own task with unit tests, before wiring the system channel.
8. **[LOW] `powerMonitor` resume re-warm & mic-device change.** Locked as in-scope resilience (openwhispr #766: sleep evicts GPU state). Add a `powerMonitor.on('resume')` re-warm (re-probe/restart whisper-server + reopen the tap) and handle mic-device change (AirPods in/out) without crashing; guard re-entrancy. Lower risk than the signing issue but required for "survive a full session."

---

## Sources

**Primary (HIGH):**
- whisper.cpp server source + README (`ggml-org/whisper.cpp` master) — `/inference` params, `verbose_json` `no_speech_prob` (`segment["no_speech_prob"] = whisper_full_get_segment_no_speech_prob(...)`), `/load`, default port 8080, `--no-speech-thold 0.60`, VAD flags: https://github.com/ggml-org/whisper.cpp/blob/master/examples/server/server.cpp , https://github.com/ggml-org/whisper.cpp/blob/master/examples/server/README.md
- whisper.cpp v1.9.1 release asset list (no macOS binary; Linux/Win + xcframework only): https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest
- whisper.cpp `models/download-ggml-model.sh` (HF `ggerganov/whisper.cpp` base, no checksum): https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/models/download-ggml-model.sh
- HF git-LFS pointers (authoritative SHA256 + byte sizes for small.en/base.en/tiny.en), verified live via `huggingface.co/ggerganov/whisper.cpp/raw/main/*` and HEAD (`Content-Length: 487614201`, `Accept-Ranges`).
- OpenCluely live code (repo ground truth) — `src/services/speech.service.js`, `src/core/{vad-segmenter,service-supervisor,local-model.manager,local-transport,config,whisper-installer,first-run}.js`, `src/services/providers/local.provider.js`, `src/ui/main-window.js`, `main.js`, `preload.js`, `package.json`, `onboarding.*`, `settings.*`, `env.example`, `Makefile`, `test/*`.
- `.planning/research/OPENWHISPR-NOTES.md` (MIT reference: `whisperServer.js`, `audioTapManager.js`, `macos-audio-tap.swift`, `download-whisper-cpp.js`); `.planning/research/PITFALLS.md` (pitfalls 2/3/4/5/6/11/12); `.planning/research/STACK.md`.

**Secondary (MEDIUM, cross-verified):**
- openwhispr `scripts/download-whisper-cpp.js` — fetches `whisper-server-darwin-{arm64,x64}.zip` from the **fork** `OpenWhispr/whisper.cpp` releases: https://raw.githubusercontent.com/OpenWhispr/openwhispr/main/scripts/download-whisper-cpp.js
- Core Audio Process Tap / TCC / signing (2026): https://dgrlabs.co/blog/2026-04-25-capturing-system-audio-on-macos-in-2026.html , https://github.com/insidegui/AudioCap , https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps , https://www.maven.de/2025/04/coreaudio-taps-for-dummies/
- Apple-Silicon whisper.cpp small benchmarks (RTF 22–34×, ~200 ms latency, Metal speedup): https://justvoice.ai/blog/whisper-benchmark-apple-silicon-m3-m4 , https://www.promptquorum.com/local-llms/apple-silicon-whisper-metal-benchmark , https://getspeakup.app/blog/whisper-cpp-benchmark-mac/
- whisper.cpp server format enumeration / DeepWiki: https://deepwiki.com/ggml-org/whisper.cpp/3.2-http-server

## Metadata

**Confidence breakdown:**
- Reusable-asset map + line numbers: HIGH (read live code).
- whisper-server REST contract + `no_speech_prob`/`verbose_json`: HIGH (source-verified).
- Model source/size/SHA256/resume: HIGH (verified live).
- Binary provenance (no macOS prebuilt) + build-from-source rec: HIGH on the fact, MEDIUM on the build ergonomics (whisper.cpp server CMake target on macOS not personally compiled here).
- Azure blast radius + LLM-safe removal: HIGH (full grep + polyfill-consumer reading).
- System-audio TCC/signing: MEDIUM with a clearly-named HIGH risk (signing requirement corroborated by multiple 2026 sources; exact ad-hoc-vs-Developer-ID behavior needs an empirical spike).
- small.en latency/memory: MEDIUM-HIGH (aggregated benchmarks).

**Research date:** 2026-07-15
**Valid until:** ~2026-08-15 (whisper.cpp releases move fast — re-check the latest tag and that `no_speech_prob` remains in `verbose_json`; re-check macOS point-release TCC behavior before the signing spike).
