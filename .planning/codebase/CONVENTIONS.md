# Coding Conventions

**Analysis Date:** 2026-07-13

## Module System

**CommonJS everywhere.** `package.json` has no `"type": "module"`, and there is no ESM `import`/`export` syntax anywhere in the repo — every main-process file uses `require(...)` / `module.exports`. Renderer/browser code has no module system at all: it's loaded via classic `<script src="...">` tags (never `type="module"`) or inlined directly in HTML, and cross-file sharing happens by attaching to `window` (e.g. `window.electronAPI`, `window.markdown`, `window.renderMathInElement`, `window.mainWindowUI`). Do not introduce `import`/`export` or a bundler-style module graph — it doesn't fit the rest of the codebase.

**Singleton-module pattern:** almost every module under `src/` does `module.exports = new XService()` / `new XManager()` — one instance shared by every `require()` call. Examples: `src/core/config.js`, `src/core/logger.js`, `src/services/capture.service.js`, `src/services/llm.service.js`, `src/services/speech.service.js`, `src/managers/window.manager.js`, `src/managers/session.manager.js`, `prompt-loader.js` (exports both the class and a `promptLoader` singleton). The two exceptions are `src/core/first-run.js` (`FirstRunManager`) and `src/core/whisper-installer.js` (`WhisperInstaller`), which export the **class** because `main.js` constructs them itself with per-instance options (logger, paths, injected `runExec`). Follow the singleton pattern for anything that represents "the one X for this running app" (a service, a manager); export a class instead only when the caller needs to control construction/config or multiple independent instances could exist.

## Naming Patterns

**Files:**
- `src/services/*.service.js`, `src/managers/*.manager.js` — kebab-case name + role suffix.
- `src/core/*.js` — plain kebab-case nouns, no suffix (`config.js`, `logger.js`, `first-run.js`, `whisper-installer.js`).
- `src/ui/*-window.js` — kebab-case matching the HTML window it drives (`main-window.js`, `chat-window.js`, `settings-window.js`). Note `src/ui/chat-window.js` is **not actually loaded by `chat.html`** — `chat.html` inlines its own script instead. Treat `chat-window.js` as dead/legacy code, not the live chat implementation, until proven otherwise by checking `chat.html`'s `<script>` tags.
- Top-level windows are plain HTML files at the project root: `index.html`, `chat.html`, `llm-response.html`, `settings.html`, `onboarding.html`.

**Classes:** PascalCase — `ApplicationController` (`main.js`), `WindowManager`, `SessionManager`, `CaptureService`, `LLMService`, `SpeechService`, `WhisperInstaller`, `FirstRunManager`, `MainWindowUI`.

**Functions/variables:** camelCase throughout, both main process and renderer.

**Private/internal methods:** single leading underscore by convention (not enforced by the language) — e.g. `_cleanup()`, `_resetVadState()`, `_getSetting()`, `_probeWhisperCandidate()` in `src/services/speech.service.js`; `_isValidArea()`, `_getTargetDisplay()` in `src/services/capture.service.js`; `_friendlyTestError()` in `src/services/llm.service.js`. Public API methods have no prefix. Follow this when adding helper methods that aren't part of a class's public contract.

**IPC channel strings:** kebab-case, verb-first: `"take-screenshot"`, `"start-speech-recognition"`, `"get-session-history"`, `"save-settings"`, `"clear-session-memory"`. Events pushed from main → renderer read as status/noun-past-tense: `"recording-started"`, `"speech-status"`, `"transcription-llm-response-chunk"`. See IPC Conventions below.

## IPC Conventions

All IPC handlers are registered in one place: `ApplicationController.setupIPCHandlers()` in `main.js` (roughly lines 408-895). Two bridges are exposed from `preload.js` via `contextBridge.exposeInMainWorld`:

- **`window.electronAPI`** — the primary, actively-extended surface. Every method is a thin camelCase wrapper around one `ipcRenderer.invoke(channel, ...)` (request/response) or `ipcRenderer.on(channel, cb)` (event subscription) call, named after the kebab-case channel (e.g. channel `"start-speech-recognition"` → `electronAPI.startSpeechRecognition()`). Use `ipcMain.handle` + `invoke` for anything that returns a value; use `ipcMain.on` + `send` for fire-and-forget (e.g. `"audio-chunk"`, `"chat-window-ready"`).
- **`window.api`** — an older, narrower bridge with an explicit channel allowlist (`validChannels` arrays inside `preload.js`) for generic `send`/`receive`. Only `src/ui/settings-window.js` and `src/ui/main-window.js` still use it, for a handful of legacy channels (`close-settings`, `quit-app`, `save-settings`, `update-skill`, `skill-updated`, ...). Prefer `electronAPI` for new work; `api` is not being extended.

