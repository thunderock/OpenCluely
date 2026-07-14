# Feature Research

**Domain:** Always-on, local-first multimodal AI desktop copilot (meeting / interview / general-question assistant)
**Researched:** 2026-07-13
**Confidence:** MEDIUM-HIGH — HIGH for the competitive feature set (corroborated across primary GitHub repos + product pages + multiple reviews); MEDIUM for proactive-suggestion UX design patterns (academic + design sources, less battle-tested in this product niche)

> **Scope note (brownfield milestone).** This maps features for the *new always-on local-AI experience*. It does **not** re-catalog OpenCluely's locked/validated capabilities (stealth overlay, on-demand screenshot→answer, mic VAD + Whisper filter, streaming pipeline, session memory, md-skill-prompt loader, global shortcuts). Those are treated as the *existing foundation* and referenced only where a new feature builds on or replaces one.
>
> **Two items below were surfaced by research and are NOT yet in `PROJECT.md`'s Active list** — flagged inline as `[RESEARCH-SURFACED]` for requirements definition to accept or reject:
> 1. **System/loopback audio capture** (hearing the *other* side of a call) — today OpenCluely is mic-only, yet the stated Core Value reacts to "what you're saying **or hearing**."
> 2. **A cheap pre-filter before expensive generation** in the relevance gate — matters because continuous mode would otherwise invoke the model on every pause just to decide relevance.

---

## Competitive Landscape (who was surveyed)

