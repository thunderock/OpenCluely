---
phase: 04-continuous-hearing-resident-stt-ambient-listening
plan: 05
subsystem: stt
tags: [system-audio, core-audio-process-tap, macos, swift, avaudioconverter, tcc, code-signing, degrade-to-mic, node-test, degrade-never-crash]

# Dependency graph
requires:
  - phase: 04-04
    provides: "SpeechService's system pipeline seam — handleSystemAudioChunk(buffer) ingest hook + setSystemChannelEnabled(enabled) gate + the second per-channel VadSegmenter → whisper-server → source:'system' tag; the tap only had to feed 16 kHz mono PCM in"
  - phase: 04-01
    provides: "WhisperServerManager DI shape (options-object ctor, degrade-never-throw, _ownsSupervisor guard, Mach-O verify, source-hash build cache) mirrored by SystemAudioTapManager + scripts/build-macos-audio-tap.js"
  - phase: 04-03
    provides: "Resident whisper-server transcribe() the tagged system audio ultimately POSTs to"
provides:
  - "resources/mac/system-audio-tap.swift — a whole-system Core Audio Process Tap helper (CATapDescription stereoGlobalTapButExcludeProcesses → private aggregate device with a REAL output main sub-device + kAudioAggregateDeviceTapListKey, driven by AudioDeviceCreateIOProcIDWithBlock, AVAudioConverter → 16 kHz mono s16le PCM on stdout, line-JSON status on stderr; @available(macOS 14.4,*); permission_denied/unsupported_os degrade codes)"
  - "scripts/build-macos-audio-tap.js — per-arch swiftc (target 14.4) → lipo universal → resources/bin/system-audio-tap; source-hash cache, Mach-O verify, xcrun→bare-swiftc fallback, off-darwin exit-0 no-op; npm script compile:audio-tap"
  - "src/core/system-audio-tap.manager.js — SystemAudioTapManager: isSupported() darwin && >=14.4 (numeric compare, platform+version INJECTABLE for bare-node boundary tests), binary resolve + Mach-O verify, spawn + stderr line-JSON parse, grant/deny persistence to <userData>/.system-audio-permission (no re-prompt), stdout PCM → onPcm consumer → speechService.handleSystemAudioChunk, ONE uniform _degrade() path (unsupported / not-installed / permission_denied / spawn-fail / no-samples watchdog)"
  - "main.js wiring — lazy getSystemAudioTapManager(); onAppReady starts the tap behind isSupported()+consent (non-blocking/non-fatal), wires PCM → handleSystemAudioChunk + setSystemChannelEnabled(live); onWillQuit fire-and-forget stop"
  - "NSAudioCaptureUsageDescription declared in package.json build.mac.extendInfo"
  - "STT-04 / ROADMAP SC#4 wording corrected: ScreenCaptureKit → Core Audio Process Tap (macOS 14.4+; mic-only below the floor)"
affects:
  - "04-06 (ambient resilience): the tap manager's start/stop + degrade path participate in sleep/wake + device-change handling; the system channel resets alongside mic"
  - "04-08 (validation gate): mic-only end-to-end + 2-min-silence are validated there on the proven baseline; system-audio capture is NOT part of that gate (it is signing-gated, deferred to Phase 8)"
  - "Phase 8 (signing / entitlements / asarUnpack / DMG): OWNS the deferred Task-4 signing spike — set up code signing, then re-run the spike to verify the TCC prompt fires + source:'system' PCM samples flow; gate shipping system audio on that outcome"
  - "Phase 6 (relevance gate / self-speech suppression): consumes source:'system' vs source:'mic' once system capture is signing-unblocked"

# Tech tracking
tech-stack:
  added:
    - "Swift Core Audio Process Tap helper (compiled to a universal Mach-O via swiftc/lipo; NOT an npm/native-addon dependency — a standalone spawned binary, so it sidesteps the Electron-29 ABI concern entirely)"
  patterns:
    - "Spawned-helper subprocess boundary: the privileged/OS-specific capture runs in a separate Swift process emitting raw PCM on stdout + line-delimited JSON status on stderr; the JS manager only parses status + pipes PCM, so a helper crash/deny degrades cleanly instead of taking down the main process"
    - "isSupported() + INJECTABLE platform/version: the manager takes platform + getSystemVersion via options so the >=14.4 boundary (13.x / 14.2 / 14.4 / 15.0) is unit-testable under bare node where process.getSystemVersion() is undefined"
    - "ONE uniform _degrade() path: unsupported-OS, binary-absent, arch-mismatch, permission_denied, spawn-fail, and the no-samples watchdog ALL funnel to the same mic-only fallback — the guaranteed baseline is structurally single-pathed, not a pile of special cases"
    - "Grant/deny persisted to <userData>/.system-audio-permission (openwhispr pattern) so consent is asked once, not every launch"
    - "Build script mirrors 04-01: per-arch compile → lipo universal → resources/bin, source-hash+mtime cache (fast no-op), Mach-O arch verify, off-darwin exit-0 no-op, xcrun→bare-swiftc fallback"

