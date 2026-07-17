# Phase 5: Continuous Capture, Notes & Hardening - Context

**Gathered:** 2026-07-16
**Status:** Ready for planning

<domain>
## Phase Boundary

Land the two **new continuous inputs** — a **throttled, deduped, downscaled continuous
screen-capture loop** (CONT-04) and a **settings-configured `.md` notes folder loaded as
bounded standing context each launch** (CONT-05) — and harden, **in the same phase**, the
threat surface those inputs create: **DOMPurify at every model-output `innerHTML` sink**
(SEC-01), **macOS TCC permission-loss detection + guided re-grant** (SEC-02), and
**sender-scoped privileged IPC** (SEC-03). All of it ships before Phase 6 turns on the
always-on pause→answer firehose.

Requirements delivered: **CONT-04, CONT-05, SEC-01, SEC-02, SEC-03**.

**In scope for this phase:**
- Continuous capture loop in/behind `capture.service.js`: fixed tick, downscale-before-encode,
  perceptual-hash frame-diff dedup (unchanged/idle screen ⇒ no encode/model cost), holding a
  `latestFrame` for Phase 6 to pull. Image goes **directly to the model** path (no OCR). The
  existing single-shot screenshot path keeps working unchanged.
- A notes/context loader (research: `context.manager.js`) that reads a settings-configured
  folder of `.md` files at startup into a bounded string, wired into the **existing
  `RequestBuilder.mdContext` parameter** (empty since Phase 2/3) so every model call carries it
  in the system prefix.
- DOMPurify sanitization at **every** `innerHTML` sink that renders dynamic/model content —
  including the dead-but-present `chat-window.js`.
- TCC recovery: detect screen/mic permission loss (status API + all-black-frame heuristic),
  inline-banner guidance, deep-link to the exact System Settings pane, one-click relaunch.
- IPC scoping: main-process sender→channel allowlist covering **every** ipcMain channel +
  per-window-class preload split; overlay/chat renderers reduced to a minimal surface.

**Explicitly NOT in scope (deferred — do not pull in):**
- **Pause orchestrator / relevance gate / streamed ephemeral suggestions** — **Phase 6**
  (CONT-01/02/03). This phase only *holds* the latest frame; nothing consumes it per-pause yet.
- **Trust indicator + one-click kill switch** — **Phase 6** (CONT-06/07).
- **Thermal/battery back-off** (capture throttle on battery, `powerMonitor` load shedding) —
  **Phase 6** (its SC5). Phase 5 pauses capture only on lock/sleep.
- **Sustained-load TTFT/memory validation** (minute-45 budget) — **Phase 6**.
- **mic+system fusion, dedup across channels, diarization** — Phase 6 / v2.
- **DMG packaging, dead-code deletion** (`chat-window.js`, 0-byte `fallback-capture.service.js`),
  license cleanup — **Phase 8** (patch dead sinks now anyway; Phase 8 deletes the files).
- **Windows/Linux** capture/permission equivalents — v2; TCC work is macOS-only.

Tech constraints carried from Phases 1–4 (still binding):
- **CommonJS + vanilla JS**, no bundler / TypeScript / framework; match existing conventions.
- **Logging:** `require('./core/logger').createServiceLogger('<TAG>')`; never interpolate
  variable data into the message. **Error philosophy:** degrade gracefully, never crash.
- **Tests:** Node's built-in `node:test` / `node --test`; keep pure logic (hashing, budgeting,
  allowlist checks, sanitize policy) unit-testable.
- ESM-only packages cannot be `require()`d (get-port/execa/node-fetch lesson) — check any new
  dep (DOMPurify main entry is CJS-compatible; verify at install).

</domain>

<decisions>
## Implementation Decisions

### Continuous capture (CONT-04)
- **Tick: every 2s** — fresh-enough frame at any natural pause; dedup makes idle cost ≈ a hash.
- **Dedup: perceptual hash** (dHash/aHash-style) computed on the downscaled frame — tolerant of
  cursor blink / trivial pixel noise; **small threshold knob** in config. Exact algorithm +
  bit-distance threshold = planner/researcher discretion.
- **Pause conditions: screen lock + system sleep only** (via `powerMonitor` — reuse the Phase 4
  `wake-rewarm.js` listener pattern). **No battery throttle this phase** — thermal/battery
  back-off is Phase 6 SC5's job.
- **Delivery: hold-latest.** The service keeps the newest deduped frame (`latestFrame` +
  metadata: timestamp, hash, dimensions); **Phase 6 pulls it at pause time. Nothing is pushed
  to the model per-capture this phase.**
