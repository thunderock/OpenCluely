---
phase: 04-continuous-hearing-resident-stt-ambient-listening
plan: 06
type: execute
wave: 5
depends_on: ["04-05"]
files_modified:
  - main.js
  - src/services/speech.service.js
  - src/ui/main-window.js
autonomous: true

must_haves:
  truths:
    - "The app keeps the audio stream open from launch to quit (ambient listening), auto-starting mic (+ system if supported) after app.whenReady() (STT-03/SC3)"
    - "The existing mic-button/recording control + Alt+R act as an interim on/off stop (no full Phase-6 kill switch)"
    - "On powerMonitor 'resume' the app re-warms: re-probe/restart whisper-server + reopen the tap, guarded against re-entrancy and in-flight transcription (survives sleep/wake)"
    - "A mic-device change (AirPods in/out) re-attaches the renderer capture without crashing"
  artifacts:
    - path: "main.js"
      provides: "Ambient auto-listen after whenReady; powerMonitor.on('resume') re-warm of whisper-server + tap with re-entrancy guard; interim stop wired to the mic control"
      contains: "powerMonitor"
    - path: "src/ui/main-window.js"
      provides: "navigator.mediaDevices devicechange handler re-acquiring getUserMedia without crashing"
      contains: "devicechange"
  key_links:
    - from: "main.js:onAppReady"
      to: "speechService.startRecording() (ambient)"
      via: "auto-listen from launch after managers start"
      pattern: "startRecording"
    - from: "main.js:powerMonitor.on('resume')"
      to: "whisperServerManager re-warm + systemAudioTap reopen"
      via: "re-probe/restart guarded by a _rewarmInFlight flag"
      pattern: "resume"
---