key-files:
  created:
    - resources/mac/system-audio-tap.swift
    - scripts/build-macos-audio-tap.js
    - src/core/system-audio-tap.manager.js
    - test/system-audio-tap.test.js
  modified:
    - main.js
    - package.json
    - .planning/ROADMAP.md
    - .planning/REQUIREMENTS.md

key-decisions:
  - "SC4 status = IMPLEMENTED + degrades-to-mic cleanly, but system-audio CAPTURE VERIFICATION is DEFERRED to Phase 8 (signing-gated) — NOT 'verified working'. Human decision 2026-07-16: the NSAudioCaptureUsageDescription TCC prompt reportedly won't fire on the current UNSIGNED build (hardenedRuntime:false, no Developer ID), so the Task-4 spike cannot be settled without code signing, which Phase 8 owns."
  - "Mic-only ambient listening is the PROVEN baseline and satisfies SC1/2/3/5 independent of system audio; the degrade-to-mic path is green in the headless boot, and full mic end-to-end + 2-min-silence get validated at the 04-08 gate."
  - "Core Audio Process Tap chosen over ScreenCaptureKit (04-CONTEXT decision): a whole-system tap wrapped in a private aggregate device with a real output main sub-device (a tap-only aggregate silently produces silence), driven by AudioDeviceCreateIOProcIDWithBlock (AVAudioEngine silently ignores aggregate-device retargeting)."
  - "Helper emits 16 kHz mono s16le (openwhispr defaults to 24 kHz) so its PCM feeds handleSystemAudioChunk → _ingestWhisperAudio/_createWavBuffer unchanged."
  - "Spawned standalone Swift binary (not an in-process native addon) — keeps the Electron-29 ABI risk out of the system-audio path entirely, matching the whisper-server 'supervise a binary' posture."

patterns-established:
  - "Signing-gated de-risking spike outcome: when a capability's verification depends on a build posture this project has not yet adopted (code signing), ship the code behind a clean degrade path, record the early non-proof signal honestly, and DEFER the verify to the phase that owns the prerequisite — do NOT claim 'verified'."
  - "Early CLI helper signal is a spike aid, not proof: a helper that builds + runs unsigned from a terminal proves the mechanism compiles and starts, but the CLI TCC context is NOT the packaged-app context and a 'start' status is NOT evidence that samples flowed."

# Metrics
duration: ~16 min build/wiring (Tasks 1–3) + closeout after human deferral decision
completed: 2026-07-16
---

# Phase 4 Plan 5: System-Audio Tap + Signing Spike Summary

**A whole-system macOS Core Audio Process Tap (Swift helper → 16 kHz mono PCM → SystemAudioTapManager → the 04-04 `handleSystemAudioChunk` system channel), built entirely behind `isSupported(>=14.4)` → consent → one uniform degrade-to-mic path; the Task-4 signing spike that would verify the TCC prompt fires + samples flow was DEFERRED to Phase 8 (signing-gated) by human decision, so SC4 ships as implemented + degrade-proven, NOT as verified-working system capture.**

## Performance

- **Duration:** ~16 min for the Tasks 1–3 build/wiring (commits span 18:01–18:18 UTC), then this closeout after the human deferral decision.
- **Completed:** 2026-07-16T18:29:13Z
- **Tasks:** 3 of 4 executed (Task 4 = signing spike, DEFERRED to Phase 8 by human decision — not run here)
- **Files modified:** 8 (4 created, 4 modified)

## Accomplishments

