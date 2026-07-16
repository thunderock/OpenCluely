---
phase: 04-continuous-hearing-resident-stt-ambient-listening
plan: 09
type: execute
wave: 7
depends_on: ["04-08"]
files_modified:
  - src/services/speech.service.js
  - src/core/config.js
  - main.js
  - onboarding.js
  - onboarding.html
  - settings.html
  - src/ui/settings-window.js
  - src/core/first-run.js
  - env.example
  - package.json
  - src/core/local-transport.js
  - src/core/local-model.manager.js
  - src/services/providers/local.provider.js
  - test/local-transport.test.js
  - test/local-model-manager.test.js
  - test/local-provider.test.js
autonomous: false

must_haves:
  truths:
    - "The Azure Speech SDK (microsoft-cognitiveservices-speech-sdk) is uninstalled and never required; no azure code path remains in speech.service.js (SC6/STT-05)"
    - "The ~380-line browser-DOM polyfill is gone — global.URL/Blob/File are never clobbered in the main process; no residual window/AudioContext/global.URL references remain there"
    - "ensureNativeGlobalURL() is retired (definition + export + both call sites removed) and the 3 poison-simulation tests are updated to match — while nodeFetch is KEPT (it is an independent loopback fix, not Azure)"
    - "The LLM path stays green after removal: make run_tests passes and a keyless LocalProvider wiring check (client constructs, ollama.list() shape) succeeds"
    - "speech.provider + speech.azure config, the azure onboarding/settings UI, and AZURE_SPEECH_* env are all removed; STT is collapsed to the single local whisper engine"
  artifacts:
    - path: "src/core/config.js"
      provides: "speech.provider + speech.azure removed; speech.whisper (the collapsed whisper-server block from 04-01) is the only speech config"
      contains: "noSpeechThreshold"
    - path: "src/core/local-transport.js"
      provides: "ensureNativeGlobalURL definition + export removed; nodeFetch + native URL retained"
      contains: "nodeFetch"
    - path: "src/services/providers/local.provider.js"
      provides: "ensureNativeGlobalURL import + call site removed; the OpenAI/ollama client still constructs and uses nodeFetch"
      contains: "nodeFetch"
    - path: "package.json"
      provides: "microsoft-cognitiveservices-speech-sdk dependency removed; node-record-lpcm16 kept (Linux mic, not Azure)"
      contains: "node-record-lpcm16"
  key_links:
    - from: "src/services/providers/local.provider.js"
      to: "127.0.0.1:11434/v1"
      via: "OpenAI/ollama client over nodeFetch — no polyfill defense needed once the polyfill is gone"
      pattern: "nodeFetch"
    - from: "src/core/local-model.manager.js"
      to: "src/core/local-transport.js"
      via: "nodeFetch import retained; ensureNativeGlobalURL import + call removed"
      pattern: "nodeFetch"
---

<objective>
Remove Azure Speech entirely — the FINAL, gated plan of the phase (STT-05/SC6). Now that 04-08 has proven the resident whisper.cpp engine on both channels, delete the Azure Speech SDK, its ~380-line browser-DOM polyfill (which clobbers `global.URL`/`Blob`/`File` at module load), every azure code path and UI/env reference, and retire the `ensureNativeGlobalURL()` workaround the polyfill forced — while KEEPING `nodeFetch` (an independent loopback fix) and verifying the local LLM path stays green. Prove-then-remove, mirroring Phase 3's Gemini removal: a hard human-verify checkpoint gates the deletion.

Purpose: STT-05/SC6 — the Azure SDK + polyfill are fully removed; STT collapses to the single local whisper engine. The removal STRICTLY helps the LLM path (the polyfill's `global.URL` poison was the only cross-cutting effect, and the LLM's coupling to Azure was purely defensive). Sequencing is locked: prove the engine FIRST (04-08), then delete Azure last.
Output: an Azure-free speech.service.js + config + UI + env, the SDK dependency removed, `ensureNativeGlobalURL` retired with its 3 tests updated, and a verified-green LLM path.

Blast radius grounded in RESEARCH Flag 7 (verify each against LIVE code at execution time — 04-03/04-04 refactored speech.service.js, so the Flag-7 line numbers are pre-refactor anchors; the method/symbol NAMES are the durable targets).
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
@.planning/phases/04-continuous-hearing-resident-stt-ambient-listening/04-08-SUMMARY.md

