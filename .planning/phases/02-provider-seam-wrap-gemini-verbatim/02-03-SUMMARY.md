---
phase: 02-provider-seam-wrap-gemini-verbatim
plan: 03
subsystem: api
tags: [gemini, llm-provider, facade, registry, cert-verify, user-agent, electron-session, checkpoint-waived]

# Dependency graph
requires:
  - phase: 02-provider-seam-wrap-gemini-verbatim (plan 01)
    provides: "LLMProvider contract + pure DI RequestBuilder emitting the neutral request struct"
  - phase: 02-provider-seam-wrap-gemini-verbatim (plan 02)
    provides: "GeminiProvider (verbatim transport) + serialize() wire-mapper + hardcoded-gemini registry + byte-identical golden parity"
provides:
  - "Thin llm.service.js facade (17 lines): re-exports registry.getSelected() so every llmService.* call-site in main.js is byte-for-byte unchanged (SC1)"
  - "GeminiProvider.configureNetworkSession(ses): the Gemini cert-verify bypass + UA override relocated VERBATIM into the provider, hostname-guarded, selection-gated (SC3)"
  - "main.js setupNetworkConfiguration() delegates cert/UA to the selected provider (gated on configureNetworkSession existing) — no unconditional global Gemini bypass (SC3)"
affects: [phase-03-local-provider]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Facade = re-export the registry-selected provider instance (module.exports = require('./providers').getSelected()) — identical method surface + { response, metadata } return shapes keep every call-site unchanged"
    - "Provider-owned, selection-gated network hardening: the cert/UA capability lives on the provider (configureNetworkSession) and main.js delegates only if the selected provider implements it — dead global code vanishes cleanly at provider removal"

key-files:
  created: []
  modified:
    - src/services/llm.service.js
    - src/services/providers/gemini.provider.js
    - main.js

key-decisions:
  - "Facade re-exports the provider instance via require('./providers').getSelected() (non-destructured) rather than the plan's illustrative destructured `const { getSelected } = ...; getSelected()` — getSelected() reads this.providers[this.selected], so a bare destructured call would lose `this` and throw. Same result the plan intended, correct binding (safe-form deviation)."
  - "Task 3 live-Gemini smoke test WAIVED — no GEMINI_API_KEY in this environment (moving off cloud is the project's whole point), so the live transport path is unrunnable here and never worked in this env. Replaced with no-key runtime verification + the byte-identical parity net; true end-to-end deferred to Phase 3 (Local, keyless)."
  - "configureNetworkSession is a Gemini-only capability (NOT part of the 4-method LLMProvider interface); main.js gates on its existence so a future keyless Local provider simply won't define it and the bypass disappears with no dead global code."

patterns-established:
  - "Thin-facade flip guarded by the prior plan's golden parity test: relocate the god-file body to the provider (Plan 02), then re-export the selected provider so call-sites never change (Plan 03) with the parity suite as the regression net."
  - "Checkpoint waiver: when a live smoke needs an unavailable credential, substitute no-key runtime verification (module load, method surface, graceful degradation, wiring trace) + automated parity, document the waiver, and defer true e2e to a keyless phase."

# Metrics
duration: 20min
completed: 2026-07-14
---

# Phase 2 Plan 03: Thin Facade + Provider-Owned Cert/UA (Live Smoke Waived) Summary

**`llm.service.js` collapsed to a 17-line facade re-exporting the registry-selected Gemini provider (every `main.js` `llmService.*` call-site byte-for-byte unchanged, SC1), and the Gemini cert-verify bypass + UA override relocated VERBATIM into the provider behind a selection-gated `configureNetworkSession` (SC3) — the live-Gemini smoke WAIVED (no key; cloud is being removed) in favor of no-key runtime verification + the byte-identical parity net.**

## Performance

- **Duration:** ~20 min (2 autonomous tasks + checkpoint finalization)
- **Started:** 2026-07-14T17:53:00Z
- **Completed:** 2026-07-14T18:13:27Z
- **Tasks:** 2 of 3 executed and committed; Task 3 (live smoke) WAIVED (see waiver below)
- **Files modified:** 3

_Task commits landed 2026-07-14T18:01:09Z (`95a9936`) and 2026-07-14T18:03:25Z (`47ecfdf`); the checkpoint was resolved (smoke waived) and this summary written at 18:13:27Z._