**Adding a new IPC-backed feature:** (1) add `ipcMain.handle('x-y', async (event, ...) => {...})` in `main.js`'s `setupIPCHandlers()`; (2) add a matching line to `electronAPI` in `preload.js` (`x: (...) => ipcRenderer.invoke('x-y', ...)`); (3) call `window.electronAPI.x(...)` from the renderer. Handler bodies should be wrapped in try/catch and return `{ success: false, error: error.message }` on failure instead of throwing — see Error Handling.

## Configuration & Settings Persistence

There are **three separate, non-overlapping persistence mechanisms** — know which one you're touching:

1. **Static in-memory defaults** — `src/core/config.js` (`ConfigManager` singleton). A hardcoded JS object built once in `loadConfiguration()`, read via a dot-path getter: `config.get('llm.gemini.model')`, `config.get('speech.whisper.segmentMs')`. `config.set()` only mutates the singleton for the current process; nothing here is ever written to disk.
2. **`.env` file** — the only user settings that survive a restart: `GEMINI_API_KEY`, `SPEECH_PROVIDER`, `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`, `WHISPER_COMMAND`, `WHISPER_MODEL`, `WHISPER_LANGUAGE`, `WHISPER_SEGMENT_MS`. Path resolution lives in `resolveEnvPath()` in `main.js`: a project-root `.env` is used only if it already exists and no userData `.env` does (dev workflow); otherwise it's `app.getPath('userData')/.env` (stable across packaged-build install dirs). Writes go through `ApplicationController.persistEnvUpdates()` in `main.js` (~line 1659): read the existing file, replace matching `KEY=` lines in place, append genuinely new keys, then atomic write via a `.tmp` file + `fs.renameSync`. To persist a new setting: add it to the `envUpdates` object built in `saveSettings()` and to the value returned by `getSettings()` (both in `main.js`).
3. **In-memory only, lost on restart** — `activeSkill`, `codingLanguage`, `appIcon`/`selectedIcon`, `windowGap` live only on the `ApplicationController` instance / `windowManager` and are pushed to open windows via `windowManager.broadcastToAllWindows(...)`, but are **never** written to `.env`. Don't assume these survive a relaunch — if a setting needs to persist, it must be added to the `.env` path in `main.js`, following the pattern used for the speech/API-key fields.
4. **Renderer `localStorage`** — used only in `chat.html`, only for the chat transcript (`CHAT_HISTORY_KEY = 'opencluely_chat_history_v1'`, capped to the last 500 entries by `saveHistory()`/`loadHistory()`). No other window uses `localStorage`.

Separately, `FirstRunManager` (`src/core/first-run.js`) tracks onboarding completion via its own sentinel file (`.opencluely-firstrun-completed` in userData), independent of `.env` contents — `needsOnboarding()` is based on both the sentinel and whether `GEMINI_API_KEY` is set/placeholder.

## Code Style

**Formatting:** no formatter is configured — no `.prettierrc*`, no `.editorconfig`. Indentation and quote style are consistent *within* a layer but differ *across* layers; match whichever file/layer you're editing rather than imposing one style repo-wide:

- **Indentation:** main-process code (`main.js`, and everything under `src/core/`, `src/managers/`, `src/services/`, plus `prompt-loader.js`) uses **2-space** indentation. Renderer UI controllers (`src/ui/*.js`, `onboarding.js`) use **4-space** indentation.
- **Quotes:** most of `src/**` and `preload.js` use single quotes for strings/`require(...)`. `main.js` predominantly uses double quotes. Inline `<script>` blocks inside HTML files (`chat.html`, `llm-response.html`) mix both depending on the line.
- **Semicolons:** used consistently everywhere (no ASI-reliant style).

**Linting:** none configured — no `.eslintrc*`, `eslint.config.*`, or `biome.json` in the repo, and no lint step in CI (`.github/workflows/release.yml` only builds/packages). `onboarding.js` has a top-of-file `/* eslint-disable no-undef */` comment, which is a relic of some previous local lint setup rather than an active rule.

## Import Organization

