---
phase: 01-foundation-supervisor-tests-lint-makefile
plan: 1
subsystem: core
tags: [node-test, dotenv, env-parsing, prompt-loader, pure-functions, refactoring]

# Dependency graph
requires:
  - phase: none
    provides: First plan of Phase 1 (wave 1); no upstream dependencies
provides:
  - "src/core/env-file.js — pure fs-free .env parse/format/upsert helpers"
  - "src/core/skill-normalizer.js — pure skill-name normalization + programming-language injection"
  - "test/env-file.test.js + test/skill-normalizer.test.js — node:test suites (2 of 3 FND-01 pure-logic targets)"
  - "Proven extract-pure-logic-and-delegate pattern for the rest of the phase"
affects: [01-02-vad-extraction, 01-04-eslint, 01-05-makefile-run_tests]

# Tech tracking
tech-stack:
  added: [node:test (built-in runner), node:assert/strict]
  patterns:
    - "Extract pure transforms to src/core/*; fs-backed singletons delegate with zero behavior change"
    - "node:test suites require ONLY the extracted module, never the app singleton"

key-files:
  created:
    - src/core/env-file.js
    - src/core/skill-normalizer.js
    - test/env-file.test.js
    - test/skill-normalizer.test.js
  modified:
    - main.js
    - src/core/first-run.js
    - prompt-loader.js

key-decisions:
  - "main.js imports only upsertEnvContent (not formatEnvValue): after delegation main.js never calls formatEnvValue directly, so importing it would be an unused-var lint error the plan's own lint-clean gate forbids"
  - "SKILLS_REQUIRING_PROGRAMMING_LANGUAGE lives in skill-normalizer.js as the single source of truth; PromptLoader spreads a copy in its constructor"
  - "Semantic string literals (dotenv quote-wrapping, DSA/default prompt template blocks) preserved byte-for-byte; only surrounding JS adopts src/core single-quote style"

patterns-established:
  - "Extract-and-delegate: pure module in src/core/*, singleton keeps I/O and delegates the transform"
  - "Quality gate: test files require the extracted module only (grep-verified: no singleton imports)"

# Metrics
duration: 10min
completed: 2026-07-14
---

# Phase 1 Plan 1: Pure-Logic Extraction (.env + Skill Normalization) Summary

**Pure fs-free `.env` parse/format/upsert (`env-file.js`) and skill-name/prompt-language normalization (`skill-normalizer.js`) extracted from `main.js`/`first-run.js`/`prompt-loader.js`, delegated with zero behavior change, and pinned by 25 passing `node:test` cases.**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-07-14T02:27:38Z
- **Completed:** 2026-07-14T02:38:05Z
- **Tasks:** 2
- **Files modified:** 7 (4 created, 3 modified)

## Accomplishments
- Delivered 2 of the 3 FND-01 pure-logic test targets: `.env` parse/format/upsert and skill/prompt normalization.
- Extracted `src/core/env-file.js` (`parseEnv`, `formatEnvValue`, `upsertEnvContent`) with no fs / process.env / config coupling; `main.js persistEnvUpdates` and `FirstRunManager._readEnv` now delegate to it.
- Extracted `src/core/skill-normalizer.js` (`normalizeSkillName`, `injectProgrammingLanguage`, `SKILLS_REQUIRING_PROGRAMMING_LANGUAGE`); `PromptLoader` delegates without changing its `{ PromptLoader, promptLoader }` export shape.
- Added 25 `node:test` cases (16 env-file + 9 skill-normalizer) that import only the extracted modules; end-to-end delegation through the live singletons verified equivalent behavior.

## Task Commits

Each task was committed atomically:

1. **Task 1: Extract env-file.js and delegate main.js + first-run.js** - `510a7da` (feat) — *co-mingled with sibling plan 01-03's commit due to a shared-index race; all four Task 1 files (env-file.js, main.js, first-run.js, test/env-file.test.js) are present and correct in `510a7da` (verified via `git log -1 -- <file>`). See Issues Encountered.*
2. **Task 2: Extract skill-normalizer.js and delegate prompt-loader.js** - `5b9775a` (feat) — clean commit containing exactly my 3 files.

**Plan metadata:** committed in the final docs commit alongside this SUMMARY.md + STATE.md.

