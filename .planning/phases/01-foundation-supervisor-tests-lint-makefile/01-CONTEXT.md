# Phase 1: Foundation — Supervisor, Tests, Lint, Makefile - Context

**Gathered:** 2026-07-13
**Status:** Ready for planning

<domain>
## Phase Boundary

A developer safety net — automated tests + lint/format + a `Makefile` — so the 1600+ line
god-files (`src/services/llm.service.js`, `main.js`) can be refactored safely in later phases,
**plus** a generic `ServiceSupervisor` that can spawn, health-check, restart-with-backoff, and
cleanly stop any long-running local process. The supervisor is written **once** here and
configured **twice** later: the Ollama model server (Phase 3) and the whisper-server (Phase 4).

Requirements delivered: **FND-01, FND-02, FND-03, FND-04**.

**In scope for this phase:**
- Choose + wire a test runner; write tests for the three named pure-logic pieces.
- Extract those pure-logic pieces out of their self-initializing singletons so they're testable.
- Choose + wire a linter; a CI gate that runs lint + tests.
- A `Makefile` with the four standard targets.
- The generic `ServiceSupervisor` class + a demonstrating test (spawn / health-check / restart-with-backoff / terminate / adopt-vs-own).

**Explicitly NOT in scope (deferred to later phases — do not pull in):**
- Wiring any *real* service into the supervisor (Ollama → P3, whisper-server → P4). Phase 1 proves the supervisor generically against a trivial dummy process only.
- The provider abstraction / any Gemini refactor (that's P2).

## Locked (do not re-ask / do not re-litigate)

- **Makefile targets** are fixed by the user's personal-project convention: `setup`, `setup-dev`, `run_tests`, `lint`. (FND-03)
- **Named test targets** (FND-01): VAD segmentation, `.env` parse, skill/prompt normalization.
- **Supervisor adopt-if-present / own-if-started** — never kill a process it did not start. Hard requirement (FND-04 + Success Criterion 4), not a choice.
- **Tech constraint:** stay CommonJS + vanilla JS; no bundler, no TypeScript, no framework. Match existing conventions (incl. the intentional `assests/` misspelling).
- **CI must gate lint on PRs** (FND-02 Success Criterion 2: a PR carrying a lint violation fails the gate).

</domain>

<decisions>
## Implementation Decisions

### Test runner & scope
- **Runner: Node's built-in `node:test` + `node:assert`**, run via `node --test`. Zero new runtime/dev dependencies, native CommonJS, works on the Node 20 already provisioned in CI. Chosen over Jest/Vitest to match the repo's zero-bloat, no-bundler ethos.
- **Scope: only the three named pure-logic targets** (VAD segmentation, `.env` parse, skill/prompt normalization). Enough of a regression safety net to refactor the god-files in P2/P3; keeps this phase tight. Do not expand to broader coverage.
- **Extraction is IN SCOPE:** the named logic currently lives inside self-initializing singletons (per `.planning/codebase/TESTING.md`), which can't be unit-tested cleanly. Pull those pure functions out into standalone testable modules as part of this phase — this extraction *is* the safety-net work and de-risks the later god-file refactor.
- **No coverage gate/threshold** this phase — just a running suite. (Repo is at ~0% today; an arbitrary threshold now is noise. Revisit later if useful.)

### Lint & format
- **Linter: ESLint (flat config).** Safe default for Electron — first-class handling of the three distinct environments (main/Node, `preload`, renderer/browser globals). Also matches the existing `/* eslint-disable no-undef */` relic in `onboarding.js`. Chosen over Biome.
- **No mass reformat.** Lint *rules* only; do NOT impose one style repo-wide. The codebase has intentionally mixed style (2-space main / 4-space renderer; single vs double quotes across layers) — a full reformat now would be a giant diff that fights the safe-incremental-refactor sequencing and pollutes every later phase's diff. Preserve per-layer style.
- **Lean, high-signal ruleset.** Enable real-bug rules (e.g. `no-undef` with correct per-environment globals, `no-unused-vars`), fix the handful it surfaces, gate on **errors only**. Fast path to a meaningful green gate without a large fix-up diff.

### CI gate
- **Runs lint + tests** (`node --test`). Success criterion only strictly requires the lint gate, but the test suite built this phase is the regression safety net — running it on every PR is the point.
- **Triggers on pull requests + pushes to `main`.** Keeps WIP feature-branch pushes noise-free while gating everything that merges.
- **Runner OS: ubuntu + macOS matrix.** Lint + pure-logic tests + the supervisor demo (spawning a trivial dummy process) are OS-agnostic, but the app is macOS-primary, so run macOS too to catch OS-specific test breakage on the primary platform. This is a **new** workflow, separate from the tag-only `.github/workflows/release.yml`.

### ServiceSupervisor behavior
- **Restart policy: exponential backoff (capped interval) → give up after N attempts → mark failed and surface a clear status.** Bounded and predictable; a permanently-broken service reports itself instead of thrashing forever.
- **Health-check: support BOTH a TCP port-open probe AND an HTTP-endpoint probe, chosen per service in its config.** Ollama (P3) uses an HTTP health URL; a whisper-server (P4) may just open a TCP port. Configurable-per-service serves both known consumers without a rewrite.
- **When a service won't start at all** (binary missing, port permanently held by a foreign process, retries exhausted): **degrade gracefully + surface status.** Don't crash, don't hang; mark the service unavailable, emit a status the UI can show, keep the rest of the app running. Matches the codebase's existing "degrade gracefully, never crash" error philosophy (see `.planning/codebase/CONVENTIONS.md` → Error Handling).
- **Build it generic NOW, validated against both future consumers.** Design the full service-definition contract this phase (command/args, health-check type, backoff config, adopt/own policy) and prove it generic via the demo test **plus** a design check against both known consumers (Ollama HTTP on `127.0.0.1:11434`, whisper-server on a local TCP port). This is the roadmap's "written once, configured twice" intent — avoids reshaping the API in P3/P4.

### Claude's Discretion
None delegated wholesale — the user weighed in on all four areas. Within the locked decisions above, the following are Claude's / the planner's call:
- Exact backoff constants (initial delay, multiplier, cap, max-attempt count) and the concrete "surfaced status" shape/event.
- The precise ESLint rule list and per-environment `globals` config, and the shape of the dummy fixture process used by the supervisor demo test.
- Where the extracted pure-logic modules live (path/naming), following existing conventions.
- Adopt/own **detection mechanism** (the *policy* is locked; the mechanism — e.g. port probe ± PID sidecar — is implementation).

</decisions>

<specifics>
## Specific Ideas

- **Supervisor structure — imitate the two DI-friendly modules.** `src/core/whisper-installer.js` (`WhisperInstaller`) and `src/core/first-run.js` (`FirstRunManager`) already export the **class** (not a singleton) and take dependencies via a constructor options object; `WhisperInstaller` exposes `options.runExec || runExec` as an explicit seam for swapping real process-spawning in tests. The `ServiceSupervisor` should follow this exact shape (export the class, inject the spawn/exec function) so its restart/health-check logic is unit-testable without real long-running processes. (Source: `.planning/codebase/TESTING.md`, `CONVENTIONS.md`.)

- **Reference research for the supervisor's adopt/own + health-check + resilience patterns:** `.planning/research/OPENWHISPR-NOTES.md` (just produced). Relevant, proven patterns for the *later* consumers that the generic design should accommodate: resident local server health-checked on `127.0.0.1:<port>`, a **PID-sidecar** for adopt/own detection, pre-warm at `app.whenReady()` and re-warm on OS sleep/wake. Phase 1 need not implement pre-warm/wake-rewarm (those attach when real services wire in at P3/P4) — but the generic contract shouldn't preclude them.

- **Logging convention for the new module:** use `require('./core/logger').createServiceLogger('SUPERVISOR')` (all-caps one-word tag) and the `logger.<level>(message, metaObject)` call shape — never string-interpolate variable data into the message. (Source: `CONVENTIONS.md` → Logging.)

- **Termination sequence** for the supervisor is fixed by Success Criterion 3: **SIGTERM → SIGKILL** on app quit.

</specifics>

<deferred>
## Deferred Ideas

- **Wiring real services into the supervisor** — Ollama model manager (Phase 3, `PROV-05`) and the resident whisper-server (Phase 4, `STT-01`). Phase 1 only proves the supervisor generically against a dummy process.
- **Pre-warm-on-launch / re-warm-on-wake** behaviors (from `OPENWHISPR-NOTES.md`) — belong with the real services in P3/P4, not the generic Phase 1 demo.
- **Coverage threshold / gate** — intentionally not added this phase; revisit once there's a meaningful suite to hold a floor against.
- **Broader test coverage** beyond the three named pieces — out of this phase's tight scope; add opportunistically alongside future refactors.

</deferred>

---

*Phase: 01-foundation-supervisor-tests-lint-makefile*
*Context gathered: 2026-07-13*
