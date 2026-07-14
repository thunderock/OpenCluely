# Roadmap: OpenCluely (Local-First Transformation)

## Overview

This milestone turns OpenCluely from a cloud-Gemini, on-demand overlay into a local-first, always-on multimodal copilot. The build order is dependency- and safety-driven: first lay a foundation (a generic service supervisor plus a test/lint/Makefile safety net for refactoring the god-files); then land the LLM provider abstraction *wrapping the existing Gemini code verbatim* so the app never stops working; then stand up the local model as the primary path and only *after it is proven* delete Gemini + Azure; in parallel, replace the per-utterance Whisper spawn with a resident engine that continuously hears both sides of a conversation; harden the render/permission surface alongside the new screen-capture and notes inputs; wire the pause-triggered orchestrator that fuses screen + speech + notes into a streamed, relevance-gated suggestion (the core value); add on-demand Claude/Codex CLI backup off the hot path; and finish with an unsigned universal macOS DMG in CI plus dead-code and license cleanup. The load-bearing rule threaded through everything: **abstraction first → local proven → cloud removed last.**

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Foundation — Supervisor, Tests, Lint, Makefile** - Generic service supervisor + a test/lint/Makefile safety net for safe refactoring
- [x] **Phase 2: Provider Seam — Wrap Gemini Verbatim** - `LLMProvider` abstraction + `RequestBuilder`; app still works on Gemini, call-sites unchanged
- [ ] **Phase 3: Local Engine + Cloud Removal** - Local multimodal model as the primary/default path; Gemini + Azure removed last, after Local is proven
- [ ] **Phase 4: Continuous Hearing — Resident STT + Ambient Listening** - Resident whisper.cpp continuously transcribes mic + macOS system audio from launch to quit
- [ ] **Phase 5: Continuous Capture, Notes & Hardening** - Throttled/deduped screen capture + bounded `.md` context, shipped with output sanitization, TCC recovery, and IPC scoping
- [ ] **Phase 6: Continuous Mode — Pause Orchestrator, Relevance Gate & Trust UI** - After each pause, a relevant streamed answer appears; relevance gate + listening indicator + kill switch
- [ ] **Phase 7: CLI Backup Providers — Claude / Codex** - On-demand escalation + auto-fallback to Claude/Codex CLI, reusing terminal auth, never on the per-pause path
- [ ] **Phase 8: Packaging & Release — macOS DMG CI + Cleanup** - Unsigned universal macOS DMG in CI, `asarUnpack` for helpers, `xattr` docs, dead-code + license cleanup
- [ ] **Phase 9: Website — Refresh & Publish** - Update the existing `webapp/` static site to the local-first product + a GitHub Pages deploy workflow

## Phase Details

### Phase 1: Foundation — Supervisor, Tests, Lint, Makefile
**Goal**: The repo has a safety net (tests + lint + Makefile) so the 1600+ line god-files can be refactored safely, and a generic supervisor that can manage any long-running local process (written once, configured later for both the model server and the STT server).
**Depends on**: Nothing (first phase)
**Requirements**: FND-01, FND-02, FND-03, FND-04
**Success Criteria** (what must be TRUE):
  1. `make setup`, `make setup-dev`, `make run_tests`, and `make lint` all run and succeed on a clean checkout.
  2. `make run_tests` executes an automated suite covering the pure-logic pieces (VAD segmentation, `.env` parse, skill/prompt normalization), and a pushed PR carrying a lint violation fails the CI lint gate.
  3. The `ServiceSupervisor` can spawn a local process, health-check it (port/HTTP), restart it with backoff after the process is killed, and terminate it on app quit (SIGTERM→SIGKILL) — demonstrated by a test.
  4. The supervisor supports adopt-if-present / own-if-started, so it never kills a process it did not start.
**Plans**: 5 plans (3 waves)
- [x] 01-01-PLAN.md — Extract .env + skill/prompt normalization into pure modules + node:test suites (Wave 1)
- [x] 01-02-PLAN.md — Extract VAD segmentation state machine, delegate SpeechService + node:test suite (Wave 1)
- [x] 01-03-PLAN.md — Generic ServiceSupervisor + fixture + demo suite proving SC3/SC4 (Wave 1)
- [x] 01-04-PLAN.md — ESLint 9 flat config + globals devDeps + clean fix pass (Wave 2)
- [x] 01-05-PLAN.md — Makefile (4 targets) + CI lint/test gate on PR + push:main (Wave 3)

