---
phase: 05-continuous-capture-notes-hardening
plan: 04
subsystem: permissions
tags: [tcc, sec-02, systemPreferences, permission-recovery, deep-link, relaunch, electron]

# Dependency graph
requires:
  - phase: 05-01
    provides: "captureService.setFrameStatsListener()/getBlackStreak() — the black-frame signal seam"
  - phase: 05-02
    provides: "window.sanitizeHtml + the sanitized-shell/createElement'd-buttons recovery-panel precedent"
provides:
  - "src/core/tcc-monitor.js createTccMonitor — pure DI'd cross-check state machine (black-streak + status fusion, transition-only emission)"
  - "permission-status broadcast (main → all windows): transition-only { screen:'ok'|'lost', mic:'ok'|'lost', reason }"
  - "open-privacy-settings IPC (enum 'screen'|'microphone' → x-apple pane URL mapped in MAIN, root-pane fallback)"
  - "relaunch-app IPC (app.relaunch + app.exit(0))"
  - "Inline perm-banner-screen / perm-banner-mic recovery banners in the main overlay"
affects:
  - "05-05 (SEC-03) must add open-privacy-settings + relaunch-app to the channel→audience table when converting to guarded handlers"
  - "05-06 attended gate: live revoke → banner → deep-link → relaunch → recovery"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "TCC cross-check: loss requires BOTH signals (black-frame streak >= threshold AND status != granted); lone signals go to a greppable onDisagreement warn seam, never a banner"
    - "Sticky-lost hysteresis: screen recovers only on granted status + an actual non-black frame; mic failure is sticky until recordMicRecovered()"
    - "Event-driven re-checks only (startup / frame signal / browser-window-focus / powerMonitor resume) — no polling timer anywhere"
    - "Enum-only privileged deep-link IPC: renderer passes a kind, MAIN owns the URL — the http(s)-only open-external is never loosened"

key-files:
  created:
    - src/core/tcc-monitor.js
    - test/tcc-monitor.test.js
  modified:
    - main.js
    - preload.js
    - src/ui/main-window.js

key-decisions:
  - "onDisagreement fires on condition ENTRY only (entry-tracked flags) so a genuinely black screen warns once, not every 2s tick"
  - "Monitor trusts the capture loop's streak counter when provided, falls back to internal counting (tests stay bare-node)"
  - "recordMicFailure at the speechService 'error' emit site; recordMicRecovered at the 'recording-started' emit site"
  - "index.html untouched — the lu-* recovery classes + the 05-02 sanitize stack already cover the banner shell"
  - "perm-banner-stack flex container so simultaneous screen+mic banners stack instead of overlapping"

patterns-established:
  - "Signal-fusion monitors live pure in src/core/* with injected status getters; main.js wires Electron events into checkNow(reason)"

requirements-completed: [SEC-02]

# Metrics
duration-minutes: 20
completed: 2026-07-17
---

# Phase 05 Plan 04: TCC Permission-Loss Detection & Guided Recovery Summary

**Pure cross-check monitor fuses the 05-01 black-frame streak with `getMediaAccessStatus` (both required, per the locked decision) into transition-only `permission-status` broadcasts that raise inline overlay banners deep-linking to the exact System Settings pane with one-click relaunch — event-driven re-checks only, macOS-only, degrade-never-crash.**

## What Was Built

### Task 1 — Pure tcc-monitor (TDD)
`src/core/tcc-monitor.js` — pure CommonJS, zero Electron imports, wake-rewarm-shaped factory DI:
- `createTccMonitor({ getScreenStatus, getMicStatus, onStateChange, onDisagreement, blackStreakThreshold = 3, platform })` → `{ recordFrameStats, recordMicFailure, recordMicRecovered, checkNow, getState }`
- **Screen loss** = streak ≥ threshold AND status ≠ 'granted' (evaluated on every frame + every checkNow); **recovery** = status 'granted' AND an actual non-black frame arrived (sticky-lost hysteresis)
- **Mic loss** = sticky recorded failure AND status ≠ 'granted'; recovery = granted + `recordMicRecovered()`
- **Transition-only** emission (state-equality guard before `onStateChange`); disagreements (black+granted, status-only-denied, mic-failure+granted) fire `onDisagreement` once per condition entry — greppable without per-tick spam
- `platform !== 'darwin'` ⇒ all methods inert; every injected callback try/caught

12 node:test cases (RED a68e219 → GREEN 5f44999): loss at exactly 3, granted-status veto + disagreement `{kind:'screen', streak:3, status:'granted'}`, streak reset, no re-emission while lost + checkNow-driven recovery exactly once, mic both-required cross-check, mic recovery, startup status-only warn (streak 0), non-darwin inertness, throwing-listener safety, threshold param, seam streak trust.

