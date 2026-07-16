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
- **04-07 disposition (2026-07-16): NOT taken — re-assigned to 04-09.** `env.example` is a repo-root file outside 04-07's declared `files_modified` (onboarding.js / onboarding.html / settings.html / src/ui/settings-window.js) and outside the renderer/onboarding/settings file scope this plan was explicitly granted. Per the executor SCOPE BOUNDARY (pre-existing, not task-caused → log, don't fix), it is left untouched and inert (re-confirmed: nothing reads `WHISPER_COMMAND`/`WHISPER_MODEL_DIR`; the resident `WhisperServerManager` reads `config.speech.whisper.model = small.en`). Re-assigned to **04-09 (azure-removal)**, which must already edit `env.example` to strip the Azure seed lines — the stale whisper-Python seed rides along with that holistic env cleanup. 04-07 DID complete the renderer-side venv/Python removal (onboarding no longer persists `whisperCommand`; the `.venv-whisper`/pip/`turbo` copy is gone).

## 04-05 (system-audio tap) — signing spike DEFERRED to PHASE 8 (2026-07-16)

- **[DEFERRED to Phase 8 by human decision — 2026-07-16]** Re-run the 04-05 Task-4 system-audio SIGNING SPIKE once code signing exists.
  - **Why deferred:** OpenCluely's current build is UNSIGNED (`hardenedRuntime:false`, no Developer ID cert). The research's PRIMARY RISK is that the `NSAudioCaptureUsageDescription` TCC prompt does **not** fire on unsigned (and reportedly ad-hoc) builds → the Core Audio Process Tap then silently returns zero samples. The Task-4 human-verify spike therefore cannot be settled without code signing, which **Phase 8 owns** (signing / entitlements / hardened runtime / `asarUnpack` / DMG). Human decision at the checkpoint: "Defer to Phase 8, proceed."
  - **Current SC4 status:** IMPLEMENTED (swift helper + build script + `SystemAudioTapManager` + main.js wiring, all behind `isSupported(>=14.4)` → consent → one uniform degrade-to-mic path) and degrades-to-mic cleanly — but system-audio CAPTURE is **NOT verified working**. Mic-only ambient listening is the proven baseline (SC1/2/3/5 do not depend on system audio; validated at the 04-08 gate).
  - **Early non-proof signal (do not treat as evidence):** the helper, built to a universal Mach-O and run UNSIGNED from a CLI shell on a macOS >= 14.4 machine, emitted `{"type":"start",…,"pcm_s16le",16000}` then a clean `{"type":"stop"}` on SIGTERM. Proves the mechanism compiles + starts only — a CLI TCC context ≠ the packaged-app TCC context, and "start" ≠ samples flowed.
  - **Phase-8 action:** set up code signing (Developer ID / hardened runtime + entitlements + `asarUnpack` of `resources/bin/system-audio-tap` + DMG), then RE-RUN the 04-05 Task-4 spike to determine (1) which signing level (ad-hoc vs self/real Developer ID) makes the TCC prompt actually FIRE, (2) whether `source:'system'` PCM samples actually FLOW after granting (a system-channel transcript appears for other-app audio — check SYSAUDIO logs / overlay label), and (3) whether a relaunch-after-grant is required. **Gate shipping system audio on that outcome.**
  - **Reference:** `.planning/phases/04-…/04-05-SUMMARY.md` → "Signing Spike Outcome (Task 4) — DEFERRED to Phase 8" + "Phase-8 Follow-up".

## 04-08 (validation gate) — real-world validation DEFERRED to pre-ship / Phase 8 (2026-07-16)

- **[DEFERRED by human decision — 2026-07-16, "defer real validation, proceed"]** Run the full real-world validation of the resident STT engine before shipping (ideally on a signed dev build, alongside the Phase-8 signing spike).
  - **Why deferred:** the human accepted the keyless proof (145/145 tests; the 04-03 `smoke-whisper.js` loopback `POST /inference`→`verbose_json`→`no_speech_prob` gate round-trip; the new `smoke-whisper-mem.js` latency/memory/silence spot-check; headless degrade-to-mic + simulated `powerMonitor 'resume'`) as sufficient to proceed to the final (on-branch, revertible) Azure removal. The mic path is well-covered; the attended real-world run is a pre-ship confidence check, not a blocker.
  - **NOT yet performed (run these before shipping):**
    1. **SC2 real download** — clear `<userData>/.whisper-models/`, run onboarding → the ~488 MB `ggml-small.en` shows visible/resumable progress, SHA256-verifies before "installed", caches in userData; a killed-mid-download resumes from the `.part`; a partial/corrupt file must NOT register as installed.
    2. **Flag 5 latency/memory** — `node scripts/smoke-whisper-mem.js <real-phrase.wav>` → correct-ish transcript, near-real-time latency on Metal, whisper-server RSS + `qwen3-vl:8b` RSS coexist in the ~32 GB budget with no swap.
    3. **SC5 2-min silence** — ambient on, quiet room, 2 full minutes → ZERO transcripts; then one clear sentence → transcribes (proves the three-gate composition isn't just muted).
    4. **STT-03 resilience** — real sleep→wake (whisper-server re-warms, ambient resumes, no crash) + AirPods in/out mid-session (renderer capture re-attaches, no crash).
  - **SC4 system audio** rides with the 04-05 Phase-8 signing spike above (mic-only baseline until then).
  - **Reference:** `.planning/phases/04-…/04-08-SUMMARY.md` → "Validation gate outcome (Task 2) — DEFERRED".
