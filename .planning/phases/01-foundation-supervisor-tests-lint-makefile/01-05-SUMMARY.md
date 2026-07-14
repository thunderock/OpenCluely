---
phase: 01-foundation-supervisor-tests-lint-makefile
plan: 5
subsystem: infra
tags: [makefile, github-actions, ci, eslint, node-test, npm]

# Dependency graph
requires:
  - phase: 01-01
    provides: env-file + skill-normalizer pure modules and their node:test suites
  - phase: 01-02
    provides: vad-segmenter pure module and its node:test suite
  - phase: 01-03
    provides: service-supervisor + real-spawn node:test suite (uses test/fixtures excluded from the glob)
  - phase: 01-04
    provides: ESLint 9 flat config (eslint.config.js) and a whole-repo-green `npx eslint .` gate
provides:
  - Four-target Makefile (setup, setup-dev, run_tests, lint) wiring npm ci + node --test + npx eslint
  - .github/workflows/ci.yml — lint + test gate on pull_request and push:main across ubuntu+macOS on Node 20
  - SC1 verified (all four make targets succeed on the checkout) and SC2 acceptance shape demonstrated (lint violation exits the gate non-zero)
affects: [all future phases, ci, refactor-safety, developer-onboarding]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Developer commands via a fixed-name four-target Makefile (setup/setup-dev/run_tests/lint), tab-indented recipes"
    - "CI gate separate from release: ci.yml (lint+test on PR/push:main) alongside the tag-only release.yml"
    - "CI installs with `npm ci --ignore-scripts` to skip the Electron binary download for lint/test-only jobs"
    - "Portable test invocation `node --test test/*.test.js` (single-* glob; fixtures under test/fixtures/ never run as tests)"

key-files:
  created:
    - Makefile
    - .github/workflows/ci.yml
  modified: []

key-decisions:
  - "Makefile setup/setup-dev both run `npm ci` (reproducible from the committed lockfile); setup-dev keeps `setup` as its only prerequisite (no separate recipe) since dev/test/lint tooling comes from the same install"
  - "CI uses `npm ci --ignore-scripts` (skip the ~100MB Electron binary + electron-builder rebuild) — the lint/test job needs neither; faster and removes a flaky network dependency (Pitfall 5)"
  - "run_tests uses the single-* glob `node --test test/*.test.js`, never a bare `test/` dir (which would execute test/fixtures/dummy-service.js as a test and hang — Pitfall 1)"
  - "SC1 for setup/setup-dev verified non-destructively (recipe correctness + already-installed deps + `npm ci --dry-run` lockfile parity) rather than a full reinstall that would download Electron"

patterns-established:
  - "Fixed-name Makefile targets are the single developer entrypoint; CI runs the same underlying commands (npx eslint ., node --test test/*.test.js) so local == CI"

# Metrics
duration: 12min
completed: 2026-07-14
---

# Phase 1 Plan 5: Makefile + CI Lint/Test Gate Summary

**Four-target Makefile (setup/setup-dev/run_tests/lint) plus a new ubuntu+macOS Node-20 `ci.yml` that gates `npx eslint .` and `node --test test/*.test.js` on every PR and push to main — SC1 verified (38/38 tests, lint clean) and SC2's lint-fail-the-gate shape demonstrated locally.**

## Performance

- **Duration:** 12 min (continuation after a prior infrastructure stall)
- **Completed:** 2026-07-14T04:41:06Z
- **Tasks:** 2
- **Files created:** 2

## Accomplishments
- `Makefile` with exactly the four locked, tab-indented targets; `make run_tests` runs all six suites (38/38 pass, terminates cleanly) and `make lint` exits 0 across the repo.
- New `.github/workflows/ci.yml` gating lint + tests on `pull_request` and `push:main` across an `ubuntu-latest` + `macos-latest` matrix on Node 20, using `npm ci --ignore-scripts`; the tag-only `release.yml` is untouched.
- SC1 verified end-to-end (run_tests + lint executed live; setup/setup-dev confirmed via correct recipe + installed deps + `npm ci --dry-run` lockfile parity).
- SC2 acceptance shape demonstrated: an intentional `no-undef` violation makes `npx eslint .` exit non-zero, so a PR carrying it would fail the CI lint gate; probe removed and the gate is clean again.