# Live seams (blast radius — verified 2026-07-16; RESEARCH Flag 7 has the full table):
@src/services/speech.service.js
@src/core/config.js
@src/core/local-transport.js
@src/core/local-model.manager.js
@src/services/providers/local.provider.js
@env.example
@package.json
</context>

<tasks>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 1: Prove-then-remove gate — confirm the resident engine works on both channels before deleting Azure</name>
  <what-built>
The resident whisper.cpp STT engine has replaced the Python subprocess (04-03), runs two independent source-tagged channels (04-04), captures macOS system audio behind isSupported/consent/degrade-to-mic (04-05), listens ambiently launch→quit with sleep/wake + device-swap resilience (04-06), and was exercised end-to-end at the 04-08 validation gate (real 488 MB download, near-real-time latency, in-budget memory, 2-min silence → zero transcripts, sleep/wake, AirPods swap, mic/system source tags). Azure is STT-only (confirmed: `microsoft-cognitiveservices-speech-sdk` is required in exactly one place; no LLM/other consumer) and its polyfill only ever HARMED the LLM path. This checkpoint STOPS before the irreversible Azure deletion so a human confirms the engine is proven.
  </what-built>
  <how-to-verify>
  1. Confirm the 04-08 validation gate PASSED: SC2 real download, SC5 2-min silence → zero transcripts, mic source:'mic' tagging, and sleep/wake + AirPods resilience all verified; SC4 system-audio either verified on a signed dev build OR spike-documented with the mic-only baseline confirmed (04-05).
  2. Confirm the app currently answers voice via the resident whisper engine — NOT via Azure (Azure was never the active path in dev; this just double-checks removing it changes nothing user-visible).
  3. Acknowledge this deletes ~380 lines of polyfill + all Azure code/UI/env + the SDK dependency + retires `ensureNativeGlobalURL()`, and that `make run_tests` + a keyless LocalProvider wiring check will gate the result (Task 4). `nodeFetch` is KEPT.
This is the "prove the resident engine on both channels" gate that MUST pass before Azure removal. If 04-08 did not pass, STOP and fix the engine first — do not proceed with deletion.
  </how-to-verify>
  <resume-signal>Type "approved" to proceed with the Azure deletion (04-08 gate passed), or describe what must be fixed first.</resume-signal>
</task>

<task type="auto">
  <name>Task 2: Delete the Azure polyfill + SDK + all azure code paths in speech.service.js (+ config + dep)</name>
  <files>src/services/speech.service.js, src/core/config.js, package.json</files>
  <action>
Ground every deletion against LIVE code (04-03 KEPT these azure branches for prove-then-remove; 04-03/04-04 shifted the line numbers — search by symbol name). Remove from `src/services/speech.service.js`:
- **The browser-DOM polyfill** — the entire `if (typeof window === 'undefined') { ... }` block that fabricates `window`/`document`/`navigator`, the fake `URL` class, and the `global.URL = global.window.URL` clobber (RESEARCH: lines ~1-380, incl. the fake `class URL` ~293 and `global.URL =` ~354). After removal, the module must not reference `window`/`document`/`navigator`/`AudioContext`/`global.URL` at all in the main process.
- **The SDK require** — `sdk = require('microsoft-cognitiveservices-speech-sdk')` + its try/catch + the "Azure Speech SDK unavailable" warn (~392-396).
- **The azure methods** — `_initializeAzureClient` (~459), `_startAzureRecording` (~574), `recognizeFromFile` (~964, azure-only — delete the whole method), and the azure `testConnection` branch (~1001-1015; KEEP the whisper branch 04-03 rewired).
- **The azure branches** in `initializeClient` (~444-445 `if (provider === 'azure') this._initializeAzureClient()`), `startRecording` (~556-557), `stopRecording` (~848), `getStatus` (azureKey/azureRegion/azure-config keys ~1052-1061), `isAvailable` (~1069-1071), `updateSettings` (azure speech keys ~1081), `_getConfiguredProvider` (~1098-1113 — since whisper is now the SOLE provider, this collapses to always-whisper; either delete it and hardcode `this.provider = 'whisper'`, or keep a trivial stub returning 'whisper'), and the `_handleAudioChunk` azure push-stream branch (~1579-1586).
- Remove now-dead azure-only helpers/state (`this.speechConfig`, `this.recognizer`, azure push-stream refs, `_getSetting('azureKey'|'azureRegion')` reads) surfaced by the above. Keep the module export shape (`module.exports = new SpeechService()`) and EVERYTHING the resident path uses (the per-channel pipelines + `handleSystemAudioChunk` from 04-04, the flush→manager.transcribe from 04-03, `_isHallucinatedTranscript`, `_createWavBuffer`, `VadSegmenter`, `node-record-lpcm16` Linux mic). Degrade never crash.

