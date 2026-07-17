---
phase: 05-continuous-capture-notes-hardening
plan: 05
subsystem: ipc-security
tags: [sec-03, ipc, sender-validation, allowlist, preload, electron, defense-in-depth]

# Dependency graph
requires:
  - phase: 05-02
    provides: "open-external overlay link routing (sanitized links) — the reason chat/llmResponse are in the open-external audience"
  - phase: 05-03
    provides: "select-notes-folder IPC (settings audience) — new Phase-5 channel encoded in the table"
  - phase: 05-04
    provides: "open-privacy-settings + relaunch-app IPC (main audience) — new Phase-5 channels encoded in the table"
provides:
  - "src/core/ipc-scope.js — CHANNEL_AUDIENCES (all 60 registered channels) + isChannelAllowed default-deny helper"
  - "WindowManager.webContentsTypes registry (wcId → type, set before loadFile, cleaned on destroyed) + getWindowTypeByWebContentsId(id)"
  - "preload-overlay.js — minimal bridge for the llmResponse/chat window classes (zero settings/model/whisper/capture APIs)"
  - "guardedHandle/guardedOn sender gate on EVERY ipcMain registration in main.js (deny + structured warn, never throw)"
  - "Completeness reflection test: any future channel registered without a CHANNEL_AUDIENCES row fails CI"
affects:
  - "05-06 (attended gate): live overlay denial probe (devtools getSettings → denied + warn log) runs against this plan"
  - "Phase 6 (pause orchestrator): any new IPC channel must declare its audience row — the completeness test enforces it"
  - "Phase 8 (cleanup): six unused legacy channels flagged below for deletion"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Central channel→audience table (one row per ipcMain channel) + default-deny helper; runtime gate AND CI completeness test read the same table"
    - "Sender identity via WebContents-id registry (set between new BrowserWindow and loadFile — no early-IPC race; 'destroyed' cleanup), never URL matching"
    - "Per-window-class preload split: model-output renderers (untrusted content) load a strict-subset bridge; the main-process table remains the load-bearing gate"
    - "Deny semantics: handle → { ok:false, error:'denied' } + warn log; on → drop + warn log — degrade-never-crash, violations greppable via 'IPC denied'"

key-files:
  created:
    - src/core/ipc-scope.js
    - test/ipc-scope.test.js
    - preload-overlay.js
  modified:
    - src/managers/window.manager.js
    - main.js
    - eslint.config.js

key-decisions:
  - "Unaudited window-management/control channels widened to ['main','settings'] only (privileged-widen rule) — never toward chat/llmResponse"
  - "preload-overlay.js header lists the absent surface by CHANNEL name (kebab-case), not bridge method name — the plan's own leak-check regex greps for the camelCase bridge names, so listing those verbatim would self-trip the check"
  - "Completeness test guards against vacuous pass: asserts ≥ 55 channels extracted before asserting membership (a broken regex can never silently pass)"

patterns-established:
  - "New IPC channel workflow: register via guardedHandle/guardedOn + add a CHANNEL_AUDIENCES row, or the channel is denied at runtime and the completeness test fails in CI"

requirements-completed: [SEC-03]

# Metrics
duration-minutes: 24
completed: 2026-07-17
---

# Phase 5 Plan 05: Sender-Scoped IPC (SEC-03) Summary

**One-liner:** Every one of the 64 ipcMain registrations now flows through a sender-identity gate (WebContents-id → window type → central 60-row channel→audience table, default-deny, deny+warn never throw), and the model-output renderers (llmResponse/chat) load a new minimal preload with zero settings/model/whisper APIs — both SEC-03 layers live, proven by a 10-test suite including a CI completeness reflection against main.js.

## What Was Built

