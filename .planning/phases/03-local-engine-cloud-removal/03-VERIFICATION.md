---
phase: 03-local-engine-cloud-removal
verified: 2026-07-15T20:33:54Z
status: passed
human_verified: "2026-07-15 — user ran `npm start` post-removal and approved: app boots on Local, the three on-demand entry points answer locally, screenshot answered directly, voice inits, no Gemini/API-key prompt. The one outstanding live-boot regression check is satisfied."
score: 6/6 must-haves verified in code (SC1–SC5 + GEN-01) + live post-removal boot confirmed by the user
re_verification:
  # No previous VERIFICATION.md — this is the initial verification.
human_verification:
  - test: "Live post-removal boot: `npm start`, then ask a typed question, capture a screenshot, and ask a general (non-coding) question."
    expected: "App boots on Local (no cloud config), the overlay streams a local answer to each of the three entry points, the screenshot is answered directly, and voice init does not crash. No Gemini/API-key prompt appears."
    why_human: "Electron GUI boot + voice-init is not feasible headless in a subagent. The three entry points were human-approved at the 03-07 gate, but that was BEFORE the 03-08 Gemini deletion — a live confirmation that removal didn't regress the boot/answer path is the one outstanding check. Code-level evidence (require chain resolves to provider=local, 96/96 tests, eslint 0, all edited files pass node -c, all wiring intact) strongly indicates it is intact."
---

# Phase 3: Local Engine + Cloud Removal — Verification Report

**Phase Goal:** A local multimodal model is the primary, default answer path over an OpenAI-compatible localhost endpoint (the "if all else fails, this works" core engine), and only after it is proven is Gemini deleted entirely. (Azure is STT-only; its SDK + browser-DOM polyfill move to Phase 4 so voice keeps working.)
**Verified:** 2026-07-15T20:33:54Z
**Status:** passed (live boot confirmed by the user 2026-07-15)
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria + GEN-01)

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| SC1 (PROV-03) | With no cloud configured, a text question streams tokens back into the overlay via `127.0.0.1:11434/v1` | ✓ VERIFIED | `local.provider.js` `generateStream()` = `client.chat.completions.create({stream:true})` → `for await chunk → onDelta(delta)`; baseURL `${host}/v1` where `config.llm.local.host`=`http://127.0.0.1:11434`; `processTextWithSkillStream` wired. Runtime: `getSelected()`→LocalProvider, `provider=local`. 03-07 human gate: text ~4.0s TTFT, clean stream, no `<think>` leak. |
| SC2 (PROV-04) | Screenshot answered directly by the multimodal model (no OCR step) | ✓ VERIFIED | `serialize()` maps `neutral.images` → `{type:'image_url', image_url:{url:'data:<mime>;base64,<b64>'}}` (RESEARCH Flag 2 nested shape); `processImageWithSkillStream` → `buildImageRequest` → `generateStream`. No OCR module in the path. 03-07 gate: image ~5.6s with a correct frame description. |
| SC3 (PROV-05) | First-run pulls `qwen3-vl:8b` (visible, resumable), Ollama-default cache, adopt-if-present / own-if-started, resident `keep_alive:-1` | ✓ VERIFIED | `local-model.manager.js` (372 lines): supervisor def `adopt:true`, `start()` adopts-else-spawns, `stop()` no-ops when adopted; `pullModel` = `ollama.pull({stream:true})` with structured `{status,percent}` progress + default `~/.ollama/models` cache; `keepAlive:-1` via serve-env + explicit `warmUp()`; owned-vs-adopted + 3-level health; warn-not-block `preflight()`; guide-install when binary absent. main.js/preload wire `download-model`→`model-pull-progress`, status/list/preflight/recover. 03-07: `ollama ps` 100% GPU, `keep_alive` resident. |
| SC4 (PROV-06) | User chooses provider + model in settings, Local default; a non-coding question gets a general answer; DSA/coding is an optional overlay | ✓ VERIFIED | `config.provider = LLM_PROVIDER \|\| 'local'`; registry local-only, `getSelected()`→`providers.local`; runtime `provider=local`. `settings.html`: Local provider option, curated + `__advanced__` model pickers, test-connection, restart-to-apply note. `settings-window.js` defaults to `'local'` + curated-vs-advanced. `main.js` persists `LLM_PROVIDER`/`LOCAL_MODEL`. |
| GEN-01 | Default answer style is a concise general reply-suggester; coding is an opt-in skill; no interview framing | ✓ VERIFIED | `main.js:96 activeSkill="general"` (answer-path default); `prompt-loader` ships only `['general','programming']`; `prompts/general.md` = concise reply-suggester, `programming.md` = "General-Purpose" (broadened from DSA); `prompts/dsa.md` DELETED; request-builder interview string removed; skill picker = General(default)+Coding. |
| SC5 (PROV-07) | Gemini fully removed (SDK, hosts, cert-verify bypass) — done LAST after Local proven; rough TTFT/memory smoke within budget, model GPU-resident, no swap | ✓ VERIFIED | Runtime grep clean; `gemini.provider.js` deleted; `@google/genai` gone (package.json + `npm ls` empty); registry/config gemini-free; cert-bypass gone (`setCertificateVerifyProc`/`rejectUnauthorized`/`NODE_TLS_REJECT` = none); `configureNetworkSession` is a guarded no-op delegate only. Sequencing: removal commits (fb8bfd8…) land AFTER the 03-07 human "approved" (b393697) — never removal-first. Azure SDK + `speech.service.js` + polyfill KEPT. `smoke-local.js` reads `prompt_eval_duration` over `/api/chat`+`/v1`, lenient 4s gate. |

