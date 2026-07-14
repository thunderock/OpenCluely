# Phase 2: Provider Seam — Wrap Gemini Verbatim - Context

**Gathered:** 2026-07-13
**Status:** Ready for planning

<domain>
## Phase Boundary

Introduce an `LLMProvider` abstraction and a `RequestBuilder`, and move today's Gemini
code behind them so the app answers on-demand **screenshot, voice, and typed-chat**
questions **exactly as before** — with every `main.js` / `sessionManager`
(`src/managers/session.manager.js`) call-site byte-for-byte unchanged. This is the
sequencing keystone: the abstraction lands FIRST, Gemini is wrapped verbatim, and
**nothing is removed** (Gemini + Azure removal is Phase 3, never removal-first — Pitfall 12).

Requirements delivered: **PROV-01, PROV-02**.

**In scope for this phase:**
- Define the `LLMProvider` interface: `generate` / `generateStream` / `isAvailable` / `testConnection`.
- Register Gemini as a provider implementing it; move the Gemini logic verbatim into a provider module.
- Shrink `src/services/llm.service.js` (1654-line god-file) into a thin facade with identical exports that delegates to the provider + RequestBuilder.
- Relocate the Gemini-specific cert-verify bypass + User-Agent override inside the Gemini provider, applied only when Gemini is the active provider.
- Build `RequestBuilder`: turn (skill, text/image, history, md-context) into one neutral input struct; no prompt logic in providers.
- Golden/parity tests on the pure pieces + manual smoke of the three entry points (both streaming and non-streaming).

**Explicitly NOT in scope (deferred — do not pull in):**
- Any second provider / the Local (Ollama `qwen3-vl`) engine — Phase 3.
- Removing Gemini or Azure, or a user-facing provider switch — Phase 3.
- CLI backup providers (Claude/Codex) — Phase 7.
- Wiring a real md-context *source* — Phase 5 (the RequestBuilder input exists now but is empty/unused until then).

## Locked (do not re-ask / do not re-litigate)

Locked by the ROADMAP Success Criteria + PROV-01/02:
- **Interface methods** are fixed: `generate`, `generateStream`, `isAvailable`, `testConnection`. (SC2)
- **Facade contract:** `llm.service` keeps **identical exports**; every `main.js` / `sessionManager` call-site is unchanged. (SC1, SC2)
- **Cert-bypass + UA-override** must move OUT of unconditional global startup and INTO the Gemini provider, active only when Gemini is selected — so they vanish cleanly at removal. (SC3)
- **RequestBuilder owns prompt assembly:** one neutral request shape from (skill, text/image, history, md-context); **no prompt logic inside any provider**. (SC4, PROV-02)
- **Sequencing:** abstraction first, Gemini wrapped verbatim, nothing removed this phase. (roadmap load-bearing rule)

Tech constraints carried from Phase 1 (still binding):
- **CommonJS + vanilla JS**, no bundler / TypeScript / framework; match existing conventions (incl. the `assests/` misspelling).
- **Logging:** `require('./core/logger').createServiceLogger('<TAG>')`, `logger.<level>(msg, metaObject)` — never interpolate variable data into the message.
- **Error philosophy:** degrade gracefully, never crash.
- **Test net:** Node's built-in `node:test` / `node --test` (added Phase 1); no new test framework.

</domain>

<decisions>
## Implementation Decisions

### Provider selection & config
- **Active provider is a hardcoded default (`gemini`).** A registry + a "selected provider" notion exist (SC3 needs "when Gemini is selected" to mean something), but there is **no user-facing config/env switch** this phase — there's no real alternative to switch to until Local lands. The config-driven switch (`LLM_PROVIDER` or similar) is added in Phase 3.
- **Gemini config stays exactly where it is today** (API key, model name, endpoint). The provider reads the same config from the same place. **No per-provider config restructuring** now — reorganize into per-provider blocks in Phase 3 when Local needs its own.
- **`isAvailable` / `testConnection` mirror today's behavior verbatim** — wrap whatever Gemini already does (e.g. API-key-present check + the existing test path) into these methods. No new availability semantics this phase.

### Verbatim strictness (how much to touch while wrapping)
- **Move Gemini logic verbatim.** Relocate the existing Gemini code into the provider module as close to byte-identical as possible — only the mechanical changes needed to fit the interface. No logic rewrite, no opportunistic refactor. Matches "wrap verbatim" + Phase 1's no-mass-reformat ethos and keeps the parity diff reviewable.
- **Cert-bypass + UA-override: relocate verbatim, gate on selection.** Same bypass/UA logic, moved into the provider and applied only when Gemini is the active provider. No behavior change while Gemini is active; clean removal later. **Isolate the Gemini-specific bypass** (in `main.js` global startup + `llm.service.js`) from the **Azure/STT** cert/UA handling in `speech.service.js` — only the Gemini one moves this phase; the STT one is Phase 3/4's concern. (`main-window.js` also touches UA — confirm which, if any, is Gemini-relevant.)
- **`llm.service.js` becomes a thin facade** with identical exports, delegating to a **separate Gemini provider module** + RequestBuilder. The bulk of the 1654-line god-file's LLM logic moves out into the provider. (Satisfies SC2 and de-risks Phase 3.)

