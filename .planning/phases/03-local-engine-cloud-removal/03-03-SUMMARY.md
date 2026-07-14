---
phase: 03-local-engine-cloud-removal
plan: 03
subsystem: llm-provider
tags: [openai-sdk, ollama, local-llm, multimodal, streaming, serialize, provider-registry, PROV-03, PROV-04]

# Dependency graph
requires:
  - phase: 03-01
    provides: "openai ^6.47.0 dep (require-safe); config.llm = {provider,local,gemini} with llm.local {host,model,keepAlive,curatedModels} and provider defaulting 'local'"
  - phase: 02-abstraction-seam
    provides: "LLMProvider base contract (4 methods); RequestBuilder neutral struct (images as {data,mimeType}); provider registry + thin llm.service facade (getSelected())"
provides:
  - "LocalProvider: text streaming (PROV-03) + multimodal screenshot (PROV-04, no OCR) over 127.0.0.1:11434/v1 via the openai SDK"
  - "serialize() as the single OpenAI wire-shape site (SC4): system prefix, model->assistant history rename, base64 data-URL image_url parts"
  - "Full main.js call-site surface mirrored byte-compatibly ({response, metadata}); registry selects from config.llm.provider (Local default), Gemini stays selectable"
  - "Network-free serialize/graceful-degrade unit test (12 assertions)"
affects: [03-04, 03-06, 03-07, 03-08, PROV-07]

# Tech tracking
tech-stack:
  added: ["openai SDK v6.47.0 (LocalProvider transport, baseURL=host/v1, apiKey:'ollama')"]
  patterns:
    - "serialize-only provider (SC4): no prompt/skill/history logic in the provider; RequestBuilder owns assembly"
    - "Full-surface mirror of GeminiProvider so the facade re-export keeps every main.js llmService.* call-site unchanged"
    - "Config-driven registry selection with a hardened getSelected() that never returns undefined"

key-files:
  created:
    - "src/services/providers/local.provider.js"
    - "test/local-provider.test.js"
  modified:
    - "src/services/providers/index.js"

key-decisions:
  - "openai SDK (not the Gemini-shaped hand-rolled SSE parser) for transport; keep_alive:-1 passed in the request body as defense-in-depth (authoritative resident mechanism is LocalModelManager's warm-up in 03-04)"
  - "Image part is the nested {url:'data:<mime>;base64,<b64>'} object per RESEARCH Flag 2 (bare-string variant superseded)"
  - "Request/error counters live only in the process* methods, not in generate/generateStream, so a process* -> generateStream delegation counts once (mirrors GeminiProvider)"
  - "generateIntelligentFallbackResponse reworded model-availability-oriented (reused by 03-06 Local-down UX); Gemini kept registered through the transition window (removed at PROV-07)"

patterns-established:
  - "LocalProvider.serialize(): neutral -> OpenAI {model, messages}; mdContext appended to the system prefix (wired now, empty until Phase 5)"
  - "process*Stream: RequestBuilder.build*Request -> generateStream -> byte-compatible {response, metadata}; degrade to canned fallback on throw"

# Metrics
duration: 10min
completed: 2026-07-14
---

# Phase 3 Plan 03: LocalProvider (text stream + screenshot over /v1) Summary

**LocalProvider streams text (PROV-03) and answers screenshots multimodal-direct (PROV-04, no OCR) from `qwen3-vl:8b` over the OpenAI-compatible `127.0.0.1:11434/v1` endpoint via the `openai` SDK; registered as the config-selected default while Gemini stays selectable, with all wire-shape + graceful-degrade behavior proven network-free.**

## Performance

- **Duration:** 10 min
- **Started:** 2026-07-14T20:48:22Z
- **Completed:** 2026-07-14T20:58Z
- **Tasks:** 3
- **Files modified:** 3 (2 created, 1 modified)

## Accomplishments
- `LocalProvider extends LLMProvider` with `serialize()` as the single OpenAI wire-shape site (SC4): system prefix (`systemPrompt` + `mdContext`), neutral `'model'`->`'assistant'` history rename, and base64 data-URL `image_url` parts — no prompt/skill/history logic in the provider.
- `generate`/`generateStream` stream via `openai` `chat.completions.create` (`keep_alive` in the body); the full main.js call-site surface (`process{Image,Text,Transcription}*Stream`, `generateIntelligentFallbackResponse`, `getStats`, `updateApiKey`, `checkNetworkConnectivity`, `testConnection`, `initializeClient`) returns byte-compatible `{response, metadata}` so every `llmService.*` consumer keeps working with zero main.js edits.
- Registry now selects from `config.get('llm.provider')` (Local default) with a hardened `getSelected()` that never returns undefined; Gemini stays registered/selectable for the transition window.
- Graceful degradation throughout: network-free constructor (never throws with Ollama down), canned model-availability fallback so the overlay never blanks.
- 12 network-free tests added (75/75 repo suite green; whole-repo eslint exit 0).

## Task Commits

Each task was committed atomically (explicit pathspec — parallel-safe alongside 03-04):

1. **Task 1: serialize() + 4 interface methods + openai client** - `6e3b799` (feat)
2. **Task 2: mirror GeminiProvider's full main.js call-site surface** - `0d9a902` (feat)
3. **Task 3: register LocalProvider + network-free serialize/degrade test** - `38cbb1a` (feat)