### Task 2 — main.js integration + recovery IPC (bf88c9a)
- `_registerTccMonitor()` armed early in onAppReady (beside `_registerCaptureLifecycle`): status getters wrap `systemPreferences.getMediaAccessStatus('screen'|'microphone')` (try/catch → 'unknown'); `onStateChange` → warn-log + `broadcastToAllWindows('permission-status', state)`; `onDisagreement` → warn-log
- Event-driven signals, NO polling timer: `checkNow('startup')` at the end of onAppReady; `captureService.setFrameStatsListener(...)` (the 05-01 seam) → `recordFrameStats`; `app.on('browser-window-focus')` → `checkNow('focus')`; `checkNow('resume')` alongside (not inside) the wake-rewarm call in `_setupPowerMonitor`
- Mic signals: `recordMicFailure()` in the `speechService.on('error')` handler (the speech-error broadcast site); `recordMicRecovered()` in the `recording-started` handler
- `open-privacy-settings` IPC: ENUM-only (`screen`|`microphone`) → x-apple pane URL mapped in MAIN (`?Privacy_ScreenCapture` / `?Privacy_Microphone`), falls back to the Privacy & Security root on failure — `open-external` stays http(s)-only, diff-clean
- `relaunch-app` IPC: `app.relaunch(); app.exit(0)`
- preload: `openPrivacySettings(kind)`, `relaunchApp()`, `onPermissionStatus(cb)` (receive-only)

### Task 3 — Inline permission banner (c2d3f38)
`src/ui/main-window.js` mirrors the `showLocalUnavailable` idiom exactly:
- `handlePermissionStatus(state)` subscribed via `onPermissionStatus` (guarded): per-kind show on 'lost', hide on 'ok'
- `showPermissionBanner(kind)`: sanitized button-free shell (`window.sanitizeHtml`, 05-02 policy strips `<button>`/`style=`) + createElement'd buttons post-assignment; reuses the lu-* classes; ids `perm-banner-screen`/`perm-banner-mic`; re-show replaces
- Screen variant: "Screen access lost" + [Open System Settings → `openPrivacySettings('screen')`] [Relaunch app → `relaunchApp()`] [Dismiss]; mic variant: "Microphone access lost" + [Open System Settings → `openPrivacySettings('microphone')`] [Dismiss] (no relaunch needed for mic)
- `perm-banner-stack` fixed flex column so simultaneous banners never overlap; inline + dismissible, NEVER modal, no alert/setInterval; app fully usable behind it
- index.html untouched (plan allowed skipping when lu-* classes suffice — they did)

## IPC surface changes (for the 05-05 channel→audience table)

| Channel | Direction | Kind | Audience (suggested) | Notes |
|---|---|---|---|---|
| `open-privacy-settings` | renderer → main | `ipcMain.handle` (plain — 05-05 wraps in the guard) | `main` | enum-only; URL mapping lives in MAIN |
| `relaunch-app` | renderer → main | `ipcMain.handle` (plain — 05-05 wraps in the guard) | `main` | `app.relaunch()+exit(0)` |
| `permission-status` | main → renderers | `broadcastToAllWindows` (outbound — NOT gated per locked SEC-03 scope) | receive-only | transition-only `{screen, mic, reason}` |

## Verification Results

| Check | Result |
|---|---|
| `node --test test/tcc-monitor.test.js` | 12/12 pass |
| `npx eslint src/core/tcc-monitor.js test/tcc-monitor.test.js` + `make lint` | exit 0 |
| `make run_tests` | 183/183 pass (171 pre-plan + 12 new) |
| Headless boot (LOG_LEVEL=debug, 2×) | 0 uncaught/unhandled; `TCC permission monitor registered` + `Continuous capture started` in log |
| Grep chain | setFrameStatsListener → recordFrameStats → `permission-status` broadcast → onPermissionStatus → showPermissionBanner → openPrivacySettings/relaunchApp — all links present |
| `open-external` handler | diff-clean (no hunk touches it; only a comment in the NEW handler references the name) |
| No polling timers | `setInterval` count 0 in tcc-monitor.js and the new main.js/main-window.js code |
| Transition-only guard | state-equality check before onStateChange (tcc-monitor.js:137) |
| Live revoke/re-grant | ATTENDED — deferred to the 05-06 gate per plan |

## Deviations from Plan

None - plan executed exactly as written. Environment notes (not code deviations):
- macOS has no `timeout` binary → headless-boot verify used the 05-01 spawn+sleep+kill pattern (same check, same evidence).
- Discovered during teardown: the stealth `process.title = "Terminal "` rename hides the MAIN process from `pkill -f`, so a stale instance can block the next boot via the single-instance lock. Documented in MEMORY.md; the second boot's short log was this artifact, and a clean third boot verified green.
- index.html listed in the plan frontmatter but intentionally unchanged — the plan's own condition ("ONLY if the lu-panel classes don't cover it") resolved to no-change.

## Known Stubs

None. Both banners are fully wired to live IPC; the monitor is fed by the live capture loop and speech events. The only untested-live path is the actual macOS revoke → banner round-trip, which is the attended 05-06 gate (System Settings interaction cannot be automated).

## Commits

| Task | Commit | Message |
|---|---|---|
| 1 (RED) | a68e219 | test(05-04): add failing tests for TCC cross-check monitor |
| 1 (GREEN) | 5f44999 | feat(05-04): pure TCC cross-check monitor |
| 2 | bf88c9a | feat(05-04): TCC monitor integration + privacy-settings/relaunch IPC |
| 3 | c2d3f38 | feat(05-04): permission-loss recovery banner |

## Self-Check: PASSED
