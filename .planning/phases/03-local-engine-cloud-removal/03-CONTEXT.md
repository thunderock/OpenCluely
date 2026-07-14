# Phase 3: Local Engine + Cloud Removal - Context

**Gathered:** 2026-07-14
**Status:** Ready for planning

<domain>
## Phase Boundary

Make a **local multimodal model** the **primary, default** answer path for the
existing **on-demand** entry points (text/typed-chat + screenshot), served by **Ollama**
(`qwen3-vl:8b`) over the OpenAI-compatible `http://127.0.0.1:11434/v1` endpoint — the
"if all else fails, this works" core engine — behind the Phase 2 `LLMProvider` seam.
Stand up a **`LocalModelManager`** (adopt/own Ollama, pull the model with visible
resumable progress, keep it resident). Add **provider + model selection in settings**
with Local as default. **Generalize** the skill/prompt system so the default answer is a
general copilot (not DSA/coding-only). Then — **only after Local is proven, behind a
hard manual checkpoint** — **fully remove Gemini + Azure**.

Requirements delivered: **PROV-03, PROV-04, PROV-05, PROV-06, PROV-07, GEN-01**.

**In scope for this phase:**
- `LocalProvider` implementing the Phase 2 interface (`generate` / `generateStream` /
  `isAvailable` / `testConnection`), text **streaming** + **multimodal screenshot** over `/v1`.
- `LocalModelManager`: adopt-if-present / own-if-started Ollama via the Phase 1
  `ServiceSupervisor`; ensure `qwen3-vl:8b` present (pull if missing, resumable progress);
  keep resident (`keep_alive:-1`); Ollama-default cache.
- First-run setup flow (see decisions): guide-install Ollama, auto-pull on first launch,
  progress in onboarding + settings, preflight disk/RAM warning.
- Settings: provider + model pickers (curated + "advanced: any installed"), **per-provider
  config blocks**, Local default, minimal provider switcher retained.
- **GEN-01**: default = concise general **reply-suggester**; Coding becomes an **opt-in skill
  overlay** (existing machinery kept, broadened DSA → general-purpose coding); skill picker
  in settings, default General.
- **Gemini + Azure removal** (SDKs, hardcoded hosts, Gemini cert-verify bypass, Azure
  browser-DOM polyfill) — **gated behind a manual checkpoint after Local is proven**;
  **keep STT working throughout** (see Azure timing decision).
- **Functional rebrand**: the app now answers as a general copilot; scrub in-app
  "interview"-specific strings (see cross-cutting Positioning section).

**Explicitly NOT in scope (deferred — do not pull in):**
- Continuous "always-on" mode / pause orchestrator / relevance gate — **Phase 6**.
- Resident STT engine (whisper.cpp / `smart-whisper`) — **Phase 4**.
- Continuous screen capture (throttle / downscale-before-encode / frame-diff dedup) +
  the **md-context source** + DOMPurify / TCC recovery / IPC scoping — **Phase 5**.
  (The `RequestBuilder` md-context input exists but stays empty/unused until Phase 5.)
- CLI backup providers (Claude / Codex) + login-shell env resolution — **Phase 7**.
- DMG CI / `asarUnpack` / `xattr` README / dead-code + license cleanup — **Phase 8**.
- Website interview-copy refresh + Pages deploy — **Phase 9 (WEB-01/02)**.
- **Full sustained-load** TTFT/memory validation (session-end, full notes, minute-45
  pressure) — that's **Phase 6**; Phase 3 does only a rough smoke (see removal gate).

## Locked (do not re-ask / do not re-litigate)

From ROADMAP SC + REQUIREMENTS + STACK research + Phase 2 carry-over:
- **Runtime:** Ollama ≥ 0.19. **Model:** `qwen3-vl:8b` default. **Endpoint:**
  `127.0.0.1:11434/v1`, OpenAI-compatible. **Resident:** `keep_alive:-1`.
- **Lifecycle:** adopt-if-present / own-if-started — **never kill an Ollama daemon it did
  not start** — via the Phase 1 `ServiceSupervisor`. **Cache:** Ollama default
  (`~/.ollama/models`), not `~/.cache`.
- **Multimodal-direct:** screenshot goes straight to the VLM, **no OCR step**.
- **Sequencing (load-bearing):** abstraction first → **Local proven** → cloud removed
  **last** (never removal-first — Pitfall 12).
- **Local is the default** provider; **bounded md-context, no RAG**.
- **Keep the `OpenCluely` name** (reposition messaging only — see Positioning).

Tech constraints carried from Phases 1–2 (still binding):
- **CommonJS + vanilla JS**, no bundler / TypeScript / framework; match existing
  conventions (incl. the `assests/` misspelling).
- **`LLMProvider` seam is fixed:** `LocalProvider` implements the same 4 methods and slots
  into the registry (`src/services/providers/`). **`RequestBuilder` owns prompt assembly**;
  the provider only **serializes** the neutral struct to its wire format — **no prompt logic
  in the provider** (mirror `GeminiProvider.serialize()` from Phase 2).
