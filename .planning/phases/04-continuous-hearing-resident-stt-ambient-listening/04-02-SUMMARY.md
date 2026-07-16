---
phase: 04-continuous-hearing-resident-stt-ambient-listening
plan: 02
subsystem: stt
tags: [whisper, ggml, download, sha256, http-range, resumable, node-test, offline, disk-full]

# Dependency graph
requires:
  - phase: 04-01
    provides: whisper-server manager + build config that consumes the ggml weights this downloader fetches
  - phase: 03
    provides: LocalModelManager DI + preflight (statfs) pattern; local-transport (native URL / Node-http) conventions
provides:
  - "src/core/whisper-model-downloader.js — resumable (HTTP Range), SHA256-verified ggml downloader to <userData>/.whisper-models/"
  - "Pinned checksum table (small.en default, base.en low-RAM, tiny.en CI) with a DI-injectable override for tests"
  - "Structured { percent, downloadedBytes, totalBytes } progress (throttled ~100ms) for the existing progress UI"
  - "Friendly offline + disk-full status structs (degrade-never-crash); isModelPresent/modelPath/verifyChecksum helpers"
affects:
  - "04-03 (resident STT rewire + IPC): streams this download progress over IPC; retires the venv/pip whisper-installer"
  - "04-07 (onboarding/settings STT UI): drives the first-run download + progress bar"
  - "04-08 (validation gate): exercises the REAL 488 MB download end-to-end"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Atomic-rename-after-verify: download to <file>.part, SHA256+size verify against a pinned OID, fs.renameSync only on pass (Pitfall 5)"
    - "DI transport seam (httpGet) + injectable checksum table + injectable statfs → fully network-free, real-fs-on-tmpdir tests"
    - "Node http/https byte stream (native node:url URL); ESM node-fetch and global fetch both avoided for determinism"

key-files:
  created:
    - src/core/whisper-model-downloader.js
    - test/whisper-model-downloader.test.js
  modified: []

key-decisions:
  - "Re-hash the whole .part at the end (streamed SHA256) rather than seeding a running hash on resume — simpler and correct for both fresh and resumed downloads"
  - "download() verifies an existing .bin before short-circuiting; callers wanting a cheap check use isModelPresent (path+size), reserving the full hash for isModelPresent({verify:true})/download"
  - "dataDir resolves Electron userData with a ~/.OpenCluely fallback (mirrors logger) so the module constructs + paths resolve network-free outside Electron"
  - "If a Range request is answered 200 (server ignored it), rewrite the .part from scratch instead of appending onto stale bytes"

patterns-established:
  - "Status-struct returns ({ ok, reason, message, ... }) with friendly reasons: offline | disk-full | checksum-mismatch | http-error | unknown-model | error"
  - "Progress-handler and fs calls are all try/caught — a throwing onProgress or fs quirk never breaks the download"

# Metrics
duration: ~14 min
completed: 2026-07-16
---

# Phase 4 Plan 2: ggml Model Downloader Summary

**Resumable (HTTP Range), SHA256-verified `ggml-small.en.bin` downloader that caches into `<userData>/.whisper-models/` with atomic-rename-after-verify, structured progress, and friendly offline/disk-full handling — proven entirely network-free.**

## Performance

- **Duration:** ~14 min
- **Started:** 2026-07-16T16:11:00Z
- **Completed:** 2026-07-16T16:25:00Z
- **Tasks:** 2
- **Files modified:** 2 (both created)

## Accomplishments
- `WhisperModelDownloader` (DI shape mirroring `LocalModelManager`/`WhisperInstaller`): resumes via `Range: bytes=<offset>-` from HF `ggerganov/whisper.cpp` `resolve/main`, follows the 302→CDN redirect over a Node http/https byte stream (no ESM node-fetch, no global fetch).
- Atomic-rename-after-verify: bytes land in a sibling `.part`, are verified against the pinned SHA256 **and** byte size, and only then `fs.renameSync` into the final `.bin` — a partial/corrupt file can never masquerade as installed (Pitfall 5).
- Pinned checksum table (authoritative git-LFS OIDs) for `small.en` (default, 487,614,201 B), `base.en` (low-RAM), `tiny.en` (CI), DI-injectable so tests pin a tiny fixture instead of the 488 MB hash.
- Friendly degrade paths: offline first-launch ("connect once … after that OpenCluely works offline") and a `statfs` disk-full preflight that refuses to start — both return status structs, never throw.
- 7 network-free `node:test` cases (fake `httpGet` + injected checksum table + real `os.tmpdir` cache): checksum pass, checksum fail (partial-not-installed), resume offset, already-present short-circuit, offline, disk-full, and a path/network-free-construction sanity. Full suite 103/103 green.

