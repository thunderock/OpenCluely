---
phase: 01-foundation-supervisor-tests-lint-makefile
plan: 3
subsystem: infra
tags: [supervisor, child_process, net, http, health-check, backoff, node-test, process-lifecycle]

# Dependency graph
requires:
  - phase: (existing repo infra)
    provides: src/core/logger.js createServiceLogger contract; WhisperInstaller DI/export shape
provides:
  - "Generic ServiceSupervisor (FND-04): spawn + own, TCP-port OR HTTP health probe, capped exponential backoff, give-up->'failed', SIGTERM->SIGKILL termination"
  - "adopt-if-present / own-if-started: stop() never kills a process the supervisor did not spawn (SC4)"
  - "Exported pure helpers: probePort, probeHttp, computeBackoffDelay"
  - "node:test demo suite proving SC3 + SC4 with REAL spawn against test/fixtures/dummy-service.js"
affects: [phase-3-ollama-model-server, phase-4-whisper-server, 01-04-eslint, 01-05-makefile-ci]

# Tech tracking
tech-stack:
  added: []   # zero new deps — child_process/net/http/fs/events + node:test/node:assert are all built-in
  patterns:
    - "Injected spawn seam: this.spawn = options.spawn || spawn (WhisperInstaller pattern)"
    - "Class export + named property + helper exports (module.exports = Class; .Class; .probePort; ...)"
    - "EventEmitter 'status' events carrying a getStatus() snapshot"
    - "Timeout-bounded health probes that always destroy/resume the socket (never hang)"
    - "Hardened startup: _startupSettled one-shot guard + _intentionalStop guard + single backoff timer"
    - "Test fixture under test/fixtures/ so the *.test.js glob never runs it as a test"

key-files:
  created:
    - src/core/service-supervisor.js
    - test/fixtures/dummy-service.js
    - test/service-supervisor.test.js
  modified: []

key-decisions:
  - "Hardened lifecycle over the RESEARCH sketch: a one-shot _startupSettled guard routes a startup exit/error to the backoff path exactly once, eliminating the double-restart/hang risk (Pitfall 6)."
  - "stop() awaits the child's post-SIGKILL 'exit' before settling, so a caller's immediate process.kill(pid,0) liveness check is race-free; a bounded 2s timeout guarantees it never hangs."
  - "stop() settles to 'stopped' immediately when the owned child has already exited (crashed/'failed'), avoiding a pointless multi-second wait for an 'exit' that can never fire again."
  - "Tests use tiny backoff (10/2/50, maxRetries 2-3) and REAL spawn via process.execPath for deterministic, fast (~0.8s) proofs; production constants are left to the P3/P4 consumers."

patterns-established:
  - "DI spawn seam for out-of-process service management, reused verbatim by Ollama (HTTP, adopt) and whisper-server (TCP, own + PID sidecar)"
  - "No-op logger injection ({debug,info,warn,error}) in tests to keep node:test output clean"
  - "Bounded waitFor(predicate, ms) polling helper instead of fixed sleeps, with teardown in finally so node --test always exits"

# Metrics
duration: 11min
completed: 2026-07-14
---

# Phase 1 Plan 3: ServiceSupervisor (FND-04) Summary

**Generic out-of-process supervisor — spawn/own, TCP-port or HTTP health probe, capped exponential backoff with give-up->'failed', SIGTERM->SIGKILL termination, and adopt-if-present that never kills a foreign process — proven end-to-end by a real-spawn node:test suite (SC3 + SC4).**

## Performance

- **Duration:** 11 min
- **Started:** 2026-07-14T02:29:33Z
- **Completed:** 2026-07-14T02:41:30Z
- **Tasks:** 2 (+1 auto-fix)
- **Files created:** 3

## Accomplishments
- `ServiceSupervisor extends EventEmitter` with a hardened start/restart/stop lifecycle: adopt-if-present, own-if-started, one-shot startup guard, single backoff timer, intentional-stop guard.
- Two timeout-bounded health probes (`probePort` via `net.connect`, `probeHttp` via `http.get`) plus a pure `computeBackoffDelay` — all exported and unit-tested.
- SIGTERM->SIGKILL termination that awaits actual reaping, and a `stop()` that is a strict no-op kill-wise for adopted/foreign processes (SC4).
- 7-case demo suite with REAL OS processes (backoff math, both probe types, spawn->healthy, restart-with-backoff after a kill, give-up->'failed', SIGTERM->SIGKILL of a stubborn child, adopt-never-kills-foreign). Suite runs in ~0.8s and exits cleanly; the fixture is never executed as a test.
- Design check confirmed: both future consumers fit the contract unchanged — Ollama `{ healthCheck: { type:'http', port:11434, path:'/' }, adopt:true }` and whisper-server `{ healthCheck: { type:'port', port }, adopt:false, pidFile, terminate:{ sigtermGraceMs:5000 } }`.

## Task Commits

1. **Task 1: Implement ServiceSupervisor (hardened lifecycle)** - `510a7da` (feat)
2. **Auto-fix: fast stop() when owned child already exited** - `ed27117` (fix, Rule 1)
3. **Task 2: Fixture + demo suite (SC3/SC4)** - `83acc1a` (test)

**Plan metadata:** committed separately (docs: complete plan).

