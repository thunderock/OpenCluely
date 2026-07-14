---
phase: 01-foundation-supervisor-tests-lint-makefile
plan: 4
subsystem: tooling
tags: [eslint, lint, flat-config, globals, eslint9, code-quality]

# Dependency graph
requires:
  - phase: 01-01
    provides: src/core/env-file.js + skill-normalizer.js + their test files (must lint clean)
  - phase: 01-02
    provides: src/core/vad-segmenter.js + vad-segmenter.test.js (must lint clean)
  - phase: 01-03
    provides: src/core/service-supervisor.js + service-supervisor.test.js + fixtures (must lint clean)
provides:
  - ESLint 9 flat config (eslint.config.js) as the repo's error-only lint gate
  - eslint@^9 + globals committed as devDependencies with a lockfile in npm-ci parity
  - whole-repo `npx eslint .` exit-0 (every hand-written file matched by a files block; only vendored code ignored)
affects: ["01-05 (Makefile lint target + CI lint gate invoke this same `npx eslint .`)", "later god-file refactors rely on this gate"]

# Tech tracking
tech-stack:
  added: [eslint@^9.39.5, globals@^17.7.0]
  patterns:
    - "Flat CommonJS config with per-environment files blocks (Node/CommonJS vs renderer/browser script) + global ignores for vendored/generated/standalone dirs"
    - "Lean error-only ruleset (no-undef + lenient no-unused-vars); no stylistic gate, per-layer indentation/quote style preserved"

key-files:
  created: [eslint.config.js]
  modified:
    - package.json
    - package-lock.json
    - main.js
    - onboarding.js
    - src/managers/window.manager.js
    - src/services/llm.service.js
    - src/core/whisper-installer.js
    - src/core/service-supervisor.js
    - test/service-supervisor.test.js

key-decisions:
  - "Pinned eslint@^9 (not 10) for Node-20 CI safety; eslint + globals are the ONLY new deps this phase, installed with --ignore-scripts and lockfile regenerated in sync so `npm ci` succeeds"
  - "Lean error-only flat config: no-undef + no-unused-vars only. sourceType:'commonjs' for the Node block (main/preload/scripts/tests), sourceType:'script' for the renderer block (src/ui + onboarding.js + lib/mathrender.js) with browser + app-injected globals"
  - "no-unused-vars caughtErrors:'none' (12 unused catch bindings across 6 files — plan-authorized config tweak over renaming); require declared readonly in renderer globals so chat-window.js's `typeof require` dual-load feature-detection lints clean instead of being disabled"
  - "Whole-repo green achieved surgically (dead-code removal + `_`-prefixing unused trailing args + removing 7 unused eslint-disable directives), no mass reformat; lib/markdown.js + assests/vendor + webapp ignored, hand-written lib/mathrender.js linted"

patterns-established:
  - "Pattern: run `npx eslint .` as the single whole-repo gate (what Makefile/CI will call in 01-05)"
  - "Pattern: unused trailing args prefixed with `_` (matches argsIgnorePattern ^_) rather than deleted when the callback signature is meaningful (forEach Map keys, Electron console-message args)"

# Metrics
duration: 25min
completed: 2026-07-14
---

# Phase 1 Plan 4: ESLint 9 Lint Gate Summary

**Lean, error-only ESLint 9 flat config with per-layer Node/renderer globals, installed as committed devDeps with a synced lockfile, gating the entire repo to a clean `npx eslint .` (exit 0, no output).**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-07-14T02:47:05Z
- **Completed:** 2026-07-14T03:11:59Z
- **Tasks:** 2
- **Files modified:** 10 (1 created, 9 modified)

## Accomplishments
- Installed `eslint@^9.39.5` + `globals@^17.7.0` as devDependencies (via `--ignore-scripts` to skip the electron-builder postinstall); `package.json` + `package-lock.json` regenerated in sync (npm-ci parity verified).
- Authored `eslint.config.js`: a flat CommonJS config with global ignores (Block 0), a Node/CommonJS block (Block 1), and a renderer/browser `script` block (Block 2) with browser + app-injected globals. `lib/mathrender.js` is linted; only vendored `lib/markdown.js`, `assests/vendor/**`, and `webapp/**` are ignored.
- Drove `npx eslint .` from 42 errors + 7 warnings to **exit 0 with no output** across the whole repo, entirely via surgical fixes (no mass reformat). Wave-1 test suite still green (38/38).

## Task Commits

Each task was committed atomically:

1. **Task 1: Install ESLint + globals and author eslint.config.js** - `7147beb` (chore)
2. **Task 2: Run the lint fix pass until `npx eslint .` is clean** - `2bdb12c` (refactor)

**Plan metadata:** _(this SUMMARY + STATE update)_

## Files Created/Modified
- `eslint.config.js` - **created.** Flat CommonJS config: leanRules (`no-undef` + lenient `no-unused-vars` w/ `caughtErrors:'none'`), Block 0 global ignores, Block 1 Node/CommonJS files, Block 2 renderer/browser files with per-env globals (incl. `require:'readonly'`).
- `package.json` / `package-lock.json` - eslint + globals added as devDeps, lockfile regenerated in sync.
- `main.js` - removed dead `const window =`/`execSync`/`appPath`; `_`-prefixed unused `type` args in 4 `forEach` Map-iteration callbacks.
- `onboarding.js` - removed relic `/* eslint-disable no-undef */`; removed unused `nav`/`modelDownloadChoices` DOM lookups; `_`-prefixed the unreferenced `navigate` helper.
- `src/managers/window.manager.js` - removed dead `path` import + unused destructured `screenHeight`/`llmHeight`/`llmY`/`windowHeight`/`displayHeight`; `_`-prefixed unused `type`/`line`/`sourceId` args.
- `src/services/llm.service.js` - `_`-prefixed image-path `sessionMemory` (doc says "not required for image"); dropped unused destructured `name`; removed dead `https` import in `executeAlternativeRequest`.
- `src/core/whisper-installer.js` - dropped unused `execFile` from destructure; removed 2 vestigial `no-await-in-loop` directives.
- `src/core/service-supervisor.js` / `test/service-supervisor.test.js` - removed vestigial `no-await-in-loop` directives (await bodies untouched).

