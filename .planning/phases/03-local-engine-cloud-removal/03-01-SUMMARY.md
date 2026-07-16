---
phase: 03-local-engine-cloud-removal
plan: 01
subsystem: infra
tags: [openai, ollama, config, provider-selection, cjs, ollama-lifecycle]

# Dependency graph
requires:
  - phase: 02-llm-abstraction
    provides: provider registry + thin facade (providers.getSelected) that will later read config.llm.provider; RequestBuilder neutral struct that LocalProvider will serialize
provides:
  - "openai ^6.47.0 (CJS-safe) — LocalProvider /v1 inference transport"
  - "ollama ^0.6.3 (CJS-safe) — LocalModelManager daemon lifecycle (pull/ps/list)"
  - "config.llm.provider selector — default 'local', overridable via LLM_PROVIDER (registry NOT flipped yet)"
  - "config.llm.local per-provider block — host (OLLAMA_BASE_URL), model (LOCAL_MODEL), keepAlive -1, curatedModels"
  - "config.llm.gemini block preserved verbatim for the Phase-3 transition window"
affects: [03-03-local-provider, 03-04-local-model-manager, 03-07-proven-gate, 03-08-gemini-removal]

# Tech tracking
tech-stack:
  added: ["openai ^6.47.0", "ollama ^0.6.3"]
  patterns:
    - "Per-provider config blocks under llm.{provider,local,gemini} with an env-overridable selector"
    - "Env reads inline in the config object literal, evaluated at singleton construction (after dotenv) — matches the existing this.env pattern"
    - "CJS-safe transport deps only; port/spawn/fetch plumbing uses node:child_process / global fetch / net instead of ESM-only get-port/execa/node-fetch"

key-files:
  created: []
  modified:
    - "package.json — openai + ollama added to dependencies"
    - "package-lock.json — lockfile updated (npm ci parity confirmed)"
    - "src/core/config.js — llm restructured into provider/local/gemini"

key-decisions:
  - "Locked transport deps: openai ^6.x (/v1 inference) + ollama ^0.6.x (daemon lifecycle); both ship a require() build. No get-port/execa/node-fetch (ESM-only, throw on require in this CJS app)."
  - "llm.provider defaults to 'local' but the registry is NOT flipped here — the app stays on the proven Gemini path until 03-03 wires providers.getSelected() to the key (never removal-first sequencing)."
  - "llm.gemini block kept byte-for-byte — Phase-2 golden parity asserts config.get('llm.gemini.generation'); it is deleted only at PROV-07 (03-08)."
  - "speech.* left untouched — Azure STT removal is deferred to Phase 4 (STT-05), isolated from this LLM-provider work."

patterns-established:
  - "Per-provider config block + env-overridable provider selector (config half of PROV-06)"
  - "CJS/ESM guardrail: transport deps must be require()-safe; verified with a require() smoke before use"

# Metrics
duration: ~3 min
completed: 2026-07-14
---

# Phase 3 Plan 01: Local-Engine Foundation (deps + per-provider config) Summary

**Installed the two CJS-safe transport deps (openai ^6.47.0, ollama ^0.6.3) and restructured `config.llm` into `provider`/`local`/`gemini` blocks with a Local-default, env-overridable selector — without flipping the registry, so the app keeps running on the proven Gemini path.**

## Performance

- **Duration:** ~3 min
- **Started:** 2026-07-14T20:25:57Z
- **Completed:** 2026-07-14 (see final commit)
- **Tasks:** 2
- **Files modified:** 3 (package.json, package-lock.json, src/core/config.js)

## Accomplishments
- Added `openai ^6.47.0` + `ollama ^0.6.3` to `dependencies`; both `require()` without throwing (verified `require-ok`), and no ESM-only deps were introduced.
- Restructured `config.llm` into a `provider` selector + a `local` per-provider block, while preserving the `gemini` block verbatim.
- `provider` defaults to `'local'` and honors `LLM_PROVIDER`; `local.host`/`local.model` honor `OLLAMA_BASE_URL`/`LOCAL_MODEL`.
- Kept the registry unchanged: `require('./src/services/llm.service')` still resolves to `GeminiProvider`, so the proven path is untouched (honors never-removal-first sequencing).

