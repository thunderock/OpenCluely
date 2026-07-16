---
phase: 04-continuous-hearing-resident-stt-ambient-listening
plan: 07
subsystem: ui
tags: [onboarding, settings, whisper, whisper-server, stt, renderer, install-progress, degrade-never-crash, prove-then-remove]

# Dependency graph
requires:
  - phase: 04-03
    provides: "get-whisper-status + whisper-recover IPC (+ preload getWhisperStatus/recoverWhisper); download-whisper-model rewired to the 04-02 ggml downloader streaming structured {percent,downloadedBytes,totalBytes} over install-progress; detect-whisper/install-whisper bridges deleted"
  - phase: 04-02
    provides: "WhisperModelDownloader (resumable ggml-small.en → {ok,path}/{ok:false,reason,message}) behind download-whisper-model"
  - phase: 04-01
    provides: "WhisperServerManager.getStatus({probeResponding}) → {binaryPresent,modelPresent,serverUp,responding,state,pid}"
  - phase: 03
    provides: "settings AI-model status/model/repair panel + refreshModelStatus/renderStatusLine/repairModelBtn pattern; onboarding ollama/model-pull progress-bar plumbing"
provides:
  - "Onboarding STT step rewired: getWhisperStatus() binary-presence check (no Python detect/install), ggml-small.en download (was turbo) with a structured percent progress bar over install-progress (STT-02/SC2)"
  - "Onboarding no longer references the deleted Python path — detectWhisper()/installWhisper()/.venv-whisper/installWhisperBtn/whisperCmd persistence all removed; skip affordance kept"
  - "Settings gains a local-whisper status/model/repair panel (getWhisperStatus health line + one-click download-if-missing / recoverWhisper, periodic 8s refresh) mirroring the Phase-3 minimal switcher"
  - "Azure onboarding card + settings azure|whisper dropdown + azure/CLI fields LEFT IN PLACE (prove-then-remove; 04-09)"
affects:
  - "04-08 (validation gate): the real onboarding click-through + first-run ggml-small.en download-with-progress + settings repair are validated live here"
  - "04-09 (azure removal): removes the still-present Azure onboarding card + settings speechProvider dropdown + azureFields + dead whisper-CLI fields holistically; also absorbs the env.example stale-Python seed (re-deferred from 04-07, see deferred-items.md)"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Renderer engine-presence check: onboarding reads getWhisperStatus().binaryPresent (the whisper.cpp binary ships built with the app — there is NO user install step) instead of probing a Python CLI"
    - "Structured install-progress consumption in the renderer: onInstallProgress returns an unsubscribe fn; the handler renders p.percent into a progress-fill bar + a human MB line, guarding defensively for a legacy string payload"
    - "Settings whisper panel mirrors the Phase-3 model panel 1:1 (renderWhisperStatusLine / refreshWhisperStatus / appendWhisperLog / setInterval 8s) — every window.electronAPI bridge presence-guarded, degrade to 'Status unavailable' never throw"
    - "Repair button chooses download-vs-repair from live health: binaryPresent && !modelPresent → downloadWhisperModel('small.en'); else recoverWhisper() (restart owned server) — success detected via r.ok || r.serverUp since start() returns a status object, not {ok}"

key-files:
  created: []
  modified:
    - onboarding.js
    - onboarding.html
    - settings.html
    - src/ui/settings-window.js

key-decisions:
  - "Repurposed the existing whisper-screen detect-row/install-card DOM (detectCmd/detectStatus/installCardTitle/installList/installLog) for the engine-presence check + resident-engine copy rather than adding new elements — minimal diff, same look"
  - "Onboarding model-download drives p.percent into a new #modelDownloadBar (mirroring the model-pull #modelPullBar markup) via the unsubscribe-returning onInstallProgress; kept the friendly-failure 'continue anyway, resumes on retry' behavior"
  - "Settings refreshWhisperStatus passes { probeResponding: true } so the 4th health level (responding) is meaningful (getStatus only probes it on request); onboarding's engine check passes no opts (binaryPresent is a sync check — no need to probe)"
  - "Deleted the now-dead quoteCommandIfNeeded helper + state.whisperCmd + whisperCommand persistence (both nextBtn save sites) — all tied to the removed Python CLI path — keeping the file eslint-clean (no-unused-vars)"
  - "env.example (repo-root, pre-assigned to 04-07 by 04-03's deferred log) left untouched and re-deferred to 04-09 — it is outside this plan's declared files_modified + the orchestrator-granted renderer/onboarding/settings scope, and is inert (nothing reads WHISPER_COMMAND/WHISPER_MODEL_DIR)"

patterns-established:
  - "Renderer degrade-never-crash: a missing/throwing getWhisperStatus bridge yields a friendly 'Status unavailable' / 'Could not check the voice engine' line, proven by a vm-sandbox renderer-load smoke"
  - "Prove-then-remove UI coexistence: 04-07 ADDS the whisper.cpp UX alongside the still-present Azure UI; an HTML comment marks the exact block 04-09 will remove"

