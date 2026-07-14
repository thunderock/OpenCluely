---
phase: 03-local-engine-cloud-removal
plan: 05
subsystem: ui
tags: [settings, ollama, provider-selection, model-picker, ipc, electron-renderer, prov-06]

# Dependency graph
requires:
  - phase: 03-local-engine-cloud-removal (03-01)
    provides: config.llm = { provider (default 'local'), local.curatedModels, local.model }; LLM_PROVIDER/LOCAL_MODEL env reads
  - phase: 03-local-engine-cloud-removal (03-03)
    provides: registry selects per config.llm.provider (Local default, Gemini selectable); provider.testConnection()
  - phase: 03-local-engine-cloud-removal (03-04)
    provides: local IPC + preload bridges (getModelStatus, listInstalledModels, testProviderConnection, pullModel, onModelPullProgress)
provides:
  - Provider picker in settings (Local default, Gemini transitional) — PROV-06 user-facing half
  - Curated model dropdown (qwen3-vl:8b default, :30b, gemma3:4b/12b) + advanced "any installed" picker from live Ollama
  - Model status/health line (adopted-vs-owned + 3-level health), test-connection, and re-download/repair with streamed progress
  - getSettings surfaces provider/model/curatedModels; saveSettings persists LLM_PROVIDER + LOCAL_MODEL to .env (restart-to-apply)
