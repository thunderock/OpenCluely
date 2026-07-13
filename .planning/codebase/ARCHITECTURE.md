# Architecture

**Analysis Date:** 2026-07-13

## Pattern Overview

**Overall:** Multi-window Electron desktop app with a single main-process "god object" controller (`ApplicationController` in `main.js`) that owns app lifecycle and delegates to a handful of CommonJS singleton managers/services. Renderers are plain HTML + vanilla inline `<script>` — no framework, no bundler, no state library. The only legal crossing point between renderer and main is `preload.js`'s `contextBridge`.

**Key Characteristics:**
- Five `BrowserWindow`s (`main`, `chat`, `llmResponse`, `settings`, `onboarding`) share one Node/Electron main process; there is no separate backend server — Gemini/Whisper/Azure network calls happen directly from the main process (`src/services/`).
- Every window is frameless, transparent, always-on-top, `skipTaskbar: true`, and (macOS/Windows only) `setContentProtection(true)`-protected — the whole app is a "stealth overlay" that disguises its process name/dock icon as "Terminal" (or "Activity Monitor" / "System Settings") via `app.setName()` and `process.title` (`main.js` `setupStealth()`, `updateAppName()`).
- Renderers run with `nodeIntegration: false`, `contextIsolation: true` (`src/managers/window.manager.js` `createWindow()`); all main-process access goes through `window.electronAPI` / `window.api` exposed by `preload.js`.
- Business logic lives in CommonJS modules under `src/services/` and `src/managers/`, each written as `module.exports = new ClassName()` — process-wide singletons via Node's module cache, not a DI container.
- No client-side router or state store. Each HTML file is a self-contained script block that queries `electronAPI` on load and reacts to pushed IPC events; state that must survive across windows lives in the main process (`sessionManager`, `windowManager`, `ApplicationController` fields).
- Token-level streaming exists end-to-end inside `llm.service.js` (Gemini SSE) and is broadcast over IPC (`transcription-llm-response-start` / `-chunk`), but **no active renderer currently consumes the `-chunk` event** — the only listener for it lives in `src/ui/chat-window.js`, which is dead code (never referenced by a `<script>` tag). In the shipped build, `chat.html` and `llm-response.html` only render the *final*, fully-accumulated response. See "Message streaming envelope" below.

## Layers

**Main process / orchestrator:**
- Purpose: app lifecycle, global shortcuts, all IPC routing, stealth setup, settings/`.env` persistence, coalescing rapid speech fragments into one LLM call.
- Location: `main.js` (`ApplicationController` class, ~1890 lines; single instance created at the bottom of the file behind `app.requestSingleInstanceLock()`)
- Contains: `setupIPCHandlers()` (~60 `ipcMain.handle`/`ipcMain.on` channels), `triggerScreenshotOCR()`, `processWithLLM()`, `processTranscriptionWithLLM()`/`dispatchCoalescedUtterance()`, `getSettings()`/`saveSettings()`/`persistEnvUpdates()`, stealth helpers (`updateAppIcon`, `updateAppName`).
- Depends on: `src/managers/window.manager.js`, `src/managers/session.manager.js`, `src/services/capture.service.js`, `src/services/speech.service.js`, `src/services/llm.service.js`, `src/core/*`, `prompt-loader.js`.
- Used by: nothing above it — this is the process entry point (`package.json` `"main": "main.js"`).

**Managers (`src/managers/`):**
- Purpose: own long-lived, cross-window state.
- `window.manager.js` (`WindowManager`, singleton): creates/positions/shows every `BrowserWindow`, enforces always-on-top + stealth (`applyStealthMeasures`, `setContentProtection`), "window binding" (keeps `main` + `llmResponse` visually locked as a column — `positionBoundWindows()`), multi-display/desktop tracking, `broadcastToAllWindows(channel, data)`.
- `session.manager.js` (`SessionManager`, singleton): in-memory conversation/event log that is both the LLM's context window (`getConversationHistory()`, `getSkillContext()`, `getOptimizedHistory()`) and an audit trail; seeds itself with the active skill's system prompt on construction via `prompt-loader.js`.
- Depends on: `src/core/config.js`, `src/core/logger.js`; `session.manager.js` also depends on `prompt-loader.js`.
- Used by: `main.js`; `llm.service.js` also reaches back into `session.manager` (via `require('../managers/session.manager')`) to pull conversation history when building a Gemini request.

