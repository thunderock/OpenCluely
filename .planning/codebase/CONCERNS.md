# Codebase Concerns

**Analysis Date:** 2026-07-13

**Context:** The owner intends to transform OpenCluely from a cloud-Gemini overlay into a fully-local AI app: a self-starting local model service (à la Ollama), continuous audio listening + screen watching, a multimodal local model, and md-file context injection. Findings below are written generally, but flagged with **[LOCAL-AI]** where they directly bear on that transformation.

## Tech Debt

**Gemini is not behind a provider abstraction — it *is* the LLM layer. [LOCAL-AI]**
- Issue: `src/services/llm.service.js` (1443 lines) imports `GoogleGenAI` directly (`const { GoogleGenAI } = require('@google/genai')`, line 1) and every method builds Gemini-shaped request objects (`systemInstruction`, `generationConfig`, `contents[].parts[].inlineData`) and calls Gemini-specific SDK/REST methods. There is no `LLMProvider` interface with a `GeminiProvider` implementation — just one class that *is* Gemini.
- Files: `src/services/llm.service.js:1-1654`, `main.js:605-662` (IPC handlers literally named `set-gemini-api-key`, `get-gemini-status`, `test-gemini-connection`, `run-gemini-diagnostics`), `preload.js:34-37` (`setGeminiApiKey`, `getGeminiStatus`, `testGeminiConnection` exposed to every renderer).
- Impact: The call-site shape used by `main.js` (`llmService.processImageWithSkillStream(...)`, `processTextWithSkillStream(...)`, `processTranscriptionWithIntelligentResponseStream(...)`) is reasonably generic and worth preserving, but everything *inside* those methods — retries across `modelsToTry`, the raw HTTPS fallback in `executeAlternativeRequest`/`_streamRequestForModel`, error classification in `analyzeError()` — is Gemini-specific. Swapping in a local model means rewriting the internals of this file, not adding a sibling class.
- Fix approach: Extract an `LLMProvider` interface (`generate`, `generateStream`, `isAvailable`, `testConnection`) with `GeminiProvider` wrapping the existing code verbatim and a new `LocalProvider` (e.g. talking to an Ollama-compatible `/api/generate` or `/api/chat` endpoint) implementing the same shape. `main.js` and `sessionManager` call sites need no change if this is done first.

**The Gemini REST hostname is hard-coded in 6 places across 2 files. [LOCAL-AI]**
- Issue: `generativelanguage.googleapis.com` is a literal string in `src/services/llm.service.js:1118, 1196, 1281, 1572` (stream URL, connectivity probe, alternative-request URL) and in `main.js:307, 315` inside `setupNetworkConfiguration()`, which special-cases the Electron `session` for that exact host — overriding the `User-Agent` header and, more importantly, unconditionally trusting its TLS certificate (see Security Considerations).
- Files: `src/services/llm.service.js`, `main.js:301-323`
- Impact: A local provider needs none of this (no internet host, no cert override), but nothing marks these blocks as "only relevant when provider === gemini" — they run unconditionally at every app start regardless of which provider is active.
- Fix approach: Move the network/cert special-casing into the `GeminiProvider` itself (called only when that provider initializes), not into global `app.whenReady()` startup code.

