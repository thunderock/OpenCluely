---
phase: 01-foundation-supervisor-tests-lint-makefile
verified: 2026-07-14T04:51:21Z
status: passed
score: 4/4 success criteria verified (13/13 artifacts, 11/11 key links)
---

# Phase 1: Foundation — Supervisor, Tests, Lint, Makefile Verification Report

**Phase Goal:** The repo has a safety net (tests + lint + Makefile) so the 1600+ line god-files can be refactored safely, and a generic supervisor that can manage any long-running local process (written once, configured later for both the model server and the STT server).
**Verified:** 2026-07-14T04:51:21Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `make setup`, `make setup-dev`, `make run_tests`, `make lint` all run and succeed on a clean checkout | ✓ VERIFIED | `Makefile` has exactly the 4 locked tab-indented targets (`cat -te Makefile` confirms `^I` tab recipes). `make run_tests` → 38/38 tests pass, 6 suites, 0.97s, exits 0. `make lint` → `npx eslint .` exits 0. `make -n setup setup-dev run_tests lint` shows correct recipes (`npm ci`, nothing extra for setup-dev since it depends on setup, `node --test test/*.test.js`, `npx eslint .`). `setup`/`setup-dev` verified non-destructively per task instructions: `npm ci --dry-run` exits 0 reporting "up to date" (package.json↔package-lock.json parity confirmed programmatically — root `dependencies`/`devDependencies` match the lockfile's root package entry exactly); `node_modules/electron` is only 900K metadata (no `dist/` binary), confirming the environment still reflects the intended `--ignore-scripts` install (no destructive Electron download was forced during verification). |
| 2 | `make run_tests` covers VAD segmentation, `.env` parse, skill/prompt normalization; a lint violation fails the CI lint gate (CI runs `npx eslint .`, non-zero on violation) | ✓ VERIFIED | All three pure-logic suites present and passing: `test/env-file.test.js` (16 cases), `test/skill-normalizer.test.js` (9 cases), `test/vad-segmenter.test.js` (6 cases), plus `test/service-supervisor.test.js` (7 cases) — 38 total, 6 describe-suites, 0 failures. `.github/workflows/ci.yml` parses as valid YAML (`python3 -c "import yaml..."` succeeded) and its steps run `npm ci --ignore-scripts` → `npx eslint .` → `node --test test/*.test.js` on `pull_request` + `push: branches:[main]` across `ubuntu-latest`+`macos-latest` on Node 20. Lint-gate acceptance shape demonstrated live: wrote `src/core/__lint_probe.js` containing an undefined global reference, `npx eslint src/core/__lint_probe.js` exited 1 with a `no-undef` error, file removed, `npx eslint .` clean again (exit 0), `git status` clean. |
| 3 | `ServiceSupervisor` spawns a process, health-checks it (port/HTTP), restarts with backoff after being killed, terminates on quit (SIGTERM→SIGKILL) — demonstrated by a test | ✓ VERIFIED | `src/core/service-supervisor.js` (271 lines) implements the hardened lifecycle exactly as designed. `test/service-supervisor.test.js` real-spawns `test/fixtures/dummy-service.js` via `process.execPath` and proves, with real OS processes: spawn→healthy (owned=true, numeric pid); `process.kill(pid,'SIGKILL')` → supervisor emits `'restarting'` → returns to `'healthy'` with a new pid; `mode:'crash'` + `maxRetries:2` → terminal `'failed'` state reached without hanging; `mode:'ignore-sigterm'` → `stop()` escalates SIGTERM→SIGKILL and awaits reaping (`process.kill(pid,0)` throws ESRCH afterward). All 7 cases pass. |
| 4 | Supervisor supports adopt-if-present / own-if-started; never kills a process it did not start | ✓ VERIFIED | `start()`: `if (this.def.adopt && await this._probe()) { this.owned = false; this._setState('adopted'); return ...; }` (never spawns). `stop()`: `if (!this.owned || !this.child || alreadyExited) { this._setState('stopped'); return; }` — a strict no-kill path for anything not owned. Test `'adopt: adopts a foreign process and stop() leaves it alive'` starts a real foreign `http.createServer` NOT via the supervisor, supervisor adopts it (`state==='adopted'`, `owned===false`, `pid===null`), `stop()` is called, and the foreign server is proven still alive afterward via both `probePort` and `probeHttp` returning `true`. Passes. |

**Score:** 4/4 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/core/env-file.js` | Pure `.env` parse/format/upsert helpers | ✓ VERIFIED | 86 lines (≥40). Exports exactly `parseEnv`, `formatEnvValue`, `upsertEnvContent`. Zero `require(...)` calls (fully pure — no fs/process.env/config). |
| `src/core/skill-normalizer.js` | Pure skill normalization + language injection | ✓ VERIFIED | 85 lines (≥40). Exports `normalizeSkillName`, `injectProgrammingLanguage`, `SKILLS_REQUIRING_PROGRAMMING_LANGUAGE`. Zero requires. |
| `test/env-file.test.js` | node:test coverage of `.env` round-trip | ✓ VERIFIED | Requires only `../src/core/env-file`; 16 passing cases (format quoting/backslash/newline/fallback, parse quoting/CRLF/inline-comment, upsert replace/append/preserve, round-trip). |
| `test/skill-normalizer.test.js` | node:test coverage of skill normalization | ✓ VERIFIED | Requires only `../src/core/skill-normalizer`; 9 passing cases (alias mapping, DSA/default injection, fence tags, language title-casing, skills list). |
| `src/core/vad-segmenter.js` | Pure VAD state machine | ✓ VERIFIED | 153 lines (≥60). `class VadSegmenter` present; static `rmsEnergy`/`chunkDurationMs`; `ingest()` returns `accumulate\|flush\|discard\|noop`. Zero requires (pure). |
| `test/vad-segmenter.test.js` | node:test coverage of VAD onset/flush/discard/max-utterance | ✓ VERIFIED | Requires only `../src/core/vad-segmenter`; 6 passing cases (static helpers, onset+pre-roll, flush-on-pause, discard-noise, max-utterance flush, endUtterance reset). |
| `src/core/service-supervisor.js` | Generic FND-04 supervisor | ✓ VERIFIED | 271 lines (≥110). `class ServiceSupervisor` present; exports `ServiceSupervisor`, `probePort`, `probeHttp`, `computeBackoffDelay`. |
| `test/fixtures/dummy-service.js` | Trivial spawn target (ok/ignore-sigterm/crash) | ✓ VERIFIED | 24 lines (≥10). Lives under `test/fixtures/`; confirmed NOT executed by `node --test test/*.test.js` (no `dummy-service` test in output; no leftover process after the run). |
| `test/service-supervisor.test.js` | Demo suite proving SC3+SC4 | ✓ VERIFIED | Requires `../src/core/service-supervisor`; uses `process.execPath` (real spawn); 7 passing cases. |
| `eslint.config.js` | Flat ESLint 9 config | ✓ VERIFIED | 79 lines (≥30). Contains `sourceType`; 3 blocks (global ignores, Node/CommonJS, renderer/browser). |
| `package.json` | eslint + globals as devDependencies | ✓ VERIFIED | `devDependencies: { electron, electron-builder, eslint: "^9.39.5", globals: "^17.7.0" }`. |
| `Makefile` | 4 locked targets | ✓ VERIFIED | 28 lines (≥10). Contains `run_tests`; recipe lines are tab-indented (`cat -te` shows `^I`). |
| `.github/workflows/ci.yml` | CI lint+test gate | ✓ VERIFIED | 35 lines (≥20). Contains `pull_request`; parses as valid YAML; separate from unmodified `release.yml`. |

**13/13 artifacts VERIFIED** — none missing, none stub.

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `main.js` | `src/core/env-file.js` | `require("./src/core/env-file")` + `upsertEnvContent` in `persistEnvUpdates` | ✓ WIRED | Line 4: `const { upsertEnvContent } = require("./src/core/env-file");`. `persistEnvUpdates` builds content via `upsertEnvContent(existing, updates)`, keeps the `process.env` mutation loop + atomic write. Local `function formatEnvValue` no longer exists in main.js (grep returns nothing). |
| `src/core/first-run.js` | `src/core/env-file.js` | `parseEnv` in `_readEnv` | ✓ WIRED | Line 4: `const { parseEnv } = require('./env-file');`. `_readEnv()` body: `return parseEnv(fs.readFileSync(this.envPath, 'utf8'));` with unchanged try/catch fallback. |
| `prompt-loader.js` | `src/core/skill-normalizer.js` | delegation in `normalizeSkillName`/`injectProgrammingLanguage` | ✓ WIRED | Line 3: `const skillNormalizer = require('./src/core/skill-normalizer');`. Both methods delegate; constructor spreads `SKILLS_REQUIRING_PROGRAMMING_LANGUAGE`. Runtime-verified: `require('./prompt-loader.js').promptLoader.normalizeSkillName('DSA') === 'dsa'`, export shape `{ PromptLoader, promptLoader }` unchanged. |
| `src/services/speech.service.js` | `src/core/vad-segmenter.js` | `this._segmenter.ingest(buffer, tuning)` in `_ingestWhisperAudio` | ✓ WIRED | `_ingestWhisperAudio` builds a tuning object from the live getters each call and routes to `this._segmenter.ingest(...)`; `action.type` drives accumulate/flush/discard. Legacy VAD-disabled branch left byte-identical. |
| `src/services/speech.service.js` | `src/core/vad-segmenter.js` | `require('../core/vad-segmenter')` | ✓ WIRED | Line 389: `const VadSegmenter = require('../core/vad-segmenter');`; constructed at line 428 (`this._segmenter = new VadSegmenter();`). |
| `src/core/service-supervisor.js` | `child_process.spawn` | `options.spawn \|\| spawn` DI seam | ✓ WIRED | `this.spawn = options.spawn \|\| spawn;` in constructor; used in `_attemptStart()`. |
| `test/service-supervisor.test.js` | `test/fixtures/dummy-service.js` | real spawn via `process.execPath` + fixture path | ✓ WIRED | `command: process.execPath, args: [fixturePath, String(port), mode]`; all 7 tests exercise real child processes. |
| `src/core/service-supervisor.js` | `src/core/logger.js` | `createServiceLogger('SUPERVISOR')` | ✓ WIRED | Line 29: `const logger = require('./logger').createServiceLogger('SUPERVISOR');`. |
| `eslint.config.js` | `globals` package | `languageOptions.globals = globals.node / globals.browser` | ✓ WIRED | Block 1: `globals: { ...globals.node }`; Block 2: `globals: { ...globals.browser, ... }`. `require('globals')` resolves successfully. |
| `package.json` | `package-lock.json` | lockfile regenerated after adding devDeps | ✓ WIRED | Both list `eslint@^9.39.5` / `globals@^17.7.0`; `npm ci --dry-run` reports "up to date" (no drift). |
| `Makefile` / `.github/workflows/ci.yml` | `node --test`, `eslint` | `run_tests`/`lint` targets; CI steps | ✓ WIRED | `Makefile`: `run_tests: node --test test/*.test.js`, `lint: npx eslint .`. `ci.yml`: `npm ci --ignore-scripts` → `npx eslint .` → `node --test test/*.test.js`, matching local commands exactly (local == CI). |

**11/11 key links WIRED.**

### Requirements Coverage

| Requirement | Status | Blocking Issue |
|-------------|--------|-----------------|
| FND-01 (automated test suite via `make run_tests`, covering VAD/`.env`/skill-prompt) | ✓ SATISFIED | None — all three pure-logic modules extracted, tested, and running via `make run_tests`. |
| FND-02 (lint/format via `make lint` + CI lint gate on pushes/PRs) | ✓ SATISFIED | None — `eslint.config.js` + `Makefile lint` + `ci.yml` all confirmed; violation-fails-gate shape proven locally. |
| FND-03 (`Makefile` with `setup`/`setup-dev`/`run_tests`/`lint`) | ✓ SATISFIED | None — exactly these 4 targets exist, tab-indented, all succeed. |
| FND-04 (generic `ServiceSupervisor`: spawn/health-check/restart-backoff/stop-on-quit) | ✓ SATISFIED | None — implemented and proven end-to-end by real-spawn tests, including adopt/own semantics. |

### Anti-Patterns Found

Scanned every phase-authored/modified file (`src/core/env-file.js`, `src/core/skill-normalizer.js`, `src/core/vad-segmenter.js`, `src/core/service-supervisor.js`, `main.js`, `src/core/first-run.js`, `prompt-loader.js`, `src/services/speech.service.js`, `test/*.test.js`, `test/fixtures/dummy-service.js`, `eslint.config.js`, `onboarding.js`, `src/managers/window.manager.js`, `src/services/llm.service.js`, `src/core/whisper-installer.js`, `Makefile`, `.github/workflows/ci.yml`) for `TODO|FIXME|XXX|HACK|PLACEHOLDER`, "coming soon"/"not implemented", and empty-return stubs.

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| — | — | none found | — | No blockers, warnings, or stub markers in any phase-authored file. |

### Human Verification Required

No items block phase completion. One optional follow-up is noted for full end-to-end confidence, matching what the phase's own SUMMARY already flagged:

1. **Live GitHub Actions confirmation**
   **Test:** Push the `gsd/phase-01-foundation-supervisor-tests-lint-makefile` branch (or open a PR) and watch the `CI` workflow run on both `ubuntu-latest` and `macos-latest`.
   **Expected:** Both matrix legs go green (`npm ci --ignore-scripts` → `npx eslint .` → `node --test test/*.test.js` all succeed), confirming the workflow behaves identically to the local runs verified here.
   **Why human:** Per the user's global delivery policy this agent never pushes or opens PRs automatically. The workflow file was validated (valid YAML, correct triggers/matrix/steps) and the exact commands it runs were proven to succeed locally — this is a confirmatory step only, not a source of new risk.

### Gaps Summary

None. All 4 ROADMAP success criteria are verified against the live codebase (not just SUMMARY claims): the four Makefile targets exist with correct recipes and the two runtime-verifiable ones (`run_tests`, `lint`) both succeed live (38/38 tests, 6 suites, exit 0); the three pure-logic modules (`env-file.js`, `skill-normalizer.js`, `vad-segmenter.js`) are genuinely pure (zero `require` calls) and their singleton call-sites (`main.js`, `first-run.js`, `prompt-loader.js`, `speech.service.js`) delegate to them with the legacy paths left byte-identical (confirmed by direct source reading, not just grep); `ServiceSupervisor` implements and a real-process test suite proves spawn, dual-mode health-check, backoff restart, give-up, SIGTERM→SIGKILL, and adopt-never-kill; the ESLint 9 flat config covers every hand-written file in the repo (spot-checked via `--print-config` that `lib/mathrender.js` receives real rules while vendored `lib/markdown.js`/`webapp/**` are genuinely ignored) and a live lint-probe proved the gate fails non-zero on a real violation; the CI workflow wires the identical local commands into `pull_request`/`push:main` across the required OS/Node matrix. No stubs, no orphaned artifacts, no anti-patterns, no regressions. The only unverifiable item (an actual green run on GitHub's hosted runners) is explicitly out of scope for local/automated verification under the no-auto-push policy and does not gate phase completion.

---

*Verified: 2026-07-14T04:51:21Z*
*Verifier: Claude (gsd-verifier)*