- **Logging:** `require('./core/logger').createServiceLogger('<TAG>')`; never interpolate
  variable data into the message. **Error philosophy:** degrade gracefully, never crash.
- **Tests:** Node's built-in `node:test` / `node --test`; no new framework.

</domain>

<decisions>
## Implementation Decisions

### First-run model setup
- **Ollama provisioning = guide the user to install.** When Ollama is missing, detect it
  and show install instructions / a link (openwhispr-style). App stays small; **do not**
  bundle the Ollama binary this phase (revisit for Phase 8 packaging if distribution
  widens). The primary user likely already has Ollama.
- **Model pull timing = auto-pull on first launch.** Onboarding pulls `qwen3-vl:8b`
  (~6 GB) up front so the app is answer-ready immediately after; accept a long one-time
  first-launch wait.
- **Progress + status UI = both onboarding AND settings.** Onboarding screen shows the
  first pull; a Settings **"Model"** section shows ongoing status + a **re-download / repair**
  action. Reuse the existing `whisper-installer.js` `download-*-model` IPC + progress flow.
- **Preflight check + warn.** Before the pull/model-load, check free disk (~6 GB+) and
  unified memory; warn clearly if the machine looks too small (friendly failure), then proceed.

### Cloud-removal gate (the load-bearing "burn the boats" step)
- **"Proven" = functional + a latency/memory smoke.** All 3 on-demand entry points work
  locally in the overlay (text streaming, screenshot answer, a general non-coding question),
  **plus** a rough TTFT + memory-under-ceiling check on a representative prompt (simulate the
  md-notes budget). **Full** sustained-load validation is deferred to Phase 6.
- **Deletion is a HARD MANUAL CHECKPOINT.** The phase **pauses** after Local is proven;
  the user personally verifies and **approves** the irreversible Gemini + Azure deletion as a
  **separate, clearly-labeled plan/commit**. Do not auto-delete on criteria pass.
- **Post-removal Local-down UX = error + one-click recovery.** After Gemini is gone (and
  before Phase 7 CLI backups exist), when Local can't answer (Ollama down / model missing /
  OOM), show an inline **"Local model unavailable"** message with a one-click action to
  **restart Ollama / re-pull the model / open settings**. This is now the sole engine, so
  recovery is first-class.
- **Keep STT working throughout (Azure timing).** Do **not** let Phase 3 cloud removal break
  voice. Remove the **Gemini LLM path + the Azure browser-DOM polyfill** now; if Azure also
  powers **STT**, **defer that specific removal** (or ensure the existing Python-Whisper path
  still works) until **Phase 4**'s resident engine lands. ⚠ Researcher must first CONFIRM what
  Azure actually powers before scoping the deletion.

### Provider & model settings
- **Model list = curated + "advanced: any installed".** Default dropdown is a vetted list
  (`qwen3-vl:8b` default, `qwen3-vl:30b`, `gemma3:4b`/`gemma3:12b`); plus an **advanced**
  option to pick **any** model Ollama has installed (query `ollama list` / `/v1/models`).
- **Keep a minimal provider switcher.** After Gemini removal, keep the provider-switch UI
  present with just **Local** so Phase 7 slots CLI providers in with **no UI rework** (the
  Phase 2 registry already supports it).
- **Per-provider config blocks.** Restructure config so each provider owns its block
  (Local: host / model / keep_alive; later Claude/Codex their own) — scales to Phase 7,
  matches the Phase 2 anticipation. (Phase 2 left Gemini config flat; reorganize here.)
- **Transition window = Local default, Gemini selectable until deleted.** Before the
  approved deletion, the user can flip back to **Gemini** for safety/comparison during
  validation; once deletion is approved, Local only.

### General-purpose default & skills (GEN-01)
- **Default answer style = concise reply-suggester.** With no skill overlay active, the
  default is **short, ready-to-say/answer suggestions** (matches the auto-reply-suggester
  core value + the future pause-triggered continuous mode); expands when explicitly asked.
- **Skill switch = settings picker, default = General.** A skill dropdown/list in settings;
  **General** is the default selection; Coding is one selectable skill. Reuse the existing
  `prompt-loader.js` skill-from-markdown mechanism with minimal change. (A quick in-overlay
  toggle/hotkey was **not** chosen for now.)