**Services (`src/services/`):**
- Purpose: integration with external systems (screen, microphone, Gemini).
- `capture.service.js` (122 lines): wraps Electron `desktopCapturer`/`screen` to grab a screenshot (`captureAndProcess()` → PNG `Buffer`), optional crop by `{x,y,width,height}`, `listDisplays()`. Only the "capture primary/current display" path is wired to any UI; `listDisplays`/area-crop are implemented but not called from any renderer today.
- `speech.service.js` (1847 lines, largest service): dual-provider speech-to-text. Azure Cognitive Services SDK (continuous recognition, native mic via `node-record-lpcm16` spawning `sox`/`arecord`) **or** a local Whisper CLI (spawned per utterance; VAD-based segmentation; synthesizes its own WAV header; filters known Whisper silence-hallucination phrases). Also accepts renderer-captured PCM16 on Windows/macOS via `handleAudioChunkFromRenderer()`. `EventEmitter`-based (`transcription`, `interim-transcription`, `status`, `error`, `recording-started`/`-stopped`), consumed only by `main.js`.
- `llm.service.js` (1655 lines): Google Gemini (`@google/genai`) wrapper. Builds requests with/without conversation history, model-fallback + exponential-backoff retry ladder (`config.get('llm.gemini.fallbackModels')`), non-streaming path (SDK `executeRequest`, with a raw-HTTPS `executeAlternativeRequest` fallback) and a streaming path (`executeStreamingRequest`, hand-rolled HTTPS SSE parser against `generativelanguage.googleapis.com`), plus canned heuristic fallback responses (`generateFallbackResponse`/`generateIntelligentFallbackResponse`) when the API is unreachable.
- `fallback-capture.service.js`: **0 bytes** — an empty file. Nothing `require()`s it; it is not part of any runtime path.
- Depends on: `src/core/config.js`, `src/core/logger.js`; `llm.service.js` also depends on `prompt-loader.js` and (indirectly) `session.manager.js`.
- Used by: `main.js` exclusively — no renderer/UI file requires a service directly.

**Core (`src/core/`):**
- Purpose: cross-cutting infrastructure, no app-specific business logic.
- `config.js` (128 lines): one in-memory config object (Gemini model + fallbacks, window default sizes, Whisper VAD tuning, stealth flags) read via a dotted-path `get('a.b.c')`.
- `logger.js` (93 lines): single Winston logger; `createServiceLogger('NAME')` is what every module actually imports as `logger`.
- `first-run.js` (165 lines, `FirstRunManager`): decides whether onboarding is needed (missing/placeholder `GEMINI_API_KEY`), bootstraps `.env` from `env.example`, writes a `.opencluely-firstrun-completed` sentinel so the wizard doesn't nag again.
- `whisper-installer.js` (626 lines): detects an existing Whisper CLI or installs one into a per-app Python venv (`.venv-whisper` under Electron `userData`), downloads model weights, streams install progress lines to the onboarding UI.
- Used by: `main.js` and every manager/service.

**Renderer / UI layer (root `*.html` + `src/ui/*.js` + `onboarding.js`):**
- Purpose: presentation only; zero Node access except through `window.electronAPI` / `window.api`.
- Each HTML file either has its behavior inline (`chat.html`, `llm-response.html`, `onboarding.html` + `onboarding.js`) or in a same-purpose file under `src/ui/` (`index.html` ↔ `src/ui/main-window.js`, `settings.html` ↔ `src/ui/settings-window.js`). `src/ui/chat-window.js` is the exception: it exists but is **not loaded by `chat.html`** and is dead code.
- Depends on: `preload.js` bridge, `lib/markdown.js` (bundled markdown fallback), `lib/mathrender.js` (shared LaTeX→HTML renderer), `assests/vendor/fontawesome`.
- Used by: the end user directly — these are the app's only visible surfaces.

