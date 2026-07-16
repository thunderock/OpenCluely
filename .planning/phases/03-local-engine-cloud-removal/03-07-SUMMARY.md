---
phase: 03-local-engine-cloud-removal
plan: 07
subsystem: testing
tags: [ollama, qwen3-vl, smoke, ttft, no_think, local-provider, verification, human-gate]

# Dependency graph
requires:
  - phase: 03-local-engine-cloud-removal (03-03)
    provides: "LocalProvider (/v1 over the openai SDK, /no_think in the system prompt, text + image serialize)"
  - phase: 03-local-engine-cloud-removal (03-04)
    provides: "LocalModelManager (adopt/own Ollama, resident keep_alive, 3-level health) + local IPC"
  - phase: 03-local-engine-cloud-removal (03-05)
    provides: "provider/model settings UI (Local default, curated + advanced pickers)"
  - phase: 03-local-engine-cloud-removal (03-06)
    provides: "first-run onboarding (guide-install + pull) + in-overlay Local-down recovery"
provides:
  - "PROVEN: Local is the working default answer path — text streams + screenshots answered directly, both locally over /v1 (the precondition gate 03-08 requires)"
  - "scripts/smoke-local.js — a reusable, dependency-free TTFT/memory smoke (prefill via /api/chat prompt_eval_duration; answer + wall-clock TTFT via the app's /v1 path; SMOKE_NUM_PREDICT tunable)"
  - "Human sign-off 'approved' recorded (2026-07-15) — Local proven at the Phase-3 rough bar"
