# Phase 5: Continuous Capture, Notes & Hardening - Research

**Researched:** 2026-07-16
**Domain:** Electron 29 continuous screen capture + local md-context + renderer hardening (DOMPurify / macOS TCC / sender-scoped IPC)
**Confidence:** HIGH (codebase audit exhaustive; external APIs verified against Electron 29 docs + npm registry; TCC empirics MEDIUM — OS behavior varies by macOS version)

<user_constraints>
## User Constraints (from 05-CONTEXT.md)

**CRITICAL:** Locked decisions below are NON-NEGOTIABLE. Copied from 05-CONTEXT.md `<decisions>`.

### Locked Decisions

**Continuous capture (CONT-04):**
- Tick every 2s; dedup makes idle cost ≈ a hash
- Dedup: perceptual hash (dHash/aHash-style) on the downscaled frame; small threshold knob in config (exact algorithm + threshold = discretion)
- Pause conditions: screen lock + system sleep ONLY (`powerMonitor`, reuse the Phase 4 `wake-rewarm.js` listener pattern). NO battery throttle this phase
- Delivery: hold-latest. `latestFrame` + metadata (timestamp, hash, dimensions); Phase 6 pulls at pause time. Nothing pushed to the model per-capture
- Primary display only. No OCR — the frame is the model input (multimodal)
- Existing single-shot screenshot path keeps working unchanged

**Notes / md-context (CONT-05):**
- Folder selection: native picker (`dialog.showOpenDialog` directory mode) + editable text path in settings
- Reload: launch-only. NO `fs.watch`
- Budget: 12,000 chars, configurable (pre-validated by 03-07 smoke at ~12k)
- Over budget: whole files, alphabetical order, stop before the file that would bust the budget (no mid-file truncation); log + surface "N of M files loaded" in settings
- Wire into existing `RequestBuilder.mdContext` param → LocalProvider system prefix (no provider changes)

**Output sanitization (SEC-01):**
- Central sanitize helper — ONE shared module with the locked DOMPurify config; every sink calls `sanitize(html)` immediately before `innerHTML` assignment
- Links: allowed, http(s) only; `javascript:`/`data:` stripped; `rel="noopener noreferrer"` enforced; clicks route through the URL-validated `open-external` IPC (never in-window navigation)
- Images: stripped entirely (`<img>` = beacon/exfil channel)
- Patch ALL sinks — including dead `chat-window.js`
- Covers BOTH markdown paths in llm-response.html (marked@15 + bundled fallback parser) — sanitize the parsed HTML, not the markdown source

**TCC recovery (SEC-02):**
- Detection: `systemPreferences.getMediaAccessStatus('screen'|'microphone')` at startup + all-black-frame check (variance ≈ 0) in the capture loop + mic-stream failure signal, CROSS-CHECKED (black frames AND status ≠ granted ⇒ TCC loss)
- Guidance: inline banner in the main overlay (Phase 3/4 recovery idiom); screen loss ⇒ capture guidance, mic loss ⇒ voice guidance; degrade, never a blocking modal
- Re-grant: deep-link to the exact System Settings pane + one-click "Relaunch app"
- Re-check cadence: event-driven only (startup, capture-loop black-frame signal, app focus regain, `powerMonitor` resume) — no polling timer

**IPC scoping (SEC-03):**
- BOTH layers: (1) central channel→allowed-window-types allowlist enforced in main via `event.sender` (the load-bearing gate); (2) per-window-class preloads so overlay/chat never expose settings APIs
- Overlay/chat surface: minimal — `copy-to-clipboard` (write-only), `open-external` (http(s)-validated), their window-resize/expand channels, receive-only events. NO settings read/write
- Violation: deny + structured warn log (channel + window type). No throws, no silent nulls
- Breadth: FULL channel table — every `ipcMain` channel declares its audience; covers BOTH bridges (`electronAPI` + legacy `api`)