# Metrics
duration: 11min
completed: 2026-07-16
---

# Phase 4 Plan 7: Onboarding + Settings STT UI Summary

**Collapsed the onboarding + settings STT UI onto the resident whisper.cpp engine: onboarding now checks the built-in engine via `getWhisperStatus()` and downloads `ggml-small.en` (was `turbo`) with a structured percent progress bar over `install-progress`, and settings gained a local-whisper status/model/repair panel — while the Azure UI is left in place for 04-09's holistic removal.**

## Performance

- **Duration:** 11 min
- **Started:** 2026-07-16T17:12:07Z
- **Completed:** 2026-07-16T17:23:34Z
- **Tasks:** 2
- **Files modified:** 4 (all modified)

## Accomplishments
- **STT-02/SC2 onboarding rewired (`onboarding.js` + `onboarding.html`):** the whisper screen calls `window.electronAPI.getWhisperStatus()` and reads `binaryPresent` (the whisper.cpp binary is built with the app — no user install step), showing "Voice engine ready" or an actionable "engine missing — reinstall/rebuild" line; `state.whisperDetected = !!binaryPresent`. The model-download screen now calls `downloadWhisperModel('small.en')` and renders the structured `{percent, downloadedBytes, totalBytes}` into a new `#modelDownloadBar` progress bar + a human MB log line (not raw log lines), keeping the friendly "continue anyway, resumes on retry" failure path.
- **Deleted Python path gone from the renderer:** `runWhisperDetect`/`detectWhisper()`, `runWhisperInstall`/`installWhisper()`, `addManualInstallButton`/`installWhisperBtn`, the per-platform `.venv-whisper`/pip/`turbo` hint object, `state.whisperCmd` + `whisperCommand` persistence (both save sites), and the now-unused `quoteCommandIfNeeded` helper — all removed. The `state.skippingWhisper` skip affordance is preserved.
- **Settings local-whisper panel (`settings.html` + `src/ui/settings-window.js`):** a `#whisperStatus` health line (via `getWhisperStatus({probeResponding:true})` → "Engine up · model present · responding" / "Voice model missing — download it" / "Engine not responding — repair" / degrade "Status unavailable"), a `#whisperRepairBtn` that downloads `ggml-small.en` if missing else `recoverWhisper()`, a `#whisperStatusLog` streaming structured `install-progress`, and a light periodic 8s refresh — mirroring the Phase-3 model panel exactly.
- **Prove-then-remove honored:** the Azure onboarding choice-card + `azurePanel`, and the settings `#speechProvider` azure|whisper dropdown + `#azureFields` + `#azureFieldsNote` + the dead `#whisperFields` CLI inputs, are all LEFT IN PLACE (an HTML comment marks the exact block 04-09 removes).
- **Gates green:** `npx eslint` clean on both JS files; `make lint` exit 0; `make run_tests` 116/116; a vm-sandbox renderer-load smoke proves both scripts execute their top-level wiring with NO throw, `#whisperStatus` renders correctly, and a throwing bridge degrades to "Status unavailable" (no crash).

## Task Commits

Each task was committed atomically with an explicit pathspec (shared branch — a concurrent 04-04 sibling owns `main.js`/`speech.service.js`/`session.manager.js`):

1. **Task 1: Onboarding STT step — engine-presence check + ggml-small.en download** — `f84685c` (feat) — `onboarding.js`, `onboarding.html`
2. **Task 2: Settings — local-whisper status/model/repair panel** — `20d407d` (feat) — `settings.html`, `src/ui/settings-window.js`

**Plan metadata:** _(final docs commit — see git log)_

## Files Created/Modified
- `onboarding.js` (modified, −186/+105) — `runWhisperDetect`/`runWhisperInstall` replaced by `runWhisperEngineCheck` (getWhisperStatus presence check); `enterWhisperScreen` resident-engine copy (no venv/pip); `startModelDownload` → `small.en` + structured progress bar via the unsubscribe-returning `onInstallProgress`; `whisperCmd`/`quoteCommandIfNeeded`/manual-install button + persistence removed; Azure path untouched.
- `onboarding.html` (modified) — whisper screen retitled "Local Voice Engine" with engine-presence copy ("Voice engine" label); model-download screen retitled to the `ggml-small.en` voice-model download + a new `#modelDownloadBar`/`#modelDownloadStatus` progress card; Azure choice-card + `azurePanel` untouched.
- `settings.html` (modified) — new `#whisperStatus` / `#whisperRepairBtn` / `#whisperStatusLog` panel in the Speech section (HTML-commented as the 04-09 removal boundary); `#speechProvider` dropdown + `#azureFields` + `#whisperFields` CLI inputs left in place.
- `src/ui/settings-window.js` (modified, +~97) — `whisperStatus`/`whisperRepairBtn`/`whisperStatusLog` refs; `renderWhisperStatusLine`/`refreshWhisperStatus`/`appendWhisperLog`/`formatWhisperProgress` helpers; repair-button handler (download-if-missing / else recoverWhisper, streaming install-progress); `refreshWhisperStatus()` in `loadSettingsIntoUI` + a `setInterval(…, 8000)`; existing speech/azure/CLI + model handlers untouched.