| Product | Type | Listening | Screen | Providers | Local? | Stealth | Closest to OpenCluely on… |
|---------|------|-----------|--------|-----------|--------|---------|---------------------------|
| **Cluely** | Commercial, cloud | Continuous transcription, hotkey answer | OCR of screen | Cloud LLMs | No | Yes ($75/mo tier) | Overlay + stealth; opposite on privacy |
| **Pluely** (OSS, Tauri) | OSS, BYOK | Mic **+ system audio** (BlackHole/WASAPI/PulseAudio), VAD | Screenshot, multimodal | OpenAI/Claude/Grok/Gemini | Partial (BYOK) | Yes | Direct lineage; multi-provider + system audio |
| **Glass / Pickle** (OSS) | OSS | **On-demand** (Ctrl+Enter) + continuous screen watch; Rust AEC | Continuous monitor | OpenAI/Gemini/Claude/**Ollama** | Yes (Ollama) | Yes ("no always-on capture" as a *virtue*) | Local option; but reactive, anti-always-on |
| **Natively** (OSS) | OSS | **Continuous** dual-channel, WebRTC-ML VAD | Screenshot + OCR | Gemini/OpenAI/Claude/Groq + **Ollama** | Yes (100% offline) | Yes (process disguise) | **Closest overall**: always-on, local, context injection, personas |
| **Meetily** (OSS, Rust) | OSS notetaker | Continuous, Parakeet/Whisper, diarization | No | **Ollama** + BYOK | Yes (100% local) | No (notetaker, not stealth) | Local STT + local summarize |
| **Highlight AI** | Commercial, local-first | Continuous, on-device transcription | OS-level screen context | Cloud + local | Local-first, opt-in cloud | No | Local-first + screen context + user context |
| **Granola** | Commercial | Continuous (no bot) | No | Cloud | No | No | Bot-free desktop capture; human-in-loop notes |
| **Otter** | Commercial | Continuous, **joins as bot** | Slide capture | Cloud | No | No | (Anti-model: bot-based) |
| **Final Round AI** | Commercial | Continuous, sub-3s answer | Screen | Cloud | Yes | No | Interview auto-answer latency bar |
| **Rewind → Limitless** | Commercial (pivoted) | 24/7 record everything | 24/7 record | Cloud (now) | *Was* local; pivoted to cloud (Meta) | No | Cautionary tale for local-first |
| **Screenpipe** | OSS | 24/7 record everything | 24/7 event-driven | Ollama + BYOK | Yes | No | Local capture; but "record everything" (anti-model) |

**Takeaway:** OpenCluely's exact combination — **always-on + local-primary + screen+voice fusion + escalation-to-a-stronger-model + trust affordances** — is not fully occupied by any single competitor. Natively is the closest, but it leans BYOK-cloud-first and uses OCR + a persistent vector store. The white space is *proactive-but-gated, fully-local-by-default, ephemeral (no persistent capture store)*.

---

## Feature Landscape

### Table Stakes (Users Expect These)

Missing any of these makes an always-on copilot in this category feel broken or unusable.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **System / loopback audio capture (hear the other side)** `[RESEARCH-SURFACED]` | In a meeting/interview the *question comes from the other person* — their voice arrives via speakers (system audio), not your mic. Every serious competitor captures **mic + system audio** with echo cancellation (Pluely, Natively, Glass, Raven, Cluely). OpenCluely is **mic-only today** (verified: no BlackHole/WASAPI/loopback in codebase). Core Value says "saying **or hearing**" → this is implied but unscoped. | **HIGH** | Platform-specific: macOS ScreenCaptureKit/BlackHole, Windows WASAPI loopback, Linux PulseAudio monitor; plus acoustic echo cancellation (AEC) so speaker output doesn't bleed into the mic. **Biggest gap between core value and current scope.** |
| **Persistent, continuous STT** (not per-utterance subprocess) | Always-on listening requires a resident transcriber; spawning a Python/Whisper process per utterance (current impl) is the #1 latency blocker (already in scope). | **HIGH** | Already in PROJECT.md Active. Prerequisite for everything continuous. |
| **Low-latency streaming answer (sub-3s to first token)** | Real-time copilots live or die on latency; Final Round markets "sub-3-second" answers. OpenCluely already streams (SSE) — the new risk is the *local model* hitting this bar on Apple Silicon. | **MEDIUM** | Reuse existing streaming overlay; gate on quantized-model TTFT. Local model is the only thing on the per-pause path (cloud CLI is never per-pause). |
| **Screen-share invisibility / stealth overlay** | Table stakes *in this specific category* — Cluely, Pluely, Glass, Natively, Final Round all have it. It's the entry ticket, not a differentiator here. | (existing) | Already locked (`setContentProtection` + process disguise). Keep. macOS/Windows only. |
| **Provider choice + local option** | Multi-LLM is now standard (all OSS competitors offer 3-4 providers + Ollama). Users expect to not be locked to one model. | **MEDIUM** | Delivered by the `LLMProvider` abstraction + Local/Claude/Codex providers (in scope). |
| **Manual show/hide + global hotkeys** | Baseline overlay control. | (existing) | Locked. |
| **Fully local/offline processing path** | For the privacy-first segment OpenCluely targets, "runs offline, nothing leaves the machine" is now expected (Meetily, Natively, Highlight, Screenpipe all offer it). | **HIGH** | Delivered by self-starting local model + STT services (in scope). |
| **Pause / kill switch for capture** | Any always-on capture tool must let the user *instantly stop* listening/watching. Non-negotiable for trust and for private moments (passwords, other calls). | **LOW-MEDIUM** | In scope. Must be a single obvious action, not buried in settings. |
| **Personal/custom context injection** | Cluely (playbooks/doc upload), Natively (context + resume + reference files), Highlight (user context) all inject user-provided context. Users expect the copilot to "know their stuff." | **LOW-MEDIUM** | OpenCluely's md-folder-as-context is its version (in scope). |

### Differentiators (Competitive Advantage)

Where OpenCluely competes. These align with the Core Value (local, fast, private, proactive-but-relevant).

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Continuous, proactive suggestions gated by a relevance filter** | The headline. Most competitors are *on-demand* (press a hotkey to ask); Glass is explicitly reactive and even markets "no always-on capture." A copilot that *proactively* surfaces an answer after each pause — **only when it's actually answerable** — is the differentiating experience. | **HIGH** | The hard part is "reply only when answerable" (see UX section). OpenCluely already has an *intelligent-filter skeleton* (`llm.service.js` ~L690-818: casual-vs-relevant classification, currently skill-scoped) to generalize. |
| **Local-first as the *primary* path (not a fallback)** | Cluely/Otter/Granola/Final Round are cloud-primary. Rewind's local-first → cloud (Meta) pivot and Cluely's 83k-user data breach make "genuinely local by default" a durable, trust-based differentiator, not just a checkbox. | **HIGH** | Self-starting local model service + supervisor (download/cache/resident/health/restart-with-backoff). In scope. |
| **On-demand escalation to a stronger model (Claude/Codex CLI)** | Genuinely uncommon: competitors let you *pick one* provider; OpenCluely runs local for speed and lets you **escalate a hard question** to Claude/Codex on demand. Best-of-both without paying cloud latency/cost per pause. | **MEDIUM** | Reuse `thunderock/forge` headless-CLI pattern + existing terminal auth (no stored API keys). Never on the per-pause path. |
| **Screen+voice fusion at the pause — no OCR, no persistent recording** | Cluely/Natively OCR the screen; Rewind/Screenpipe record 24/7 (5-10 GB/mo). OpenCluely sends the *image directly* to a multimodal model and grabs the screen *only at the pause* (throttled, downscaled, frame-diff-deduped), storing nothing. Simpler, faster, more private. | **MEDIUM** | Multimodal local model sized for Apple Silicon 32 GB+. Frame-diff dedup avoids re-sending unchanged screens. |
| **Live personal-notes folder (.md) as standing context** | Vs. static one-time uploads (Cluely playbooks, Natively files): a *watched folder of your own markdown notes*, reloaded fresh every startup, bounded-concatenated into context. Your evolving knowledge, no re-upload, no cloud. | **LOW-MEDIUM** | Bounded concatenation, **no RAG** in v1 (PROJECT.md decision — "few md files fit a context slot"). `prompt-loader.js` directory-scan is the skeleton. |
| **General-purpose (not just coding/DSA)** | Interview-coder tools (Interview Coder, this repo's origin) are DSA-locked. Generalizing the skill/prompt to *any* question is a positioning differentiator. | **LOW-MEDIUM** | Generalize the skill-prompt system; keep skill packs as optional overlays. |
| **Self-visible "listening / watching" indicator (trust-forward always-on)** | Stealth tools deliberately hide *everything* — including from the user. A prominent, always-visible "I'm listening / I'm watching" state (distinct from OS orange-dot) makes always-on *acceptable*: the user always knows the copilot's state. This is the affordance that squares "always-on" with "trustworthy." | **LOW-MEDIUM** | Pairs with the pause/kill switch. macOS already shows an orange (mic) / purple (screen) dot at OS level; the in-app indicator adds intent + one-click control. |

### Anti-Features (Commonly Requested, Often Problematic)

Deliberately do **not** build these — evidence-backed.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| **Reply on *every* pause (always-answer)** | "It's always-on, so it should always help." | Interruption fatigue — proactive-AI research is unanimous that unfiltered suggestions become noise and get ignored/disabled. Also wastes the local model on non-questions. | Relevance gate + turn detection + **ephemeral** suggestions that auto-clear on intent change. Answer only when confidently answerable. |
| **Cloud upload of screen/audio/transcripts** | Bigger cloud models; easy sync. | Directly against the privacy thesis. Cluely leaked 83k users' transcripts + screenshots; Rewind's local promise died on the Meta acquisition. This is the trust moat. | Local-first by default; cloud only via *opt-in* CLI escalation that reuses terminal auth (no app-stored keys). |
| **24/7 persistent recording + searchable history** (Rewind/Screenpipe model) | "Remember everything." | Storage cost (5-10 GB/mo), a standing privacy liability (a searchable archive of everything you saw/heard), and a *different product*. | Ephemeral: capture the screen/transcript window *at the pause*, use it, keep only bounded in-session memory. No capture datastore. |
| **Continuous full-res screen OCR / heavy watch loop** | "See everything on screen precisely." | Latency, CPU/GPU cost, and privacy surface; OCR also loses layout/visual meaning a multimodal model keeps. | Throttled + downscaled + frame-diff-deduped screenshot, image straight to the multimodal model (no OCR step) — already OpenCluely's plan. |
| **Meeting bot that joins the call** | Otter/Fireflies auto-join; "official" transcript. | Announces itself in the attendee list (kills stealth + consent optics), needs calendar/OAuth, and is a heavier integration. | Desktop-side system-audio capture — invisible, no bot, no calendar coupling (Granola/Cluely/Glass all do this). |
| **Speaker diarization (who-said-what)** | "Label the interviewer vs me." | Complex (embeddings/clustering, fails with one shared device), marginal value for a *single-user answer* copilot that just needs "what was asked." | Treat transcript as rolling context; skip attribution in v1. Revisit only if multi-speaker summaries become a goal. |
| **CRM / calendar / team-sharing integrations** | Enterprise polish (Cluely has Salesforce/HubSpot). | Scope creep toward the enterprise-notetaker category; conflicts with single-user local-tool positioning (PROJECT.md already out-of-scopes multi-user/telemetry). | Stay a single-user, local, real-time *answer* copilot. |
| **RAG / vector store for notes (v1)** | "Scale to a huge notes library." | Premature: bounded concatenation covers "few md files"; adds an index, embeddings, and a store to maintain. | Bounded concat now (PROJECT.md decision); add retrieval only if notes outgrow the context slot. |
| **Spoken answers / TTS talk-back** | "Just tell me the answer." | Audio output during a live call breaks stealth and can be heard by others. | Silent overlay text only. |
| **Post-meeting summary/notes as a headline feature** | Granola/Otter/Meetily core value. | Different product (notetaker vs live-answer copilot); dilutes the "instant answer after a pause" focus and pulls toward storage/history. | Optional, deferrable extra (v2+); not the core loop. |

---

## Feature Dependencies

```
LLMProvider abstraction  (foundational — everything routes through it)
    ├──requires──> LocalProvider (primary)
    │                   └──requires──> Local-service lifecycle supervisor
    │                                      (download / cache / resident / health / restart-backoff)
    └──requires──> Claude/Codex CLI providers (escalation, off the per-pause path)

Persistent STT server  (replaces per-utterance subprocess)
    └──enables──> Continuous always-on listening
                       └──requires──> Relevance gate (else noise = anti-feature)
                                          └──enhanced-by──> Cheap pre-filter  [RESEARCH-SURFACED]
                                                            (heuristic/local classifier BEFORE
                                                             expensive generation, per pause)

Continuous always-on mode
    ├──requires──> Turn/pause detection (endpointing, beyond raw VAD)
    ├──requires──> Screen capture at the pause (throttle + downscale + frame-diff dedup)
    │                   └──requires──> Local multimodal model (image+text+context → reply)
    ├──requires──> md-context injection
    │                   └──requires──> Generalized prompt system (not skill-locked)
    └──controlled-by──> Listening/watching indicator + Pause/Kill switch

System audio capture (hear the other side)  [RESEARCH-SURFACED]
    └──requires──> Acoustic echo cancellation (AEC)
    └──enables──> Answering questions the OTHER person asks
                  (fulfills the "or hearing" half of Core Value)

Output sanitization before innerHTML
    └──required-by──> Screen-watch + md-context (untrusted-content volume grows)
```

### Dependency Notes

- **Continuous listening requires the persistent STT server:** the per-utterance subprocess reload is the dominant voice latency and can't sustain an always-on loop. (PROJECT.md: "#1 blocker.")
- **Continuous mode requires the relevance gate:** without it, always-on becomes always-reply — the top anti-feature. The gate is what makes "always-on" tolerable.
- **Relevance gate is enhanced by a cheap pre-filter `[RESEARCH-SURFACED]`:** the current filter is an *LLM-prompt decision* ("is this relevant to the active skill?"). In continuous mode that means invoking the model on *every* pause just to decide whether to answer — a latency/cost tax. A cheap first stage (keyword/heuristic, `seemsLikeQuestion`, or a tiny local classifier — the keyword fallback at `llm.service.js` ~L1366 is a starting point) should short-circuit obvious non-questions before the expensive generation call.
- **Everything routes through the provider abstraction:** it's the refactor that unblocks Local + escalation; do it first.
- **System audio capture enables the interview/meeting use case `[RESEARCH-SURFACED]`:** without it the copilot only ever sees *your* speech, so it can't answer a question the interviewer asks unless you re-voice it. Ties directly to the "or hearing" clause of the Core Value.
- **Turn detection > raw VAD:** VAD answers "speech or silence?"; it can't tell a *thinking pause* from a *finished thought*, so silence-only triggering fires prematurely mid-sentence. Endpointing (punctuation cues, adaptive silence timeout, prosody) reduces false triggers — directly serves "reply only after a *natural* pause."

---

## The Hard UX Problem: "Reply Only When It's Actually Answerable"

This is OpenCluely's core differentiator and its main design risk. Findings from proactive-AI and voice-AI research:

1. **Two decisions, not one.** (a) *Is the turn actually over?* (endpointing) and (b) *Is there something worth saying?* (relevance/answerability). Conflating them causes both premature and irrelevant suggestions.
2. **Endpointing is genuinely hard** — described by voice-AI practitioners as "one of the absolute hardest engineering problems." Fixed 0.5 s silence fails; use punctuation-aware + adaptive timeouts (shorter when the transcript ends like a question, longer when it trails off).
3. **Relevance = filter + threshold.** Ask "is this in the user's current context?" *and* "is it important/answerable enough to interrupt?" Only cross both bars → surface.
4. **Suggestions must be ephemeral.** Auto-clear stale suggestions when intent shifts; never stack a backlog of unanswered prompts. A suggestion that arrives late for a topic already passed is worse than none.
5. **Don't interrupt active input.** Suppress/soften when the user is actively typing or clearly mid-task (matches "user-state analysis" from the proactive-AI literature).
6. **Fail toward silence.** Because models are *confidently wrong* (automation-bias risk is real, and severe in interviews), when answerability is uncertain, prefer *not* surfacing over surfacing a confident-but-wrong answer. A quieter copilot that's right is more trusted than a chatty one that's sometimes wrong.

**Design implication:** a two-stage gate — cheap endpoint/relevance pre-filter → (only if it passes) local generation with an answerability check — plus ephemeral, non-stacking overlay suggestions.

---

## Privacy Affordances for Always-On Capture (deep-dive)

Because OpenCluely is *always-on* (unlike reactive Glass, which markets "no always-on capture" as a virtue), privacy affordances are what make the always-on stance *acceptable* rather than creepy:

| Affordance | Table Stakes / Differentiator | Notes |
|-----------|-------------------------------|-------|
| **Self-visible listening/watching indicator** | Differentiator (trust) | Distinct from the OS orange (mic) / purple (screen) dot; conveys *the app's* state + intent. The thing that makes always-on honest. |
| **One-click pause / kill switch** | Table stakes | Instantly halts capture. Must be reachable without opening settings. |
| **Local-only by default; cloud only on explicit escalation** | Differentiator (the moat) | Mirrors Highlight AI's "data leaves only when you attach it to a cloud query." |
| **No persistent capture store** | Differentiator | Nothing recorded to disk; bounded in-session memory only. Directly counters the Rewind/Screenpipe liability. |
| **Exclusions (apps/windows/private moments)** | Nice-to-have (v1.x+) | Rewind offered per-app/site/time exclusions. Could later suppress capture for password managers, banking, other calls. Defer, but design capture so it's addable. |
| **OS permission honesty** | Table stakes | Clear mic/screen permission prompts with accurate usage strings (Info.plist already has these). |

---

## MVP Definition

Anchored on the Core Value: *"after any natural pause, a relevant, streamed answer appears in the stealth overlay, generated by a local model from screen + speech + your notes."*

### Launch With (v1)

- [ ] **`LLMProvider` abstraction** — foundational; unblocks Local + escalation.
- [ ] **`LocalProvider` (primary) + lifecycle supervisor** — self-start, download/cache, resident, health-check, restart-with-backoff. This *is* the Core Value's engine.
- [ ] **Local multimodal model** (image+text+context → reply), Apple-Silicon 32 GB+ sized, hitting sub-3s TTFT.
- [ ] **Persistent STT server** — replaces per-utterance subprocess; prerequisite for continuous listening.
- [ ] **Continuous always-on loop** — listen + (screen-at-pause) watch; per-pause: screen + recent transcript + md-context → local model.
- [ ] **Generalized relevance gate with a cheap pre-filter first** — reply only when answerable; not skill-locked. `[pre-filter = RESEARCH-SURFACED]`
- [ ] **md-context injection** — watched folder, bounded concatenation, reloaded per startup.
- [ ] **Continuous screen capture** — interval throttle + downscale + frame-diff dedup, image direct to model (no OCR).
- [ ] **Listening/watching indicator + pause/kill switch** — the trust surface for always-on.
- [ ] **Output sanitization before `innerHTML`** — hardening as untrusted-content volume grows.
- [ ] *(kept from existing)* stealth overlay, streaming answer pipeline, global hotkeys, session memory.

### Add After Validation (v1.x)

- [ ] **System / loopback audio capture + AEC** `[RESEARCH-SURFACED]` — *strong candidate to pull into v1*: without it the interview/meeting use case only works if the user re-voices the question. Deferred here only because it's HIGH-complexity + platform-specific; **requirements should explicitly decide v1 vs v1.x.** Trigger to add: any real meeting/interview testing.
- [ ] **`ClaudeProvider` / `CodexProvider` escalation** — local works standalone; add escalation once the local path is solid. Trigger: local model demonstrably weak on a class of hard questions.
- [ ] **Endpointing upgrade** (punctuation/adaptive/prosody beyond raw VAD). Trigger: false-trigger rate too high in real use.
- [ ] **Capture exclusions** (per-app/window/private-moment). Trigger: user hits a "don't watch this" moment.

### Future Consideration (v2+)

- [ ] **RAG / vector retrieval for notes** — only if md-context outgrows the context slot.
- [ ] **Speaker diarization** — only if multi-speaker summaries become a goal.
- [ ] **Optional post-session summary/notes** — only if users ask for a notetaker layer.
- [ ] **Custom personas / skill packs** (Natively-style domain modes) — optional overlays on the general-purpose base.

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| LocalProvider + supervisor (primary path) | HIGH | HIGH | **P1** |
| Persistent STT server | HIGH | HIGH | **P1** |
| Continuous always-on loop | HIGH | HIGH | **P1** |
| Relevance gate + cheap pre-filter | HIGH | MEDIUM | **P1** |
| LLMProvider abstraction | HIGH (enabler) | MEDIUM | **P1** |
| md-context injection | HIGH | LOW-MEDIUM | **P1** |
| Screen capture throttle/downscale/dedup | HIGH | MEDIUM | **P1** |
| Listening/watching indicator + pause/kill | HIGH (trust) | LOW-MEDIUM | **P1** |
| Output sanitization | MEDIUM (security) | LOW-MEDIUM | **P1** |
| **System/loopback audio capture + AEC** `[RESEARCH-SURFACED]` | **HIGH** | **HIGH** | **P1/P2** (requirements to decide) |
| Claude/Codex escalation | MEDIUM | MEDIUM | **P2** |
| Endpointing upgrade (beyond VAD) | MEDIUM | MEDIUM | **P2** |
| Generalize skill/prompt system | MEDIUM | LOW-MEDIUM | **P2** |
| Capture exclusions | MEDIUM | MEDIUM | **P3** |
| RAG for notes | LOW (until notes grow) | HIGH | **P3** |
| Speaker diarization | LOW | HIGH | **P3** |
| Post-session summary | LOW-MEDIUM | MEDIUM | **P3** |

**Priority key:** P1 = must-have for launch · P2 = should-have, add when possible · P3 = future.

---

## Competitor Feature Analysis

| Feature | Cluely | Glass (OSS) | Natively (OSS) | Our Approach |
|---------|--------|-------------|----------------|--------------|
| Listening model | Continuous + hotkey answer | On-demand (Ctrl+Enter) | Continuous dual-channel | **Continuous, proactive, gated by relevance** |
| Other-side audio | System audio | Mic+system via AEC | Dual-channel | **Mic-only today → gap `[RESEARCH-SURFACED]`** |
| Screen understanding | OCR | Continuous monitor | Screenshot + OCR | **Screenshot at pause, image→multimodal, no OCR** |
| Relevance/when-to-answer | Hotkey (user decides) | Hotkey (user decides) | Profile router by domain | **Auto-gate: reply only when answerable** |
| Local/offline | No | Ollama option | 100% offline (Ollama) | **Local as the primary path** |
| Provider strategy | Cloud only | Pick one (incl. local) | Pick one (incl. local) | **Local primary + on-demand escalation to Claude/Codex** |
| Personal context | Uploaded playbooks | — | Context + resume + files | **Live watched .md folder, bounded, no RAG** |
| Persistence | Cloud history | — | SQLite vector store | **Ephemeral, no capture store** |
| Privacy posture | Breached (83k users) | "No always-on capture" | Local + process disguise | **Always-on but trust-forward: indicator + kill + local-only** |
| Stealth | Yes ($75/mo) | Yes | Yes | **Yes (existing, locked)** |

---

## Sources

**Primary (product repos / official pages) — HIGH confidence:**
- Glass / Pickle — https://github.com/pickle-com/glass
- Natively — https://github.com/Natively-AI-assistant/natively-cluely-ai-assistant
- Pluely — https://github.com/iamsrikanthnani/pluely ; system-audio feature page https://pluely.com/features/system-audio-capture ; mic/VAD https://pluely.com/features/microphone-capture
- Meetily — https://github.com/Zackriya-Solutions/meetily ; https://meetily.ai/
- Screenpipe — https://github.com/screenpipe/screenpipe
- Project Raven (system+mic + WebRTC AEC3, local) — https://github.com/Laxcorp-Research/project-raven
- Highlight AI — https://highlightai.com/product ; https://highlightai.com/assistant
- Granola — https://www.granola.ai/blog/how-to-use-ai-to-take-meeting-notes-a-step-by-step-guide-for-2026
- Otter — https://otter.ai/
- Final Round AI Interview Copilot — https://www.finalroundai.com/interview-copilot
- Cluely — https://cluely.com/

**Secondary (reviews / analysis) — MEDIUM confidence:**
- Cluely review + data-breach context — https://tldv.io/blog/cluely-review/ ; https://en.wikipedia.org/wiki/Cluely
- Cluely pricing/features — https://dupple.com/tools/cluely ; https://www.eesel.ai/blog/cluely-pricing
- Cluely vs Glass (positioning) — https://hyperlush.com/cluely-vs-glass/
- Rewind→Limitless→Meta pivot & EFF audit — https://memx.app/alternatives/rewind-ai/ ; https://andrewschreiber.substack.com/p/an-early-adopters-thoughts-on-rewindais
- Local AI notetakers roundup — https://heymumble.com/blog/local-ai-meeting-note-takers-mac ; https://blog.buildbetter.ai/best-local-ai-meeting-recorders-no-cloud-2026/

**Proactive-suggestion & turn-detection UX — MEDIUM confidence (academic + practitioner):**
- Proactive AI agents (relevance filter, importance threshold, ephemeral suggestions) — https://www.lyzr.ai/glossaries/proactive-ai-agents/ ; https://arxiv.org/pdf/2509.21730 (ProPerSim)
- Proactive assistants for programming (CHI 2025) — https://dl.acm.org/doi/10.1145/3706598.3714002 ; CodingGenie https://arxiv.org/pdf/2503.14724
- Turn detection / endpointing (why VAD-only fails) — https://theten.ai/blog/ai-powered-turn-detection/ ; https://www.cekura.ai/blogs/endpointing-in-voice-ai-turn-detection
- AI hallucination / confidently-wrong / automation bias — https://www.knostic.ai/blog/ai-hallucinations

**macOS privacy affordances — HIGH confidence:**
- Recording indicator / TCC / mic control — https://support.apple.com/guide/mac-help/control-access-to-the-microphone-on-mac-mchla1b1e1fe/mac ; https://corelock.net/blog/mac-privacy-permissions-explained

**Codebase (verified directly) — HIGH confidence:**
- Mic-only capture (`node-record-lpcm16`, 16 kHz mono; Web Audio on Windows) — `src/services/speech.service.js`; no system/loopback/BlackHole/WASAPI references anywhere in `src/`.
- Existing relevance-filter skeleton — `src/services/llm.service.js` (~L690-818 LLM-prompt classifier; ~L1366 keyword/`seemsLikeQuestion` fallback).

---
*Feature research for: always-on local-first multimodal AI desktop copilot*
*Researched: 2026-07-13*
