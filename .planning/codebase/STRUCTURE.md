# Codebase Structure

**Analysis Date:** 2026-07-13

## Directory Layout

```
OpenCluely/
├── main.js                  # Electron main-process entry point (ApplicationController)
├── preload.js               # contextBridge: window.electronAPI + window.api
├── prompt-loader.js         # Loads/injects skill system prompts from prompts/*.md
├── speech-recognition.js    # 3-line legacy re-export of src/services/speech.service.js
├── index.html               # Main overlay ("pill" command bar) window markup
├── chat.html                 # Chat window (markup + all behavior inline)
├── llm-response.html         # AI-response overlay window (markup + all behavior inline)
├── settings.html              # Settings window markup
├── onboarding.html             # First-run wizard markup
├── onboarding.js                # First-run wizard behavior (paired with onboarding.html)
├── tailwind.config.js       # Tailwind content globs (see note under Special Directories)
├── env.example              # Template copied to .env on first run (FirstRunManager)
├── setup.sh                 # Dev convenience script: .env, npm install, Whisper venv, build/run
├── src/
│   ├── core/                # Cross-cutting infra: config, logging, first-run, Whisper installer
│   ├── managers/             # Long-lived cross-window state (windows, session/conversation)
│   ├── services/              # External integrations (screen capture, speech, Gemini LLM)
│   ├── ui/                     # Renderer-side behavior for index.html and settings.html
│   ├── styles/                # Shared CSS (common.css)
│   └── input.css               # Tailwind directives source (see Special Directories)
├── lib/                     # Vendored/shared renderer helpers (markdown + LaTeX rendering)
├── prompts/                  # Skill system prompts as Markdown (dsa.md is the only active one)
├── scripts/                   # Build/packaging/dev helper scripts (not app runtime code)
├── assests/                    # App icons + vendored Font Awesome (note: misspelled "assests")
├── webapp/                      # Standalone static marketing site (not part of the Electron bundle)
└── .github/workflows/            # CI: release.yml builds+publishes Linux/Windows installers
```

## Directory Purposes

**`src/core/`:**
- Purpose: infrastructure with no OpenCluely-specific business logic — the kind of code every Electron app needs.
- Contains: `config.js` (in-memory config tree + `get()`/`getApiKey()`), `logger.js` (Winston setup + `createServiceLogger()`), `first-run.js` (`FirstRunManager` — onboarding-needed detection, `.env` bootstrap), `whisper-installer.js` (`WhisperInstaller` — detect/install local Whisper CLI + models).
- Key files: `src/core/config.js`, `src/core/logger.js`.

**`src/managers/`:**
- Purpose: singletons that own state shared across multiple windows/requests.
- Contains: `window.manager.js` (`WindowManager` — all `BrowserWindow` creation/positioning/stealth/broadcast), `session.manager.js` (`SessionManager` — conversation history used as LLM context).
- Key files: `src/managers/window.manager.js` (1828 lines, largest file in `src/`), `src/managers/session.manager.js` (600 lines).

