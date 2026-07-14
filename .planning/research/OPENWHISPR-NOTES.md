# OpenWhispr — Research Notes

**Purpose**: Prior-art study for OpenCluely's local-first always-on copilot transformation. Covers (1) the self-starting local model service pattern, and (2) macOS system-audio capture, to inform **STT-04**.

**Source**: [github.com/OpenWhispr/openwhispr](https://github.com/OpenWhispr/openwhispr), MIT license, 4.5k stars. Cloned shallow at commit `5cac496deb950378364cf872d2a416ade4845d83` (2026-07-10) into scratchpad for this research; not vendored into OpenCluely. All citations below are `path:line` against that commit unless a GitHub URL is given.

There is **no local clone under `/Users/ashutosh/personal/`** — the only local traces were a companion CLI (`@openwhispr/cli`, an npm-installed control-plane client, not the app itself) and a homebrew tap, neither of which contain the Electron app source. The actual app was fetched fresh from GitHub for this research.

---

## 1. Overview & Stack

OpenWhispr is "the open-source and free alternative to WisprFlow and Granola" — a cross-platform (macOS/Windows/Linux) Electron dictation + meeting-transcription + notes app with an AI agent layer. It is **not** Tauri or a native-only app; it's a fairly conventional Electron 41 + React 19 + TypeScript app, but with an unusually large amount of native/compiled surface area bolted on:

- **Shell**: Electron 41, React 19, TypeScript, Tailwind v4, shadcn/ui, Zustand stores (`main.js`, `preload.js`, `src/`).
- **Local STT**: whisper.cpp (server mode) and NVIDIA Parakeet via sherpa-onnx (ONNX runtime).
- **Local LLM**: llama.cpp (`llama-server` / `llama-cli`) for the AI agent and a "dictation agent" (voice-command) feature.
- **Local vector DB**: a vendored Qdrant binary, resident on loopback, for semantic search over notes.
- **Local diarization**: sherpa-onnx pyannote speaker-segmentation model.
- **Native platform helpers**: six standalone Swift binaries compiled at build time for macOS (audio tap, mic-active listener, media-remote control, text monitor, fast-paste, globe-key listener), plus separate native helpers for Windows (WASAPI loopback, key listener, fast-paste) and Linux (PipeWire portal audio, key listener, fast-paste) — all invoked as child processes, none as native Node addons/N-API bindings.
- Cloud paths exist in parallel (OpenAI/Anthropic/Gemini/Groq/etc., plus an "OpenWhispr Cloud" hosted API) — everything here is about the **local** paths only, since that's what's relevant to OpenCluely.

Languages in the repo (`gh repo view`): TypeScript/JavaScript dominate, plus Swift (~35KB, all six macOS helper binaries), C/C++ (whisper.cpp/llama.cpp build glue, ~150KB combined — note the app does not build these from source at runtime; see §5), Python (small utility scripts), Nix (dev shell), NSIS (Windows installer script).

---

## 2. Audio Capture — Mic vs. System, and the macOS Mechanism

**Key finding for STT-04: OpenWhispr is emphatically not mic-only. It captures real system/loopback audio on all three platforms, and on macOS it uses neither ScreenCaptureKit nor BlackHole.**

### 2.1 macOS: native Core Audio *Process Tap* API (not ScreenCaptureKit, not a virtual device)

macOS capture lives entirely in `resources/macos-audio-tap.swift` (424 lines), a standalone Swift binary — **not** the Electron/Chromium renderer, **not** `getUserMedia`. It uses the **Core Audio Process Tap API** introduced in **macOS 14.2 (Sonoma)**:

- `CATapDescription` + `AudioHardwareCreateProcessTap(tapDescription, &tapID)` creates a tap. `tapDescription.processes = []` with `isExclusive = true` means "exclude nothing" → captures the **whole system audio mix**, not a single app's output. (`resources/macos-audio-tap.swift:39-54`)
- The tap is wrapped in a **private aggregate device** (`AudioHardwareCreateAggregateDevice` with `kAudioAggregateDeviceTapListKey`, no sub-devices, `isPrivate: true`) so it can be driven with a normal `AudioDeviceIOProcID` callback. (`:101-118`, `:172-194`)
- Captured audio is converted with `AVAudioConverter` to 16-bit mono PCM at a configurable sample rate (default 24kHz) and written **raw to stdout** in ~100ms chunks; status/error events are emitted as line-delimited JSON on **stderr** (`{"type":"start"|"stop"|"error", ...}`). (`:196-343`)
- Gated behind `@available(macOS 14.2, *)`; on older macOS it exits immediately with `{"code":"unsupported_os"}`. (`:380-423`)

The Node/Electron side, `src/helpers/audioTapManager.js` (469 lines), is a thin process manager:
- `isSupported()` checks `process.platform === "darwin" && process.getSystemVersion() >= "14.2"`.
- Spawns the compiled binary, treats the first `{"type":"start"}` JSON line on stderr as "permission granted + tap live," and treats `kAudioHardwareIllegalOperationError` as `permission_denied`. (`:178-241`)
- **Persists granted/denied status to a file** (`userData/.system-audio-permission`) so the app doesn't have to re-probe (and re-trigger a system prompt) on every launch. (`:80-103`)
- Validates the compiled binary's Mach-O arch (magic number `0xfeedfacf` + cpu-type check) before trusting it, to catch arm64/x64 mismatches from a bad build. (`:437-466`)

**Permission mechanics** (from the packaging config, not the Swift file): the macOS build declares `NSAudioCaptureUsageDescription: "OpenWhispr uses system audio to capture other participants' audio from calls and meetings."` in `electron-builder.json:153`, distinct from `NSMicrophoneUsageDescription` (`:152`). The hardened-runtime entitlements file (`resources/mac/entitlements.mac.plist`) grants only `com.apple.security.device.audio-input` (mic) plus the standard Electron JIT/library-validation entitlements — **no special entitlement is needed for the process tap itself**. This is a materially lighter permission story than ScreenCaptureKit, which is normally gated behind the Screen Recording (now "Screen & System Audio Recording") TCC bucket — a system-settings-pane permission that historically can't be granted through a simple in-app consent alert the way `NSAudioCaptureUsageDescription` can, and which (on many macOS versions) has required an app relaunch after granting. OpenCluely should verify current exact behavior on the target macOS version(s), but the code evidence here is unambiguous: **OpenWhispr chose the dedicated Core Audio Tap permission path specifically to avoid the Screen Recording bucket.**

Build/packaging for this binary is itself worth noting: `scripts/build-macos-audio-tap.js` compiles `macos-audio-tap.swift` via `xcrun swiftc` (falling back to bare `swiftc`) targeting `arm64-apple-macosx14.2` / `x86_64-apple-macosx14.2` explicitly, skips recompilation via a source-hash + mtime cache, and verifies the output arch before accepting it. It's a no-op on non-darwin (`process.exit(0)` immediately). Wired up as `npm run compile:audio-tap` (`package.json:21`).

Two *other* macOS Swift helpers are easy to mistake for capture but aren't:
- `resources/macos-mic-listener.swift` — does **not** capture audio. It registers CoreAudio property listeners (`kAudioDevicePropertyDeviceIsRunningSomewhere`) on all input devices and just emits `MIC_ACTIVE`/`MIC_INACTIVE` lines — used for meeting-state/UX signaling, not transcription.
- `resources/macos-media-remote.swift` — wraps the private `MediaRemote.framework` to query/pause system media playback (e.g., pause music before dictating); explicitly detects that macOS 15.4+ closed this framework to unprivileged processes and degrades to `UNKNOWN`. Unrelated to audio capture, included here only so it isn't misread as such.

### 2.2 Windows: native WASAPI process-loopback (not Chromium loopback)

`src/helpers/windowsLoopbackAudioManager.js` spawns a compiled `windows-system-audio-helper.exe` (native WASAPI process-loopback capture). The code comment is the clearest articulation in the repo of *why* a native helper beats the Electron/Chromium path:

> "Captures system audio on Windows via a native WASAPI process-loopback helper. Unlike Chromium's display-media loopback (which only hears the default render device), process loopback hears every application on every output device and excludes OpenWhispr's own audio." (`src/helpers/windowsLoopbackAudioManager.js:9-13`)

### 2.3 Linux: PipeWire portal (with Chromium loopback as fallback)

`src/helpers/linuxPortalAudioManager.js` spawns a compiled `linux-system-audio-helper` (PipeWire/XDG-portal based), tracks portal restore tokens (`restoreTokenAvailable`, `portalVersion` fields) to avoid re-prompting every session. Where the portal path isn't available, it falls back to the same renderer-side mechanism as below.

### 2.4 Unifying abstraction + Chromium `getDisplayMedia` as the universal fallback

`src/types/electron.ts:300-317` defines the cross-platform contract:
```ts
type SystemAudioMode = "native" | "loopback" | "portal" | "unsupported";
type SystemAudioStrategy = "native" | "loopback" | "pipewire-loopback" | "wasapi-loopback" | "unsupported";
```
`src/utils/systemAudioAccess.ts` and `src/stores/meetingRecordingStore.ts` (1280 lines; see `:170-241` for the fallback path) tie it together: macOS uses `"native"` (the process tap, fully main-process-managed, no renderer permission dance — `canManageSystemAudioInApp = mode === "native"`); Windows defaults to `"wasapi-loopback"`; Linux to `"pipewire-loopback"` when the portal helper is available. When none of the native helpers apply, the renderer calls `navigator.mediaDevices.getDisplayMedia({video:true, audio:true, systemAudio:"include", windowAudio:"system", selfBrowserSurface:"exclude"})` — Electron/Chromium's screen-share-based loopback trick — then immediately drops the video track and keeps only audio. This is treated as the **fallback of last resort**, not the primary design, on every platform.

**Mic + system reconciliation**: `src/helpers/diarization.js` runs STT on the mic and system streams as separate tagged sources (`source: "mic" | "system"`) and then runs a `dedupeMicAgainstSystem()` pass that drops mic-side segments flagged as `likelyRenderBleed`/`hasBleedEvidence`/`double_talk` if they text-overlap a system-audio segment in a 6s window — i.e., explicit handling of the other-party's voice leaking from your speakers into your own mic, layered on top of a separate native AEC helper (`scripts/download-meeting-aec-helper.js` — a first-party prebuilt binary, own repo release tag `meeting-aec-helper-v*`, for darwin-arm64/darwin-x64/linux-x64/win32-x64).

### 2.5 Answering the question directly

**How does OpenWhispr do system audio capture, and via what mechanism on macOS?** Native OS-level "process loopback" APIs on every platform, each shipped as a small compiled helper binary invoked as a child process and streamed over stdout/stderr — **not** a virtual audio device (no BlackHole anywhere in the codebase — confirmed via grep), **not** ScreenCaptureKit, **not** `getUserMedia` as the primary path. On macOS specifically it is the **Core Audio Process Tap API (`AudioHardwareCreateProcessTap` / `CATapDescription`, macOS 14.2+)**, chosen (based on the entitlements/Info.plist evidence) over ScreenCaptureKit specifically to get a lighter, audio-specific permission grant instead of the Screen Recording bucket.

---

## 3. Local Model / STT Service Pattern (the part the owner cited before)

This is the single most directly reusable part of the codebase for OpenCluely's "self-starting local model service" pattern, and it is **exactly** the localhost-resident-service shape already chosen for Ollama — OpenWhispr runs the analogous thing for whisper.cpp, llama.cpp, *and* Qdrant.

### 3.1 `WhisperServerManager` (`src/helpers/whisperServer.js`, 841 lines)

- Spawns whisper.cpp's own **server binary** (`whisper-server`, whisper.cpp's built-in HTTP server example, not a hand-rolled wrapper) bound to `127.0.0.1`, scanning a fixed port range `8178–8199` for the first free port (`:16-17`, `:366-371`).
- Health-checked via plain `GET /` polling — every 100ms during startup (30s timeout), every 5s once running (`:554-632`).
- Transcription is a `POST /inference` multipart request (file + language + optional prompt + `response_format=json`) — whisper.cpp server's native REST contract. Input is always pre-converted to 16kHz mono WAV via a bundled `ffmpeg-static` binary first, since the server only accepts that exact format unless FFmpeg conversion is available (`:634-773`).
- **Thread auto-tuning**: defaults to `75%` of `os.availableParallelism()`, clamped to `[4, 12]` automatically or `[1, 64]` if manually configured via `WHISPER_THREADS`; if a chosen thread count fails to start, it retries once with the default (`:26-119`, `:521-538`).
- **VAD is a first-class server flag**, not a separate pipeline stage: `--vad --vad-model <path> --vad-threshold --vad-min-speech-duration-ms --vad-min-silence-duration-ms --vad-max-speech-duration-s --vad-speech-pad-ms --vad-samples-overlap`, all sanitized/clamped centrally (`src/helpers/whisperVadConfig.js` + `src/constants/whisperVad.json` DEFAULTS/LIMITS table).
- **CUDA variant with automatic fallback**: prefers a `whisper-server-<platform>-<arch>-cuda` binary if present and requested; if it exits within 10s of starting, treats that as a CUDA failure and transparently restarts on the CPU binary (`:409-419`, `:510-520`).
- **Remote mode**: `connectRemote(url)` lets the exact same manager talk to a whisper-server running elsewhere instead of spawning locally — a clean escape hatch for "bring your own server."
- Lifecycle: SIGTERM then SIGKILL-after-5s on stop; a **PID sidecar file** (`src/helpers/sidecarPidFile.js`) is written on start and cleared on clean exit, so a stale/orphaned `whisper-server` from a crashed previous session can be identified and reaped on next launch — a cheap, generalizable robustness trick for any "keep a local server resident" design.

