---
phase: 03-local-engine-cloud-removal
plan: 08
subsystem: infra
tags: [gemini-removal, ollama, local-llm, azure-stt, provider-registry, onboarding, cloud-removal]

# Dependency graph
requires:
  - phase: 03-07 (PROVE-LOCAL)
    provides: "human 'approved' sign-off that Local is PROVEN on the real machine — the hard gate for the irreversible deletion"
  - phase: 02 (LLM abstraction seam)
    provides: "thin facade + provider-owned cert/UA in configureNetworkSession + guarded setupNetworkConfiguration delegate — made removal clean"
provides:
  - "Gemini LLM path fully removed (SDK, provider incl. cert-verify bypass + UA override, IPC + preload bridges, orphaned modal, config block, settings + onboarding surface, goldens/parity test/capture script)"
  - "App runs on LocalProvider alone; provider switcher UI retained (Local only) so Phase-7 CLI backends slot in with no rework"
  - "Cert-verify bypass gone with ZERO dead global startup code (LocalProvider omits configureNetworkSession → the guarded delegate no-ops)"
  - "First-run onboarding no longer traps Local-only installs in a nag-loop (needsOnboarding de-gated from the removed cloud key)"
affects: [phase-04-stt (Azure removal deferred here), phase-06-continuous (full sustained validation deferred), phase-07-cli-providers (registry shape retained), phase-08-readme, phase-09-website]

# Tech tracking
tech-stack:
  added: []
  removed: ["@google/genai (35 packages)"]
  kept: ["microsoft-cognitiveservices-speech-sdk (Azure STT — deliberately deferred to Phase 4)"]
  patterns:
    - "Burn-the-boats: cloud path removed LAST, only after Local proven + explicit human approval (never removal-first — Pitfall 12)"
    - "Provider network hardening as an OPTIONAL provider method (configureNetworkSession) behind a guarded delegate → a keyless provider drops it automatically, no dead startup code"

key-files:
  created: []
  deleted:
    - "src/services/providers/gemini.provider.js (cert/UA bypass + hardcoded generativelanguage hosts go with it)"
    - "test/gemini-request-parity.test.js"
    - "test/fixtures/gemini-requests/{text,image,transcription}.json"
    - "scripts/capture-gemini-goldens.js"
  modified:
    - "src/services/providers/index.js (registry: local-only; getSelected falls back to local)"
    - "src/core/config.js (llm.gemini block removed; llm = { provider, local })"
    - "main.js (Gemini IPC handlers + geminiKey get/saveSettings + reinit block removed; Azure/whisper plumbing untouched)"
    - "preload.js (Gemini bridges removed)"
    - "src/ui/main-window.js (orphaned Gemini modal removed)"
    - "settings.html + src/ui/settings-window.js (Gemini section + provider option removed; switcher Local-only)"
    - "onboarding.html + onboarding.js (Gemini apikey screen + handlers removed)"
    - "src/core/first-run.js (DEVIATION — needsOnboarding de-gated; getStatus.geminiConfigured dropped; template de-clouded)"
    - "env.example (DEVIATION — Gemini key block → local-first Ollama guidance)"
    - "src/services/{llm.service.js,providers/local.provider.js,providers/llm-provider.js}, src/core/request-builder.js, src/managers/session.manager.js, scripts/smoke-local.js (de-Gemini comments/dead branch so grep -RIn gemini src/ is clean)"
    - "test/local-provider.test.js (registry test flipped to a PROV-07 removal guard + stale-selection fallback)"

key-decisions:
  - "Deletion ran ONLY after 03-07's explicit human 'approved' (Local proven) — Task 1 gate was pre-satisfied, never auto-deleted on criteria pass"
  - "Azure STT (SDK + browser-DOM polyfill + settings/onboarding) DELIBERATELY KEPT — documented SC5 divergence, removal deferred to Phase 4 (resident whisper.cpp)"
  - "Full-sustained validation divergence remains Phase 6 (03-07 rough gate was lenient; qwen3-vl over-reasoning TTFT concern logged there)"
  - "Provider switcher UI retained (Local only) so Phase-7 CLI backends need no rework"