**`src/services/`:**
- Purpose: talk to something outside the process (OS screen APIs, microphone/CLI tools, Google's API).
- Contains: `capture.service.js` (screenshots via `desktopCapturer`), `speech.service.js` (Azure/Whisper speech-to-text, 1847 lines — largest file in the repo's `src/`), `llm.service.js` (Gemini requests, streaming, retries, 1655 lines), `fallback-capture.service.js` (**empty file, 0 bytes, unused** — do not add code here without first checking whether it should just be deleted).
- Key files: `src/services/llm.service.js`, `src/services/speech.service.js`.

**`src/ui/`:**
- Purpose: renderer-side (browser-context) behavior for the two windows whose HTML doesn't inline its own script.
- Contains: `main-window.js` (drives `index.html`, 1282 lines), `settings-window.js` (drives `settings.html`, 323 lines), `chat-window.js` (675 lines — **written for `chat.html` but not referenced by any `<script>` tag anywhere; dead code**, `chat.html` implements the same behavior inline instead).
- Key files: `src/ui/main-window.js`.

**`src/styles/` and `src/input.css`:**
- Purpose: CSS shared across the vanilla-JS windows.
- Contains: `common.css` (579 lines) — linked by `index.html`, `chat.html`, `settings.html`. Not linked by `llm-response.html` or `onboarding.html` (both use their own inline `<style>` blocks + Font Awesome only).
- `src/input.css` is a 2-line Tailwind `@tailwind base/components/utilities` entry file — see Special Directories; it is not part of the CSS actually loaded at runtime today.

**`lib/`:**
- Purpose: small vendored/shared renderer helper libraries loaded via plain `<script src="lib/...">` (not bundled, not npm packages).
- Contains: `markdown.js` (1725 lines — a bundled fallback Markdown-to-HTML parser used when `marked` isn't available/loaded), `mathrender.js` (84 lines — `window.renderMathInElement()`, a hand-rolled LaTeX-subset → HTML converter for `$...$`/`$$...$$` spans, shared by `chat.html` and `llm-response.html` so both windows render the same inline math/sub/superscripts).
- Key files: `lib/mathrender.js`, `lib/markdown.js`.

**`prompts/`:**
- Purpose: the actual "skill" system prompts, as Markdown, loaded by `prompt-loader.js`.
- Contains: `dsa.md` (27 lines, the only prompt currently loaded — `PromptLoader.loadPrompts()` explicitly skips every other `.md` file) and `programming.md` (51 lines, present on disk but never loaded).
- Adding a new active skill requires *both* adding a `.md` file here *and* editing `prompt-loader.js`'s `loadPrompts()`/`getAvailableSkills()` (currently hardcoded to `['dsa']`) and the `skillsRequiringProgrammingLanguage` list if it needs language injection.

**`scripts/`:**
- Purpose: one-off/build-time/dev helper scripts invoked via `npm run <script>` or by the installer — not required by the running app.
- Contains: `gen-og.js` (renders `webapp/og-image.html` to a PNG using an offscreen Electron window), `post-install-deb.sh` / `post-install-nsis.nsh` (electron-builder post-install hooks — both currently no-ops, since Whisper venv/`.env` setup happens at first app launch instead), `test-speech.js` (manual CLI smoke test for `src/services/speech.service.js`, run via `npm run test-speech`).

**`assests/`:**
- Purpose: app icons (used for stealth dock/window-icon swapping) and vendored Font Awesome (self-hosted, no CDN/network dependency for icons in the stealth-sensitive UI).
- Contains: `icons/{terminal,activity,settings}.png` (the only copies actually referenced, by `main.js` `updateAppIcon()`'s `iconPaths` map) plus byte-identical duplicates `activity.png`/`settings.png`/`terminal.png` directly under `assests/` (not referenced anywhere — leftover, safe to ignore or remove); `vendor/fontawesome/` (`all.min.css` + `webfonts/`, referenced by `onboarding.html` and, via `@fortawesome/fontawesome-free` npm package, by the other windows).
- Note: the directory name is misspelled ("assests" not "assets") throughout the codebase — match the existing spelling exactly when adding new paths; `package.json`'s `asarUnpack` also references `assests/icons/**/*` literally.

**`webapp/`:**
- Purpose: standalone static marketing/landing-page site (HTML/CSS/vanilla JS) for the project. Not loaded by any Electron window, not referenced by `main.js`/`preload.js`, and not part of the `.github/workflows/release.yml` build. Treat as a separate mini-project living in this repo.
- Contains: `index.html`, `style.css`, `script.js`, `og-image.html`/`og-image.png` (Open Graph preview image, generated by `scripts/gen-og.js`), `favicon.svg`.

**`.github/workflows/`:**
- Purpose: CI/CD.
- Contains: `release.yml` — triggered on `v*` tags (or manual dispatch), builds on `ubuntu-latest` (AppImage + deb) and `windows-latest` (nsis exe), publishes a GitHub Release. There is currently no macOS build job in CI (README/docs direct macOS users to build from source).

## Key File Locations

**Entry Points:**
- `main.js`: Electron main-process entry (`package.json` `"main"`), constructs `ApplicationController`.
- `preload.js`: renderer/main IPC bridge, loaded via `config.get('window.webPreferences').preload` for every `BrowserWindow`.
- `index.html` / `src/ui/main-window.js`: main overlay window.
- `chat.html`: chat window (fully self-contained, no companion JS file).
- `llm-response.html`: AI-response overlay window (fully self-contained).
- `settings.html` / `src/ui/settings-window.js`: settings window.
- `onboarding.html` / `onboarding.js`: first-run wizard.

**Configuration:**
- `src/core/config.js`: in-app defaults (models, window sizes, VAD tuning) — edit here for non-secret defaults.
- `.env` (git-ignored; template at `env.example`): secrets/user settings — `GEMINI_API_KEY`, `AZURE_SPEECH_KEY`/`AZURE_SPEECH_REGION`, `SPEECH_PROVIDER`, `WHISPER_*`. Written/read by `main.js` (`resolveEnvPath()`, `persistEnvUpdates()`) and `src/core/first-run.js`.
- `package.json` `build` block: `electron-builder` packaging config (per-platform targets, `asarUnpack`, `files` excludes).
- `tailwind.config.js` / `src/input.css`: Tailwind source config — see Special Directories (no build script currently wires these up).

**Core Logic:**
- `main.js`: orchestration, IPC handler registry, screenshot/chat/voice → LLM pipelines.
- `src/managers/window.manager.js`: window lifecycle, stealth, positioning.
- `src/managers/session.manager.js`: conversation memory / LLM context.
- `src/services/llm.service.js`: all Gemini interaction.
- `src/services/speech.service.js`: all speech-to-text.
- `prompt-loader.js` + `prompts/*.md`: skill system prompts.

**Testing:**
- No test framework or `test`/`spec` files exist in this repo. `scripts/test-speech.js` is a manual CLI smoke-test script (`npm run test-speech`), not an automated test.

## Naming Conventions

**Files:**
- Root-level windows: `<name>.html` (+ optional same-stem `.js`, e.g. `onboarding.html` + `onboarding.js`). No `.html`/`.js` pairing convention inside `src/ui/` — those files are named `<window>-window.js` (`main-window.js`, `chat-window.js`, `settings-window.js`) and paired to root HTML files by `<script>` tag, not by filename stem.
- Services: `<name>.service.js` under `src/services/`.
- Managers: `<name>.manager.js` under `src/managers/`.
- Core infra: bare `<name>.js` under `src/core/` (no suffix convention).
- Directory name `assests` is a persistent misspelling of "assets" — used consistently everywhere (code, `package.json`, CI config); do not "fix" it in isolation, as it would break every reference.

**Directories:**
- Singular, lowercase, purpose-named: `core`, `managers`, `services`, `ui`, `styles`. No `utils`/`helpers`/`common` catch-all directory exists — cross-cutting helpers live in `src/core/`.

**Code style inside files (for placement decisions, not full convention doc):**
- Main-process modules: `class Foo { ... } module.exports = new Foo();` singleton pattern (managers/services) or a plain class kept as the sole export (`FirstRunManager`, `WhisperInstaller` — these are `require()`d and constructed explicitly by `main.js` instead, since they need per-call options like `envPath`/`cwd`).
- Renderer scripts: a `class FooUI { constructor() { this.init(); } }` wrapper (`MainWindowUI`, `SettingsWindowUI`-style; settings/onboarding use a plain `DOMContentLoaded` closure instead of a class) that queries `window.electronAPI` for state on load and subscribes to push events with `electronAPI.onX((event, data) => ...)`.

## Where to Add New Code

**New IPC-backed capability (e.g., a new main-process action a window can trigger):**
1. Add the handler in `main.js` `setupIPCHandlers()` (`ipcMain.handle('channel-name', ...)`).
2. Expose it through `preload.js`'s `contextBridge.exposeInMainWorld('electronAPI', { ... })` — add a wrapped `ipcRenderer.invoke('channel-name', ...)` method; do not bypass the bridge.
3. Call `window.electronAPI.yourMethod()` from the relevant renderer script (inline `<script>` in the HTML file, or the matching file in `src/ui/`).

**New external integration (new API/SDK, à la Gemini or Azure Speech):**
- Add a new `<name>.service.js` under `src/services/`, follow the existing singleton export pattern (`module.exports = new NameService()`), and `require()` it only from `main.js` — services are never required directly from renderer/UI files in this codebase.

**New skill/system-prompt:**
- Add `prompts/<skill>.md`, then update `prompt-loader.js`: remove/adjust the `if (skillName !== 'dsa') continue;` guard in `loadPrompts()` (currently hardcoded to DSA-only) and add the skill to `getAvailableSkills()`; add it to `skillsRequiringProgrammingLanguage` in `prompt-loader.js` (and the parallel list in `main.js`'s `triggerScreenshotOCR`/`processWithLLM`/`processTranscriptionWithLLM`) if it needs language-fenced code output.

**New window:**
1. Add an entry to `windowConfigs` in `src/managers/window.manager.js` (size, `file`, title, frame/transparency flags) and add a branch in `createWindow()` if it needs non-default `BrowserWindowOptions`.
2. Add a `create<Name>Window()` method and call it from `initializeWindows()`.
3. Create the `<name>.html` at the project root; link `src/styles/common.css` if it should match the existing overlay look, and load `lib/markdown.js`/`lib/mathrender.js` if it will render AI responses.
4. Give it behavior either inline (like `chat.html`) or as `src/ui/<name>-window.js` loaded via `<script src="./src/ui/<name>-window.js">` (like `index.html`/`settings.html`) — pick whichever pattern the file is more similar to; do not create an `src/ui/*.js` file without wiring a `<script>` tag to it (see `chat-window.js`, which is the cautionary example of forgetting this step).

**Utilities/shared renderer helpers:**
- Put framework-free, `<script>`-tag-loadable helpers in `lib/` (see `mathrender.js` for the expected shape: an IIFE that attaches one function to `window`).
- Put main-process-only cross-cutting helpers in `src/core/`.

## Special Directories

**`dist/`:**
- Purpose: `electron-builder` output directory (`package.json` `build.directories.output`).
- Generated: Yes, by `npm run build`/`build:mac`/`build:win`/`build:linux`/`build:all`.
- Committed: No (`.gitignore`).
- Note: `index.html` also references `./dist/output.css`, which looks like a Tailwind CLI build output — but `tailwindcss` is not in `package.json`'s dependencies/devDependencies or `package-lock.json`, and no npm script builds it. `tailwind.config.js` and `src/input.css` exist but nothing currently wires them into `dist/output.css`; that stylesheet does not exist on a fresh checkout, so `index.html` loads without it (its visuals come from the inline `<style>` block plus `src/styles/common.css`).

**`node_modules/`, `.venv-whisper/`, `.whisper-models/`, `eng.traineddata`:**
- Purpose: npm dependencies; per-app Python virtualenv + downloaded Whisper model weights created by `src/core/whisper-installer.js` (either under the project root in dev or Electron `userData` in packaged builds); a Tesseract OCR trained-data file (legacy — current screenshot flow sends the image directly to Gemini, not through OCR, despite the `ocr` naming still used in `main.js`/`src/core/config.js`).
- Generated: Yes (install-time / first-run).
- Committed: No (`.gitignore`).

**`.github/workflows/`:**
- Purpose: CI build/release pipeline.
- Generated: No (hand-written).
- Committed: Yes.

---

*Structure analysis: 2026-07-13*
