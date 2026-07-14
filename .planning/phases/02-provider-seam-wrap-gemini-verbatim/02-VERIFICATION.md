---
phase: 02-provider-seam-wrap-gemini-verbatim
verified: 2026-07-14T18:24:39Z
status: passed
score: 4/4 must-haves verified
caveats:
  - "SC1's live-Gemini 3-entry-point smoke (screenshot/voice/typed-chat against the real API) is WAIVED by design — no GEMINI_API_KEY exists in this environment (cloud removal is the project's goal) and this path was never runnable here. Per task instructions this is NOT treated as a gap. Verified instead by: (a) byte-identical golden parity (63/63 tests, 7 parity-specific) proving the outgoing request is unchanged for text/image/transcription across both generate and generateStream, (b) zero `llmService.*` call-site diff in main.js/session.manager.js, (c) verbatim relocation of the live transport code (unchanged code fed a byte-identical request). True end-to-end verification is deferred to Phase 3 (keyless Local provider)."
---

# Phase 2: Provider Seam — Wrap Gemini Verbatim Verification Report

**Phase Goal:** An `LLMProvider` abstraction exists with the existing Gemini code wrapped verbatim behind it, and the app still answers exactly as before — this is the sequencing keystone (never removal-first).
**Verified:** 2026-07-14T18:24:39Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria, used directly)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | The app still answers on-demand screenshot, voice, and typed-chat questions via Gemini exactly as before — every `main.js` / `sessionManager` call-site is unchanged. | VERIFIED (live smoke waived by design, not a gap) | `git diff a5bde38 HEAD -- src/managers/session.manager.js` is empty (zero changes). `git diff a5bde38 HEAD -- main.js` shows ONLY the `setupNetworkConfiguration()` body changed (10 insertions/20 deletions); all 11 `llmService.*` call-sites (lines 584, 585, 589, 619, 624, 625, 1029, 1096, 1263, 1315, 1566) present and byte-identical. Byte-identical golden parity: `node --test test/gemini-request-parity.test.js` → 7/7 pass, proving `serialize(RequestBuilder.build*Request())` reproduces the committed goldens for text/image/transcription AND that `generate`/`generateStream` construct the identical request. Re-ran `node scripts/capture-gemini-goldens.js` against the POST-refactor facade (live re-capture) — `git diff --stat -- test/fixtures/gemini-requests/` was empty, i.e., the current code reproduces the exact same fixtures already committed. Live 3-entry-point smoke against real Gemini is WAIVED (no `GEMINI_API_KEY` in this environment; deferred to Phase 3 per task instructions). |
| 2 | An `LLMProvider` interface (`generate`/`generateStream`/`isAvailable`/`testConnection`) exists, and Gemini is registered as a provider implementing it behind a thin `llm.service` facade with identical exports. | VERIFIED | `src/services/providers/llm-provider.js` (29 lines) declares exactly the 4 methods, each throwing by default. `src/services/providers/gemini.provider.js`: `class GeminiProvider extends LLMProvider` implementing all 4. `src/services/providers/index.js`: registry `{ providers:{gemini}, selected:'gemini', register, get, getSelected }`. `src/services/llm.service.js` is a 17-line facade: `module.exports = providers.getSelected();`. Ran `node -e "const s=require('./src/services/llm.service.js'); console.log(s.constructor.name)"` → logs `Session memory initialized`, `WARN [LLM] Gemini API key not configured` (graceful, no throw), prints `GeminiProvider` — exactly as specified. Programmatic check confirms all 9 methods `main.js` calls (`initializeClient, updateApiKey, getStats, testConnection, checkNetworkConnectivity, processImageWithSkillStream, processTextWithSkillStream, processTranscriptionWithIntelligentResponseStream, generateIntelligentFallbackResponse`) are functions, plus the 4 interface methods. |
| 3 | The Gemini-specific cert-verify bypass and User-Agent override now live inside the Gemini provider (active only when Gemini is selected), not as unconditional global startup code. | VERIFIED | `gemini.provider.js:239` — `configureNetworkSession(ses)` holds the verbatim `onBeforeSendHeaders` UA-override + `setCertificateVerifyProc` hostname-guarded blocks (exact UA string, `callback(0)`/`callback(-2)`). `main.js` `setupNetworkConfiguration()` (line 289) now does `require('./src/services/providers').getSelected()` then calls `provider.configureNetworkSession(ses)` gated on `typeof === 'function'`. `grep -n "generativelanguage.googleapis.com\|setCertificateVerifyProc" main.js` → zero hits (no longer inline). Isolation held: `git diff a5bde38 HEAD --stat -- src/services/speech.service.js src/ui/main-window.js` is empty — Azure/STT UA (`speech.service.js:5`) and platform-detection UA (`main-window.js:653-656`) untouched. |
| 4 | A `RequestBuilder` produces one neutral request shape from (skill, text/image, history, md-context), with no prompt logic living inside any provider. | VERIFIED | `src/core/request-builder.js` (228 lines) emits `{ kind, skill, systemPrompt, userText, images[], history[], mdContext }` for text/image/transcription. `formatUserMessage`/`formatImageInstruction`/`getIntelligentTranscriptionPrompt` live ONLY in `request-builder.js` — `grep` for these in `gemini.provider.js` returns zero hits. `test/request-builder.test.js` (18 tests) asserts `contents`/`parts`/`systemInstruction`/`generationConfig` are absent from every neutral struct, and pins the exact history caps (15 for text; 10-then-`.slice(-8)` for transcription) with filtering/role-mapping. RequestBuilder reuses Phase-1 skill normalization via `require('../../prompt-loader').promptLoader`, which itself requires `./src/core/skill-normalizer` — confirmed by inspection (no re-implementation). |