**IPC bridge (`preload.js`, 160 lines):**
- Purpose: the sole legal crossing point between renderer and main; runs with Node access in an isolated context and exposes two globals via `contextBridge.exposeInMainWorld`.
- `window.electronAPI`: ~50 wrapped `ipcRenderer.invoke`/`.on` calls — screenshot, speech, window management, session/settings, first-run/onboarding, Whisper install, LLM window sizing, clipboard. Used by `index.html`/`src/ui/main-window.js`, `chat.html`, `llm-response.html`, `settings.html`/`src/ui/settings-window.js`, `onboarding.html`/`onboarding.js`.
- `window.api`: a second, smaller bridge with an explicit channel allowlist (`send`: `close-settings`, `quit-app`, `save-settings`, `toggle-recording`, `toggle-interaction-mode`, `update-skill`, `window-loaded`; `receive`: `load-settings`, `recording-state-changed`, `interaction-mode-changed`, `skill-updated`, `update-skill`, `recording-started`, `recording-stopped`). Used only by `settings.html` / `src/ui/settings-window.js` and referenced in `src/ui/main-window.js` for `skill-updated`.

## Data Flow

**Screenshot → AI response:**

1. User presses `Cmd/Ctrl+Shift+S` (global shortcut, `main.js` `setupGlobalShortcuts()`) or clicks the camera icon in the overlay (`src/ui/main-window.js:287`, `window.electronAPI.takeScreenshot()`). Both paths hit `ipcMain.handle("take-screenshot")` → `ApplicationController.triggerScreenshotOCR()`.
2. `windowManager.showLLMLoading()` sends `show-loading` to the `llmResponse` window; `llm-response.html` shows its "Analyzing…" state.
3. `captureService.captureAndProcess()` (`src/services/capture.service.js`) grabs the current display via `desktopCapturer.getSources()` and returns a PNG `Buffer`.
4. `llmService.processImageWithSkillStream(imageBuffer, mimeType, activeSkill, sessionHistory.recent, codingLanguage, onDelta)` (`src/services/llm.service.js`) sends the image as Gemini `inlineData` alongside the active skill's system prompt (from `prompt-loader.js`) and streams the answer over raw HTTPS SSE (`_streamRequestForModel`), invoking `onDelta` per chunk.
5. Each `onDelta` broadcasts `transcription-llm-response-chunk {messageId, delta}` to all windows — currently unconsumed by any live renderer (see Pattern Overview).
6. On completion: `sessionManager.addModelResponse(...)`, then `broadcastTranscriptionLLMResponse()` sends the **full** `transcription-llm-response` event (consumed by `chat.html`), and `windowManager.showLLMResponse(response, metadata)` sends the **full** `display-llm-response` event (consumed by `llm-response.html`, which then calls `electronAPI.resizeLlmWindowForContent()` to size itself to the content).

**Voice → AI response:**

