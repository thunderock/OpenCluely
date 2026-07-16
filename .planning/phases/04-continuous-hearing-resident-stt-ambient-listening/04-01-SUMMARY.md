---
phase: 04-continuous-hearing-resident-stt-ambient-listening
plan: 01
subsystem: stt
tags: [whisper, whisper-server, whisper.cpp, cmake, metal, mach-o, service-supervisor, verbose_json, no_speech, node-test, di]

# Dependency graph
requires:
  - phase: 01
    provides: generic ServiceSupervisor (adopt/own, port/http health probes, backoff, SIGTERM->SIGKILL) + probePort/probeHttp statics
  - phase: 03
    provides: LocalModelManager DI template (options-object ctor, degrade-never-throw, _ownsSupervisor guard); local-transport (ensureNativeGlobalURL + Node-http nodeFetch, never global fetch)
provides:
  - "src/core/whisper-server.manager.js — WhisperServerManager: binary resolution + Mach-O arch verify, free-port select at start(), conservative thread clamp, ServiceSupervisor(adopt:false, pidFile, SIGTERM grace), three-level health, transcribe(wav) via POST /inference verbose_json + no_speech_prob>0.6 gate"
  - "scripts/build-whisper-server.js — from-source CMake build of whisper.cpp v1.9.1 whisper-server (Metal) into resources/bin, source-clone + version-marker cache, Mach-O arch verify, exit-0 no-op off-darwin"
  - "src/core/config.js — collapsed speech.whisper whisper-server block (host/port/model=small.en/threads/noSpeechThreshold + shared VAD knobs)"
  - "npm script compile:whisper-server; exported pure helpers clampThreads + verifyMachO"
affects:
  - "04-02 (ggml downloader): the model file this manager resolves at <userData>/.whisper-models/ggml-small.en.bin is what the downloader fetches"
  - "04-03 (resident STT rewire): _flushWhisperSegment swaps the Python-CLI spawn for manager.transcribe(); retires per-utterance process spawn (STT-01/SC1)"
  - "04-04 (two-channel refactor): the shared VAD knobs in speech.whisper drive both mic + system channels"
  - "04-08 (validation gate): exercises the built binary + real transcription end-to-end"
  - "04-09 (azure removal): removes speech.provider/azure left in place here (prove-then-remove)"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "From-source native build at build time (openwhispr build-macos-audio-tap philosophy): CMake -> resources/bin, source-hash/version-marker cache, Mach-O magic+cpu-type verify, exit-0 no-op off-darwin"
    - "WhisperServerManager mirrors LocalModelManager DI shape EXACTLY: options-object ctor, real-singleton defaults, every method returns a status/struct (degrade, never throw), _ownsSupervisor guard so an injected supervisor is trusted in tests"
    - "Free ephemeral port picked at start() via net.listen(0) (get-port is ESM-banned), re-picked each start to sidestep orphan-held EADDRINUSE; the supervisor def is mutated by reference before supervisor.start()"
    - "Three independent health levels (binaryPresent/modelPresent/serverUp/responding); a responding-probe failure is isolated in try/catch and can NEVER flip serverUp false"
    - "Client-side no_speech gate: response_format=verbose_json (the ONLY format exposing no_speech_prob), drop segments > 0.6, concatenate survivors; hand-built multipart body; nodeFetch transport (never the ambient global fetch)"

key-files:
  created:
    - scripts/build-whisper-server.js
    - src/core/whisper-server.manager.js
    - test/whisper-server-manager.test.js
  modified:
    - src/core/config.js
    - package.json
    - .gitignore
    - eslint.config.js

