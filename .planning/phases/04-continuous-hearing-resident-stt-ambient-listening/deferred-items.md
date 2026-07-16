# Phase 04 — Deferred Items

Out-of-scope discoveries logged during plan execution (per the executor SCOPE
BOUNDARY rule: log, do not fix, do not restart builds to chase resolution).

## From 04-02 (ggml model downloader) — 2026-07-16

- **[RESOLVED during the wave by 04-01, commit `a0dfd0a`]** `make lint` (whole-repo `npx eslint .`) fails on vendored whisper.cpp source.
  - Update: 04-01 landed `chore(04-01): eslint-ignore the whisper-server build cache` (`a0dfd0a`), which added the ignore. Re-verified after that commit: `make lint` exits 0 and `make run_tests` is 116/116. No further action needed. Original detail below for the record.
  - Error: `resources/.whisper-cpp-src/examples/addon.node/index.js:30:7 — Parsing error: Binding arguments in strict mode`.
  - Cause: the vendored whisper.cpp checkout under `resources/.whisper-cpp-src/` (created by the concurrent 04-01 executor, which owns the whisper-server build + resources vendoring) is not in the eslint `ignores` block. It is third-party source, not OpenCluely code.
  - Out of scope for 04-02: my deliverables (`src/core/whisper-model-downloader.js`, `test/whisper-model-downloader.test.js`) lint CLEAN in isolation (`npx eslint <both files>` exits 0), and all 103 tests pass. I did NOT touch `eslint.config.js` — 04-01 owns build/resources/config this wave, and a concurrent edit would collide on the shared branch.
  - Suggested fix (for 04-01 or the phase verifier): add `'resources/.whisper-cpp-src/**'` (or `'resources/**'` for the whole vendored/binaries tree) to the eslint `ignores` block in `eslint.config.js`, matching the existing vendored exclusions (`lib/markdown.js`, `assests/vendor/**`, `webapp/**`). After that, `make lint` returns to exit 0.

## 04-03 — stale env.example Python-Whisper seed (→ 04-07)
- **File:** `env.example` (root; outside this plan's `main.js/preload.js/src/` scope and files_modified).
- **Issue:** Still seeds the legacy Python path — `WHISPER_COMMAND=whisper`, `.venv-whisper/...`, `pip install openai-whisper`, `WHISPER_MODEL_DIR=`, `WHISPER_MODEL=turbo`. `FirstRunManager._readTemplate()` PREFERS `env.example` over the in-code fallback (which 04-03 cleaned), so a fresh `.env` still gets these stale lines.
- **Impact:** Cosmetic/inert only — the resident `WhisperServerManager` reads `config.speech.whisper.model` (`small.en`), NOT `WHISPER_MODEL` env; `WHISPER_COMMAND`/`WHISPER_MODEL_DIR` are no longer read by anything (the resolver was deleted). No functional break.
- **Fix in 04-07** (onboarding/settings STT UI owns env seeding): update `env.example` speech block to the resident engine (drop venv/pip/WHISPER_COMMAND/WHISPER_MODEL_DIR; model `small.en`).
