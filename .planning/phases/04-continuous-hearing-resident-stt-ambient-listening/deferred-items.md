# Phase 04 — Deferred Items

Out-of-scope discoveries logged during plan execution (per the executor SCOPE
BOUNDARY rule: log, do not fix, do not restart builds to chase resolution).

## From 04-02 (ggml model downloader) — 2026-07-16

- **`make lint` (whole-repo `npx eslint .`) fails on vendored whisper.cpp source.**
  - Error: `resources/.whisper-cpp-src/examples/addon.node/index.js:30:7 — Parsing error: Binding arguments in strict mode`.
  - Cause: the vendored whisper.cpp checkout under `resources/.whisper-cpp-src/` (created by the concurrent 04-01 executor, which owns the whisper-server build + resources vendoring) is not in the eslint `ignores` block. It is third-party source, not OpenCluely code.
  - Out of scope for 04-02: my deliverables (`src/core/whisper-model-downloader.js`, `test/whisper-model-downloader.test.js`) lint CLEAN in isolation (`npx eslint <both files>` exits 0), and all 103 tests pass. I did NOT touch `eslint.config.js` — 04-01 owns build/resources/config this wave, and a concurrent edit would collide on the shared branch.
  - Suggested fix (for 04-01 or the phase verifier): add `'resources/.whisper-cpp-src/**'` (or `'resources/**'` for the whole vendored/binaries tree) to the eslint `ignores` block in `eslint.config.js`, matching the existing vendored exclusions (`lib/markdown.js`, `assests/vendor/**`, `webapp/**`). After that, `make lint` returns to exit 0.