## Accomplishments
- **Facade flip (SC1/SC2):** `src/services/llm.service.js` reduced from the 1654-line Gemini god-file to a **17-line facade** — `module.exports = require('./providers').getSelected()` — that re-exports the registry-selected provider singleton. The provider preserves every method name/signature and the same `{ response, metadata }` return shapes, so all **11 `llmService.*` call-sites in `main.js` are byte-for-byte unchanged** (`git diff` on those lines empty). Facade net change: **1655 deletions, 17 insertions** (`95a9936`).
- **Cert/UA relocation (SC3):** The Gemini-specific `onBeforeSendHeaders` UA override + `setCertificateVerifyProc` bypass moved **verbatim** (exact UA string, exact `callback(0)`/`callback(-2)` codes, hostname-guarded to `generativelanguage.googleapis.com`) out of unconditional global startup in `main.js` into `GeminiProvider.configureNetworkSession(ses)`. `main.js setupNetworkConfiguration()` now delegates to the selected provider, **gated on `configureNetworkSession` existing** — so the bypass vanishes cleanly when Gemini is removed in Phase 3 (`47ecfdf`).
- **Isolation held (SC3):** The Gemini hostname bypass no longer appears inline in `main.js`; `speech.service.js` (Azure/STT `userAgent: 'Node.js'`) and `main-window.js` (`navigator.userAgentData` platform detection) are untouched — neither file is in either 02-03 commit.
- **Verified keyless:** facade loads as a `GeminiProvider` exposing all 9 methods `main.js` calls, degrades gracefully with no key, and the whole seam stays green (`npx eslint .` exit 0; `node --test` 63/63, incl. byte-identical golden parity).

## Task Commits

Each executed task was committed atomically:

1. **Task 1: Flip llm.service.js to a thin facade over the selected provider (SC1)** — `95a9936` (refactor)
2. **Task 2: Relocate the Gemini cert/UA bypass into the provider, gate in main.js (SC3)** — `47ecfdf` (refactor)
3. **Task 3: Live smoke of the three entry points (screenshot / typed-chat / voice)** — **WAIVED** (no `GEMINI_API_KEY`; no commit) — see [Smoke-Test Waiver](#smoke-test-waiver-task-3)

**Plan metadata:** _(final docs commit — this SUMMARY + STATE.md; see below)_

## Files Created/Modified
- `src/services/llm.service.js` — Now a 17-line thin facade: `const providers = require('./providers'); module.exports = providers.getSelected();`. Re-exports the registry-selected provider instance so the identical export surface (all 9 methods) and `{ response, metadata }` returns keep every call-site unchanged.
- `src/services/providers/gemini.provider.js` — Added `configureNetworkSession(ses)` (line 239): the verbatim UA-override (`onBeforeSendHeaders`) + `setCertificateVerifyProc` blocks, hostname-guarded to `generativelanguage.googleapis.com`, with `if (!ses) return` guard. A Gemini-only capability, not part of the 4-method interface.
- `main.js` — `setupNetworkConfiguration()` body (line 289, invoked at line 223) now resolves `require('./src/services/providers').getSelected()` and calls `provider.configureNetworkSession(ses)` **only if that method exists** (lines 295-297). The two inline Gemini blocks were removed; no `llmService.*` call-site or the require at line 86 was touched.

## Verification (No-Key Runtime Evidence — in place of the live smoke)

All automated gates and no-key runtime checks were re-run at finalization and PASSED — recorded here as the evidence standing in for the waived live smoke:

- **Facade load + method surface (rules out the flip breaking module load / exports / this-binding):** `require('./src/services/llm.service.js')` loads successfully; `.constructor.name === 'GeminiProvider'`; all 9 methods `main.js` calls are functions — `initializeClient`, `updateApiKey`, `getStats`, `testConnection`, `checkNetworkConnectivity`, `processImageWithSkillStream`, `processTextWithSkillStream`, `processTranscriptionWithIntelligentResponseStream`, `generateIntelligentFallbackResponse`.
- **Graceful no-key degradation (behavior preserved vs. before):** with no key the facade logs `"Gemini API key not configured"` and does **not** throw.
- **SC3 wiring confirmed live (trace):** `main.js:223` calls `setupNetworkConfiguration()` → `require('./src/services/providers').getSelected()` → `provider.configureNetworkSession(ses)` (`main.js:295-297`). Cert/UA is applied at startup via the provider, gated on selection. The `generativelanguage.googleapis.com` bypass is confirmed **no longer inline** in `main.js`.
- **SC1 automated parity green:** `npx eslint .` exit 0; `node --test test/*.test.js` → **63/63** (incl. byte-identical golden parity for text/image/transcription across `generate` + `generateStream`); **zero `llmService.*` call-site changes** across the phase; Azure/STT (`speech.service.js`, `main-window.js`) untouched.
- **The one unverified bit is unchanged code:** the Gemini transport (SDK + raw-HTTPS streaming SSE) and cert/UA blocks were relocated **verbatim**, so the live network round-trip is unchanged code fed a byte-identical request. True end-to-end verification is deferred to Phase 3 (Local), which is keyless.

## Success Criteria Mapping

| SC | Requirement | Status |
| -- | ----------- | ------ |
| **SC1** | Thin facade with identical exports; every call-site unchanged; app answers screenshot/voice/typed-chat via Gemini as before | **Met (mechanism verified; live behavior via parity + no-key load).** 17-line facade re-exports the provider; all 11 `main.js` call-sites byte-for-byte unchanged; 63/63 parity. Live streaming behavior asserted via the byte-identical golden + verbatim transport; direct GUI smoke waived (no key). |
| **SC2** | Facade delegates to the registered, interface-implementing Gemini provider | **Met.** `getSelected()` returns the `GeminiProvider extends LLMProvider` instance registered in `src/services/providers/index.js` (hardcoded `gemini`). |
| **SC3** | Gemini cert-verify bypass + UA override live inside the provider, active only when Gemini is selected, removed from global startup, isolated from Azure/STT | **Met.** `configureNetworkSession` owns the verbatim blocks; `main.js` delegates gated on the method existing; bypass no longer inline; `speech.service.js` + `main-window.js` untouched. |
| **SC4** | RequestBuilder owns the neutral struct; no Gemini wire shape leaks into it | **Met (landed 02-01/02-02; unchanged here).** No RequestBuilder/serialize edits this plan; the parity suite stays green, confirming no regression. |

Plan `must_haves` artifacts/links all satisfied: `llm.service.js` contains `require('./providers')`; `gemini.provider.js` contains `setCertificateVerifyProc`; `main.js` contains `configureNetworkSession`; the facade→registry and main.js→provider delegation links are live.

## Smoke-Test Waiver (Task 3)

**Status: WAIVED (accepted, documented — NOT a failure).**

- **What was planned:** a manual human smoke launching `npm start` and exercising typed chat, screenshot OCR, and voice against live Gemini, confirming streamed answers and no cert/UA/network errors.
- **Why waived:** there is no `GEMINI_API_KEY` in this environment, and **removing the cloud dependency is the entire point of the project**. The live-Gemini transport path is therefore unrunnable here and was never exercised in this environment. Provisioning a cloud key solely to smoke a path slated for deletion in Phase 3 is counter to the project's goal.
- **What was done instead:** the no-key runtime verification above (facade load, 9-method surface, graceful degradation, SC3 wiring trace) plus the full automated parity net (eslint + 63/63 incl. byte-identical goldens across `generate`/`generateStream`). Because the transport + cert/UA were relocated **verbatim**, the only bit these do not cover — a live network round-trip / streaming SSE — is unchanged code receiving a byte-identical request.
- **Deferred to:** Phase 3 (Local engine), which is **keyless** and provides true end-to-end streaming verification without any cloud credential.

## Decisions Made
- **Facade re-exports the provider instance (non-destructured getSelected).** The registry's `getSelected()` is `return this.providers[this.selected]` — it depends on `this`. The plan's illustrative snippet destructured it (`const { getSelected } = require('./providers'); getSelected()`), which would call it bare and lose the `this` binding (TypeError). Using `require('./providers').getSelected()` keeps the method bound to the registry and yields exactly the result the plan intended. (Documented as a deviation below.)
- **Live smoke waived; keyless verification substituted.** See the waiver section — no key exists, cloud is being removed, and parity + verbatim relocation cover the mechanism; e2e is deferred to keyless Phase 3.
- **`configureNetworkSession` kept off the interface, gated by existence.** It is Gemini-only network hardening; `main.js` checks `typeof provider.configureNetworkSession === 'function'` so a keyless Local provider that omits it drops the bypass with zero dead global code (SC3's clean-removal property).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Facade uses non-destructured `require('./providers').getSelected()` to preserve `this` binding**
- **Found during:** Task 1 (facade flip)
- **Issue:** The plan's illustrative facade snippet was `const { getSelected } = require('./providers'); module.exports = getSelected();`. But the registry's `getSelected()` (`src/services/providers/index.js:28-30`) is `return this.providers[this.selected]` — it reads `this`. Destructuring and bare-calling it detaches the method from the registry object, so `this` is `undefined` and the call throws (`Cannot read properties of undefined`).
- **Fix:** Implemented the facade as `const providers = require('./providers'); module.exports = providers.getSelected();` — calling the method on the registry object so `this` stays bound. Identical net result (the selected provider instance) to what the plan intended.
- **Files modified:** `src/services/llm.service.js`
- **Verification:** `require('./src/services/llm.service.js')` loads and exposes all 9 methods; 63/63 tests + eslint clean.
- **Committed in:** `95a9936` (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 bug — safe-form binding fix). The plan explicitly allowed latitude on facade shape ("if you prefer an explicit delegating facade object... it is allowed"); this stays within that latitude while fixing a `this`-binding bug the literal snippet would have introduced.
**Impact on plan:** None on scope or outcome — the facade delivers exactly the intended export surface. No source beyond the three planned files was changed.

## Issues Encountered
None during the executed work. The only checkpoint deviation is the intentional, documented Task-3 waiver (no key), not a problem encountered mid-task.

## User Setup Required
None for the seam itself — the provider abstraction runs **keyless** (loads, degrades gracefully, all tests pass with no `GEMINI_API_KEY`). A `GEMINI_API_KEY` is required only to exercise the **live** Gemini transport (the waived smoke); that path is slated for removal in Phase 3 and is not needed to proceed.

## Next Phase Readiness
- **Phase 2 seam complete.** `llm.service.js` is a thin facade over the registry-selected provider; the Gemini transport, serialize mapper, cert/UA bypass, and registry all live behind the `LLMProvider` interface. Every `main.js`/`llmService.*` call-site is unchanged, guarded by the byte-identical golden parity suite.
- **Phase 3 (Local engine) can:** register a keyless Local provider in the registry and flip `selected` (or add the config/env switch the registry was designed for), gaining true end-to-end streaming verification without a cloud key. A Local provider that omits `configureNetworkSession` automatically drops the Gemini cert/UA bypass — the SC3 clean-removal property.
- **Open item carried forward:** the live-Gemini streaming round-trip remains directly unverified in this environment (waived, no key); it is unchanged verbatim code, and Phase 3 supersedes it with keyless e2e.
- **Delivery:** Phase 1 branch + all Phase 2 commits (incl. `95a9936`, `47ecfdf`, and this docs commit) remain **unpushed** pending the user's push/merge. The phase verifier + ROADMAP/REQUIREMENTS phase-complete marking are the orchestrator's next step (not done here).

## Self-Check: PASSED

- **Files verified on disk:** `src/services/llm.service.js` (17 lines, facade), `src/services/providers/gemini.provider.js` (`configureNetworkSession` at line 239), `main.js` (delegation at 289/295-297), `.planning/phases/02-provider-seam-wrap-gemini-verbatim/02-03-SUMMARY.md` — all FOUND.
- **Commits verified in git:** `95a9936` (Task 1 facade flip, 1655−/17+), `47ecfdf` (Task 2 cert/UA relocation, main.js + gemini.provider.js) — both FOUND on `gsd/phase-02-provider-seam-wrap-gemini-verbatim`.
- **Gates:** `npx eslint .` exit 0; `node --test test/*.test.js` → 63/63 pass; facade loads keyless with all 9 methods; all 11 `llmService.*` call-sites present + unchanged; Gemini hostname bypass absent from `main.js`; `speech.service.js` + `main-window.js` untouched.
- **No source code changed by this finalization** — only the SUMMARY + STATE docs.

---
*Phase: 02-provider-seam-wrap-gemini-verbatim*
*Completed: 2026-07-14*
