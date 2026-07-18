---
phase: 05-continuous-capture-notes-hardening
plan: 01
subsystem: capture
tags: [continuous-capture, dhash, dedup, powermonitor, electron, desktopCapturer]

# Dependency graph
requires: []
provides:
  - "Continuous 2s screen-capture loop holding latestFrame (JPEG q80, ~1280px long edge) for Phase 6 to pull"
  - "captureService.getLatestFrame() / getBlackStreak() / setFrameStatsListener() — Phase-6 + SEC-02 seams"
  - "src/core/frame-dedup.js pure dHash/hamming/blackStats (node:test covered)"
  - "config.capture block (intervalMs/longEdgePx/dedupThreshold/jpegQuality, env-overridable)"
affects:
  - "05-04 (SEC-02 TCC) consumes getBlackStreak()/setFrameStatsListener()"
  - "Phase 6 orchestrator pulls getLatestFrame() at pause time"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Capture-at-target: desktopCapturer thumbnailSize computed from primary display size x scale — never full-res + resize"
    - "display_id source matching (size heuristic breaks under downscaled thumbnails)"
    - "Perceptual dedup: 17x16 luma -> 256-bit dHash, hamming <= threshold => hash-only tick, no encode"
    - "Pure math in src/core/* under node:test; Electron wiring stays in the service (vad-segmenter idiom)"

key-files:
  created:
    - src/core/frame-dedup.js
    - test/frame-dedup.test.js
  modified:
    - src/services/capture.service.js
    - src/core/config.js
    - main.js

key-decisions:
  - "JPEG q80 for the held frame (vision-model input: ~5-10x smaller base64 than PNG at legible quality)"
  - "Loop start mirrors ambient listening: onAppReady when first-run complete, re-invoked on complete-first-run, skipped during onboarding"
  - "Loop yields to the single-shot path (skips its tick when isProcessing) via its own _loopBusy re-entrancy flag"
  - "powerMonitor lock-screen/suspend pause + unlock-screen/resume resume registered EARLY in onAppReady, each callback try/caught"

patterns-established:
  - "Continuous-loop services expose start/stop (timer lifecycle) + pause/resume (state flag) separately"

requirements-completed: [CONT-04]

# Metrics
duration-minutes: 12
completed: 2026-07-17
---

# Phase 05 Plan 01: Continuous Capture Loop Summary

**2s hold-latest capture loop: primary display captured directly at ~1280px via thumbnailSize, 256-bit dHash dedup makes idle ticks hash-only (no encode), JPEG-q80 latestFrame + metadata held for Phase 6; pauses on lock/sleep via powerMonitor.**

## What Was Built

### Task 1 — Pure frame-dedup module (TDD)
`src/core/frame-dedup.js` — pure CommonJS, zero Electron/fs imports:
- `grayscaleFromBgra(buffer, w, h)` — BGRA (Electron `toBitmap()` on macOS) → luma via ITU-R 601 weights
- `dhash(luma, 16, 16)` — difference hash over a 17x16 luma grid → 32-byte MSB-packed Buffer
- `hamming(a, b)` — popcount distance; TypeError on length mismatch
- `blackStats(luma)` — mean/variance, the SEC-02 all-black-frame signal

8 node:test cases (RED 128758c → GREEN 29960c5): BGRA byte order, hash determinism + 32-byte length, self-distance 0, large-region change > 10 bits, single-pixel noise ≤ 2 bits (cursor-blink tolerance), length-mismatch TypeError, all-zero stats, checkerboard variance > 1000.

### Task 2 — Continuous capture loop (81adb8c)
`config.capture`: `intervalMs` 2000 / `longEdgePx` 1280 / `dedupThreshold` 10 / `jpegQuality` 80, each env-overridable (`CAPTURE_*`).

`capture.service.js` gains (single-shot `captureAndProcess`/`captureScreenshot` byte-identical — verified by diff hunks):
- `startContinuousCapture()` (idempotent) / `stopContinuousCapture()` / `pauseContinuousCapture()` / `resumeContinuousCapture()`
- `getLatestFrame()` → `{ buffer, mimeType: 'image/jpeg', timestamp, hash (hex), dimensions }` or null
- `getBlackStreak()` + `setFrameStatsListener(fn)` — SEC-02 seams; listener fires `{ isBlack, streak }` per captured tick
- `_captureDownscaled()` — primary display only, thumbnailSize at target scale, `display_id === String(display.id)` matching
- `_tick()` — skips when `_paused || _loopBusy || isProcessing` (yields to single-shot); black-stats + dHash; unchanged frame (hamming ≤ threshold) → debug-log + return with NO encode; changed frame → refresh `latestFrame`

### Task 3 — main.js lifecycle wiring (2c2a8c9)
- `_ensureContinuousCapture(reason)` — mirrors `_ensureAmbientListening`: try/caught, skips (debug-log) during onboarding; called in onAppReady beside the ambient start and re-invoked in the `complete-first-run` handler
- `_registerCaptureLifecycle()` — armed early in onAppReady beside `_setupPowerMonitor()`, guarded by `_captureLifecycleArmed`; `lock-screen`/`suspend` → pause, `unlock-screen`/`resume` → resume, every callback body try/caught
- `onWillQuit` → `captureService.stopContinuousCapture()` (fire-and-forget)

## Verification Results

| Check | Result |
|---|---|
| `node --test test/frame-dedup.test.js` | 8/8 pass |
| `make run_tests` | 163/163 pass |
| `make lint` (`npx eslint .`) | exit 0 |
| Headless boot (25s, LOG_LEVEL=debug) | zero uncaught/unhandled; log shows `Continuous capture started`, then live 2s ticks alternating `frame refreshed` / `tick skipped (unchanged frame)` — dedup proven live |
| Single-shot path | diff hunks only at file top (requires/constructor) + appended methods; `captureAndProcess`/`captureScreenshot` untouched |
| Scope leaks | no OCR, no per-capture model calls, no battery throttle, no fs.watch |

## Deviations from Plan

None - plan executed exactly as written. (One environment note: `timeout` doesn't exist on macOS, so the headless-boot verify used background-spawn + sleep + pkill instead of the plan's `timeout 25 npx electron .` — same check, same evidence.)

## Known Stubs

None. `latestFrame` intentionally goes nowhere this phase (hold-latest; Phase 6 pulls) — that is the locked CONT-04 design, not a stub: the loop, dedup, pause/resume, and frame refresh are all live and verified in the boot log.

## Phase-6 / SEC-02 Seams (for downstream plans)

- `captureService.getLatestFrame()` — pull the newest frame at pause time (null until first capture)
- `captureService.getBlackStreak()` — consecutive all-black-frame count for the TCC cross-check
- `captureService.setFrameStatsListener(fn)` — per-captured-tick `{ isBlack, streak }` callback (05-04 wires this)

## Commits

| Task | Commit | Message |
|---|---|---|
| 1 (RED) | 128758c | test(05-01): add failing tests for frame-dedup pure math |
| 1 (GREEN) | 29960c5 | feat(05-01): add pure frame-dedup (dHash + black-frame stats) |
| 2 | 81adb8c | feat(05-01): continuous downscaled deduped capture loop |
| 3 | 2c2a8c9 | feat(05-01): capture loop lifecycle wiring (start post-onboarding, pause on lock/sleep) |

## Self-Check: PASSED

All 6 claimed files exist on disk; all 4 task commits (128758c, 29960c5, 81adb8c, 2c2a8c9) present in git log.