`src/core/config.js`: remove `speech.provider: 'azure'` (~63) and the entire `speech.azure` block (~64-69). Leave `speech.whisper` (the collapsed whisper-server block from 04-01) as the ONLY speech config.

`package.json`: remove the `microsoft-cognitiveservices-speech-sdk` dependency (~37) and run the install so `node_modules`/lockfile reflect it. KEEP `node-record-lpcm16` (~38) — it is the Linux mic capture, NOT Azure.
  </action>
  <verify>`grep -rniE "cognitiveservices|azure|speechConfig|SpeechRecognizer|_initializeAzureClient|_startAzureRecording|recognizeFromFile" src/services/speech.service.js` returns NOTHING. `grep -nE "global\.URL|AudioContext|typeof window" src/services/speech.service.js` returns NOTHING (polyfill gone). `grep -n "speech.azure\|provider: 'azure'\|provider: \"azure\"" src/core/config.js` returns NOTHING; `node -e "const c=require('./src/core/config'); console.log(!!c.get('speech.whisper'), c.get('speech.provider'), c.get('speech.azure'))"` prints `true undefined undefined`. `grep -c "microsoft-cognitiveservices-speech-sdk" package.json` is 0; `grep -c "node-record-lpcm16" package.json` is >= 1. `require('./src/services/speech.service')` loads without throwing (no SDK, no polyfill). `npx eslint src/services/speech.service.js src/core/config.js` clean.</verify>
  <done>The Azure polyfill, SDK require, all azure methods/branches, speech.provider/speech.azure config, and the SDK dependency are gone; the resident whisper path is intact; node-record-lpcm16 is kept; the module loads clean.</done>
</task>

<task type="auto">
  <name>Task 3: Remove the Azure surface — main.js getters/env, onboarding + settings UI, first-run + env.example</name>
  <files>main.js, onboarding.js, onboarding.html, settings.html, src/ui/settings-window.js, src/core/first-run.js, env.example</files>
  <action>
Ground against LIVE code (line anchors are pre-04-03/04-07 snapshots — search by symbol).
main.js:
- `getSettings`: remove `azureKey` (~1567), `azureRegion` (~1568), `azureConfigured` (~1581), and collapse the `speechProvider` default (~1566) — whisper is the only engine, so drop the field or hardcode `'whisper'`.
- `saveSettings`: remove the azure env writes — `SPEECH_PROVIDER` azure branch (~1618-1619), `AZURE_SPEECH_KEY` (~1621-1622), `AZURE_SPEECH_REGION` (~1624-1625), and the `providerChanged` azure logic (~1673) if now moot. Keep the whisper-server settings path.
- Confirm no `getWhisperInstaller`/`detect-whisper`/`install-whisper` remain (04-03 removed them) — grep as a guard.

onboarding.js / onboarding.html: remove the Azure choice-card (html ~797-807), the `azurePanel` + `azureKey`/`azureRegion` inputs (html ~820-839), and the JS azure state + handlers (js `state.azureKey`/`azureRegion` ~44-47; the `#speechChoices` azure toggle + `#azureKey`/`#azureRegion` input listeners ~170-186; the azure persistence in the `speech`-screen save ~652-666; the azure summary row ~596-601). With Azure gone the speech step is whisper-only (single engine) — simplify the choice list to whisper (+ optional skip) and `canAdvance`/`computeScreenOrder` accordingly. Keep the 04-07 whisper-engine presence check + ggml-small.en download intact.