## Task Commits

Each task was committed atomically:

1. **Task 1: Author the Makefile and verify all four targets (SC1)** - `0d237c7` (feat)
2. **Task 2: Author ci.yml and demonstrate the lint gate (SC2)** - `c8b0bc9` (feat)

**Plan metadata:** (docs commit for SUMMARY + STATE — see final commit)

## Files Created/Modified
- `Makefile` - The four locked developer commands: `setup`/`setup-dev` (`npm ci`), `run_tests` (`node --test test/*.test.js`), `lint` (`npx eslint .`); tab-indented recipes with an ordering comment (run setup before lint/run_tests on a clean checkout).
- `.github/workflows/ci.yml` - CI lint+test gate on `pull_request` + `push:main`, ubuntu+macOS matrix, Node 20, `npm ci --ignore-scripts` → `npx eslint .` → `node --test test/*.test.js`.

## Decisions Made
- Verified SC1 for `setup`/`setup-dev` non-destructively: the recipe is the reproducible `npm ci`, deps are already installed (eslint v9.39.5 present), and `npm ci --dry-run` reports "up to date" (package.json↔package-lock.json parity). Chose this over a full `npm ci` that would wipe the `--ignore-scripts` node_modules and download the ~100MB Electron binary — the plan's "(or confirm deps already installed)" escape hatch.
- Modeled `ci.yml` on the RESEARCH example and mirrored `release.yml` conventions (actions/checkout@v4, actions/setup-node@v4 with `cache: 'npm'`, `fail-fast: false`), swapping the release matrix for `ubuntu-latest` + `macos-latest` and the build steps for the lint/test gate.

## Deviations from Plan

None - plan executed exactly as written. The `Makefile` drafted by the prior (stalled) executor was validated line-for-line against the FND-03 locked spec (correct tab-indented recipes, exact target names/recipes, ordering comment) and matched, so it was committed as-is with no edits.

## Issues Encountered
- The previous executor stalled on an infrastructure watchdog timeout (not a logic failure) while deliberating how to verify SC1 for `make setup`/`make setup-dev` without a destructive `npm ci`. Resolved decisively here using the non-destructive parity check above; no reinstall loop, no Electron download.
- Verification/tooling notes: on macOS `cat -A` is unavailable — used `cat -te` (tabs shown as `^I`) to confirm recipe indentation. The `node --test test/*.test.js` glob form is required (the bare-dir form fails on newer Node and would run the fixture); Node 20 in CI handles the single-`*` glob portably.
- The lint-probe SC2 demonstration was run under a shell `trap ... EXIT` guard so the throwaway file could not be left behind; `git status` afterward shows only the new `ci.yml`.

## User Setup Required
None - no external service configuration required. End-to-end CI-on-a-real-PR confirmation is pending the user's first push of a branch/PR (delivery policy: never push automatically); the workflow and the exact gate command (`npx eslint .`) were validated locally.

## Next Phase Readiness
- The safety net is complete: developer commands (Makefile) + CI gate (ci.yml) now compose the 01-01/02/03 test suites and the 01-04 lint config into a single local==CI check protecting every future refactor.
- Phase 1 (Foundation) plans 01-01..01-05 are all delivered. Ready to proceed to Phase 2.
- Note for the user: push a branch/PR to light up CI and confirm the green matrix on GitHub.

---
*Phase: 01-foundation-supervisor-tests-lint-makefile*
*Completed: 2026-07-14*

## Self-Check: PASSED

- FOUND: `Makefile`
- FOUND: `.github/workflows/ci.yml`
- FOUND: `.planning/phases/01-foundation-supervisor-tests-lint-makefile/01-05-SUMMARY.md`
- FOUND commit: `0d237c7` (Task 1 — Makefile)
- FOUND commit: `c8b0bc9` (Task 2 — ci.yml)