affects: [03-08 (PROV-07 Gemini removal — this sign-off is its hard precondition), Phase 6 (full sustained-load TTFT validation + the qwen3-vl over-reasoning decision), Phase 4 (STT — deliberately NOT exercised here)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Smoke measures the answer + user-perceived TTFT over the app's /v1 path (LocalProvider), while keeping /api/chat only for the authoritative prompt_eval_duration prefill number"
    - "Mirror LocalProvider's /no_think system-prompt switch in any qwen3 probe (the API think:false param is NOT honored by qwen3-vl on this Ollama)"
    - "Never block a serverUp-gated status poll on a model-liveness generate — probe it cheaply + bounded, or skip it (probeResponds:false)"

key-files:
  created:
    - "scripts/smoke-local.js — Task 1 TTFT/memory smoke (commit 8ddcc26; reworked db71009)"
  modified:
    - "src/core/local-model.manager.js — _modelResponds cheap bounded ping + getStatus({probeResponds}) fast path (25b7278); _ollamaBinFallbacks(~/.ollama/bin) + spawn-PATH prepend (27d8737)"
    - "main.js / preload.js / onboarding.js — thread probeResponds:false to the onboarding detect (25b7278)"
    - "test/local-model-manager.test.js — regression tests 11-15 (25b7278, 27d8737)"

key-decisions:
  - "Audio/STT is OUT of scope for this gate — it is Phase 4; Azure STT stays untouched through Phase 3. The three on-demand entry points (type / screenshot / ask) are what 03-07 proves."
  - "SC5 satisfied at the Phase-3 ROUGH bar only; full sustained-load / minute-45 / real-full-notes validation DEFERRED to Phase 6 (documented divergence)."
  - "qwen3-vl:8b over-reasons on heavy multimodal prompts even with /no_think → slow time-to-first-content. Accepted at this gate (rough/lenient); flagged as a Phase-6 decision (candidate: switch default to a non-reasoning curated model, gemma3)."

patterns-established:
  - "Faithful local validation goes through the app's real transport (openai SDK -> /v1 + /no_think), not the native /api/chat — the two diverge on qwen3-vl reasoning behavior"

# Metrics
duration: human-verify gate (multi-session); env-prep + validation ~this session
completed: 2026-07-15
---

# Phase 3 / Plan 07: Prove Local Summary

**Local is PROVEN as the working default answer path — typed text streams and screenshots are answered directly, both locally over `/v1`, with the human sign-off "approved" that 03-08 (Gemini removal) requires.**

## Performance

- **Duration:** human-verify gate spanning sessions; blockers cleared + env prepped + validated this session
- **Completed:** 2026-07-15
- **Tasks:** 2 (Task 1 auto — smoke harness; Task 2 — human-verify gate, approved)
- **Files modified:** 1 created (smoke) + 5 touched by gap fixes

## Accomplishments

- **Functional gate PASSED (user-verified on the real app):** screenshot answered directly (SC2) and typed/chat text answers locally (SC1/SC4). User signed off **"approved."**
- **Direct validation (Claude, during env-prep):** the app's exact `/v1` + `/no_think` path returns clean content — text ~4.0 s TTFT, image ~5.6 s with a *correct* frame description, **no `<think>` leak** in either.
- **Memory/residency:** `ollama ps` → **100% GPU** (no CPU offload), SIZE ~6–7.8 GB, `keep_alive` resident. Model `qwen3-vl:8b` already pulled (6.1 GB).
- **Two pre-gate blockers fixed** (TDD RED→GREEN, atomic commits): the onboarding "Probing" hang and own-if-started auto-start hardening.
- **Smoke harness reworked** to measure the answer over the app's `/v1` path and to surface qwen3-vl's over-reasoning honestly.

## Task Commits

1. **Task 1: TTFT/memory smoke harness** — `8ddcc26` (test), reworked `db71009` (fix)
2. **Task 2: Human-verify gate** — no code; sign-off "approved" 2026-07-15

**Gap fixes cleared during the gate:**
- `25b7278` (fix) — bound `_modelResponds` cheap-ping + skip on onboarding detect (kills "Probing" hang); tests 11–13
- `27d8737` (fix) — resolve ollama bin from standard locations (`~/.ollama/bin`) + prepend bin dirs to spawn PATH; tests 14–15
- `8779c66`, `ba25145` (docs) — STATE.md tracking

Full suite **102/102**, eslint **0** after every commit.

## Files Created/Modified

- `scripts/smoke-local.js` — reusable local smoke; prefill via `/api/chat`, answer + TTFT via `/v1`, `SMOKE_NUM_PREDICT` tunable, honest reasoning-vs-empty verdict.
- `src/core/local-model.manager.js` — bounded cheap liveness ping; `getStatus({probeResponds})`; `_ollamaBinFallbacks()`; spawn-PATH prepend.
- `main.js` / `preload.js` / `onboarding.js` — `probeResponds:false` threaded to the serverUp-gated onboarding detect.
- `test/local-model-manager.test.js` — regression tests 11–15.

## Decisions Made

- **Audio/STT not tested** — out of scope (Phase 4); Azure STT kept intact through Phase 3.
- **SC5 documented divergence** — rough smoke only; full sustained-load validation → Phase 6.
- **qwen3-vl over-reasoning accepted at this gate**, flagged as a Phase-6 decision (candidate: non-reasoning default model).

## Deviations from Plan

Plan 03-07 declared only `scripts/smoke-local.js` as `files_modified`. During the human-verify gate, several **gap-closure** fixes to the local engine were required to make the gate attemptable/clean (the plan's own directive: "If verification fails, loop to gap closure"):

**1. [Gap] "Probing" hang — `getStatus()` blocked on a full model generate**
- **Fix:** `_modelResponds` cheap bounded ping (`think:false` + `num_predict:1` + ≤2.5 s timeout); `getStatus({probeResponds:false})` fast detection path.
- **Committed in:** `25b7278` (tests 11–13).

**2. [Gap] Auto-start binary resolution + spawn PATH under Electron GUI PATH**
- **Fix:** `~/.ollama/bin/ollama` fallback + prepend standard bin dirs to the spawn `env.PATH`.
- **Committed in:** `27d8737` (tests 14–15).

**3. [Gap] Smoke reported a false "empty answer"**
- **Fix:** mirror the app (`/no_think` in system, `/v1` answer path), tunable budget, honest verdict.
- **Committed in:** `db71009`.

**Impact:** all gap fixes made the gate attemptable and its evidence truthful. No scope creep beyond the local engine.

## Issues Encountered

- **qwen3-vl:8b over-reasons on heavy prompts even with `/no_think`.** On the realistic bounded-notes(12 KB) + image prompt it emits hundreds of `<think>` tokens before content (the API `think:false` is ignored; `/no_think` only fully works on simple prompts). Prefill ~6.8 s **plus** a long reasoning phase pushes time-to-first-content over the rough ~3–4 s target. This is RESEARCH Flag 1's empirical TTFT question, now observed → Phase-6 decision (see STATE.md Blockers/Concerns).
- Earlier "broken Ollama.app" saga resolved: broken `.app` removed; Homebrew `ollama` 0.32.0 is the working daemon (`brew services start ollama`).

## Next Phase Readiness

- **03-08 (Gemini removal) precondition met:** Local proven + human "approved." 03-08's own hard manual-approval gate still applies before any irreversible deletion.
- **Phase 6:** full sustained-load TTFT validation + decide the qwen3-vl over-reasoning tradeoff (accept vs. non-reasoning default model).
- **Phase 4:** STT layer (audio) — untouched here by design.

---
*Phase: 03-local-engine-cloud-removal*
*Completed: 2026-07-15*
