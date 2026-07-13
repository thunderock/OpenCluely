# Technology Stack

**Analysis Date:** 2026-07-13

## Languages

**Primary:**
- JavaScript (CommonJS, plain ES2020-ish syntax, no TypeScript) — main process (`main.js`, `src/core/*.js`, `src/managers/*.js`, `src/services/*.js`), preload bridge (`preload.js`), renderer scripts (`src/ui/*.js`, `onboarding.js`), and the request/prompt layer (`prompt-loader.js`). No `tsconfig.json`, no `.babelrc`/`babel.config.js`, no webpack/vite/rollup config anywhere in the repo — renderer `<script>` tags run unbundled, unminified source directly.

**Secondary:**
- HTML/CSS — renderer windows: `index.html` (main overlay), `chat.html`, `settings.html`, `onboarding.html`, `llm-response.html`; static marketing site in `webapp/` (`webapp/index.html`, `webapp/script.js`, `webapp/style.css`, `webapp/og-image.html`).
- Bash — `setup.sh` (primary dev/onboarding installer), `scripts/post-install-deb.sh` (Debian post-install hook, currently a no-op).
- NSIS script — `scripts/post-install-nsis.nsh` (Windows installer hook, currently empty macros).
- Markdown — skill/system prompts consumed at runtime: `prompts/dsa.md`, `prompts/programming.md` (only `dsa` is actually wired up — see `prompt-loader.js`).

## Runtime

**Environment:**
- Electron `^29.1.0` (devDependency; resolved `29.4.6` per `package-lock.json`) — bundles its own Chromium + Node.js; `main.js` is the app entry point (`package.json` → `"main": "main.js"`).
- Node.js: no `engines` field in `package.json`. `README.md` states "Node.js 18 or newer"; `setup.sh` only checks that `node`/`npm` exist (no version gate); CI (`.github/workflows/release.yml`) provisions Node `20` via `actions/setup-node`.
- `NODE_ENV` controls `src/core/config.js` dev/prod flags; not set by any script (defaults to `'development'` whenever unset, including in packaged builds — `app.isDevelopment`/`isProduction` should not be trusted as a packaging signal).

**Package Manager:**
- npm — `package-lock.json` is committed (lockfile present). CI and `setup.sh --ci` use `npm ci`; default dev flow uses `npm install`.

## Frameworks

**Core:**
- None (no React/Vue/Angular/Svelte). All renderer UI is hand-written DOM manipulation in `src/ui/main-window.js`, `src/ui/chat-window.js`, `src/ui/settings-window.js`, and `onboarding.js`.
- Tailwind CSS — `tailwind.config.js` exists (`content: ["./**/*.{html,js}"]`) and `src/input.css` contains `@tailwind base/components/utilities` directives, and `index.html` links `./dist/output.css`. However, `tailwindcss` is **not** declared in `package.json` dependencies/devDependencies, and there is no npm script (`build:css` or similar) that compiles `src/input.css` → `dist/output.css`. `dist/` is also gitignored. A fresh clone therefore has no working Tailwind build step; `dist/output.css` must be produced by an undocumented external process for the main overlay's Tailwind-based styling to render correctly.

**Testing:**
- None. No Jest/Vitest/Mocha/Playwright config or dependency anywhere in the repo. `npm run test-speech` (`scripts/test-speech.js`) is a manual smoke-test script that prints the resolved speech-provider config and calls `speechService.testConnection()` — not an automated test suite/assertions.

**Build/Dev:**
- `electron-builder` `^24.13.3` (devDependency; resolved `24.13.3`) — packaging/distribution only, driven entirely by the `"build"` block in `package.json`.

## Key Dependencies

**Critical:**
- `@google/genai` `^2.9.0` (resolved `2.9.0`) — official Google Gen AI JS SDK; sole LLM integration. Used throughout `src/services/llm.service.js`.
- `dotenv` `^16.3.1` (resolved `16.5.0`) — loads the resolved `.env` file into `process.env` at startup (`main.js`) and in `scripts/test-speech.js`.
- `microsoft-cognitiveservices-speech-sdk` `^1.40.0` (resolved `1.44.1`) — Azure Cognitive Services Speech SDK; optional cloud speech-to-text provider (`src/services/speech.service.js`). Loaded defensively behind a `try/require` so its absence doesn't crash the app.
- `node-record-lpcm16` `^1.0.1` (resolved `1.0.1`) — spawns `sox`/`arecord` to capture raw 16kHz mono PCM microphone audio on macOS/Linux for both the Azure and native-Whisper capture paths (`src/services/speech.service.js`). Also loaded defensively behind `try/require`.

**Infrastructure:**
- `winston` `^3.17.0` + `winston-daily-rotate-file` `^4.7.1` — structured logging with console + daily-rotating file transports; exception/rejection handlers. Configured once in `src/core/logger.js`, logs written to `~/.OpenCluely/logs/`.

**UI/rendering (renderer-side, loaded via `<script>`/`<link>` tags, not bundled):**
- `marked` `^15.0.12` — declared dependency, referenced defensively in `llm-response.html` (`typeof marked !== 'undefined'`), but **no `<script>` tag in the app loads it anywhere** — it is effectively dead at runtime; Markdown rendering always falls through to the vendored parser below.
- `markdown` `^0.5.0` — legacy JsonML-based Markdown parser (Christoph Dorn, 2011). Because `nodeIntegration` is `false` everywhere, the renderer cannot `require('markdown')`; instead a vendored copy lives at `lib/markdown.js` and is loaded via `<script src="lib/markdown.js">` in `chat.html` / `llm-response.html`, exposing a global `window.markdown` with `.toHTML()`.
- `lib/mathrender.js` — small hand-written LaTeX-subset-to-HTML renderer (no dependency; converts `\frac`, super/subscripts, Greek letters, common symbols) shared by `chat.html` and `llm-response.html`.
- `prismjs` `^1.30.0` — code syntax highlighting; loaded directly from `./node_modules/prismjs/prism.min.js` + the autoloader plugin via `<script>` tags in `chat.html` (autoloader fetches language grammars on demand from the same `node_modules` path).
- `@fortawesome/fontawesome-free` `^7.2.0` — icon font; self-hosted/vendored at `assests/vendor/fontawesome/` (`all.min.css` + `.woff2` files), referenced by `onboarding.html`. Not loaded from a CDN.