### Task 1 — `src/core/ipc-scope.js` (+ 10 node:test cases, TDD)
- **`CHANNEL_AUDIENCES`** — one row per registered channel (60 unique channels covering all 54 `handle` + 10 `on` registrations; 4 channels are dual-registered). Pure CJS, zero requires. Every non-obvious row commented with its consumer.
- **`isChannelAllowed(channel, windowType)`** — default-deny: unknown channel, unknown/null/non-string windowType ⇒ false. (Non-string guard means an array windowType can never spoof `.includes`.)
- **Locked rows byte-match the plan spec:** `get-settings`/`save-settings` = `['main','settings','onboarding']` (NEVER chat/llmResponse); `open-external` = `['chat','llmResponse','onboarding']` (main excluded — not in audited usage); `copy-to-clipboard` = `['main','chat','llmResponse']`; `open-privacy-settings`/`relaunch-app` = `['main']`; `select-notes-folder` = `['settings']`.
- **Tests:** trio denial for overlay/chat, privileged allows, default-deny (unknown channel / null / undefined / non-string), Phase-5 rows, table hygiene (audiences are non-empty arrays of known window types), and the **completeness reflection test** — extracts every channel from main.js source via a regex matching BOTH `ipcMain.handle/on` and `guardedHandle/guardedOn` forms (green before and after the Task-3 rename), asserts ≥ 55 extracted (anti-vacuous guard) and that each is a table key.

### Task 2 — Sender registry + preload split (`window.manager.js`, `preload-overlay.js`)
- `WindowManager.webContentsTypes` Map: `wcId → type` set **immediately after `new BrowserWindow`, before `loadFile`** (no early-IPC race; verified in the diff), deleted on webContents `'destroyed'`. `getWindowTypeByWebContentsId(id)` returns the type or `null` (⇒ deny).
- Per-class preload computed before baseOptions: `llmResponse|chat → preload-overlay.js`, everything else keeps the config-baked privileged `preload.js`; the override is added **after** the `...config.get('window.webPreferences')` spread so it wins.
- **`preload-overlay.js`** — strict subset of preload.js (method bodies copied verbatim): `copyToClipboard`, `openExternal`, `sendChatMessage`, speech toggles + availability, `expandLlmWindow`, `resizeLlmWindowForContent`, `closeWindow`, `notifyChatWindowReady`, the receive-only event list, `receive`, `removeAllListeners`; legacy `api.send` allowlist reduced to exactly `['quit-app', 'window-loaded']` (receive list unchanged — receive-only is safe). Header explicitly enumerates the absent surface (settings read/write, notes picker, all model/whisper lifecycle, capture triggers, SEC-02 recovery, audio-chunk, window management) and why.
- eslint Block 1 gains `preload-overlay.js` (same treatment as preload.js).
- Leak check green: none of `getSettings|saveSettings|selectNotesFolder|downloadWhisperModel|pullModel|openPrivacySettings|relaunchApp|sendAudioChunk|takeScreenshot|captureArea` appear anywhere in the file.

### Task 3 — Guarded registrations (main.js)
- `guardedHandle`/`guardedOn` defined once at the top of `setupIPCHandlers()` (all 64 registrations live inside that one method): resolve `event.sender && event.sender.id` → window type → `isChannelAllowed`. Deny: handle returns `{ ok:false, error:'denied' }` + `logger.warn('IPC denied', { channel, windowType })`; on drops after the same warn. Never a throw, never a silent null.
- All 64 registrations mechanically converted (54 → `guardedHandle`, 10 → `guardedOn`); handler bodies untouched. Only the two wrapper definitions still reference `ipcMain.handle(`/`ipcMain.on(` (unquoted `channel` arg — invisible to the completeness regex, and the raw-count check allows ≤ 2).

## Final Audience Table Stats

| Window class | Channels in audience | Notes |
|---|---|---|
| main | 39 | full control surface incl. SEC-02 recovery |
| settings | 38 | settings/model/whisper lifecycle + widened control channels |
| onboarding | 12 | first-run + model/whisper download surface |
| **chat** | **8** | send/speech/clipboard/open-external/ready/close only |
| **llmResponse** | **6** | clipboard/open-external/expand/resize/close/quit only |

- 60 channels total; 17 unaudited control channels resolved by the privileged-widen rule to `['main','settings']` — zero channels widened toward chat/llmResponse beyond audited use.
- Neither overlay class has `get-settings`, `save-settings`, or ANY model/whisper/capture/first-run channel — in BOTH layers (table + preload).

## Phase-8 Flag: Unused Legacy Channels (NOT deleted — no table row; default-deny covers them)

