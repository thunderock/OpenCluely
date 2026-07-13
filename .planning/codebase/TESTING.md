# Testing Patterns

**Analysis Date:** 2026-07-13

## Test Framework

**None installed.** There is no test runner in `package.json` — no `jest`, `mocha`, `vitest`, `ava`, `tap`, or similar in either `dependencies` or `devDependencies`. There is no test config file anywhere in the repo (`jest.config.*`, `vitest.config.*`, `.mocharc*` — all absent). `package.json`'s `scripts` block has no `"test"` key at all:

```json
"scripts": {
  "start": "env -u ELECTRON_RUN_AS_NODE electron .",
  "dev": "env -u ELECTRON_RUN_AS_NODE electron . --no-sandbox --disable-gpu",
  "test-speech": "node scripts/test-speech.js",
  "build": "electron-builder",
  ...
}
```

Running `npm test` in this repo falls through to npm's default and fails with "Error: no test specified". There is also no linter (no `.eslintrc*`, `eslint.config.*`, `biome.json`) and no formatter config, so there is no automated static-analysis gate either — see `CONVENTIONS.md`.

**Assertion library:** none (nothing to assert with).

**Run commands:** there is no way to "run the tests" in the traditional sense. The closest things:

```bash
npm run test-speech      # manual speech-pipeline diagnostic (see below) — NOT a test suite
npm run dev               # run the actual app locally, with GPU/sandbox flags relaxed
npm start                 # run the actual app locally, normal flags
```

## Test File Organization

**None exists.** A repo-wide search confirms zero files matching `*.test.js`, `*.spec.js`, or a `__tests__` directory anywhere outside `node_modules`. No module in `src/services/`, `src/managers/`, `src/core/`, `src/ui/`, nor `prompt-loader.js`/`main.js`/`preload.js`, has a companion test file.

## Test Structure

Not applicable — there are no test suites to show a pattern from.

## Mocking

Not applicable — no mocking library (`sinon`, `jest.mock`, etc.) is used or installed anywhere in the repo.

## Fixtures and Factories

Not applicable — no fixture files or factory helpers exist for tests.

## Coverage

**Effectively 0%.** No coverage tool is configured (no `nyc`, no `c8`, no `--coverage` flag in any script), and there's nothing to measure coverage of, since there are zero test files. Be direct about this with anyone planning work here: there is **no automated regression safety net** for any module — `src/services/llm.service.js` (Gemini request/retry/fallback logic), `src/services/speech.service.js` (VAD state machine, Whisper/Azure recording), `src/managers/window.manager.js` (always-on-top/window-binding logic), `src/core/whisper-installer.js` (venv creation, pip install), and every renderer controller are all verified by hand only.

## Test Types

**Unit tests:** none.

**Integration tests:** none, aside from the manual smoke script described below.

**E2E tests:** none. No Playwright, Spectron, or WebdriverIO despite Electron being a common target for these tools (Playwright is registered as an MCP tool for this environment, but nothing in this repo wires it into an actual E2E suite).

## `npm run test-speech` — the one "test" that exists (manual diagnostic, not automated)

`scripts/test-speech.js` is a small standalone Node script, not a test-framework test:

```js
require('dotenv').config();
const speechService = require('../src/services/speech.service');

async function main() {
  const status = speechService.getStatus();
  console.log('Speech provider:', status.provider);
  console.log('Initialized:', status.isInitialized);
  console.log('Available:', speechService.isAvailable());
  console.log('Effective settings:', JSON.stringify(status.effectiveSettings, null, 2));

  try {
    const connection = await speechService.testConnection();
    console.log('Connection test:', JSON.stringify(connection, null, 2));
  } catch (error) {
    console.error('Connection test failed:', error.message);
    process.exitCode = 1;
  }
}
```

Key characteristics — read this as "what NOT to assume it does":