_(Sibling plan 03-04 committed `e7b5fb0` interleaved on the same branch; not part of this plan.)_

## Files Created/Modified
- `src/services/providers/local.provider.js` - LocalProvider: constructor/initializeClient (network-free openai client), serialize (the SC4 wire-shape site), generate/generateStream (streaming via openai SDK), testConnection (1-token ping), full main.js surface, enforceProgrammingLanguage (verbatim from GeminiProvider), local health probe.
- `src/services/providers/index.js` - Registry registers `{gemini, local}`; `selected = config.get('llm.provider')` (was hardcoded `'gemini'`); `getSelected()` hardened with local->gemini fallback.
- `test/local-provider.test.js` - node:test, network-free: serialize() OpenAI shape (system prefix, model->assistant, single + multi image_url data-URLs, plain-string no-image content), graceful-degrade, registry+facade resolve Local by default with Gemini still registered.

## Decisions Made
- **Transport:** `openai` SDK over a hand-rolled parser (the existing one is Gemini-shaped); `keep_alive:-1` sent in the request body as defense-in-depth — the openai SDK passes unknown body fields through, and the authoritative resident mechanism is LocalModelManager's warm-up (03-04).
- **Counters only in process\*:** `requestCount`/`errorCount` increment in the process* methods, not in `generate`/`generateStream`, so a `process* -> generateStream` delegation counts exactly once (mirrors GeminiProvider's design).
- **Fallback reworded** to model-availability guidance ("Local model unavailable — restart Ollama or re-download from Settings"), reused by the 03-06 Local-down UX.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `enforceProgrammingLanguage` authored in the Task 1 commit (plan slotted it in Task 2)**
- **Found during:** Task 1 (generate/generateStream)
- **Issue:** Task 1's `generate`/`generateStream` call `this.enforceProgrammingLanguage(...)` when a language is set; committing Task 1 without the helper would leave the commit referencing an undefined method.
- **Fix:** Copied the pure post-processor verbatim from `gemini.provider.js:651` into the Task 1 commit so each commit is self-consistent. Task 2's verify (method present) still holds.
- **Files modified:** src/services/providers/local.provider.js
- **Verification:** Task 1 + Task 2 surface checks pass; eslint 0.
- **Committed in:** 6e3b799 (Task 1 commit)

**2. [Rule 3 - Blocking] `_sessionMemory` rename in `processImageWithSkillStream`**
- **Found during:** Task 2 (eslint gate)
- **Issue:** The image path does not use `sessionMemory` (buildImageRequest takes no history), so `no-unused-vars` failed the required whole-repo eslint gate.
- **Fix:** Prefixed the positional param `_sessionMemory` (positional order preserved for main.js) — matches GeminiProvider's own `_sessionMemory` convention on its image method.
- **Files modified:** src/services/providers/local.provider.js
- **Verification:** `npx eslint .` exit 0.
- **Committed in:** 0d9a902 (Task 2 commit)

**3. [Rule 2 - Defensive] `neutral.history || []` guard in serialize()**
- **Found during:** Task 1
- **Issue:** The plan's literal snippet iterates `neutral.history` unguarded; a hand-built/edge neutral without `history` would throw (violating never-crash).
- **Fix:** `for (const h of neutral.history || [])` — no output change for valid RequestBuilder neutrals (which always set `history: []`).
- **Files modified:** src/services/providers/local.provider.js
- **Verification:** serialize tests pass.
- **Committed in:** 6e3b799 (Task 1 commit)

---

**Total deviations:** 3 auto-fixed (2 blocking, 1 defensive)
**Impact on plan:** All trivial and behavior-preserving — commit self-consistency, the required lint gate, and a never-crash guard. No scope creep; no wire-shape or contract change.

## Issues Encountered
- ESLint `no-unused-vars` (`args: 'after-used'`) still flagged the image method's unused `sessionMemory` even though used args follow it; resolved via the `_` prefix (deviation 2).

## User Setup Required
None - no external service configuration required. (Live streaming round-trip against a real Ollama daemon with `qwen3-vl:8b` pulled is proven separately in 03-07.)

## Next Phase Readiness
- **03-04 (LocalModelManager):** LocalProvider passes `keep_alive:-1` per request; 03-04 owns the adopt/own daemon lifecycle + warm-up that makes residency authoritative. No shared files touched.
- **03-06 (Local-down UX):** `generateIntelligentFallbackResponse` + `getStats().provider/model/host` + `checkNetworkConnectivity` (local `/api/version` + `/v1/models` probe) are ready for the recovery UI.
- **03-07 (prove):** live TTFT/memory + streaming round-trip needs a real daemon + pulled model — the only unproven bit here (all wire-shape + degrade is network-free proven).
- **03-08 / PROV-07 (remove Gemini):** drop `gemini` from the registry + config; `getSelected()` already falls back to Local.

---
*Phase: 03-local-engine-cloud-removal*
*Completed: 2026-07-14*

## Self-Check: PASSED
- Files: src/services/providers/local.provider.js, src/services/providers/index.js, test/local-provider.test.js, 03-03-SUMMARY.md — all present.
- Commits: 6e3b799 (Task 1), 0d9a902 (Task 2), 38cbb1a (Task 3) — all present.
- Gates: `node --test test/*.test.js` 75/75; `npx eslint .` exit 0; each commit touched only this plan's files (no cross-contamination with 03-04).