patterns-established:
  - "Grep-clean burn: phase-verify greps `grep -RIn gemini src/` (all of src/), so cloud comments/dead branches are removed too — not deferred like the GEN-01 dsa copy"

# Metrics
duration: 25min
completed: 2026-07-15
---

# Phase 3 Plan 08: Remove Gemini (PROV-07) Summary

**Gemini LLM path fully deleted behind the 03-07 "approved" gate — @google/genai SDK, the provider (with its cert-verify bypass + UA override + hardcoded generativelanguage hosts), IPC/preload/modal/settings/onboarding surface, config block, and goldens — leaving LocalProvider (Ollama qwen3-vl:8b) as the sole engine with Azure STT intact; 96/96 tests, eslint 0.**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-07-15T19:45:48Z
- **Completed:** 2026-07-15T20:10:27Z
- **Tasks:** 2 (Task 1 hard-approval checkpoint was pre-satisfied by 03-07's "approved" sign-off)
- **Files modified:** 26 (6 deleted, 20 modified)

## Approval Sign-off

Task 1 is a `checkpoint:decision` HARD MANUAL GATE for the irreversible deletion. It was **already satisfied before this run**: 03-07 (PROVE-LOCAL) was signed off "approved" 2026-07-15 (Local proven on the real 32 GB machine — all three on-demand entry points answer locally, rough TTFT/memory smoke passed, 03-07-SUMMARY written). Per the orchestrator directive, Tasks 2–3 proceeded directly on that standing "approved"; deletion was NEVER auto-triggered on criteria pass.

## Accomplishments
- **Gemini engine gone (Task 2, `fb8bfd8`):** `npm uninstall @google/genai` (35 packages); deleted `gemini.provider.js` (its cert-verify bypass + UA override + hardcoded `generativelanguage.googleapis.com` hosts + behavioral keyword list go with it); registry is Local-only with `getSelected()` falling back to `local`; `llm.gemini` config block removed (`llm = { provider, local }`); Gemini goldens + parity test + capture script retired.
- **Gemini IPC/UI surface gone (Task 3, `c435f17`):** removed the four `*-gemini-*` IPC handlers, the `geminiKey` get/saveSettings fields + the key-reinit block, the preload bridges (`setGeminiApiKey`/`getGeminiStatus`/`testGeminiConnection`/`onOpenGeminiConfig`), the orphaned Gemini config modal, the settings Gemini section + provider option, and the onboarding `apikey` screen + all its state/handlers.
- **Cert bypass vanished with zero dead startup code:** `main.js setupNetworkConfiguration()` keeps its guarded delegate untouched; `LocalProvider` defines no `configureNetworkSession`, so the delegate simply no-ops — the global cert-verify bypass is gone without leaving any dead global startup path.
- **App runs Local-only:** provider facade resolves `LocalProvider` (`getStats().provider === 'local'`, network-free); the provider switcher UI is retained (Local only) for Phase-7 CLI backends.

## Task Commits

1. **Task 2: Delete the Gemini engine (SDK, provider, registry, config, goldens)** — `fb8bfd8` (feat) — 17 files, +54/-2278
2. **Task 3: Delete the Gemini IPC/UI surface + verify Local-only + Azure intact** — `c435f17` (feat) — 9 files, +35/-354

**Plan metadata:** (this SUMMARY + STATE advance) — committed separately as `docs(03-08)`.

## Files Created/Modified

See frontmatter `key-files` for the full list. Highlights:
- `src/services/providers/gemini.provider.js` — DELETED (54 KB; cert/UA bypass + hosts).
- `src/services/providers/index.js` — registry Local-only; unknown/stale selection resolves to Local.
- `src/core/config.js` — `llm.gemini` removed.
- `main.js` / `preload.js` — Gemini IPC + bridges removed; Azure/whisper plumbing (SPEECH_PROVIDER/AZURE_SPEECH_KEY/AZURE_SPEECH_REGION) untouched.
- `settings.html` / `src/ui/settings-window.js` / `src/ui/main-window.js` / `onboarding.html` / `onboarding.js` — Gemini surface removed; Local switcher + Ollama/model-pull/speech onboarding retained.

## Decisions Made
- Ran the deletion on the standing 03-07 "approved" (Local proven) — the hard gate, never removal-first.
- Kept Azure STT (SDK + browser-DOM polyfill + settings/onboarding) this phase; removal is a Phase-4 concern.
- Retained the provider switcher (Local only) for Phase-7 CLI backends.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] First-run onboarding would nag-loop forever on Local-only installs**
- **Found during:** Task 3
- **Issue:** `src/core/first-run.js` `needsOnboarding()` returned `true` whenever `.env` lacked a real `GEMINI_API_KEY` — which, once Gemini is removed and Local is the default, is the normal state for EVERY fresh install. That would re-trigger the onboarding wizard on every launch AND keep the main overlay hidden (`showMainWindow: !isFirstRun`). Directly caused by the removal (the whole point is that no cloud key exists). `first-run.js` was not in the plan's `files_modified`, but the plan's own phase verification is `grep -RIn gemini src/` (all of src/), which `first-run.js` also failed.
- **Fix:** `needsOnboarding()` now gates only on the sentinel + `.env` existence (Local needs no cloud key, so once onboarding completes we never nag again); dropped `geminiConfigured` from `getStatus()`; de-clouded the `_readTemplate()` fallback. Also de-clouded `env.example` (the template `_readTemplate` writes to fresh installs).
- **Files modified:** src/core/first-run.js, env.example
- **Verification:** `getStatus()` now returns keys `envExists,sentinelExists,azureConfigured,whisperConfigured,needsOnboarding` (no `geminiConfigured`); module loads network-free; `grep -RIn gemini src/` clean.
- **Committed in:** `c435f17` (Task 3 commit)