1. User presses `Alt+R` or clicks the mic icon → `speechService.startRecording()`.
2. Audio capture is platform-gated inside `speech.service.js`: Linux spawns a native `arecord`/`sox` child process from the main process; Windows/macOS set `useRendererCapture = true` instead (no bundled recorder), and wait for the renderer.
3. On Windows/macOS, `src/ui/main-window.js` (`_startRendererAudioCapture()`, lines ~679-730) opens `getUserMedia` → `AudioContext` → `createScriptProcessor`, converts Float32 samples to 16 kHz mono PCM16, and streams buffers via `window.electronAPI.sendAudioChunk(buffer)` → `ipcRenderer.send('audio-chunk', ...)` → `ipcMain.on("audio-chunk")` → `speechService.handleAudioChunkFromRenderer()`.
4. `speech.service.js` runs a VAD state machine (`_ingestWhisperAudio`) that accumulates audio while RMS energy is above an adaptive noise floor and flushes an utterance once trailing silence exceeds `silenceHangoverMs` (or `maxUtteranceMs` is hit — hard cap). A flushed segment is WAV-wrapped (`_createWavBuffer`) and transcribed either by the Azure `SpeechRecognizer` (continuous, event-driven: `recognizing`/`recognized`/`canceled`) or by spawning the local Whisper CLI (`_transcribeWhisperFile`), with `_isHallucinatedTranscript()` dropping known Whisper silence artifacts ("thank you for watching", "please subscribe", etc.).
5. `speechService` emits `transcription` → `main.js` `handleTranscriptionFragment()` immediately broadcasts `transcription-received` (so `chat.html` shows the live captured line) and appends the fragment to `_utteranceBuffer`, debounced 800 ms (`_utteranceCoalesceMs`) via `dispatchCoalescedUtterance()` — this coalesces several VAD fragments from one spoken thought into a single LLM call instead of one slow call per pause.
6. Once the debounce fires, `processTranscriptionWithLLM()` calls `llmService.processTranscriptionWithIntelligentResponseStream()`, which uses a distinct "intelligent filter" system prompt (`getIntelligentTranscriptionPrompt()` in `llm.service.js`) deciding whether the utterance is an on-topic question (full detailed answer) or small talk (short acknowledgment like "Yeah, I'm listening. Ask your question relevant to dsa.").
7. Same start/chunk/final broadcast pattern as the screenshot flow; the final response reaches both `chat.html` (`transcription-llm-response`) and the `llmResponse` overlay (`display-llm-response`).

**Typed chat → AI response:**

1. User types in `chat.html` and presses Enter/Send → `whysperAPI.sendChatMessage(text)` (`whysperAPI` is just `window.electronAPI`, aliased inside `chat.html`) → `ipcMain.handle("send-chat-message")` → `sessionManager.addUserInput(text, 'chat')`, then fire-and-forget `ApplicationController.processWithLLM(text, sessionHistory)`.
2. `processWithLLM()` uses the **full** skill system prompt + conversation history (`llmService.processTextWithSkillStream`) — unlike the voice path's "intelligent filter" prompt, typed input is assumed to be a deliberate question.
3. Same broadcast/render pattern as the screenshot flow.

**State Management:**
- No client-side state library; each HTML file keeps its own module-scoped variables inside its inline `<script>` block.
- Cross-window "source of truth" lives in the main process: `sessionManager` (conversation history fed to every LLM call), `windowManager` (positions/visibility/interactivity/binding), and `ApplicationController` instance fields (`activeSkill`, `codingLanguage`, `speechAvailable`, utterance-coalescing buffers).
- `chat.html` additionally keeps its own `localStorage`-backed transcript (key `opencluely_chat_history_v1`) purely so the chat panel survives being hidden/reloaded — this is separate from, and never synced with, `sessionManager`'s in-memory history.
- Settings are persisted to a `.env` file: `main.js` `persistEnvUpdates()` upserts keys atomically (temp file + rename) and `resolveEnvPath()` picks Electron's `userData` directory in packaged builds (stable, writable) or a project-root `.env` in dev (`npm start`). `dotenv` loads this file once at startup (`main.js` top).

## Key Abstractions

**`ApplicationController` (main.js):**
- Purpose: the single stateful orchestrator for the main process — holds `activeSkill`, `codingLanguage`, `speechAvailable`, the utterance-coalescing buffer/timer, and the `FirstRunManager`.
- Examples: `main.js` (one instance, constructed at the bottom of the file, gated by `app.requestSingleInstanceLock()`).
- Pattern: not a DI-managed service — it directly `require()`s the singleton managers/services it needs at module load time.

**Singleton manager/service modules:**
- Purpose: `window.manager.js`, `session.manager.js`, `capture.service.js`, `speech.service.js`, `llm.service.js` each export `new ClassName()` — one instance per process, shared by reference wherever `require()`d.
- Examples: `src/managers/window.manager.js:1828` (`module.exports = new WindowManager()`), `src/services/llm.service.js:1656`.
- Pattern: classic Node singleton-via-module-cache. There is no registry/container, so swapping an implementation for tests means mocking the module itself, not injecting a constructor argument.