- **Display: primary display only.** Follow-cursor / multi-monitor deferred.
- **No OCR** — the frame is the model input (multimodal), per CONT-04.

### Notes / md-context (CONT-05)
- **Folder selection: native picker + editable text path.** Settings button opens
  `dialog.showOpenDialog` (directory mode); chosen path stored in settings and shown as an
  editable text field too.
- **Reload: launch-only** — exactly what CONT-05 requires; edit notes → restart to apply.
  **No `fs.watch`** (deferred; keeps the Phase 6 hot path deterministic and the KV prefix stable).
- **Budget: 12,000 chars, configurable** — the size Phase 3 already validated prefill latency
  against (03-07 smoke used ~12k filler md-context).
- **Over budget: whole files, stable order.** Concat alphabetically; stop before the file that
  would bust the budget (no mid-file truncation); log + surface **"N of M files loaded"** in
  settings.
- Wire into `RequestBuilder`'s existing `mdContext` param → LocalProvider system prefix
  (the seam built in 02/03 — no provider changes needed).

### Output sanitization (SEC-01)
- **Central sanitize helper** — one shared module holding the locked DOMPurify config; every
  sink calls `sanitize(html)` immediately before `innerHTML` assignment. One policy, greppable,
  unit-testable.
- **Links: allowed, http(s) only.** `<a>` survives with http/https hrefs; `javascript:`/`data:`
  schemes stripped; `rel="noopener noreferrer"` enforced; clicks route through the existing
  URL-validated `open-external` IPC (never in-window navigation).
- **Images: stripped entirely.** A rendered `<img src=remote>` is itself a beacon/exfil channel
  in a stealth app; model answers don't legitimately need images.
- **Patch ALL sinks** — including dead `chat-window.js` (requirement says *every* sink; trivial
  cost; safe if Phase 8 reordering ever slips).
- Applies to output from **both** markdown paths in `llm-response.html` (`marked@15` and the
  bundled fallback parser) — sanitize the parsed HTML, not the markdown source.

### TCC recovery (SEC-02)
- **Detection: status API + black-frame heuristic, cross-checked.**
  `systemPreferences.getMediaAccessStatus('screen'|'microphone')` at startup, **plus** an
  all-black-frame check (variance ≈ 0, nearly free next to the dedup hash) inside the capture
  loop, **plus** the mic-stream failure signal from the speech path. Cross-check so a genuinely
  black screen doesn't false-alarm (black frames AND status ≠ granted ⇒ TCC loss).
- **Guidance: inline banner** in the main overlay — the established Phase 3/4 recovery idiom
  (Local-down / voice-unavailable). Screen loss ⇒ capture guidance; mic loss ⇒ voice guidance.
  App keeps working degraded; never a blocking modal.
- **Re-grant flow: deep-link + relaunch.** Banner button opens the exact System Settings pane
  (`x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture` /
  `?Privacy_Microphone`), then offers **one-click "Relaunch app"** (Screen Recording grants
  only take effect after restart).
- **Re-check cadence: event-driven, no polling timer** — startup check, capture-loop
  black-frame signal, app focus regain, `powerMonitor` resume.

### IPC scoping (SEC-03)
- **Mechanism: BOTH layers.** (1) A **central channel→allowed-window-types allowlist** enforced
  in the main process via `event.sender` identity — the load-bearing gate, per Electron security
  guidance. (2) **Per-window-class preloads** so the overlay/chat bridge never even exposes
  settings APIs. Defense in depth.