## Decisions Made
- **Pinned `eslint@^9`** (per RESEARCH Open Question 1) for maximal Node-20 CI safety; installed with `--ignore-scripts` to avoid triggering `electron-builder install-app-deps`.
- **`caughtErrors:'none'`** instead of renaming: 12 unused `catch (e)`/`catch (error)` bindings surfaced across 6 files — the plan explicitly authorized this config tweak when churn exceeds "a handful". Kept `argsIgnorePattern`/`varsIgnorePattern: '^_'`.
- **`require:'readonly'` in the renderer block** rather than an inline disable: `src/ui/chat-window.js` uses `typeof require !== 'undefined'` feature-detection for dual Node/browser module loading. Per the plan, real renderer `no-undef` is fixed by declaring the global, not disabling the rule.
- **Unused trailing args `_`-prefixed, unused vars/imports removed:** `_`-prefix preserved meaningful callback signatures (forEach Map keys, Electron `console-message` args, positional `sessionMemory`); genuine dead imports/locals were deleted outright.

## Deviations from Plan

The plan anticipated fixing "a handful" of surfaced errors; the first pass surfaced **42 errors + 7 warnings**. All were resolved within the plan's explicitly-granted discretion and the whole-repo-clean mandate (must_haves truth #3) — no architectural change, no rule was disabled to hide a problem.

### Auto-fixed Issues

**1. [Scale + config discretion] Switched `no-unused-vars` `caughtErrors` to `'none'`**
- **Found during:** Task 2 (first `npx eslint .` pass)
- **Issue:** 12 unused caught-error bindings (`catch (e)`/`catch (error)`) across main.js, window.manager.js, speech.service.js, chat-window.js, main-window.js — far beyond a "handful".
- **Fix:** Set `caughtErrors:'none'` in leanRules (plan-authorized "instead of renaming"); dropped the now-redundant `caughtErrorsIgnorePattern`.
- **Verification:** All 12 catch errors cleared on re-run; `catch (_) {}` / `catch (e) { log }` idioms remain lint-clean.
- **Committed in:** `2bdb12c`

**2. [Rule 3-style / plan-authorized] Removed 6 extra vestigial `no-await-in-loop` directives**
- **Found during:** Task 2
- **Issue:** The plan named only the onboarding.js `no-undef` relic. But ESLint 9's default `reportUnusedDisableDirectives:'warn'` also flagged 6 `// eslint-disable-next-line no-await-in-loop` comments (service-supervisor.js, whisper-installer.js, test/service-supervisor.test.js) — the lean config never enables `no-await-in-loop`, so those directives suppress nothing.
- **Fix:** Removed all 6 comment lines (await statements untouched); verified via the passing test suite.
- **Committed in:** `2bdb12c`

**3. [Whole-repo-clean mandate] Surgical fixes reached beyond Task 2's `<files>` hint**
- **Found during:** Task 2
- **Issue:** Task 2 listed `onboarding.js, main.js`, but errors also lived in window.manager.js, llm.service.js, whisper-installer.js (and directive removals in service-supervisor.js + a test file).
- **Fix:** Fixed each surgically (dead-code removal + `_`-prefix). Justified by must_haves truth #3 ("`npx eslint .` exits 0 across the whole repo") — this is the stated deliverable, not scope creep. No behavior change (38/38 tests green).
- **Committed in:** `2bdb12c`

**4. [Minor] Collapsed trailing whitespace on 4 touched blank lines**
- **Found during:** Task 2 (window.manager.js multi-line edits)
- **Issue:** 4 blank lines inside edited blocks carried a 4-space indent.
- **Fix:** They became empty in the edited blocks. No rule governs this (no whitespace rule in the lean config); behavior identical. Not a reformat of any code line.
- **Committed in:** `2bdb12c`

---

**Total deviations:** 4 (1 config discretion, 1 extra directive cleanup, 1 scope-per-mandate, 1 cosmetic). All within the plan's authorized discretion and the whole-repo-clean success criterion.
**Impact on plan:** None negative. The lint half of FND-02 is delivered exactly as specified; the extra fixes were required to hit the stated "whole repo green" gate. No mass reformat, no stylistic rules added.

## Issues Encountered
- **`node --test test/` fails on Node v26** with `Cannot find module '.../test'` — the runner tries to resolve the directory as a module entry point. The wave-1 suite runs correctly via `node --test test/*.test.js` (38/38 pass). **Note for 01-05:** the Makefile `run_tests` target should glob `test/*.test.js` (or rely on node's default test discovery), not pass `test/`.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- `npx eslint .` is a clean, committed gate — ready for 01-05 to wire into the Makefile (`lint` target) and CI.
- eslint + globals are in the lockfile, so CI `npm ci --ignore-scripts` installs them deterministically.
- Test-runner invocation caveat above should be honored by the 01-05 `run_tests` target.

## Self-Check: PASSED

- `eslint.config.js` — FOUND
- `01-04-SUMMARY.md` — FOUND
- Task 1 commit `7147beb` — FOUND
- Task 2 commit `2bdb12c` — FOUND
- `npx eslint .` re-confirmed exit 0 (clean)

---
*Phase: 01-foundation-supervisor-tests-lint-makefile*
*Completed: 2026-07-14*