**Skill prompts (`prompt-loader.js` + `prompts/*.md`):**
- Purpose: system-prompt-as-markdown-file abstraction read by both `session.manager.js` (seeds history / builds LLM context) and `llm.service.js` (system instruction for every request).
- Examples: `prompts/dsa.md` (27 lines), `prompts/programming.md` (51 lines), loaded by `PromptLoader.loadPrompts()` in `prompt-loader.js`.
- Pattern: only `dsa` is actually active — `PromptLoader.getAvailableSkills()` hardcodes `['dsa']` and `loadPrompts()` explicitly skips every `.md` file except `dsa.md` (so `programming.md` is never loaded), even though `normalizeSkillName()` still maps many other aliases (behavioral, sales, presentation, data-science, devops, system-design, negotiation) that have no corresponding prompt content. Programming-language injection (C++/C/Python/Java/JavaScript) is layered on top via `injectProgrammingLanguage()`.

**Message streaming envelope (`messageId`):**
- Purpose: ties together the three broadcast events of one AI response — `transcription-llm-response-start` → zero-or-more `-chunk` → final `transcription-llm-response` / `display-llm-response` — so a renderer *could* replace one bubble instead of duplicating it.
- Examples: `main.js` `triggerScreenshotOCR()`, `processWithLLM()`, `processTranscriptionWithLLM()` all mint an id via `` `${prefix}-${Date.now()}-${this._responseSeq}` `` (`img-`, `chat-`, `tr-` prefixes).
- Current state: only `src/ui/chat-window.js` (dead/unloaded code) reads the `-start`/`-chunk` events. The live renderers (`chat.html`, `llm-response.html`) only handle the final event, so responses currently appear all-at-once rather than token-by-token, despite the backend generating them incrementally.

**Window "binding" (`windowManager.bindWindows`):**
- Purpose: keeps the pill-shaped `main` overlay and the `llmResponse` panel visually locked together as a vertical column, moving/resizing as one unit.
- Examples: `src/managers/window.manager.js` (`setWindowBinding()`, `positionBoundWindows()`, `moveBoundWindows()`, `getWindowBindingStatus()`); wired to `CommandOrControl+Up/Down/Left/Right` in `main.js` `setupGlobalShortcuts()` (`handleUpArrow`/etc.).

## Entry Points

**`main.js` (process entry point, `package.json` `"main"`):**
- Location: `main.js`
- Triggers: `electron .` via `npm start` / `npm run dev`.
- Responsibilities: dotenv bootstrap (`resolveEnvPath()`), Linux GPU-crash workaround flags, stealth process-title setup, single-instance lock, constructs `ApplicationController`, which wires `app.whenReady`/global shortcuts/IPC and creates all windows through `windowManager.initializeWindows()`.

**`index.html` + `src/ui/main-window.js` (main overlay / "pill" window):**
- Location: `index.html` (markup/styles), `src/ui/main-window.js` (behavior, loaded via `<script src="./src/ui/main-window.js">`)
- Triggers: created by `windowManager.createMainWindow()` at startup; always visible, always-on-top, frameless command bar.
- Responsibilities: screenshot button, mic button (+ renderer-side audio capture on Windows/macOS), skill indicator, coding-language `<select>`, shortcuts popover; the app's primary always-present surface.

**`chat.html` (inline script — no separate JS file):**
- Location: `chat.html`
- Triggers: `Cmd/Ctrl+Shift+C`, or automatically via `windowManager.showChatWindow()` when recording starts.
- Responsibilities: full conversation UI (text input + mic toggle); renders `transcription-received` (live captions) and `transcription-llm-response` (final AI answers) with markdown/code/LaTeX rendering; persists its own transcript to `localStorage`.