affects: [03-07 (human-verify — this UI is proven on a real machine there), 03-08 (PROV-07 Gemini removal — provider picker + local IPC survive), phase-07 (CLI providers slot into the same switcher with no UI rework)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Renderer const-helper pattern extended (updateLocalModelFieldStates mirrors updateSpeechFieldStates; helpers defined once, referenced by load + handlers + interval)"
    - "Restart-to-apply .env persistence for provider/model (no live hot-swap — facade resolves provider at module load), consistent with the app's other .env-backed settings"
    - "install-log progress mirror: structured { status, percent } pull events appended to a scrollable log, reusing the whisper onboarding install-log visual"

key-files:
  created: []
  modified:
    - "settings.html — new 'AI Model' section (provider + curated/advanced model + status/test/repair) above Gemini Settings; install-log style"
    - "src/ui/settings-window.js — load/save/advanced-list/status/test/repair wiring + 8s light health refresh"
    - "main.js — getSettings surfaces provider/model/curatedModels; saveSettings persists LLM_PROVIDER + LOCAL_MODEL"

key-decisions:
  - "Provider switch is restart-to-apply (persist to .env, note on next launch) — the provider facade resolves the selected provider at module load, so a live hot-swap was deliberately NOT wired (matches stealth-name relaunch + speech-provider .env pattern)"
  - "Advanced model select stacked under the curated select in one settings-item (settings-stack), toggled on the __advanced__ sentinel — keeps a single toggle target and matches the whisper stacked-field layout"
  - "Model-status line renders adopted ('Using your running Ollama') vs owned ('Managed by OpenCluely') + serverUp/modelPresent/modelResponds, consumed directly from LocalModelManager.getStatus() shape (no new IPC)"
  - "Gemini kept as a selectable provider option (labelled 'being removed') and geminiKey left in getSettings — removed at PROV-07 (03-08), honoring never-removal-first"

patterns-established:
  - "Curated-vs-advanced classification: settings.curatedModels (from config) decides whether a saved model maps to the curated dropdown or the advanced 'any installed' select; DEFAULT_CURATED fallback covers pre-settings-load"
  - "Provider-neutral local bridges reused verbatim (pullModel/getModelStatus/listInstalledModels/testProviderConnection/onModelPullProgress) — the settings UI adds zero new IPC and survives PROV-07"

# Metrics
duration: 9min
completed: 2026-07-14
---

# Phase 3 Plan 05: Provider + Model Selection UI Summary

**Provider picker (Local default, Gemini transitional) + curated/advanced model picker with live-Ollama health, test-connection, and repair in settings; provider/model persisted to .env as restart-to-apply (PROV-06 user-facing half).**

## Performance

- **Duration:** 9 min
- **Started:** 2026-07-14T21:06:22Z
- **Completed:** 2026-07-14T21:15:18Z
- **Tasks:** 3
- **Files modified:** 3

## Accomplishments
- Added an "AI Model" settings section: Local (default) / Gemini provider picker, a curated model dropdown (qwen3-vl:8b default, qwen3-vl:30b, gemma3:4b, gemma3:12b) plus an advanced "any installed model" select populated from the running Ollama.
- Wired load/save for provider + model, live health status (adopted-vs-owned + serverUp/modelPresent/modelResponds), test-connection, and re-download/repair with streamed pull progress — all on the existing 03-04 bridges (zero new IPC).
- Surfaced provider/model/curatedModels in `getSettings()` and persisted `LLM_PROVIDER` + `LOCAL_MODEL` to `.env` in `saveSettings()`, so the selection survives restart and applies on next launch (facade resolves the provider at module load — no live hot-swap).
- Kept the minimal provider switcher so Phase 7's CLI providers slot in with no UI rework; Gemini stays selectable until PROV-07.

## Task Commits

Each task was committed atomically (explicit pathspec — parallel-safe with sibling plan 03-06):

1. **Task 1: Provider + Model + Model-status sections in settings.html** - `62e04e1` (feat)
2. **Task 2: Wire provider/model load, save, advanced-list, status, test in settings-window.js** - `fac8b85` (feat)
3. **Task 3: Surface + persist provider/model in main.js getSettings/saveSettings** - `787d976` (feat)

_Note: sibling 03-06 commit `d2f2194` interleaved between Task 2 and Task 3 on the same branch; each of the three commits above touched only this plan's files._

## Files Created/Modified
- `settings.html` - New "AI Model" settings-section above Gemini Settings: `#llmProvider` (Local/Gemini), `#localModelFields` wrapping curated `#localModel` + advanced `#localModelAdvanced`, `#testProviderBtn` + `#providerStatus`, `#modelStatus` + `#repairModelBtn` + `#modelStatusLog`; added an `install-log` style mirroring onboarding. Speech/Azure/Gemini sections untouched.
- `src/ui/settings-window.js` - Element refs + helpers (`updateLocalModelFieldStates`, `populateAdvancedModels`, `renderStatusLine`, `refreshModelStatus`, `appendModelLog`, `formatPullProgress`); load classifies curated-vs-advanced; save emits `provider`/`model`; provider/model change handlers; test-connection + repair (streams `onModelPullProgress`); 8s light health refresh.
- `main.js` - `getSettings()` returns `provider`/`model`/`curatedModels` from config; `saveSettings()` persists `LLM_PROVIDER` (local|gemini) + `LOCAL_MODEL` via `persistEnvUpdates`, with a meta-only `logger.info` and a restart-to-apply comment. Azure/whisper/Gemini-key plumbing untouched.

## Decisions Made
- **Restart-to-apply, not hot-swap:** provider/model are persisted to `.env` and applied on next launch (the facade resolves the provider at module load). A live provider hot-swap was deliberately not wired, matching the app's existing restart-to-apply settings (stealth-name relaunch, speech provider).
- **Advanced picker stacked under curated:** the advanced "any installed" select sits in the same `settings-item` (settings-stack) as the curated dropdown and is toggled on the `__advanced__` sentinel — a single toggle target, matching the whisper stacked-field layout.
- **Status semantics straight from `getStatus()`:** the status line reads the LocalModelManager shape (`adopted`/`owned` + `serverUp`/`modelPresent`/`modelResponds`) with no new IPC, giving three distinct health messages plus adopted-vs-owned ownership.
- **Gemini retained this phase:** the Gemini provider option (labelled "being removed") and `geminiKey` stay until PROV-07 (03-08), honoring never-removal-first.

## Deviations from Plan

None - plan executed exactly as written. All task verifications passed on first attempt (settings ids present + HTML balanced; `npx eslint src/ui/settings-window.js` and `npx eslint main.js` exit 0; config round-trip prints `local 4`). No bugs, missing critical functionality, or blocking issues were discovered, so no auto-fix deviations (Rules 1-3) were triggered, and no architectural decisions (Rule 4) arose.

## Issues Encountered
None. (One self-inflicted, immediately-corrected shell slip: an initial `git commit -- <file> -m "..."` put `--` before `-m`, swallowing the message flag; re-run as `git commit -m "..." -- <file>`. No effect on the tree or on any file.)

## Authentication Gates
None. Live provider/model behavior (advanced list populating from a running Ollama, test-connection succeeding, model health, repair pull) is WIRING-verified only here — it is proven on a real machine at the 03-07 human-verify gate. No API keys or logins were required for this plan.

## User Setup Required
None - no external service configuration required for this plan. Real-machine Ollama + `qwen3-vl:8b` are exercised at the 03-07 gate.

## Next Phase Readiness
- PROV-06 UI complete: the user can choose the provider (Local default) and model (curated + advanced), Gemini remains selectable this phase, and the selection persists to `.env` and applies on next launch.
- Ready for Wave 4/5: 03-07 human-verify ("Local proven" on a real machine — this settings UI is part of that verification) → 03-08 PROV-07 Gemini deletion (the provider picker + local IPC survive; only the Gemini option/key are removed).
- No blockers. Whole-repo gate green after this plan: `npx eslint .` exit 0, `node --test test/*.test.js` 83/83.

## Self-Check: PASSED

- Files exist: settings.html, src/ui/settings-window.js, main.js, 03-05-SUMMARY.md (all FOUND).
- Commits exist: 62e04e1 (Task 1), fac8b85 (Task 2), 787d976 (Task 3) (all FOUND).
- Wiring markers present in tree: `#llmProvider` (settings.html), `settings.provider = llmProvider.value` (settings-window.js), `envUpdates.LLM_PROVIDER = settings.provider` (main.js).
- Gates: `npx eslint .` exit 0; `node --test test/*.test.js` 83/83.

---
*Phase: 03-local-engine-cloud-removal*
*Completed: 2026-07-14*
