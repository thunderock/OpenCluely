---
phase: 04-continuous-hearing-resident-stt-ambient-listening
verified: 2026-07-16T00:00:00Z
status: passed
score: 6/6 must-haves verified (SC2/SC4/SC5 satisfied-with-documented-deferral — human-approved)
re_verification: false
deferred_human_verification: # Human-approved (2026-07-16 "defer + proceed"); NOT gaps. Tracked for Phase 8 / pre-ship.
  - item: "SC2 real ~488 MB ggml-small.en download through the onboarding UI (resumable progress, checksum-verified install, userData cache, killed-mid-download resume, corrupt-not-installed)"
    deferred_to: "pre-ship / Phase 8"
    signoff: "STATE.md, 04-08-SUMMARY.md, deferred-items.md"
    code_status: "downloader + onboarding/settings UI wiring fully implemented + keyless-tested"
  - item: "SC4 live system-audio CAPTURE — TCC NSAudioCaptureUsageDescription prompt fires + source:'system' PCM actually flows (signing-gated)"
    deferred_to: "Phase 8 (owns code signing / entitlements / hardened runtime)"
    signoff: "STATE.md, 04-05-SUMMARY.md, deferred-items.md"
    code_status: "Core Audio Process Tap helper + build script + manager + main.js wiring + separate tagged channel fully implemented; degrades-to-mic cleanly"
  - item: "SC5 full 2-minute attended silence run (zero transcripts) + Flag-5 real-phrase latency/memory + STT-03 real sleep/wake + AirPods swap"
    deferred_to: "pre-ship / Phase 8"
    signoff: "STATE.md, 04-08-SUMMARY.md, deferred-items.md"
    code_status: "three-gate composition wired; keyless smoke (scripts/smoke-whisper-mem.js) proves silence gate on a 2 s buffer; headless boot + simulated powerMonitor 'resume' pass"
---

# Phase 04: Continuous Hearing — Resident STT + Ambient Listening — Verification Report

**Phase Goal:** The app continuously hears both sides of a conversation through a resident transcriber, with no per-utterance process spawn — the prerequisite for continuous mode.
**Verified:** 2026-07-16
**Status:** passed (6/6 — three criteria satisfied-with-documented-deferral, human-approved)
**Re-verification:** No — initial verification

## Goal Achievement

The resident-transcriber goal is achieved in code: a supervised `whisper-server` transcribes every VAD segment over `POST /inference` with no per-utterance process/model spawn, the legacy Python/venv path is gone, ambient listening auto-starts launch→quit across two independently-segmented source-tagged channels, and the cloud STT SDK + its browser-DOM polyfill are fully removed. Three criteria (SC2 real download, SC4 live TCC capture, SC5 full 2-min silence run) reach their code + keyless-proof boundary and have explicit human sign-off to defer the remaining *attended* real-world validation to pre-ship / Phase 8 — these are documented deferrals, not gaps.

### Observable Truths