**2. [Rule 3 - Blocking] `test/local-provider.test.js` asserted "gemini stays registered"**
- **Found during:** Task 2
- **Issue:** A registry test asserted `registry.get('gemini')` is truthy ("must remain registered until PROV-07"). PROV-07 is this plan — the assertion would fail `node --test` after removal.
- **Fix:** Replaced it with a PROV-07 removal guard (`registry.get('gemini') === undefined`) plus a stale-selection test (simulating a leftover `LLM_PROVIDER=gemini` resolves to `local`). De-referenced the deleted parity test in the header comment.
- **Files modified:** test/local-provider.test.js
- **Verification:** 96/96 tests pass.
- **Committed in:** `fb8bfd8` (Task 2 commit)

**3. [Rule 1 - Cleanup] Cloud references in src/ comments + one dead branch (required by phase-verify `grep -RIn gemini src/`)**
- **Found during:** Tasks 2 & 3
- **Issue:** Stale "Gemini"/"GeminiProvider" comments in `llm.service.js`, `local.provider.js`, `llm-provider.js`, `request-builder.js`, the setupNetworkConfiguration/PROV-05/PROV-07 comments in `main.js`, a dead `actionLower.includes('gemini')` branch in `session.manager.js`, and a comment referencing the deleted capture script in `smoke-local.js`. Unlike the deferred GEN-01 `dsa` copy strings, gemini comments are NOT deferrable — the phase verification greps all of `src/`.
- **Fix:** Reworded the comments to describe the Local-only reality; removed the dead `session.manager` branch.
- **Files modified:** src/services/llm.service.js, src/services/providers/local.provider.js, src/services/providers/llm-provider.js, src/core/request-builder.js, src/managers/session.manager.js, main.js, scripts/smoke-local.js
- **Verification:** `grep -RIn -i gemini src/ main.js preload.js settings.html onboarding.*` returns nothing; eslint 0.
- **Committed in:** `fb8bfd8` (engine internals) + `c435f17` (main.js comments)

---

**Total deviations:** 3 auto-fixed (2× Rule 1, 1× Rule 3).
**Impact on plan:** Deviation 1 was necessary to actually deliver "app runs on Local alone" (without it, fresh installs loop onboarding with a hidden overlay). Deviations 2 & 3 were required to pass the plan's own verification (`node --test` green + `grep -RIn gemini src/` clean). No scope creep beyond Gemini removal; Azure STT provably untouched.