### Phase 2: Provider Seam — Wrap Gemini Verbatim
**Goal**: An `LLMProvider` abstraction exists with the existing Gemini code wrapped verbatim behind it, and the app still answers exactly as before — this is the sequencing keystone (never removal-first).
**Depends on**: Phase 1 (test/lint safety net for the refactor)
**Requirements**: PROV-01, PROV-02
**Success Criteria** (what must be TRUE):
  1. The app still answers on-demand screenshot, voice, and typed-chat questions via Gemini exactly as before — every `main.js` / `sessionManager` call-site is unchanged.
  2. An `LLMProvider` interface (`generate` / `generateStream` / `isAvailable` / `testConnection`) exists, and Gemini is registered as a provider implementing it behind a thin `llm.service` facade with identical exports.
  3. The Gemini-specific cert-verify bypass and User-Agent override now live inside the Gemini provider (active only when Gemini is selected), not as unconditional global startup code — so they disappear cleanly at removal.
  4. A `RequestBuilder` produces one neutral request shape from (skill, text/image, history, md-context), with no prompt logic living inside any provider.
**Plans**: 3 plans (3 waves)
- [x] 02-01-PLAN.md — `LLMProvider` interface + pure DI `RequestBuilder` (neutral struct) + node:test (Wave 1)
- [x] 02-02-PLAN.md — Gemini provider (verbatim relocation) + `serialize()` + registry + byte-identical golden parity (Wave 2)
- [x] 02-03-PLAN.md — Thin `llm.service` facade flip + cert/UA relocation into provider (gated) + 3-entry-point smoke [live smoke waived — no key] (Wave 3)

### Phase 3: Local Engine + Cloud Removal
**Goal**: A local multimodal model is the primary, default answer path over an OpenAI-compatible localhost endpoint — the "if all else fails, this works" core value engine — and only after it is proven are Gemini + Azure deleted entirely.
**Depends on**: Phase 2 (provider seam + `RequestBuilder`); Phase 1 (`ServiceSupervisor` for the model manager)
**Requirements**: PROV-03, PROV-04, PROV-05, PROV-06, PROV-07, GEN-01
**Success Criteria** (what must be TRUE):
  1. With no cloud configured, the user asks a text question and a local model streams tokens back into the overlay via `127.0.0.1:11434/v1`.
  2. The user captures/attaches a screenshot and the local multimodal model answers directly from the image (no OCR step).
  3. On first run with the model missing, the app pulls `qwen3-vl:8b` with visible, resumable progress, caches it at Ollama's default location, adopts a running Ollama if present (starts one only if absent, never killing a daemon it didn't start), and keeps it resident (`keep_alive:-1`).
  4. The user can choose provider and model in settings with Local as the default, and a non-coding question (e.g., summarizing an on-screen contract clause) gets a relevant general-purpose answer, with DSA/coding available as an optional skill overlay.
  5. Gemini and Azure are fully removed (SDKs, hardcoded hosts, cert-verify bypass, Azure browser-DOM polyfill) — done last; and measured TTFT at session end with full md-notes loaded stays within budget while total memory (VLM + KV + resident Whisper + Electron) stays under the macOS GPU-wired ceiling with no swap.
**Plans**: 8 plans (5 waves)
- [ ] 03-01-PLAN.md — Foundation: install openai+ollama, restructure config into per-provider blocks (Local default) (Wave 1)
- [ ] 03-02-PLAN.md — GEN-01: general reply-suggester default + Coding skill; neutralize both interview prompt sources (Wave 1)
- [ ] 03-03-PLAN.md — LocalProvider (PROV-03/04): text stream + screenshot over /v1; mirror the full seam; register Local (Wave 2)
- [ ] 03-04-PLAN.md — LocalModelManager (PROV-05): adopt/own Ollama + resumable pull + resident; model IPC + lifecycle (Wave 2)
- [ ] 03-05-PLAN.md — Settings UI (PROV-06): provider + model pickers (curated + advanced), Local default, status/repair (Wave 3)
- [ ] 03-06-PLAN.md — First-run onboarding (Ollama guide + auto-pull) + in-overlay Local-down recovery UX (Wave 3)
- [ ] 03-07-PLAN.md — Validation gate: prove Local (3 entry points + rough TTFT/memory smoke) — manual sign-off (Wave 4)
- [ ] 03-08-PLAN.md — Cloud removal (PROV-07): delete Gemini behind a hard manual approval; keep Azure STT (Wave 5)