## Task Commits

Each task was committed atomically with an explicit pathspec (parallel-safe: a sibling 04-01 executor ran concurrently on this branch):

1. **Task 1: Resumable, SHA256-verified ggml model downloader** - `f6e9d85` (feat)
2. **Task 2: node:test suite (fake fetch + fake fs)** - `6f8fe57` (test)

**Plan metadata:** _(final docs commit — see git log)_

## Files Created/Modified
- `src/core/whisper-model-downloader.js` (created, 358 lines) - Resumable + SHA256-verified ggml downloader to `<userData>/.whisper-models/`; structured progress; offline/disk-full handling; pinned checksum table; `isModelPresent`/`modelPath`/`verifyChecksum` helpers; no venv/pip/Python.
- `test/whisper-model-downloader.test.js` (created, 194 lines) - Network-free node:test suite covering checksum pass/fail, resume offset, already-present short-circuit, offline, disk-full.

## Decisions Made
- **Whole-file re-hash on completion** (not a running hash seeded from `.part`) — the plan permitted either; re-hashing the streamed `.part` is simpler and provably correct for both fresh and resumed downloads.
- **`download()` does the thorough verify; `isModelPresent()` is the cheap check** — the short-circuit re-hashes an existing `.bin` (correct for a repair/first-run entry point), while callers on the hot path use the path+size `isModelPresent` (or opt into `{ verify:true }`).
- **`dataDir` resolves Electron userData with a `~/.OpenCluely` fallback** so the module constructs and `modelPath` resolves under `.whisper-models/` outside Electron (tests/CLI) without importing electron.
- **Range answered as 200 → restart the `.part`** rather than appending onto stale bytes (correctness guard for a server that ignores Range).

## Deviations from Plan

None to the module or tests — both tasks executed exactly as written (both verify commands pass; module 358 ≥ 90 min-lines, test 194 ≥ 70 min-lines; my two files lint clean in isolation).

## Issues Encountered

**Whole-repo `make lint` fails on vendored whisper.cpp source (OUT OF SCOPE — logged, not fixed).**
- `npx eslint .` reports a parse error in `resources/.whisper-cpp-src/examples/addon.node/index.js` (`Binding arguments in strict mode`). This is third-party whisper.cpp source vendored by the concurrent **04-01** executor (untracked dir, created this session), which owns the whisper-server build + resources + build/eslint config this wave.
- My deliverables lint CLEAN in isolation (`npx eslint src/core/whisper-model-downloader.js test/whisper-model-downloader.test.js` exits 0) and all 103 tests pass.
- Per the SCOPE BOUNDARY rule I did NOT edit `eslint.config.js` (a concurrent edit would collide with 04-01 on the shared branch). Logged to `.planning/phases/04-.../deferred-items.md` with the suggested fix: add `'resources/.whisper-cpp-src/**'` (or `'resources/**'`) to the eslint `ignores` block, matching the existing vendored exclusions. `make lint` returns to exit 0 once that ignore lands.

## User Setup Required
None - no external service configuration required. (The real 488 MB download runs at the 04-08 validation gate / onboarding; this plan ships the network-free engine.)

## Next Phase Readiness
- Download engine ready for 04-03 to wire over IPC (structured progress mirrors the Ollama `model-pull-progress` shape) and for 04-07 onboarding UX.
- 04-08 will validate the REAL download (resume, checksum, cache location) against Hugging Face.
- One cross-plan follow-up (04-01's to close): add the vendored `resources/` tree to the eslint `ignores` so the whole-repo `make lint` gate is green again.

---
*Phase: 04-continuous-hearing-resident-stt-ambient-listening*
*Completed: 2026-07-16*

## Self-Check: PASSED

- FOUND: src/core/whisper-model-downloader.js
- FOUND: test/whisper-model-downloader.test.js
- FOUND: .planning/phases/04-.../04-02-SUMMARY.md
- FOUND: commit f6e9d85 (Task 1, feat)
- FOUND: commit 6f8fe57 (Task 2, test)