**Score:** 4/4 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/services/providers/llm-provider.js` | `LLMProvider` contract: generate/generateStream/isAvailable/testConnection | VERIFIED | 29 lines; 4 methods, each throws `'LLMProvider.<method> not implemented'`; no config/registry/Gemini logic. |
| `src/core/request-builder.js` | Pure DI RequestBuilder emitting the neutral struct | VERIFIED | 228 lines; `constructor({sessionManager, promptLoader})` DI with real-singleton defaults; 3 build methods; verbatim prompt helpers; no wire keys (proven by test). |
| `test/request-builder.test.js` | node:test coverage of neutral output | VERIFIED | 18 tests, all passing; covers caps, filtering, role-mapping, wire-key absence, fallback branches, mdContext passthrough. |
| `src/services/providers/gemini.provider.js` | GeminiProvider: verbatim transport + serialize() + 4 interface methods + configureNetworkSession | VERIFIED | 1491 lines; `class GeminiProvider extends LLMProvider`; `serialize()` single wire-mapper (contents→generationConfig→systemInstruction key order); `generate`/`generateStream`/`isAvailable`/`testConnection` implemented; `configureNetworkSession` present with verbatim cert/UA blocks. |
| `src/services/providers/index.js` | Provider registry with hardcoded default 'gemini' | VERIFIED | 33 lines; `providers:{gemini}`, `selected:'gemini'`, `register/get/getSelected`. |
| `test/gemini-request-parity.test.js` | Byte-identical golden assertion across generate/generateStream | VERIFIED | 7 tests, all passing; string-equal comparison against committed fixtures; explicit stream==non-stream assertion. |
| `test/fixtures/gemini-requests/{text,image,transcription}.json` | Golden outgoing Gemini requests captured from original code | VERIFIED | Present; re-generating them from the CURRENT (post-facade-flip) code via `node scripts/capture-gemini-goldens.js` produced byte-identical output (`git diff` empty) — the fixtures still describe live behavior, not a stale snapshot. |
| `src/services/llm.service.js` | Thin facade, identical exports | VERIFIED | 1654 lines → 17 lines. `module.exports = providers.getSelected()`. All 9 methods present; loads keyless without throwing. |
| `main.js` | `setupNetworkConfiguration` delegates cert/UA to selected provider (gated); LLM call-sites unchanged | VERIFIED | Only the method body changed (30 lines touched total in the whole phase); all `llmService.*` call-sites unchanged. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `src/core/request-builder.js` | `src/core/skill-normalizer.js` | prompt-loader delegation | WIRED | `request-builder.js` requires `../../prompt-loader` → `prompt-loader.js:3` requires `./src/core/skill-normalizer` (Phase 1 module); no re-implementation. |
| `src/services/providers/gemini.provider.js` | `src/core/request-builder.js` | `this.serialize(this.requestBuilder.build*Request(...))` | WIRED | Confirmed in all 6 `process*` methods and `generate`/`generateStream`. |
| `src/services/providers/gemini.provider.js` | `src/services/providers/llm-provider.js` | `extends LLMProvider` | WIRED | Confirmed; `new GeminiProvider()` passes `instanceof` checks implicitly via `super()`. |
| `test/gemini-request-parity.test.js` | `test/fixtures/gemini-requests/*.json` | byte-identical string comparison | WIRED | 7/7 tests pass; independently re-verified by re-running the capture script against current code — zero diff. |
| `src/services/llm.service.js` | `src/services/providers/index.js` | `require('./providers').getSelected()` | WIRED | Facade re-exports the registry-selected singleton (non-destructured, preserving `this` binding). |
| `main.js setupNetworkConfiguration` | `gemini.provider.configureNetworkSession` | gated selected-provider delegation | WIRED | `main.js:289-297` calls `require('./src/services/providers').getSelected()` then `provider.configureNetworkSession(ses)` only if the method exists. |
| `main.js` `llmService.*` call-sites | `src/services/llm.service.js` facade | unchanged export surface | WIRED, UNCHANGED | All 11 call-sites present, byte-for-byte identical (`git diff` shows no change to these lines). |

### Requirements Coverage

| Requirement | Status | Blocking Issue |
|-------------|--------|----------------|
| PROV-01 — `LLMProvider` interface exists; Gemini wrapped verbatim as a provider; every `main.js` call-site unchanged | SATISFIED | None |
| PROV-02 — `RequestBuilder` converts (skill, text/image, history, md-context) into one neutral request shape shared by all providers; no prompt logic inside providers | SATISFIED | None |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/services/providers/llm-provider.js` | 10,15,20,25 | `throw new Error('...not implemented')` | None (by design) | Intentional base-class contract — a provider MUST override; not a stub of a concrete provider. |

No TODO/FIXME/HACK/PLACEHOLDER comments, no empty stub returns, and no console.log-only implementations found in any file touched this phase (`llm-provider.js`, `gemini.provider.js`, `index.js`, `request-builder.js`, `llm.service.js`, `main.js`). No scope creep detected: no `Local`/`Ollama`/`LLM_PROVIDER` switch code exists yet (only a forward-looking comment referencing Phase 3); Azure/STT code is untouched (removal correctly deferred to Phase 3, honoring "never removal-first").

### Ground-Truth Command Results

- `node --test test/*.test.js` → **63/63 pass** (10 suites, 0 fail).
- `npx eslint .` → **exit 0**.
- `make lint` / `make run_tests` (Phase 1 CI gates) → both green, unaffected.
- `node -e "const s=require('./src/services/llm.service.js'); console.log(s.constructor.name)"` → logs `Session memory initialized`, `WARN [LLM] Gemini API key not configured`, prints `GeminiProvider` — loads without throwing, degrades gracefully. Matches expected output exactly.
- `git diff a5bde38 HEAD --stat` (whole phase vs. phase-1-complete baseline) confirms: `main.js` (+10/-20, `setupNetworkConfiguration` only), `src/managers/session.manager.js` (untouched, not listed), `src/core/config.js` (untouched, not listed), `src/services/llm.service.js` (1654→17 lines), plus purely additive new files (`gemini.provider.js`, `request-builder.js`, `llm-provider.js`, `providers/index.js`, capture script, fixtures, tests).

### Human Verification Required

None required to close this phase. The one item that would normally need human/live verification — the 3-entry-point Gemini smoke test (screenshot/voice/typed-chat against the real API) — is explicitly WAIVED per task instructions: no `GEMINI_API_KEY` exists in this environment (the project's entire goal is removing the cloud dependency), so this path was never runnable here and is not a meaningful regression check for code slated for deletion in Phase 3. The byte-identical golden parity tests plus the verbatim relocation of the transport code provide the strongest available anti-drift guarantee, and true end-to-end verification is deferred to Phase 3's keyless Local provider.

### Gaps Summary

No gaps. All four Success Criteria are verified against the actual codebase (not just SUMMARY claims): the `LLMProvider` interface exists with exactly the 4 locked methods; Gemini's logic was relocated behind it with byte-identical golden-test proof (independently re-verified by re-running the capture script against the current, post-facade-flip code); the facade preserves an identical 9-method export surface with zero `main.js`/`session.manager.js` call-site drift; the cert-verify bypass + UA override moved into the provider and are gated on selection, with Azure/STT isolation intact; and `RequestBuilder` is the sole owner of prompt/history assembly with no wire-format leakage into any provider. Both PROV-01 and PROV-02 are satisfied. The only unmet item — the live-Gemini smoke — is a documented, in-scope waiver per the verification brief, not a gap.

---

*Verified: 2026-07-14T18:24:39Z*
*Verifier: Claude (gsd-verifier)*
