---
phase: 04-continuous-hearing-resident-stt-ambient-listening
plan: 08
type: execute
wave: 6
depends_on: ["04-06", "04-07"]
files_modified:
  - scripts/smoke-whisper-mem.js
autonomous: false

must_haves:
  truths:
    - "The real first-run ggml-small.en (~488 MB) download completes through the onboarding UI with visible, resumable progress, a checksum-verified install, and a userData cache (SC2 real)"
    - "A real short-phrase WAV transcribes correctly-ish via the resident whisper-server with near-real-time per-utterance latency on Apple-Silicon Metal, whisper-server RSS coexisting with the resident VLM inside budget (Flag 5 / Pitfall 2)"
    - "Two minutes of silence under always-on ambient listening produces ZERO transcripts (VAD + phrase-list + no_speech_prob>0.6 three-gate composition holds) — the SC5 acceptance"
    - "Sleep/wake re-warm and a mic-device swap (AirPods in/out) mid-session leave the app crash-free with ambient listening resumed (STT-03 resilience)"
    - "Mic transcripts are tagged source:'mic' end-to-end; other-party/system audio is tagged source:'system' when the 04-05 signing spike unblocked it (SC4, else spike-documented)"
  artifacts:
    - path: "scripts/smoke-whisper-mem.js"
      provides: "Keyless loopback smoke: start WhisperServerManager, transcribe a real/synthesized short WAV AND a 2 s silence buffer, assert transcript vs zero-on-silence (no_speech gate), log per-utterance latency + whisper-server RSS + coexisting VLM RSS (Pitfall 2 budget)"
      min_lines: 60
  key_links:
    - from: "scripts/smoke-whisper-mem.js"
      to: "src/core/whisper-server.manager.js:transcribe"
      via: "manager.transcribe(wav,{language}) over POST /inference?response_format=verbose_json for both the phrase and the silence buffer"
      pattern: "transcribe"
    - from: "onboarding first-run download"
      to: "src/core/whisper-model-downloader.js"
      via: "the real ~488 MB ggml-small.en download exercised live through the install-progress UI (checksum-verified, resumable, userData cache)"
      pattern: "small.en"
---

<objective>
Prove the resident STT engine on both channels before Azure is removed. This is the phase's real-world validation gate: it turns the checks the unit tests deliberately WAIVE (the 488 MB download, live transcription latency/memory, 2-minute always-on silence, sleep/wake + device-swap resilience, two-channel source tagging) into explicit, human-verified gated steps — following the project's "keyless waived checks + a real validation gate" rule. It adds one repeatable keyless smoke (`scripts/smoke-whisper-mem.js`) for the latency + memory-budget + silence-gate spot-check, then blocks on a human-verify checkpoint that exercises the full first-run flow end-to-end.

Purpose: SC2 (real download), SC5 (2-min silence → zero transcripts), STT-03 resilience (sleep/wake + AirPods swap), SC4 two-channel source tags (conditional on the 04-05 signing spike), and the Flag-5 rough latency/memory smoke coexisting with the resident VLM. This is the "prove the resident engine on both channels" gate that MUST pass before Azure removal (04-09). It is NOT the Phase-6 sustained-load run.
Output: `scripts/smoke-whisper-mem.js` + a documented gate outcome in the SUMMARY.
</objective>

<execution_context>
@~/.claude/get-shit-done/workflows/execute-plan.md
@~/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/phases/04-continuous-hearing-resident-stt-ambient-listening/04-CONTEXT.md
@.planning/phases/04-continuous-hearing-resident-stt-ambient-listening/04-RESEARCH.md
@.planning/phases/04-continuous-hearing-resident-stt-ambient-listening/04-03-SUMMARY.md
@.planning/phases/04-continuous-hearing-resident-stt-ambient-listening/04-05-SUMMARY.md
@.planning/phases/04-continuous-hearing-resident-stt-ambient-listening/04-06-SUMMARY.md
@.planning/phases/04-continuous-hearing-resident-stt-ambient-listening/04-07-SUMMARY.md