### Request shape & RequestBuilder↔provider boundary
- **Input-neutral request struct.** RequestBuilder emits a clean struct of the **known inputs** (skill, text, image[], history, md-context); **each provider serializes** that to its own wire format. This satisfies PROV-02's "one neutral request shape" without guessing Local's still-unknown request format (Phase 3 research item) — do NOT over-abstract into a fully generic message model now.
- **Gemini wire-formatting lives in the provider's serialize step.** RequestBuilder owns prompt/skill/system/history **assembly**; the Gemini provider maps the neutral struct to Gemini's `contents`/`parts` wire format + role naming. Clean removal boundary — no Gemini shape leaks into the shared builder.
- **RequestBuilder owns conversation-history assembly and truncation/limits, replicating today's exact behavior/limits** so answers don't drift. Clean ownership + parity.
- **md-context input exists in the struct now but is empty/unused** until its source ships in Phase 5. Include the parameter (per SC4) so the contract is stable; don't build a source.

### Parity verification
- **"Exactly as before" = byte-identical outgoing request.** Snapshot the request payload the app sends to Gemini today; assert the refactored seam (RequestBuilder + Gemini serialization) produces the **identical payload**. Strongest anti-drift guard; immune to LLM answer variance.
- **Test strategy: golden tests on the pure pieces + manual smoke.** Unit/golden-test the network-free pieces — RequestBuilder's neutral output and the Gemini neutral→wire serialization — with `node:test`; manually smoke the three live entry points (screenshot, voice, typed-chat). No mocked-transport integration layer this phase.
- **Cover both `generate` and `generateStream`** in golden tests + smoke — they are distinct code paths that can regress independently.

### Claude's Discretion
Within the locked decisions, the planner/researcher decide:
- Exact module paths/names for the Gemini provider and RequestBuilder (follow repo conventions; likely `src/core/` or a `src/services/providers/` dir).
- The registry's concrete shape and how the "selected provider" default is expressed.
- The precise neutral-struct field names/types, and the snapshot/golden-fixture mechanism (how the "today's request" baseline is captured for the byte-identical assertion).
- How to make the Gemini serialization testable without network (the seam to inject/capture the outgoing request), mirroring Phase 1's DI-for-testability approach.

</decisions>

<specifics>
## Specific Ideas

- **Follow Phase 1's extract-for-testability pattern.** Phase 1 pulled pure logic (`.env`, skill-normalizer, VAD) out of self-initializing singletons into `src/core/` modules so they're unit-testable; `RequestBuilder` should be a pure, dependency-free module in the same spirit, and the Gemini provider should expose a seam (inject/capture the outgoing request or the transport) so its serialization is testable without a live call — the same DI shape `WhisperInstaller` / `ServiceSupervisor` use (export the class, inject the spawn/transport fn).
- **Reuse the Phase 1 skill/prompt normalization.** `src/core/skill-normalizer.js` (skill-name + programming-language injection) already exists — RequestBuilder should consume it rather than re-implement skill/prompt normalization.
- **Golden baseline capture BEFORE refactoring.** Capture the exact outgoing Gemini request for representative screenshot / voice / typed-chat inputs (and one streaming case) as the golden fixtures the post-refactor seam must reproduce byte-for-byte.
- **The god-files are the target.** `src/services/llm.service.js` (1654 lines) is the LLM god-file to thin into a facade; `main.js` (1855 lines) + `src/managers/session.manager.js` hold the call-sites that must not change.
- **Cert/UA today is spread out.** `NODE_TLS_REJECT_UNAUTHORIZED` / `rejectUnauthorized` / User-Agent handling appears in `main.js`, `llm.service.js`, `speech.service.js`, and `main-window.js`. The researcher must disentangle the Gemini-relevant bits (which move into the provider) from the Azure/STT bits (which stay for now).

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope. (Local/Ollama engine, cloud removal, user-facing provider switch → Phase 3; md-context source → Phase 5; CLI backup providers → Phase 7 — all already on the roadmap, none newly surfaced here.)

</deferred>

---

*Phase: 02-provider-seam-wrap-gemini-verbatim*
*Context gathered: 2026-07-13*