### Phase 4: Continuous Hearing — Resident STT + Ambient Listening
**Goal**: The app continuously hears both sides of a conversation through a resident transcriber, with no per-utterance process spawn — the prerequisite for continuous mode.
**Depends on**: Phase 1 (`ServiceSupervisor`, if using a supervised `whisper-server`); independent of the provider phases (2–3)
**Requirements**: STT-01, STT-02, STT-03, STT-04
**Success Criteria** (what must be TRUE):
  1. Each VAD segment transcribes against a resident whisper.cpp engine with no per-utterance process/model spawn or cold-start — the Python subprocess + venv path is deleted.
  2. On first run the STT model downloads and caches locally with visible progress.
  3. The app keeps the audio stream open from launch to quit (ambient listening), transcribing on VAD-detected natural pauses using the existing VAD + hallucination filter.
  4. On macOS, audio from the other party (system/loopback via ScreenCaptureKit) is transcribed as a separate channel from the mic, so a question you only *hear* is captured.
  5. Two minutes of silence produces zero transcripts (the silence-hallucination filter holds under always-on).
**Plans**: TBD (derived in /gsd:plan-phase) — RESEARCH FLAG: in-process `smart-whisper` vs supervised `whisper-server`; validate native-addon ABI against Electron 29 early

### Phase 5: Continuous Capture, Notes & Hardening
**Goal**: The app's new screen-capture and notes inputs are in place, and the render/permission threat surface they create is hardened *in the same phase* — before the always-on firehose turns on in Phase 6.
**Depends on**: Phase 3 (`RequestBuilder` — md-context injects into the neutral request; the frame feeds the local multimodal path)
**Requirements**: CONT-04, CONT-05, SEC-01, SEC-02, SEC-03
**Success Criteria** (what must be TRUE):
  1. On startup the app loads a settings-configured folder of `.md` files as bounded, size-budgeted standing context, reloaded each launch.
  2. Continuous screen capture runs on a throttled interval with downscale-before-encode and frame-diff dedup; an unchanged/idle screen is skipped and adds no encode/model cost; the frame is sent directly to the model (no OCR).
  3. Model output containing hostile markdown/HTML (e.g., an `<img onerror>` lifted from on-screen text) is rendered inert at every `innerHTML` sink via DOMPurify.
  4. After screen or mic permission is lost (e.g., all-black frames / mic status after an update), the app detects it and guides the user to re-grant (macOS TCC recovery).
  5. The response/overlay renderers cannot read settings or exfiltrate keys — privileged IPC (settings read, `openExternal`, clipboard) is scoped by sender.
**Plans**: TBD (derived in /gsd:plan-phase)

### Phase 6: Continuous Mode — Pause Orchestrator, Relevance Gate & Trust UI
**Goal**: The core value — after each natural pause, a relevant answer streams into the stealth overlay, generated locally from screen + speech + notes, surfaced only when actually answerable, with the trust affordances that make always-on acceptable.
**Depends on**: Phases 3 (local provider), 4 (continuous transcript stream), 5 (capture, notes, sanitized render path)
**Requirements**: CONT-01, CONT-02, CONT-03, CONT-06, CONT-07
**Success Criteria** (what must be TRUE):
  1. During a live conversation, after a natural speech pause, a relevant answer streams token-by-token into the stealth overlay — fused from recent transcript + current screen frame + md-context + history via the local provider.
  2. Suggestions are ephemeral: they auto-clear/replace on topic change and never stack a backlog (the previously-dead `-chunk` streaming path is fixed and consumed).
  3. Small talk and non-answerable moments produce no suggestion, and two minutes of silence produces zero suggestions (layered relevance gate: cheap `seemsLikeQuestion` pre-filter → local generation with model-abstain; fail-toward-silence).
  4. A persistent, self-visible "listening / watching" indicator always shows capture state, and a one-click pause/kill switch — reachable without opening settings — instantly halts all listening + watching.
  5. Sustained-session budget gates hold: measured TTFT at session end with full notes stays within budget, memory pressure at ~minute 45 stays under the GPU-wired ceiling (no swap), and thermal/battery back-off engages under load (via `powerMonitor`).