**Score:** 6/6 truths verified at code level. One live post-removal GUI-boot/voice-init confirmation is flagged for human verification (see below).

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `src/core/config.js` | `llm.provider` (LLM_PROVIDER\|\|local) + `llm.local` block; NO `llm.gemini` | ✓ VERIFIED | provider default `local`, host/model/keepAlive:-1/curatedModels/think present; gemini block removed; azure speech block kept |
| `src/services/providers/index.js` | registry local-only; `getSelected()`→local | ✓ VERIFIED | `providers:{local}`, `selected=config.get('llm.provider')`, hardened fallback `\|\| this.providers.local` |
| `src/services/providers/local.provider.js` | LocalProvider: serialize + 4 interface methods + full call-site surface; ≥200 lines; `image_url` | ✓ VERIFIED | 432 lines; serialize is the single wire-shape site; streaming via openai SDK; graceful fallback; network-free ctor; NO `configureNetworkSession` (cert-bypass vanishes) |
| `src/core/local-model.manager.js` | adopt:true supervisor, pull progress, ensure/warm-up/preflight/health/getStatus; ≥150 lines | ✓ VERIFIED | 372 lines; all methods present + DI seam; bounded `_modelResponds` ping (kills "Probing" hang) |
| `prompts/general.md` + `prompts/programming.md` | concise general default + broadened coding; dsa.md gone | ✓ VERIFIED | general reply-suggester; coding general-purpose; `dsa.md` deleted |
| `settings.html` + `settings-window.js` | provider (Local) + model (curated+advanced) pickers + skill picker | ✓ VERIFIED | Local option, `__advanced__` model option, activeSkill General(default)+Coding, test-connection |
| `onboarding.html` + `onboarding.js` | Ollama guide-install + auto-pull with progress bar | ✓ VERIFIED | ollama detect via `getModelStatus.serverUp`; `pullModel(LOCAL_MODEL_TAG)` + `onModelPullProgress` subscribe; progress track (mirrors whisper plumbing) |
| `src/ui/main-window.js` | "Local model unavailable" recovery keyed off owned-vs-adopted | ✓ VERIFIED | panel + actions: owned+down→"Restart Ollama"; adopted→guide (never kills foreign daemon); `recoverModel('restart'/'repull')` |
| `scripts/smoke-local.js` | TTFT/memory smoke reading `prompt_eval_duration` | ✓ VERIFIED | prefill via `/api/chat`, answer + TTFT via app's `/v1`+`/no_think`, lenient 4s gate |
| `package.json` | `@google/genai` removed; `microsoft-cognitiveservices-speech-sdk` kept | ✓ VERIFIED | genai gone from manifest + dep tree; Azure SDK line 37 kept |
| `main.js` / `preload.js` | model IPC handlers + bridges; network delegate no-ops | ✓ VERIFIED | `getLocalModelManager().start()` on ready, `stop()` on quit; download-model/status/list/preflight/recover; 5 preload bridges; guarded network delegate |

