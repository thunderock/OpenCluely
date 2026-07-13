# External Integrations

**Analysis Date:** 2026-07-13

## APIs & External Services

**AI / LLM — Google Gemini (the only LLM provider):**
- SDK: `@google/genai` (`^2.9.0`), imported as `GoogleGenAI` in `src/services/llm.service.js`.
- Client init: `LLMService.initializeClient()` (`src/services/llm.service.js:17`) — reads the key via `config.getApiKey('GEMINI')` → `process.env.GEMINI_API_KEY`, constructs `new GoogleGenAI({ apiKey })`, and sets the active model from `config.get('llm.gemini.model')`.
- Models (`src/core/config.js` → `llm.gemini`): primary `gemini-3.1-flash-lite`; fallbacks `gemini-2.5-flash-lite`, `gemini-3.5-flash`. On a model-unavailable signal (HTTP 503 / `UNAVAILABLE` / "high demand" / rate-limit text), `executeRequest()` / `executeStreamingRequest()` immediately advance to the next fallback model rather than exhausting all `maxRetries` (3) on a dead model; other errors retry the same model with exponential backoff + jitter (`analyzeError()`, `delay()`).
- Call sites (all in `src/services/llm.service.js`, invoked from `main.js`):
  - `processTextWithSkill` / `processTextWithSkillStream` — typed chat messages (`main.js: processWithLLM()`, IPC `send-chat-message`).
  - `processImageWithSkill` / `processImageWithSkillStream` — screenshot analysis; the PNG buffer from `src/services/capture.service.js` is base64-encoded and sent as an `inlineData` part alongside the active skill prompt as `systemInstruction` — **no OCR step**, Gemini reads the image directly (`main.js: triggerScreenshotOCR()`).
  - `processTranscriptionWithIntelligentResponse` / `...Stream` — voice transcripts, wrapped in an "intelligent filter" system prompt (`getIntelligentTranscriptionPrompt()`) that decides whether the utterance is a real question vs. filler/greeting before answering (`main.js: processTranscriptionWithLLM()`).
- Three distinct request mechanisms exist and are used situationally:
  1. SDK call — `this.client.models.generateContent({ model, contents, config, systemInstruction })` (`executeRequest()`).
  2. Manual HTTPS non-streaming fallback — raw `https.request` POST to `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` with header `x-goog-api-key: <GEMINI_API_KEY>` (`executeAlternativeRequest()` / `_executeAlternativeRequestForModel()`). Which of (1)/(2) is tried first is controlled by `config.get('llm.gemini.enableFallbackMethod')` (default `true`, so the manual HTTPS path is actually tried *first* for reliability, with the SDK as the fallback).
  3. Manual SSE streaming — raw `https.request` POST to `https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse`, hand-parsed line-by-line for `data: {...}` chunks (`_streamRequestForModel()`). All of the app's word-by-word streamed answers (chat + overlay) go through this path, not the SDK's own streaming API.
- Generation defaults (`getGenerationConfig()`): `temperature: 0.7`, `topK: 32/40`, `topP: 0.9/0.95`, `maxOutputTokens: 4096`, `thinkingConfig: { thinkingBudget: 0 }` (thinking disabled for latency).
- Diagnostics exposed to the renderer via IPC: `test-gemini-connection` → `LLMService.testConnection()` (sends a trivial "Test connection" prompt); `run-gemini-diagnostics` → `checkNetworkConnectivity()` (raw TCP-connect probes to `google.com:443` and `generativelanguage.googleapis.com:443`, no HTTP request) + `testConnection()`. Both surface user-friendly translated error strings via `_friendlyTestError()` (e.g. "Invalid API key...", "Cannot reach Google servers...").
- Electron networking accommodations specific to Gemini, in `main.js: setupNetworkConfiguration()`: overrides the `User-Agent` header and forces certificate trust (`setCertificateVerifyProc` → `callback(0)`) specifically for requests to `generativelanguage.googleapis.com`.

