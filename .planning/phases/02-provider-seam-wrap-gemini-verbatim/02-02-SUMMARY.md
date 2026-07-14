---
phase: 02-provider-seam-wrap-gemini-verbatim
plan: 02
subsystem: api
tags: [gemini, llm-provider, serialize, golden-test, parity, node-test, commonjs, registry]

# Dependency graph
requires:
  - phase: 01-foundation-supervisor-tests-lint-makefile
    provides: "node:test harness, whole-repo eslint gate, DI-for-testability pattern"
  - phase: 02-provider-seam-wrap-gemini-verbatim (plan 01)
    provides: "LLMProvider contract + pure DI RequestBuilder emitting the neutral struct { kind, skill, systemPrompt, userText, images[], history[], mdContext }"
provides:
  - "GeminiProvider (src/services/providers/gemini.provider.js): Gemini transport/client/retry/fallback/testConnection relocated VERBATIM, extends LLMProvider, implements generate/generateStream/isAvailable/testConnection"
  - "serialize(neutral): the SINGLE neutral->Gemini wire mapper (contents/parts/systemInstruction/generationConfig), byte-identical key order (SC4)"
  - "Provider registry (src/services/providers/index.js) with hardcoded 'gemini' default (SC3 groundwork; no user-facing switch this phase)"
  - "Byte-identical golden fixtures (text/image/transcription) + parity test proving RequestBuilder+serialize reproduces today's exact outgoing request across generate AND generateStream"
affects: [02-03-facade-callsites, phase-03-local-provider]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Provider = verbatim-relocated transport core + a single serialize(neutral) wire-mapper; request construction is the ONLY surgery (process* call serialize(requestBuilder.build*Request(...)))"
    - "generate/generateStream are thin siblings over serialize + execute*/executeStreamingRequest; process* kept verbatim (parity judged by the golden test)"
    - "Golden capture from the LIVE source of truth: monkeypatch the singleton's transport + collaborators (network-free), snapshot the outgoing request, commit as frozen JSON baseline"
    - "Capture script exports shared FIXED inputs + fakes and guards execution with require.main so the parity test imports the SAME values side-effect-free"

key-files:
  created:
    - src/services/providers/gemini.provider.js
    - src/services/providers/index.js
    - scripts/capture-gemini-goldens.js
    - test/gemini-request-parity.test.js
    - test/fixtures/gemini-requests/text.json
    - test/fixtures/gemini-requests/image.json
    - test/fixtures/gemini-requests/transcription.json
  modified: []

key-decisions:
  - "Kept process* methods verbatim (only the build call swapped for serialize(requestBuilder.build*Request(...))); generate/generateStream added as thin transport siblings. Safest for parity — the golden test judges the serialized request, and every path funnels through the same serialize."
  - "Provider needs NO direct sessionManager/promptLoader imports: those live in RequestBuilder now, so the relocated file has zero '../managers'/'../../prompt-loader' requires (the deleted build*/format* methods were their only users)."
  - "Registry exported as the object itself (module.exports = registry) with providers/selected/register/get/getSelected; selected is the hardcoded 'gemini' string (Phase 3 adds the config/env switch)."
  - "generate/generateStream keep the isInitialized guard (mirrors process*) and read options.programmingLanguage for response-side enforceProgrammingLanguage; they return the answer TEXT (not the {response, metadata} envelope the process* wrappers return)."
  - "Golden capture uses a fake getConversationHistory that ignores the cap (returns the full fixed 4-event array) — cap/slice behavior is already unit-tested in request-builder.test.js; here a stable representative shape shared by capture + test is what matters."

patterns-established:
  - "Byte-identical parity gate: capture the outgoing request from the live code (transport monkeypatched, network-free), commit as JSON via JSON.stringify(x,null,2), assert exact string equality against serialize(requestBuilder.build*()) — immune to LLM answer variance."
  - "Prove both interface paths (generate + generateStream) by patching the provider's transport to capture the outgoing request and asserting each equals the golden."

# Metrics
duration: 15min
completed: 2026-07-14
---

# Phase 2 Plan 02: Gemini Provider + serialize + Byte-Identical Parity Summary

**GeminiProvider relocated verbatim behind the LLMProvider interface with a single `serialize()` neutral→wire mapper and a hardcoded-`gemini` registry, pinned by byte-identical golden fixtures that prove RequestBuilder + serialize reproduces today's exact outgoing Gemini request for text/image/transcription across both generate and generateStream — the live `llm.service.js` untouched.**

## Performance

- **Duration:** 15 min
- **Started:** 2026-07-14T17:34:18Z
- **Completed:** 2026-07-14T17:48:53Z
- **Tasks:** 2
- **Files modified:** 7 (all created)