**Plans**: TBD (derived in /gsd:plan-phase) — RESEARCH FLAG: relevance-gate tuning (thresholds, cooldown, not answering the assistant's own speech / hallucinated silence)

### Phase 7: CLI Backup Providers — Claude / Codex
**Goal**: On-demand escalation to stronger Claude/Codex CLI agents as backup, reusing existing terminal auth, with auto-fallback when Local is unavailable — never on the per-pause hot path.
**Depends on**: Phase 3 (provider registry + Local-as-primary to fall back from)
**Requirements**: PROV-08, PROV-09, PROV-10, PROV-11
**Success Criteria** (what must be TRUE):
  1. The user can escalate the current question to Claude (`claude -p` headless) and get an answer, with an optional screenshot passed via a temp PNG.
  2. The user can escalate to Codex (`codex exec` headless) and get an answer, with an optional screenshot via `-i`.
  3. Escalation reuses existing terminal auth (no app-stored keys); on launch the app resolves the login-shell environment so the `claude`/`codex` binaries + credentials are visible to the GUI-launched app (and `CLAUDECODE` / `CLAUDE_CODE_*` are cleared).
  4. When Local is unavailable a backup request auto-falls back to a CLI provider; CLI providers never run on the per-pause path; and an expired-auth or hung CLI fails loudly within a hard timeout instead of hanging.
**Plans**: TBD (derived in /gsd:plan-phase)

### Phase 8: Packaging & Release — macOS DMG CI + Cleanup
**Goal**: Users can download a working unsigned universal macOS DMG, and the repo's dead code and conflicting license are cleaned up. Independent of the AI pipeline.
**Depends on**: Phases 3, 4 (so the set of spawned helper binaries to unpack is known); otherwise independent of the AI pipeline
**Requirements**: REL-01, REL-02, REL-03, REL-04
**Success Criteria** (what must be TRUE):
  1. The release CI builds and publishes an unsigned universal macOS DMG (`--universal -c.mac.notarize=false`, `CSC_IDENTITY_AUTO_DISCOVERY=false`), modeled on forge's workflow.
  2. A downloaded DMG launches and can spawn its helper binaries — anything spawned is correctly `asarUnpack`-ed so packaged builds run.
  3. The README documents the `xattr -cr` Gatekeeper workaround, replacing the current "build from source only" note.
  4. Dead code is removed (`chat-window.js`, the 0-byte `fallback-capture.service.js`, the orphaned Gemini modal, dead IPC handlers) and the license is reconciled to one (currently ISC / Apache-2.0 / MIT stated in three places).
**Plans**: TBD (derived in /gsd:plan-phase)

### Phase 9: Website — Refresh & Publish
**Goal**: The existing `webapp/` static landing site tells the *local-first* story — private, on-device, always-on continuous copilot — instead of the old cloud-Gemini interview-copilot framing, and it ships to GitHub Pages via CI so the public site reflects the shipped product. Last phase: it documents finished v1.
**Depends on**: All feature + release phases (2–8) — the site describes the final product and its downloads, so it lands last.
**Requirements**: WEB-01, WEB-02
**Success Criteria** (what must be TRUE):
  1. `webapp/index.html` + copy reflect the local-first product (on-device model, continuous hearing/watching, private/offline, no API key) — no stale "cloud Gemini" / "API key" / interview-only positioning; features, screenshots/OG image, and download/install match the final README.
  2. The site still works as a dependency-free static bundle (opens locally; all internal links + assets resolve; no build step introduced).
  3. A CI workflow publishes `webapp/` to GitHub Pages on push to `main` (static deploy; repo owner enables Pages in settings) — separate from `ci.yml` and `release.yml`.
  4. `README.md`'s Website link points at the published site, and the site links back to the latest release/downloads.
**Plans**: TBD (derived in /gsd:plan-phase)

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation — Supervisor, Tests, Lint, Makefile | 5/5 | Complete | 2026-07-14 |
| 2. Provider Seam — Wrap Gemini Verbatim | 3/3 | Complete | 2026-07-14 |
| 3. Local Engine + Cloud Removal | 0/8 | Not started | - |
| 4. Continuous Hearing — Resident STT + Ambient Listening | 0/TBD | Not started | - |
| 5. Continuous Capture, Notes & Hardening | 0/TBD | Not started | - |
| 6. Continuous Mode — Pause Orchestrator, Relevance Gate & Trust UI | 0/TBD | Not started | - |
| 7. CLI Backup Providers — Claude / Codex | 0/TBD | Not started | - |
| 8. Packaging & Release — macOS DMG CI + Cleanup | 0/TBD | Not started | - |
| 9. Website — Refresh & Publish | 0/TBD | Not started | - |

---
*Roadmap created: 2026-07-13*
*Coverage: 36/36 v1 requirements mapped — no orphans, no duplicates*