**`llm-response.html` (inline script):**
- Location: `llm-response.html`
- Triggers: shown via `windowManager.showLLMLoading()` / `showLLMResponse()` whenever a screenshot, chat message, or voice question produces an answer.
- Responsibilities: renders the final AI answer in a split text/code layout (or single full-content layout when there's no code), self-resizes via `electronAPI.resizeLlmWindowForContent()`, copy-to-clipboard on code blocks.

**`settings.html` + `src/ui/settings-window.js`:**
- Location: `settings.html`, `src/ui/settings-window.js`
- Triggers: `Cmd/Ctrl+,` shortcut or `windowManager.showSettings()`.
- Responsibilities: speech provider (Whisper/Azure) + credentials, Gemini key, default skill/coding language, stealth icon picker; saves via `window.electronAPI.saveSettings()` and the legacy `window.api.send('save-settings'|'close-settings'|'quit-app')` channel.

**`onboarding.html` + `onboarding.js`:**
- Location: `onboarding.html`, `onboarding.js`
- Triggers: first launch only, when `FirstRunManager.getStatus().needsOnboarding` is true (no/placeholder Gemini key); opened ~800 ms after the other windows finish loading so it appears on top.
- Responsibilities: 5-step wizard — welcome → Gemini key entry + live connection test → speech provider choice (Whisper/Azure/skip) → Whisper detect/install (only if Whisper chosen) → GitHub-star + finish; calls `electronAPI.completeFirstRun()` to reveal the main overlay.

## Error Handling

**Strategy:** defensive, log-and-continue. Almost nothing in the main process is allowed to crash the app; failures are logged through the shared Winston logger and surfaced to the UI as a status/error IPC event or a canned fallback response rather than an unhandled exception.

**Patterns:**
- Process-level guard: `main.js` installs `process.on('uncaughtException'|'unhandledRejection', ...)` specifically because child-process recorders (Whisper CLI, `sox`/`arecord`) can emit an unlistened `error` event on their child process that would otherwise take down the whole app the moment a user clicks the mic without the binary installed.
- Service-level fallback ladder: `llm.service.js` tries the primary Gemini model, then each entry in `config.get('llm.gemini.fallbackModels')`, retrying with exponential backoff + jitter; if the SDK method fails it tries `executeAlternativeRequest` (raw HTTPS), and if everything fails it falls back to a canned `generateFallbackResponse()` / `generateIntelligentFallbackResponse()` so the UI always gets *something*.
- Speech provider probing never throws on a missing binary: `speech.service.js` tries multiple Whisper command candidates (`_resolveWhisperCommand()` → venv python, system PATH, `python3 -m whisper`, etc.) and multiple recorder programs (`sox`/`arecord`), emitting a descriptive `status`/`error` event instead — the mic button simply hides (`speechAvailable: false`) rather than the app crashing.
- IPC handlers wrap risky calls in `try/catch` and return `{ success: false, error }`-shaped objects across the bridge rather than throwing (e.g. `updateAppIcon()`, `saveSettings()`, `close-window`).

## Cross-Cutting Concerns

**Logging:** `src/core/logger.js` — one Winston instance; `createServiceLogger('NAME')` is what every module imports as `logger` (tags: `MAIN`, `WINDOW`, `SESSION`, `CAPTURE`, `SPEECH`, `LLM`, `PERFORMANCE`, ...). Writes to console (colorized) plus daily-rotating files under `~/.OpenCluely/logs/` (`application-*.log` info+, `error-*.log` error-only, `exceptions.log`, `rejections.log`).

**Validation:** minimal/ad-hoc — inline `typeof`/truthiness checks at IPC boundaries rather than a schema library (e.g. `open-external` regex-validates the URL scheme before `shell.openExternal`; `processTranscriptionWithLLM` rejects empty/very-short text before calling the LLM).

**Authentication:** not applicable within the app (single local user, no accounts). The closest analogue is API-key configuration — `GEMINI_API_KEY`, `AZURE_SPEECH_KEY`/`AZURE_SPEECH_REGION` — stored in `.env` and read via `src/core/config.js#getApiKey()` / `process.env` directly.

---

*Architecture analysis: 2026-07-13*