**Whisper runs as a fresh subprocess per utterance, not a persistent daemon. [LOCAL-AI]**
- Issue: `_transcribeWhisperFile()` in `src/services/speech.service.js:1752-1808` spawns `whisper` (a Python process that reloads the model into memory) via `child_process.spawn` for every flushed VAD segment, writing a temp WAV file first (`_transcribeWhisperBuffer`, line 1740) and reading a temp `.txt` output back. For a single on-demand utterance this is acceptable; for **continuous listening** this means a new Python interpreter + model load on every pause in speech, which is seconds of latency and CPU/memory churn per utterance, not the persistent-server model `Ollama` uses.
- Files: `src/services/speech.service.js:671-706` (`_startWhisperRecording`), `1666-1808` (flush/transcribe path)
- Impact: This is the biggest structural blocker to "continuous audio listening" — the current design assumes discrete start/stop recording sessions with occasional flushes, not an always-on pipeline feeding a resident model.
- Fix approach: A local-AI pivot needs a long-running local STT process (faster-whisper server, whisper.cpp server, or the local multimodal model's own audio path) that the app talks to over a socket/HTTP, mirroring how `WhisperInstaller` already manages a venv lifecycle — but for a *server process*, not a *per-call CLI*.

**Screenshot capture is a single-shot, full-resolution, on-demand pipeline. [LOCAL-AI]**
- Issue: `src/services/capture.service.js` has one entry point (`captureAndProcess`) invoked only from the `CommandOrControl+Shift+S` shortcut or the `take-screenshot` IPC handler (`main.js:409, 1019-1099`). It captures via `desktopCapturer.getSources()`, optionally crops, and PNG-encodes the full image before base64-embedding it into the Gemini request (`llm.service.js:142-150`, `243`).
- Files: `src/services/capture.service.js:1-123`, `main.js:1019-1099`
- Impact: There is no interval/loop capture, no downscaling, no frame-diffing, and no throttling logic anywhere in the codebase. "Continuous screen watching" needs all four; sending a full-resolution PNG to a local multimodal model on every tick (even at 1 fps) will saturate CPU (PNG encode) and VRAM/context (image tokens) fast.
- Fix approach: Add a capture-loop mode with configurable interval, downscale-before-encode, and a cheap diff/hash check to skip unchanged frames before they ever reach the model.

**No process supervisor exists for a long-running local service. [LOCAL-AI]**
- Issue: Every child process in the codebase is fire-and-forget and short-lived: Whisper transcription (`speech.service.js`), venv creation / pip install (`src/core/whisper-installer.js`), the sox/arecord microphone stream (stopped/restarted per recording session). Nothing in the codebase starts a background service, checks if it's already running, binds/reuses a port, restarts it on crash, or stops it on app quit.
- Files: `src/core/whisper-installer.js:1-627` (closest analog — manages an install lifecycle, not a running server), `main.js:1466-1475` (`onWillQuit` only tears down windows/shortcuts/session, no service shutdown hook)
- Impact: "Self-starting local model service à la Ollama" requires this exact capability and there is currently zero scaffolding for it — not even a naming convention (e.g. no `*.process-manager.js` or `*.daemon.js`).
- Fix approach: A new manager (e.g. `src/managers/local-model.manager.js`) modeled loosely on `WhisperInstaller`'s platform detection/spawn patterns, but supervising a long-lived process: health-check via HTTP ping, restart-on-crash with backoff, and a shutdown hook wired into `app.on('will-quit')` alongside the existing `windowManager.destroyAllWindows()` / `globalShortcut.unregisterAll()` calls.

**The "skill" system is mostly vestigial; only `dsa` is reachable.**
- Issue: `prompt-loader.js`'s `loadPrompts()` explicitly skips every prompt file except `dsa.md` (`if (skillName !== 'dsa') continue;`, line 31), and `getAvailableSkills()` hard-returns `['dsa']` (line 371). Yet `normalizeSkillName()` (lines 319-361) still maps a dozen skill aliases (`behavioral`, `sales`, `presentation`, `data-science`, `devops`, `system-design`, `negotiation`), and `llm.service.js`'s `generateIntelligentFallbackResponse()` (lines 1349-1390) still keys a keyword dictionary off those same unreachable skills.
- Files: `prompt-loader.js:9-11, 30-31, 367-372`, `src/services/llm.service.js:1352-1363`, `prompts/programming.md` (present on disk, never loaded)
- Impact: Anyone extending the skill system (or reusing it as a shape for injecting md-file context per the local-AI roadmap) will trip over dead branches that look live.
- Fix approach: Either delete the unreachable skill plumbing or explicitly re-enable multi-skill loading — don't leave both states half-present. If md-file context injection is meant to replace/extend this skill-prompt mechanism, `prompt-loader.js` is the natural place to generalize (it already loads directory contents into a `Map`).

**Platform branching is duplicated inline across 4+ files instead of centralized.**
- Issue: `process.platform === 'darwin'` / `'win32'` / `'linux'` checks are repeated independently in `main.js` (GPU flags, stealth, icon), `src/managers/window.manager.js` (window levels, always-on-top strategy, content protection), `src/services/speech.service.js` (recorder binary choice, renderer-vs-native capture gate), and `src/ui/main-window.js` (renderer-side platform sniff via `navigator.platform`/`userAgentData`, which must be kept manually in sync with the main-process gate).
- Files: `main.js:53-62, 1764-1783`, `src/managers/window.manager.js:148-174, 543-697, 829-888`, `src/services/speech.service.js:689, 1533-1536`, `src/ui/main-window.js:650-661`
- Impact: A local-model-service rollout will add its own platform-specific install/run logic (different binary per OS, like Whisper already needs); without a shared platform-adapter module, that logic will be scattered a fifth and sixth time.
- Fix approach: Introduce a small `src/core/platform.js` exposing the decisions already duplicated (e.g. `platform.audioCaptureMode()`, `platform.preferredAlwaysOnTopLevel()`) so new local-AI platform logic has one place to live.

**Duplicated, drifting `.env` read/write logic.**
- Issue: `main.js` has a hand-rolled `.env` writer (`persistEnvUpdates`, lines 1659-1723, plus `formatEnvValue`, lines 34-40) with its own quoting rules, while `src/core/first-run.js` has an independent hand-rolled `.env` *reader* (`_readEnv`, lines 93-126) with different quote-handling logic. Both parse/write the same file format without sharing code.
- Files: `main.js:29-40, 1659-1723`, `src/core/first-run.js:93-126`
- Impact: A quoting edge case fixed in one will not be fixed in the other (the codebase already has comments documenting past bugs from Windows paths with spaces and embedded quotes — evidence this has bitten the project before).
- Fix approach: Extract one small `envFile.js` module (`read`, `upsert`) used by both.

**Dead/inconsistent config value.**
- Issue: `src/core/config.js:60` sets `speech.provider: 'azure'` as a config default, but `speech.service.js`'s real provider-resolution method, `_getConfiguredProvider()` (lines 1171-1186), never reads `config.get('speech.provider')` at all — it reads `process.env.SPEECH_PROVIDER` / a runtime setting and defaults to `'whisper'` if neither is set. The config.js value is pure dead weight that misleads anyone reading it as documentation.
- Files: `src/core/config.js:59-92`, `src/services/speech.service.js:1171-1186`

**Hard-coded/guessed Gemini model identifiers with no single source of truth.**
- Issue: `src/core/config.js:43-44` hard-codes `model: 'gemini-3.1-flash-lite'` with `fallbackModels: ['gemini-2.5-flash-lite', 'gemini-3.5-flash']`, while a comment in `src/services/llm.service.js:31` says `// Use the configured model name (default: gemini-3.5-flash)` — the comment and the actual configured default disagree.
- Files: `src/core/config.js:43-44`, `src/services/llm.service.js:31`
- Impact: Minor now, but illustrates the general pattern: model identifiers are magic strings with no registry, which will make it harder to add a "local model name" alongside Gemini's model names later.

**Orphaned/dead code left in the tree.**
- `src/services/fallback-capture.service.js` is a **0-byte file** — no content, not required anywhere (`grep` for its filename outside itself returns nothing). Confusing to encounter beside the real `capture.service.js`.
- `global.windowManager` is referenced 4 times in `src/services/speech.service.js` (lines 657-658, 694-695, 703-704, 976-977) as `if (global.windowManager) { global.windowManager.handleRecordingStarted(); }` but **nothing in the codebase ever assigns `global.windowManager`** — these calls are permanently dead; the real notification path is the `EventEmitter` `'recording-started'`/`'recording-stopped'` events wired up in `main.js:365-406`.
- `src/ui/main-window.js:1004-1096` defines a complete second, unreachable Gemini-configuration UI (`showGeminiConfig()`, `createGeminiConfigModal()`, `configureGemini()`). Nothing calls `showGeminiConfig()` — no button, no IPC event (`onOpenGeminiConfig` is wired in `preload.js:112` but `main.js` never emits `open-gemini-config`). See also the Known Bugs entry below: this dead path also has a persistence bug, so re-wiring it without fixing that would reintroduce a regression.
- Duplicate IPC registrations for the same operation: `save-settings` is registered as both `ipcMain.handle` (`main.js:793`) and `ipcMain.on` (`main.js:871`) and both are genuinely exercised (`onboarding.js`/`main-window.js` use the invoke form via `electronAPI.saveSettings`; `settings.html`'s own script uses the send form via `window.api.send('save-settings', ...)`). Functionally harmless since both call the same `this.saveSettings()`, but it means the same feature has two independent call paths to keep in sync.
- `ipcMain.handle("quit-app", ...)` (`main.js:837-860`) is dead: no renderer code calls `ipcRenderer.invoke('quit-app')` — every quit path (`preload.js:71-77`, `settings-window.js:52`, `llm-response.html:1029`) uses the `send`/`ipcMain.on` form (`main.js:882-894`) instead.

**Project metadata is self-contradictory.**
- Issue: `package.json:31` declares `"license": "ISC"`, the `LICENSE` file contains the full **Apache License 2.0** text, and `README.md:216-218` says "Released under the MIT License." Three different licenses stated in three places.
- Files: `package.json:31`, `LICENSE:1-3`, `README.md:216-218`
- Impact: Low technical impact, but a real problem for anyone trying to determine actual usage rights (contributors, downstream packagers, or a future relicensing decision if the project goes fully local/open-core).

## Known Bugs

**`close-window` IPC handler never actually closes/hides the calling window.**
- Symptoms: Any renderer calling `window.electronAPI.closeWindow()` gets `{ success: true }` back, but the intended "hide whichever window sent this" behavior silently does nothing.
- Files: `main.js:814-823`
- Trigger: The handler calls `windowManager.windows.forEach((win, type) => { if (win.webContents === webContents) { win.hide(); return true; } })` — `Map.prototype.forEach` ignores its callback's return value and has no early-exit, so the `return true` neither stops iteration nor produces a usable result; `const window = ...forEach(...)` is always `undefined`. The `win.hide()` call itself *would* work if the matching window is ever reached, so the bug is benign only by accident (it still hides the right window when the map has one matching entry, it's just written in a way that looks intentional but the "found the window" branch is unused dead code).
- Workaround: None needed today since the only visible effect (hiding the matching window) happens to work; the bug matters if someone edits this code expecting `window` to hold a real value.

**Orphaned Gemini-config modal can silently fail to persist the API key.**
- Symptoms: If `MainWindowUI.showGeminiConfig()`/`configureGemini()` (`src/ui/main-window.js:1004-1096`) were ever wired up to a button, entering a key there calls `window.electronAPI.setGeminiApiKey(apiKey)`, which hits `ipcMain.handle("set-gemini-api-key", ...)` (`main.js:605-608`) → `llmService.updateApiKey(newApiKey)` (`llm.service.js:1512-1518`), which only sets `process.env.GEMINI_API_KEY` in memory and reinitializes the client. It never calls `persistEnvUpdates()`.
- Files: `main.js:605-608`, `src/services/llm.service.js:1512-1518`, `src/ui/main-window.js:1064-1091`
- Trigger: Use this path (currently unreachable from the UI) instead of the Settings window's `saveSettings` flow.
- Workaround: The real Settings window (`settings.html` → `save-settings` → `main.js:1516-1642` `saveSettings()`) is the only path that writes `GEMINI_API_KEY` to `.env` via `persistEnvUpdates()`. Keep using that; don't re-wire the orphaned modal without adding persistence.

## Security Considerations

**Certificate validation is unconditionally bypassed for the Gemini host.**
- Risk: `main.js:313-320` installs a `session.defaultSession.setCertificateVerifyProc` that does `if (request.hostname === 'generativelanguage.googleapis.com') { callback(0); }` — `callback(0)` means "treat this certificate as valid" regardless of what Chromium's own verification concluded. This unconditionally trusts *any* certificate presented for that hostname (self-signed, expired, wrong CA — anything), for every request the app makes to it, including the ones carrying the user's Gemini API key and full conversation/screenshot content.
- Files: `main.js:301-323` (`setupNetworkConfiguration`)
- Current mitigation: None — this is intentional code (comment says "Trust Google's certificates"), presumably added to work around corporate proxies/TLS-inspecting networks, but it removes TLS's protection against exactly that kind of interception for this host.
- Recommendations: Remove the blanket bypass. If the goal is tolerating corporate TLS-inspection proxies, surface a specific, user-opt-in "network compatibility mode" setting instead of silently trusting all certs for the API host by default. This block should also be scoped inside the Gemini provider (only registered when that provider is active), not run unconditionally at every startup regardless of provider — doubly so once a local provider needs no network trust at all.

**LLM output is inserted into the DOM without HTML sanitization.**
- Risk: Model responses are rendered via `marked.parse()`/a bespoke markdown lib and then assigned directly to `.innerHTML` with no sanitizer (no DOMPurify or equivalent found anywhere in the codebase). Confirmed at `src/ui/chat-window.js:364` (`textDiv.innerHTML = this.formatMarkdown(text)`), `chat.html:869`, and `llm-response.html:607, 837, 882` (`marked.parse(text)` → `innerHTML`).
- Files: `src/ui/chat-window.js:364, 481-494`, `chat.html:869`, `llm-response.html:607-908`
- Current mitigation: `contextIsolation: true` / `nodeIntegration: false` are set on all `BrowserWindow`s (`src/managers/window.manager.js:279-280`), which limits blast radius (no direct Node/`require` access from a compromised renderer). External navigation is also funneled to the OS browser (`window.manager.js:456-467`).
- Recommendations: Because these are AI-generated strings — reachable via prompt injection embedded in a screenshotted page, a malicious PDF/image, or adversarial audio — treat them as untrusted input and sanitize before `innerHTML` (e.g. DOMPurify), especially since `preload.js` exposes a wide privileged surface (`quit`, `restartAppForStealth`, `openExternal`, settings read/write, clipboard write, Whisper install/download) to the very same renderer context that would execute injected markup. This risk grows as the roadmap adds continuous screen watching and md-file context injection — both increase the volume of untrusted content flowing into the same rendering path.

**API keys are stored in a plaintext `.env` file with no OS keychain integration.**
- Risk: `GEMINI_API_KEY` and `AZURE_SPEECH_KEY` are persisted as plaintext in the `.env` resolved by `resolveEnvPath()` (`main.js:12-26`, typically Electron's `userData` directory in packaged builds). `FirstRunManager.ensureEnv()` does `fs.chmodSync(this.envPath, 0o600)` on creation (`src/core/first-run.js:54-56`) as a best-effort permission tightening, but `persistEnvUpdates()`'s own write path (`main.js:1709-1712`, temp-file + rename) does not re-apply that mode, so a rewritten `.env` can silently lose the restrictive permission.
- Files: `main.js:12-26, 1659-1723`, `src/core/first-run.js:42-62`
- Current mitigation: `0600` permissions on initial creation only; file is `.gitignore`d.
- Recommendations: Use the OS keychain (`keytar`-style, or Electron's `safeStorage` API) for secrets, or at minimum re-apply `chmod 0600` after every rewrite in `persistEnvUpdates()`. This matters more, not less, in a local-AI pivot: a local model service will likely need its own credentials/tokens (or none at all, which is actually a point in favor of going local), so get the pattern right before adding more secrets to it.

**Any window's renderer can read all configured provider settings, including keys, via one IPC call.**
- Risk: `ipcMain.handle("get-settings", ...)` (`main.js:680-682` → `getSettings()`, lines 1490-1514) returns `geminiKey`, `azureKey`, and `whisperCommand` (which can contain an absolute filesystem path) to whichever renderer calls it. This is necessary for the Settings UI, but it is not scoped to the Settings window — the same `electronAPI.getSettings()` is available in every `BrowserWindow`, including the LLM-response window that renders untrusted model output (see the sanitization finding above).
- Files: `main.js:680-682, 1490-1514`, `preload.js:42`
- Recommendations: If sanitization is not added, consider at least restricting which windows can invoke `get-settings`/`open-external` (e.g. by checking `event.sender` against the settings window's `webContents.id`), so a hypothetical HTML-injection in the response window can't trivially exfiltrate configured keys through `openExternal`.

**Stealth process-disguise features may trip AV/EDR heuristics and complicate support.**
- Risk: The app deliberately renames its own process/dock/taskbar identity to look like `Terminal`, `Activity Monitor`, or `System Settings` (`main.js:151-169, 1725-1882`), sets `ELECTRON_NO_ATTACH_CONSOLE`/`ELECTRON_NO_ASAR` on macOS, and tries multiple native window levels to defeat screen-capture (`setContentProtection(true)`, `src/managers/window.manager.js:629-638`). This is the app's core value proposition (an "invisible" interview overlay), not a defect, but process-name spoofing plus `setContentProtection` is exactly the pattern antivirus/EDR heuristics and screen-recording software increasingly flag. It also means bug reports/crash logs from users will show a misleading process name, complicating support.
- Files: `main.js:151-169, 1725-1882`, `src/managers/window.manager.js:543-697`
- Recommendations: No change required for the product's stated purpose, but keep this in mind when triaging user-reported crashes (the visible process name in Task Manager/Activity Monitor will not match "OpenCluely"), and re-test these code paths after every Electron upgrade since `setContentProtection`/window-level behavior is Chromium-version-sensitive.

## Performance Bottlenecks

**Continuous background polling competes with any future local inference workload. [LOCAL-AI]**
- Problem: Multiple `setInterval` loops run for the app's entire lifetime: `window.manager.js` runs a screen tracker every 2s (`screenWatcher`, line 1573), a desktop tracker every 10s (`desktopWatcher`, line 1693), a screen-capture-availability probe every 5s on non-Linux (`screenCaptureAvailabilityWatcher`, line 942), and a per-window always-on-top re-enforcement every 3s for *each* open window (`periodicEnforcement`, lines 682-688, created inside `applyStealthMeasures` which runs once per window).
- Files: `src/managers/window.manager.js:929-994, 1552-1584, 1691-1698, 682-688`
- Cause: These are all legitimate individually (keeping the stealth overlay always-on-top and tracking multi-monitor moves), but together they add continuous timer wake-ups and Electron/OS API calls (`desktopCapturer.getSources`, `screen.getCursorScreenPoint`, `setAlwaysOnTop`) running indefinitely in the background.
- Improvement path: Before adding a CPU/GPU-hungry local model process, audit and coalesce these loops (e.g. one shared scheduler instead of 5+ independent intervals) so the local model gets predictable CPU/battery headroom, especially on laptops.

**Per-utterance Whisper subprocess spawn is the dominant latency cost for voice.**
- Problem: Each flushed VAD segment pays: temp WAV write → spawn Python → (cold) import `whisper`/torch → model forward pass → temp file cleanup, for every natural pause in speech (`src/services/speech.service.js:1740-1808`). The code already works around one manifestation of this (`_probeWhisperModuleFast`, lines 1340-1365, exists specifically because a full `import whisper` during *detection* took "well over 8s on a cold cache").
- Files: `src/services/speech.service.js:1666-1834`
- Cause: No persistent model process; every segment re-pays interpreter/model-load cost.
- Improvement path: See the [LOCAL-AI] tech-debt entry above — a persistent local STT server removes this cost entirely and is a prerequisite for low-latency continuous listening.

**Full-resolution screenshot capture and base64 inlining on every request.**
- Problem: `capture.service.js` always encodes the full display resolution to PNG (`finalImage.toPNG()`, line 47) and `llm.service.js` base64-encodes the entire buffer into the JSON request body (`imageBuffer.toString('base64')`, lines 142, 243). There is no resize/compression step.
- Files: `src/services/capture.service.js:30-65`, `src/services/llm.service.js:142-150, 243`
- Cause: Fine for an occasional on-demand screenshot; would be a real bottleneck (CPU for PNG encode + memory for base64 string + upload size) if repeated on an interval for "screen watching."
- Improvement path: Downscale to the minimum resolution the model needs before encoding, and consider JPEG for photographic content.

## Fragile Areas

**The audio capture path branches by platform in two different processes that must stay in sync. [LOCAL-AI]**
- Files: `src/services/speech.service.js:689` (main process: `this.useRendererCapture = process.platform === 'win32' || process.platform === 'darwin'`) vs. `src/ui/main-window.js:655-658` (renderer: sniffs `navigator.userAgentData.platform`/`navigator.platform` string and does its own `includes('win')`/`includes('mac')` check).
- Why fragile: These two independent platform checks, in two different processes/files, must always agree on which platform uses renderer-side `getUserMedia` capture vs. native `sox`/`arecord` capture. They already disagree in *mechanism* (one reads `process.platform`, a stable enum; the other parses a free-form user-agent string) even though they currently agree in *result*. A future Electron upgrade changing `navigator.platform`'s reported string, or a new platform branch added to one side and not the other, would silently break microphone capture on that platform with no error — the recording UI would show "recording" while no audio ever arrives.
- Safe modification: If either branch changes, change both, or better, replace both with a single IPC round-trip (`main.js` tells the renderer whether to use renderer capture, instead of the renderer re-deriving it).
- Test coverage: None (see Test Coverage Gaps) — this exact class of drift would not be caught automatically today.

**Renderer audio capture uses the deprecated `ScriptProcessorNode`.**
- Files: `src/ui/main-window.js:700` (`audioContext.createScriptProcessor(bufferSize, 1, 1)`)
- Why fragile: `ScriptProcessorNode` has been deprecated in the Web Audio spec in favor of `AudioWorkletNode` for years; it runs audio processing on the main thread (main-thread jank risk) and browser vendors have signaled eventual removal. Electron bundles Chromium, so this keeps working today, but is exactly the kind of API a future Electron major bump could break without much warning, and it's the code path this project would lean on harder for continuous listening.
- Safe modification: Migrating to an `AudioWorkletProcessor` now (before continuous-listening work builds more on top of this path) avoids compounding the migration cost later.

**Global `uncaughtException`/`unhandledRejection` handlers log-and-continue for the entire process. [LOCAL-AI]**
- Files: `main.js:82-92`
- Why fragile: This is a deliberate, documented tradeoff (the comment explains it exists so a missing `sox`/`arecord` binary doesn't crash the whole app), but its scope is global — *any* uncaught exception anywhere in the main process, including bugs in a future local-model-service manager, will be swallowed and logged rather than surfaced, potentially leaving services (speech, LLM, a new local-model manager) in a half-initialized state that's hard to diagnose from user reports.
- Safe modification: Narrow the protection to the specific known-risky call sites (child-process spawn of the audio recorder, which already has its own `child.on('error', ...)` guard at `speech.service.js:1608-1617`) rather than relying on a process-wide catch-all as the safety net for new subsystems.

**Session memory re-sends the full skill prompt as conversation "history" on every request.**
- Files: `src/managers/session.manager.js:20-57` (skill prompts pushed into `sessionMemory` as `role: 'system'` events at startup), `src/services/llm.service.js:602-665` (`buildGeminiRequestWithHistory` filters `event.role !== 'system'`, so this specific duplication is avoided for the *history* array) — but `getSkillContext()` (`session.manager.js:231-260`) still separately re-fetches the full skill prompt text as `systemInstruction` on *every single call*, and history entries themselves are included with no token-budget cap, only an entry-count cap (`.slice(-8)` / `getConversationHistory(15)`).
- Why fragile: There's no total-size guard — a handful of long code-heavy responses in history plus a full skill prompt as system instruction could approach context limits with no truncation logic. Local models generally have smaller context windows than Gemini's; this will surface sooner once local.
- Safe modification: Add a token/character budget check in `getOptimizedHistory()`/`getConversationHistory()`, not just an entry-count slice.

## Scaling Limits

**Continuous audio listening does not fit the current start/stop recording model. [LOCAL-AI]**
- Current capacity: Recording is explicitly started/stopped (mic button, `Alt+R` shortcut, or chat-window open/close) and each session spins up a recorder process/stream from scratch (`_startAzureRecording`/`_startWhisperRecording`, `speech.service.js:572-706`).
- Limit: An always-on "continuous listening" mode needs the recorder (and, per the earlier finding, the transcription backend) to run indefinitely with power-aware behavior (e.g. pause on system sleep, handle device unplug/replug), none of which exists today — the code assumes a bounded, user-initiated session.
- Scaling path: Introduce a distinct "ambient listening" mode in `SpeechService` that keeps the audio stream open continuously and only invokes transcription on VAD-detected utterances (the VAD logic in `_ingestWhisperAudio`, lines 800-890, is actually a decent foundation for this — it already segments by silence rather than a fixed timer).

**Continuous screen watching has no capture-loop, throttling, or dedup mechanism. [LOCAL-AI]**
- Current capacity: One capture per explicit user action (shortcut or IPC call); `CaptureService.isProcessing` (`capture.service.js:6, 31`) guards against overlapping *manual* captures but has no concept of a scheduled loop.
- Limit: Naively calling `captureAndProcess()` on an interval would duplicate the existing `screenCaptureAvailabilityWatcher` polling in `window.manager.js` (which already calls `desktopCapturer.getSources()` every 5s just to check *availability*), and would send full frames to the model with no change-detection, quickly overwhelming a local model's context/throughput.
- Scaling path: Build a single shared capture scheduler that both the availability watcher and the "screen watching" feature use, with frame hashing to skip near-duplicate frames.

**Unbounded session memory array with only count-based (not size-based) trimming.**
- Current capacity: `SessionManager` compresses events past 500 and prunes past 1000 (`config.js:94-98`, `session.manager.js:369-489`), which bounds *event count* but each event's `content` can be arbitrarily long (a full pasted question, a full LLM response, a full skill prompt).
- Limit: A single very large response (or a future md-file context injection that appends whole file contents as conversation events) is not size-limited before it lands in memory and gets serialized into every subsequent request's history.
- Scaling path: Cap individual event content length at insertion time, and make the roadmap's "md-file context injection" a separate, explicitly-budgeted context slot rather than more `sessionMemory` events.

## Dependencies at Risk

**`node-record-lpcm16` (mic capture on macOS/Linux native path).**
- Risk: Last published years ago (thin wrapper spawning `sox`/`arecord`/`rec` as child processes); no active maintenance, and it does not bundle those binaries — the app depends on the user having `sox` (macOS) or `arecord`/`sox` (Linux) already installed (`src/services/speech.service.js:1528-1576`, `setup.sh:170-208`, deb `recommends: [ffmpeg]` in `package.json`).
- Impact: If it stops working on a future Node/Electron ABI, there is no upstream to fix it, and the app already has to guard its missing-binary failure mode manually (`main.js:75-87` comment explains exactly this scenario).
- Migration plan: For the local-AI pivot, this is a good one to replace outright with whatever audio-capture path the local multimodal/audio model ships with, or with a maintained native-binding alternative — don't invest further in the sox/arecord spawn model.

**`microsoft-cognitiveservices-speech-sdk` (Azure Speech, cloud-only).**
- Risk: This is the app's other cloud dependency besides Gemini. `src/services/speech.service.js:1-380` even ships a large hand-written browser-DOM polyfill (`global.window`, fake `AudioContext`, fake `Blob`/`File`, etc.) purely so this SDK — built for browsers — can run inside a Node.js main process. That's substantial surface area kept alive to support one of two speech providers.
- Impact: Every polyfilled global is a latent compatibility risk with any other code that also expects browser globals in the main process.
- Migration plan: If the local-AI pivot drops cloud speech entirely, this dependency and its ~380-line polyfill block can be deleted outright — flag it as the first thing to remove once local STT is in place.

**Electron 29.4.6 is several major versions behind current.**
- Risk: Released ~March 2024; ships an outdated bundled Chromium/Node with any security fixes from newer Electron majors missing. `electron-builder` is pinned to `^24.13.3`, also aging.
- Files: `package.json:38-39` (`devDependencies`)
- Impact: `setContentProtection` behavior, GPU flags, and window-level APIs the app leans on heavily (`window.manager.js`) are exactly the kind of Chromium-internal behavior that shifts across major versions — upgrading later will likely require re-validating all the stealth/always-on-top code paths at once.
- Migration plan: Upgrade in a dedicated pass (not bundled with feature work), specifically re-testing `setContentProtection` on macOS/Windows and the Linux GPU-disable workaround (`main.js:53-62`) since both are version-sensitive.

**No auto-update mechanism despite `electron-builder` producing updater metadata.**
- Risk: The release workflow explicitly deletes `latest-*.yml` / `.blockmap` files before publishing (`.github/workflows/release.yml:230-234`, comment: "electron-updater channel metadata" is intentionally dropped), and there is no `autoUpdater` wiring in `main.js`. Users must manually notice and re-download new releases.
- Impact: Security fixes (including, eventually, Electron version bumps) won't reach existing installs without the user proactively checking GitHub.
- Migration plan: Not urgent, but worth deciding deliberately — either wire up `electron-updater` or explicitly document that updates are manual.

## Missing Critical Features

**No local model process lifecycle management. [LOCAL-AI]**
- Problem: As detailed under Tech Debt, nothing in the codebase starts, health-checks, restarts, or stops a long-running local service. This is the single largest gap relative to the "self-starting local model service à la Ollama" goal.
- Blocks: The entire local-AI pivot's core mechanic.

**No provider abstraction for LLM, so "multimodal local model" has nowhere to plug in cleanly. [LOCAL-AI]**
- Problem: See the `llm.service.js` findings above — the file is Gemini, not "an LLM service that currently uses Gemini."
- Blocks: Running local and cloud models side-by-side (even temporarily, for comparison/fallback during migration) without a substantial rewrite.

**No md-file context injection mechanism exists yet.**
- Problem: Context today comes from two sources only: the hard-coded `prompts/dsa.md` skill prompt (loaded once at startup via `prompt-loader.js`) and in-memory `sessionManager` conversation history. There is no file-watching, no user-facing "attach/inject a markdown file as context" UI or IPC handler, and no chunking/retrieval strategy for injecting larger documents.
- Blocks: The roadmap's md-file context injection feature needs this built from scratch; `prompt-loader.js`'s existing directory-scan-into-`Map` pattern is a reasonable starting skeleton (it already does "read `.md` files from a directory into memory") but currently only runs once at startup for exactly one hard-coded file.

**No persistent "you are being recorded/watched" indicator for continuous modes.**
- Problem: The only visible signal that the mic is active today is `micButton.classList.add('recording')` in the overlay (`src/ui/main-window.js`, tied to `handleRecordingStarted`/`Stopped`) and OS-level permission prompts. There's no equivalent concept yet for an always-on background listening/watching mode, where a persistent, hard-to-miss indicator matters more (both for user trust and because OS-level "app is using your microphone/camera" indicators — which the OS shows regardless of this app's own UI — would otherwise be the *only* signal during continuous capture).
- Blocks: Responsible UX for always-on audio/screen capture; also relevant to platform store policies if ever distributed through one.

## Test Coverage Gaps

**There is no automated test suite at all.**
- What's not tested: Everything. `package.json` has no `"test"` script, no Jest/Mocha/Vitest config exists anywhere in the repo, and the only test-shaped file is `scripts/test-speech.js`, a manual smoke-test invoked via `npm run test-speech` (spawns the resolved Whisper command against a synthetic tone and prints the result) — useful for a human running setup, not a CI gate.
- Files: `package.json` (no test script), `scripts/test-speech.js` (manual only)
- Risk: Every finding in this document — the VAD state machine (`speech.service.js:716-902`), the Gemini request-building/retry/fallback logic (`llm.service.js`), the `.env` read/write logic (`main.js`, `first-run.js`) — is entirely unverified by automation. A local-AI pivot will touch nearly every one of these files; regressions will only be caught manually.
- Priority: High — before large structural changes (provider abstraction, persistent local service) land, at minimum unit-test the pure-logic pieces that don't need Electron: VAD segmentation (`_ingestWhisperAudio`/`_chunkRmsEnergy`), `.env` parsing (`first-run.js:_readEnv`, `main.js:formatEnvValue`), and `prompt-loader.js`'s skill-name normalization.

**Whisper hallucination filter is an unverified hard-coded list.**
- What's not tested: `_isHallucinatedTranscript()` (`src/services/speech.service.js:1716-1738`) matches a fixed set of English phrases ("thank you for watching", "please subscribe", etc.). There's no test confirming it doesn't also swallow legitimate short utterances, and no mechanism to extend/verify the list per-language (it's applied regardless of `WHISPER_LANGUAGE`).
- Files: `src/services/speech.service.js:1710-1738`
- Risk: A legitimate one-or-two-word answer ("okay", "bye", "so") is silently dropped and never reaches the LLM, with no user-visible indication that it happened — could look like the mic silently failed.
- Priority: Medium.

**Whisper command resolution has many platform-specific branches, none exercised automatically.**
- What's not tested: `_resolveWhisperCommand`/`_probeWhisperCandidate`/`_expandConfiguredWhisperCandidates` (`src/services/speech.service.js:1289-1501`) encode a large matrix of Windows/macOS/Linux path and venv-detection logic (including specific past bug fixes referenced in comments, e.g. spaced Windows usernames, `shell:true` argument-splitting). None of this is covered by any test that runs on all three platforms.
- Files: `src/services/speech.service.js:1289-1501`, `src/core/whisper-installer.js:432-527`
- Risk: Regressions in this logic tend to manifest as "the mic button silently doesn't appear" for a subset of users on a specific OS/Python-install combination — exactly the class of bug hardest to catch without CI running on all three OSes.
- Priority: Medium.

---

*Concerns audit: 2026-07-13*
