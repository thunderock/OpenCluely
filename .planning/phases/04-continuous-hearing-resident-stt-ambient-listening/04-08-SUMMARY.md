# 04-08 — Validation Gate (Real-World Checks) — SUMMARY

**Plan:** 04-08 (validation-gate-real-world-checks) · wave 6 · `autonomous: false`
**Status:** COMPLETE — prep shipped; the real-world validation gate was **DEFERRED by human decision (2026-07-16, "defer real validation, proceed")**.
**Requirements touched:** SC2, SC5, STT-03 (validation), SC4 (already deferred via 04-05).

## What shipped

- `scripts/smoke-whisper-mem.js` (commit `de81b40`) — a keyless, loopback-only latency + memory-budget + silence-gate smoke. It reuses the side-effect-safe WAV helpers exported by `scripts/smoke-whisper.js` and drives the SAME `WhisperServerManager.transcribe()` the flush seam uses (`POST /inference?response_format=verbose_json` + the `no_speech_prob > 0.6` gate) to:
  1. measure per-utterance wall-clock latency on a known WAV (a real phrase WAV → accuracy check; else a deterministic tone → plumbing check);
  2. prove the SC5 silence gate — ~2 s of digital silence must gate to empty text (a repeatable proxy for the full 2-minute always-on run);
  3. log whisper-server RSS + the coexisting ollama/VLM RSS so a human can confirm they fit the ~32 GB budget with no swap (Pitfall 2).
  It deliberately does NOT `require('./src/services/speech.service')` (that module still mutates globals via the Azure polyfill until 04-09), and is not a `test/*.test.js` glob file (never runs in CI).

## Gates

- `npx eslint scripts/smoke-whisper-mem.js` clean; `make lint` exit 0; `make run_tests` **145/145** (the script is not a test glob).
- Ran here to the expected **MODEL_MISSING waive path**: binary found (`resources/bin/whisper-server`), model absent → actionable message, exit 3, no crash. The real download + live run is the human gate below.

## Validation gate outcome (Task 2) — DEFERRED to pre-ship / Phase 8

The human elected to proceed to Azure removal on the strength of the existing **keyless proof**, deferring the attended real-world run:
- **Keyless proof accepted as sufficient to proceed:** 145/145 node:test suites; the 04-03 loopback wiring smoke (`scripts/smoke-whisper.js`) proved the real `POST /inference` → `verbose_json` → `no_speech_prob` gate round-trip on canned + synthetic audio (0.92-prob segment dropped, survivors concatenated); the new `smoke-whisper-mem.js` adds the latency/memory/silence-gate spot-check; headless boot degrades-to-mic cleanly and a simulated `powerMonitor 'resume'` re-warms without crashing (04-06).
- **Honest SC status (real-world runs NOT yet performed):**
  - **SC2 (first-run download):** the downloader is network-free-test-proven (resume, SHA256, atomic-rename, offline/disk-full — 04-02) and wired to the onboarding progress UI (04-03/04-07); the **real ~488 MB `ggml-small.en` download** through the UI is deferred.
  - **SC5 (2-min silence):** the three-gate composition (VAD + phrase-list `_isHallucinatedTranscript` + `no_speech_prob > 0.6`) is unit-proven and the 2 s-silence smoke gates to empty; the **full 2-minute always-on** manual run is deferred.
  - **STT-03 resilience:** `powerMonitor` resume re-warm + mic `devicechange` re-attach are wired, re-entrancy-guarded, and simulated-resume-tested (04-06); **real sleep/wake + AirPods swap** are deferred.
  - **SC4 (system audio):** already deferred to Phase 8 (04-05 signing spike) — mic-only baseline.
- **Mic channel + baseline** are considered proven-enough by the keyless suite to proceed to the final (revertible, on-branch) Azure removal.

## Phase-8 / pre-ship follow-up (logged in `deferred-items.md`)

Run the full real-world validation before shipping (ideally alongside the Phase-8 signing spike, on a signed dev build): real 488 MB download through onboarding (visible/resumable/checksum-verified/userData-cached), `node scripts/smoke-whisper-mem.js <phrase.wav>` (latency + memory coexistence), 2-minute always-on silence → zero transcripts (then a sentence transcribes), and sleep/wake + AirPods-swap resilience. Report per-step pass/fail.

## Deviations

- The plan's Task-1 prep + the Task-2 human gate were executed by the orchestrator inline (a transient API error terminated two `gsd-executor` attempts before any commit; the deliverable is small + doc-heavy, so it was completed directly from a clean tree at `06f702d`). The `scripts/smoke-whisper-mem.js` content, verify steps, and waive-path behavior match the plan exactly.