### 3.2 Startup pre-warm + sleep/wake re-warm (`main.js:940-994`, `src/helpers/whisper.js:89-140,247-270`)

This is the "self-starting… keep resident" behavior verbatim:
- After `app.whenReady()`, `whisperManager.initializeAtStartup(settings)` runs **non-blocking**: if local transcription is enabled and the selected model is already on disk, it starts the whisper-server **before the user does anything**, explicitly to "eliminate the 2-5s cold-start delay" (comment at `src/helpers/whisper.js:97`). If pre-warm fails, it's swallowed as non-fatal and the server just starts lazily on first real use instead.
- The exact same pattern runs for the local LLM: `modelManagerBridge.prewarmServer(modelId)` (`src/helpers/modelManagerBridge.js:430-450`) spawns `llama-server` with `gpuLayers: 99` (offload as much as possible to GPU) at startup for the "cleanup" and "dictation agent" local-model features, also non-blocking/non-fatal.
- **Sleep/wake handling is an explicit, documented gotcha**: `powerMonitor.on("resume", ...)` triggers a delayed re-warm because *"Sleep evicts the local GPU model from VRAM; reload it once the driver settles"* (`main.js:946`, referencing their own issue #766). `onWakeFromSleep()` replays the exact prior start options (VAD/thread signature) rather than a bare restart, guarded against re-entrancy (`_rewarmInFlight`) and against interrupting an in-progress transcription.
- Startup also runs `cleanupStaleDownloads()` to remove partial/interrupted model downloads left over from a killed previous session.

### 3.3 Model download & cache (`src/helpers/ModelManager.ts`, `LOCAL_WHISPER_SETUP.md`)

- Whisper GGML models cache to `~/.cache/openwhispr/whisper-models/`; LLM (llama.cpp) models to a sibling `~/.cache/openwhispr/models/` (`src/helpers/ModelManager.ts:47-50`). Same top-level convention OpenCluely likely wants: one dotted cache dir per app, sub-keyed by service.
- Download UX (`src/hooks/useModelDownload.ts`, `useLocalModels.ts`): streamed progress events (percentage/downloaded/total bytes) throttled to 100ms UI updates; explicit states for `downloading → installing → complete/error`; **corrupted-download detection** by checking the final file size against a minimum-size constant and deleting+erroring if too small (`ModelManager.ts:108-114`); a `Set`/`Map` of in-flight downloads prevents double-triggering the same model download from two UI paths.
- First-run UX per `LOCAL_WHISPER_SETUP.md`: user opts in via Settings → "Use Local Whisper," picks a model (tiny/base/small/medium/large with a size/speed/quality/RAM table), and **the first transcription attempt triggers the model download automatically** if not already cached — i.e., local mode is opt-in, not auto-enabled, and cloud is the default (`settingsStore.ts:872`: `useLocalWhisper` defaults to `false`).

### 3.4 A third resident local service: Qdrant

`src/helpers/qdrantManager.js` + `scripts/download-qdrant.js` run a **vendored Qdrant vector-DB binary** resident on loopback for semantic search over notes — the same "spawn prebuilt upstream binary as a child process, bind to localhost, health-check it" shape as whisper-server and llama-server, just for a different upstream project. Worth noting as evidence this is a deliberate, repeated architectural choice in the app, not a one-off.

---

## 4. Reusable VAD / Streaming / Audio-Pipeline Patterns

- **VAD lives in the STT server, not a separate JS-side stage** — whisper-server is invoked with `--vad` + a Silero-style VAD model path and threshold/duration/padding flags, centrally sanitized/clamped against a single DEFAULTS/LIMITS table (`src/helpers/whisperVadConfig.js`, `src/constants/whisperVad.json`) with independent enable/disable per context (`dictation`, `noteRecording`, `meeting`).
- **Dual-stream capture + reconciliation for meetings**: mic and system audio are captured and transcribed as independently tagged sources, then merged/deduped by timestamp-window + text-similarity matching to suppress "render bleed" (system audio leaking back through the mic) — see `dedupeMicAgainstSystem()` and `transcriptsOverlap`/`transcriptsLooselyOverlap` in `src/helpers/diarization.js`. This is directly relevant if OpenCluely ever transcribes mic+system together rather than keeping them as fully separate channels (STT-04 currently specifies "separate channel," so this may not be needed immediately, but it's the right reference if fusion is ever wanted).
- **Local diarization** via a downloaded sherpa-onnx pyannote speaker-segmentation model (`SEGMENTATION_MODEL_URL` → `k2-fsa/sherpa-onnx` GitHub releases) plus voice-fingerprint matching across sessions — fully on-device.
- **Orphan-process cleanup**: a tiny PID-sidecar-file convention (`src/helpers/sidecarPidFile.js`) used for every resident child process (whisper-server, etc.), read back at next startup to kill anything left running from a crash.
- **GPU/VRAM eviction on sleep is a named, handled failure mode** (`main.js` `powerMonitor` resume handler) — directly relevant to any Ollama-resident-model design running on laptops that sleep.

---

## 5. Packaging: Shipping Native/Audio Bits Cross-Platform

Two distinct strategies, used for different kinds of native code:

1. **First-party Swift/native helpers are compiled locally at build time**, per-target, and cached by source hash (macOS: `scripts/build-macos-audio-tap.js` and five sibling `build-*.js` scripts, unified under `npm run compile:native`; similar per-platform scripts exist for Windows/Linux key listeners and paste helpers). Each script is a no-op that exits 0 immediately on the wrong host OS, so the same `npm run compile:native` is safe to run anywhere. Output binary architecture is verified via Mach-O header inspection before being trusted.
2. **Third-party engines (whisper.cpp, llama.cpp, sherpa-onnx, Qdrant) are never built from source at package time.** Instead, `scripts/download-whisper-cpp.js`, `download-llama-server.js`, `download-sherpa-onnx.js`, `download-qdrant.js` fetch **prebuilt binaries from the upstream project's GitHub Releases**, pinned to a specific tested tag (e.g., llama.cpp pinned to tag `b9763` with the comment *"whisper-server is statically linked, so bumping this can't affect local Whisper"* — `scripts/download-llama-server.js:16-18`), for every `platform-arch` combination, so **one CI machine can produce all platform artifacts** without cross-compiling. `npm run download:whisper-cpp:all` / `:current` mirrors this for whisper.cpp.
3. Everything lands in `resources/bin/`, resolved at runtime through an ordered list of candidate paths that account for dev vs. packaged-app layouts (including `app.asar.unpacked`) — see the near-identical `resolveBinary()` methods in `audioTapManager.js`, `windowsLoopbackAudioManager.js`, `linuxPortalAudioManager.js`, and `getServerBinaryPath()` in `whisperServer.js`.
4. `electron-builder.json` ships `dmg`+`zip` for macOS (hardened runtime, notarized, `entitlements.mac.plist`), `nsis`+`portable` for Windows, `AppImage`+`deb`+`rpm`+`tar.gz` (+ a Flatpak manifest with `--socket=wayland --socket=fallback-x11 --share=network --share=ipc`) for Linux.

---

## 6. Recommendation for OpenCluely

### STT-04 (macOS system audio)

1. **Add the Core Audio Process Tap API as the primary macOS mechanism to evaluate against ScreenCaptureKit before locking STT-04's implementation**, not just as a footnote. OpenWhispr's code is a strong, working, MIT-licensed reference implementation (`resources/macos-audio-tap.swift`) for exactly the same problem in the same runtime shape (Electron + spawned Swift helper). Concrete reasons to prefer it over ScreenCaptureKit for an audio-only, always-on feature:
   - Lighter permission story: a dedicated `NSAudioCaptureUsageDescription` consent, no Screen Recording/"Screen & System Audio Recording" TCC bucket, no extra hardened-runtime entitlement, and (per this codebase's entitlements file) it does not appear to require the app-relaunch-after-grant dance that Screen Recording historically does.
   - No video pipeline to stand up and tear down just to get audio, and no persistent screen-recording indicator surprising the user for what's supposed to be a background listening feature.
   - Requires macOS 14.2+ — verify this floor is acceptable for OpenCluely's target macOS support range (this is *newer* than the SpeechAnalyzer 26+ gate already tracked in `SUMMARY.md:190`, so it's a softer constraint by comparison).
   - Caveat: exact TCC bucketing has shifted across recent macOS point releases and some community reports suggest Core Audio Taps have been folded toward similar consent surfaces as ScreenCaptureKit on the newest OS versions — verify empirically on the actual target OS build before finalizing, and treat Apple's WWDC23 "Adopt Core Audio Taps" session as the authoritative spec.
2. **Borrow the process-per-platform shape wholesale, not just the macOS piece**: OpenWhispr's `SystemAudioStrategy` abstraction (`native` macOS / `wasapi-loopback` Windows / `pipewire-loopback` Linux / `loopback` Chromium fallback) is a clean template if/when OpenCluely extends system-audio capture beyond macOS. In particular, the Windows comment (`windowsLoopbackAudioManager.js:9-13`) is a good citation for *why* a native WASAPI process-loopback helper beats Electron's own `getDisplayMedia` loopback if Windows system audio ever comes up.
3. **Don't drop the other three references the owner named** — OpenWhispr is now a legitimate fourth code-level reference alongside them, not a replacement: Pluely, Glass, and Project Raven were not investigated in this pass (out of scope for this task) and should still be cross-checked, particularly for their exact ScreenCaptureKit usage if the team decides to stick with ScreenCaptureKit per the current STT-04 wording.
4. If mic+system fusion (rather than "separate channel" as STT-04 currently specifies) ever becomes desirable, `diarization.js`'s bleed-suppression/dedup logic is the right pattern to study.

### Local-service startup UX (whisper.cpp / Ollama)

5. **This directly resolves the open RESEARCH FLAG in `ROADMAP.md:70`/`SUMMARY.md:186`** ("in-process `smart-whisper` vs. supervised `whisper-server`"): OpenWhispr's production implementation is a supervised, out-of-process `whisper-server` on loopback — not an in-process native addon — specifically because it decouples the STT engine's lifecycle (and native ABI) from Electron's bundled Node/V8 version, matches the existing Ollama-style "resident supervised process on localhost" architecture, and gives crash isolation for free. This is evidence in favor of choosing supervised `whisper-server` over in-process `smart-whisper` for OpenCluely, consistent with what the flag already leaned toward.
6. **Copy the pre-warm-at-startup + non-blocking + lazy-fallback pattern** (`main.js:940-994`, `whisper.js:initializeAtStartup`): start the resident model service right after `app.whenReady()` if a model is already cached and local mode is enabled, swallow failures as non-fatal, and fall back to starting on first real request. This gives the "self-starting, cached, resident" behavior the owner wants without blocking app launch on it.
7. **Add a sleep/wake re-warm handler.** This is a non-obvious, real production bug OpenWhispr had to fix (issue #766: GPU VRAM eviction on sleep) — worth building into OpenCluely's Ollama supervisor from day one rather than discovering it later: listen for OS resume/wake and re-issue the same model-load call the service was last configured with.
8. **Adopt the PID-sidecar-file pattern** (`sidecarPidFile.js`) for orphan cleanup of the local model service across crashes/force-quits — trivial to implement, meaningfully reduces leaked resident processes.
9. **For packaging**: don't build whisper.cpp/llama.cpp/Ollama-adjacent binaries from source per platform. Vendor prebuilt binaries from the upstream project's own GitHub Releases, pinned to a tested tag, fetched per `platform-arch` at build time (`download-whisper-cpp.js`, `download-llama-server.js` pattern) — this lets a single CI runner produce all platform artifacts and avoids the cross-compilation problems that would come from building whisper.cpp from source for Windows/Linux on a macOS CI box.

---

## Source Index

| Topic | File(s) |
|---|---|
| macOS system audio capture | `resources/macos-audio-tap.swift`, `src/helpers/audioTapManager.js`, `scripts/build-macos-audio-tap.js` |
| macOS mic-active / media-remote (not capture) | `resources/macos-mic-listener.swift`, `resources/macos-media-remote.swift` |
| Windows system audio | `src/helpers/windowsLoopbackAudioManager.js` |
| Linux system audio | `src/helpers/linuxPortalAudioManager.js` |
| Cross-platform strategy types & fallback | `src/types/electron.ts:300-317`, `src/utils/systemAudioAccess.ts`, `src/stores/meetingRecordingStore.ts` |
| macOS entitlements/usage strings | `electron-builder.json:133-156`, `resources/mac/entitlements.mac.plist` |
| Local whisper.cpp server | `src/helpers/whisperServer.js`, `src/helpers/whisperVadConfig.js`, `src/constants/whisperVad.json` |
| Startup pre-warm / wake re-warm | `main.js:940-994`, `src/helpers/whisper.js:89-140,247-270` |
| Local LLM (llama.cpp) manager | `src/helpers/ModelManager.ts`, `src/helpers/modelManagerBridge.js:430-450` |
| Model download UX | `src/hooks/useModelDownload.ts`, `src/hooks/useLocalModels.ts`, `LOCAL_WHISPER_SETUP.md` |
| Local vector DB | `src/helpers/qdrantManager.js`, `scripts/download-qdrant.js` |
| Diarization + bleed dedup | `src/helpers/diarization.js` |
| Orphan process cleanup | `src/helpers/sidecarPidFile.js` |
| Binary vendoring / packaging | `scripts/download-whisper-cpp.js`, `scripts/download-llama-server.js`, `scripts/download-meeting-aec-helper.js`, `electron-builder.json` |
| Repo metadata | `README.md`, `gh repo view OpenWhispr/openwhispr` |

OpenCluely's own prior findings referenced above: `.planning/REQUIREMENTS.md:36`, `.planning/ROADMAP.md:63-70`, `.planning/research/FEATURES.md:43`, `.planning/research/SUMMARY.md:183-190`.