_Discretionary additions (not in plan `files_modified`, verified working):_ `src/core/local-transport.js` (`ensureNativeGlobalURL()` + `nodeFetch` — shields the openai/ollama clients from the Azure browser-DOM polyfill poisoning `global.URL`), `src/core/first-run.js` (onboarding gating de-clouded), `test/local-transport.test.js`.

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `config.js` | `LLM_PROVIDER`/`OLLAMA_BASE_URL`/`LOCAL_MODEL` env | env overrides in loadConfiguration | ✓ WIRED | all three env reads present |
| `local.provider.js serialize()` | OpenAI `image_url` data-URL parts | `neutral.images.map` | ✓ WIRED | base64 data-URL, no OCR |
| `local.provider.js generateStream()` | `chat.completions.create({stream:true})` | `for await chunk → onDelta` | ✓ WIRED | streaming confirmed |
| `providers/index.js` | `config.llm.provider` | `getSelected()` fallback→local | ✓ WIRED | runtime resolves LocalProvider |
| `local-model.manager.js` | `service-supervisor.js` | `new ServiceSupervisor(def,{spawn})` adopt:true | ✓ WIRED | first real supervisor consumer |
| `main.js onAppReady` | `localModelManager.start()` | awaited on app ready (main.js:290) | ✓ WIRED | lazy `getLocalModelManager()` |
| `main.js download-model` | renderer `model-pull-progress` | `sender.send('model-pull-progress', p)` | ✓ WIRED | mirrors whisper progress |
| `onboarding.js` | `pullModel` + `onModelPullProgress` | auto-pull with progress bar | ✓ WIRED | lines 538/554 |
| `main-window.js recovery` | `getModelStatus` + `recoverModel` | actions keyed off owned/adopted | ✓ WIRED | restart/repull |
| `main.js setupNetworkConfiguration()` | `provider.configureNetworkSession` (undefined on Local) | guarded delegate no-ops | ✓ WIRED | cert-bypass vanishes, zero dead startup code |
| `providers/index.js getSelected()` | `this.providers.local` | fallback after gemini removed | ✓ WIRED | never-undefined |
| `smoke-local.js` | `127.0.0.1:11434` (`/api/chat`+`/v1`) | warm-up then representative request | ✓ WIRED | reads `prompt_eval_duration` |

### Requirements Coverage

| Requirement | Status | Note |
| ----------- | ------ | ---- |
| PROV-03 (text stream over /v1) | ✓ SATISFIED (code) | via SC1 |
| PROV-04 (multimodal screenshot) | ✓ SATISFIED (code) | via SC2 |
| PROV-05 (LocalModelManager adopt/own/pull/resident) | ✓ SATISFIED (code) + human-proven residency | via SC3; 03-07 `ollama ps` 100% GPU |
| PROV-06 (provider+model settings, Local default) | ✓ SATISFIED (code) | via SC4 |
| PROV-07 (Gemini fully removed, last) | ✓ SATISFIED | via SC5; sequencing confirmed in git history |
| GEN-01 (generalized skills, coding optional) | ✓ SATISFIED (code) | main.js default general; ships general+programming |