Preload references with **no main-side registration** (dead bridge surface found during the audit):
- `hide-settings` (preload.js `hideSettings`)
- `get-llm-session-history` (preload.js `getLLMSessionHistory`)
- `format-session-history` (preload.js `formatSessionHistory`)
- `toggle-recording` (legacy `api.send` allowlist)
- `toggle-interaction-mode` (legacy `api.send` allowlist)
- `window-loaded` (legacy `api.send` allowlist — kept in preload-overlay's reduced allowlist per plan; sends go nowhere)

Also noted for Phase 8: `ipcMain.on('chat-window-ready')` currently has no live sender (chat.html never sends it); `preload-overlay.js` exposes `notifyChatWindowReady` as the plan-specified forward provision.

## Audience Rows Widened During Boot Testing

**None.** The first headless boot produced zero `IPC denied` lines — the table was correct as audited; no row changed after Task 1.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] preload-overlay.js header lists absent APIs by channel name, not bridge method name**
- **Found during:** Task 2
- **Issue:** the plan asks the header to "EXPLICITLY list what is absent: getSettings, saveSettings, selectNotesFolder, …" while its own verify step fails the task if those exact camelCase strings appear anywhere in the file — the two instructions are mutually exclusive
- **Fix:** resolved in favor of the executable verify command — the header enumerates the absent surface by main.js channel name (`get-settings`, `select-notes-folder`, …), which is equally explicit and keeps the leak-check regex meaningful
- **Files modified:** preload-overlay.js
- **Commit:** afac14e

No other deviations — tasks executed as written. (eslint.config.js was named in the Task-2 action text though not in the frontmatter `files_modified` list; included in the Task-2 commit pathspec.)

## Verification Results

| Gate | Result |
|---|---|
| `node --test test/ipc-scope.test.js` | 10/10 pass (≥ 8 required), incl. completeness reflection |
| `make run_tests` | 193/193 pass (183 pre-plan + 10 new) |
| `make lint` (`npx eslint .`) | 0 errors |
| Trio rows | byte-match the plan spec (asserted by tests) |
| `rg -c "guardedHandle\(" main.js` / `"guardedOn\("` | 54 (≥ 50) / 10 (≥ 8) |
| Raw `ipcMain.handle(`/`.on(` matches | 2 (the wrapper definitions only; ≤ 2 allowed) |
| Registry placement | `.set(` between `new BrowserWindow` and `loadFile` (diff-verified) |
| Overlay leak check (node one-liner) | exit 0 — no privileged API names in preload-overlay.js |
| Legacy `api.send` allowlist in overlay preload | exactly `['quit-app', 'window-loaded']` |
| Headless boot (~25 s, real windows created) | 0 uncaught/unhandled, **0 `IPC denied` lines** (all legit startup flows pass the gate); notes context loaded, continuous capture started, no TCC-registration failure warn |
| Completeness test after the Task-3 rename | still green (regex matches the guarded form) |

Live overlay denial probe (devtools `getSettings` from llm-response → denied + warn log) is attended → **05-06 gate** per plan.

## Known Stubs

None. The gate is live on every channel and both preload classes ship real surfaces. `notifyChatWindowReady` in preload-overlay.js has no current caller (chat.html never sent `chat-window-ready` — a pre-existing dormant listener, not introduced here); exposed per the plan's audited-union spec and flagged above for Phase 8.

## Commits

| Task | Commit | Type | Description |
|---|---|---|---|
| 1 (RED) | 6a90804 | test | failing tests for IPC channel audience table |
| 1 (GREEN) | e6d1ba8 | feat | IPC channel audience table |
| 2 | afac14e | feat | webContents registry + per-class preload split |
| 3 | 50f0745 | feat | sender-scoped guard on all ipcMain channels |

## Next Phase Readiness

- **05-06 attended gate:** probe from the llm-response devtools — `window.electronAPI.getSettings` must be `undefined` (preload layer); a raw `ipcRenderer`-less bypass isn't possible under contextIsolation, and any main-process attempt logs `IPC denied { channel: 'get-settings', windowType: 'llmResponse' }` (table layer). Chat speech toggles, overlay copy/links, settings/onboarding flows all verified working headlessly.
- **Phase 6:** new orchestrator channels must add a CHANNEL_AUDIENCES row — the completeness test + runtime default-deny enforce the discipline automatically.

## Self-Check: PASSED

- Created files exist: src/core/ipc-scope.js, test/ipc-scope.test.js, preload-overlay.js ✓
- Commits exist: 6a90804, e6d1ba8, afac14e, 50f0745 ✓
- ipc-scope tests 10/10; full suite 193/193; lint 0; boot clean with zero denials ✓