settings.html / src/ui/settings-window.js: remove the `#speechProvider` dropdown's azure `<option>` (html ~387) — and since whisper is the sole engine, remove the provider dropdown entirely (or leave a static "Local Whisper" label); remove `#azureFields` (~393-408), `#azureFieldsNote` (~447-449), and the dead Python `#whisperFields` CLI inputs (`whisperCommand`/`whisperModel`/`whisperLanguage`/`whisperSegmentMs` ~411-445 — superseded by the 04-07 whisper status/model/repair panel). In `settings-window.js` remove the matching refs + logic: `speechProviderSelect`/`azureKeyInput`/`azureRegionInput`/`whisperCommandInput`/`whisperSegmentMsInput` (~9-15), their load (~89-98) + save (~169-176) + `updateSpeechFieldStates` (~191-218) + the inputs array + change listeners (~286-308). KEEP the 04-07 whisper status/model/repair panel and the Local-model (PROV-06) panel.

src/core/first-run.js: remove `azureConfigured` (~84) from `getStatus` (drop or replace `whisperConfigured` with a whisper-server-oriented check); rewrite the `.env` template in `_readTemplate` (~110-128) to drop the azure/Python-whisper lines (`SPEECH_PROVIDER`/`WHISPER_COMMAND`/`WHISPER_MODEL=turbo`/`WHISPER_LANGUAGE`/`WHISPER_SEGMENT_MS`) — leave a minimal whisper-server-oriented comment (or nothing speech-specific; config.js defaults cover it).

env.example: remove `AZURE_SPEECH_KEY`/`AZURE_SPEECH_REGION` (~10-11) and the stale Python `WHISPER_COMMAND`/`WHISPER_MODEL`/`WHISPER_LANGUAGE`/`WHISPER_SEGMENT_MS`/`WHISPER_MODEL_DIR` block (~13-25). Optionally add the whisper-server knobs (host/port/model/threads/noSpeechThreshold) as commented overrides, matching the collapsed config.

preload.js needs NO change: it has no azure-specific bridge (detect/install were removed in 04-03; azure only ever rode inside the generic getSettings/saveSettings payload) — Task 4's grep confirms this. `webapp/index.html:345` marketing Azure copy is cosmetic/low-priority (optional; note in SUMMARY if left).
  </action>
  <verify>`grep -rniE "azure" main.js onboarding.js onboarding.html settings.html src/ui/settings-window.js src/core/first-run.js env.example` returns NOTHING (surface clean). `grep -rniE "azure" preload.js` returns NOTHING (no bridge — confirms preload needs no edit). `grep -nE "WHISPER_COMMAND|WHISPER_SEGMENT_MS|turbo" env.example src/core/first-run.js` returns NOTHING (stale Python env gone). `npx eslint main.js onboarding.js src/ui/settings-window.js src/core/first-run.js` clean. App boots headless without throwing; onboarding + settings open without azure UI and without referencing a missing field.</verify>
  <done>All azure getters/env in main.js, the azure onboarding card/panel/inputs, the settings azure dropdown-option + fields + dead Python CLI fields, first-run azureConfigured + .env azure/Python template, and env.example azure/Python vars are removed; STT is a single local whisper engine end-to-end; preload needs no change.</done>
</task>

<task type="auto">
  <name>Task 4: Retire ensureNativeGlobalURL (+ update 3 poison tests) + verify the LLM path green</name>
  <files>src/core/local-transport.js, src/core/local-model.manager.js, src/services/providers/local.provider.js, test/local-transport.test.js, test/local-model-manager.test.js, test/local-provider.test.js</files>
  <action>