## Accomplishments
- `GeminiProvider extends LLMProvider` with the Gemini transport/client/retry/error/fallback/testConnection logic relocated **byte-identical** from the 1654-line `llm.service.js` (only require paths + `extends`/`super()` changed; SC2).
- `serialize(neutral)` is the **single** site of Gemini wire construction (`contents` → `generationConfig` → `systemInstruction` key order preserved), so no Gemini shape leaks into the shared RequestBuilder (SC4). The 6 process* methods now call `serialize(requestBuilder.build*Request(...))` instead of building the wire shape inline.
- Interface implemented: `isAvailable` (returns `isInitialized`), `generate`/`generateStream` (thin serialize + transport siblings returning answer text), `testConnection` (relocated verbatim).
- Registry (`src/services/providers/index.js`) exposes the **hardcoded `gemini`** selected default — the "when Gemini is selected" anchor for Plan 03's cert/UA gating (SC3), with no user-facing switch this phase.
- **Byte-identical parity proven**: 3 committed goldens captured from the LIVE `llm.service.js` (network-free) + a parity test asserting exact string equality for text/image/transcription AND that `generate` and `generateStream` construct the identical golden request. Full suite 63/63, whole-repo eslint clean.

## Task Commits

Each task was committed atomically:

1. **Task 1: GeminiProvider (verbatim relocation) + serialize + registry** - `6564b6f` (feat)
2. **Task 2: golden fixtures + byte-identical Gemini request parity** - `7877968` (test)

**Plan metadata:** _(final docs commit — see below)_

## Files Created/Modified
- `src/services/providers/gemini.provider.js` - `GeminiProvider extends LLMProvider`; verbatim-relocated Gemini transport/client/retry/fallback/testConnection; `serialize(neutral)` wire-mapper; the 4 interface methods; process* delegate request construction to `serialize(requestBuilder.build*Request(...))`.
- `src/services/providers/index.js` - Provider registry (`providers`/`selected`/`register`/`get`/`getSelected`); hardcoded `gemini` default.
- `scripts/capture-gemini-goldens.js` - Network-free capture of the outgoing Gemini request from the live `llm.service.js`; exports shared `FIXED` inputs + deterministic fakes; guarded by `require.main` so the test imports them side-effect-free.
- `test/gemini-request-parity.test.js` - 7 node:test cases: 3 byte-identical serialize-vs-golden, 3 generate/generateStream identical-request, 1 generationConfig-sourcing.
- `test/fixtures/gemini-requests/{text,image,transcription}.json` - Frozen golden outgoing requests captured from today's code.

## Decisions Made
- **process* kept verbatim; generate/generateStream added as thin siblings.** Both paths funnel through the same `serialize`, so the golden test covers both; verbatim process* minimizes drift risk (the plan's "if in doubt, keep process* verbatim" path).
- **Provider imports neither sessionManager nor promptLoader.** RequestBuilder owns them now; the relocated methods that used them (`buildGeminiRequest*`, `buildIntelligentTranscriptionRequest*`, `getIntelligentTranscriptionPrompt`, `formatUserMessage`, `formatImageInstruction`) were deleted, leaving zero `../managers`/`../../prompt-loader` requires.
- **Capture from the live source of truth.** Goldens are snapshotted from the still-live `llm.service.js` (transport monkeypatched), making the byte-identical assertion a real anti-drift guard rather than a self-referential check.
- **Shared FIXED inputs/fakes via `require.main` guard.** The capture script and the parity test consume the identical fixed inputs + fakes, so "SAME fixed fakes used at capture" is guaranteed rather than duplicated.

## Deviations from Plan

None - plan executed exactly as written.

The only latitude the plan explicitly delegated (registry shape; whether process* funnel through generate/generateStream) was resolved conservatively: registry exported as the object with a `getSelected()` method; process* kept verbatim with generate/generateStream as thin siblings. Both are within the plan's stated discretion, not deviations.

## Issues Encountered
None. The serialize key-insertion-order spec in the plan matched today's three construction sites exactly, so all three goldens reproduced byte-for-byte on the first run.

## User Setup Required
None - no external service configuration required. This plan is pure, additive, network-free code (the capture script and tests never hit the network).

## Next Phase Readiness
- **Plan 02-03** (facade flip + cert/UA relocation): thin `llm.service.js` to delegate to the provider (via the registry's selected default) with identical exports; every `main.js`/`sessionManager` call-site unchanged. Relocate the Gemini-specific cert-verify bypass + User-Agent override into the provider, gated on `gemini` being selected. Smoke-test the streaming transport live (this plan proved request construction; transport wiring is 02-03).
- The provider is proven byte-identical BEFORE it is wired in — 02-03 can flip the facade with the parity test as the regression net.
- God-files (`llm.service.js`, `main.js`, `session.manager.js`) remain byte-for-byte unchanged; the app still runs on the original live path.

## Self-Check: PASSED

- Files verified on disk: `src/services/providers/gemini.provider.js`, `src/services/providers/index.js`, `scripts/capture-gemini-goldens.js`, `test/gemini-request-parity.test.js`, `test/fixtures/gemini-requests/{text,image,transcription}.json`, `02-02-SUMMARY.md` — all FOUND.
- Commits verified in git: `6564b6f` (Task 1), `7877968` (Task 2) — both FOUND.
- Gates: `npx eslint .` exit 0; `node --test test/*.test.js` → 63/63 pass (56 prior + 7 new parity); god-files (`llm.service.js`, `main.js`, `session.manager.js`) unchanged (`git diff --stat` empty).

---
*Phase: 02-provider-seam-wrap-gemini-verbatim*
*Completed: 2026-07-14*