## Decisions Made
- **Repurposed existing whisper-screen DOM** (detect-row/install-card/install-log) for the engine check + resident copy rather than adding new elements — minimal diff, consistent look, keeps `installList`/`installCardTitle`/`installLog` in use (no eslint dead refs).
- **`{ probeResponding: true }` from settings only** — `getStatus` probes the level-4 "responding" HTTP check only on request; onboarding's binary-presence check skips it (sync check, faster).
- **Repair success detection via `r.ok || r.serverUp`** — `downloadWhisperModel` returns `{ok,path}` but `recoverWhisper()` (restart) returns a status object (`{binaryPresent,…,serverUp}`) with no `ok`, so the handler treats `serverUp` as success on the restart path.
- **env.example left untouched, re-deferred to 04-09** — see Issues Encountered.

## Deviations from Plan

None — the plan executed exactly as written: both `type="auto"` tasks, the four declared `files_modified` (`onboarding.js`, `onboarding.html`, `settings.html`, `src/ui/settings-window.js`), no checkpoints, no deviation-rule auto-fixes required. All work stayed inside the plan's declared file scope; no `main.js`/`speech.service.js` edits (sibling territory).

## Issues Encountered
- **env.example stale-Python seed — pre-assigned to 04-07 by 04-03's deferred log, but declined + re-deferred to 04-09.** 04-03's `deferred-items.md` note said 04-07 should also update `env.example` (drop `WHISPER_COMMAND`/`WHISPER_MODEL_DIR`/venv/pip/`turbo`). It is NOT in this plan's `files_modified`, NOT in the renderer/onboarding/settings file scope the orchestrator explicitly granted, and is inert (nothing reads those keys — the resident `WhisperServerManager` reads `config.speech.whisper.model = small.en`). Per the executor SCOPE BOUNDARY (pre-existing, not task-caused → log, don't fix), it was left untouched and the `deferred-items.md` entry was updated with a disposition note re-assigning it to **04-09** (which must already edit `env.example` to remove the Azure seed lines — the whisper-Python seed rides along). 04-07 DID complete the renderer-side venv/Python removal (onboarding no longer persists `whisperCommand`).
- **Shared branch with a concurrent 04-04 executor.** `main.js`/`session.manager.js`/`speech.service.js` were modified/staged in the shared index by the sibling during execution; every 04-07 commit used an explicit pathspec (`git commit -m … -- <my files>`) so none of the sibling's files were swept in (verified: each commit contains only its two intended files).
- **Live click-through deferred (per plan).** No jsdom in the repo, and a full electron boot would exercise the sibling's in-flight `main.js`; substituted a `vm`-sandbox renderer-load smoke (both scripts load without throwing; `#whisperStatus` renders "Voice model missing — download it" from a fake three-level status; a throwing bridge degrades to "Status unavailable"). The real onboarding click-through + first-run `ggml-small.en` download-with-progress + settings repair are validated at the **04-08** gate.

## User Setup Required
None - no external service configuration required. (The real ~488 MB `ggml-small.en` download happens at onboarding / the 04-08 validation gate.)

## Next Phase Readiness
- **04-08 (validation gate):** onboarding now boots clean (no dead Python bridges) and the first-run download shows visible structured progress — ready for the real click-through + live model download.
- **04-09 (azure removal):** the Azure onboarding card + settings `speechProvider` dropdown + `azureFields`/`azureFieldsNote` + dead `whisperFields` CLI inputs are intact and clearly HTML-commented as the removal boundary; `env.example`'s stale Azure + whisper-Python seed is now assigned here too (deferred-items.md).
- **Concern:** the visual/functional correctness of the new progress bar + status panel is WIRING-proven only (renderer-load smoke) — the real GUI verification is the 04-08 gate, as the plan mandates.

---
*Phase: 04-continuous-hearing-resident-stt-ambient-listening*
*Completed: 2026-07-16*

## Self-Check: PASSED

- FOUND: onboarding.js
- FOUND: onboarding.html
- FOUND: settings.html
- FOUND: src/ui/settings-window.js
- FOUND: .planning/phases/04-.../04-07-SUMMARY.md
- FOUND: commit f84685c (Task 1, feat — onboarding engine-presence + ggml-small.en download)
- FOUND: commit 20d407d (Task 2, feat — settings whisper status/model/repair panel)
- CONFIRMED: each commit contains ONLY its two intended files (no main.js/speech.service.js/session.manager.js swept in from the concurrent 04-04 sibling)
- GATES: npx eslint clean (onboarding.js + settings-window.js); make lint exit 0; make run_tests 116/116; renderer-load vm smoke PASS (no throw + #whisperStatus renders + degrade path)
