# Project Research Summary

**Project:** OpenCluely — local-first, always-on multimodal AI copilot (brownfield Electron pivot)
**Domain:** Always-on, local-first, multimodal AI desktop copilot (Apple Silicon 32 GB+ primary; meeting/interview/general-question assistant)
**Researched:** 2026-07-13
**Confidence:** MEDIUM-HIGH

## Executive Summary

OpenCluely is being transformed from a cloud-Gemini, on-demand overlay into a **local-first, always-on multimodal copilot**: on launch it self-starts local STT + model services, loads a folder of the user's `.md` notes as standing context, then continuously listens and watches the screen and surfaces a streamed answer after each natural speech pause — from a local model, fast and private. The way experts build this class of tool (verified against Pluely, Natively, Glass, Meetily, Highlight) is: two persistent, supervised local servers (model + STT) fronted by dumb transport clients, a **pause-triggered pipeline gated by a relevance filter**, ephemeral (non-persistent) capture, and trust affordances (a visible listening/watching indicator + one-click kill switch) that make "always-on" acceptable. OpenCluely's exact combination — always-on + local-primary + screen+voice fusion + on-demand escalation to a stronger model + trust affordances — is **not fully occupied by any competitor**, so the white space is real.

The recommended approach is a **provider abstraction** (`LLMProvider`) with a locked chain of **LocalProvider (Ollama, primary) → ClaudeProvider (CLI) → CodexProvider (CLI) as backup** — Gemini and Azure are removed entirely. Local serving is **Ollama >= 0.19** running `qwen3-vl:8b` (6.1 GB, 256K ctx) over its OpenAI-compatible endpoint at `127.0.0.1:11434/v1`, reached via the CommonJS `openai` npm SDK; STT becomes a **resident whisper.cpp** engine (`smart-whisper` in-process, or a supervised `whisper-server`) with `ggml-large-v3-turbo`, deleting the per-utterance Python spawn that is the #1 blocker to continuous listening. Almost all the new work slots onto **existing seams** in the brownfield app — the pause-coalesce pipeline (`main.js:1181-1360`), VAD-on-silence (`speech.service.js:800-902`), and the streaming broadcast envelope already exist. The dominant structural insight: build a generic **ServiceSupervisor once**, configure it twice (model + STT).

The three biggest risks are all pre-identified and sequencing-driven. **(1) Sequencing:** the abstraction must land *first* wrapping Gemini verbatim, and Gemini/Azure must be deleted *last* — removing the only working path before the local one is proven is the classic rewrite trap. **(2) Real-time on 32 GB:** per-pause latency is dominated by image-token + context **prefill (TTFT)**, not decode, and the VLM + resident Whisper + Electron/Chromium must coexist under macOS's ~75%-of-RAM GPU-wired ceiling without swapping — this must be budgeted and measured, not assumed. **(3) The always-on failure modes:** unsigned macOS builds silently lose screen/mic TCC grants on every update (capture just goes black with no error); Whisper hallucinates text during silence and would trigger answers to things nobody said; and untrusted on-screen text funnelled into the VLM turns the unsanitized `innerHTML` render path into a prompt-injection XSS vector. Each has a known mitigation, and each must ship *with* the feature that creates it — not "later."

One scope question is unresolved and needs a requirements decision (see Gaps): **system/loopback audio capture (mic + system audio + AEC)**. The Core Value says answers appear after a pause in what you're "saying **or hearing**," but the app is **mic-only today** — it cannot hear the interviewer/other party without the user re-voicing the question. This is table stakes for the meeting/interview use case across every serious competitor, but it's HIGH-complexity and platform-specific, so v1-vs-later is a deliberate call.

## Key Findings

### Recommended Stack

The stack is chosen to satisfy six requirements at once — local multimodal serving, resident STT, CLI backup, supervision, cache, and download UX — while respecting the locked constraints (**CommonJS, no bundler, no TS, no framework rewrite; Apple Silicon 32 GB+ primary; keep Windows/Linux building**). Confidence is HIGH on the core runtime/model/STT picks and MEDIUM on specific latency/memory figures and a few younger supporting libs. Full detail in `STACK.md`.

