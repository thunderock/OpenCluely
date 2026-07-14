# Project Memory — OpenCluely

<!-- Per-repo durable facts. Global memory: ~/.claude/memory/ (Claude) / inlined in ~/.codex/AGENTS.md (Codex). -->
<!-- Keep this SHORT — only what's specific to THIS repo. Entries: `YYYY-MM-DD — what — why`. No secrets. -->

## What this is
Electron app being transformed from a cloud-Gemini on-demand overlay into a local-first, always-on multimodal copilot (GSD-planned, 9 phases; see `.planning/`).

## Local facts
- 2026-07-14 — Install deps with `npm ci --ignore-scripts` — plain `npm ci` (what `make setup`/`setup-dev` run) triggers the electron-builder postinstall that downloads the ~100 MB Electron binary; slow/destructive in sandboxed contexts.
- 2026-07-14 — Run tests with `node --test test/*.test.js` (glob) — the bare-directory form `node --test test/` fails to resolve on newer Node. Makefile `run_tests` and CI use the glob.
- 2026-07-14 — Lint gate is `npx eslint .` (ESLint 9 flat config `eslint.config.js`), error-only, must exit 0. `make lint` wraps it.
- 2026-07-14 — Pure, testable logic lives in `src/core/*` (env-file, skill-normalizer, vad-segmenter, service-supervisor); the god-file singletons (`src/services/speech.service.js` etc.) delegate to them. Tests must import `src/core/*`, never the singletons.
- 2026-07-14 — LLM path (post-Phase-2): `main.js` → `src/services/llm.service.js` (17-line facade = `require('./providers').getSelected()` — NOT destructured, that loses `this`) → `GeminiProvider` (`src/services/providers/gemini.provider.js`) → `RequestBuilder` (`src/core/request-builder.js`, pure/DI, emits input-neutral struct) → `serialize()` → transport. New providers register in `src/services/providers/index.js` (hardcoded `gemini` default until Phase 3 adds selection).
- 2026-07-14 — Provider-seam parity net: `test/gemini-request-parity.test.js` asserts byte-identical outgoing Gemini requests vs `test/fixtures/gemini-requests/*.json`; regenerate with `node scripts/capture-gemini-goldens.js`. This is the regression guard for any change to the LLM request path.
- 2026-07-14 — Gemini cert-verify bypass + UA override live in `GeminiProvider.configureNetworkSession()` (gated on selection), invoked from `main.js setupNetworkConfiguration()`. Azure/STT cert/UA remain in `speech.service.js` + `main-window.js` (Phase 3/4 removes them).

## Gotchas
- 2026-07-14 — gsd-tools CLI can't parse this repo's NARRATIVE ROADMAP/STATE format — `phase complete` / `state advance-plan` / `update-progress` silently no-op AND `phase complete` falsely reports `is_last_phase: true`. Mark phase/plan/requirement completion MANUALLY in ROADMAP.md + REQUIREMENTS.md; verify next-phase via ROADMAP, not the CLI's `is_last_phase`.
- 2026-07-14 — Parallel GSD executors share one branch/worktree: a bare `git commit` after `git add <file>` commits the whole staged index and can sweep a sibling's staged files into your commit (mislabeling attribution — see `510a7da` labeled feat(01-03) but containing 01-01 files). Use explicit-pathspec commits: `git commit -- <files>`.

## Workflow
- 2026-07-13 — Merge every phase to `main` when complete, BEFORE planning/branching the next phase, so phases don't entangle on one branch (next phase branches off freshly-merged main). Applies to every phase. Ashutosh does the merge + push himself; Claude flags the merge point and, post-merge, branches the next phase off main + captures learnings. (Lesson: Phase 2 was planned on the unmerged Phase 1 branch — entangled.)
- 2026-07-13 — After each phase merges to `main`, capture that phase's durable learnings into BOTH global memory (`~/.claude/memory/`; source: `ashutosh_setup/setup/memory/`) and this file. Ashutosh handles all GitHub pushes + phase merges himself — never auto-push/PR/merge.
