---
phase: 04-continuous-hearing-resident-stt-ambient-listening
plan: 05
type: execute
wave: 4
depends_on: ["04-04"]
files_modified:
  - resources/mac/system-audio-tap.swift
  - scripts/build-macos-audio-tap.js
  - src/core/system-audio-tap.manager.js
  - test/system-audio-tap.test.js
  - main.js
  - package.json
  - .planning/ROADMAP.md
  - .planning/REQUIREMENTS.md
autonomous: false

must_haves:
  truths:
    - "On macOS >= 14.4 the other party's system/loopback audio is captured via a Core Audio Process Tap and transcribed as a separate source:'system' channel (STT-04/SC4) — verified on a locally-signed dev build OR spike-documented if signing blocks the TCC prompt"
    - "System audio is built behind isSupported() (darwin && >=14.4) → consent → degrade-to-mic; the SAME degrade path serves the <14.4 fallback, so mic-only ambient listening is the guaranteed baseline"
    - "Grant/deny is persisted to <userData>/.system-audio-permission so it does not re-prompt each launch"
    - "STT-04 wording in ROADMAP SC#4 + REQUIREMENTS STT-04 is corrected from ScreenCaptureKit to Core Audio Process Tap (macOS 14.4+)"
  artifacts:
    - path: "src/core/system-audio-tap.manager.js"
      provides: "SystemAudioTapManager: isSupported(>=14.4), helper spawn, stderr line-JSON status, grant/deny persistence, emits 16kHz PCM → handleSystemAudioChunk, degrade-to-mic"
      min_lines: 90
    - path: "resources/mac/system-audio-tap.swift"
      provides: "Core Audio Process Tap helper (openwhispr MIT reference): whole-system tap → aggregate device → 16kHz mono PCM to stdout, line-JSON status on stderr, target 14.4"
      min_lines: 120
    - path: "scripts/build-macos-audio-tap.js"
      provides: "xcrun swiftc per-arch (target 14.4) → lipo universal → resources/bin/system-audio-tap, source-hash cache, Mach-O verify, exit-0 no-op off-darwin"
      min_lines: 50
    - path: "test/system-audio-tap.test.js"
      provides: "node:test: isSupported() gating (platform/version), stderr status parsing, grant/deny persistence (fake spawn/fs)"
      min_lines: 60
  key_links:
    - from: "src/core/system-audio-tap.manager.js"
      to: "src/services/speech.service.js:handleSystemAudioChunk"
      via: "helper stdout 16kHz mono PCM piped to the system ingest path"
      pattern: "handleSystemAudioChunk"
    - from: "src/core/system-audio-tap.manager.js"
      to: "<userData>/.system-audio-permission"
      via: "persisted grant/deny (openwhispr pattern)"
      pattern: "system-audio-permission"
---

<objective>
Capture the other party's macOS system audio as a separate `source:'system'` channel via a Core Audio Process Tap (STT-04/SC4), built behind a clean `isSupported()` → consent → degrade-to-mic path, and run an EARLY signing spike to empirically determine whether the `NSAudioCaptureUsageDescription` prompt fires on this build posture. This is the phase's HIGH-RISK item (the tap prompt does not fire on unsigned/ad-hoc builds → silent zero-sample capture); the plan is defensive by design and the signing outcome gates SC4's "verified working" claim.

Purpose: STT-04/SC4 — system/loopback audio transcribed as a separate channel from the mic. Mic-only ambient listening remains the guaranteed baseline (fully satisfies SC1/2/3/5 without this plan). Also correct the STT-04 doc wording (ScreenCaptureKit → Core Audio Process Tap, macOS 14.4+).
Output: swift helper + build script + SystemAudioTapManager + main.js wiring + doc correction; a human-verify signing spike checkpoint.
</objective>