## Task Commits

Each task was committed atomically (explicit pathspec — parallel-safe with plan 03-02):

1. **Task 1: Install openai + ollama (CJS-safe transport deps)** - `794ce1f` (chore)
2. **Task 2: Restructure config.llm into per-provider blocks + selector** - `0b2cea6` (feat)

**Plan metadata:** see final `docs(03-01)` commit.

## Files Created/Modified
- `package.json` - added `openai ^6.47.0` + `ollama ^0.6.3` to `dependencies` (additions only; `@google/genai` + Azure SDK untouched).
- `package-lock.json` - lockfile updated (+73/-26); one benign change was npm deduping a nested `ws` under `@google/genai` (the package itself remains present + require-safe).
- `src/core/config.js` - `llm` now `{ provider, local, gemini }`: `provider = process.env.LLM_PROVIDER || 'local'`; `local = { host: OLLAMA_BASE_URL||'http://127.0.0.1:11434', model: LOCAL_MODEL||'qwen3-vl:8b', keepAlive: -1, curatedModels: [...] }`; `gemini` block preserved byte-for-byte.

## Verification
- `require('openai')` and `require('ollama')` → `require-ok` (both CJS-safe).
- `config.get('llm.provider')` = `local`; `config.get('llm.local.model')` = `qwen3-vl:8b`; `config.get('llm.local.host')` = `http://127.0.0.1:11434`; `config.get('llm.gemini.generation')` still resolves (truthy).
- `LLM_PROVIDER=gemini` → `provider` = `gemini`; `OLLAMA_BASE_URL`/`LOCAL_MODEL` overrides applied; `speech.provider` still `azure` (untouched).
- Registry unchanged → `llm.service` constructor is `GeminiProvider` (graceful "Gemini API key not configured" WARN, no throw).
- `npx eslint .` exit 0; `node --test test/*.test.js` → 63/63 pass, 0 fail; `npm ci --dry-run` reports lockfile parity.

## Decisions Made
See `key-decisions` in frontmatter. In brief: transport deps locked to CJS-safe `openai`/`ollama` (no ESM-only deps); `provider` defaults to `local` but the registry is deliberately NOT flipped (proven Gemini path stays live until 03-03); `gemini` block preserved for Phase-2 golden parity (removed at PROV-07); `speech.*` untouched (Azure removal deferred to Phase 4).

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- **npm 11 gated the postinstall scripts** behind an `allow-scripts` approval, so `electron-builder install-app-deps` did NOT run during `npm install`. This is benign for two pure-JS transport deps (nothing to rebuild), and lockfile parity was confirmed independently via `npm ci --dry-run`. No action taken.
- **Pre-existing transitive `node-fetch@3.3.2` (ESM-only) is present** in the tree via an existing dependency. This is NOT a violation of the plan's "no ESM-only deps added" guardrail — the guardrail targets *direct* deps our own code `require()`s; `node-fetch` here is transitive, was not added by this install, and is not referenced by app code. Left untouched per the scope boundary.

## User Setup Required
None - no external service configuration required by this plan. (Ollama install / model pull is handled by the first-run flow built in later Phase-3 plans.)

## Next Phase Readiness
- 03-03 (LocalProvider) can now `require('openai')` and read `config.llm.local` (host/model) — both present.
- 03-04 (LocalModelManager) can now `require('ollama')` and read `config.llm.local` (curatedModels, host→OLLAMA_HOST derivation) — both present.
- No registry/behavior flip occurred; the provider switch is 03-03's job. App remains on the proven Gemini path.

## Self-Check: PASSED

- Files: package.json, package-lock.json, src/core/config.js, 03-01-SUMMARY.md — all FOUND.
- Commits: `794ce1f` (Task 1), `0b2cea6` (Task 2) — both FOUND.
- must_haves anchors: `"openai"` in package.json, `provider:` in config.js, `process.env.LLM_PROVIDER` in config.js — all FOUND.

---
*Phase: 03-local-engine-cloud-removal*
*Completed: 2026-07-14*