**Core technologies:**
- **Ollama >= 0.19** (local LLM runtime, PRIMARY) — the only option combining an OpenAI-compatible `/v1` endpoint, automatic model download+cache, a cross-platform single binary, MLX acceleration on Apple Silicon, resident keep-alive, and an official CJS Node client. Serves at `127.0.0.1:11434`; keep resident with `OLLAMA_KEEP_ALIVE=-1`.
- **`qwen3-vl:8b`** (multimodal model, PRIMARY) — 6.1 GB, 256K ctx, purpose-built "visual agent": strong OCR (32 langs), UI-element understanding, document/chart parsing. Fits comfortably on 32 GB. Expose `qwen3-vl:30b` (quality upgrade, tight on 32 GB) and `gemma3:4b/12b` (light alt) as user-selectable.
- **`openai` npm >= 6 (6.46.0)** (LocalProvider transport) — point `baseURL` at `http://127.0.0.1:11434/v1`, `apiKey:'ollama'`; ships a CommonJS `require` build; runtime-agnostic (swap `baseURL` to move to llama-server/LM Studio later with no code change).
- **whisper.cpp v1.9.x + `smart-whisper`** (STT, resident) — pure C/C++, no Python/venv/torch, GPU via Metal (~4-10x realtime on Apple Silicon); `smart-whisper` keeps the model resident in-process so each VAD segment calls `transcribe()` with no per-utterance spawn. Model: `ggml-large-v3-turbo` (Q5). (faster-whisper is **CPU-only** on Apple Silicon — avoid.)
- **`claude -p` / `codex exec` via `child_process.spawn`** (CLI backup providers) — headless one-shot, reuse existing terminal auth (no app-stored keys), never on the per-pause hot path. Forge's `ask-code.ts` is the proven headless template.
- **`tree-kill` + built-in `fetch` health-check** (supervision) — reuses existing spawn patterns; `electron-ollama@0.1.25` is an optional accelerator (0.1.x/single-maintainer — don't hard-depend).

**CJS/ESM constraint (load-bearing):** this is a bundler-free CommonJS app (`require`). Avoid ESM-only libs — **`get-port@7`, `execa@9`, `node-fetch@3` will throw on `require`**. Use `net.createServer().listen(0)` for port probing, `node:child_process`, and Electron's global `fetch` instead. Native addons (`smart-whisper`, `node-pty`) must be rebuilt against Electron 29's ABI via `@electron/rebuild` — validate early.

### Expected Features

Full landscape in `FEATURES.md`. The existing foundation (stealth overlay, on-demand screenshot->answer, mic VAD + Whisper filter, streaming pipeline, session memory, skill-prompt loader, global shortcuts) is treated as locked and built upon.

**Must have (table stakes — missing any makes an always-on copilot feel broken):**
- **Persistent, continuous STT** (resident, not per-utterance subprocess) — prerequisite for everything continuous.
- **Low-latency streaming answer (sub-3s to first token)** — the new risk is the *local* model hitting this on Apple Silicon.
- **Provider choice + a fully-local/offline path** — now standard across OSS competitors.
- **One-click pause / kill switch for capture** — non-negotiable trust affordance for any always-on tool.
- **Personal/custom context injection** — OpenCluely's watched `.md` folder is its version.
- **Stealth overlay** (existing, locked) — the entry ticket in this category, not a differentiator.
- **System/loopback audio capture (mic + system audio + AEC)** `[RESEARCH-SURFACED — v1 decision pending]` — every serious competitor has it; OpenCluely is mic-only. See Gaps.

**Should have (differentiators — where OpenCluely competes):**
- **Continuous proactive suggestions gated by a relevance filter** — the headline; most competitors are on-demand (hotkey). The hard part is "reply only when answerable."
- **Local-first as the PRIMARY path** (not a fallback) — a durable trust moat (cf. Cluely's 83k-user breach, Rewind's local->cloud pivot).
- **On-demand escalation to Claude/Codex CLI** — best-of-both without per-pause cloud latency/cost.
- **Screen+voice fusion at the pause — no OCR, no persistent recording** — image straight to the multimodal model, screen grabbed only at the pause (throttled/downscaled/deduped), storing nothing.
- **Live personal-notes `.md` folder as standing context** — bounded concatenation, no RAG in v1.
- **Self-visible "listening/watching" indicator** — the affordance that squares always-on with trustworthy.

**Defer (v2+):**
- RAG / vector retrieval for notes (only if notes outgrow the context slot).
- Speaker diarization (marginal for a single-user answer copilot).
- Post-session summary/notes (a different product — notetaker, not live-answer).
- Custom personas / skill packs (optional overlays on the general-purpose base).

**Explicit anti-features (do NOT build):** reply on *every* pause (interruption fatigue — the top anti-feature); cloud upload of screen/audio/transcripts; 24/7 persistent recording + searchable history; continuous full-res OCR; a meeting bot that joins the call; TTS talk-back (breaks stealth).

### Architecture Approach

The vision decomposes into **six new subsystems that slot onto existing seams** — it extends the embryonic pause-triggered pipeline (`handleTranscriptionFragment` -> 800ms coalesce -> `dispatchCoalescedUtterance`) rather than building a parallel loop. All code is CommonJS (`module.exports = new ClassName()`), matching repo convention. New code **extends, never rewrites**; the 1655-line `llm.service.js` becomes a thin facade with identical exports so ~6 `main.js` call-sites stay untouched. Full detail in `ARCHITECTURE.md`.

**Major components:**
1. **`LLMProvider` + registry + `llm.service` facade** — dumb-transport providers behind a facade that preserves call-site shapes; provider swap and fallback become config. Gemini deletion is contained to the facade internals.
2. **`RequestBuilder`** — turns `(skill, text/image, history, mdContext)` into one neutral `{system, messages, image?}`; owns all prompt logic so every provider gets the same context (no prompt logic inside providers).
3. **Generic `ServiceSupervisor`** — spawn / health-poll / restart-with-backoff / SIGTERM->SIGKILL-on-quit, written once and configured for both the model server and STT server. Fills the "no supervisor exists" blocker.
4. **`LocalModelManager` + `LocalProvider`** — OpenAI-compatible localhost HTTP client + SSE, multimodal (image as base64 part). Uses **adopt-if-present / own-if-started** lifecycle for the shared Ollama daemon (see reconciliation below).
5. **Persistent STT client** — a *one-method swap* inside `speech.service.js` (`_transcribeWhisperFile` -> resident whisper.cpp); the VAD state machine, EventEmitter surface, and hallucination filter are all reused unchanged.
6. **Capture scheduler + Context manager + Orchestrator** — throttle+downscale+hash-dedup capture holding `latestFrame` (pulled, not pushed); bounded `.md` concatenation with `fs.watch`; and the orchestrator that fuses transcript + frame + md-context + history at the pause, runs the layered relevance gate, and streams via the existing broadcast envelope.

### Critical Pitfalls

Top pitfalls from `PITFALLS.md` (12 critical + debt/security/UX tables). Each maps to a specific phase and must ship *with* the feature that creates the risk.

1. **Removal-first breaks everything (Pitfall 12)** — Gemini isn't behind an interface; `llm.service.js` *is* Gemini, the host is hardcoded ~6 places, and a cert-verify bypass + UA override run unconditionally at startup, plus Azure drags a ~380-line browser-DOM polyfill. **Avoid:** land the abstraction FIRST wrapping Gemini *verbatim* (app still works on Gemini), move cert/UA special-casing into the Gemini provider, add LocalProvider, then delete Gemini/Azure LAST.
2. **Per-pause latency blown by prefill/TTFT, not decode (Pitfall 1)** — a screenshot is hundreds-to-~1,280 image tokens; prefilling image + transcript + md-notes + system prompt every pause dominates. **Avoid:** instrument TTFT specifically (budget <~1.5s), downscale to the minimum readable resolution, give md-notes/system a fixed capped position-stable prefix for KV reuse, cap the transcript window, and skip the image when the frame didn't change.
3. **OOM/swap on 32 GB (Pitfall 2)** — macOS caps GPU-wired memory at ~75% of RAM; VLM weights + KV cache + resident Whisper + Electron/Chromium must coexist. Crossing the ceiling triggers swap (10x latency collapse), silent CPU offload, or a process kill. **Avoid:** budget total footprint against `32 GB - 8+ GB headroom`; `OLLAMA_MAX_LOADED_MODELS=1`, `OLLAMA_NUM_PARALLEL=1`; size the VLM with KV headroom, not one that just fits empty.
4. **Silent TCC permission loss on unsigned updates (Pitfall 3)** — macOS ties screen/mic grants to the code signature; an unsigned build gets a new identity each build, so after a DMG update macOS forgets the grants and capture returns black frames **with no error** — the always-on product just stops. **Avoid:** stable bundle ID + consistent ad-hoc signature in CI; runtime probe (mic via `getMediaAccessStatus`; screen by detecting all-black frames) -> deep-link re-grant flow; document the post-update re-grant.
5. **Prompt-injection XSS via unsanitized `innerHTML` (Pitfall 7)** — `marked.parse()` -> `.innerHTML` with no sanitizer, and continuous screen-watch now funnels attacker-influenced on-screen text into the VLM, whose output reaches a renderer with a broad privileged preload. `marked` removed built-in `sanitize` in v5. **Avoid:** DOMPurify at every `innerHTML` sink, treat all model output as hostile, scope privileged IPC by `event.sender` — sequenced *with or before* continuous capture / md-notes, not later.

Also critical and phase-mapped: **service lifecycle / clobbering the user's own Ollama (Pitfall 4)**; **multi-GB first-run download with no resume/checksum/offline path + the `~/.cache` vs `~/.ollama` cache-location mismatch (Pitfall 5)**; **Whisper silence-hallucination amplified by always-on (Pitfall 6)**; **CLI backup treated as low-latency/well-behaved — hangs on expired auth (Pitfall 8)**; **battery/thermal death spiral that also breaks stealth via fan noise (Pitfall 9)**; **unbounded context overflowing the smaller local window (Pitfall 10)**; **bundling native binaries across asar/arch/Gatekeeper (Pitfall 11)**.

## Implications for Roadmap

Based on the combined research, the dependency-driven build order (from `ARCHITECTURE.md` build-order section, reconciled with `PITFALLS.md` Pitfall 12 sequencing) suggests **8 phases**. Each is independently shippable/testable. The load-bearing constraint threaded through everything: **abstraction first -> LocalProvider proven -> Gemini/Azure removed last.**

### Phase 1: Foundation — Supervisor + Test/Lint/Makefile Baseline
**Rationale:** No dependencies; the generic `ServiceSupervisor` is the true foundation (both local servers need identical spawn/health/backoff/kill machinery — write once, configure twice), and the test/lint/Makefile baseline enables safe refactor of the 1655-line god-files (repo has ~0 coverage today).
**Delivers:** `service-supervisor.js`; `run_tests`/`lint`/`setup`/`setup-dev` Makefile targets; CI lint gate.
**Addresses:** Test baseline + Makefile (PROJECT Active).
**Avoids:** Sets up the "own-if-started vs adopt-if-present" support the supervisor needs for Pitfall 4.

### Phase 2: Provider Seam — Wrap Gemini Verbatim (app keeps working)
**Rationale:** Pitfall 12 is the single most important sequencing rule. Stand up `LLMProvider` + registry + facade internals wrapping the *existing* Gemini code verbatim; verify `main.js`/`sessionManager` call-sites are unchanged and the app still runs on Gemini. Move the cert-verify bypass + UA override *into* the Gemini provider (registered only when active) so they disappear cleanly at removal instead of as dead global startup code.
**Delivers:** `providers/provider.js` (interface), `registry.js`, facade with preserved exports, `RequestBuilder` skeleton.
**Implements:** Facade-over-providers (ARCHITECTURE Pattern 1); Anti-pattern 4 (no prompt logic in providers).
**Avoids:** Pitfall 12 (removal-breaks-call-sites) — never removal-first.

### Phase 3: Local Engine + Gemini/Azure Removal (the Core Value engine)
**Rationale:** Stand up a working local *primary* transport in isolation, *then* flip routing and delete cloud. A working local engine de-risks Gemini removal (otherwise you delete the only working path first). This is the "if all else fails, this works" core.
**Delivers:** `LocalProvider` (openai SDK -> `127.0.0.1:11434/v1`, multimodal base64, SSE), `LocalModelManager` (Ollama adopt/own via supervisor, resumable+checksummed first-run download UX, resident via `keep_alive:-1`, `qwen3-vl:8b`), full `RequestBuilder`; flip Local->primary; **then** delete Gemini + Azure SDKs, hardcoded hosts, cert bypass, and the browser-DOM polyfill.
**Uses:** Ollama >= 0.19, `openai` npm, `qwen3-vl:8b` (STACK).
**Avoids:** Pitfalls 1 (TTFT), 2 (OOM), 4 (lifecycle/port), 5 (download + cache location), 10 (context budget), 12 (removal last).
**Research flag:** YES — exact TTFT/memory validation on 32 GB, request shape, Ollama-vs-llama-server lifecycle nuance.

### Phase 4: Persistent STT (resident whisper.cpp)
**Rationale:** The per-utterance Python/Whisper spawn is the #1 blocker to continuous listening. This is a surgical one-method swap, not a rewrite — everything above the swap (VAD, events, coalesce, hallucination filter) is untouched.
**Delivers:** Resident whisper.cpp (`smart-whisper` in-process *or* supervised `whisper-server` — see Gaps), `ggml-large-v3-turbo`, `_transcribeWhisperFile` -> resident transcribe; delete the Python subprocess + venv path.
**Uses:** whisper.cpp + `smart-whisper` (STACK).
**Implements:** Persistent-server-instead-of-per-invocation-spawn (ARCHITECTURE Pattern 4).
**Avoids:** Pitfalls 6 (silence hallucination / VAD via `no_speech_threshold` + min-duration/energy), 11 (Python packaging quagmire).

### Phase 5: Continuous Inputs — md-Context + Capture Scheduler
**Rationale:** Mutually independent and parallelizable once their upstreams exist; neither alone changes user-visible behavior much, so they land before the orchestrator that composes them.
**Delivers:** `context.manager.js` (bounded `.md` concat, `fs.watch`, reload per startup, capped stable-prefix slot); extended `capture.service.js` (throttle + downscale-before-encode via `thumbnailSize` + perceptual-hash dedup, holds `latestFrame`; single-shot preserved).
**Addresses:** Live `.md`-folder context; continuous screen capture (FEATURES differentiators).
**Implements:** ARCHITECTURE Patterns 5 (capture) + 7 (bounded md-context, no RAG).
**Avoids:** Pitfalls 9 (battery/thermal — dedup is the biggest lever) and 10 (bounded context slot).

### Phase 6: Continuous Mode — Orchestrator + Relevance Gate + Trust UI + Hardening
**Rationale:** The composition point that fuses providers + STT + context + frame; necessarily last among features because it needs its inputs to exist. This is also where the dead streaming-UX bug finally gets fixed (wire `llm-response.html` to consume `-chunk`), and where the security/permission risks created by continuous capture must be closed *in the same phase*.
**Delivers:** Pause-triggered orchestrator (reuses coalesce seam + single-flight + cooldown), **layered relevance gate** (cheap heuristic/`seemsLikeQuestion` pre-filter -> local generation with model-abstain), listening/watching indicator + one-click pause/kill, wired streaming overlay, **DOMPurify at all `innerHTML` sinks**, **macOS TCC runtime probe + re-grant flow**, thermal/battery back-off via `powerMonitor`.
**Addresses:** Continuous proactive suggestions, trust affordances, output sanitization (FEATURES).
**Implements:** ARCHITECTURE Pattern 6 (pause-triggered orchestration with layered gate); fixes Anti-pattern 6 (dead stream).
**Avoids:** Pitfalls 3 (TCC — ship *with* capture), 7 (XSS — ship *with* capture/notes), 6/9 (gating + thermal). **The hard UX problem** ("reply only when answerable"): two decisions (endpointing + answerability), ephemeral non-stacking suggestions, fail-toward-silence.
**Research flag:** YES — relevance-gate tuning (thresholds, cooldown, not answering the assistant's own speech).

### Phase 7: CLI Backup Providers (Claude / Codex)
**Rationale:** Deliberately late — not on the hot path, and the local path must prove out first. Reuses forge's headless template (`ask-code.ts`) with a one-shot spawn (not a PTY).
**Delivers:** `claude.provider.js` (`claude -p`, `--output-format json`/`stream-json`, `--append-system-prompt`, image by temp-PNG path + `--allowedTools Read`) and `codex.provider.js` (`codex exec`, `--json`, native `-i` image, `--sandbox read-only --ephemeral`); auth pre-flight, timeouts, structured-output parsing, never per-pause.
**Uses:** CLI providers via `child_process.spawn`, existing terminal auth (STACK/CLI-PROVIDERS).
**Implements:** ARCHITECTURE Pattern 8 (headless CLI adapter); Anti-pattern 5 (CLI never on hot path).
**Avoids:** Pitfall 8 (cold-start/auth-hang/rate-limit/parse) — pre-flight auth, structured output, hard timeout, loud non-zero-exit handling.

### Phase 8: Packaging & Release — macOS DMG in CI + Cleanup
**Rationale:** Ships the build users actually get; the packaged/downloaded/other-arch build is where "works on my machine" dies.
**Delivers:** Unsigned universal macOS DMG in CI (forge pattern: `CSC_IDENTITY_AUTO_DISCOVERY=false`, `--universal -c.mac.notarize=false`), `asarUnpack` for any spawned helper binaries, `xattr -cr` README note; dead-code cleanup (`chat-window.js`, 0-byte `fallback-capture.service.js`, orphaned Gemini modal, dead IPC handlers), license reconciliation (ISC/Apache/MIT -> one).
**Avoids:** Pitfall 11 (asar/arch/Gatekeeper binary packaging); reduces existing tech-debt.

### Phase Ordering Rationale

- **Supervisor before both servers** — the model server (P3) and STT server (P4) need identical lifecycle machinery; building it once (P1) unblocks two subsystems without duplication.
- **Abstraction before local, local before removal** — the load-bearing constraint from Pitfall 12. P2 wraps Gemini verbatim (app still works), P3 stands up + proves local *then* deletes cloud last. Never removal-first.
- **STT / md-context / capture parallelize (P4-P5)** once their upstreams exist; none alone changes user-visible behavior much, so they precede the orchestrator that fuses them.
- **Orchestrator is necessarily last among features (P6)** — it's the composition point; it must come after its inputs exist or it has nothing to fuse. Security (DOMPurify) and TCC-recovery are folded *into* P6 because continuous capture + md-notes are exactly what create those threat surfaces.
- **CLI backup deliberately late (P7)** — off the hot path; the local path must prove out first.

### Research Flags

Phases likely needing `/gsd:research-phase` during planning:
- **Phase 3 (Local Engine):** HIGH-impact, MEDIUM-certainty — exact TTFT/memory behavior of `qwen3-vl:8b` on 32 GB Apple Silicon (budget validation, not just tags/sizes), the OpenAI-compatible multimodal request shape, and the Ollama shared-daemon adopt/own lifecycle vs a fully-app-owned llama-server.
- **Phase 6 (Relevance Gate):** MEDIUM-certainty — product-tuning of heuristic thresholds vs model-abstain vs a cheap classifier, cooldown, endpointing beyond raw VAD, and how to avoid answering the assistant's own speech / hallucinated silence.
- **Phase 4 (STT strategy sub-decision):** LOW-MEDIUM — resolve in-process `smart-whisper` vs a separate supervised `whisper-server` (native-addon ABI + crash-isolation trade-off); validate `@electron/rebuild` against Electron 29 early.

Phases with standard patterns (integration seams read directly — skip deep research):
- **Phases 1, 2, 5, 7, 8** — supervisor, provider facade, md-context/capture, CLI adapters (forge template), and DMG CI (forge workflow) are all well-documented and read from source; API details are captured in the research docs.

### Cross-Document Reconciliations (resolve before roadmapping)

These are stated explicitly so downstream requirements/roadmap stay consistent:

1. **Provider chain order is LOCAL (Ollama) primary -> Claude CLI -> Codex CLI backup. Gemini + Azure are REMOVED.** `CLI-PROVIDERS.md` section 8 shows a "Gemini -> Claude -> Codex" fallback wiring — that reflects an *earlier* framing and is **NOT** the locked design. Read CLI-PROVIDERS.md for the CLI *invocation mechanics* only; the chain is Local-primary per `PROJECT.md`.
2. **Model cache location is `~/.ollama/models` (port 11434), not `~/.cache`.** `PROJECT.md` Active wording ("caches under `~/.cache`") is imprecise — Ollama's real default is `~/.ollama/models`, relocatable via `OLLAMA_MODELS` (point it at an app-scoped dir for control). Correct the wording; document one cache truth consistently (Pitfall 5).
3. **Local runtime = Ollama >= 0.19 with adopt-if-present / own-if-started.** Ollama is a shared system-wide daemon on `:11434`, so the supervisor must **probe first, spawn `ollama serve` only if absent, and NOT kill a daemon it didn't start**; keep-resident is `keep_alive:-1`, not holding the process. (llama-server is the architecturally symmetric app-owned alternative if Ollama's daemon model becomes a problem — same OpenAI-compatible code path.)
4. **STT is resident whisper.cpp** — `smart-whisper` in-process (STACK's preferred: no separate process to supervise) *or* a supervised `whisper-server` (ARCHITECTURE's pattern: crash isolation). Both are valid; Phase 4 picks. Either way it replaces the per-utterance Python spawn.
5. **CommonJS-only:** avoid ESM-only libs (`get-port@7`, `execa@9`, `node-fetch@3`) — they throw on `require` in this bundler-free app.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH / MEDIUM | HIGH on core runtime/model/STT picks (official Ollama/whisper.cpp/npm docs, verified module types). MEDIUM on latency/memory figures and younger libs (`smart-whisper` single-maintainer; `electron-ollama` 0.1.x; Ollama MLX vision path unconfirmed). |
| Features | MEDIUM-HIGH | HIGH for the competitive feature set (corroborated across primary GitHub repos + product pages + multiple reviews). MEDIUM for proactive-suggestion UX patterns (academic + design sources, less battle-tested in this niche). |
| Architecture | HIGH | Existing seams read directly from source (`main.js`, `speech.service.js`, `capture.service.js`, `prompt-loader.js`); external service surfaces verified against official docs; forge prior art read directly. |
| Pitfalls | MEDIUM-HIGH | Grounded in official docs (Ollama/Claude Code/Electron/marked/electron-builder) + forge workflow + corroborating community sources. Context7 MCP was unavailable this run; VLM image-token specifics and macOS-TCC-vs-signing behavior are MEDIUM. |

**Overall confidence:** MEDIUM-HIGH — the architecture and sequencing are well-grounded in read-from-source seams and official docs; the residual uncertainty is empirical (real TTFT/memory on 32 GB) and product-tuning (the relevance gate), both of which resolve through measurement during the flagged phases rather than more upfront research.

### Gaps to Address

- **System/loopback audio capture (mic + system audio + AEC)** `[RESEARCH-SURFACED]` — the biggest gap between the Core Value ("saying **or hearing**") and current mic-only scope; table stakes for meeting/interview use across all serious competitors, but HIGH-complexity and platform-specific (macOS ScreenCaptureKit/BlackHole, Windows WASAPI loopback, Linux PulseAudio monitor + AEC). **Requirements must explicitly decide v1 vs v1.x.** If v1, it slots alongside Phase 4/6 (continuous listening); if deferred, the interview use case requires the user to re-voice questions.
- **STT embedding strategy** — in-process `smart-whisper` (simplest, no supervision) vs a separate `whisper-server` (crash isolation, supervised like Ollama). Resolve in Phase 4 planning; validate native-addon ABI against Electron 29 early.
- **VLM sizing on real hardware** — `qwen3-vl:8b` is the confident default, but the sub-3s TTFT budget and total-memory coexistence on 32 GB are *estimates*; instrument and validate at Phase 3 (TTFT at session *end* with full notes, memory pressure at minute 45), not just fresh-session demos.
- **Relevance-gate tuning** — thresholds, cooldown, endpointing beyond VAD, and suppressing the assistant's own speech / hallucinated silence are empirical; Phase 6 needs iteration in real use.
- **Ollama MLX path requires >32 GB unified memory** — exactly 32 GB is borderline; the Metal/GGML path still serves vision below that. Don't default to `qwen3-vl:30b`/`gemma3:27b` on 32 GB (swap risk).
- **macOS SpeechAnalyzer (macOS 26+)** — a faster/more-accurate on-device STT fast-path to layer on *after* the portable whisper.cpp baseline works (macOS-only, no HTTP server -> needs a Swift helper). Optional later optimization, not v1.

## Sources

### Primary (HIGH confidence)
- **Ollama** — OpenAI compatibility, FAQ (`~/.ollama/models`, `OLLAMA_MODELS`, `:11434`, `keep_alive:-1`, `MAX_LOADED_MODELS`/`NUM_PARALLEL`), MLX blog (0.19, >32 GB), Qwen3-VL + Gemma3 library pages — https://docs.ollama.com/api/openai-compatibility , https://docs.ollama.com/faq , https://ollama.com/blog/mlx , https://ollama.com/library/qwen3-vl , https://ollama.com/library/gemma3
- **whisper.cpp** — v1.9.1, Metal + Core ML, `whisper-server` `/inference` multipart — https://github.com/ggml-org/whisper.cpp (+ server README)
- **Claude Code headless** — `claude -p`, `--output-format json/stream-json`, `--append-system-prompt`, `--allowedTools`, auth precedence, non-zero exits, 10 MB stdin cap — https://code.claude.com/docs/en/headless
- **OpenAI Codex CLI** — `codex exec`, `--json`, `-i` image, `--sandbox`, `--ephemeral`, `CODEX_NON_INTERACTIVE` — https://learn.chatgpt.com/docs/non-interactive-mode
- **Electron** — `desktopCapturer` (macOS permission behavior, older-permission-system flag), `powerMonitor` (thermal/battery), electron-builder Application Contents (asar can't spawn; `asarUnpack`/`extraResources`) — https://www.electronjs.org/docs/latest/api/desktop-capturer , /power-monitor , https://www.electron.build/docs/contents/
- **marked / DOMPurify** — sanitizer removed in v5 (bring your own); `removed` array — https://github.com/markedjs/marked/discussions/1232 , https://github.com/cure53/DOMPurify
- **npm registry** (module type verified 2026-07-13) — `openai@6.46.0` (cjs), `ollama@0.6.3` (dual), `wait-on@9`/`tree-kill@1.2.2` (cjs); `get-port@7`/`execa@9` (**esm**)
- **Existing codebase (read directly)** — `main.js` (lifecycle :172-175, LLM call-sites :1028-1360, coalesce seam :1181-1237), `speech.service.js` (VAD :800-902), `capture.service.js`, `llm.service.js`, `prompt-loader.js`, `.planning/codebase/` (ARCHITECTURE/STRUCTURE/CONCERNS), `.planning/PROJECT.md`
- **forge (local prior art)** — headless `ask-code.ts` template, `agent-args.ts` arg shaping, `main.ts:fixEnv` login-shell env, `.github/workflows/release.yml` unsigned universal DMG — `/Users/ashutosh/personal/forge`
- **Competitor repos/pages** — Glass/Pickle, Natively, Pluely (system-audio), Meetily, Screenpipe, Project Raven, Highlight AI, Granola, Otter, Final Round AI, Cluely

### Secondary (MEDIUM confidence)
- **faster-whisper Apple Silicon** (CPU-only, no Metal) — https://github.com/SYSTRAN/faster-whisper/issues/515
- **smart-whisper / whisper-node-addon** (resident model, prebuilt Electron binaries; single maintainer) — https://github.com/JacobLinCool/smart-whisper , https://github.com/Kutalia/whisper-node-addon
- **electron-ollama** (0.1.x sidecar) — https://github.com/antarasi/electron-ollama
- **Apple Silicon Metal ~75%-RAM GPU cap, `iogpu.wired_limit_mb`** — https://stencel.io/posts/apple-silicon-limitations-with-usage-on-local-llm.html
- **Whisper silence-hallucination + `no_speech_threshold`** — https://github.com/openai/whisper/discussions/679 , https://github.com/SYSTRAN/faster-whisper/issues/843
- **macOS TCC tied to code signature; unsigned/ad-hoc lose grants on rebuild; Sequoia Gatekeeper** — https://developer.apple.com/forums/thread/730043 , https://mjtsai.com/blog/2024/07/05/sequoia-removes-gatekeeper-contextual-menu-override/
- **Qwen2.5-VL ~1,280 patch tokens/image** — https://huggingface.co/docs/transformers/model_doc/qwen2_5_vl
- **Cluely breach / Rewind->Meta pivot (trust moat)** — https://tldv.io/blog/cluely-review/ , https://en.wikipedia.org/wiki/Cluely , https://memx.app/alternatives/rewind-ai/
- **Codex/Claude CLI image + headless corroboration** — https://codex.danielvaughan.com/2026/03/28/codex-cli-image-workflows/ , https://smartscope.blog/en/generative-ai/claude/claude-code-image-guide/

### Tertiary (LOW confidence — needs validation)
- **macOS SpeechAnalyzer benchmark figures** (~2x faster, WER 9.02%->2.12%) — Apple docs HIGH, benchmark numbers MEDIUM-LOW — https://developer.apple.com/documentation/speech/speechanalyzer
- **Resident-RAM / TTFT estimates per model** — hardware-dependent; validate on target 32 GB machine (STACK.md tables)
- **Proactive-suggestion UX patterns** (relevance filter + importance threshold + ephemeral) — academic/practitioner, less battle-tested in this niche — https://arxiv.org/pdf/2509.21730 , https://www.cekura.ai/blogs/endpointing-in-voice-ai-turn-detection

---
*Research completed: 2026-07-13*
*Ready for roadmap: yes*
