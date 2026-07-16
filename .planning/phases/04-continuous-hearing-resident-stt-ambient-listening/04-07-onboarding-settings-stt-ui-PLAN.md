---
phase: 04-continuous-hearing-resident-stt-ambient-listening
plan: 07
type: execute
wave: 3
depends_on: ["04-03"]
files_modified:
  - onboarding.js
  - onboarding.html
  - settings.html
  - src/ui/settings-window.js
autonomous: true

must_haves:
  truths:
    - "The onboarding STT step no longer calls the removed Python detectWhisper()/installWhisper() bridges — it checks the resident whisper.cpp engine via getWhisperStatus and auto-downloads ggml-small.en with visible progress (STT-02/SC2)"
    - "The first-run model download renders the structured {percent, downloadedBytes, totalBytes} progress from the reused install-progress channel (not raw log lines) and downloads small.en (not turbo)"
    - "Settings exposes a local-whisper status/model/repair panel (engine status via getWhisperStatus, model present/missing → download, one-click whisper-recover) mirroring the Phase-3 minimal switcher"
    - "The Azure onboarding card + settings azure|whisper dropdown + azure fields remain IN PLACE (prove-then-remove; 04-09 removes them holistically)"
  artifacts:
    - path: "onboarding.js"
      provides: "STT step rewired to getWhisperStatus presence check + downloadWhisperModel('small.en') with structured install-progress; Python detect/install callers + .venv-whisper hints + whisperCmd persistence removed"
      contains: "getWhisperStatus"
    - path: "onboarding.html"
      provides: "STT step copy for the resident whisper.cpp engine + a ggml-small.en download progress bar (venv/turbo copy removed); Azure card left in place"
      contains: "small.en"
    - path: "settings.html"
      provides: "Local-whisper status/model/repair panel markup (status line + download/repair buttons + log); azure|whisper dropdown + azure/whisper-CLI fields left in place for 04-09"
      contains: "whisperStatus"
    - path: "src/ui/settings-window.js"
      provides: "Whisper status/model/repair wiring via getWhisperStatus + downloadWhisperModel + recoverWhisper, with a periodic status refresh (mirror refreshModelStatus)"
      contains: "getWhisperStatus"
  key_links:
    - from: "onboarding.js"
      to: "main.js get-whisper-status + download-whisper-model IPC"
      via: "window.electronAPI.getWhisperStatus() presence check + downloadWhisperModel('small.en') streaming structured install-progress"
      pattern: "getWhisperStatus|downloadWhisperModel"
    - from: "src/ui/settings-window.js"
      to: "main.js get-whisper-status + whisper-recover IPC"
      via: "getWhisperStatus() status line + recoverWhisper() one-click repair (mirror getModelStatus/recoverModel)"
      pattern: "getWhisperStatus|recoverWhisper"
---

<objective>
Collapse the onboarding + settings STT UI onto the resident whisper.cpp engine. In onboarding, swap the Python `detectWhisper()`/`installWhisper()` calls (whose IPC + preload bridges 04-03 already deleted) for a whisper.cpp engine-presence check via `getWhisperStatus` plus an auto-download of `ggml-small.en` using the existing `install-progress` streaming UI (now carrying structured `{percent, downloadedBytes, totalBytes}`), and drop the `.venv-whisper` copy hints. In settings, add a local-whisper **status / model / repair** panel that mirrors the Phase-3 model "minimal switcher" (engine status via `getWhisperStatus`, model present/missing → download, one-click `recoverWhisper`).

Purpose: STT-02/SC2 — the first-run model download shows visible, resumable progress, and the STT UX stops referencing the deleted Python path. This is the renderer-side companion to 04-03's IPC rewire; it removes the now-dangling detect/install callers so the wizard boots clean.
Output: rewired `onboarding.js` + `onboarding.html`, a settings whisper status/model/repair panel in `settings.html` + `src/ui/settings-window.js`.

PROVE-THEN-REMOVE boundary (consistency with 04-01/04-03): LEAVE the Azure onboarding choice-card, the settings `azure|whisper` provider dropdown, and the Azure fields IN PLACE here. 04-09 removes all Azure UI holistically behind the hard checkpoint once the resident engine is proven (04-08). 04-07 only *adds/rewires* the whisper.cpp UX alongside them — which is exactly why 04-07 (wave 3) and 04-09 (wave 7) can both edit `onboarding.*`/`settings.*` safely: different, non-concurrent waves.
</objective>

<execution_context>
@~/.claude/get-shit-done/workflows/execute-plan.md
@~/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/phases/04-continuous-hearing-resident-stt-ambient-listening/04-CONTEXT.md
@.planning/phases/04-continuous-hearing-resident-stt-ambient-listening/04-RESEARCH.md
@.planning/phases/04-continuous-hearing-resident-stt-ambient-listening/04-03-SUMMARY.md