## Files Created/Modified
- `src/core/env-file.js` - Pure `.env` helpers: `parseEnv(content)`, `formatEnvValue(raw)`, `upsertEnvContent(existing, updates)`. No fs/process.env/config.
- `src/core/skill-normalizer.js` - Pure `normalizeSkillName`, `injectProgrammingLanguage`, and the `SKILLS_REQUIRING_PROGRAMMING_LANGUAGE = ['dsa']` source of truth.
- `test/env-file.test.js` - 16 cases: format quoting/backslash/newline/single-quote-fallback, parse quoting/CRLF/inline-comment, upsert replace/append/preserve, and a format-then-parse round-trip.
- `test/skill-normalizer.test.js` - 9 cases: alias mapping, unknown passthrough, general fallback, DSA vs default injection blocks, fence tags, language title-casing, and the skills list.
- `main.js` - Removed the local `formatEnvValue` (+ its comment); imports `upsertEnvContent`; `persistEnvUpdates` now builds content via `upsertEnvContent` while keeping the guard, atomic temp-file+rename write, `process.env` mutation, and logger calls.
- `src/core/first-run.js` - `_readEnv` reduced to `parseEnv(fs.readFileSync(...))` with the same try/catch fallback.
- `prompt-loader.js` - `normalizeSkillName` / `injectProgrammingLanguage` bodies replaced with delegation; constructor spreads the shared skills list; export shape unchanged.

## Decisions Made
- **Import only `upsertEnvContent` in main.js.** The plan text said to import `{ formatEnvValue, upsertEnvContent }`, but after delegation `formatEnvValue` is used only inside `upsertEnvContent` (env-file.js), so importing it into main.js would be an unused variable — a lint error the plan's own verification section forbids. Importing only what's used satisfies both the delegation and the lint-clean gate. The plan's grep check (`require("./src/core/env-file")`) still matches.
- **Single source of truth for the DSA skills list** in skill-normalizer.js; PromptLoader keeps a defensive spread copy so callers can't mutate the shared array.
- **Semantic literals preserved verbatim** (dotenv single/double-quote wrapping; DSA and default prompt template blocks byte-for-byte); only non-semantic surrounding code adopted src/core single-quote/2-space style.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] main.js imports only `upsertEnvContent`, not `formatEnvValue`**
- **Found during:** Task 1 (env-file delegation)
- **Issue:** Plan specified `const { formatEnvValue, upsertEnvContent } = require(...)`, but the delegated `persistEnvUpdates` no longer calls `formatEnvValue` directly (formatting happens inside `upsertEnvContent`). Importing it unused would fail the plan's own lint-clean requirement (no unused vars) once eslint lands in 01-04.
- **Fix:** Imported only `upsertEnvContent`. Delegation and the plan's `require("./src/core/env-file")` grep both still hold.
- **Files modified:** main.js
- **Verification:** `node --check main.js` passes; `grep "function formatEnvValue" main.js` empty; no unused import.
- **Committed in:** 510a7da (Task 1 commit)

**Minor style-only adjustments (explicitly permitted by the plan, listed for transparency):** dropped trailing whitespace on blank lines when copying `normalizeSkillName`, and used a single-quoted `' '` for the newline-collapse replacement in `formatEnvValue`. Both are behavior-identical and required by the "author lint-clean / surrounding JS may follow src/core style" instruction.

---

**Total deviations:** 1 auto-fixed (1 blocking/lint) + trivial permitted style normalization.
**Impact on plan:** No scope creep. Observable behavior of all three touched singletons is unchanged (verified by tests + an end-to-end delegation harness).

## Issues Encountered
- **Shared-index git race (parallel execution).** Three executor agents (01-01/01-02/01-03) ran on the same working tree and git index. Task 1's staged files were swept into sibling plan 01-03's `git commit` (`510a7da`) microseconds before my own commit ran, so my commit reported "nothing staged". No work was lost: all four Task 1 files are present and byte-correct in `510a7da` (verified), the working tree is clean, and the full suite passes (25/25). I deliberately did **not** rewrite shared history (reset/amend/rebase) because two sibling agents were actively committing to the same branch. For Task 2 I switched to `git add … && git commit -m … -- <pathspec>`, which committed only my three files (`5b9775a`) without sweeping other agents' staged work.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- 2 of 3 FND-01 pure-logic targets shipped; the third (VAD extraction) is plan 01-02, executing in parallel.
- Extract-and-delegate pattern proven and documented for reuse in 01-02.
- New modules and tests authored lint-clean in anticipation of the eslint config in 01-04.
- `test/*.test.js` files are ready to be wired into the `make run_tests` target in 01-05; they run fast and do not hang (no interactive/watch behavior).

---
*Phase: 01-foundation-supervisor-tests-lint-makefile*
*Completed: 2026-07-14*

## Self-Check: PASSED
- Files verified on disk: src/core/env-file.js, src/core/skill-normalizer.js, test/env-file.test.js, test/skill-normalizer.test.js, 01-01-SUMMARY.md
- Commits verified in history: 510a7da (Task 1, co-mingled), 5b9775a (Task 2)