<execution_context>
@~/.claude/get-shit-done/workflows/execute-plan.md
@~/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/REQUIREMENTS.md
@.planning/phases/04-continuous-hearing-resident-stt-ambient-listening/04-CONTEXT.md
@.planning/phases/04-continuous-hearing-resident-stt-ambient-listening/04-RESEARCH.md
@.planning/research/OPENWHISPR-NOTES.md
@.planning/phases/04-continuous-hearing-resident-stt-ambient-listening/04-04-SUMMARY.md

# Reuse targets:
@src/core/local-model.manager.js
@src/services/speech.service.js
</context>

<tasks>

<task type="auto">
  <name>Task 1: Swift Core Audio Process Tap helper + build script</name>
  <files>resources/mac/system-audio-tap.swift, scripts/build-macos-audio-tap.js</files>
  <action>
Create `resources/mac/system-audio-tap.swift` porting openwhispr's `resources/macos-audio-tap.swift` (MIT reference) with two required deltas:
- **Output 16 kHz mono 16-bit PCM raw to stdout** (openwhispr defaults to 24 kHz — set 16 kHz so it feeds `handleSystemAudioChunk` → `_ingestWhisperAudio`/`_createWavBuffer` unchanged). Line-delimited JSON status on stderr: `{"type":"start"|"stop"|"error", ...}`.
- Mechanism (verbatim shape): `CATapDescription` with `processes=[]` + exclusive → whole-system mix; wrap in a private aggregate device (`AudioHardwareCreateAggregateDevice`, `kAudioAggregateDeviceTapListKey`, `isPrivate:true`) with a REAL output device as the main sub-device (a tap-only aggregate silently produces silence); drive with `AudioDeviceCreateIOProcIDWithBlock` (NOT AVAudioEngine — it silently ignores aggregate-device retargeting); convert via `AVAudioConverter`. Guard the `isExclusive` direction (mis-setting inverts include/exclude). Treat `kAudioHardwareIllegalOperationError` → emit `{"type":"error","code":"permission_denied"}`. Gate `@available(macOS 14.4, *)`; below → emit `{"code":"unsupported_os"}` and exit.
Create `scripts/build-macos-audio-tap.js` mirroring openwhispr's build script + our 04-01 build pattern: `xcrun swiftc resources/mac/system-audio-tap.swift -O -target arm64-apple-macosx14.4 -o <tmp-arm64>` (+ `x86_64-apple-macosx14.4`), `lipo -create` → `resources/bin/system-audio-tap`; cache by source-hash+mtime; verify Mach-O arch; `process.exit(0)` no-op on non-darwin. Fallback to bare `swiftc` if `xcrun` unavailable. Add npm script `"compile:audio-tap": "node scripts/build-macos-audio-tap.js"`.
Also add `NSAudioCaptureUsageDescription` to `package.json` `build.mac.extendInfo` (so the TCC prompt can fire in dev): e.g. "OpenCluely captures system audio to transcribe the other participant in a call." (Phase 8 finalizes asarUnpack/entitlements/DMG.)
  </action>
  <verify>On darwin: `node scripts/build-macos-audio-tap.js` exits 0 and `resources/bin/system-audio-tap` is a universal (or arm64) Mach-O (`lipo -info` / `file`). Running the helper prints line-JSON on stderr (`{"type":...}`) and raw PCM on stdout when permitted, or `permission_denied`/`unsupported_os` otherwise. Off-darwin → exit 0 no-op. `npx eslint scripts/build-macos-audio-tap.js` clean. `grep -c NSAudioCaptureUsageDescription package.json` >= 1.</verify>
  <done>A 16 kHz Core Audio Process Tap helper (target 14.4) builds to resources/bin via a cached, arch-verified, off-darwin-no-op script; NSAudioCaptureUsageDescription is declared.</done>
</task>

<task type="auto">
  <name>Task 2: SystemAudioTapManager + main.js wiring + tests</name>
  <files>src/core/system-audio-tap.manager.js, main.js, test/system-audio-tap.test.js</files>
  <action>