**Order (informal, observed, not enforced):** in main-process files, `require()` calls are grouped as: (1) Node builtins (`path`, `fs`, `os`), (2) Electron (`electron` destructured members), (3) third-party packages, (4) local `./src/...` modules, roughly in the order they're first used — see the top of `main.js` for the clearest example (`path`/`fs` → `electron` → `dotenv` → `./src/core/logger` → `./src/core/config` → services → managers). Some `require()` calls are deliberately deferred *inside* a function body instead of hoisted to the top of the file — e.g. `require('electron').BrowserWindow` and `require('./prompt-loader')` inside individual IPC handlers in `main.js`, and `require('../managers/session.manager')` inside `llm.service.js` methods. This is intentional in a couple of cases (avoiding a require cycle between `llm.service.js` and `session.manager.js`, or only pulling in `electron` when a handler actually runs) — don't "clean up" these into top-of-file requires without checking for a cycle first.

**Path aliases:** none. All local requires are relative (`../core/logger`, `../../prompt-loader`). No `tsconfig.json`/`jsconfig.json` path mapping exists (there is no TypeScript in this project at all — pure JavaScript).

## Logging (winston)

A single winston instance is created once in `src/core/logger.js` (`Logger` class, singleton via `module.exports = new Logger()`). Transports: colorized `Console`, plus two `winston-daily-rotate-file` transports under `~/.OpenCluely/logs/` — `application-%DATE%.log` (level `info` and above, 14-day retention) and `error-%DATE%.log` (level `error` only, 30-day retention) — plus file-based `exceptionHandlers`/`rejectionHandlers` (`exceptions.log`, `rejections.log`).

**Never use the raw logger directly.** Every module gets its own tagged child logger:

```js
const logger = require('../core/logger').createServiceLogger('LLM');
```

Existing service tags (all-caps, one word): `MAIN`, `SESSION`, `WINDOW`, `CAPTURE`, `LLM`, `SPEECH`. Use the same `createServiceLogger('YOURTAG')` pattern for any new main-process module.

**Call shape:** always `logger.<level>(humanReadableMessage, metadataObject)` — never string-interpolate variable data into the message; put it in the second argument:

```js
logger.error('LLM processing failed', { error: error.message, activeSkill, requestId: this.requestCount });
```

`logger.debug/info/warn/error` all take `(message, meta = {})`. Service loggers also expose `logger.logPerformance(operation, startTime, metadata)` for timing spans (used after LLM calls and screenshot capture). When logging a caught error, log `{ error: error.message }` (and often `error.stack`) — never pass the raw `Error` object as the message argument.