With the polyfill gone, `global.URL` is never clobbered, so `ensureNativeGlobalURL()` is a permanent no-op → retire it (CONTEXT locked "retire", not "leave as no-op").
- `src/core/local-transport.js`: remove the `ensureNativeGlobalURL` definition (~38) and drop it from the `module.exports` (~144). KEEP `nodeFetch` (~72) + the native `URL` require + `normalizeHeaders` in the export — nodeFetch is the independent Electron-main loopback fix (Chromium-net false-negatives the local daemon), unrelated to Azure. Do NOT remove it.
- `src/core/local-model.manager.js`: remove `ensureNativeGlobalURL` from the require (~22, keep `nodeFetch`) and delete the `ensureNativeGlobalURL();` call (~34) + its now-stale Azure-polyfill comment. The `const { URL } = require('node:url')` native import (~20) can stay (harmless, still used) or its comment simplified.
- `src/services/providers/local.provider.js`: remove `ensureNativeGlobalURL` from the require (~22, keep `nodeFetch`) and delete the `ensureNativeGlobalURL();` call (~61) + its polyfill comment. The `dangerouslyAllowBrowser` handling stays (it was for the polyfill's `window` triad in the main process; with the polyfill gone it is harmless/defensive — leave it unless it clearly references a now-absent global; do not expand scope).
- **Update the 3 poison-simulation tests** (they assert a defense that no longer exists):
  - `test/local-transport.test.js`: remove the `ensureNativeGlobalURL` import (~18) and the `'ensureNativeGlobalURL() restores a poisoned global.URL'` test (~57). KEEP the `nodeFetch` tests — including `'nodeFetch() parses the host with the NATIVE URL even when global.URL is poisoned'` (~144): nodeFetch stays and manually simulating a poisoned global.URL still validly proves nodeFetch uses the native URL (leave that test, just ensure it no longer imports/uses the retired function).
  - `test/local-model-manager.test.js`: remove/rewrite the fake Azure-polyfill proxy (~294-316) and the `'getStatus().serverUp stays true when the Azure polyfill has poisoned global.URL'` test (~318-340) — either delete it or convert it to a plain "serverUp true on a reachable daemon" test with no poison simulation.
  - `test/local-provider.test.js`: remove/rewrite the `'LocalProvider robustness vs the Azure browser-DOM polyfill'` describe (~169-215) and its `'poisoned global URL is repaired'` assertion (~214) — convert to a plain "client initializes network-free" wiring test, or delete if redundant with existing coverage.
- **LLM-regression check** (Azure removal cannot regress the LLM path — its only coupling was defensive): run `make run_tests` (all node:test suites green) + a keyless LocalProvider wiring check per the "keyless wiring check, waive un-runnable live checks" memory rule (construct LocalProvider network-free; confirm the client builds + `ollama.list()`/`isAvailable` shape is reachable without a live server). Confirm NO residual `window`/`AudioContext`/`global.URL` references remain in the main process.
  </action>
  <verify>`grep -rn "ensureNativeGlobalURL" src/ test/` returns NOTHING (definition + export + both call sites + all test refs gone). `grep -rn "nodeFetch" src/core/local-transport.js src/core/local-model.manager.js src/services/providers/local.provider.js` still present (kept). `grep -rniE "global\.URL|AudioContext|typeof window ===" src/ main.js` returns nothing in the main process (polyfill fully retired). `make run_tests` green (updated 3 suites + all others). `node -e "const P=require('./src/services/providers/local.provider'); const p=new (P.LocalProvider||P)({}); console.log(typeof p.isAvailable, typeof p.generateStream)"` prints two `function`s (constructs network-free, no throw). `make lint` clean.</verify>
  <done>ensureNativeGlobalURL is fully retired (definition + export + 2 call sites + 3 tests) while nodeFetch is kept; make run_tests is green; the keyless LocalProvider wiring check passes; no residual browser-globals remain in the main process.</done>
</task>

</tasks>

<verification>
- `make run_tests` green (3 updated suites + all others); `make lint` exits 0.
- No `microsoft-cognitiveservices-speech-sdk`, `azure`, polyfill (`global.URL`/`AudioContext`/`typeof window`), or `ensureNativeGlobalURL` references remain in `src/`, `main.js`, `onboarding.*`, `settings.*`, `env.example`, or `package.json`.
- `nodeFetch` + `node-record-lpcm16` are KEPT.
- The keyless LocalProvider wiring check passes; the local LLM path is verified green post-removal.
- STT is collapsed to the single local whisper engine (no provider selection, no azure UI/env/config).
</verification>

<success_criteria>
- STT-05/SC6: the Azure Speech SDK + its ~380-line browser-DOM polyfill are fully removed; speech.provider/speech.azure config, azure UI, and AZURE_SPEECH_* env are gone.
- ensureNativeGlobalURL is retired with its 3 tests updated; nodeFetch is kept.
- The LLM path is verified green (make run_tests + keyless wiring check); no residual browser-globals in the main process.
- Removal happened LAST, behind a hard human-verify checkpoint, after 04-08 proved the resident engine on both channels.
</success_criteria>

<output>
After completion, create `.planning/phases/04-continuous-hearing-resident-stt-ambient-listening/04-09-SUMMARY.md`
</output>