# Live seams (verified 2026-07-16):
@onboarding.js
@onboarding.html
@settings.html
@src/ui/settings-window.js
@preload.js
</context>

<tasks>

<task type="auto">
  <name>Task 1: Onboarding STT step — engine-presence check + ggml-small.en download</name>
  <files>onboarding.js, onboarding.html</files>
  <action>
04-03 deleted the `detect-whisper`/`install-whisper` IPC + their preload bridges and rewired `download-whisper-model` → the 04-02 ggml downloader (streaming structured `{percent, downloadedBytes, totalBytes}` over the SAME `install-progress` channel). So `window.electronAPI.detectWhisper`/`.installWhisper` no longer exist; `downloadWhisperModel` + `onInstallProgress` remain (now ggml); `getWhisperStatus`/`recoverWhisper` are new. Rewire the onboarding renderer to match.

onboarding.js (verified lines):
- **Whisper screen → engine-presence check.** Replace `runWhisperDetect` (`:210-230`, calls `window.electronAPI.detectWhisper()`) with an engine check that calls `await window.electronAPI.getWhisperStatus()` and reads `{ binaryPresent, modelPresent, serverUp }`. Show "Voice engine ready" when `binaryPresent` (the whisper-server binary is built at package/dev time — no user install step); if the binary is somehow missing, show an actionable "voice engine missing — reinstall the app / rebuild" message (no crash). Set `state.whisperDetected = !!binaryPresent`. DELETE `runWhisperInstall` (`:232-292`), `addManualInstallButton` + the `installWhisperBtn` wiring (`:760-778`), and the `state.whisperCmd`/`whisperCommand` persistence (`:48-51`, `:662-664`, `:677-681`, and the `whisperCmd` usage in `populateSummary` `:590-608`) — all tied to the deleted Python detect/install path. Keep the `state.skippingWhisper` skip affordance.
- **Whisper screen copy.** In `enterWhisperScreen` (`:296-337`) replace the venv hint object (title "create a project-local venv and install openai-whisper"; steps mentioning `.venv-whisper`, pip, `turbo` ~150 MB) with resident-engine copy: the whisper.cpp engine is bundled/built with the app; the only first-run step is downloading the `ggml-small.en` voice model (~488 MB), cached in app data, resumable, offline afterward. Drop the per-platform venv/python guidance.
- **Model-download screen → small.en + structured progress.** In `startModelDownload` (`:381-418`) change `downloadWhisperModel('turbo')` → `downloadWhisperModel('small.en')`. Replace the `onInstallProgress((line) => appendModelLog(line))` line-handler (`:388-392`) with a structured handler that renders `p.percent` into a progress bar and logs a human line (mirror the model-pull screen's `onModelPullProgress` handler `:538-551`): guard for a possibly-string payload defensively. Keep the friendly-failure "continue anyway, resumes on retry" behavior.
- Leave the Azure choice-card + `azurePanel` + `azureKey`/`azureRegion` handlers and the `speech`-screen azure persistence (`:652-666`) UNTOUCHED (04-09 removes them). Keep `canAdvance`'s azure branch (`:146-149`).

onboarding.html (verified lines):
- Whisper screen (`data-screen="whisper"`, `:841-867`): update the subtitle/detect-card copy to the engine-presence check wording; remove the venv `installList`/`installCardTitle` framing that implied a pip install (keep the `installLog` element if still used for status lines, or repurpose to an engine-status line). Do NOT touch the Azure choice-card (`:797-807`) or `azurePanel` (`:820-839`).
- Model-download screen (`data-screen="model-download"`, `:869-906`): retitle to the `ggml-small.en` voice-model download; ADD a progress-bar element (mirror the model-pull `modelPullBar`/`modelPullStatus` markup `:949-971`) that `startModelDownload` drives from `p.percent`. Keep `modelDownloadLog`.
Keep all conventions (the `assests/` misspelling, FontAwesome classes, existing class names). Degrade never crash — a missing bridge or status field must show a friendly message, not throw.
  </action>
  <verify>`npx eslint onboarding.js` clean. `grep -nE "detectWhisper\(|installWhisper\(|\.venv-whisper|installWhisperBtn|'turbo'|\"turbo\"" onboarding.js` returns NOTHING. `grep -nE "getWhisperStatus|downloadWhisperModel\('small.en'\)|small\.en" onboarding.js` shows the engine check + small.en download. `grep -n "azurePanel\|azureKey\|data-value=\"azure\"" onboarding.html` still shows the Azure card in place (prove-then-remove). `grep -n "small.en\|modelDownloadBar\|Voice engine" onboarding.html` shows the updated copy + progress bar. App boots and opens onboarding without throwing (real click-through deferred to the 04-08 gate).</verify>
  <done>Onboarding checks the resident whisper.cpp engine via getWhisperStatus and downloads ggml-small.en with a structured progress bar over install-progress; the Python detect/install callers, .venv-whisper hints, and whisperCmd persistence are gone; the Azure card is left in place.</done>
</task>

<task type="auto">
  <name>Task 2: Settings — local-whisper status / model / repair panel</name>
  <files>settings.html, src/ui/settings-window.js</files>
  <action>
Add a local-whisper status/model/repair panel that mirrors the Phase-3 AI-model-engine panel already in this file (status line + repair button + streamed log). This surfaces the resident engine's real health now that STT is the single local whisper engine.

settings.html (verified lines):
- ADD a whisper status/model/repair block near the speech section (`:384-449`). Mirror the model-status markup pattern (`getModelStatus`/`repairModelBtn`/`modelStatusLog`, `:461-...`): a `#whisperStatus` status line, a `#whisperRepairBtn` ("Download / repair voice model"), and a `#whisperStatusLog`. This is the local-whisper equivalent of the Local-model status panel.
- LEAVE the existing `#speechProvider` dropdown with its `azure`/`whisper` options (`:386-390`), `#azureFields` (`:393-408`), `#azureFieldsNote` (`:447-449`), and the `#whisperFields` CLI inputs (`:411-445`) IN PLACE — 04-09 removes the provider dropdown + azure fields + the dead Python CLI fields holistically when it collapses to the single engine. Note this in an HTML comment.

src/ui/settings-window.js (verified lines):
- ADD whisper-panel refs + wiring mirroring the model-status helpers (`renderStatusLine` `:250-259`, `refreshModelStatus` `:261-269`, `repairModelBtn` handler `:378-404`, `setInterval(refreshModelStatus, 8000)` `:493`):
  - `refreshWhisperStatus()` → `await window.electronAPI.getWhisperStatus()` → render a human line from the three-level health `{ binaryPresent, modelPresent, serverUp, responding }` (e.g. "engine up · model present · responding" / "voice model missing — download" / "engine not responding — repair"). Degrade to "Status unavailable" on error (never throw).
  - `#whisperRepairBtn` → if the model is missing, `window.electronAPI.downloadWhisperModel('small.en')` streaming `onInstallProgress` into `#whisperStatusLog`; otherwise `window.electronAPI.recoverWhisper()` (restart the owned server / re-probe). Re-`refreshWhisperStatus()` when done.
  - A light periodic `setInterval(refreshWhisperStatus, 8000)` while settings is open (mirror the model-status refresh).
- Do NOT remove or rewrite the existing `speechProviderSelect`/`azureKey`/`azureRegion`/`whisperCommand*` handlers (`:9-15`, `:88-144`, `:167-218`) — leave them for 04-09. Keep all logging/console patterns as-is.
Keep it vanilla + defensive (guard every `window.electronAPI` bridge with a presence check, as the file already does).
  </action>
  <verify>`npx eslint src/ui/settings-window.js` clean. `grep -n "getWhisperStatus\|recoverWhisper\|whisperRepairBtn\|refreshWhisperStatus" src/ui/settings-window.js` shows the new panel wiring. `grep -n "whisperStatus\|whisperRepairBtn\|whisperStatusLog" settings.html` shows the new markup. `grep -n "id=\"speechProvider\"\|id=\"azureFields\"" settings.html` still present (prove-then-remove). App opens the settings window without throwing; the whisper status line populates (or shows "Status unavailable" when the engine is absent — no crash). Full click-through deferred to 04-08.</verify>
  <done>Settings shows a local-whisper status/model/repair panel driven by getWhisperStatus + downloadWhisperModel('small.en') + recoverWhisper with a periodic refresh; the existing azure|whisper dropdown + azure/CLI fields are left in place for 04-09.</done>
</task>

</tasks>

<verification>
- `make run_tests` green; `make lint` exits 0.
- No `detectWhisper(`, `installWhisper(`, `.venv-whisper`, `installWhisperBtn`, or `'turbo'` references remain in onboarding.js.
- Onboarding calls `getWhisperStatus` for engine presence and `downloadWhisperModel('small.en')` with a structured progress bar over `install-progress`.
- Settings has a `getWhisperStatus`/`recoverWhisper`-driven whisper status/model/repair panel; the Azure dropdown + fields remain (removed by 04-09).
- App boots and opens onboarding + settings without throwing when the engine/model are absent (degrade, never crash).
</verification>

<success_criteria>
- STT-02/SC2 UX: first-run onboarding checks the resident whisper.cpp engine and downloads ggml-small.en with visible, structured, resumable progress; the deleted Python detect/install/venv references are gone.
- Settings surfaces the single local whisper engine's status + one-click model download / repair (Phase-3 minimal-switcher mirror).
- Azure onboarding/settings UI is preserved for prove-then-remove (04-09 removes it holistically).
</success_criteria>

<output>
After completion, create `.planning/phases/04-continuous-hearing-resident-stt-ambient-listening/04-07-SUMMARY.md`
</output>