# Reuse targets:
@scripts/smoke-whisper.js
@scripts/smoke-local.js
</context>

<tasks>

<task type="auto">
  <name>Task 1: Keyless latency + memory-budget + silence-gate smoke</name>
  <files>scripts/smoke-whisper-mem.js</files>
  <action>
Create `scripts/smoke-whisper-mem.js` modeled on `scripts/smoke-whisper.js` (04-03) + `scripts/smoke-local.js` — keyless, loopback-only, NOT a `test/*.test.js` glob file (so it never runs in CI). It uses the `WhisperServerManager` directly (import-safe, network-free to construct); it must NOT `require('./src/services/speech.service')` (that module still mutates globals via the Azure polyfill until 04-09). Behavior:
1. Construct + `start()` the `WhisperServerManager` (reads config). If the binary or model are absent, print the actionable message ("run `node scripts/build-whisper-server.js` and download ggml-small.en first") and exit non-zero WITHOUT crashing — waivable, like smoke-whisper.js.
2. **Latency + accuracy:** accept an optional WAV path arg (default to a fixture under `test/fixtures/` if present, else synthesize a deterministic tone as smoke-whisper.js does). `manager.transcribe(wav, { language:'en' })`; log wall-clock per-utterance latency and the returned `no_speech_prob` values; if a real phrase WAV was given, print the transcript for an eyeball accuracy check.
3. **Silence gate (SC5 spot-check):** synthesize/load a short (~2 s) near-silent 16 kHz mono buffer, frame it with the manager's WAV path, `transcribe()` it, and assert the `no_speech_prob>0.6` gate drops it → empty/near-empty text. This is a repeatable proxy for SC5 (the full 2-minute always-on run stays the human gate below, because the always-on pipeline lives in speech.service.js which mutates globals pre-04-09).
4. **Memory budget (Pitfall 2):** read the whisper-server process RSS (via the manager's pid → `process` inspection or a `ps -o rss= -p <pid>`) and, best-effort, the resident VLM/Ollama RSS, and log both so a human can confirm they coexist inside the ~32 GB budget with no swap. Best-effort — a missing VLM must not fail the smoke.
5. Exit codes like smoke-local (0 = wiring/latency/silence-gate OK; non-zero = engine unreachable / model missing — eyeballable, never blocks CI). If a full live run is un-runnable in this environment, WAIVE the live transcript + memory read and confirm the keyless wiring (manager constructs, start attempted, transcribe path reachable), documenting it — per the "keyless wiring check, waive un-runnable live checks" memory rule.
Log via `require('../src/core/logger').createServiceLogger('WHISPER-MEM')` (never interpolate variable data into the message).
  </action>
  <verify>`node scripts/smoke-whisper-mem.js` — with the binary (04-01) + model present, prints per-utterance latency, the silence-buffer `no_speech_prob` + empty-gate assertion, and whisper-server RSS (+ VLM RSS if available), exiting 0; without them, prints the actionable message + non-zero (no crash). If un-runnable here, WAIVE the live run and confirm the keyless wiring. `npx eslint scripts/smoke-whisper-mem.js` clean. `make run_tests` stays green (the script is not a test glob).</verify>
  <done>A keyless loopback smoke proves (or waives-with-wiring-check) the latency + no_speech silence gate + memory-coexistence spot-check, giving the human gate a repeatable artifact to run.</done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 2: Validation gate — prove the resident engine on both channels (real download + smoke + 2-min silence + sleep/wake)</name>
  <what-built>
The complete resident-STT + ambient-listening pipeline: a from-source whisper-server (04-01) transcribing per VAD segment over POST /inference with the no_speech_prob>0.6 gate (04-03), a resumable checksum-verified ggml-small.en downloader wired to the onboarding install-progress UI (04-02/04-03/04-07), per-channel mic + system pipelines tagging source:'mic'|'system' (04-04), the macOS Core Audio system-audio tap behind isSupported/consent/degrade-to-mic (04-05), and always-on ambient listening with powerMonitor-resume re-warm + mic devicechange re-attach (04-06). The unit tests deliberately WAIVE the real-world checks below (488 MB download, live latency/memory, 2-min always-on silence, sleep/wake, device swap) — this gate exercises them before Azure removal.
  </what-built>
  <how-to-verify>
Perform on a macOS >= 14.4 Apple-Silicon machine (mic-only is the guaranteed baseline regardless of the 04-05 signing outcome):
  1. **SC2 (real first-run download):** with no model cached (clear `<userData>/.whisper-models/`), launch onboarding and trigger the voice-model step. Confirm the ggml-small.en (~488 MB) download shows visible percent progress, RESUMES if interrupted (kill mid-download, relaunch → continues from the `.part`), verifies its SHA256 before flipping to "installed", and caches under `<userData>/.whisper-models/ggml-small.en.bin`. A partial/corrupt file must NOT register as installed.
  2. **Rough STT smoke (Flag 5):** run `node scripts/smoke-whisper-mem.js` with a REAL short-phrase WAV. Confirm the transcript is correct-ish, log per-utterance latency (expect near-real-time on Metal), and confirm whisper-server RSS coexists with the resident VLM (qwen3-vl:8b) inside the ~32 GB budget with no swap (Pitfall 2). This is the rough smoke, NOT the Phase-6 sustained-load run.
  3. **SC5 (2-min silence):** with ambient listening on and the room quiet, leave it running for 2 full minutes. Confirm ZERO transcripts appear (the VAD + phrase-list + no_speech_prob>0.6 three-gate composition holds). Speak one clear sentence afterward → it transcribes (proves the gate isn't just muted).
  4. **Resilience (04-06):** (a) sleep the Mac (or trigger `powerMonitor` 'resume'), wake it, and confirm the whisper-server is re-probed/restarted and ambient listening resumes with no crash; (b) swap the mic device mid-session (AirPods in, then out) and confirm renderer capture re-attaches without crashing and listening continues.
  5. **Two-channel sanity:** confirm a mic utterance is tagged source:'mic' end-to-end (overlay label / logs). If the 04-05 signing spike unblocked system audio, play audio from another app and confirm the other-party audio transcribes tagged source:'system'; if signing blocked it, confirm mic-only degrade with a clear note (SC4 spike-documented).
Report: pass/fail per step (SC2, smoke latency+memory, SC5, sleep/wake, device swap, mic tag, system tag or spike-documented). ALL of SC2/SC5/mic-tag/resilience must pass to proceed; SC4 system-audio may be "verified on signed dev build" OR "spike-documented, mic-only baseline confirmed".
  </how-to-verify>
  <resume-signal>Type "approved" with the per-step outcome (and the SC4 system-audio status: verified-signed / spike-documented), or describe issues to fix before Azure removal.</resume-signal>
</task>

</tasks>

<verification>
- `make run_tests` green; `make lint` exits 0 (`scripts/smoke-whisper-mem.js` lints clean, is not a test glob).
- SC2: the real ggml-small.en download is visible, resumable, checksum-verified, userData-cached (human-confirmed).
- SC5: 2 minutes of always-on silence → zero transcripts (human-confirmed); a subsequent sentence transcribes.
- Flag 5: per-utterance latency near-real-time; whisper-server + VLM RSS coexist inside budget (human-confirmed).
- Resilience: sleep/wake re-warm + AirPods swap re-attach → no crash, listening resumes.
- Two-channel: mic tagged source:'mic'; system tagged source:'system' (verified-signed) OR spike-documented with mic-only baseline.
</verification>

<success_criteria>
- The resident engine is proven on both channels end-to-end: real first-run download (SC2), near-real-time latency + in-budget memory (Flag 5), 2-min silence → zero transcripts (SC5), sleep/wake + device-swap resilience (STT-03), and source tagging (SC4 or spike-documented).
- The gate PASSES (human sign-off) — the precondition for Azure removal in 04-09.
</success_criteria>

<output>
After completion, create `.planning/phases/04-continuous-hearing-resident-stt-ambient-listening/04-08-SUMMARY.md`
</output>