**Note on packaging:** `package.json`'s `"build".files` glob is `["**/*", "!dist/**/*", "!*.md", ...]` — it does **not** exclude `node_modules/`, which is required because `chat.html` loads `prismjs` directly from `./node_modules/prismjs/...` at runtime.

## Configuration

**Environment:**
- Single `.env` file, loaded by `dotenv`. Its path is resolved dynamically in `main.js` (`resolveEnvPath()`): a project-root `.env` is used only in dev when it already exists; otherwise the app uses Electron's `userData` directory (`app.getPath('userData')/.env`) so configuration survives read-only install locations (NSIS install dir, AppImage mount, `.app` bundle) and app relaunches.
- `env.example` (repo root) is the template — copied to `.env` by `setup.sh` (`ensure_env_file()`) or by `FirstRunManager.ensureEnv()` (`src/core/first-run.js`) on first launch of a packaged build. File permissions are set to `0600` on creation.
- Settings UI writes back to the same `.env` at runtime: `saveSettings()` / `persistEnvUpdates()` in `main.js` rewrite it in place (temp-file + atomic rename) and update `process.env` live, so provider/key changes apply without an app restart.

**Env vars read directly via `process.env` (see `env.example` for the user-facing subset):**
| Variable | Purpose | Default if unset |
|---|---|---|
| `GEMINI_API_KEY` | Google Gemini auth | none — required for AI features |
| `SPEECH_PROVIDER` | `azure` or `whisper` | auto-detected (`whisper` unless Azure key+region both present) |
| `AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION` | Azure Speech auth | none |
| `WHISPER_COMMAND` | Whisper CLI invocation | probed across several fallback locations |
| `WHISPER_MODEL_DIR` | absolute dir for downloaded model weights | Electron `userData/.whisper-models` |
| `WHISPER_MODEL` | Whisper model size | `turbo` |
| `WHISPER_LANGUAGE` | transcription language | `en` |
| `WHISPER_SEGMENT_MS` | legacy fixed-window / max single-utterance size | `4000` |
| `WHISPER_VAD_ENABLED` | disable voice-activity-detection segmentation | VAD enabled |
| `WHISPER_SILENCE_HANGOVER_MS`, `WHISPER_MIN_UTTERANCE_MS`, `WHISPER_MAX_UTTERANCE_MS`, `WHISPER_PRE_ROLL_MS`, `WHISPER_VAD_ENERGY_FLOOR` | advanced VAD tuning, not documented in `env.example` | see `src/core/config.js` → `speech.whisper.*` |
| `LOG_LEVEL` | Winston log level | `info` |
| `NODE_ENV` | dev/prod flag in `src/core/config.js` | `development` |
| `ELECTRON_NO_ATTACH_CONSOLE`, `ELECTRON_NO_ASAR` | macOS stealth-mode process tweaks, set programmatically | — |

**Build:**
- `package.json` `"build"` block (electron-builder config) — see Platform Requirements below for per-OS targets.
- `tailwind.config.js` — see caveat above; no working build script currently wires it up.

## Platform Requirements

**Development:**
- Node.js 18+ (20 used in CI), npm.
- Python 3.10+ — only needed for the local Whisper venv (`setup.sh` / onboarding installer's `WhisperInstaller`).
- Optional native audio tools: `sox` (macOS) or `arecord`/`sox` (Linux) for microphone capture; `ffmpeg` recommended (not strictly required — audio is always pre-converted to WAV in-app before being handed to Whisper).

**Production:**
- **macOS** — no prebuilt artifact is distributed (unsigned, un-notarized; Gatekeeper would block it). Users build from source via `setup.sh`. electron-builder mac config: `dmg` + `zip` targets for `x64`/`arm64`, `hardenedRuntime: false`, `gatekeeperAssess: false`, custom `Info.plist` usage-description strings for microphone/camera/screen-capture.
- **Windows** — NSIS installer (`x64`/`ia32`, `artifactName: OpenCluely-Setup-${version}.${ext}`) plus a portable exe; unsigned (`sign: null`); `scripts/post-install-nsis.nsh` hook is present but empty.
- **Linux** — `AppImage` + `.deb` (`x64` only). The `.deb` declares runtime `depends`: `libgtk-3-0`, `libnotify4`, `libnss3`, `libxss1`, `libxtst6`, `xauth`, `libasound2t64`, `libgbm1`, `python3 (>= 3.10)`, `python3-venv`, `python3-pip`, plus `recommends: ffmpeg`; runs `scripts/post-install-deb.sh` (currently a no-op — Whisper venv/`.env` are bootstrapped lazily on first launch instead) via `fpm --after-install`.
- **CI/CD** — `.github/workflows/release.yml` builds on `ubuntu-latest` (→ `npm run build:linux`) and `windows-latest` (→ `npm run build:win`) with Node 20 on tag pushes (`v*`) or manual dispatch; uploads artifacts and, on a tag, creates a GitHub Release with SHA-256 checksums and an auto-generated changelog. macOS is intentionally not built in CI. Code signing is explicitly opt-out (`CSC_IDENTITY_AUTO_DISCOVERY: false`).

---

*Stack analysis: 2026-07-13*
