---
phase: 03-local-engine-cloud-removal
plan: 06
subsystem: ui
tags: [ollama, onboarding, model-pull, recovery, overlay, renderer, preflight, qwen3-vl]

# Dependency graph
requires:
  - phase: 03-local-engine-cloud-removal (03-04)
    provides: "LocalModelManager + provider-neutral local IPC — pullModel/onModelPullProgress (structured {status,percent,completed,total}), getModelStatus (owned/adopted + serverUp/modelPresent/modelResponds), recoverModel('restart'|'repull'), modelPreflight, listInstalledModels; preload bridges"
  - phase: 03-local-engine-cloud-removal (03-03)
    provides: "LocalProvider.generateIntelligentFallbackResponse — canned 'Local model unavailable' body with metadata.usedFallback the overlay keys off"
provides:
  - "First-run onboarding: openwhispr-style Ollama guide-install screen (detect via getModelStatus, Open ollama.com/download + Re-check) + auto-pull screen for qwen3-vl:8b with a resumable percent progress bar and a preflight disk/RAM warning banner (warn, never block)"
  - "In-overlay 'Local model unavailable' one-click recovery panel keyed off owned-vs-adopted + 3-level health — never offers to restart a daemon the app doesn't own"
affects: [03-07 (human-verify: needs a real Ollama to exercise guide-install + pull + recovery), 03-08 (PROV-07 Gemini removal — the apikey onboarding screen + orphaned Gemini modal are removed then), Phase 5 (SEC/continuous-capture reuse the overlay render path), Phase 7 (CLI backup engines slot behind the same Local-down affordance)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Renderer consumes the 03-04 local IPC surface only — no new IPC added"
    - "Reuse the whisper download-progress plumbing shape for the structured model pull (subscribe → render percent bar → unsubscribe on settle)"
    - "Self-contained overlay affordances: inject scoped keyframes + unicode glyphs when the host HTML (index.html) ships no icon font / spinner class"

key-files:
  created: []
  modified:
    - "onboarding.html — added data-screen=ollama (guide-install) + data-screen=model-pull (progress bar + preflight slot); progress/preflight CSS; +2 stepper dots"
    - "onboarding.js — ollama/model-pull screen order + canAdvance + state (ollamaDetected/modelPulling/modelPulled); runOllamaDetect/enterOllamaScreen; renderPreflightWarnings/startModelPull via pullModel + onModelPullProgress"
    - "src/ui/main-window.js — showLocalUnavailable(status) + recovery actions (restart/repull/settings) keyed off owned/adopted; overlay subscribes to llm-response/transcription-llm-response/llm-error and detects the local-unavailable fallback"

key-decisions:
  - "Local-model onboarding screens (ollama guide-install + qwen3-vl:8b pull) always run — Local is the default engine, so this is core setup, not gated on the STT choice"
  - "ollama screen gates advancement on a running engine (openwhispr-style: install + Re-check to proceed); model-pull uses friendly-failure (once the pull settles, ok or not, Continue is enabled — a partial pull resumes on retry/first use)"
  - "Recovery panel wired to broadcastToAllWindows events the overlay already receives; branches only on getStatus (owned→Restart, adopted-down→Open Settings never restart, model-missing→Re-download with inline progress, !modelResponds/OOM→Open Settings)"

patterns-established:
  - "Overlay Local-down safety net: detect the canned fallback (metadata.usedFallback or /local model unavailable/i) or any llm-error → getModelStatus → one-click recovery; dismiss when a real answer arrives"
  - "Window grows to reveal a floating panel (resizeWindow to panel.bottom+margin) and shrinks back via resizeWindowToContent on dismiss — mirrors the shortcuts-popover lifecycle"

# Metrics
duration: 10min
completed: 2026-07-14
---

# Phase 3 Plan 06: Model-availability UX (PROV-05) Summary

**First-run onboarding that guide-installs Ollama (openwhispr-style) and auto-pulls qwen3-vl:8b with a resumable percent bar + preflight warning, plus an in-overlay "Local model unavailable" one-click recovery panel keyed off owned-vs-adopted — all pure renderer work over the 03-04 IPC surface.**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-07-14T21:10:10Z
- **Completed:** 2026-07-14T21:20:04Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- **Onboarding Ollama guide-install** (`data-screen="ollama"`): detects the engine via `getModelStatus().serverUp`; when missing, shows install guidance + an "Open ollama.com/download" (`openExternal`) button + a "Re-check" button and blocks advancement until a running engine is found — never bundles, never silently fails.
- **Onboarding auto-pull** (`data-screen="model-pull"`): on entry runs `modelPreflight()` and renders any disk/RAM `warnings` into `#modelPreflightWarn` (warn, do not block), then auto-starts `pullModel('qwen3-vl:8b')`, rendering the structured `{status,percent}` from `onModelPullProgress` into a real percent bar (`#modelPullBar`) + status (`#modelPullStatus`) + log (`#modelPullLog`). Resumable + friendly on interruption; STT (whisper/speech) onboarding untouched.
- **In-overlay recovery panel** (`showLocalUnavailable`): inline, dismissible "Local model unavailable" panel that branches off `getModelStatus()` — owned+down → Restart Ollama (`recoverModel('restart')`); adopted+down → Open Settings (never restart a foreign daemon); model-missing → Re-download (`recoverModel('repull')` with inline progress); `!modelResponds`/OOM → Open Settings. Triggered from the fallback response (`metadata.usedFallback` / "Local model unavailable" text) and any `llm-error`.

## Task Commits

Each task was committed atomically (explicit pathspec — parallel-safe with sibling plan 03-05):

1. **Task 1: Onboarding guide-install + auto-pull screens** - `d2f2194` (feat) — onboarding.html, onboarding.js
2. **Task 2: In-overlay Local-model-unavailable recovery** - `2136253` (feat) — src/ui/main-window.js

_Sibling 03-05 commits (`787d976`, `091740b`) interleaved on the shared branch; every commit touched only its own plan's files._

## Files Created/Modified
- `onboarding.html` - New `ollama` (guide-install) + `model-pull` (progress bar + `#modelPreflightWarn` slot) screens; `.progress-track`/`.progress-fill`/`.preflight-warn` CSS; +2 stepper dots for the new 6-screen base flow.
- `onboarding.js` - New screen order + `canAdvance` cases + state (`ollamaDetected`/`modelPulling`/`modelPulled`); `runOllamaDetect`/`enterOllamaScreen` (getModelStatus + openExternal + re-check); `renderPreflightWarnings`/`startModelPull` (modelPreflight + pullModel + onModelPullProgress with unsubscribe-on-settle).
- `src/ui/main-window.js` - `showLocalUnavailable(status)` + `checkAndShowLocalUnavailable`/`_renderLocalUnavailablePanel`/`_runRecoveryAction`/`_resizeForPanel`/`dismissLocalUnavailable`; overlay subscriptions to `llm-response`/`transcription-llm-response`/`llm-error`; fallback detection in `handleLLMResponse`/`handleLLMError`.

## Decisions Made
- **Local-model screens are always-on core setup** (not gated on the STT choice), because Local is now the default engine (registry flip landed in 03-03).
- **ollama screen blocks; model-pull is friendly.** Guide-install is openwhispr-style (must Re-check to a running engine before proceeding); the pull enables Continue once it settles regardless of outcome (a partial pull resumes on retry or first use).
- **Recovery keyed strictly off `getStatus`.** The adopted-down branch offers "Open Settings", never "Restart", so the app never tries to restart a daemon it doesn't own (matches RESEARCH Pattern 7 and the `recover-model 'restart'` main-process guard).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Overlay had no subscribed LLM response/error handler to branch from**
- **Found during:** Task 2
- **Issue:** The plan says to "find the current `onLlmError`/response handler in main-window.js and branch to `showLocalUnavailable`." In reality the LLM answer *rendering* lives in `chat-window.js` (outside my file scope); `main-window.js` had dormant `handleLLMResponse`/`handleLLMError` methods that were never subscribed to any IPC.
- **Fix:** Subscribed the overlay to the `llm-response` / `transcription-llm-response` / `llm-error` events (all delivered to every window via `windowManager.broadcastToAllWindows`) and branched inside those existing (now-wired) handlers — faithful to the plan's intent while staying inside my declared file (`src/ui/main-window.js`), not touching `chat-window.js`.
- **Files modified:** src/ui/main-window.js
- **Verification:** eslint 0; grep confirms the affordance + owned/adopted branching; broadcast path traced in main.js (1488/1492/1513) + window.manager.js `broadcastToAllWindows`.
- **Committed in:** `2136253` (Task 2 commit)

**2. [Rule 3 - Blocking] index.html ships no Font Awesome / `.spinner` class**
- **Found during:** Task 2
- **Issue:** The recovery panel initially used `<i class="fas ...">` icons + a `.spinner` class (as the onboarding screens do), but the main overlay (`index.html`) loads only Tailwind + `common.css` — no icon font, no spinner keyframes — and `index.html` is outside my declared file set.
- **Fix:** Made the panel self-contained: a `_ensureRecoveryStyles()` injector adds scoped `@keyframes lu-spin` + a `.lu-spinner` class once, and the warning icon is a unicode glyph (`&#9888;`). No dependency on the host page's assets; `index.html` untouched.
- **Files modified:** src/ui/main-window.js
- **Verification:** eslint 0; panel markup is dependency-free.
- **Committed in:** `2136253` (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (both Rule 3 - blocking).
**Impact on plan:** Both were adaptations to the actual codebase (wiring hook + host-page assets) handled entirely within the declared file scope. No architectural changes, no scope creep, no sibling-file edits.

## Issues Encountered
- **Runtime paths are wiring-verified only.** Onboarding auto-pull, preflight rendering, and the recovery panel's live restart/repull all require a real Ollama daemon + a real `qwen3-vl:8b` pull, which aren't available in this environment. Static verification is complete (eslint 0 on both files + full repo; grep-confirmed screens/wiring; 83/83 node tests still green — renderer files aren't imported by them). True runtime behavior is confirmed at the **03-07 human-verify gate** (per the phase's PROVEN-before-removal sequencing).

## User Setup Required
None - no external service configuration required. (End users install Ollama via the onboarding guide-install screen at runtime; that is the feature, not a build-time setup step.)

## Next Phase Readiness
- **Ready for 03-07 (human-verify "Local proven"):** all model-availability UX is in place and consumes the 03-04 IPC surface exclusively. The 03-07 smoke should exercise: (a) first-run with Ollama absent → guide-install; (b) first-run with Ollama present → auto-pull with a live percent bar + any preflight warning; (c) stop Ollama, ask a question → overlay shows "Local model unavailable" with a working Restart (owned) / Open Settings (adopted) button.
- **No blockers.** PROV-07 (03-08) later removes the still-present Gemini `apikey` onboarding screen and the orphaned Gemini config modal in main-window.js — deliberately left intact this plan.

## Self-Check: PASSED

- Files verified on disk: `onboarding.html`, `onboarding.js`, `src/ui/main-window.js`, `.planning/phases/03-local-engine-cloud-removal/03-06-SUMMARY.md` — all FOUND.
- Commits verified: `d2f2194` (Task 1), `2136253` (Task 2) — all FOUND.
- Artifact `contains` checks: onboarding.html⊇"ollama" ✓, onboarding.js⊇"pullModel" ✓, main-window.js⊇"Local model unavailable" ✓.
- Static gates: `npx eslint onboarding.js` + `npx eslint src/ui/main-window.js` + `npx eslint .` all exit 0; `node --test test/*.test.js` = 83/83.

---
*Phase: 03-local-engine-cloud-removal*
*Completed: 2026-07-14*