<objective>
Turn the proven per-channel STT engine into an always-on ambient listener that survives a full session: auto-listen from launch to quit, repurpose the existing mic control as an interim on/off stop, and add the LOCKED resilience — `powerMonitor.on('resume')` re-warm (re-probe/restart whisper-server + reopen the tap; openwhispr #766 GPU/stream eviction on sleep) and mic-device-change re-attach (AirPods in/out) without crashing, guarding re-entrancy.

Purpose: STT-03/SC3 — the stream stays open launch→quit, transcribing on VAD-detected pauses via the existing VAD + hallucination filter. Resilience is in-scope and locked ("survive a full session"). The full Phase-6 trust indicator + kill switch are NOT built here (interim mic-control stop only).
Output: ambient auto-listen + interim stop + sleep/wake + device-change resilience.
</objective>

<execution_context>
@~/.claude/get-shit-done/workflows/execute-plan.md
@~/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/phases/04-continuous-hearing-resident-stt-ambient-listening/04-CONTEXT.md
@.planning/phases/04-continuous-hearing-resident-stt-ambient-listening/04-RESEARCH.md
@.planning/research/OPENWHISPR-NOTES.md
@.planning/phases/04-continuous-hearing-resident-stt-ambient-listening/04-05-SUMMARY.md

# Live seams (verified):
@src/services/speech.service.js
@src/ui/main-window.js
</context>

<tasks>

<task type="auto">
  <name>Task 1: Ambient auto-listen from launch + interim stop</name>
  <files>main.js, src/services/speech.service.js</files>
  <action>
main.js `onAppReady` (after the whisper-server + tap managers start, `:283-296`): auto-start ambient listening once the mic path is available — call the same entry the toggle uses (`speechService.startRecording()`), NON-BLOCKING + guarded (only if the engine is available; if the model is still downloading on first run, defer the auto-start until the engine reports ready, do not block launch). The stream then stays open launch → quit.
Repurpose the EXISTING mic control as the interim on/off stop (no new UI): the mic button (`main-window.js:314` click), Alt+R (`main.js:340` → `toggleSpeechRecognition` `:941-969`) already toggle recording — keep them as the interim pause/resume of ambient listening. Update copy/log to reflect "ambient listening" rather than a manual recording session where it is user-visible, but DO NOT build the Phase-6 persistent indicator or one-click kill switch (out of scope).
speech.service.js: ensure `startRecording`/`stopRecording` cleanly start/stop BOTH channels (mic + system) and are idempotent (guard against double-start). Ensure quit teardown (`_cleanup`) stops both channels + the watchdog.
Keep the interim stop honest: stopping halts mic capture (and system tap via its manager) so the user has a real off switch this phase.
  </action>
  <verify>`grep -n "startRecording" main.js | grep -i "ready\|ambient\|whenReady\|onAppReady"` shows the auto-listen wiring. App boots headless and (with the engine available) begins ambient listening without a manual trigger; Alt+R / mic button toggle it off/on. `npx eslint main.js src/services/speech.service.js` clean. `make run_tests` green.</verify>
  <done>Ambient listening auto-starts from launch (deferred until the engine is ready on first run), stays open until quit, and the existing mic control + Alt+R act as the interim on/off.</done>
</task>

<task type="auto">
  <name>Task 2: Sleep/wake re-warm + mic-device-change re-attach (resilience)</name>
  <files>main.js, src/ui/main-window.js, src/services/speech.service.js</files>
  <action>
**powerMonitor resume re-warm** (openwhispr #766 — sleep evicts GPU/stream state): in main.js, `require('electron').powerMonitor.on('resume', ...)` → a `onWakeFromSleep()` that, guarded by a `_rewarmInFlight` flag (never re-enter) and NOT interrupting an in-progress transcription: (a) re-probe the whisper-server via the manager's health; if down, restart it (the manager re-picks a free port on restart — 04-01); (b) if the system tap was running, reopen it (SystemAudioTapManager.start() again, respecting the persisted grant); (c) if ambient listening was active, re-acquire the mic stream. Replay the LAST known state (do not force-start if the user had paused). Add a short settle delay before re-warming (let the driver settle), mirroring openwhispr.
**Mic-device change** (AirPods in/out): in `src/ui/main-window.js`, add a `navigator.mediaDevices.addEventListener('devicechange', ...)` handler that, while ambient/recording is active, tears down and re-acquires the getUserMedia stream (`_stopRendererAudioCapture()` then `_startRendererAudioCapture()`), debounced, wrapped in try/catch so a transient device error never crashes the renderer. If re-acquire fails, notify main (existing `stopSpeechRecognition` path) so the state stays consistent.
speech.service.js: make the re-entrancy guards on flush/ingest robust to a re-attach mid-utterance (a device swap should not double-flush or strand a segment); reset the affected channel's VAD state on re-attach.
Guard everything against re-entrancy and against a null manager/tap (degrade, never crash).
  </action>
  <verify>`grep -n "powerMonitor\|resume\|_rewarmInFlight" main.js` shows the guarded re-warm. `grep -n "devicechange" src/ui/main-window.js` shows the re-attach handler. `npx eslint main.js src/ui/main-window.js src/services/speech.service.js` clean. App boots headless without crashing. (Full sleep/wake + AirPods swap is exercised at the 04-08 validation gate; here confirm the handlers are wired + re-entrancy-guarded + no crash on a simulated resume event.)</verify>
  <done>powerMonitor 'resume' re-warms whisper-server + tap + mic stream guarded against re-entrancy/in-flight transcription; a mic-device change re-attaches renderer capture without crashing.</done>
</task>

</tasks>

<verification>
- `make run_tests` green; `make lint` exits 0.
- Ambient listening auto-starts from launch and stays open to quit; interim stop works via the mic control + Alt+R.
- `powerMonitor.on('resume')` re-warm is wired + re-entrancy-guarded; mic `devicechange` re-attach is wired + crash-safe.
- No new Phase-6 indicator/kill-switch UI introduced.
</verification>

<success_criteria>
- STT-03/SC3: the audio stream stays open launch→quit (ambient listening), transcribing on VAD pauses via the existing VAD + hallucination filter; interim on/off via the existing mic control.
- Resilience: survives sleep/wake (re-warm) and mic-device changes (re-attach) without crashing — "survive a full session."
</success_criteria>

<output>
After completion, create `.planning/phases/04-continuous-hearing-resident-stt-ambient-listening/04-06-SUMMARY.md`
</output>