**Speech-to-Text — two optional, mutually exclusive providers selected by `SPEECH_PROVIDER`:**
- **Azure Cognitive Services Speech** (cloud) — SDK: `microsoft-cognitiveservices-speech-sdk` (`^1.40.0`). `src/services/speech.service.js: _initializeAzureClient()` builds `sdk.SpeechConfig.fromSubscription(AZURE_SPEECH_KEY, AZURE_SPEECH_REGION)`, sets `speechRecognitionLanguage` (default `en-US`), `OutputFormat.Detailed`, and silence-timeout properties. `_startAzureRecording()` opens a continuous `SpeechRecognizer` over a push-stream fed by microphone PCM (via `node-record-lpcm16`) and emits `recognizing` (interim) / `recognized` (final) events. Requires **both** `AZURE_SPEECH_KEY` and `AZURE_SPEECH_REGION`; if either is missing, `_getConfiguredProvider()` silently falls back to `whisper`. Since the app has no `window` polyfill issue in Node, `speech.service.js` ships an extensive top-of-file polyfill (`global.window`, `AudioContext`, `Blob`, etc.) purely so the Azure SDK — which expects a browser-like environment — can load under Node in the main process.
- **Local OpenAI Whisper CLI** (offline, default provider) — see "Local/Native Tooling" below; not a network integration.

**Marketing / landing page (outside the Electron app):**
- `webapp/script.js` calls the public **GitHub REST API** (unauthenticated `fetch`, no token) from the browser:
  - `https://api.github.com/repos/TechyCSR/OpenCluely` (repo metadata, e.g. star count)
  - `https://api.github.com/repos/TechyCSR/OpenCluely/releases/latest` (latest release + per-platform download links)
  - Renders results into `webapp/index.html`. This runs only when the static site (`opencluely.techycsr.dev`) is loaded in a regular browser — it is not reachable from, or bundled into, the Electron desktop app.

## Local/Native Process Integrations (not network APIs)

**Whisper CLI (`openai-whisper`, Python):**
- Not an npm dependency — invoked as an external process. Two independent install paths converge on the same runtime contract:
  - **Dev/CLI**: `setup.sh` → `setup_whisper_env()` creates `.venv-whisper/` (project root) via `python3 -m venv`, `pip install openai-whisper`, and writes `WHISPER_COMMAND`/`WHISPER_MODEL_DIR`/etc. into `.env`.
  - **Packaged app / onboarding wizard**: IPC handlers in `main.js` (`detect-whisper`, `install-whisper`, `download-whisper-model`) delegate to `src/core/whisper-installer.js` (`WhisperInstaller`), which creates an equivalent venv under Electron's `userData` dir (`<userData>/.venv-whisper`) — no admin/sudo needed, avoids Debian/Ubuntu PEP 668 "externally-managed-environment" pip errors — and downloads model weights into `<userData>/.whisper-models` via `whisper.load_model(name, download_root=...)`.
- Command resolution at runtime: `speech.service.js: _resolveWhisperCommand()` probes, in order: the configured `WHISPER_COMMAND`, the app's own `userData` venv, then system-PATH fallbacks (`whisper`, `whisper.exe`, `py -3 -m whisper`, `python3 -m whisper`, `python -m whisper`). A fast `importlib.util.find_spec` probe avoids the slow first `import whisper` (torch/numba) hit before falling back to a full `--help` spawn.
- Invocation per utterance: `_transcribeWhisperFile()` spawns `<command> <baseArgs> <wavPath> --model <model> --language <lang> --task transcribe --output_format txt --output_dir <tmp> --model_dir <modelDir> --verbose False --fp16 False`, then reads the resulting `.txt` file.
- Voice-activity detection (`_ingestWhisperAudio()` and friends) decides when to flush a segment to Whisper — segments are cut on natural pauses (`silenceHangoverMs`, default 700ms) rather than a fixed timer, with pre-roll padding, a max-utterance cap (15s), and a hallucination filter (`_isHallucinatedTranscript()`) that drops known Whisper silence artifacts ("thank you for watching", "please subscribe", etc.).
- `npm run test-speech` → `scripts/test-speech.js` — loads `.env`, prints `speechService.getStatus()`/`isAvailable()`, and runs `speechService.testConnection()` (for Whisper: `spawnSync <command> --help`).
- Audio capture path differs by OS: Windows and macOS capture mic audio in the **renderer** via the Web Audio API (`getUserMedia`) and stream raw 16kHz PCM chunks to the main process over the `audio-chunk` IPC channel (`preload.js: sendAudioChunk` → `main.js` → `speechService.handleAudioChunkFromRenderer()`); Linux uses the native `node-record-lpcm16` (`arecord` then `sox`) path directly in the main process. This split avoids requiring a Homebrew `sox` install on macOS and works around Windows lacking Unix audio CLIs.
- `ffmpeg` is recommended (Debian package `recommends`, installer checks for it) but not required by the app itself, since audio is always pre-packaged as WAV before being handed to Whisper (`_createWavBuffer()`).