- **Core Audio Process Tap helper shipped (Task 1).** `resources/mac/system-audio-tap.swift` (328 lines) is a whole-system tap — `CATapDescription(stereoGlobalTapButExcludeProcesses:[])` → a private aggregate device with a REAL output main sub-device + `kAudioAggregateDeviceTapListKey`, driven by `AudioDeviceCreateIOProcIDWithBlock`, converted via `AVAudioConverter` to 16 kHz mono s16le PCM on stdout with line-JSON status on stderr; gated `@available(macOS 14.4,*)` with `permission_denied`/`unsupported_os` degrade codes. `scripts/build-macos-audio-tap.js` (210 lines) compiles per-arch (target 14.4) → `lipo` universal → `resources/bin/system-audio-tap` with a source-hash cache, Mach-O arch verify, `xcrun`→bare-`swiftc` fallback, and an off-darwin exit-0 no-op; `compile:audio-tap` npm script + `NSAudioCaptureUsageDescription` in `package.json` `build.mac.extendInfo`.
- **SystemAudioTapManager + main.js wiring + 13 tests (Task 2).** `src/core/system-audio-tap.manager.js` (413 lines) mirrors the `WhisperServerManager` DI shape: `isSupported()` (darwin && >=14.4 numeric compare; platform+version INJECTABLE so the boundary is testable under bare node), binary resolve + Mach-O verify, spawn + stderr line-JSON parse, grant/deny persistence to `<userData>/.system-audio-permission` (no re-prompt), stdout PCM → `onPcm` → `speechService.handleSystemAudioChunk`, and ONE uniform `_degrade()` path covering unsupported-OS / not-installed / arch-mismatch / permission_denied / spawn-fail / no-samples-watchdog. `main.js` gained a lazy `getSystemAudioTapManager()`, an `onAppReady` start-behind-`isSupported()`+consent (non-blocking/non-fatal) that wires PCM → `handleSystemAudioChunk` + `setSystemChannelEnabled(live)`, and a fire-and-forget `stop()` on quit. 13 network- and GUI-free `node:test` cases cover the version boundaries (13.x/14.2/14.4/15.0), stderr status parsing (`start`/`permission_denied`/`unsupported_os`), grant/deny persistence, and the binary-absent/arch-mismatch degrade.
- **STT-04 / SC#4 doc wording corrected (Task 3).** ROADMAP SC#4 (`:85`) and REQUIREMENTS STT-04 (`:36`) now name a *macOS Core Audio Process Tap (macOS 14.4+; mic-only below the floor)* instead of ScreenCaptureKit; the requirement id + traceability were left intact (wording correction only).
- **Degrade-to-mic baseline proven green.** Headless Electron boot with the helper absent degrades cleanly — `[SYSAUDIO] system audio unavailable — using microphone only`, zero uncaught exceptions — so mic-only ambient listening (SC1/2/3/5) is the guaranteed baseline regardless of the tap outcome.
- **Gates re-confirmed at closeout (no code changes):** `make run_tests` **129/129** pass, `make lint` exit **0**.

## Task Commits

Tasks 1–3 were committed atomically (Task 4 was not run — deferred):