- **Coding overlay: keep the machinery as-is, but broaden its scope.** Preserve the existing
  language-injection + coding-prompt machinery **as-is**, but reframe the skill from
  **DSA-specific → general-purpose coding/programming** help. (User: "use coding machinery as
  is … but may be more general purpose coding.")
- **Initial skill set = General (default) + Coding.** Two skills, clean and minimal;
  **no interview branding** anywhere. (An optional Interview overlay was offered and
  **declined** for v1 — see Deferred.)

### Claude's Discretion
Within the locked decisions, the planner/researcher decide:
- Exact module paths/names (`local.provider.js` in `src/services/providers/`; a
  `LocalModelManager` in `src/core/` or `src/services/` following the Phase 1 DI shape).
- **Transport:** `openai` npm SDK (`baseURL` → localhost, `apiKey:'ollama'`) **vs.** reusing
  the existing hand-rolled `https` + SSE parser pointed at localhost — a research call.
- Health-check / readiness mechanics (`/api/version` poll + backoff), `tree-kill` on quit,
  and how the manager reports "adopted vs owned".
- Preflight thresholds, exact settings-UI layout, and concrete config key names for the
  per-provider blocks.
- The concrete default General system prompt (draft for review during planning).

</decisions>

<specifics>
## Specific Ideas

- **Reuse Phase 1 `ServiceSupervisor`** for the Ollama adopt/own lifecycle — this is its
  first real consumer (HTTP health-check + adopt-if-present, per its design). STT is Phase 4's.
- **Reuse the `whisper-installer.js` download-progress pattern** (IPC + onboarding UI) for the
  `ollama pull qwen3-vl:8b` progress; the official `ollama` npm `pull()` yields progress events.
- **Mirror the Phase 2 `GeminiProvider` shape:** `LocalProvider` gets its own `serialize()`
  (neutral struct → OpenAI `/v1` chat shape) and registers in `src/services/providers/index.js`.
- **Ollama images = base64 data-URL parts** (not remote `image_url`); the app already
  base64-encodes screenshot PNGs today — feed that into the `image_url` data URL.
- **openwhispr** is the reference for the "model service isn't installed → guide/download" UX.
- **`get-port@7` / `execa@9` / `node-fetch@3` are ESM-only** — cannot be `require()`d in this
  CJS app; use `net.createServer` port probe / `node:child_process` / global `fetch`.

</specifics>

<positioning>
## Cross-Cutting Decision — Reposition / Rebrand (founder directive, mid-discussion)

**Directive:** "I do not like its branding for just interviews … edit everything which says
it is for interviews, including website. We are developing this to be an automatic reply
suggester … rebrand it."

- **Scope = reposition messaging, KEEP the `OpenCluely` name.** The locked "keep the name"
  decision stands (avoids rename churn + the "Pluely" collision). **No product rename.**
- **New positioning to write toward:** *"a private, always-on copilot that watches your
  screen + hears the conversation and helps with anything"* (an automatic reply/answer
  suggester — general, not interview- or coding-specific).
- **Routing:**
  - **Functional** ("answer as a general copilot, not interview/DSA") → **GEN-01, THIS phase**
    (captured in the General-purpose decisions above).
  - **Copy/branding scrub** ("everything that says interviews") → **cross-cutting**, spans:
    **in-app strings** (scrub interview-specific copy where it appears — Phase 3/ongoing),
    **README** (Phase 8), **website** (already scoped as **WEB-01 / Phase 9** — this
    *reinforces + extends* it), and the **`PROJECT.md` positioning** itself.
  - **Recommended project-level follow-up (offered at hand-off):** update `PROJECT.md`'s
    positioning line + the ROADMAP WEB-01 wording so the whole roadmap inherits the new
    framing. Not a new capability — a repositioning of existing scope.

</positioning>

<deferred>
## Deferred Ideas

- **Rename the product** to a new name — **declined**; keep `OpenCluely` (reposition only).
- **Interview skill overlay** — **declined for v1**; could return later as one opt-in overlay
  among others (not the default or the product identity). [[general-purpose-skills]]
- **Bundle the Ollama binary as a sidecar** — deferred; revisit in **Phase 8** packaging if
  distribution widens (this phase guides the user to install instead).
- **Quick in-overlay skill toggle / hotkey** — not now; settings picker only this phase.
- **Mode-aware verbosity** (terse for live pauses vs. fuller on-demand) — a **Phase 6**
  concern; one default style this phase.
- **Full sustained-load TTFT/memory validation** (session-end + minute-45 pressure, full
  md-notes) — **Phase 6**; only a rough smoke here.

</deferred>

<research_flags>
## Research Flags (carry into /gsd:plan-phase → gsd-phase-researcher)

1. **Empirical TTFT + memory** for `qwen3-vl:8b` on 32 GB Apple Silicon — a rough smoke
   (simulate the md-notes budget); enough to satisfy the "proven" bar, not the Phase 6 full run.
2. **Exact multimodal request shape** for Ollama `/v1` (base64 data-URL image parts; how the
   neutral struct serializes to OpenAI `messages` with an image).
3. **Ollama adopt/own lifecycle** mechanics: detect running (`/api/version`), spawn `serve`
   with `OLLAMA_HOST`/`OLLAMA_KEEP_ALIVE`, health-check + backoff, `tree-kill` on quit.
4. **⚠ Confirm what Azure actually powers** in the codebase (LLM? STT? both?) BEFORE scoping
   removal — drives the "keep STT working / defer Azure-STT to Phase 4" decision.
5. **Transport choice:** `openai` npm SDK vs. reuse the existing hand-rolled `https`+SSE
   parser pointed at localhost (CJS-safe either way).
6. **Model-pull progress:** `ollama` npm `pull()` progress events wired to the existing
   download-progress IPC/UI.

</research_flags>

---

*Phase: 03-local-engine-cloud-removal*
*Context gathered: 2026-07-14*
