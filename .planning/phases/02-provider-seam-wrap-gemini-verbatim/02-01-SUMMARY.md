---
phase: 02-provider-seam-wrap-gemini-verbatim
plan: 01
subsystem: api
tags: [llm-provider, request-builder, gemini, node-test, dependency-injection, commonjs]

# Dependency graph
requires:
  - phase: 01-foundation-supervisor-tests-lint-makefile
    provides: "src/core/ pure-module + DI-for-testability pattern (service-supervisor.js), skill-normalizer.js, node:test harness, eslint whole-repo gate"
provides:
  - "LLMProvider contract (src/services/providers/llm-provider.js) with exactly generate/generateStream/isAvailable/testConnection (SC2 groundwork)"
  - "Pure DI RequestBuilder (src/core/request-builder.js) emitting ONE input-neutral request struct from (skill, text/image, history, md-context) with no Gemini wire shape (PROV-02/SC4 groundwork)"
  - "Verbatim-relocated prompt assembly: formatUserMessage / formatImageInstruction / getIntelligentTranscriptionPrompt (byte-identical to llm.service.js)"
  - "node:test coverage (18 tests) pinning neutral output, history limits, filtering, and absence of wire keys"
affects: [02-02-gemini-provider-serialize, 02-03-facade-callsites, phase-03-local-provider, phase-05-md-context]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Provider contract as a base class whose default methods throw (subclass-must-override)"
    - "RequestBuilder = pure DI module: constructor({ sessionManager, promptLoader }) defaulting to real singletons; assembly-only, no wire serialization"
    - "Neutral request struct is the sole builder output shape: { kind, skill, systemPrompt, userText, images[], history[], mdContext }"

key-files:
  created:
    - src/services/providers/llm-provider.js
    - src/core/request-builder.js
    - test/request-builder.test.js
  modified: []

key-decisions:
  - "Neutral struct carries NO programmingLanguage field — it is an input used to assemble systemPrompt/userText via the verbatim helpers; response-side language enforcement remains the provider's concern (Plan 02-02)."
  - "Cap ownership matches today's architecture: RequestBuilder passes 15 (text) / 10 (transcription) to sessionManager.getConversationHistory (which slices); transcription additionally applies its own .slice(-8), replicated verbatim."
  - "buildImageRequest accepts a Buffer (.toString('base64'), matching today) OR an already-base64 string (passed through) for testability."
  - "Skipped the always-truthy dead defensive throws from the transcription/fallback originals (getIntelligentTranscriptionPrompt never returns falsy); preserved the reachable formatUserMessage empty-guard in the text history branch verbatim."

patterns-established:
  - "Byte-identical parity gate: a throwaway harness slices the original method source by line-range and diffs runtime output against the relocated copy across a skill x language matrix."

# Metrics
duration: 9min
completed: 2026-07-14
---

# Phase 2 Plan 01: Provider Seam Abstraction Skeleton Summary

**LLMProvider contract (generate/generateStream/isAvailable/testConnection) plus a pure DI RequestBuilder that assembles one input-neutral request struct — Gemini prompt/history logic carved out byte-identical, with zero changes to any call-site or the live Gemini service.**

## Performance

- **Duration:** 9 min
- **Started:** 2026-07-14T17:20:11Z
- **Completed:** 2026-07-14T17:29:50Z
- **Tasks:** 3
- **Files modified:** 3 (all created)

## Accomplishments
- `LLMProvider` base contract naming exactly the four locked interface methods (SC2), each throwing by default so providers must override.
- `RequestBuilder` produces ONE input-neutral struct for text/image/transcription with no Gemini wire keys (`contents`/`parts`/`systemInstruction`/`generationConfig`) anywhere — PROV-02/SC4 seam.
- Prompt assembly (`formatUserMessage`, `formatImageInstruction`, `getIntelligentTranscriptionPrompt`) relocated byte-identical, proven by a 432-assertion parity harness across 4 skills x 9 languages.
- Exact history behavior preserved: text 15-cap, transcription 10-then-last-8, system/empty filtering, trim, and `model→model / *→user` role mapping.
- Reuses Phase-1 skill normalization via the injected `promptLoader` (no re-implementation).

## Task Commits