**Native microphone capture — `node-record-lpcm16` (`^1.0.1`):**
- Spawns `sox` (macOS) or `arecord`/`sox` (Linux) as child processes to stream raw PCM audio (`src/services/speech.service.js: _startMicrophoneCapture()` / `_startMicrophoneCaptureWithFallback()`). Pre-checks binary existence with `which`/`where` before spawning (a missing binary would otherwise emit an unhandled `error` event on the recorder's child process and crash the whole Electron app — guarded explicitly here and in `main.js`'s global `uncaughtException` handler).
- Used by both speech providers on Linux; used by Azure on all platforms (Azure has no renderer-capture path).

## Data Storage

**Databases:**
- None. No SQL/NoSQL client or ORM anywhere in dependencies.

**Session / conversation memory:**
- Entirely in-process JavaScript (`src/managers/session.manager.js`) — not persisted to disk or any external store. Lost on app restart (unless `session.clearOnRestart` config were changed; it does not currently write to disk either way). Capped by `session.maxMemorySize` / `compressionThreshold` (`src/core/config.js`).

**File Storage:**
- Local filesystem only:
  - `.env` — app config/secrets (Electron `userData` dir in packaged builds, project root in dev).
  - `~/.OpenCluely/logs/*.log` — Winston daily-rotating logs (`src/core/logger.js`).
  - `<userData>/.venv-whisper/`, `<userData>/.whisper-models/` (or `.venv-whisper/`, `.whisper-models/` in dev) — local Whisper venv + downloaded model weights.
  - OS temp dir (`os.tmpdir()`) — transient WAV segments per Whisper utterance and transcript output dirs, both cleaned up immediately after use (`_transcribeWhisperBuffer()`, `_removeTempDir()`).

**Caching:**
- None (no Redis/Memcached/etc.).

## Authentication & Identity

**Auth Provider:**
- None — no user accounts, no OAuth/OIDC provider, no third-party auth SDK (Auth0/Firebase/Clerk/etc.). The app is single-user/local-only.

**API-key handling (the only "auth" in this app):**
- `GEMINI_API_KEY` (required for AI features) and, optionally, `AZURE_SPEECH_KEY` + `AZURE_SPEECH_REGION` are the only secrets.
- Entry points: `env.example` → `.env` (via `setup.sh` prompt/manual edit), or the Settings/onboarding UI → IPC `set-gemini-api-key` / `save-settings` → `LLMService.updateApiKey()` (re-instantiates the `GoogleGenAI` client immediately, no restart needed) and `SpeechService.initializeClient()` for speech-provider changes.
- Storage: plaintext, single `.env` file, `0600` permissions on creation (`FirstRunManager.ensureEnv()` in `src/core/first-run.js`). Excluded from git (`.gitignore`) and from packaged builds (`package.json` → `build.files: ["!.env*"]`).
- The Settings UI reads keys back in plaintext for display/editing (`main.js: getSettings()` returns `process.env.GEMINI_API_KEY` etc. directly) — acceptable given the single-user, fully-local threat model, but worth knowing if this pattern is ever extended to a multi-user context.
- No token refresh/expiry logic anywhere — API keys are used as static bearer credentials.

## Monitoring & Observability