_Note: `510a7da` also contains an adjacent agent's env-file files that were staged into the shared index at commit time — see Issues Encountered. All work is preserved; subsequent commits used explicit pathspecs._

## Files Created/Modified
- `src/core/service-supervisor.js` (273 lines) - The FND-04 deliverable: class + probePort/probeHttp/computeBackoffDelay, DI spawn seam, `createServiceLogger('SUPERVISOR')`, hardened lifecycle.
- `test/fixtures/dummy-service.js` (24 lines) - Trivial spawn target with `ok` / `ignore-sigterm` / `crash` modes; lives outside the `*.test.js` glob.
- `test/service-supervisor.test.js` (203 lines) - node:test suite, real spawn via `process.execPath`, no-op logger, bounded `waitFor` polling, teardown in `finally`.

## Decisions Made
- Followed the RESEARCH probe helpers verbatim (HIGH-confidence Node builtins) but implemented the plan's HARDENED control model over the RESEARCH lifecycle sketch, closing the double-restart / hang gaps.
- Health-probe polling uses `healthPollMs` (default 50ms) and bails early when startup already settled, so a dead child never blocks the caller for the full startup timeout.
- Kept `no-await-in-loop` disable comments on the intentional sequential polling loops, mirroring the existing `whisper-installer.js` convention (safe for the 01-04 errors-only gate).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Installed project dependencies (winston missing)**
- **Found during:** Task 1 (smoke-construct verification)
- **Issue:** `node_modules` was absent in this environment, so `require('./logger')` (transitively `winston`) failed — the supervisor module could not load and no test could run.
- **Fix:** `npm ci --ignore-scripts --no-audit --no-fund` (installs from the committed lockfile; `--ignore-scripts` skips the ~100 MB Electron binary download and postinstall — not needed for lint/test, per RESEARCH Pitfall 5). Added nothing to `package.json`; `package-lock.json` unchanged.
- **Files modified:** none tracked (`node_modules/` is gitignored)
- **Verification:** smoke test prints `40` then `ok`; full suite runs.
- **Committed in:** n/a (no tracked file changed)

**2. [Rule 1 - Bug] stop() waited ~7s to settle on an already-crashed child**
- **Found during:** Task 2 (give-up test teardown)
- **Issue:** In the `failed` state `this.child` references the last *crashed* child. `stop()` sent SIGTERM and awaited an `'exit'` that had already fired, burning the full default grace (5000ms) + post-SIGKILL wait (2000ms) — making post-crash app shutdown needlessly slow (test 5 took 7.2s).
- **Fix:** Guard `stop()` on `child.exitCode !== null || child.signalCode !== null`; if the owned child is already gone, settle to `'stopped'` immediately.
- **Files modified:** src/core/service-supervisor.js
- **Verification:** test 5 dropped from 7182ms to ~180ms; full suite ~0.8s, all 7 pass, exits 0.
- **Committed in:** `ed27117`

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 bug)
**Impact on plan:** The blocking fix was environmental (deps never installed); the bug fix improves shutdown latency and is strictly within the locked "don't hang / surface status" contract. No scope creep, no architectural change.

## Issues Encountered
- **Shared-index git race (parallel execution).** Three executors (01-01/01-02/01-03) share one working tree and git index. A bare `git commit` after `git add <my-file>` commits the *entire* staged index, so my Task 1 commit `510a7da` swept in another agent's already-staged `src/core/env-file.js` / `test/env-file.test.js` (and their `main.js`/`first-run.js` delegation edits). Detected immediately from the commit stat. A commit from 01-02 had already landed on top, so history rewriting was unsafe; instead I left history intact (all work preserved, only commit attribution is imperfect) and switched to explicit-pathspec commits (`git commit -- <files>`) for the fix and test commits, which committed only my own files. Also added an index.lock retry loop for the commits.

## User Setup Required
None - no external service configuration required. (Real-service wiring for Ollama and whisper-server is explicitly deferred to Phases 3 and 4.)

## Next Phase Readiness
- FND-04 delivered and proven; the supervisor contract is stable for its two future consumers without reshaping.
- For **01-04 (ESLint):** the three new files are authored for the errors-only gate (`no-undef`/`no-unused-vars` clean, `catch (_)` idiom, 2-space single-quote). The `no-await-in-loop` disable comments match the existing `whisper-installer.js` pattern.
- For **01-05 (Makefile/CI):** `node --test test/*.test.js` includes this suite (38 tests across all wave-1 plans, all passing, ~0.8s) and correctly excludes `test/fixtures/`.
- Note: `node_modules` was installed locally via `npm ci --ignore-scripts`; CI/Makefile should install deps before running lint/tests (as planned).

---
*Phase: 01-foundation-supervisor-tests-lint-makefile*
*Completed: 2026-07-14*

## Self-Check: PASSED

- FOUND: src/core/service-supervisor.js
- FOUND: test/fixtures/dummy-service.js
- FOUND: test/service-supervisor.test.js
- FOUND: .planning/phases/01-foundation-supervisor-tests-lint-makefile/01-03-SUMMARY.md
- FOUND commit 510a7da (feat, contains service-supervisor.js)
- FOUND commit ed27117 (fix)
- FOUND commit 83acc1a (test, contains service-supervisor.test.js)