Each task was committed atomically:

1. **Task 1: Define the LLMProvider interface contract** - `f190809` (feat)
2. **Task 2: Build the pure, DI-injectable RequestBuilder (neutral struct)** - `a5600f6` (feat)
3. **Task 3: node:test suite for RequestBuilder neutral output** - `6fd6d6e` (test)

**Plan metadata:** _(final docs commit — see below)_

## Files Created/Modified
- `src/services/providers/llm-provider.js` - Provider-agnostic contract; four throw-by-default interface methods; no config/registry/Gemini logic.
- `src/core/request-builder.js` - Pure DI RequestBuilder; three build methods emitting the neutral struct; verbatim prompt helpers; exact history limits/filtering/role-mapping.
- `test/request-builder.test.js` - 18 node:test cases with injected fake sessionManager + promptLoader; pins neutral shape, caps, filtering, wire-key absence, fallback branches, and md-context passthrough.

## Decisions Made
- **No `programmingLanguage` field on the neutral struct.** It is a build-time input (drives systemPrompt/userText via the verbatim helpers); response-side language enforcement stays with the provider (Plan 02-02). Matches the locked struct spec exactly.
- **Cap ownership left where it is today.** RequestBuilder requests `getConversationHistory(15|10)` (sessionManager slices) and, for transcription only, additionally applies `.slice(-8)` — replicating today's exact two-step transcription truncation rather than centralizing it.
- **`buildImageRequest` accepts Buffer or base64 string.** Buffer → `.toString('base64')` (matching today); an already-base64 string is passed through — keeps the method testable without a real image.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `_`-prefixed the intentionally-unused transcription `sessionMemory` param**
- **Found during:** Task 2 (RequestBuilder)
- **Issue:** `npx eslint .` (a hard Phase-1 gate) flagged `no-unused-vars` on `buildTranscriptionRequest`'s `sessionMemory` param — the transcription path genuinely never uses it (verbatim: the original transcription builders ignore session memory), but the positional slot must remain for Plan 02-03's call-sites.
- **Fix:** Renamed the param to `_sessionMemory` (the repo's established Phase-1 convention; eslint `argsIgnorePattern: '^_'`). Positional signature unchanged; `buildTextRequest` keeps `sessionMemory` since it IS used there.
- **Files modified:** src/core/request-builder.js
- **Verification:** `npx eslint src/core/request-builder.js` clean; parity harness re-run (432 assertions still pass).
- **Committed in:** `a5600f6` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Cosmetic param rename to satisfy the lint gate; no behavior or positional-contract change. No scope creep.

## Issues Encountered
- None beyond the lint-gate deviation above. Byte-identical relocation of `getIntelligentTranscriptionPrompt` was verified structurally (line-range source slice → runtime diff) rather than by eye to eliminate whitespace/escape drift risk.

## User Setup Required
None - no external service configuration required. This plan is pure, additive, network-free code.

## Next Phase Readiness
- **Plan 02-02** (Gemini provider): implement `GeminiProvider extends LLMProvider`, moving Gemini's neutral→wire serialization (`contents`/`parts`/`systemInstruction`/`generationConfig`) + cert-bypass/UA-override into the provider, consuming RequestBuilder's neutral struct.
- **Plan 02-03** (facade + call-sites): thin `llm.service.js` to delegate to provider + RequestBuilder with identical exports; call-sites unchanged.
- The god-files (`llm.service.js`, `main.js`, `session.manager.js`) remain byte-for-byte unchanged this plan — the verbatim originals are still the live path, so nothing is at risk until 02-03 wires the seam in.

## Self-Check: PASSED

- Files verified on disk: `src/services/providers/llm-provider.js`, `src/core/request-builder.js`, `test/request-builder.test.js`, `02-01-SUMMARY.md` — all FOUND.
- Commits verified in git: `f190809` (Task 1), `a5600f6` (Task 2), `6fd6d6e` (Task 3) — all FOUND.
- Gates: `npx eslint .` exit 0; `node --test test/*.test.js` → 56/56 pass; god-files (`llm.service.js`, `main.js`, `session.manager.js`) unchanged.

---
*Phase: 02-provider-seam-wrap-gemini-verbatim*
*Completed: 2026-07-14*