**Error Tracking:**
- None. No Sentry/Bugsnag/Rollbar or similar SaaS. Uncaught exceptions/rejections are caught by a global handler in `main.js` (kept alive, logged) and by Winston's `exceptionHandlers`/`rejectionHandlers` (`src/core/logger.js`), which just write to `~/.OpenCluely/logs/exceptions.log` / `rejections.log` locally.

**Logs:**
- `winston` + `winston-daily-rotate-file`, console (colorized) + rotating files (`application-%DATE%.log` 14-day retention, `error-%DATE%.log` 30-day retention). No remote log shipping/aggregation of any kind — 100% local.

## CI/CD & Deployment

**Hosting:**
- Not applicable — OpenCluely is a distributed desktop app (Windows/Linux installers via GitHub Releases; macOS built from source), not a hosted service. The marketing site (`webapp/`) is referenced as living at `opencluely.techycsr.dev`, but no deployment config (Netlify/Vercel/etc.) exists in this repo — its deploy pipeline is external/undocumented here.

**CI Pipeline:**
- GitHub Actions — `.github/workflows/release.yml`. Triggers on `v*` tags or manual dispatch; builds on `ubuntu-latest` and `windows-latest` (Node 20); on a tag push, also creates a GitHub Release with generated changelog, uploaded artifacts, and SHA-256 checksums. No separate lint/test CI job exists (there is no automated test suite to run).

## Environment Configuration

**Required env vars:**
- `GEMINI_API_KEY` — the only strictly required secret for AI features to work.

**Optional env vars:**
- `SPEECH_PROVIDER`, `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`, `WHISPER_COMMAND`, `WHISPER_MODEL_DIR`, `WHISPER_MODEL`, `WHISPER_LANGUAGE`, `WHISPER_SEGMENT_MS`, plus undocumented advanced Whisper VAD tuning vars (`WHISPER_VAD_ENABLED`, `WHISPER_SILENCE_HANGOVER_MS`, `WHISPER_MIN_UTTERANCE_MS`, `WHISPER_MAX_UTTERANCE_MS`, `WHISPER_PRE_ROLL_MS`, `WHISPER_VAD_ENERGY_FLOOR`) — see `STACK.md` for the full table.

**Secrets location:**
- Single `.env` file (see Auth section above). No secrets manager, no cloud KMS, no CI secrets consumed at runtime (CI only signs nothing — code signing is explicitly disabled via `CSC_IDENTITY_AUTO_DISCOVERY: false`).

## Webhooks & Callbacks

**Incoming:**
- None — the app runs no HTTP server and exposes no public endpoint.

**Outgoing:**
- None beyond the direct, synchronous API calls documented above (no fire-and-forget webhook/notification integrations, e.g. no Slack/Discord webhook, no analytics beacon).

## Network Endpoint Summary (all outbound; app has no inbound listener)

| Endpoint | Purpose | Trigger |
|---|---|---|
| `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` | Gemini non-streaming inference (manual HTTPS path, tried first by default) | any text/image LLM request |
| `https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse` | Gemini streaming inference (SSE) | chat/overlay streamed responses |
| `https://generativelanguage.googleapis.com` (SDK-internal host) | Gemini inference via `@google/genai` SDK | fallback method when manual HTTPS fails |
| Azure regional STT endpoint (host resolved internally by `microsoft-cognitiveservices-speech-sdk` from `AZURE_SPEECH_REGION`) | Cloud speech-to-text | only when `SPEECH_PROVIDER=azure` |
| `google.com:443`, `generativelanguage.googleapis.com:443` | Raw TCP connectivity probes only (no HTTP payload) | `checkNetworkConnectivity()` diagnostics |
| `https://api.github.com/repos/TechyCSR/OpenCluely[...]` | Repo/release metadata for the landing page | `webapp/script.js` only — never from the desktop app |
| `https://github.com/TechyCSR/OpenCluely` | Opened in the system default browser | onboarding "star on GitHub" button (`shell.openExternal` via IPC `open-external`) |
| `https://aistudio.google.com/` | Opened in the system default browser | "get a Gemini API key" links in onboarding/settings |

---

*Integration audit: 2026-07-13*