- **No assertions, no expected values.** It prints whatever `getStatus()`/`isAvailable()`/`testConnection()` return; a human reads the JSON and judges whether it looks right. The only pass/fail signal is a non-zero `process.exitCode` if `testConnection()` throws.
- **Talks to the real world, not a fake.** It `require()`s the actual `src/services/speech.service` singleton (which self-initializes from `process.env`/`config` the moment it's required) and calls the same `testConnection()` used by the Settings UI's "Test Connection" button. For Whisper, `testConnection()` does a real `spawnSync` of the resolved Whisper binary with `--help`; for Azure it constructs and immediately closes a real `SpeechConfig`/`AudioConfig` pair. There is no mocking layer — a meaningful run requires either a working local Whisper install or real Azure credentials in `.env`.
- **It's a setup-time smoke test, not a CI/dev-loop test.** `setup.sh`'s `setup_whisper_env()` function runs `npm run test-speech` automatically, once, immediately after installing Whisper into `.venv-whisper`, purely to print confirmation that the freshly-installed CLI responds:

  ```bash
  if [[ "$whisper_found" -eq 1 ]]; then
    echo "Running Whisper smoke test"
    npm run test-speech
  else
    echo "Skipping Whisper smoke test (CLI not found)"
  fi
  ```

  Its output is informational — `setup.sh` continues (`build_app`, `run_app`) regardless of `test-speech`'s exit code. It is never invoked from CI (`.github/workflows/release.yml` only builds/packages release artifacts on a `v*` tag push; it does not run `test-speech` or any other check).
- **Legacy sibling:** `speech-recognition.js` at the project root is a 3-line re-export (`module.exports = require('./src/services/speech.service')`) whose own comment says "Speech Recognition wrapper for testing" — a leftover from some prior ad-hoc testing approach. Nothing in the current codebase requires it.

If you need to reproduce what this script checks, run `npm run test-speech` after configuring `.env`; expect it to fail loudly (non-zero exit, printed error) if Whisper isn't installed or Azure keys are missing/invalid — that's by design, not a bug in the script.

## How things are actually verified (all manual)

Since there is no automated suite, verification in this codebase means:

1. **Run the app and exercise the feature by hand:** `npm start` (normal) or `npm run dev` (adds `--no-sandbox --disable-gpu`, useful on Linux/headless/CI-like environments where the GPU process is unreliable — see the Linux GPU workaround block at the top of `main.js`).
2. **`npm run test-speech`** for the speech pipeline specifically (see above).
3. **Read the logs.** Winston writes to both the console and rotating files under `~/.OpenCluely/logs/` (`application-%DATE%.log` for info+, `error-%DATE%.log` for errors only — see `src/core/logger.js`). Because almost every method logs entry/exit/error context (see `CONVENTIONS.md`'s Logging section), "tail the log file after reproducing the issue" is the primary debugging and verification technique in this codebase, not a test report.
4. **User-facing diagnostic IPC handlers**, meant for a human clicking a button in the Settings/onboarding UI rather than for developers running checks headlessly:
   - `run-gemini-diagnostics` / `test-gemini-connection` (`main.js`) → `LLMService.testConnection()` / `checkNetworkConnectivity()` in `src/services/llm.service.js` — hits the real Gemini endpoint and a couple of well-known hosts (`google.com`, `generativelanguage.googleapis.com`) over a raw TCP socket to distinguish "no network" from "bad API key" from "rate limited."
   - `detect-whisper` / `install-whisper` / `download-whisper-model` (`main.js`) → `WhisperInstaller` (`src/core/whisper-installer.js`) — probes for a working Whisper CLI, or actually creates a venv and runs `pip install openai-whisper`, streaming live output back to the renderer.
   - These are the closest thing to "integration checks" in the app, but they're product features (onboarding wizard diagnostics), not developer test tooling — they exercise real network calls / real subprocesses every time, with no fixture or offline mode.
5. **Not a test script:** `scripts/gen-og.js` renders `webapp/og-image.html` to a static PNG for the marketing site/README — unrelated to testing, but it lives in the same `scripts/` directory as `test-speech.js` so don't mistake it for one when browsing.

## If You're Asked to Add Tests Here

Nothing in this repo demonstrates a testing pattern to copy, so any new test effort starts from zero. A few structural facts that will shape that work:

- **Almost everything is a self-initializing singleton.** `module.exports = new LLMService()` and `module.exports = new SpeechService()` mean the constructor runs side effects (`initializeClient()`, reading `process.env`/`config.get(...)`) the moment the module is `require()`'d — before a test could inject a mock config or API key. Unit-testing these as they stand would require stubbing `process.env`/`src/core/config.js` *before* the first `require()`, or refactoring the constructors to accept injected config.
- **Two modules are already structured for testability** and are the best templates to imitate if you add tests: `src/core/whisper-installer.js` (`WhisperInstaller`) and `src/core/first-run.js` (`FirstRunManager`) both export the **class**, not a singleton, and take their dependencies through a constructor options object (`cwd`, `dataDir`, `platform`, `logger`, `envPath`, `sentinelPath`) — `WhisperInstaller` even exposes `options.runExec || runExec` as an explicit seam for swapping out real process-spawning in a test.
- **No runner is chosen yet.** Picking a test framework (and adding a real `"test"` script plus a config file) is a prerequisite before any test can be written — there's nothing to be "consistent with" here, only a blank slate.

---

*Testing analysis: 2026-07-13*