key-decisions:
  - "Build whisper-server FROM SOURCE (v1.9.1, Metal on) rather than fetching a third-party fork's prebuilt — self-contained, reproducible, no upstream cadence dependency; whisper.cpp ships no darwin CLI/server asset (only an xcframework)"
  - "verbose_json is REQUIRED (not json) — no_speech_prob exists only in verbose_json; the client-side gate drops segments strictly > 0.6 (0.6 boundary survives), the SC5 second filter behind JS VAD + the phrase list"
  - "Conservative thread clamp: clamp(floor(cores*0.5), 2, 8) — deliberately below openwhispr's 75%/[4,12] to leave cores for the resident VLM (Pitfall 2); overridable via WHISPER_THREADS / config"
  - "adopt:false (own-only) with a pidFile sidecar + SIGTERM grace — whisper-server is app-private, unlike Ollama's adopt:true"
  - "speech.provider/azure left UNTOUCHED (prove-then-remove; 04-09 removes them behind the manual checkpoint); segmentMs kept as a harmless legacy backstop so _getWhisperSegmentMs callers keep working until 04-03 rewrites the flush"

patterns-established:
  - "Pure, exported, separately-testable helpers (clampThreads, verifyMachO) so boundary/arch logic is proven without spawning or a real binary"
  - "Build script stays dependency-free (its own copy of verifyMachO) so `node scripts/build-whisper-server.js` never depends on app modules that may not exist yet under a parallel executor"

# Metrics
duration: 16min
completed: 2026-07-16
---

# Phase 4 Plan 1: Whisper-Server Manager, Build & Config Summary

**Resident STT foundation: a from-source-built whisper.cpp `whisper-server` (v1.9.1, Metal) supervised by the Phase-1 ServiceSupervisor via a LocalModelManager-shaped `WhisperServerManager` that free-port-selects at start, arch-verifies its Mach-O binary, exposes three-level health, and transcribes a WAV over `POST /inference?response_format=verbose_json` — dropping `no_speech_prob > 0.6` segments (the SC5 second gate).**

## Performance

- **Duration:** 16 min
- **Started:** 2026-07-16T16:13:55Z
- **Completed:** 2026-07-16T16:30:14Z
- **Tasks:** 3 (Task 3 committed in 2 atomic commits)
- **Files modified:** 7 (3 created, 4 modified)

## Accomplishments
- `scripts/build-whisper-server.js` compiles whisper.cpp **v1.9.1** `whisper-server` (Metal on) from source into `resources/bin`, with a source-clone + version-marker cache (fast no-op on re-run), Mach-O magic + cpu-type verify, a clear actionable message when the toolchain is missing (never a stack trace), and an exit-0 no-op off-darwin. **Built and verified live on this arm64 machine** — `file resources/bin/whisper-server` -> `Mach-O 64-bit executable arm64`, `--help` prints usage.
- `WhisperServerManager` mirrors `LocalModelManager`'s DI shape exactly: resolves + arch-verifies the binary (dev vs packaged), resolves the ggml model at `<userData>/.whisper-models/ggml-small.en.bin`, picks a free ephemeral port at `start()` (re-picked each start), auto-tunes threads conservatively, supervises via `ServiceSupervisor(adopt:false, pidFile, sigtermGrace:5000, backoff, startupTimeout:30000)`, and never throws when binary/model/server are absent.
- `transcribe(wav)` POSTs a hand-built multipart body to `/inference` with `response_format=verbose_json`, parses `segments[]`, drops every segment whose `no_speech_prob > 0.6` (SC5 second gate; strict boundary — 0.6 survives), concatenates survivors, and degrades to top-level `.text` when a build returns no segments. Transport is `nodeFetch` (Node http) — **never the ambient global fetch** (the Electron-main Chromium-net loopback false-negative that already bit the Ollama path).
- `config.speech.whisper` collapsed to the whisper-server block: `host`, `port:0` (auto), `model:'small.en'`, `language`, `threads:0` (auto), `noSpeechThreshold:0.6`, plus the shared VAD knobs and the legacy `segmentMs` backstop. `speech.provider`/`speech.azure` left in place for 04-09.
- 13 network-free `node:test` cases (fake spawn / injected supervisor / fake fetch): the verbose_json no_speech gate incl. the strict boundary, the degrade path, the multipart/verbose_json wire contract, free-port -> args + healthCheck, three-level health + the serverUp guard, the thread clamp boundaries + env/config precedence, Mach-O arch verify, and the guide-install not-installed path. Full suite **116/116** green, `make lint` exit 0.