**Intentional scope boundaries (NOT changed):** `test/env-file.test.js` (uses `GEMINI_API_KEY` as generic env-parser fixture data — not a Gemini code path) and `test/request-builder.test.js` (asserts the neutral struct "never emits Gemini wire keys" — a still-valid, still-passing guard). Neither is in any verification grep scope; changing passing tests unnecessarily would violate minimalism.

## Documented Divergences (carried forward)

- **SC5 / Azure STT KEPT → Phase 4:** SC5 literally says "remove … the Azure browser-DOM polyfill." RESEARCH Flag 4 confirmed Azure is STT-only and the polyfill (`src/services/speech.service.js`) is inseparable from the Azure Speech SDK — removing it breaks voice. The higher-priority locked decision "keep STT working throughout" wins: `microsoft-cognitiveservices-speech-sdk`, `speech.service.js` (incl. the polyfill), the Azure settings/onboarding fields, and the SPEECH_PROVIDER/AZURE_SPEECH_KEY/AZURE_SPEECH_REGION plumbing all stay. Removal is deferred to Phase 4 (resident whisper.cpp replaces the whole STT layer). VERIFIED intact: `microsoft-cognitiveservices-speech-sdk` still in package.json; `git status` shows `speech.service.js` UNCHANGED.
- **Full sustained validation → Phase 6:** 03-07's gate was rough/lenient by design; sustained relevance-gate + TTFT validation (incl. the logged qwen3-vl over-reasoning TTFT concern) is Phase 6.

## Verification Results (exact)

- **V1** `grep -RIn -i "gemini" main.js preload.js src/ui/ settings.html onboarding.html onboarding.js` → **nothing (clean)**
- **Phase-verify** `grep -RIn -i "gemini" src/ main.js preload.js settings.html onboarding.*` → **nothing (clean)**
- **V2** `grep -RIl "google/genai\|GeminiProvider\|generativelanguage" src/ test/ scripts/` → **nothing (clean)**
- **V3** `test -f src/services/providers/gemini.provider.js` → **DELETED**
- **Cert bypass** `grep -n configureNetworkSession src/services/providers/local.provider.js` → **nothing (bypass gone, no dead startup code)**
- **V4** `node -e "...llm.service...getStats().provider"` → **`local`** (network-free, no throw)
- **V5 (Azure kept)** `grep -n microsoft-cognitiveservices-speech-sdk package.json` → **matches**; `speech.service.js` **UNCHANGED** in git
- **V6** `node --test test/*.test.js` → **96/96 pass, 0 fail**; `npx eslint .` → **exit 0**
- **Module-load** `main.js` evaluated top-level without throwing (stubbed electron; Azure polyfill + LLM facade in the require chain); all touched electron/renderer files pass `node --check`.
- **Boot smoke** the full `npm start` GUI boot + voice-init is a HUMAN post-check (not feasible headless) — see Next Phase Readiness.

## Issues Encountered
None during planned work beyond the deviations above. The Gemini modal (`showGeminiConfig`) and the `run-gemini-diagnostics` / `onOpenGeminiConfig` bridges were confirmed fully orphaned (no callers/subscribers) before removal.

## User Setup Required
None — no external service configuration required. (The removal makes the app work with NO cloud key; Ollama + a local model is the only requirement, guided by onboarding.)

## Next Phase Readiness
- **Phase 3 SC5 met at Phase-3 scope:** Gemini fully removed behind the hard approval, done LAST after Local was proven. The app is a working local-first engine.
- **Human post-check (recommended before merge):** `npm start` on the real machine — confirm the app boots straight to the overlay (no onboarding nag now that first-run is de-gated), answers a question on Local, and the mic/STT still initializes. The env prep from 03-07 (Homebrew ollama daemon + qwen3-vl:8b resident) applies.
- **Deferred to Phase 4:** Azure STT removal (SDK + browser-DOM polyfill + Azure settings/onboarding) when resident whisper.cpp lands.
- **Deferred to Phase 6:** full sustained validation + qwen3-vl over-reasoning TTFT decision.
- **Phase 7 ready:** provider registry keeps its multi-provider shape (Local only today) so CLI backends slot in with no rework.

---
*Phase: 03-local-engine-cloud-removal*
*Completed: 2026-07-15*