1. **Task 1: Core Audio Process Tap helper + build script** (+ `NSAudioCaptureUsageDescription`, `compile:audio-tap`) — `ad1a883` (feat)
2. **Task 2: SystemAudioTapManager + main.js wiring + 13 tests** — `25988f4` (feat)
3. **Task 3: Correct STT-04 doc wording (ROADMAP SC#4, REQUIREMENTS STT-04)** — `b521401` (docs)

**Checkpoint state commit** (mid-plan pause record): `b73a260` (docs — Tasks 1–3 done + paused at the Task-4 signing spike)

**Plan metadata:** _(final docs commit — see git log; this SUMMARY + STATE + deferred-items)_

## Files Created/Modified

- `resources/mac/system-audio-tap.swift` (created, 328 lines) — whole-system Core Audio Process Tap → private aggregate device → `AVAudioConverter` → 16 kHz mono s16le PCM on stdout, line-JSON status on stderr; `@available(macOS 14.4,*)`; `permission_denied`/`unsupported_os` degrade codes.
- `scripts/build-macos-audio-tap.js` (created, 210 lines) — per-arch swiftc (target 14.4) → lipo universal → `resources/bin/system-audio-tap`; source-hash cache, Mach-O verify, xcrun→bare-swiftc fallback, off-darwin exit-0 no-op.
- `src/core/system-audio-tap.manager.js` (created, 413 lines) — `SystemAudioTapManager`: `isSupported(>=14.4)`, helper spawn + stderr line-JSON parse, grant/deny persistence, PCM → `handleSystemAudioChunk`, ONE uniform `_degrade()` to mic.
- `test/system-audio-tap.test.js` (created, 288 lines) — 13 network-/GUI-free `node:test` cases: version boundaries, status parsing, persistence, degrade.
- `main.js` (modified) — lazy `getSystemAudioTapManager()`; `onAppReady` start-behind-consent → `handleSystemAudioChunk` + `setSystemChannelEnabled(live)`; `onWillQuit` fire-and-forget `stop()`.
- `package.json` (modified) — `NSAudioCaptureUsageDescription` in `build.mac.extendInfo`; `compile:audio-tap` script.
- `.planning/ROADMAP.md` (modified) — SC#4 wording → Core Audio Process Tap (14.4+).
- `.planning/REQUIREMENTS.md` (modified) — STT-04 wording → Core Audio Process Tap (14.4+).

## Signing Spike Outcome (Task 4) — DEFERRED to Phase 8

**Status: NOT RUN. Resolved by human decision on 2026-07-16 — "Defer to Phase 8, proceed."**

The Task-4 checkpoint was a BLOCKING human-verify spike to answer, empirically, whether the `NSAudioCaptureUsageDescription` TCC prompt fires and whether `source:'system'` PCM samples actually flow. It requires an attended macOS >= 14.4 GUI + a specific build posture. The spike could not be settled on OpenCluely's current build because:

- The app still ships **UNSIGNED** today (`hardenedRuntime:false`, no Developer ID cert). The research's PRIMARY RISK is that the system-audio TCC prompt does **not** fire on unsigned (and reportedly ad-hoc) builds → capture then silently returns zero samples.
- Settling the spike therefore depends on **code signing** (Developer ID / hardened runtime / entitlements / `asarUnpack` / DMG) — all of which **Phase 8 owns**. Verifying here would require standing up signing that this phase does not own and Phase 8 will do holistically.

**Human decision:** defer the system-audio signing verification to Phase 8 and proceed with the rest of Phase 4. SC4 is therefore recorded as **implemented; degrades-to-mic cleanly; system-audio capture verification DEFERRED to Phase 8 (signing-gated)** — explicitly **NOT** "verified working."

### Early CLI signal (encouraging, but NOT proof)

During Task 1, the helper — built to a universal Mach-O and run **unsigned from a CLI shell** on this macOS >= 14.4 machine — emitted `{"type":"start",…,"pcm_s16le",16000}` then a clean `{"type":"stop"}` on SIGTERM (exit 0). This is a useful early spike signal that the mechanism **compiles and starts**, but it is **NOT proof**:

- A **CLI TCC context is not the packaged-app TCC context** — the prompt/authorization behavior that gates real capture is exactly what differs between a terminal-launched binary and a signed, bundled `.app`.
- A `{"type":"start"}` status is **not evidence that audio samples actually flowed** — "start" only means the tap/aggregate device was created, not that non-silent PCM reached the converter and downstream.

So the CLI run de-risks compilation + process lifecycle only; the two questions that matter for SC4 (does the prompt fire on a real build posture, and do samples flow) remain open and are the Phase-8 spike's job.

### Degrade-to-mic baseline (proven)

Independent of the tap outcome, mic-only ambient listening is the guaranteed baseline. The headless Electron boot with the helper absent degrades through the single `_degrade()` path (`[SYSAUDIO] system audio unavailable — using microphone only`, zero uncaught exceptions), and SC1/2/3/5 do not depend on system audio. Full mic end-to-end + the 2-min-silence check are validated at the 04-08 gate.

## Phase-8 Follow-up (explicit)

**Set up code signing (Developer ID / hardened runtime + entitlements + `asarUnpack` of the helper + DMG), then RE-RUN the 04-05 Task-4 signing spike** to determine:

1. Which signing level (ad-hoc vs self/real Developer ID) makes the `NSAudioCaptureUsageDescription` TCC prompt actually **fire**.
2. After granting, whether `source:'system'` PCM samples **actually flow** (a system-channel transcript appears for other-app audio — check the SYSAUDIO logs / overlay transcript label).
3. Whether an app **relaunch after granting** is required for samples to start (unconfirmed in the sources).

**Gate shipping system audio on that outcome.** Until then, mic-only remains the shipped baseline. This follow-up is also logged in `deferred-items.md` so it is not lost.

## Decisions Made

- **SC4 = implemented + DEFERRED, not verified** (human decision 2026-07-16). See "Signing Spike Outcome" above — the honest status is that the code path exists and degrades cleanly, but real system-audio capture is unverified pending Phase-8 signing.
- **Mic-only is the proven baseline** — SC1/2/3/5 hold without system audio; the degrade path is green.
- **Core Audio Process Tap over ScreenCaptureKit** (private aggregate w/ real output sub-device, `AudioDeviceCreateIOProcIDWithBlock`, 16 kHz mono s16le) — the 04-CONTEXT decision, carried through to the doc wording.
- **Spawned standalone Swift binary, not an in-process native addon** — keeps the Electron-29 ABI risk out of the system-audio path.

## Deviations from Plan

None — Tasks 1–3 were executed as written. **Task 4 (signing spike) was not run; it was DEFERRED to Phase 8 by an explicit human decision (2026-07-16), not skipped or self-approved.** No auto-fix (Rule 1–4) deviations occurred during Tasks 1–3, and no code was changed during this closeout (gates were re-confirmed green: 129/129 tests, lint 0).

## Issues Encountered

- **The signing spike is un-runnable on the current build posture here.** The TCC-prompt/sample-flow verification depends on code signing (Phase 8) and an attended macOS >= 14.4 GUI with call audio. Per the project's "waive un-runnable live checks; do not block phase completion on an unavailable check" rule, and per the human's explicit decision, the verification was deferred to the phase that owns the prerequisite (Phase 8) rather than faked or force-claimed. The early CLI signal was recorded as a non-proof spike aid, not as evidence of working capture.

## User Setup Required

None for this plan. Note for Phase 8: verifying system audio will require an attended macOS >= 14.4 machine, a signed build, and playing audio from another app while ambient listening is active (see the Phase-8 Follow-up).

## Next Phase Readiness

- **04-06 (ambient resilience):** the tap manager's `start`/`stop` + the single `_degrade()` path are ready to participate in sleep/wake + mic-device-change handling; the system channel resets alongside mic.
- **04-08 (validation gate):** runs on the proven mic-only baseline (full mic end-to-end + 2-min-silence). System-audio capture is **not** part of that gate — it is signing-gated and deferred to Phase 8.
- **Phase 8 (signing):** owns the deferred Task-4 spike (see the explicit follow-up above and `deferred-items.md`). Shipping system audio is gated on that outcome.
- **Concern (carried, honest):** real system-audio capture (prompt fires + samples flow on a packaged build) is **UNVERIFIED**. The code + degrade path are in place, but SC4's "captured working" claim must NOT be made until the Phase-8 signing spike confirms it.

---
*Phase: 04-continuous-hearing-resident-stt-ambient-listening*
*Completed: 2026-07-16 (Tasks 1–3 shipped; Task-4 signing spike deferred to Phase 8 by human decision)*

## Self-Check: PASSED

- FOUND: resources/mac/system-audio-tap.swift (328 lines — Core Audio Process Tap → 16 kHz mono PCM)
- FOUND: scripts/build-macos-audio-tap.js (210 lines — per-arch swiftc → lipo universal, off-darwin no-op)
- FOUND: src/core/system-audio-tap.manager.js (413 lines — isSupported >=14.4, spawn+status parse, grant/deny persist, _degrade)
- FOUND: test/system-audio-tap.test.js (288 lines — 13 network-/GUI-free cases)
- FOUND: main.js (getSystemAudioTapManager + onAppReady start-behind-consent + handleSystemAudioChunk wiring + onWillQuit stop)
- FOUND: package.json (NSAudioCaptureUsageDescription + compile:audio-tap)
- FOUND: .planning/ROADMAP.md SC#4 + .planning/REQUIREMENTS.md STT-04 → "Core Audio Process Tap" (1 match each)
- FOUND: commit ad1a883 (Task 1, feat — swift helper + build script)
- FOUND: commit 25988f4 (Task 2, feat — SystemAudioTapManager + wiring + tests)
- FOUND: commit b521401 (Task 3, docs — STT-04/SC#4 wording)
- FOUND: commit b73a260 (checkpoint state record — Tasks 1–3 done + paused)
- GATES: make run_tests 129/129 pass; make lint exit 0 (re-confirmed at closeout, no code changes)
- SC4: recorded as IMPLEMENTED + degrades-to-mic + signing spike DEFERRED to Phase 8 — NOT "verified working" (per human decision 2026-07-16)
- MUST-HAVES: 3/4 truths satisfied in code (isSupported→consent→degrade-to-mic single path; grant/deny persistence; ScreenCaptureKit→Core Audio Process Tap doc correction). Truth #1 (system audio captured + transcribed as source:'system') is IMPLEMENTED but its "verified on a signed dev build" clause is DEFERRED to Phase 8 (signing-gated) — the plan's frontmatter explicitly allows "OR spike-documented if signing blocks the TCC prompt"; this is that documented outcome.