Create `src/core/system-audio-tap.manager.js` exporting `SystemAudioTapManager`, mirroring openwhispr `audioTapManager.js` + our DI shape (deps via options, methods return structs, degrade never crash). Logger tag `'SYSAUDIO'`. Owns:
- `isSupported()` = `process.platform === 'darwin' && process.getSystemVersion() >= '14.4'` (use a robust semver-ish compare, not string compare). Below → not supported (degrade-to-mic).
- Binary resolution (dev `resources/bin/system-audio-tap`, packaged `process.resourcesPath/bin/system-audio-tap`) + Mach-O arch verify (reject wrong arch).
- `spawn` the helper (DI seam `options.spawn || require('child_process').spawn`); parse stderr line-JSON status: first `{"type":"start"}` = permission granted + tap live; `{"code":"permission_denied"}` = denied → degrade-to-mic; `{"code":"unsupported_os"}` = degrade-to-mic. Pipe stdout 16 kHz PCM chunks to a consumer callback (main.js wires this to `speechService.handleSystemAudioChunk`).
- **Persist grant/deny** to `<userData>/.system-audio-permission` (openwhispr pattern) so it does not re-prompt each launch. Consent at first ambient-listen; deny → mic-only with a clear note.
- `start()` / `stop()` (SIGTERM the helper), `getStatus()` (supported/granted/running).
- A single, uniform DEGRADE-TO-MIC path shared by both the <14.4 case and the permission-denied/no-samples case.
main.js: add a lazy `getSystemAudioTapManager()` (mirror the other lazy getters). In `onAppReady` (after the whisper-server manager start), IF `isSupported()`, start the tap behind consent, wiring its PCM to `speechService.handleSystemAudioChunk`; set `speechService` `systemChannelEnabled` accordingly. On not-supported/denied, log the degrade-to-mic note (no crash). In `onWillQuit`, fire-and-forget `getSystemAudioTapManager().stop()`.
Create `test/system-audio-tap.test.js` (node:test, fake spawn + fake fs, no real helper): `isSupported()` true/false across platform + version boundaries (13.x, 14.2, 14.4, 15.0); stderr status parsing (`start`/`permission_denied`/`unsupported_os`); grant/deny persistence read/write to a temp file; degrade path when the binary is absent or arch-mismatched.
  </action>
  <verify>`node -e "const M=require('./src/core/system-audio-tap.manager'); const m=new M(); console.log(typeof m.isSupported, typeof m.start, typeof m.getStatus)"` prints three `function`s and constructs without spawning. `node --test test/system-audio-tap.test.js` all pass. `grep -n "getSystemAudioTapManager\|handleSystemAudioChunk" main.js` shows the wiring. `npx eslint src/core/system-audio-tap.manager.js main.js` clean. App boots headless without crashing when the helper/permission are absent.</verify>
  <done>SystemAudioTapManager gates on isSupported(>=14.4), spawns the helper, parses status, persists grant/deny, emits PCM to handleSystemAudioChunk, and degrades to mic uniformly; wired into main.js startup/quit; tests green.</done>
</task>

<task type="auto">
  <name>Task 3: Correct STT-04 doc wording</name>
  <files>.planning/ROADMAP.md, .planning/REQUIREMENTS.md</files>
  <action>
Per CONTEXT (required doc follow-up): the mechanism changed from ScreenCaptureKit to Core Audio Process Tap. Update:
- ROADMAP.md Phase 4 Success Criterion #4 (`:85`): rewrite "audio from the other party (system/loopback via ScreenCaptureKit)" → "audio from the other party (system/loopback via a macOS Core Audio Process Tap, macOS 14.4+; mic-only below the floor)". Keep the intent ("a question you only hear is captured").
- REQUIREMENTS.md STT-04 (`:36`): rewrite "captures system (loopback) audio via ScreenCaptureKit" → "captures system (loopback) audio via a Core Audio Process Tap (macOS 14.4+; mic-only below the floor)".
Do NOT change the requirement id or its traceability row. This is a wording correction only.
  </action>
  <verify>`grep -n "Core Audio Process Tap" .planning/ROADMAP.md .planning/REQUIREMENTS.md` shows both updated; `grep -n "ScreenCaptureKit" .planning/ROADMAP.md .planning/REQUIREMENTS.md` returns nothing in the STT-04 / SC#4 lines.</verify>
  <done>ROADMAP SC#4 and REQUIREMENTS STT-04 name the Core Audio Process Tap (macOS 14.4+) mechanism, not ScreenCaptureKit.</done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 4: Signing spike — does the tap prompt fire + do samples flow?</name>
  <what-built>