## Task Commits

Each task was committed atomically with an **explicit pathspec** (parallel-safe: the 04-02 executor ran concurrently on this branch/worktree — bare `git add`/`git commit` would sweep its staged files in):

1. **Task 1: Build whisper-server from source into resources/bin** - `992ce20` (chore)
2. **Task 2: WhisperServerManager + config collapse** - `de9014e` (feat)
3. **Task 3a: eslint-ignore the build cache (Rule-3 deviation)** - `a0dfd0a` (chore)
4. **Task 3b: WhisperServerManager node:test suite** - `cc74469` (test)

**Plan metadata:** _(final docs commit — see git log)_

## Files Created/Modified
- `scripts/build-whisper-server.js` (created, ~190 lines) - From-source CMake build of whisper.cpp v1.9.1 whisper-server (Metal) into `resources/bin`; toolchain preflight with actionable messages; clone/checkout of tag; version-marker cache; Mach-O arch verify; exit-0 no-op off-darwin.
- `src/core/whisper-server.manager.js` (created, ~370 lines) - `WhisperServerManager` + exported `clampThreads`/`verifyMachO`. Binary resolution + arch verify, free-port select, thread clamp, ServiceSupervisor wiring, three-level health, verbose_json transcribe + no_speech gate, hand-built multipart, nodeFetch transport.
- `test/whisper-server-manager.test.js` (created, ~283 lines) - 13 network-free node:test cases.
- `src/core/config.js` (modified) - Collapsed `speech.whisper` to the whisper-server block (model `turbo`->`small.en`; added host/port/threads/noSpeechThreshold); provider/azure untouched; segmentMs kept.
- `package.json` (modified) - Added `compile:whisper-server` npm script (additive; the microsoft-cognitiveservices-speech-sdk dep untouched — that is 04-09's job).
- `.gitignore` (modified) - Ignore the dev build artifacts `resources/bin/` + `resources/.whisper-cpp-src/` (Phase 8 owns packaging; source helpers under `resources/` stay tracked).
- `eslint.config.js` (modified) - Ignore the same build-cache trees (Rule-3 deviation, below).

## Decisions Made
- **Build from source, pinned to `v1.9.1`, Metal on** — whisper.cpp ships no runnable darwin binary (its darwin release asset is an xcframework library); building ourselves is self-contained/reproducible and matches the repo's compile-at-build-time philosophy.
- **`verbose_json` is mandatory** — `no_speech_prob` exists only in verbose_json; the client-side gate drops segments strictly `> 0.6`.
- **Conservative thread clamp `clamp(floor(cores*0.5),2,8)`** to leave cores for the resident VLM (Pitfall 2); overridable via `WHISPER_THREADS`/config.
- **Supervisor def mutated by reference at `start()`** — the port is only known then, and the ServiceSupervisor holds `this.def` by reference, so args + healthCheck.port are filled just before `supervisor.start()`; re-picked each start to dodge orphan-held EADDRINUSE.
- **`nodeFetch` transport, never global fetch** — reuses the Phase-3 local-transport lesson (Electron-main Chromium-net false-negatives loopback).
- **Prove-then-remove** — `speech.provider`/`speech.azure` and `segmentMs` deliberately left intact for 04-03/04-09.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] eslint-ignore the whisper-server build cache**
- **Found during:** Task 3 (the `make lint` verify step)
- **Issue:** Task 1's from-source build clones whisper.cpp into `resources/.whisper-cpp-src`; its vendored upstream JS (`examples/addon.node/index.js`) tripped the whole-repo lint gate with a parse error, so `make lint` exited non-zero. This exact block was pre-flagged by the concurrent 04-02 executor as "04-01's to close."
- **Fix:** Added `resources/.whisper-cpp-src/**` and `resources/bin/**` to the `eslint.config.js` global `ignores`, mirroring the existing `.venv-whisper`/`.whisper-models` vendored exclusions.
- **Files modified:** eslint.config.js
- **Verification:** `make lint` exits 0; 116/116 tests still green.
- **Committed in:** `a0dfd0a` (separate atomic chore commit)