**Renderer code cannot use winston** (`contextIsolation: true`, `nodeIntegration: false` on every window — see `src/core/config.js`'s `window.webPreferences`). Instead, each renderer controller defines its own tiny local shim with the same `{info, debug, warn, error}` shape, backed by `console.*`, tagging metadata with `component` instead of winston's `service`:

```js
const logger = {
    info: (...args) => console.log('[MainWindowUI]', ...args),
    debug: (...args) => console.log('[MainWindowUI DEBUG]', ...args),
    error: (...args) => console.error('[MainWindowUI ERROR]', ...args),
    warn: (...args) => console.warn('[MainWindowUI WARN]', ...args)
};
```

(see the top of `src/ui/main-window.js`). Follow this shim shape in any new renderer file instead of calling `console.log` directly.

## UI Architecture (vanilla JS + partial Tailwind)

No frontend framework, no JSX, no bundler. Every top-level window is a standalone static HTML file at the project root, loaded via `BrowserWindow.loadFile()` from `src/managers/window.manager.js`. There is no shared HTML templating between windows.

**Styling:** predominantly hand-written CSS in a `<style>` block inside each HTML file, plus one shared stylesheet `src/styles/common.css` (imports Font Awesome; defines loosely-reused primitives like `.app-container`/`.app-header`). **Tailwind is configured but not really wired up**: `tailwind.config.js` and `src/input.css` (the three `@tailwind` directives) exist, and only `index.html` links a compiled `./dist/output.css` — but there is no npm script and no `tailwindcss`/`postcss` devDependency to actually build that file, and `dist/` is gitignored, so on a fresh checkout `index.html`'s Tailwind link resolves to nothing. `index.html`'s real styling (`.command-tab`, `.command-item`, `.status-dot`, ...) is done in its own inline `<style>` block, same as every other window. `llm-response.html` goes further and hand-defines a few Tailwind-*named* classes itself (`.text-white`, `.text-gray-300`, `.text-sm`, `.font-medium`, `.mr-2`) directly in its `<style>` block rather than depending on any Tailwind build. **Treat Tailwind as vestigial** — write plain CSS in the window's own `<style>` block or in `common.css` for anything shared; don't assume an arbitrary Tailwind utility class will resolve.

**Renderer JS — two coexisting controller shapes**, pick based on the file, don't mix within one file:
- Class-based, instantiated on `DOMContentLoaded`: `src/ui/main-window.js` (`class MainWindowUI { constructor() {...} }`, instance exposed as `window.mainWindowUI` for debugging).
- Top-level `DOMContentLoaded` handler / IIFE with local functions and a plain `state` object, no class: `src/ui/settings-window.js`, `onboarding.js` (`(function () { 'use strict'; ... })()`, with `$`/`$$` query-selector helpers and a `state` object).
- Fully inline `<script>` in the HTML file itself, no external controller file at all: `chat.html`, `llm-response.html`.

Loading is always via classic `<script src="...">` (never `type="module"`). `src/ui/chat-window.js` (675 lines) exists but is not referenced by `chat.html` or any other HTML file — don't treat it as the live implementation.

**Renderer → main bridge:** `window.electronAPI` (see IPC Conventions) is the only way renderer code reaches Node/Electron; `require()` is unavailable in any renderer file. Renderer code defensively guards every call: `if (window.electronAPI && window.electronAPI.foo) { ... }` — keep doing this rather than assuming the bridge is always populated.

**Markdown rendering:** the app renders assistant/chat markdown with the **vendored** `lib/markdown.js` — a bundled copy of the old `markdown` npm package, wrapped in an IIFE exposing `window.markdown.toHTML()` — loaded via `<script src="lib/markdown.js">` in both `chat.html` and `llm-response.html`. The `marked` package is a real dependency in `package.json`, and `llm-response.html` defensively checks `typeof marked !== 'undefined'` before preferring it, but **no HTML file actually loads `marked` via a `<script src>` tag**, so that branch never executes in practice. `lib/markdown.js` / `markdown.toHTML(text)` is the markdown renderer that's actually active; if you want `marked` to run somewhere, you must add its `<script>` tag yourself.

**Math rendering:** `lib/mathrender.js` (the app's own code, not vendored) is a small IIFE exposing `window.renderMathInElement(rootNode)`. It walks text nodes for `$...$` / `$$...$$` spans and converts a limited LaTeX-ish symbol/sub/superscript subset to HTML (Unicode glyphs + `<sup>`/`<sub>`) — it is **not** a real LaTeX/KaTeX renderer, just enough for common math notation in interview answers. Call it immediately after any markdown-to-HTML render:

```js
textDiv.innerHTML = formatMarkdown(text);
if (window.renderMathInElement) window.renderMathInElement(textDiv);
```

(pattern from `chat.html`'s `addMessage()`). Both `chat.html` and `llm-response.html` load it via `<script src="lib/mathrender.js">`.

**Syntax highlighting:** PrismJS is wired up only in `chat.html` — `node_modules/prismjs/prism.min.js` + the autoloader plugin pointed at `./node_modules/prismjs/components/`. After inserting a `<code class="language-xxx">` block, call `Prism.highlightElement(codeEl)` (see `addCodeSnippet()` in `chat.html`). `llm-response.html` does **not** load Prism at all — check its own code-rendering path before assuming Prism is available in every window that can show code.

## Error Handling

- **Async main-process methods** wrap their body in try/catch and log via `logger.error(msg, { error: error.message, ...context })`. The catch block almost never rethrows — it degrades gracefully (shows a fallback UI state, emits an `-error` IPC event, or returns `{ success: false, error }`) so one failed request can't take down the app.
- **IPC handlers** (`ipcMain.handle`) follow the same shape on both sides: `{ success: true, ... }` on the happy path, `{ success: false, error: error.message }` on failure — they never let a rejection propagate to the renderer's `ipcRenderer.invoke()` promise. Follow this shape for any new handler in `main.js`.
- **`SpeechService`** (`src/services/speech.service.js`) extends `EventEmitter` and reports failure by emitting `'error'`/`'status'` events (it's driven by async child-process/stream callbacks, not a single call/return flow). `ApplicationController.setupServiceEventHandlers()` in `main.js` is the single place these get forwarded to every window as `speech-error`/`speech-status` IPC events.
- **`LLMService`** (`src/services/llm.service.js`) has an explicit two-tier fallback: (1) if the primary Gemini SDK call fails, retry via `executeAlternativeRequest` (raw HTTPS) or vice-versa depending on `config.get('llm.gemini.enableFallbackMethod')`, cycling through `[primaryModel, ...fallbackModels]` (`config.get('llm.gemini.fallbackModels')`); (2) if every model/method still fails and `config.get('llm.gemini.fallbackEnabled')` is true, return a canned local string from `generateFallbackResponse()` / `generateIntelligentFallbackResponse()` instead of throwing, so the UI always gets *something*. `analyzeError(error)` classifies failures into `NETWORK_ERROR` / `AUTH_ERROR` / `RATE_LIMIT_ERROR` / `TIMEOUT_ERROR` / `UNKNOWN_ERROR` for logging and for `_friendlyTestError()`'s user-facing message mapping — reuse this classifier rather than inventing new categories.
- **Process-level safety net** in `main.js`: `process.on('uncaughtException', ...)` and `process.on('unhandledRejection', ...)` just log and keep the app alive. This exists specifically because an unlistened `error` event on a spawned recorder child process (sox/arecord/whisper) used to crash the entire app when a binary was missing. Any new child-process spawn should attach its **own** `child.on('error', ...)` handler rather than relying on this global catch — see `_startMicrophoneCaptureWithFallback()` in `speech.service.js` for the full pattern: probe binary existence first, guard the spawned child's `error` event, then fail over to the next candidate program.
- **Renderer code** guards every bridge call defensively (`if (window.electronAPI && window.electronAPI.foo) {...}`) rather than assuming `electronAPI` is fully populated.

## Comments

Sparse overall. Used mainly for multi-line "why" explanations above non-obvious workarounds — platform quirks, timing hacks, security tradeoffs — rather than restating what the code does line-by-line. Representative examples of the house style: the block comments above `resolveEnvPath()` and `formatEnvValue()`, and the Linux GPU-crash workaround, all near the top of `main.js`; the VAD (voice-activity-detection) state-machine comments in `speech.service.js` (`_resetVadState()`, `_ingestWhisperAudio()`). When adding a workaround, explain *why* it's needed (what breaks without it), not just what it does.

JSDoc-style `/** ... */` blocks with `@param`/`@returns` appear fairly consistently in `prompt-loader.js`, `src/core/whisper-installer.js`, and `src/managers/session.manager.js`, but are not universal — `src/managers/window.manager.js` mostly uses single-line `//` comments instead. Either style is acceptable; JSDoc is preferred for functions with several parameters or non-obvious return shapes.

## Function Design

**Size:** methods are generally task-sized (10-60 lines); very large "orchestrator" methods do exist for genuinely multi-step flows (e.g. `ApplicationController.saveSettings()` and `triggerScreenshotOCR()` in `main.js`, `WindowManager.createWindow()` in `src/managers/window.manager.js`) and are acceptable when they represent one linear sequence of steps with early returns, rather than deeply nested branching.

**Parameters:** plain positional parameters with defaults are the norm (`function foo(text, activeSkill, sessionMemory = [], programmingLanguage = null)`), not options-object destructuring, except where a method already has many optional knobs — there, a single options object with a default (`{ onProgress } = {}`) is used instead (see `WhisperInstaller.install({ onProgress })`, `runExec(cmd, args, { timeout, onProgress } = {})`).

**Return values:** async service methods that call an LLM/external API consistently return `{ response, metadata }` (never a bare string) — `metadata` always includes at least `{ skill, processingTime, requestId, usedFallback }`. IPC handlers consistently return `{ success: boolean, ... }` (see Error Handling). Functions that can legitimately find nothing return `null` (e.g. `promptLoader.getSkillPrompt()` returns `null` if the skill isn't found) rather than throwing.

## Module Design

**Exports:** one export per file in almost every case — either a singleton instance (`module.exports = new XService()`) or, for the two options-driven classes, the class itself plus a named property for symmetry (`module.exports = FirstRunManager; module.exports.FirstRunManager = FirstRunManager;` in `src/core/first-run.js`, same pattern in `whisper-installer.js`). `prompt-loader.js` is the one file that exports two things by design: `module.exports = { PromptLoader, promptLoader }` — the class for anyone who needs a fresh instance, and the shared singleton for normal use.

**Barrel files:** none — there is no `index.js` re-export file anywhere under `src/`. Every module is required by its full relative path.

---

*Convention analysis: 2026-07-13*
