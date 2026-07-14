# Phase 1: Foundation — Supervisor, Tests, Lint, Makefile - Research

**Researched:** 2026-07-13
**Domain:** Node 20 native test runner (`node:test`), ESLint 9 flat config, GitHub Actions CI, GNU Make, generic process supervisor (child_process/net/http) — all in a CommonJS + vanilla-JS Electron app with zero prior test/lint infra.
**Confidence:** HIGH (stack, extraction, tests, lint, CI verified against source + versioned docs; supervisor design is a synthesized recommendation built on HIGH-confidence Node builtins)

<user_constraints>
## User Constraints (from CONTEXT.md)

These are LOCKED user decisions. The planner MUST honor them verbatim. Do not plan alternatives to locked choices.

### Locked Decisions
- **Makefile targets fixed by convention:** `setup`, `setup-dev`, `run_tests`, `lint`. (FND-03)
- **Named test targets (FND-01):** VAD segmentation, `.env` parse, skill/prompt normalization. Do NOT expand coverage beyond these three.
- **Supervisor adopt-if-present / own-if-started** — never kill a process it did not start. Hard requirement (FND-04 + Success Criterion 4).
- **Tech constraint:** stay CommonJS + vanilla JS; no bundler, no TypeScript, no framework. Match existing conventions (incl. the intentional `assests/` misspelling).
- **CI must gate lint on PRs** (FND-02 SC2: a PR carrying a lint violation fails the gate).
- **Test runner:** Node's built-in `node:test` + `node:assert`, run via `node --test`. Zero new runtime/dev deps. Chosen over Jest/Vitest — do NOT re-litigate.
- **Extraction IN SCOPE:** pull the pure functions out of their self-initializing singletons into standalone testable modules; the singleton delegates to the extracted module.
- **No coverage gate/threshold this phase.**
- **Linter:** ESLint (flat config). First-class handling of three environments (main/Node, preload, renderer/browser globals). Chosen over Biome — do NOT re-litigate.
- **No mass reformat.** Lint rules only; preserve per-layer style (2-space main / 4-space renderer; mixed quotes). Gate on errors only. Lean, high-signal ruleset (`no-undef` with correct per-environment globals, `no-unused-vars`); fix the handful it surfaces.
- **CI gate:** runs lint + tests (`node --test`); triggers on pull requests + pushes to `main`; ubuntu + macOS matrix; new workflow, separate from the tag-only `.github/workflows/release.yml`.
- **Supervisor restart policy:** exponential backoff (capped interval) → give up after N attempts → mark failed and surface a clear status.
- **Supervisor health-check:** support BOTH a TCP port-open probe AND an HTTP-endpoint probe, chosen per service in its config.
- **Supervisor failure mode:** degrade gracefully + surface status; don't crash, don't hang.
- **Build supervisor generic NOW**, validated against both future consumers (Ollama HTTP on 127.0.0.1:11434, whisper-server on a local TCP port) via a demo test PLUS a design check.
- **Termination sequence fixed by SC3:** SIGTERM → SIGKILL on app quit.
- **Logging:** `require('./core/logger').createServiceLogger('SUPERVISOR')`; `logger.<level>(message, metaObject)` — never string-interpolate variable data into the message.
- **Supervisor shape:** imitate `src/core/whisper-installer.js` and `src/core/first-run.js` — export the CLASS (not a singleton), take deps via a constructor options object, expose an injected spawn/exec function as an explicit test seam (like `WhisperInstaller`'s `options.runExec || runExec`).

### Claude's Discretion
- Exact backoff constants (initial delay, multiplier, cap, max-attempt count) and the concrete surfaced-status shape/event.
- The precise ESLint rule list and per-environment `globals` config; the shape of the dummy fixture process for the supervisor demo test.
- Where the extracted pure-logic modules live (path/naming), following existing conventions.
- Adopt/own detection mechanism (policy is locked; mechanism — e.g. port probe ± PID sidecar — is implementation).

### Deferred Ideas (OUT OF SCOPE)
- Wiring real services into the supervisor (Ollama P3 PROV-05, whisper-server P4 STT-01). Phase 1 proves the supervisor generically against a trivial dummy process only.
- The provider abstraction / any Gemini refactor (that's P2).
- Pre-warm-on-launch / re-warm-on-wake (belong with real services in P3/P4). The generic contract must not *preclude* them, but Phase 1 does not implement them.
- Coverage threshold / gate.
- Broader test coverage beyond the three named pieces.
</user_constraints>

## Summary

Every locked decision is achievable with **zero new runtime dependencies and exactly one new dev dependency (ESLint + its `globals` helper)**. The test runner (`node:test`/`node --test`), all supervisor primitives (`child_process.spawn`, `net`, `http`, `fs` for a PID sidecar), and the logger are already in Node/the repo. The repo has **no** existing `Makefile`, `test/` dir, or ESLint config, so this phase is greenfield for all four deliverables — nothing to be "consistent with," which the intel docs confirm.

The single most important environment fact: **CI targets Node 20, dev machines run newer Node (this machine is v26.5.0)**, so every choice must work on *both*. `node:test` is stable (Stability 2) on Node 20 with no flags, but **command-line glob patterns in `node --test` only exist on Node 21+** — on Node 20 you pass explicit files or directories. This dictates how the Makefile and CI invoke tests. ESLint's latest (10.x) requires Node ≥20.19; ESLint 9.x has a lower Node-20 floor, so **ESLint 9 (flat config) is the lower-risk pin** while producing an identical config shape.

The extraction is genuinely low-risk because two of the three targets are already close to testable: `prompt-loader.js` already exports its class with a cheap constructor, and the `.env` write path (`main.js`) plus `.env` read path (`first-run.js`) are small pure string transforms trapped behind `fs` calls. Only the VAD state machine is buried in the 1847-line self-initializing `SpeechService` singleton (which mutates `global.window` and requires the Azure SDK on `require`), so its pure core must be lifted into a standalone segmenter that takes tuning config as plain parameters.

**Primary recommendation:** Create four extracted pure modules under `src/core/` (`vad-segmenter.js`, `env-file.js`, `skill-normalizer.js`, and the deliverable `service-supervisor.js`), have the existing singletons delegate to them, put tests in `test/*.test.js`, invoke them portably with `node --test test/*.test.js`, lint with a hand-rolled lean flat ESLint 9 config (three `files`-scoped blocks: node/main, preload, renderer/browser), and add a new `ci.yml` (ubuntu+macOS, Node 20, `npm ci`, lint gate, `node --test`). Keep supervisor fixtures OUT of the auto-discovery path.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `node:test` | built-in (Node ≥20) | Test runner (`test`/`describe`/`it`, hooks) | Locked. Stable since Node 20.0.0, no flag, native CommonJS, zero deps. |
| `node:assert` | built-in | Assertions (`assert.strictEqual`, `assert.deepStrictEqual`, `assert.throws`, `assert.match`) | Locked. Pairs with `node:test`; use the strict variants. |
| `eslint` | `^9` (9.39.5 maintenance) | Lint gate (flat config `eslint.config.js`) | Locked (over Biome). ESLint 9 flat config; broadest Node-20 support (engine `^18.18 \|\| ^20.9 \|\| >=21.1`). |
| `globals` | latest (`^17`) | Predefined `node`/`browser` global sets for `languageOptions.globals` | The flat-config replacement for the old `env:` key; avoids hand-listing `console`, `process`, `window`, `document`, etc. |
| `child_process` (`spawn`) | built-in | Supervisor spawns/owns the managed process | Locked shape mirrors `WhisperInstaller` (`spawn`, DI seam). |
| `net` | built-in | TCP port-open health probe (`net.connect`) | Locked health-check type. Covers whisper-server (local TCP). |
| `http` | built-in | HTTP-endpoint health probe (`http.get`) | Locked health-check type. Covers Ollama (`127.0.0.1:11434`). |
| `fs` | built-in | PID-sidecar file for adopt/own detection; `.env` I/O | Matches OpenWhispr `sidecarPidFile.js` pattern (OPENWHISPR-NOTES §3.1). |

### Supporting (dev tooling / CI)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@eslint/js` | matches eslint major (`^9`) | Optional `js.configs.recommended` base | ONLY if you want a broader real-bug base than the hand-rolled rules. Not required — the lean config below needs only `eslint` + `globals`. |
| `actions/checkout@v4` | v4 | CI checkout | New `ci.yml`. Same version already used in `release.yml`. |
| `actions/setup-node@v4` | v4 | Provision Node 20 + npm cache | `node-version: '20'` resolves to latest 20.x (currently 20.20.2, ≥20.19). |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| ESLint 9 | ESLint 10.7.0 (latest) | 10.x is newest but requires Node `^20.19.0 \|\| ^22.13 \|\| >=24`. Fine given `setup-node '20'` gives 20.20.2, but 9.x is strictly safer for the Node-20 target with an identical flat-config shape and the same rules. Recommend 9; 10 acceptable only if Node ≥20.19 is guaranteed. |
| Hand-rolled rules | `js.configs.recommended` | `recommended` is all real-bug (non-stylistic) rules and aligns with "lean," but turns on ~20 rules that may surface more than "a handful." The hand-rolled block (below) is the leaner, more predictable choice and needs no `@eslint/js` dep. |
| `node --test test/*.test.js` (shell glob) | `node --test test/` (directory) | **Directory form treats EVERY `.js` under `test/` as a test file** (Node 20 rule), so any fixture `.js` in `test/` would be executed as a test and hang. The shell-expanded single-`*` glob only runs `*.test.js`, so fixtures under `test/fixtures/` are ignored. See Pitfall 1. |
| Fixture file for supervisor demo | `node -e '<inline server>'` | Inline avoids the fixture-discovery problem entirely and needs no path resolution, but is unwieldy for a TCP/HTTP server. A fixture at `test/fixtures/` (excluded by the glob invocation) is cleaner and reusable. |

**Installation:**
```bash
# The ONLY new dependency this phase adds. node:test/net/http/child_process/fs are built-in.
npm install --save-dev eslint@^9 globals
# (optional base, only if using js.configs.recommended):  npm install --save-dev @eslint/js@^9
# CRITICAL: this updates package-lock.json — commit it, or CI `npm ci` fails (see Pitfall 4).
```

## Architecture Patterns

### Recommended Project Structure
```
OpenCluely/
├── Makefile                       # NEW — 4 targets (setup, setup-dev, run_tests, lint), .PHONY, TAB-indented recipes
├── eslint.config.js               # NEW — flat config, CommonJS (module.exports = [...])
├── .github/workflows/
│   ├── release.yml                # UNCHANGED (tag-only)
│   └── ci.yml                     # NEW — pull_request + push:main, ubuntu+macOS, Node 20, lint + node --test
├── src/core/                      # extracted pure modules land here (matches "cross-cutting infra, no suffix")
│   ├── vad-segmenter.js           # NEW — pure VAD state machine (lifted from speech.service.js)
│   ├── env-file.js                # NEW — pure parseEnv / formatEnvValue / upsertEnvContent (lifted from main.js + first-run.js)
│   ├── skill-normalizer.js        # NEW — pure normalizeSkillName / injectProgrammingLanguage / skill lists (lifted from prompt-loader.js)
│   └── service-supervisor.js      # NEW — the FND-04 deliverable (exports the CLASS, DI spawn seam)
└── test/                          # NEW — node:test files. `node --test test/*.test.js`
    ├── vad-segmenter.test.js
    ├── env-file.test.js
    ├── skill-normalizer.test.js
    ├── service-supervisor.test.js
    └── fixtures/
        └── dummy-service.js       # trivial spawn-target for the supervisor demo (NOT auto-run: excluded by the *.test.js glob)
```
Rationale for `src/core/`: STRUCTURE.md defines `src/core/` as "infrastructure with no OpenCluely-specific business logic — the kind of code every Electron app needs," named as "bare `<name>.js`, no suffix" (`config.js`, `logger.js`, `first-run.js`, `whisper-installer.js`). The supervisor and the three extracted helpers all fit that description. (Path is Claude's discretion; this is the recommendation.)

### Pattern 1: Export the class + inject the process seam (the locked supervisor shape)
**What:** Follow `WhisperInstaller`/`FirstRunManager` exactly — export the class (plus a named property for symmetry), accept dependencies via a single `options` object, and expose the spawn function as `options.spawn || spawn` so tests can swap it.
**When to use:** `service-supervisor.js` (and this is the constructor shape the three extracted helpers that are classes should follow too).
**Example (verbatim seam pattern from the repo):**
```js
// Source: src/core/whisper-installer.js:126-135 and :624-626 (repo)
class WhisperInstaller {
  constructor(options = {}) {
    this.cwd = options.cwd || process.cwd();
    this.dataDir = options.dataDir || this.cwd;
    this.platform = options.platform || process.platform;
    this.runExec = options.runExec || runExec;   // ← explicit DI seam for swapping process-spawning in tests
  }
}
module.exports = WhisperInstaller;
module.exports.WhisperInstaller = WhisperInstaller;
module.exports.runExec = runExec;
```

### Pattern 2: Extract-and-delegate (the locked extraction approach)
**What:** Move the pure logic into a new standalone module; leave the singleton's public API untouched but have it *delegate* to the module. Zero behavior change, full testability.
**When to use:** All three FND-01 targets.
**Example (VAD — the singleton keeps its method name, delegates to the pure segmenter):**
```js
// AFTER, inside SpeechService (src/services/speech.service.js) — illustrative
const { VadSegmenter } = require('../core/vad-segmenter');
// in _resetVadState(): build config from the existing getters, no behavior change
this._segmenter = new VadSegmenter({
  enabled: this._isVadEnabled(),
  energyFloor: this._getVadEnergyFloor(),
  silenceHangoverMs: this._getSilenceHangoverMs(),
  minUtteranceMs: this._getMinUtteranceMs(),
  maxUtteranceMs: this._getMaxUtteranceMs(),
  preRollMs: this._getPreRollMs(),
});
// in _ingestWhisperAudio(buffer): delegate the DECISION, keep the side effect (whisper flush) here
const action = this._segmenter.ingest(buffer);      // pure: returns {type:'accumulate'|'flush'|'discard'|'noop', buffers?}
if (action.type === 'flush') this._endUtteranceFlush();   // spawn/flush stays in the service
```

### Anti-Patterns to Avoid
- **Requiring the singleton in a test.** `require('../src/services/speech.service')` runs `module.exports = new SpeechService()`, which mutates `global.window` (speech.service.js:1-70), `try/require`s the Azure SDK, and reads `config`/`process.env` at import time (TESTING.md is explicit about this). Tests must require the **extracted pure module only** — never the service.
- **`node --test test/` when fixtures live in `test/`.** See Pitfall 1 — it runs the fixture as a test.
- **A stylistic ESLint plugin / `--fix` reformat.** Locked: rules only, no mass reformat. Do not add `eslint-plugin-*` stylistic packs, Prettier, or `@stylistic`.
- **Letting the supervisor throw or hang on start failure.** Locked: degrade gracefully, surface status. `start()` must always settle; the crash/backoff loop must be guarded against firing after an intentional `stop()`.
- **Killing an adopted process.** Locked hard requirement. `stop()` must be a no-op (detach only) when the supervisor did not spawn the process.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Test discovery/running | A custom runner or `require`-loop over test files | `node --test test/*.test.js` | Built-in, isolates each file in its own child process, stable on Node 20. |
| Assertions | A custom `expect()` | `node:assert/strict` | Ships with Node; `deepStrictEqual`/`throws`/`match` cover this phase. |
| Per-environment globals for lint | Hand-listing `console`, `process`, `window`, `document`, `Buffer`, … | `globals` package (`globals.node`, `globals.browser`) | Maintained, complete, exactly what flat config's docs prescribe. |
| TCP reachability check | Raw socket bookkeeping without timeout/teardown | `net.connect` with `setTimeout` + `once('connect'/'timeout'/'error')` + `destroy()` | Easy to leak sockets or hang without the timeout+destroy discipline (see Code Examples). |
| HTTP health check | `fetch` (adds surface) / manual chunk buffering | `http.get({timeout})` + `res.resume()` | Built-in, no dep; `res.resume()` drains so the socket frees; `timeout` prevents hangs. |
| Orphan/adopt detection | A process-table scanner | Port probe first + optional PID-sidecar file (`fs`) | OpenWhispr's proven approach (OPENWHISPR-NOTES §3.1 / `sidecarPidFile.js`); trivial and cross-platform. |
| `.env` parsing/writing round-trip | A brand-new parser | Consolidate the TWO existing implementations (`first-run.js:_readEnv`, `main.js:persistEnvUpdates`) into one pure module | Logic already exists and is battle-tested for quoted values / Windows paths / inline comments; extract, don't reinvent. |

**Key insight:** This phase should add *no* new algorithm. Every "hard" piece (VAD hysteresis, `.env` quoting, skill mapping, process lifecycle) either already exists in the repo or is a thin composition of Node builtins. The work is *relocation for testability* + *one new orchestration class built from builtins*.

## Common Pitfalls

### Pitfall 1: `node --test test/` runs fixtures as tests (Node 20 discovery rule)
**What goes wrong:** The supervisor demo needs a dummy child process. If that fixture is a `.js` file anywhere under a directory named `test`, `node --test test/` executes it *as a test file* — a long-running dummy server would hang the test run forever.
**Why it happens:** Node 20 docs: *"If a directory named `test` is encountered, the test runner will search it recursively for all `.js`, `.cjs`, and `.mjs` files. All of these files are treated as test files, and do not need to match the specific naming convention."*
**How to avoid:** Invoke tests as `node --test test/*.test.js` (the shell expands the single `*`; only `*.test.js` files run). Keep the fixture at `test/fixtures/dummy-service.js` — it is never passed to node, so it is never run as a test. This invocation is identical on Node 20 (CI) and Node 26 (dev). Do NOT use `**` (globstar) — CLI glob support is Node 21+ only.
**Warning signs:** `make run_tests` hangs; a "test" with no assertions appears in output; the run only ends on Ctrl-C.

### Pitfall 2: Extracting VAD without separating the flush side effect
**What goes wrong:** `_ingestWhisperAudio` (speech.service.js:800-890) both decides segment boundaries *and* triggers `_endUtteranceFlush()` → `_flushWhisperSegment()`, which spawns Whisper. If you lift the whole method, the "pure" module now spawns processes and reads `process.env`/`config`.
**Why it happens:** The method mixes a pure state machine (energy, hysteresis, timers) with an impure action (flush to Whisper) and impure config reads (`_getVadEnergyFloor()` etc. read `process.env`/`config`/`runtimeSettings`).
**How to avoid:** The segmenter takes tuning values as **constructor params** (no `process.env`/`config` import) and `ingest()` **returns an action** (`accumulate`/`flush`/`discard`/`noop`); the service keeps the buffer accumulation + Whisper flush. Pure helpers `rmsEnergy(buffer)` (speech.service.js:781-792) and `chunkDurationMs(buffer)` (`buffer.length / 32`, speech.service.js:904-907) move verbatim as static functions.
**Warning signs:** The test file `require`s `config` or `child_process`; tests need `.env` set; tests are slow.

### Pitfall 3: ESLint 9's `no-unused-vars` `caughtErrors` default flags every `catch (_)` / `catch (e)`
**What goes wrong:** In ESLint 9 the `no-unused-vars` default for `caughtErrors` changed to `'all'`, so unused catch bindings are errors. The repo uses `catch (_) { }` and `catch (e) { }` heavily (`whisper-installer.js`, `first-run.js`, `main.js`), which would produce a flood of errors — contradicting "fix the handful" and "no mass reformat."
**Why it happens:** New ESLint 9 default; the repo predates it.
**How to avoid:** Configure `no-unused-vars` leniently to preserve real signal without churn:
```js
'no-unused-vars': ['error', {
  args: 'after-used',
  argsIgnorePattern: '^_',
  varsIgnorePattern: '^_',
  caughtErrorsIgnorePattern: '^_',   // allows the repo's `catch (_)` idiom
}]
```
Use `caughtErrors: 'none'` instead if you want zero churn on the `catch (e)` bindings that go unused. Unused `event` params in IPC handlers may still surface a handful — rename to `_event` (low-risk) rather than disabling the rule. This is exactly the "fix the handful" the decision anticipates.
**Warning signs:** Hundreds of `no-unused-vars` errors on first run; urge to add a stylistic ignore or `--fix`.

### Pitfall 4: `npm ci` fails because the lockfile wasn't regenerated after adding ESLint
**What goes wrong:** CI uses `npm ci` (correct — lockfile IS committed, STACK.md confirms). But `npm ci` errors hard if `package.json` and `package-lock.json` are out of sync. Adding `eslint`/`globals` to `devDependencies` without committing the updated `package-lock.json` breaks CI immediately.
**Why it happens:** `npm ci` is strict by design.
**How to avoid:** After editing `package.json`, run `npm install` locally to regenerate `package-lock.json`, and commit both. Verify with `npm ci` locally before pushing.
**Warning signs:** CI log: `npm ci can only install packages when your package.json and package-lock.json ... are in sync`.

### Pitfall 5: `postinstall` + `electron` download slow/flaky in the lint+test CI job
**What goes wrong:** `package.json` has `"postinstall": "electron-builder install-app-deps"`, and `npm ci` also triggers the `electron` package's own postinstall (downloads a ~100 MB Electron binary). The lint+test job needs *neither* Electron the binary nor native-dep rebuilds, so this is wasted time and a flakiness source.
**Why it happens:** Lifecycle scripts run on `npm ci` by default.
**How to avoid:** Use `npm ci --ignore-scripts` in `ci.yml`. Lint reads source; `node:test` runs pure modules + spawns plain `node` — neither touches Electron. This is faster and removes a network dependency. (Trade-off: if a future test needed native rebuilds you'd drop the flag; not the case here.)
**Warning signs:** CI minutes dominated by "Downloading electron"; intermittent download timeouts unrelated to code.

### Pitfall 6: Supervisor restart loop firing on intentional stop; sockets/timers leaking
**What goes wrong:** `child.on('exit')` used for crash-detection also fires when `stop()` kills the child → an unwanted "restart" after quit. Health-probe sockets/requests without timeouts hang the whole supervisor.
**Why it happens:** Exit is exit — the handler can't tell crash from intentional kill without a guard; `net`/`http` do not time out by default.
**How to avoid:** Set an `_intentionalStop` flag in `stop()` and check it in the exit handler. Always set `setTimeout`/`timeout` on probes and `destroy()`/`resume()` the socket/response. Clear the backoff timer on `stop()`.
**Warning signs:** Process respawns after `stop()`; a test that never exits; ports left bound after the run.

### Pitfall 7: Redundant `/* eslint-disable no-undef */` becomes an unused-directive warning
**What goes wrong:** `onboarding.js:1` has `/* eslint-disable no-undef */` (a relic — CONVENTIONS.md). Once the renderer block declares browser + app-injected globals, this directive is unnecessary; ESLint 9 flat config reports unused disable directives (default `linterOptions.reportUnusedDisableDirectives: 'warn'`).
**Why it happens:** The disable is no longer needed once globals are scoped correctly.
**How to avoid:** Remove the directive from `onboarding.js` during the lint-fix pass (cleanest), OR set `linterOptions.reportUnusedDisableDirectives: 'off'`. A warning won't fail the errors-only gate, but removing it is tidy. NOTE: `onboarding.js` uses **bare** `electronAPI` (e.g. `onboarding.js:6`), not `window.electronAPI`, so the renderer block MUST declare `electronAPI` (and peers like `Prism`, `marked`, `markdown`, `renderMathInElement`) as globals or `no-undef` will fire.

## Code Examples

### node:test file (CommonJS, requires the extracted pure module)
```js
// Source: verified against Node v20 test runner docs (nodejs.org/docs/latest-v20.x/api/test.html)
// test/env-file.test.js
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { parseEnv, formatEnvValue, upsertEnvContent } = require('../src/core/env-file');

describe('formatEnvValue', () => {
  test('wraps values with whitespace in single quotes', () => {
    assert.equal(formatEnvValue('a b'), "'a b'");
  });
  test('preserves backslashes for Windows paths', () => {
    assert.equal(formatEnvValue('C:\\Users\\Jane Doe\\python.exe'), "'C:\\Users\\Jane Doe\\python.exe'");
  });
  test('collapses newlines to spaces', () => {
    assert.equal(formatEnvValue('a\nb'), "'a b'");
  });
});

describe('upsertEnvContent', () => {
  test('replaces an existing key in place and preserves comments', () => {
    const out = upsertEnvContent('# note\nWHISPER_MODEL=turbo\n', { WHISPER_MODEL: 'base' });
    assert.match(out, /^# note$/m);
    assert.match(out, /^WHISPER_MODEL=base$/m);
  });
  test('appends a genuinely new key', () => {
    const out = upsertEnvContent('A=1\n', { B: '2' });
    assert.match(out, /^B=2$/m);
  });
});
```

### `eslint.config.js` (flat, CommonJS, lean, three scoped blocks)
```js
// Source: eslint.org/docs/latest/use/configure/configuration-files + /language-options (verified 2026-07)
// eslint.config.js  — CommonJS (package.json has no "type":"module")
const globals = require('globals');

const leanRules = {
  'no-undef': 'error',
  'no-unused-vars': ['error', {
    args: 'after-used',
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    caughtErrorsIgnorePattern: '^_',   // repo idiom: catch (_) {}
  }],
  // add a few more real-bug rules here as the fix pass reveals need:
  // 'no-dupe-keys', 'no-unreachable', 'no-cond-assign', 'no-constant-condition'
};

module.exports = [
  // 0) Global ignores — vendored / generated / separate mini-project
  { ignores: [
      'node_modules/**', 'dist/**', '.venv-whisper/**', '.whisper-models/**',
      'lib/markdown.js',            // vendored 1725-line third-party parser
      'assests/vendor/**',          // vendored Font Awesome (note misspelling)
      'webapp/**',                  // standalone marketing site (out of scope)
  ] },

  // 1) Main process + preload + scripts + tests + config = Node/CommonJS
  {
    files: [
      'main.js', 'preload.js', 'prompt-loader.js', 'speech-recognition.js',
      'src/core/**/*.js', 'src/managers/**/*.js', 'src/services/**/*.js',
      'scripts/**/*.js', 'test/**/*.js', 'eslint.config.js', 'tailwind.config.js',
    ],
    languageOptions: {
      ecmaVersion: 2022,             // parses ?. and ?? used in the repo
      sourceType: 'commonjs',        // enables require/module/exports/__dirname globals
      globals: { ...globals.node },
    },
    rules: leanRules,
  },

  // 2) Renderer / browser controllers = browser globals + app-injected names
  {
    files: ['src/ui/**/*.js', 'onboarding.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',          // classic <script>, not modules
      globals: {
        ...globals.browser,
        // app-injected runtime globals (referenced bare in some files):
        electronAPI: 'readonly', api: 'readonly',
        markdown: 'readonly', marked: 'readonly',
        renderMathInElement: 'readonly', Prism: 'readonly',
        mainWindowUI: 'writable',
      },
    },
    rules: leanRules,
  },
];
```
Notes: (a) ESLint auto-ignores `node_modules`; it's listed above only for clarity. (b) No `@eslint/js` needed for this lean set. (c) The exact rule list beyond `no-undef`/`no-unused-vars` is Claude's discretion — start minimal, add real-bug rules as the fix pass surfaces genuine issues. (d) `sourceType: 'commonjs'` is essential; the flat-config default is `'module'`, which would misparse `require`/`module`.

### Makefile (4 locked targets; recipes MUST be tab-indented)
```make
# Source: standard GNU Make + npm conventions; npm ci requires the committed lockfile (STACK.md)
.PHONY: setup setup-dev run_tests lint

# Runtime deps + Electron (electron is a devDependency; the app can't run without it).
# npm ci is reproducible from the committed package-lock.json.
setup:
	npm ci

# Dev/test/lint tooling. ESLint (+globals) is a devDependency, so npm ci already
# installs it; kept distinct per the fixed target convention.
setup-dev: setup

# Pure-logic + supervisor tests. Uses system Node's built-in runner (no Electron).
# Single-* glob is shell-expanded and portable to Node 20 (CI) and newer (dev);
# excludes test/fixtures/** so the supervisor dummy process is never run as a test.
run_tests:
	node --test test/*.test.js

# Error-only lint gate (eslint exits non-zero on any error).
lint:
	npx eslint .
```
Caveats to hand to the planner: recipe lines are **tabs, not spaces** (Make requirement). `run_tests` needs only Node (no `node_modules`), but `lint` needs ESLint installed, so on a clean checkout the order is `make setup-dev` (or `make setup`) before `make lint`. SC1 ("all four run and succeed on a clean checkout") is met by running setup first; document that order. If you prefer `lint`/`run_tests` to self-provision, add a `node_modules` sentinel prerequisite — optional, adds complexity.

### CI workflow (NEW `.github/workflows/ci.yml`)
```yaml
# Source: verified against actions/setup-node@v4 + release.yml conventions already in repo
name: CI
on:
  pull_request:              # gates lint on ALL PRs (FND-02 SC2)
  push:
    branches: [main]
jobs:
  check:
    name: Lint & Test (${{ matrix.os }})
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'        # resolves to latest 20.x (>=20.19)
          cache: 'npm'
      - run: npm ci --ignore-scripts   # skip Electron binary download (not needed for lint/test) — Pitfall 5
      - run: npx eslint .              # lint gate — a lint error fails the job
      - run: node --test test/*.test.js
```

### ServiceSupervisor — recommended class API (the FND-04 deliverable)
```js
// Source: synthesized from Node builtins (child_process/net/http/fs) + WhisperInstaller DI shape
//         + OpenWhispr PID-sidecar/health-check patterns (OPENWHISPR-NOTES §3.1). Design, not verbatim.
// src/core/service-supervisor.js
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const EventEmitter = require('events');
const logger = require('./logger').createServiceLogger('SUPERVISOR');

// ── Health probes (pure-ish, timeout-bounded, never hang) ──
function probePort({ host = '127.0.0.1', port, timeoutMs = 1000 }) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let done = false;
    const finish = (ok) => { if (done) return; done = true; socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}
function probeHttp({ host = '127.0.0.1', port, path = '/', timeoutMs = 1000 }) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path, timeout: timeoutMs }, (res) => {
      res.resume();                       // drain so the socket frees
      resolve(res.statusCode > 0);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

class ServiceSupervisor extends EventEmitter {
  // definition = { name, command, args, cwd?, env?, healthCheck, backoff, startupTimeoutMs?, adopt?, pidFile?, terminate? }
  //   healthCheck = { type:'port'|'http', host, port, path?, timeoutMs? }
  //   backoff     = { initialDelayMs, multiplier, maxDelayMs, maxRetries }
  //   terminate   = { sigtermGraceMs }
  constructor(definition, options = {}) {
    super();
    this.def = definition;
    this.spawn = options.spawn || spawn;        // ← DI seam (WhisperInstaller pattern)
    this.logger = options.logger || logger;
    this.child = null;
    this.owned = false;                          // true only if WE spawned it
    this.state = 'idle';                         // idle|starting|healthy|restarting|failed|stopped|adopted
    this.attempt = 0;
    this._intentionalStop = false;
    this._backoffTimer = null;
  }

  getStatus() { return { name: this.def.name, state: this.state, attempt: this.attempt,
                         pid: this.child ? this.child.pid : null, owned: this.owned }; }
  _setState(state, extra = {}) { this.state = state; this.emit('status', this.getStatus()); 
                                 this.logger.info('supervisor state', { state, ...extra }); }

  async _probe() {
    const hc = this.def.healthCheck;
    return hc.type === 'http' ? probeHttp(hc) : probePort(hc);
  }

  async start() {
    this._intentionalStop = false;
    // ADOPT-IF-PRESENT: something already healthy on the endpoint AND we didn't spawn it → adopt, never own.
    if (this.def.adopt && await this._probe()) {
      this.owned = false;
      this._setState('adopted');                 // NOTE: stop() must NOT kill this
      return this.getStatus();
    }
    return this._spawnAndWait();                  // OWN-IF-STARTED
  }

  async _spawnAndWait() {
    this._setState('starting', { attempt: this.attempt });
    const { command, args = [], cwd, env } = this.def;
    try {
      this.child = this.spawn(command, args, { cwd, env: env ? { ...process.env, ...env } : process.env,
                                               windowsHide: true });
    } catch (e) { return this._onStartFailure(e.message); }

    this.owned = true;
    if (this.def.pidFile) { try { require('fs').writeFileSync(this.def.pidFile, String(this.child.pid)); } catch (_) {} }

    this.child.on('error', (err) => this._onStartFailure(err.message));
    this.child.on('exit', (code, signal) => {
      if (this._intentionalStop) return;         // guard: not a crash — Pitfall 6
      this.logger.warn('managed process exited', { code, signal });
      this._scheduleRestart();
    });

    const healthy = await this._waitHealthy(this.def.startupTimeoutMs || 30000);
    if (healthy) { this.attempt = 0; this._setState('healthy', { pid: this.child.pid }); return this.getStatus(); }
    return this._onStartFailure('health check did not pass within startup timeout');
  }

  async _waitHealthy(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this._probe()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  _onStartFailure(reason) {
    this.logger.error('managed process failed to start', { reason });
    this._scheduleRestart(reason);
    return this.getStatus();
  }

  _scheduleRestart(reason) {
    const b = this.def.backoff;
    if (this.attempt >= b.maxRetries) { this._setState('failed', { reason }); return; }  // give up + surface
    const delay = Math.min(b.maxDelayMs, b.initialDelayMs * (b.multiplier ** this.attempt));
    this.attempt += 1;
    this._setState('restarting', { attempt: this.attempt, delayMs: delay });
    this._backoffTimer = setTimeout(() => { if (!this._intentionalStop) this._spawnAndWait(); }, delay);
  }

  async stop() {
    this._intentionalStop = true;
    if (this._backoffTimer) clearTimeout(this._backoffTimer);
    // NEVER kill an adopted process — locked hard requirement (SC4)
    if (!this.owned || !this.child) { this._setState('stopped'); return; }
    const child = this.child, grace = (this.def.terminate && this.def.terminate.sigtermGraceMs) || 5000;
    child.kill('SIGTERM');                                            // SIGTERM …
    const exited = await new Promise((res) => {
      const t = setTimeout(() => res(false), grace);
      child.once('exit', () => { clearTimeout(t); res(true); });
    });
    if (!exited) child.kill('SIGKILL');                              // … then SIGKILL (SC3)
    if (this.def.pidFile) { try { require('fs').unlinkSync(this.def.pidFile); } catch (_) {} }
    this._setState('stopped');
  }
}
module.exports = ServiceSupervisor;
module.exports.ServiceSupervisor = ServiceSupervisor;
module.exports.probePort = probePort;
module.exports.probeHttp = probeHttp;
```

### Both future consumers fit this contract WITHOUT reshaping (the locked design check)
```js
// Ollama (Phase 3, PROV-05) — HTTP health check, adopt a user's pre-running `ollama serve`
new ServiceSupervisor({
  name: 'ollama', command: 'ollama', args: ['serve'],
  healthCheck: { type: 'http', host: '127.0.0.1', port: 11434, path: '/', timeoutMs: 1000 },
  backoff: { initialDelayMs: 500, multiplier: 2, maxDelayMs: 30000, maxRetries: 5 },
  adopt: true,                                     // never kill a system-managed ollama
});
// whisper-server (Phase 4, STT-01) — TCP port probe, own it, PID sidecar for orphan reaping
new ServiceSupervisor({
  name: 'whisper-server', command: whisperServerBin, args: ['--port', String(port)],
  healthCheck: { type: 'port', host: '127.0.0.1', port, timeoutMs: 1000 },
  backoff: { initialDelayMs: 500, multiplier: 2, maxDelayMs: 15000, maxRetries: 5 },
  adopt: false, pidFile: path.join(dataDir, '.whisper-server.pid'),
  terminate: { sigtermGraceMs: 5000 },
});
```
Pre-warm-on-launch (P3/P4) is simply *calling `start()` at `app.whenReady()`*; wake-rewarm is *calling `start()` again on `powerMonitor 'resume'`* — `start()` is idempotent (adopts the still-healthy process, or respawns). The contract does not preclude either. (Deferred: do NOT implement them now.)

### Supervisor demo test + fixture (drives all of SC3/SC4)
```js
// test/fixtures/dummy-service.js — trivial spawn target. Lives OUTSIDE the *.test.js glob, so it is
// NEVER auto-run as a test (Pitfall 1). Modes let one fixture exercise every path.
const http = require('http');
const port = Number(process.argv[2] || 0);
const mode = process.argv[3] || 'ok';            // 'ok' | 'ignore-sigterm' | 'crash-once'
if (mode === 'ignore-sigterm') process.on('SIGTERM', () => { /* force the SIGKILL path */ });
const server = http.createServer((_req, res) => res.end('ok'));
server.listen(port, '127.0.0.1', () => process.stdout.write(`LISTENING ${server.address().port}\n`));

// test/service-supervisor.test.js — sketch of the demo scenarios (use tiny backoff for speed/determinism)
// 1) spawn + health-check → start() resolves, getStatus().state === 'healthy'
// 2) restart-with-backoff → child.kill() → 'restarting' emitted → returns to 'healthy'
// 3) give-up → command that never becomes healthy → after maxRetries state==='failed', run does NOT hang
// 4) terminate SIGTERM→SIGKILL → fixture in 'ignore-sigterm' mode → stop() still reaps it via SIGKILL
// 5) adopt-vs-own → pre-start a foreign server on the port; adopt:true → start() marks 'adopted';
//    stop() leaves the foreign server ALIVE (assert it still responds) — the SC4 guarantee
// Use REAL spawn here (proves actual process management). Backoff math can also get a separate
// pure unit test. Fixture spawned via command: process.execPath, args:[fixturePath, port, mode].
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Jest/Mocha + config + deps | `node:test` + `node --test` (built-in) | Stable in Node 20.0.0 | Zero deps; locked choice; exactly right for this repo. |
| `.eslintrc.*` + `env:` key | `eslint.config.js` flat config + `languageOptions.globals` (from `globals` pkg) | Default in ESLint 9 (2024); required in 10 | `env: browser/node` no longer exists; per-file scoping via `files` blocks. |
| CLI globs `node --test 'test/**/*.js'` | Explicit files/dirs OR shell-expanded single-`*` | CLI globs added Node **21** | On Node 20 (CI) use `test/*.test.js` (shell-expanded) or a dir path — NOT `**`. |
| In-process native STT addon | Supervised out-of-process server on loopback, health-checked | OpenWhispr production choice | Validates the "generic supervisor" bet — same shape serves whisper-server AND ollama. |

**Deprecated/outdated for this repo:**
- `speech-recognition.js` (root) — 3-line legacy re-export; do not build tests around it (TESTING.md).
- `onboarding.js:1` `/* eslint-disable no-undef */` — relic; remove once renderer globals are scoped (Pitfall 7).
- Tailwind config / `dist/output.css` — vestigial, no build wired; ignore in ESLint, irrelevant to this phase.

## Open Questions

1. **ESLint 9 vs 10 pin.**
   - What we know: latest is 10.7.0 (engine Node ≥20.19); 9.x maintenance is 9.39.5 (engine Node `^20.9`+); `setup-node '20'` currently gives Node 20.20.2 (≥20.19), so both install.
   - What's unclear: whether the team wants newest (10) or maximal Node-20 safety (9). Both produce the same flat-config shape and the same lean rules.
   - Recommendation: pin `eslint@^9` for lowest risk on the Node-20 target; note 10 is acceptable if Node ≥20.19 is guaranteed in CI. Either way, `globals` latest works.

2. **Exact set of real-bug rules beyond `no-undef`/`no-unused-vars`.**
   - What we know: decision says "lean, high-signal, fix the handful," gate on errors.
   - What's unclear: which additional rules (if any) surface genuine bugs in the god-files without demanding a reformat.
   - Recommendation: start with just the two named rules, run once, and add from a small real-bug set (`no-dupe-keys`, `no-unreachable`, `no-cond-assign`, `no-constant-condition`, `no-unsafe-negation`) only where the first run shows real issues. (Discretion — planner/implementer decides during the fix pass.)

3. **`skill-normalizer` extraction depth.**
   - What we know: `prompt-loader.js` ALREADY exports the class with a cheap constructor, so `new PromptLoader()` can test `normalizeSkillName`/`injectProgrammingLanguage`/`requiresProgrammingLanguage`/`getAvailableSkills` today; only `getSkillPrompt`/`loadPrompts` touch `fs`.
   - What's unclear: whether to extract at all vs. test the class directly.
   - Recommendation: extract the pure bits (`normalizeSkillName` + `skillMap`, `injectProgrammingLanguage`, the `['dsa']` lists) into `src/core/skill-normalizer.js` and delegate, for fs-independence and consistency with the other two — but this is the lowest-risk target and testing `new PromptLoader()` directly is a legitimate fallback if extraction risk is judged not worth it.

4. **Supervisor backoff constants + status/event shape.**
   - What we know: policy locked (exponential, capped, give-up-after-N, surface status); constants and shape are explicitly Claude's discretion.
   - Recommendation: the values in the Code Examples (`initialDelayMs 500`, `multiplier 2`, `maxDelayMs 15000–30000`, `maxRetries 5`) and the `EventEmitter` `'status'` event with `getStatus()` snapshot are sensible defaults; tests should use tiny values (e.g. `initialDelayMs 10`, `maxRetries 3`) for speed/determinism. Final choice belongs to the planner/implementer.

## Sources

### Primary (HIGH confidence)
- **Repo source (authoritative, read directly):** `src/services/speech.service.js` (VAD: `_resetVadState` 716-725, `_ingestWhisperAudio` 800-890, `_chunkRmsEnergy` 781-792, `_chunkDurationMs` 904-907, VAD getters 1217-1266, `global.window` polyfill 1-70, singleton export 1847); `main.js` (`resolveEnvPath` 12-26, `formatEnvValue` 34-40, `persistEnvUpdates` 1659-1719); `prompt-loader.js` (`normalizeSkillName` 319-361, `injectProgrammingLanguage` 80-106, `getAvailableSkills` 367-372, exports 405-408); `src/core/whisper-installer.js` (DI seam 126-135, `runExec` 31-124, exports 624-626); `src/core/first-run.js` (`_readEnv` parser 93-126, class-export shape); `src/core/logger.js` (`createServiceLogger` 64-72); `preload.js` (1-30); `package.json` (scripts, deps, `postinstall`); `.github/workflows/release.yml` (existing tag-only CI); `.gitignore`.
- **Codebase intel (authoritative):** `.planning/codebase/TESTING.md`, `CONVENTIONS.md`, `STRUCTURE.md`, `STACK.md`.
- **Node.js v20 Test Runner docs** — https://nodejs.org/docs/latest-v20.x/api/test.html — discovery patterns, directory-arg support, NO CLI globs on v20, separate-child-process execution, Stability 2 (no flag).
- **`npm view` (live, 2026-07-13):** `eslint` latest 10.7.0 / maintenance 9.39.5, engine `^20.19.0 || ^22.13.0 || >=24`; `@eslint/js` 10.0.1; `globals` 17.7.0. Local Node v26.5.0, npm 11.17.0. Committed `package-lock.json` present.
- **ESLint flat config docs** — https://eslint.org/docs/latest/use/configure/configuration-files and https://eslint.org/docs/latest/use/configure/language-options — `languageOptions.globals`, `sourceType: 'commonjs'`, `files` scoping, `env:` removed.
- **`.planning/research/OPENWHISPR-NOTES.md`** — supervised-loopback-server pattern, PID sidecar (`sidecarPidFile.js`), health-check polling, SIGTERM→SIGKILL, adopt/reuse for the two future consumers.

### Secondary (MEDIUM confidence)
- ESLint migration guide (https://eslint.org/docs/latest/use/configure/migration-guide) and community flat-config write-ups (tsmx.net CommonJS migration) — corroborate the CommonJS `sourceType`/`globals` shape.
- ESLint 9 `no-unused-vars` `caughtErrors` default change to `'all'` — cross-referenced from ESLint 9 migration notes; mitigation (`caughtErrorsIgnorePattern`) is standard.

### Tertiary (LOW confidence)
- None relied upon. All load-bearing claims verified against versioned docs or repo source.

## Metadata

**Confidence breakdown:**
- Standard stack (node:test, ESLint, builtins): HIGH — verified against versioned Node 20 docs, live `npm view`, and repo source.
- Extraction approach (3 targets): HIGH — the exact source of every target was read; the pure/impure split is explicit in the code.
- Test invocation / discovery gotcha: HIGH — quoted from Node v20 docs; the `test/` directory-vs-glob behavior is the key finding.
- Lint config specifics: HIGH for shape/versions; MEDIUM for the *exact* final rule list (intentionally left to the fix pass per the lean decision).
- CI workflow: HIGH — mirrors the repo's existing `release.yml` conventions; `npm ci`/lockfile/postinstall behaviors verified.
- ServiceSupervisor design: MEDIUM-HIGH — the Node builtins (`spawn`/`net`/`http`/`fs`) are HIGH; the specific class API is a synthesized recommendation (design), and backoff constants/status shape are explicitly discretionary.

**Research date:** 2026-07-13
**Valid until:** ~2026-08-13 (30 days — `node:test` and ESLint flat config are stable/slow-moving; re-verify the ESLint 9-vs-10 pin only if the CI Node minor drops below 20.19).