_Note: REQUIREMENTS.md still shows these as `[ ]` / "Pending" — this is the known gsd-tools-blind-to-prose behavior; checkboxes are marked manually at phase-completion/merge, not by the verifier._

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `src/ui/main-window.js` | 28, 294 | Legacy overlay skill-indicator hardcodes `availableSkills=['dsa']` and toggles `newSkill='dsa'` | ⚠️ Warning | The in-overlay skill toggle (explicitly DEFERRED in CONTEXT — "not chosen for now") still routes to DSA→Coding. Does NOT affect the GEN-01 default: `main.js:96` sets `activeSkill='general'` and the settings picker defaults to General. Documented copy-residual → P8/P9. |
| `src/managers/session.manager.js` | 11 | `this.currentSkill = 'dsa'` default | ⚠️ Warning | Session-memory grouping default only; the answer-path skill comes from `main.js:96` (`general`). Non-functional for the default answer style. Documented → P8/P9. |
| `src/ui/main-window.js` | 536, 1036, 1149 | `'dsa': 'DSA'` label/emoji maps | ℹ️ Info | Cosmetic label maps; harmless. Deferred copy scrub → P8/P9. |
| `setup.sh`, `README.md`, `.github/workflows/release.yml`, `webapp/index.html`, `MEMORY.md` | various | Residual Gemini/`GEMINI_API_KEY` copy | ℹ️ Info | All NON-runtime (shell setup, docs, CI release-notes, website, memory). Explicitly deferred: setup.sh + README + release.yml → Phase 8; webapp → Phase 9; MEMORY.md → post-merge memory step. Runtime files are grep-clean. |
| `test/local-provider.test.js`, `test/request-builder.test.js`, `test/env-file.test.js` | various | `gemini`/`GEMINI_API_KEY` strings | ℹ️ Info (intentional) | Assertions that Gemini is GONE (`registry.get('gemini')===undefined`; stale `LLM_PROVIDER=gemini`→Local; neutral struct emits no Gemini keys) + a provider-agnostic env-parse fixture. Correct, not residuals. |

_No 🛑 blocker anti-patterns found. No TODO/FIXME/placeholder/stub patterns in the new engine artifacts._

### Human Verification Required

**1. Live post-removal boot + three entry points**

- **Test:** `npm start`, then (a) type a question, (b) capture/attach a screenshot, (c) ask a general non-coding question.
- **Expected:** App boots on Local with no cloud config; each entry point streams a local answer into the overlay; the screenshot is answered directly (no OCR); voice init does not crash; no Gemini/API-key prompt appears.
- **Why human:** Electron GUI boot + voice-init cannot run headless in a subagent. The three entry points were human-approved at the 03-07 gate, but that sign-off predates the 03-08 Gemini deletion. This confirms the deletion did not regress the boot/answer path. Code-level evidence is strong: the require chain resolves to `provider=local`, 96/96 tests pass, eslint 0, all 11 edited runtime files pass `node -c`, and every key link is wired.

### Gaps Summary

No gaps block the phase goal. All five ROADMAP Success Criteria and GEN-01 are verified in the actual codebase, and the load-bearing sequencing rule — **abstraction first → Local built → Local proven → Gemini removed last** — is confirmed by git history: the 03-08 removal commits (`fb8bfd8`, `c435f17`, `81ad6c0`, `0a36624`) all land AFTER the 03-07 human "approved" sign-off (`b393697`), never before. Gemini is fully removed from all runtime surfaces (SDK, provider, registry, config block, IPC/preload/modal, cert-verify bypass, goldens/parity test — the 102→96 test drop reconciles exactly to the deleted parity suite), while Azure STT (SDK + browser-DOM polyfill + settings/onboarding) is deliberately kept intact for Phase 4 so voice keeps working. Quality gates are green (96/96 tests, eslint 0).

The status is `human_needed` (not `passed`) solely because one live check the goal leans on — a post-removal `npm start` GUI boot confirming the three on-demand entry points still answer on Local — cannot be executed headless. Everything verifiable without a live GUI is verified.

Two documented, non-blocking residuals to carry forward: (1) the legacy in-overlay skill-indicator (`main-window.js:28/294`) and `session.manager.js:11` still reference `'dsa'` — cosmetic/legacy, the GEN-01 functional default (`general`) holds via `main.js:96` and the settings picker; (2) non-runtime Gemini copy in setup.sh/README/release.yml/webapp/MEMORY.md — deferred to Phase 8/9/post-merge per existing STATE decisions. Also carried to Phase 6: `qwen3-vl:8b` over-reasons on heavy multimodal prompts even with `/no_think` (slow time-to-first-content) — accepted at the lenient Phase-3 rough gate, flagged as a Phase-6 default-model decision.

---

_Verified: 2026-07-15T20:33:54Z_
_Verifier: Claude (gsd-verifier)_