- **Overlay/chat surface (llm-response, chat): minimal.** `copy-to-clipboard` (write-only),
  `open-external` (http(s)-validated — needed for sanitized model-output links), their
  window-resize/expand channels, and receive-only events. **No settings read/write** (matches
  today's actual usage — scout confirmed they only call copyToClipboard).
- **Violation behavior: deny + structured warn log** (channel + window type). Degrade-never-
  crash; violations greppable. No throws, no silent nulls.
- **Breadth: full channel table.** Every `ipcMain` channel declares its legitimate window
  audience in one table with one check helper; the SEC-03 trio (settings read, openExternal,
  clipboard) are just rows. New channels must declare their audience. Covers **both** bridges
  (`electronAPI` and the legacy `api` bridge).

### Claude's Discretion
- **Capture:** downscale target (~1280px long edge per Phase 3 research is the anchor),
  PNG vs JPEG for the held frame, exact perceptual-hash algorithm + threshold + implementation
  (prefer pure JS on `nativeImage` bitmap — avoid a native dep like sharp unless proven
  necessary), loop start timing (launch vs post-onboarding, mirroring ambient listening),
  interaction with the existing `isProcessing` guard, whether `desktopCapturer` captures at
  target resolution via `thumbnailSize` vs capture-full-then-resize.
- **Notes:** recursive vs top-level folder walk, per-file size cap, hidden-file/dotfile
  filtering, missing/empty-folder UX copy, where the loader lives (`src/core/context.manager.js`
  suggested by research) and its exact call sites in main.js request paths.
- **Sanitize:** helper location + how plain-HTML renderers load it (vendored file vs
  node_modules script tag), exact DOMPurify tag/attr allowlist beyond the locked link/image
  policy, how code blocks + syntax highlighting survive sanitization, whether `escapeHtml`-only
  paths need touching.
- **TCC:** black-frame variance threshold + pixel sample stride, banner copy, relaunch
  mechanics (`app.relaunch()` + `app.exit()`), first-launch permission priming (if any).
- **IPC:** preload split shape (per-window files vs one preload parameterized by window type),
  channel-table location/format, sender→window-type mapping (WebContents-id registry in
  WindowManager vs URL matching), what happens to unused legacy channels found during the audit
  (flag for Phase 8, don't delete here).
- Test approach per pillar (hash/budget/allowlist/sanitize-policy unit tests; what gets a
  headless boot check vs attended verification).

</decisions>

<specifics>
## Specific Ideas & Reusable Assets (grounded — from the code scout)

**Capture path today:**
- `src/services/capture.service.js` (122 lines) — single-shot `desktopCapturer.getSources` at
  **full display resolution** (`thumbnailSize` = display size), `image.toPNG()`, `isProcessing`
  guard, crop support. Clean seam to extend; **keep the single-shot path working**.
- `src/managers/window.manager.js:939-961` — existing 1×1 `desktopCapturer` capture-availability
  probe (a permission-probe precedent).
- No interval/downscale/dedup anywhere yet. No sharp/jimp — image ops via Electron `nativeImage`.

**innerHTML sink inventory (SEC-01 targets):**
- `llm-response.html:837, 842, 845, 850, 882` — **the** model-output overlay renderer; markdown
  via `marked` (`:504-516`, `:606-607`) **with a bundled fallback parser**; `:908` is an
  escape-read.
- `chat.html:800, 869, 920, 1051, 1101` — live chat renderer (`formatMarkdown` → innerHTML at
  `:869`; `escapeHtml` code path at `:1101`).
- `src/ui/chat-window.js:364, 481, 494, 553` — **dead code** (Phase 8 deletes) but has
  model-output sinks (`formatMarkdown` at `:364`) — patch anyway per decision.
- `src/ui/main-window.js:703, 749, 778, 1240, 1448` and `src/ui/settings-window.js:186, 444` —
  static/controlled content; audit each, sanitize any that ever carry dynamic strings.
- `marked@15.0.12` already a dep; **DOMPurify not yet installed**. Electron `29.4.6`.

**IPC surface today (SEC-03 targets):**
- **One shared `preload.js` for ALL windows** (`src/core/config.js:31` — every window type gets
  the same bridge). Two bridges: `electronAPI` (full API incl. `getSettings`, `saveSettings`,
  `openExternal`, `copyToClipboard`) + legacy `api` (channel-allowlisted send/receive).
- `contextIsolation: true`, `nodeIntegration: false` everywhere (`window.manager.js:276-282`,
  `config.js:27-32`). **No sender validation on any handler.**
- Privileged handlers: `get-settings` `main.js:799` (returns full settings to ANY window),
  `open-external` `main.js:846` (URL-shape validated, sender-unvalidated), `copy-to-clipboard`
  `main.js:542`, `save-settings` `main.js:1031` (+ legacy `ipcMain.on` at `:1109`).
- **Actual usage by window** (scout): overlay+chat call **only** `copyToClipboard`;
  settings read/write only from main/settings/onboarding; `openExternal` only from onboarding.
  The minimal-overlay scoping matches reality; only sanitized-link clicks add `open-external`
  to the overlay.
- `getSettings()` (`main.js:1918-1945`) returns **no keys anymore** (cloud creds deleted in
  Phases 3/4) — SEC-03 is defense-in-depth + Phase 6 future-proofing, not a live key leak.
- Window types: `main`, `chat`, `llmResponse`, `settings`, `onboarding`
  (`window.manager.js:266+`).

**md-context seam (CONT-05 target):**
- `src/core/request-builder.js:80, 142, 161` — every build*Request accepts
  `mdContext = ''`; already flows into the neutral request (`:114, :137, :155, :200, :212`).
- LocalProvider `serialize()` already appends mdContext to the system prefix (Phase 3, 03-03) —
  **the only work is building the loader + passing the string at call sites in main.js**.
- Phase 3's 03-07 smoke validated TTFT with ~12k chars of filler md-context — the budget is
  pre-validated.

**TCC (SEC-02 — greenfield):**
- **Zero `systemPreferences` / permission code exists today** — detection is net-new.
- `wake-rewarm.js` (Phase 4) — the `powerMonitor` suspend/resume listener pattern to reuse for
  capture pause/resume and permission re-checks.
- Phase 3/4 recovery idiom to mirror: inline banner + one-click action (Local-down repair,
  voice-unavailable retry).

**References:**
- `.planning/research/SUMMARY.md` Phase 5 section — `context.manager.js` + extended
  `capture.service.js` shapes; ARCHITECTURE Patterns 5 (capture) + 7 (bounded md-context, no RAG).
- PITFALLS: 3 (TCC — ship with capture), 7 (XSS — ship with capture/notes), 9 (battery/thermal —
  dedup is the biggest lever), 10 (bounded context slot).

</specifics>

<deferred>
## Deferred Ideas

- **`fs.watch` live notes reload** — declined this phase (launch-only per CONT-05); revisit if
  restart-to-apply annoys in practice. [[phase-6-or-v2]]
- **Battery-aware capture throttle / thermal back-off** — **Phase 6** (its SC5, `powerMonitor`
  load shedding).
- **Pushing frames into the model / any per-pause consumption of `latestFrame`** — **Phase 6**
  (orchestrator).
- **Follow-cursor / multi-display capture** — later; primary display only this phase.
- **Read-only prefs subset for the overlay renderer** — only if a Phase 6 UI needs it; start
  with zero settings access.
- **CSP headers for the HTML renderers** — belt-and-suspenders beyond SEC-01; note for Phase 8
  cleanup if cheap.
- **Deleting dead files** (`chat-window.js`, `fallback-capture.service.js`, unused legacy IPC
  channels found in the audit) — **Phase 8** (flag, don't delete here).

</deferred>

<research_flags>
## Research Flags (carry into /gsd-plan-phase → gsd-phase-researcher)

1. **`desktopCapturer` at 2s cadence on Electron 29** — CPU/GPU cost of `getSources` per tick;
   whether requesting the downscaled size directly via `thumbnailSize` (capture-at-target-res)
   beats capture-full-then-`nativeImage.resize`; any screen-recording indicator behavior from
   repeated calls (macOS purple/orange dot semantics for a stealth app).
2. **Perceptual hash in pure JS** — dHash/aHash on the downscaled grayscale `nativeImage`
   bitmap (`toBitmap()`/`getBitmap()`); sensible bit-distance threshold; cursor-blink tolerance;
   confirm no native dep (sharp/jimp) is needed at this frame rate.
3. **TCC empirics on target macOS** — `getMediaAccessStatus('screen')` semantics (it reports
   without prompting; how fast it reflects revocation), black-frame variance detection
   reliability, whether Screen Recording re-grant **strictly** requires relaunch on current
   macOS, exact working deep-link URLs for Ventura+ System Settings.
4. **DOMPurify distribution to plain-HTML renderers** — vendored script vs node_modules path in
   `llm-response.html`/`chat.html` (no bundler); CJS `require` in `src/ui/*.js` renderers;
   config that enforces http(s)-only anchors + strips `<img>` while keeping code blocks +
   existing syntax highlighting intact; interaction with **both** markdown paths (marked@15 and
   the bundled fallback).
5. **Sender-scoped IPC mapping** — reliable sender→window-type identification
   (WebContents-id registry in WindowManager vs `senderFrame.url` matching); full audit of every
   `ipcMain.handle`/`on` channel (both bridges) for the allowlist table; preload split mechanics
   when `config.get('window.webPreferences')` bakes one preload path.
6. **md-context call-site wiring** — enumerate every `RequestBuilder` call site in `main.js`
   that should pass the loaded notes string; confirm the 12k budget against 03-07's measured
   TTFT (pre-validated — cite, don't re-run).

</research_flags>

---

*Phase: 05-continuous-capture-notes-hardening*
*Context gathered: 2026-07-16*