| #   | Truth (Success Criterion)                                                                                                   | Status                              | Evidence                                                                                                                                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Each VAD segment transcribes against a resident whisper.cpp engine — no per-utterance spawn; Python subprocess + venv gone | ✓ VERIFIED                          | `whisper-server.manager.js:114` `new ServiceSupervisor(...)`; `.transcribe()` over `POST /inference?response_format=verbose_json` (`:204,208,211`); `speech.service.js:834` `mgr.transcribe(wav,...)` in `_flushWhisperSegment`. No `whisper-installer.js`, no `.venv-whisper`/`WHISPER_COMMAND`/`_transcribeWhisperFile` live code (only 2 historical code comments). `resources/bin/whisper-server` is a real Mach-O arm64. |
| 2   | On first run the STT model downloads and caches locally with visible progress                                             | ✓ VERIFIED (impl) · ⏸ deferred run | `whisper-model-downloader.js`: HTTP Range resume, `createHash('sha256')` verify vs pinned OID, atomic `renameSync(part,target)` only after verify (`:200`), structured `{percent,downloadedBytes,totalBytes}` (`:202`), offline/disk-full structs. `onboarding.js:315` `downloadWhisperModel('small.en')` on `install-progress`. Real 488 MB attended download → **human-deferred**.       |
| 3   | Audio stream stays open launch→quit (ambient), transcribing on VAD pauses using existing VAD + hallucination filter        | ✓ VERIFIED                          | `main.js` `onAppReady` → `speechService.startRecording()` (`:561,1162`); `powerMonitor.on('resume')` re-warm guarded by `_rewarmInFlight` (`:114,1186`); `main-window.js` `devicechange` re-acquire. Three-gate: `VadSegmenter` + `no_speech_prob>0.6` + `_isHallucinatedTranscript` (`speech.service.js:827,840,845`).                                             |
| 4   | macOS other-party system/loopback audio via Core Audio Process Tap (14.4+; mic-only below floor), separate channel from mic | ✓ VERIFIED (impl+degrade) · ⏸ live | `system-audio-tap.manager.js`: `isSupported()` darwin&&≥14.4, consent, single `_degrade` path, PCM→`handleSystemAudioChunk`, persistence to `.system-audio-permission`. Swift helper (328 L) = real CATap→16 kHz PCM; `system-audio-tap` = universal Mach-O (x86_64+arm64). Source tag threaded end-to-end (`speech.service.js:846` → `main.js:1549,1562` `addUserInput('speech',{channel})`). Live TCC capture → **human-deferred (signing-gated, Phase 8)**. |
| 5   | Two minutes of silence produces zero transcripts (silence-hallucination filter holds under always-on)                      | ✓ VERIFIED (gate) · ⏸ deferred run | Three-gate composition wired (see #3). `scripts/smoke-whisper-mem.js:127` transcribes a 2 s silence buffer and asserts empty gated text. Full 2-minute attended run → **human-deferred**.                                                                                        |
| 6   | Azure Speech SDK + its browser-DOM polyfill are fully removed                                                             | ✓ VERIFIED                          | `microsoft-cognitiveservices-speech-sdk` absent from `package.json` + `node_modules`; no azure/SpeechSDK code in `main.js`/`src/`/`preload.js`; `ensureNativeGlobalURL` retired everywhere; no `global.URL/Blob/File=` clobbering; `nodeFetch` kept (local-transport/provider/model-manager); `node-record-lpcm16` kept. `speech.service.js` 1648→918 L; config collapsed to one `speech.whisper` block. |

**Score:** 6/6 truths verified (SC2, SC4, SC5 satisfied-with-documented-deferral)

### Required Artifacts

All 24 target artifacts across the 9 plans exist, are substantive (every file exceeds its `min_lines`), and are wired. No stubs / placeholders / TODO-FIXME found in the core modules.

| Artifact                                | Expected                                  | Status     | Details                                              |
| --------------------------------------- | ----------------------------------------- | ---------- | ---------------------------------------------------- |
| `src/core/whisper-server.manager.js`    | Resident manager, supervisor, transcribe  | ✓ VERIFIED | 363 L; ServiceSupervisor + verbose_json + no_speech  |
| `scripts/build-whisper-server.js`       | CMake Metal build, off-darwin no-op       | ✓ VERIFIED | 192 L; Mach-O verify, source-hash cache              |
| `src/core/config.js`                    | Single collapsed `speech.whisper` block   | ✓ VERIFIED | 133 L; `noSpeechThreshold`, model `small.en`, VAD    |
| `test/whisper-server-manager.test.js`   | node:test suite                           | ✓ VERIFIED | 283 L (part of 145/145)                              |
| `src/core/whisper-model-downloader.js`  | Resumable + SHA256 + atomic + progress    | ✓ VERIFIED | 358 L; Range, pinned checksums, offline/disk-full    |
| `test/whisper-model-downloader.test.js` | node:test suite                           | ✓ VERIFIED | 194 L                                                |
| `src/services/speech.service.js`        | Rewired flush + two-channel + source tag  | ✓ VERIFIED | 918 L; per-channel struct, `handleSystemAudioChunk`  |
| `scripts/smoke-whisper.js`              | Keyless loopback STT smoke                | ✓ VERIFIED | 242 L; real manager.transcribe + verbose_json probe  |
| `main.js`                               | Getters, IPC, ambient, resume, transcript | ✓ VERIFIED | 2246 L; all wiring present                           |
| `src/core/system-audio-tap.manager.js`  | Tap manager, isSupported, degrade         | ✓ VERIFIED | 413 L; consent + persistence + degrade-to-mic        |
| `resources/mac/system-audio-tap.swift`  | Core Audio Process Tap helper             | ✓ VERIFIED | 328 L; whole-system tap → 16 kHz PCM, line-JSON      |
| `scripts/build-macos-audio-tap.js`      | swiftc per-arch → lipo universal          | ✓ VERIFIED | 210 L; universal Mach-O produced                     |
| `test/system-audio-tap.test.js`         | node:test suite                           | ✓ VERIFIED | 288 L                                                |
| `src/ui/main-window.js`                 | devicechange re-acquire                   | ✓ VERIFIED | 1514 L; `devicechange` handler                       |
| `onboarding.js`                         | getWhisperStatus + downloadWhisperModel   | ✓ VERIFIED | 653 L; no Python detect/install/venv                 |
| `onboarding.html`                       | small.en copy + progress bar              | ✓ VERIFIED | 1017 L; no venv/turbo/pip strings                    |
| `settings.html`                         | whisper status/repair panel               | ✓ VERIFIED | 511 L; `whisperStatus` + log                         |
| `src/ui/settings-window.js`             | getWhisperStatus + recoverWhisper wiring  | ✓ VERIFIED | 533 L; periodic status refresh                       |
| `scripts/smoke-whisper-mem.js`          | latency + memory + silence-gate smoke     | ✓ VERIFIED | 174 L; real manager, 2 s silence assert, RSS log     |
| `src/core/local-transport.js`           | nodeFetch kept, ensureNativeGlobalURL gone | ✓ VERIFIED | 120 L                                                |
| `src/services/providers/local.provider.js` | nodeFetch kept, polyfill call gone     | ✓ VERIFIED | 426 L                                                |
| `src/core/local-model.manager.js`       | nodeFetch import kept                     | ✓ VERIFIED | 365 L                                                |
| `package.json`                          | Azure SDK removed, node-record-lpcm16 kept | ✓ VERIFIED | 177 L                                                |
| `resources/bin/{whisper-server,system-audio-tap}` | Built binaries                  | ✓ VERIFIED | Real Mach-O (arm64 / universal)                      |

### Key Link Verification

| From                                            | To                                          | Via                                          | Status     |
| ----------------------------------------------- | ------------------------------------------- | -------------------------------------------- | ---------- |
| `whisper-server.manager.js`                     | `service-supervisor.js`                     | `new ServiceSupervisor(def,{spawn})`         | ✓ WIRED    |
| `whisper-server.manager.js`                     | whisper-server `POST /inference`            | `verbose_json` multipart transcribe          | ✓ WIRED    |
| `speech.service.js:_flushWhisperSegment`        | `whisper-server.manager.js:transcribe`      | injected `mgr.transcribe(wav,{language})`    | ✓ WIRED    |
| `main.js:onAppReady`                            | `getWhisperServerManager().start()`         | non-blocking non-fatal pre-warm              | ✓ WIRED    |
| `main.js` download IPC                          | `whisper-model-downloader.js`               | structured progress → `install-progress`     | ✓ WIRED    |
| `whisper-model-downloader.js`                   | HF `resolve/main/ggml-small.en.bin`         | Node http Range resume                       | ✓ WIRED    |
| `whisper-model-downloader.js`                   | `<userData>/.whisper-models/`               | atomic rename after SHA256 verify            | ✓ WIRED    |
| `speech.service.js:_flushWhisperSegment`        | `main.js:handleTranscriptionFragment`       | `emit('transcription',{text,source})`        | ✓ WIRED    |
| `main.js:handleTranscriptionFragment`           | `sessionManager.addUserInput`               | channel as separate metadata (`{channel}`)   | ✓ WIRED    |
| `system-audio-tap.manager.js`                   | `speech.service.js:handleSystemAudioChunk`  | helper stdout 16 kHz PCM → onPcm             | ✓ WIRED    |
| `system-audio-tap.manager.js`                   | `<userData>/.system-audio-permission`       | persisted grant/deny                         | ✓ WIRED    |
| `main.js:powerMonitor.on('resume')`             | whisper re-warm + tap reopen                | `_rewarmInFlight`-guarded                    | ✓ WIRED    |
| `main.js:onAppReady`                            | `speechService.startRecording()` (ambient)  | auto-listen from launch                      | ✓ WIRED    |
| `onboarding.js` / `settings-window.js`          | `get-whisper-status` / `download` / `recover` IPC | `getWhisperStatus` + `downloadWhisperModel('small.en')` + `recoverWhisper` | ✓ WIRED |
| `local.provider.js` / `local-model.manager.js`  | `127.0.0.1:11434/v1` via `nodeFetch`        | polyfill-free after retirement               | ✓ WIRED    |

### Requirements Coverage

| Requirement | Status                                   | Note                                                                 |
| ----------- | ---------------------------------------- | -------------------------------------------------------------------- |
| STT-01      | ✓ SATISFIED                              | Resident whisper-server, no per-utterance spawn; Python path deleted |
| STT-02      | ✓ SATISFIED (impl) · real run deferred   | Downloader + UI wired + keyless-tested; attended 488 MB run → Phase 8 |
| STT-03      | ✓ SATISFIED (impl) · real run deferred   | Ambient launch→quit + resume re-warm + devicechange; real sleep/wake → Phase 8 |
| STT-04      | ✓ SATISFIED (impl+degrade) · live deferred | Tap + separate channel + degrade-to-mic; live TCC capture → Phase 8 (signing) |
| STT-05      | ✓ SATISFIED                              | Azure SDK + polyfill fully removed; STT collapsed to whisper         |

REQUIREMENTS.md still shows STT-01…05 as `Pending` in its status table — a bookkeeping lag (gsd-tools is blind to the prose/table ROADMAP per repo convention); the underlying work is complete and human-signed-off at the STATE.md level. Recommend marking STT-01…05 done at the merge step.

### Anti-Patterns Found

None. Scanned `whisper-server.manager.js`, `whisper-model-downloader.js`, `system-audio-tap.manager.js`, `speech.service.js`, both build scripts, and the Swift helper for TODO/FIXME/PLACEHOLDER/"not implemented"/empty-handler/static-return patterns — zero hits. `make lint` exits 0; `make run_tests` is 145/145.

### Human Verification Required (Deferred — already adjudicated)

These are NOT open blockers for this phase. The human explicitly decided "defer + proceed" on 2026-07-16 (recorded in STATE.md, 04-05-SUMMARY.md, 04-08-SUMMARY.md, deferred-items.md). They are the attended real-world confidence checks to run before shipping, alongside the Phase-8 signing spike:

1. **SC2 real download** — clear `<userData>/.whisper-models/`, run onboarding → the ~488 MB `ggml-small.en` shows visible/resumable progress, SHA256-verifies before "installed", caches in userData; killed-mid-download resumes from `.part`; a corrupt file must NOT register as installed.
2. **Flag 5 latency/memory** — `node scripts/smoke-whisper-mem.js <real-phrase.wav>` → correct-ish transcript, near-real-time Metal latency, whisper-server RSS + `qwen3-vl:8b` RSS coexist in the ~32 GB budget with no swap.
3. **SC5 full 2-min silence** — ambient on, quiet room, 2 full minutes → ZERO transcripts; then one clear sentence transcribes.
4. **SC4 live system audio** — on a signed dev build, confirm the `NSAudioCaptureUsageDescription` TCC prompt fires and `source:'system'` PCM flows (a system-channel transcript appears for other-app audio); determine required signing level + whether relaunch-after-grant is needed. **Gate shipping system audio on this outcome.**
5. **STT-03 resilience** — real sleep→wake (whisper-server re-warms, ambient resumes, no crash) + AirPods in/out mid-session (renderer capture re-attaches, no crash).

### Gaps Summary

No gaps. All six success criteria are implemented, substantively wired, and green on the keyless gates (145/145 tests, lint exit 0, real Mach-O binaries). SC2, SC4, and SC5 reach their code + keyless-proof boundary; the remaining *attended* real-world validations (real 488 MB download, live TCC system-audio capture, full 2-minute silence run, real sleep/wake + AirPods swap) were consciously deferred to pre-ship / Phase 8 by explicit human decision, with the keyless proofs accepted as sufficient to proceed to merge. Scored as satisfied-with-documented-deferral per the phase's human sign-off; the phase goal — a resident transcriber with no per-utterance spawn, the prerequisite for continuous mode — is achieved.

---

_Verified: 2026-07-16_
_Verifier: Claude (gsd-verifier)_