### Claude's Discretion
- Capture: downscale target (~1280px long edge anchor), PNG vs JPEG, exact hash algorithm/threshold/implementation (prefer pure JS on `nativeImage` bitmap), loop start timing, `isProcessing` interaction, `thumbnailSize`-at-target vs capture-full-then-resize
- Notes: recursive vs top-level walk, per-file cap, dotfile filtering, empty-folder UX copy, loader location + call sites
- Sanitize: helper location + distribution, exact tag/attr allowlist beyond the locked link/image policy, code-block/syntax-highlight survival, `escapeHtml`-only paths
- TCC: variance threshold + sample stride, banner copy, relaunch mechanics, first-launch priming
- IPC: preload split shape, table location/format, sender→type mapping, unused legacy channels (flag for Phase 8, don't delete)
- Test approach per pillar

### Deferred Ideas (OUT OF SCOPE — do not plan)
- Pause orchestrator / relevance gate / per-pause consumption of `latestFrame` — Phase 6
- Trust indicator + kill switch — Phase 6 (CONT-06/07)
- Thermal/battery back-off — Phase 6 SC5
- Sustained-load TTFT/memory validation — Phase 6
- mic+system fusion, diarization — Phase 6 / v2
- `fs.watch` live notes reload — later
- Follow-cursor / multi-display capture — later
- Read-only prefs subset for overlay — only if Phase 6 needs it
- CSP headers — Phase 8 note
- Deleting dead files (`chat-window.js`, `fallback-capture.service.js`, unused legacy channels) — Phase 8 (flag, don't delete)
- Windows/Linux capture/permission equivalents — v2; TCC work is macOS-only
</user_constraints>

<research_summary>
## Summary

Researched the six flags from 05-CONTEXT.md by exhaustive codebase audit (every `ipcMain` channel, every `innerHTML` sink, every renderer's actual bridge usage, the `RequestBuilder`/`LocalProvider` seam) plus verification of external APIs (Electron 29 `desktopCapturer`/`nativeImage`/`systemPreferences`/`powerMonitor`, DOMPurify 3.4.x distribution on npm).

Everything needed is already in the platform: `desktopCapturer.getSources` with a computed `thumbnailSize` captures directly at the downscaled target (no full-res copy + resize needed — and the codebase already runs a 1×1-thumbnail probe every 5s, proving repeated calls are safe); a 17×16 dHash in pure JS over `nativeImage.toBitmap()` costs microseconds (no sharp/jimp); DOMPurify 3.4.12 ships a CJS main AND a UMD browser build loadable via the existing `<script src="./node_modules/...">` pattern (prismjs precedent in chat.html); `systemPreferences.getMediaAccessStatus` reports TCC without prompting; and `WindowManager.createWindow(type)` is a single seam for both the WebContents-id→type registry and the per-class preload split.

**Two findings that CORRECT assumptions in CONTEXT.md:**
1. **mdContext call sites are in `src/services/providers/local.provider.js` (lines 259, 287, 313) — NOT main.js.** `serialize()` already joins `systemPrompt + mdContext` (03-03 pre-wiring); only the three `build*Request(...)` calls need the 5th arg.
2. **The `open-external` handler validates http(s)-only (main.js:846)** — the TCC deep links are `x-apple.systempreferences:` URLs and MUST NOT go through it. SEC-02 needs a dedicated `open-privacy-settings` IPC taking an enum (`'screen'|'microphone'`), mapping to the exact URL in the MAIN process. Never loosen `open-external`.

**Primary recommendation:** Extend `capture.service.js` with a self-contained loop (capture-at-target via `thumbnailSize`, dHash dedup, JPEG-80 held frame); new pure-CJS core modules `frame-dedup.js`, `context.manager.js`, `sanitize-policy.js`, `ipc-scope.js` (all `node:test`-able); one `guardedHandle/guardedOn` wrapper in main.js over the full channel table; two preload classes (`preload.js` privileged, `preload-overlay.js` minimal).
</research_summary>

<codebase_audit>
## Codebase Audit (grounded — line-verified 2026-07-16)

### Capture seam (CONT-04)
- `src/services/capture.service.js` (122L, singleton): single-shot `captureAndProcess()` → `captureScreenshot()` → `desktopCapturer.getSources({types:['screen'], thumbnailSize: display.size})` at FULL resolution, `image.toPNG()`, `isProcessing` guard. Display matched by size-equality heuristic (`:82-86`) — breaks under downscale; use `source.display_id === String(display.id)` instead (macOS supplies it), fallback `sources[0]`.
- `src/managers/window.manager.js:939-961` — existing 1×1 `getSources` probe every 5s (`checkScreenCaptureAvailability`) = precedent that repeated `getSources` is safe. NOTE: this probe ALREADY runs constantly; the 2s loop adds a second caller.
- No interval/downscale/dedup code anywhere. No sharp/jimp; image ops = Electron `nativeImage`.
- powerMonitor pattern to copy: `main.js` `_registerWakeRewarm` (armed early in `onAppReady`), pure logic in `src/core/wake-rewarm.js` (DI, node-testable). Capture pause/resume should mirror: `powerMonitor.on('lock-screen'/'unlock-screen'/'suspend'/'resume')` in main.js, pure tick/dedup logic in core.

### innerHTML sink inventory (SEC-01) — complete
| File | Lines | Dynamic content? | Treatment |
|---|---|---|---|
| `llm-response.html` | 837 (`textHtml`), 842 (clear — static `''`), 845 (static no-code msg), 850 (template w/ `block.language` + escaped code), 882 (`html` full markdown) | 837/850/882 = model output | sanitize 837, 850, 882 |
| `llm-response.html` | 908 = escape-READ (`div.innerHTML` getter) | n/a | leave |
| `chat.html` | 800 (clear `''`), 869 (`formatMarkdown(text)` = model), 920 (static dots), 1051 (escape-read), 1101 (`escapeHtml(code)`) | 869 = model; 1101 escaped-but-wrap | sanitize 869, 1101 |
| `src/ui/chat-window.js` (DEAD, patch anyway) | 364 (`formatMarkdown` = model), 481 (template w/ vars), 494 (escape-read), 553 (static dots) | 364/481 | sanitize 364, 481 |
| `src/ui/main-window.js` | 703 (static panel; 03-06 recovery UI — contains only controlled strings from `getStatus`), 749/778 (static spinner strings), 1240 (`${arrow} ${displayName}`), 1448 (`${iconClass}${text}`) | 1240/1448 carry variables (controlled) | sanitize 703, 1240, 1448 (cheap; requirement says every dynamic sink) |
| `src/ui/settings-window.js` | 186 (clear `''`), 444 (icon grid from static table) | controlled | audit-only; sanitize 444 if it interpolates |

Markdown paths in llm-response.html: `marked` when defined (`:504-516`, `:606-607`) ELSE bundled `lib/markdown.js` (markdown@0.5.0, in deps). Both converge at the `innerHTML` assignments — sanitize at assignment covers both. Prism (`chat.html:716-717` loads from `./node_modules/prismjs/...`) runs `highlightAll()` AFTER assignment on the live DOM → unaffected by sanitize.

### IPC surface (SEC-03) — complete channel → audience table (from actual renderer usage)

Window types: `main`, `chat`, `llmResponse`, `settings`, `onboarding` (`window.manager.js:266+`). ONE shared `preload.js` today (`config.js:31`), spread into every window's webPreferences (`window.manager.js:277`). Zero sender validation on any handler.

**Actual per-renderer usage (audited, exact):**
- `llm-response.html`: electronAPI `copyToClipboard`, `closeWindow`, `resizeLlmWindowForContent`, `onDisplayLlmResponse`, `onShowLoading` (+ `expandLlmWindow` exists in preload for it); legacy `api.send('quit-app')` (`:1029`). SEC-01 adds `openExternal` (sanitized-link clicks).
- `chat.html`: electronAPI `sendChatMessage`, `startSpeechRecognition`, `stopSpeechRecognition`, `getSpeechAvailability`, `copyToClipboard` + receive-only (`onInterimTranscription`, `onLlmResponse`, `onRecordingStarted/Stopped`, `onSessionCleared`, `onSpeechAvailability/Error/Status`, `onTranscriptionLlmResponse`, `onTranscriptionReceived`). Sends `chat-window-ready`. SEC-01 adds `openExternal`.
- `index.html` (main): full control surface — screenshot/capture, speech start/stop/reattach, `sendAudioChunk` (mic lives here), window move/resize/stats, `getSettings`, `saveSettings`, `getModelStatus`, `recoverModel`, `updateActiveSkill`, `showSettings`, `takeScreenshot`, `quit`, receive-everything; legacy `api.receive('interaction-mode-changed'|'skill-updated'|'update-skill')`.
- `settings.html`: `getSettings`, `saveSettings`, `getWhisperStatus`, `downloadWhisperModel`, `recoverWhisper`, `getModelStatus`, `pullModel`, `listInstalledModels`, `testProviderConnection`, `onInstallProgress`, `onModelPullProgress`, `onCodingLanguageChanged`, `quit`; legacy `api.send('save-settings'|'update-skill'|'close-settings'|'quit-app')`, `api.receive('load-settings')`.
- `onboarding.js`: `closeOnboarding`, `completeFirstRun`, `downloadWhisperModel`, `getWhisperStatus`, `getModelStatus`, `modelPreflight`, `pullModel`, `openExternal`, `saveSettings`, `onInstallProgress`, `onModelPullProgress`, `removeAllListeners` (+ `getFirstRunStatus`).

**Full ipcMain registration list (main.js):** `take-screenshot`:537, `list-displays`:538, `capture-area`:539, `copy-to-clipboard`:542, `get-speech-availability`:553, `start-speech-recognition`:557 (+on:597), `stop-speech-recognition`:565 (+on:602), `speech-reattach-channel`:577, `audio-chunk`(on):590, `chat-window-ready`(on):607, `main-window-ready`(on):616, `test-chat-window`(on):630, `show-all-windows`:636, `hide-all-windows`:641, `enable-window-interaction`:646, `disable-window-interaction`:651, `switch-to-chat`:656, `switch-to-skills`:661, `resize-window`:666, `move-window`:685, `get-session-history`:702, `clear-session-memory`:706, `force-always-on-top`:712, `test-always-on-top`:717, `send-chat-message`:722, `get-skill-prompt`:746, `set-window-binding`:758, `toggle-window-binding`:762, `get-window-binding-status`:766, `get-window-stats`:770, `set-window-gap`:774, `move-bound-windows`:778, `show-settings`:784, `get-settings`:799, `get-first-run-status`:805, `complete-first-run`:814, `open-external`:846, `close-onboarding`:861, `download-whisper-model`:874, `get-whisper-status`:904, `whisper-recover`:915, `download-model`:952, `get-model-status`:969, `list-installed-models`:979, `model-preflight`:987, `recover-model`:999, `test-provider-connection`:1023, `save-settings`:1031 (+on:1109), `update-app-icon`:1035, `update-active-skill`:1039, `restart-app-for-stealth`:1045, `close-window`:1052, `expand-llm-window`:1064, `resize-llm-window-for-content`:1069, `quit-app`:1075 (+on:1120), `close-settings`(on):1101, `update-skill`(on):1114.
(Preload also references `hide-settings`, `get-llm-session-history`, `format-session-history`, `toggle-recording`, `toggle-interaction-mode`, `window-loaded` — some have NO main-side registration = unused legacy; FLAG for Phase 8, don't delete.)

- `getSettings()` (main.js:1918-1945) returns NO keys (cloud creds removed P3/4) — SEC-03 is defense-in-depth + Phase 6 future-proofing.
- `open-external` (main.js:846): validates `typeof url === 'string' && /^https?:\/\//i.test(url)` — keep as-is.
- Outbound `webContents.send` (main → renderer) is NOT gated — main chooses the target; only inbound `ipcMain` gets the allowlist.

### md-context seam (CONT-05)
- `RequestBuilder` `build{Text,Image,Transcription}Request` each accept `mdContext = ''` as the LAST param (`request-builder.js:80,142,161`) and place it in the neutral struct.
- `LocalProvider.serialize()` (`local.provider.js:95`) already joins `[systemPrompt, mdContext].filter(Boolean).join('\n\n')` into the single system message (position-stable prefix; `/no_think` appended after).
- **The only wiring points are the three `build*Request` calls in `local.provider.js:259, 287, 313`** (`processImageWithSkillStream`, `processTextWithSkillStream`, `processTranscriptionWithIntelligentResponseStream`). main.js never calls RequestBuilder directly.
- Settings persistence pattern: `saveSettings` → `envUpdates.X = ...` → `persistEnvUpdates` → `upsertEnvContent` → `.env`; config.js reads `process.env.X` at load → restart-to-apply (exactly matches launch-only reload).
- 12k budget pre-validated: 03-07 smoke ran ~12k chars of filler mdContext through the real prefill path — cite, don't re-run.

### TCC (SEC-02) — greenfield
- Zero `systemPreferences`/permission code today. Recovery idiom to mirror: `main-window.js:703` `showLocalUnavailable(status)` inline dismissible panel + one-click action (03-06), voice-unavailable retry (04-07).
- `wake-rewarm.js` = the powerMonitor + event-driven re-check pattern (re-entrancy-guarded, armed early in onAppReady).
- Mic-loss signal already exists: speech path emits `speech-error` / availability events on stream failure.
</codebase_audit>

<standard_stack>
## Standard Stack

### Core (only ONE new dependency)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| dompurify | ^3.4.12 | HTML sanitization at every model-output sink | THE reference sanitizer; `main: ./dist/purify.cjs.js` (CJS — `require()`-safe ✓ ESM ban respected), `browser: ./dist/purify.js` (UMD — script-tag safe for plain-HTML renderers) |

Everything else is platform (Electron 29.4.6, already shipped): `desktopCapturer`, `nativeImage` (`.resize`, `.toBitmap`, `.toJPEG`), `screen`, `powerMonitor` (`lock-screen`/`unlock-screen`/`suspend`/`resume`), `systemPreferences.getMediaAccessStatus`, `dialog.showOpenDialog`, `app.relaunch()`, Node `fs/promises` + `path`.

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| dompurify UMD via `<script src="./node_modules/dompurify/dist/purify.js">` | Vendored copy in `lib/` | node_modules path matches the existing prismjs precedent (chat.html:716) and tracks the dep version; vendoring drifts. Use node_modules. |
| Pure-JS dHash on `nativeImage` | sharp/jimp | Native dep for a 17×16 hash is absurd; toBitmap+loop is microseconds. Locked-adjacent (CONTEXT prefers pure JS). |
| Snapshot `getSources` each tick | WebRTC `getDisplayMedia` stream | A live stream pegs the capture indicator permanently and costs constant CPU; 0.5Hz snapshots are the right model for hold-latest. |
| jsdom devDep for DOMPurify unit tests | Pure policy-module tests + attended XSS check | jsdom is a huge tree for one test; policy pure-functions (href validation, anchor hook) are node-testable with fake nodes; full DOMPurify behavior verified at the human checkpoint. |

**Installation:**
```bash
npm install dompurify --ignore-scripts   # then verify: node -e "console.log(typeof require('dompurify'))" → 'function'
```
</standard_stack>

<architecture_patterns>
## Architecture Patterns

### Recommended Structure (new/changed files)
```
src/core/frame-dedup.js        # PURE: dHash + hamming + black-frame variance (node:test)
src/core/context.manager.js    # notes loader: load()/getContext()/getStatus(); pure budget helper exported (node:test)
src/core/sanitize-policy.js    # PURE CJS: DOMPurify config + anchor-policy hook fn (node:test w/ fake nodes)
src/core/ipc-scope.js          # PURE CJS: CHANNEL_AUDIENCES table + isChannelAllowed() (node:test)
src/ui/sanitize.js             # browser glue: window.sanitizeHtml(html) = DOMPurify + policy (dual-load guard)
src/services/capture.service.js  # + startContinuousCapture()/stopContinuousCapture()/getLatestFrame()/pause()/resume()
src/services/tcc-monitor.js      # (or src/core/) status checks + cross-check logic; banner IPC to main window
preload.js                     # stays = privileged class (main, settings, onboarding)
preload-overlay.js             # NEW minimal class (llmResponse, chat)
main.js                        # guardedHandle/guardedOn wrappers, contextManager.load(), capture loop start, TCC checks, new IPC: select-notes-folder, open-privacy-settings, relaunch-app
src/managers/window.manager.js # WebContents-id→type registry + per-type preload in createWindow
src/core/config.js             # capture.{intervalMs,longEdgePx,dedupThreshold,jpegQuality} + notes.{folder,budgetChars}
```

### Pattern 1: Capture-at-target via thumbnailSize (Flag 1 — RESOLVED)
**What:** `getSources` scales the capture to fit `thumbnailSize` (aspect preserved) inside Chromium — requesting the downscaled size directly IS the downscale-before-encode step. Don't capture full-res then resize.
**Verified:** codebase precedent `window.manager.js:939+` (1×1 probe, 5s interval, runs today without issue).
```js
// tick (every 2s, skip if this._loopBusy or capture paused or isProcessing single-shot)
const display = screen.getPrimaryDisplay();
const { width: dw, height: dh } = display.size;
const scale = Math.min(1, LONG_EDGE / Math.max(dw, dh));      // LONG_EDGE default 1280
const thumbnailSize = { width: Math.round(dw * scale), height: Math.round(dh * scale) };
const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
const source = sources.find(s => s.display_id === String(display.id)) || sources[0]; // display_id, NOT size heuristic
const image = source.thumbnail;                                // already at target res
```
**Cost:** one scaled capture ≈ tens of ms, async, at 0.5 Hz — negligible. Guard re-entrancy with a `_loopBusy` flag (a slow tick must never overlap the next).
**Honesty note (indicator):** macOS 15+ shows a menu-bar screen-capture indicator while capture is active and (15.1+) periodically re-confirms screen-recording apps. Repeated snapshots may flicker it. Unavoidable OS behavior; do not attempt to defeat it.

### Pattern 2: dHash + black-frame variance in pure JS (Flag 2 — RESOLVED)
**What:** difference-hash on a tiny grayscale resize of the ALREADY-downscaled frame; hamming distance vs previous ⇒ skip/encode. Same tiny buffer feeds the black-frame check for free.
**Recommended params (discretion):** 17×16 grid → 256-bit hash; default threshold 10 bits (config `capture.dedupThreshold`); cell ≈ 75×67 source px at 1280 — cursor blink flips ≤1 bit, a new message/notification flips many.
```js
// src/core/frame-dedup.js — PURE (input: BGRA Buffer + dims from nativeImage)
function grayscale(bitmap /* BGRA */, w, h) { /* luma = .299R+.587G+.114B; note BGRA order: b=i*4, g=+1, r=+2 */ }
function dhash(tiny /* (hw+1)×hh luma */, hw = 16, hh = 16) { /* bit = luma[x] > luma[x+1], row-major, → Buffer(32B) */ }
function hamming(a, b) { /* popcount over 32 bytes */ }
function blackStats(luma) { /* {mean, variance} */ }          // black frame: mean < 4 && variance < 2 (0..255 scale)
// capture.service: const tiny = image.resize({ width: 17, height: 16 }); tiny.toBitmap() → dedup module
```
**Verify at runtime:** `toBitmap().length === width*height*4` (BGRA on macOS). No native dep at this rate — confirmed unnecessary.

### Pattern 3: Hold-latest frame + JPEG-80 (discretion resolved)
```js
this.latestFrame = {
  buffer: image.toJPEG(80),          // JPEG for a vision-model input: ~5-10× smaller base64 than PNG; text stays legible at q80/1280px
  mimeType: 'image/jpeg',
  timestamp: Date.now(), hash, dimensions: image.getSize()
};
getLatestFrame() { return this.latestFrame; }                 // Phase 6 pulls; null until first capture
```
Loop start timing (discretion): mirror ambient listening — start from `onAppReady` only when first-run is complete; re-invoke on `complete-first-run`. Pause on `lock-screen`+`suspend`, resume on `unlock-screen`+`resume` (registered in main.js beside `_registerWakeRewarm`).

### Pattern 4: Notes loader with whole-file budget (CONT-05)
```js
// src/core/context.manager.js — pure budget helper exported for tests
function selectFilesWithinBudget(files /* [{name, chars}] alpha-sorted */, budget) {
  const loaded = []; let total = 0;
  for (const f of files) { if (total + f.chars > budget) break; loaded.push(f.name); total += f.chars; }
  return { loaded, total };                                    // stop-before-bust: whole files, stable alpha order
}
// load(): fs.readdir(folder) → *.md only, skip dotfiles, TOP-LEVEL only (discretion: simplest deterministic set)
// sort by simple codepoint compare (a<b) for locale-independent stability
// join: files.map(f => `# ${f.name}\n\n${f.content}`).join('\n\n---\n\n')
// status: { folder, loadedCount, totalCount, chars, budget } → settings "N of M files loaded"
// missing/empty folder: info-log + empty context; NEVER throws (degrade-never-crash)
```
Wiring (Flag 6 — RESOLVED): `local.provider.js` requires the singleton and passes `contextManager.getContext()` as the 5th/6th arg at its THREE call sites (`:259` buildImageRequest takes it as 5th param after programmingLanguage; `:287`/`:313` as 5th). `main.js onAppReady` calls `await contextManager.load()` in an isolated try/catch (non-blocking pattern like other managers). Config: `notes: { folder: process.env.NOTES_FOLDER || '', budgetChars: parseInt(process.env.NOTES_BUDGET_CHARS, 10) || 12000 }`. Settings: `getSettings()` adds `notesFolder` + `notesStatus`; `saveSettings` persists `NOTES_FOLDER`; new `select-notes-folder` IPC (settings audience) → `dialog.showOpenDialog({ properties: ['openDirectory'] })`.

### Pattern 5: Central sanitize policy + per-renderer glue (SEC-01, Flag 4 — RESOLVED)
```js
// src/core/sanitize-policy.js — PURE CJS (node:test with fake anchor objects)
const SANITIZE_CONFIG = {
  USE_PROFILES: { html: true },                                // kills svg/mathml namespace tricks
  FORBID_TAGS: ['img','picture','source','video','audio','iframe','object','embed','form','input','button','style'],
  FORBID_ATTR: ['style'],                                      // model output never needs inline style
  ALLOWED_URI_REGEXP: /^https?:/i                              // http(s)-only hrefs; javascript:/data: die here
};
function applyAnchorPolicy(node) {                             // afterSanitizeAttributes hook body — pure, testable
  if (node.tagName === 'A') {
    node.setAttribute('rel', 'noopener noreferrer');
    node.setAttribute('target', '_blank');
    const href = node.getAttribute('href') || '';
    if (href && !/^https?:\/\//i.test(href)) node.removeAttribute('href');
  }
}
// src/ui/sanitize.js — browser glue, dual-load guard (chat-window.js precedent; eslint renderer block allows require)
// requires DOMPurify global (script tag) → window.sanitizeHtml = (html) => { add hook once; return DOMPurify.sanitize(String(html ?? ''), SANITIZE_CONFIG); }
```
Distribution: add BEFORE the UI script in each renderer HTML: `<script src="./node_modules/dompurify/dist/purify.js"></script>` then `<script src="./src/ui/sanitize.js"></script>` (llm-response.html, chat.html, index.html, settings.html; chat-window.js's host page too if any — it's dead code loaded by chat.html? patch the file's sinks regardless). `class` attr survives by default → Prism classes fine; `Prism.highlightAll()` runs post-assignment on the live DOM → highlighting unaffected. `escapeHtml` composite sinks: sanitize the FINAL composed string. Link clicks: delegated click handler in llm-response/chat → `preventDefault()` + `electronAPI.openExternal(href)` (window-level `will-navigate`/`setWindowOpenHandler` at `window.manager.js:455-465` already externalizes as belt-and-suspenders).

### Pattern 6: TCC detection + recovery (SEC-02, Flag 3 — RESOLVED, MEDIUM confidence on OS empirics)
```js
// checks (event-driven only): startup, capture-loop black-frame signal, app 'browser-window-focus', powerMonitor 'resume'
const { systemPreferences } = require('electron');
systemPreferences.getMediaAccessStatus('screen');      // 'granted'|'denied'|'restricted'|'not-determined'|'unknown' — NEVER prompts; no askForMediaAccess for screen
systemPreferences.getMediaAccessStatus('microphone');  // mic CAN prompt via askForMediaAccess('microphone') — do NOT auto-prompt; banner-driven
```
- **Cross-check (locked):** N consecutive black frames (recommend 3) AND `getMediaAccessStatus('screen') !== 'granted'` ⇒ screen TCC loss → banner. Black frames WITH `'granted'` → warn-log only (genuinely black screen / the post-update stale-grant edge; log makes it greppable).
- Mic loss: `getMediaAccessStatus('microphone') !== 'granted'` cross-checked with the existing speech-path failure signal → voice banner.
- **Deep links (Ventura+ System Settings, compat shims verified still honored):** screen `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`, mic `...?Privacy_Microphone`. **MUST bypass `open-external`** (it's http(s)-only): new `open-privacy-settings` IPC (main-window audience) takes `'screen'|'microphone'`, main maps enum→URL → `shell.openExternal(url)`. Renderer never passes a URL.
- Relaunch (Screen Recording grants only apply to a NEW process — strictly requires relaunch): new `relaunch-app` IPC → `app.relaunch(); app.exit(0)`.
- Banner: reuse the `showLocalUnavailable` inline-panel idiom in `main-window.js` (dismissible, action buttons "Open System Settings" + "Relaunch app"); main → renderer via `broadcastToAllWindows('permission-status', {...})` receive-only event.

### Pattern 7: Sender-scoped IPC gate + preload split (SEC-03, Flag 5 — RESOLVED)
```js
// src/managers/window.manager.js — registry (authoritative; URL matching is brittle)
this.webContentsTypes = new Map();                             // wcId → type
// in createWindow(type): after new BrowserWindow:
this.webContentsTypes.set(window.webContents.id, type);
window.webContents.on('destroyed', () => this.webContentsTypes.delete(wcId));
getWindowTypeByWebContentsId(id) { return this.webContentsTypes.get(id) || null; }

// src/core/ipc-scope.js — PURE: the FULL table (every channel from the audit above) + helper
const CHANNEL_AUDIENCES = { 'get-settings': ['main','settings','onboarding'], 'copy-to-clipboard': ['main','chat','llmResponse','settings'], /* … every channel … */ };
function isChannelAllowed(channel, windowType) { const a = CHANNEL_AUDIENCES[channel]; return !!a && !!windowType && a.includes(windowType); }
// unknown channel OR unknown sender type ⇒ DENY (default-deny)

// main.js — wrappers (deny + structured warn, degrade-never-crash)
guardedHandle(channel, fn) → ipcMain.handle(channel, (event, ...a) => {
  const t = windowManager.getWindowTypeByWebContentsId(event.sender.id);
  if (!isChannelAllowed(channel, t)) { logger.warn('IPC denied', { channel, windowType: t }); return { ok: false, error: 'denied' }; }
  return fn(event, ...a);
});   // guardedOn same shape, silently drops after warn-log
```
Mechanical change: replace all ~60 `ipcMain.handle(`/`ipcMain.on(` registrations with the guarded pair. Preload split (per-window-class): `createWindow` overrides `webPreferences.preload` by type — `['llmResponse','chat'].includes(type) ? preload-overlay.js : preload.js` (config.js:31 default stays as fallback). `preload-overlay.js` surface (union of overlay+chat actual usage, NOTHING privileged): `copyToClipboard`, `openExternal`, `sendChatMessage`, `startSpeechRecognition`, `stopSpeechRecognition`, `getSpeechAvailability`, `expandLlmWindow`, `resizeLlmWindowForContent`, `closeWindow`, `notifyChatWindowReady`, the receive-only event list, `removeAllListeners`; legacy `api` reduced to `send: ['quit-app','window-loaded']` + existing receive list. NO getSettings/saveSettings/model/whisper APIs. The main gate is the TABLE (a compromised overlay ignoring its preload still hits the main-process allowlist).

### Anti-Patterns to Avoid
- **Size-equality display matching under downscale** (`capture.service.js:82-86` heuristic breaks when thumbnails are scaled) → use `source.display_id`.
- **Loosening `open-external` for x-apple URLs** → dedicated enum-based `open-privacy-settings`.
- **Sanitizing the markdown SOURCE** → sanitize the parsed HTML at each assignment (covers marked + fallback uniformly).
- **`fs.watch` on the notes folder** → locked out; launch-only.
- **Polling timer for TCC** → locked out; event-driven only.
- **Gating outbound `webContents.send`** → pointless; main picks targets. Gate inbound only.
- **Ambient `fetch` for anything loopback** → standing Phase-3 rule (not needed this phase; no new network code).
</architecture_patterns>

<dont_hand_roll>
## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| HTML sanitization | Regex/allowlist string filter | DOMPurify 3.4.12 | mXSS, namespace confusion, entity tricks — decades of bypasses; DOMPurify is the audited reference |
| Downscale | Manual pixel loops / sharp | `thumbnailSize` at capture + `nativeImage.resize` | Chromium-native, GPU-adjacent, zero deps |
| JPEG encode | Any JS encoder | `nativeImage.toJPEG(q)` | Built-in |
| Directory picker | Custom path validation UI | `dialog.showOpenDialog({properties:['openDirectory']})` | Native, sandbox-correct |
| Permission status | Parsing TCC.db / spawning tccutil | `systemPreferences.getMediaAccessStatus` | Supported API; TCC.db is SIP-protected |
| Relaunch | Shell respawn scripts | `app.relaunch() + app.exit(0)` | Built-in, args-preserving |
| Popcount/hamming | Bit tricks perf-tuning | Simple byte loop over 32 bytes | 0.5 Hz — readability wins |

**Key insight:** the only genuinely new algorithmic code this phase is ~60 lines of pure JS (dHash + variance + budget + allowlist) — everything else is wiring platform APIs through the app's established DI/degrade patterns. Keep the pure parts pure so `node:test` covers them.
</dont_hand_roll>

<common_pitfalls>
## Common Pitfalls

### Pitfall 1: `event.sender.id` vs registry lifetime
**What goes wrong:** gate resolves `null` window type after a window is recreated (settings closes/reopens) → legit calls denied.
**Why:** registry entry deleted on 'destroyed' but new window registered under a new wcId — fine — UNLESS registration happens after `loadFile` races an early IPC.
**How to avoid:** register the wcId → type mapping immediately after `new BrowserWindow(...)`, BEFORE `loadFile`. Default-deny means a miss is a warn-log + denial, never a crash.
**Warning signs:** 'IPC denied' logs for `main`/`settings` audiences during normal use.

### Pitfall 2: Sanitize breaking code blocks / KaTeX
**What goes wrong:** answers lose syntax highlighting or math after sanitize.
**Why:** over-aggressive FORBID lists (e.g. forbidding `span`, `class`) or sanitizing after Prism mutates the DOM.
**How to avoid:** default profile keeps `pre/code/span/class`; sanitize THEN assign THEN `Prism.highlightAll()`/`renderMathInElement` on the live DOM. Attended check: code-fenced answer + a hostile `<img onerror>` answer.
**Warning signs:** plain unstyled code blocks; console errors from Prism.

### Pitfall 3: The 2s loop colliding with single-shot capture
**What goes wrong:** user-triggered screenshot fails with 'Capture already in progress' or the loop steals its tick.
**Why:** shared `isProcessing` guard.
**How to avoid:** loop uses its OWN `_loopBusy` re-entrancy flag and SKIPS its tick when `isProcessing` is true (locked-adjacent: single-shot path unchanged, loop yields).
**Warning signs:** screenshot hotkey intermittently erroring after the loop lands.

### Pitfall 4: TCC status lies right after an update (stale 'granted' + black frames)
**What goes wrong:** post-update signature change → frames all-black while status may briefly read 'granted' (or vice versa).
**Why:** TCC re-evaluates the binary; enforcement is process-start-scoped for screen capture.
**How to avoid:** honor the LOCKED cross-check (banner only when black-frames AND status ≠ granted); warn-log the disagreeing state so it's greppable. Relaunch is mandatory after re-grant — that's why the banner has the one-click relaunch.
**Warning signs:** `latestFrame` hash constant + black-stats mean≈0 for many ticks.

### Pitfall 5: Overlay preload split silently breaking chat
**What goes wrong:** chat window loses speech toggles / send after the split.
**Why:** "overlay = clipboard only" reading of the scout note — chat ACTUALLY uses `sendChatMessage` + speech start/stop/availability (audited).
**How to avoid:** overlay-class preload carries the audited union (still zero privileged APIs); the channel TABLE distinguishes llmResponse vs chat precisely.
**Warning signs:** `undefined is not a function` in chat console; denied-log lines for chat.

### Pitfall 6: dedup threshold too coarse/fine
**What goes wrong:** too fine → cursor blink re-encodes every tick (wasted CPU); too coarse → real content changes skipped (Phase 6 pulls a stale frame).
**How to avoid:** 256-bit hash + threshold 10 default, `capture.dedupThreshold` knob; staleness is bounded anyway — a "skip" keeps the previous (identical-looking) frame, so correctness risk is low; cost is the failure mode, dedup is the biggest battery lever (PITFALLS 9).
**Warning signs:** log per-tick encode rate ≈ 100% on an idle screen, or ≈ 0% during active use.

### Pitfall 7: ESM-only dep slip
**What goes wrong:** `require('dompurify')` throws ERR_REQUIRE_ESM.
**How to avoid:** dompurify@3.4.12 `main` is `./dist/purify.cjs.js` (verified on npm) — CJS-safe. Verify at install: `node -e "require('dompurify')"`. Renderers use the UMD `dist/purify.js` via script tag (renderers have no `require`).
</common_pitfalls>

<code_examples>
## Code Examples

### Capture loop skeleton (extends capture.service.js — single-shot path untouched)
```js
startContinuousCapture() {
  if (this._captureTimer) return;
  this._paused = false;
  this._captureTimer = setInterval(() => this._tick().catch(e =>
    logger.warn('Continuous capture tick failed', { error: e.message })), config.get('capture.intervalMs') || 2000);
  logger.info('Continuous capture started');
}
async _tick() {
  if (this._paused || this._loopBusy || this.isProcessing) return;   // yield to single-shot
  this._loopBusy = true;
  try {
    const image = await this._captureDownscaled();                   // Pattern 1
    const tiny = image.resize({ width: 17, height: 16 });
    const luma = grayscale(tiny.toBitmap(), 17, 16);
    const { mean, variance } = blackStats(luma);
    this._noteBlackFrame(mean < 4 && variance < 2);                  // → tcc cross-check counter
    const hash = dhash(luma, 16, 16);
    if (this._lastHash && hamming(hash, this._lastHash) <= (config.get('capture.dedupThreshold') ?? 10)) return; // idle: no encode
    this._lastHash = hash;
    this.latestFrame = { buffer: image.toJPEG(config.get('capture.jpegQuality') ?? 80),
      mimeType: 'image/jpeg', timestamp: Date.now(), hash: hash.toString('hex'), dimensions: image.getSize() };
  } finally { this._loopBusy = false; }
}
pauseContinuousCapture() { this._paused = true; }    // lock-screen / suspend
resumeContinuousCapture() { this._paused = false; }  // unlock-screen / resume
```

### mdContext wiring (local.provider.js — the complete diff surface)
```js
const contextManager = require('../../core/context.manager');       // top of file
// :259  buildImageRequest(imageBuffer, mimeType, activeSkill, programmingLanguage, contextManager.getContext())
// :287  buildTextRequest(text, activeSkill, sessionMemory, programmingLanguage, contextManager.getContext())
// :313  buildTranscriptionRequest(text, activeSkill, sessionMemory, programmingLanguage, contextManager.getContext())
```

### Sink patch shape (identical at every dynamic sink)
```js
// before:  el.innerHTML = renderMarkdown(text);
// after:   el.innerHTML = window.sanitizeHtml(renderMarkdown(text));
// (src/ui/*.js files: sanitizeHtml is on window via the sanitize.js script tag in the host HTML)
```

### Guarded IPC registration (main.js)
```js
const { isChannelAllowed } = require('./src/core/ipc-scope');
const guardedHandle = (channel, fn) => ipcMain.handle(channel, (event, ...args) => {
  const windowType = windowManager.getWindowTypeByWebContentsId(event.sender?.id);
  if (!isChannelAllowed(channel, windowType)) {
    logger.warn('IPC denied', { channel, windowType: windowType || 'unknown' });
    return { ok: false, error: 'denied' };
  }
  return fn(event, ...args);
});
// then mechanically: ipcMain.handle("get-settings", …) → guardedHandle("get-settings", …), etc.
```
</code_examples>

<sota_updates>
## State of the Art (2025-2026)

| Old Approach | Current Approach | Impact |
|--------------|------------------|--------|
| innerHTML + trust the model | DOMPurify at every sink (default for LLM output rendering) | SEC-01 is the industry-standard mitigation for prompt-injected markup |
| One shared preload + unvalidated ipcMain | `event.sender` validation + least-privilege preloads (Electron security checklist items 15/17) | SEC-03 matches current Electron guidance exactly |
| Screen capture via always-on stream | Snapshot `getSources` on demand | Snapshot model minimizes indicator time + CPU for hold-latest |
| macOS TCC assumed stable | macOS 15+ periodic screen-recording re-approval prompts | Detection + guided re-grant (SEC-02) is now table stakes for capture apps |

**Deprecated/outdated:** `systemPreferences.getMediaAccessStatus` is stable in Electron 29 (not deprecated); `nativeImage.getBitmap()` is deprecated → use `toBitmap()`.
</sota_updates>

<open_questions>
## Open Questions

1. **Exact macOS deep-link behavior on the user's macOS build (26.x observed on this machine)**
   - Known: `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture` / `?Privacy_Microphone` honored Ventura→Sequoia via compat shims.
   - Unclear: whether newer macOS renames the pane anchor.
   - Recommendation: attempt deep-link; on failure fall back to opening the Privacy & Security root (`x-apple.systempreferences:com.apple.preference.security`). Verify at the attended checkpoint.

2. **Black-frame thresholds (mean<4, variance<2) against real revoked-TCC frames**
   - Known: revoked screen capture yields uniform black (sometimes wallpaper on old macOS).
   - Unclear: exact pixel values with cursor compositing.
   - Recommendation: thresholds as config-adjacent constants in frame-dedup.js; tune at the attended checkpoint (revoke permission live and observe logs).

3. **Indicator behavior under 0.5 Hz snapshots on macOS 15+**
   - Known: indicator shows during active capture; snapshots are brief.
   - Unclear: flicker vs persistent.
   - Recommendation: observe at checkpoint; no code contingency (OS-owned UI).

4. **`getMediaAccessStatus('screen')` latency reflecting revocation**
   - Known: reads TCC state without prompting.
   - Unclear: whether a just-revoked grant reads 'denied' immediately in a still-running process on every macOS version.
   - Recommendation: the locked cross-check (black frames AND status) already tolerates either ordering; warn-log disagreement.
</open_questions>

## Validation Architecture

### Test Infrastructure
| Property | Value |
|----------|-------|
| Framework | `node:test` (built-in; repo standard) |
| Quick run | `node --test test/<file>.test.js` |
| Full suite | `make run_tests` (= `node --test test/*.test.js`; 145/145 green pre-phase) |
| Lint | `make lint` (= `npx eslint .`; 0 errors pre-phase) |
| Estimated runtime | full suite < 30s |

### Automated coverage per pillar (pure modules — the repo pattern: test `src/core/*`, never the singletons)
| Pillar | Module | Tests |
|--------|--------|-------|
| CONT-04 dedup | `src/core/frame-dedup.js` | grayscale/BGRA order; dhash bit determinism; hamming identical=0, distinct>threshold; blackStats on synthetic black/noise buffers |
| CONT-05 budget | `src/core/context.manager.js` (pure helper) | whole-file stop-before-bust; alpha order; empty/missing folder → empty string; N-of-M status shape; 12k default |
| SEC-01 policy | `src/core/sanitize-policy.js` | config forbids img/style/script vectors; `applyAnchorPolicy` fake-node: http(s) kept + rel forced, `javascript:`/`data:` href removed |
| SEC-03 table | `src/core/ipc-scope.js` | privileged trio denied for llmResponse/chat, allowed for settings/main; unknown channel → deny; unknown windowType → deny; every registered ipcMain channel present in the table (completeness assertion against a hardcoded list) |

### Manual-only verifications (attended checkpoint at phase end)
| Behavior | Req | Why manual |
|----------|-----|------------|
| Hostile-markdown answer renders inert (`<img onerror>`, `javascript:` link) in overlay + chat | SEC-01 | needs the real DOMPurify in a real renderer |
| TCC revoke → banner → deep-link → relaunch → recovery | SEC-02 | System Settings interaction |
| Idle screen ⇒ skipped ticks (log), active screen ⇒ fresh `latestFrame`; screenshot hotkey still works | CONT-04 | visual/live behavior |
| Notes folder picked in settings; restart; "N of M loaded"; answer reflects notes content | CONT-05 | end-to-end restart flow |
| Overlay denied a settings read (devtools probe → denied + warn log) | SEC-03 | live IPC probe |

### Sampling
- After every task commit: targeted `node --test test/<new>.test.js`
- After every plan: `make run_tests` + `make lint` (both must be green — no 3 consecutive tasks without automated verify)
- Headless boot check (`timeout 20 npx electron . --no-sandbox` pattern from Phases 3/4) after main.js-touching plans: zero uncaught exceptions

<sources>
## Sources

### Primary (HIGH confidence)
- Codebase audit 2026-07-16 (line-verified): capture.service.js, window.manager.js:266-465/939-961, preload.js (both bridges, full surface), main.js:537-1120 (all ipcMain), main.js:846 (open-external validator), main.js:1918-2005 (get/saveSettings + persistEnvUpdates), local.provider.js:95/259/287/313, request-builder.js:80/142/161, config.js, llm-response.html/chat.html/onboarding.js/src/ui/*.js renderer bridge usage, test/ layout, package.json deps
- npm registry (queried live): dompurify@3.4.12 `main=./dist/purify.cjs.js`, `browser=./dist/purify.js`
- Electron 29 API surface (desktopCapturer thumbnailSize + display_id, nativeImage resize/toBitmap/toJPEG, systemPreferences.getMediaAccessStatus, powerMonitor lock/unlock/suspend/resume, dialog.showOpenDialog, app.relaunch) — all shipped in 29.x
- Phase artifacts: 03-03 (serialize mdContext join), 03-07 (12k prefill validation), 04-06 (wake-rewarm powerMonitor pattern), STATE.md decisions

### Secondary (MEDIUM confidence)
- macOS TCC behavior (screen-recording relaunch requirement, post-update signature re-evaluation, macOS 15+ periodic re-approval, System Settings deep-link anchors) — consistent community/Electron-ecosystem knowledge; runtime-verify at the attended checkpoint (Open Questions 1-4)

### Tertiary (LOW confidence)
- Exact black-frame pixel statistics under revoked TCC — tune live (Open Question 2)
</sources>

<metadata>
**Research scope:** Electron 29 capture/permissions/IPC, DOMPurify distribution in a no-bundler CJS app, perceptual hashing in pure JS, md-context wiring through the existing provider seam
**Confidence:** stack HIGH · architecture HIGH (grounded in line-verified audit) · pitfalls HIGH · TCC empirics MEDIUM (OS-version-dependent; cross-check design absorbs uncertainty)
**Research date:** 2026-07-16 · **Valid until:** ~2026-08-16 (stable platform APIs)
</metadata>

---

*Phase: 05-continuous-capture-notes-hardening*
*Research completed: 2026-07-16*
*Ready for planning: yes*