A Core Audio Process Tap Swift helper (16 kHz, target 14.4) + SystemAudioTapManager wired into the app's system channel, behind isSupported()/consent/degrade-to-mic. The app still ships unsigned today (hardenedRuntime:false, no Developer ID), and the research's PRIMARY RISK is that the NSAudioCaptureUsageDescription TCC prompt does NOT fire on unsigned (and reportedly ad-hoc) builds — capture then silently returns zero samples.
  </what-built>
  <how-to-verify>
This is the de-risking spike for STT-04. Perform on a macOS >= 14.4 machine:
  1. Build the helper + app and AD-HOC sign both: `node scripts/build-macos-audio-tap.js`; `codesign -s - --deep --force <app-or-helper>` (helper at resources/bin/system-audio-tap). Launch the app, trigger ambient listening, and play audio from another app (e.g. a YouTube video).
  2. Observe: (a) does the macOS "wants to capture system audio" prompt FIRE? (b) after granting, do PCM samples actually flow (a system-channel transcript with source:'system' appears for the other-app audio)? Check the SYSAUDIO logs / the overlay transcript label.
  3. If NO prompt / zero samples on ad-hoc: generate a self-signed Developer ID cert (Keychain Access → Certificate Assistant) and re-sign both, relaunch, and repeat step 2.
  4. Note whether an app RELAUNCH after granting is required for samples to start (unconfirmed in the sources).
  5. Confirm the DEGRADE path: on a <14.4 machine (or by forcing isSupported()=false), the app runs mic-only with a clear note and no crash.
Report: which signing level (ad-hoc vs self-Developer-ID) made the prompt fire + samples flow, whether relaunch-after-grant was needed, and whether SC4 is "verified on a signed dev build" or "spike-documented as blocked pending Phase 8 signing." Mic-only ambient listening (SC1/2/3/5) must be confirmed working regardless.
  </how-to-verify>
  <resume-signal>Type "approved" with the spike outcome (which signing made it work / or "signing blocks — degrade-to-mic confirmed"), or describe issues to fix.</resume-signal>
</task>

</tasks>

<verification>
- `make run_tests` green (system-audio-tap suite + existing); `make lint` exits 0.
- On darwin >= 14.4: helper builds, spawns, emits status + PCM; SystemAudioTapManager gates on isSupported, persists grant/deny, feeds handleSystemAudioChunk.
- Degrade-to-mic path confirmed for <14.4 and permission-denied (no crash; mic-only baseline holds).
- ROADMAP SC#4 + REQUIREMENTS STT-04 corrected to Core Audio Process Tap (14.4+).
- Signing spike outcome recorded (SC4 verified-on-signed-dev-build OR spike-documented).
</verification>

<success_criteria>
- STT-04/SC4: system audio is captured as a separate source:'system' channel on macOS >= 14.4, behind isSupported()/consent/degrade-to-mic — verified on a locally-signed dev build, or spike-documented if the unsigned-build signing risk blocks the TCC prompt (shipping gated on Phase 8 signing).
- Mic-only ambient listening remains the guaranteed baseline regardless of the tap outcome.
</success_criteria>

<output>
After completion, create `.planning/phases/04-continuous-hearing-resident-stt-ambient-listening/04-05-SUMMARY.md`
</output>