**2. [Rule 3 - Blocking, in Task 1] .gitignore the build artifacts**
- **Found during:** Task 1 (post-build git status)
- **Issue:** The from-source build produces a 1.2 MB binary at `resources/bin/whisper-server` plus a full cloned whisper.cpp source tree at `resources/.whisper-cpp-src/` — neither should be committed (Phase 8 owns packaging).
- **Fix:** Added `resources/bin/` + `resources/.whisper-cpp-src/` to `.gitignore` (source helpers under `resources/`, e.g. the 04-05 Swift tap, stay tracked).
- **Files modified:** .gitignore
- **Verification:** `git status` no longer lists `resources/`; only the 3 intended files landed in the Task-1 commit.
- **Committed in:** `992ce20` (Task 1 commit)

---

**Total deviations:** 2 auto-fixed (both Rule 3 - blocking, both handling the from-source build's own artifacts).
**Impact on plan:** Both are gate/hygiene fixes for artifacts this plan produces — necessary for a green lint gate and a clean tree. No scope creep; no product-code behavior changed.

## Issues Encountered

- **Parallel executor on the same branch (04-02).** A sibling executor staged/committed `src/core/whisper-model-downloader.js` and edited `STATE.md`/`deferred-items.md` concurrently. Every commit here used an **explicit pathspec** (`git commit -- <my files>`) and staged only my own files, so no cross-attribution occurred (the repo's known parallel-commit burn). The 04-02 file was never swept into an 04-01 commit; verified via `git show --stat` per commit.
- **The anticipated build-toolchain/network risk did NOT materialize** — this machine has git 2.50, CMake 4.4.0, and Xcode CLT, and the clone+build succeeded, so `resources/bin/whisper-server` is a real arch-verified arm64 binary in dev (no environment-limitation waiver needed). The build script's missing-toolchain path (clear actionable message, non-zero exit) was verified by code review; the off-darwin no-op path was verified live (`WHISPER_BUILD_FORCE_PLATFORM=linux` -> exit 0).

## User Setup Required
None - no external service configuration required. (The real 488 MB model download + live transcription run at the 04-08 validation gate / onboarding; this plan ships the network-free, unit-tested engine + a dev-built binary.)

## Next Phase Readiness
- **04-03** can rewire `_flushWhisperSegment` to `manager.transcribe(wav)` and retire the per-utterance Python spawn (STT-01/SC1) — the manager, the free-port supervision, and the no_speech gate are ready and unit-proven.
- **04-02**'s downloader targets the exact model path this manager resolves (`<userData>/.whisper-models/ggml-small.en.bin`) — the two halves meet cleanly.
- **Phase 8** still owns the final `asarUnpack`/DMG/CI fetch-vs-build wiring for `resources/bin/whisper-server` (this plan only guarantees it resolvable in dev).

---
*Phase: 04-continuous-hearing-resident-stt-ambient-listening*
*Completed: 2026-07-16*

## Self-Check: PASSED

- FOUND: scripts/build-whisper-server.js
- FOUND: src/core/whisper-server.manager.js
- FOUND: test/whisper-server-manager.test.js
- FOUND: src/core/config.js (modified)
- FOUND: package.json (modified)
- FOUND: .gitignore (modified)
- FOUND: eslint.config.js (modified)
- FOUND: resources/bin/whisper-server (built, Mach-O arm64)
- FOUND: .planning/phases/04-.../04-01-SUMMARY.md
- FOUND: commit 992ce20 (Task 1, chore — build script)
- FOUND: commit de9014e (Task 2, feat — manager + config)
- FOUND: commit a0dfd0a (Task 3a, chore — eslint ignore, Rule-3)
- FOUND: commit cc74469 (Task 3b, test — suite)
