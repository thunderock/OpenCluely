---
phase: quick-260716-wyo
plan: 01
subsystem: prompts / llm-pipeline / ui
tags: [cleanup, prompt-engineering, electron, plumbing-removal]
requires: []
provides:
  - "Language-free UI: no coding-language selector in overlay or settings"
  - "Language-free call chain: main.js -> LocalProvider -> RequestBuilder with no programmingLanguage param"
  - "Static Language Policy (default Python, context overrides) in prompts/programming.md riding both prompt paths"
  - "Default-Python smart clause in the hardcoded transcription prompt (spoken path)"
  - "skill-normalizer exports normalizeSkillName only — injection machinery deleted"
affects: [phase-06-relevance-gate, phase-08-packaging]
tech-stack:
  added: []
  patterns:
    - "Static prompt clause over runtime injection: one .md sentence replaces three injection paths"
    - "Unused-but-contractual params renamed _-prefixed (LLMProvider base-class arity preserved)"
key-files:
  created: []
  modified:
    - main.js
    - src/services/providers/local.provider.js
    - src/core/request-builder.js
    - test/request-builder.test.js
    - src/core/skill-normalizer.js
    - prompt-loader.js
    - src/managers/session.manager.js
    - prompts/programming.md
    - test/skill-normalizer.test.js
key-decisions:
  - "Remove programmingLanguage params outright (not keep-dead) — both sides of every positional call changed in one task to dodge the arity hazard"
  - "generate/generateStream keep their options slot as _options — the LLMProvider base-class contract keeps 2/3-arity, onDelta stays 3rd"
  - "getSkillContext reduced to ONLY the session-memory fallback branch — behavior-identical to the pre-change language-null path (no fresh getSkillPrompt call)"
metrics:
  duration: "~8 min (recovery session) + prior partial session (Task 1 + partial Task 2)"
  completed: "2026-07-17"
  tasks: 3
  files: 14
---

# Quick 260716-wyo Plan 01: Remove Coding-Language UI Everywhere Summary

**One-liner:** Coding-language picker (overlay cycler + settings dropdown) and all three prompt-injection paths deleted; replaced by a static default-Python-with-context-override clause in programming.md + the transcription prompt.

## What was built

The manual coding-language concept is gone end-to-end:

- **UI (Task 1, `25ed5f7`):** overlay `#languageSelector` command-item + orphaned select CSS, settings "Coding Language" dropdown (section retitled "Skills"), both window scripts' listeners/save-aggregation, and the `onCodingLanguageChanged` preload bridge. Zero ipcMain registrations touched (`coding-language-changed` was outbound-only) — the ipc-scope reflection test stayed green throughout.
- **Plumbing (Task 2, `e034ad7`):** `main.js` lost the `codingLanguage` field, the three `needsProgrammingLanguage` triples, the getSettings field, and the saveSettings broadcast block (stale `saveSettings({codingLanguage})` now falls through silently — no key check remains, body try/catch-wrapped). `LocalProvider.process*Stream` signatures are language-free (`onDelta` shifted left), `enforceProgrammingLanguage` deleted. `RequestBuilder` builders + `formatImageInstruction` + `getIntelligentTranscriptionPrompt` dropped the param; the hardcoded transcription prompt (which never loads programming.md) got its own "default to Python unless the question, on-screen code, or spoken context clearly indicates another language" phrasing.
- **Injection machinery (Task 3, `14f4c91`):** `skill-normalizer.js` exports only `normalizeSkillName` (skillMap incl. `dsa`→`programming` aliases untouched); `prompt-loader.js` lost the injection branch + `requiresProgrammingLanguage`/`getSkillsRequiringProgrammingLanguage`; `session.manager.getSkillContext` keeps only the session-memory `skill_prompt_initialization` branch (the branch that already executed with language null — runtime behavior unchanged). `prompts/programming.md` gained the `## Language Policy` section, which `loadPrompts()` carries into BOTH remaining paths (image `getSkillPrompt` + text session-memory init).

## Verification results

| Gate | Result |
| --- | --- |
| `make run_tests` | 188/188 pass (193 → 188: 5 retired injection-describe tests removed, 0 failures) |
| `make lint` | exit 0 |
| Absence sweep (all 9 terms, runtime files) | clean — zero refs in main.js, preload*.js, prompt-loader.js, index/settings.html, src/, test/ |
| `getIntelligentTranscriptionPrompt('programming')` | contains "default to Python", no CODING CONTEXT block |
| `getSkillPrompt('programming')` (and `'dsa'` alias) | Language Policy + "Default to **Python**" load OK |
| `getSkillContext('programming')` | returns only `{skillPrompt, recentEvents, currentSkill}` |
| ipc-scope reflection test | green (zero channels added/removed) |

## Deviations from Plan

### Executor death + recovery (process, not code)

**1. Previous executor died mid-Task-2; this session resumed without restarting**
- **Found during:** Session start
- **Issue:** Task 1 was committed (`25ed5f7`) but Task 2 was half-applied and uncommitted (main.js + local.provider.js edited; request-builder.js + test untouched; `make lint` failing).
- **Recovery:** Diffed the dirty tree against the plan's Task-2 spec — both partial diffs matched the plan's intent exactly (all main.js deletions + provider signature/metadata/enforceProgrammingLanguage changes), so the work was kept and built upon rather than reset.
- **Commits:** `e034ad7` (completed Task 2), `14f4c91` (Task 3)

### Auto-fixed Issues

**2. [Rule 1 - Bug] Fixed 2 `no-unused-vars` lint errors left by the interrupted edit**
- **Found during:** Task 2 (resume)
- **Issue:** The dead executor's provider edit removed the `options.programmingLanguage` reads but left the params named `options` → `no-unused-vars` at local.provider.js:139 and :161 (the plan's own verification note warned to watch for exactly this).
- **Fix:** Renamed to `_options` (matches the eslint `argsIgnorePattern: '^_'` convention AND the `LLMProvider` base-class `generate(_neutralRequest, _options)` idiom), preserving arity so `onDelta` stays the 3rd `generateStream` arg.
- **Files modified:** src/services/providers/local.provider.js
- **Commit:** `e034ad7`

No other deviations — Tasks 2 (remainder) and 3 executed exactly as written.

## Known Stubs

None. The illustrative ```` ```language ```` placeholder fence in programming.md's "### 4. Production Code" is intentional prompt content the plan explicitly preserved, not a stub.

## Commits

| Task | Commit | Description |
| --- | --- | --- |
| 1 | `25ed5f7` | remove coding-language UI from overlay + settings (previous executor) |
| 2 | `e034ad7` | remove programmingLanguage plumbing through main/provider/builder; default-Python transcription clause |
| 3 | `14f4c91` | retire language-injection machinery; static default-Python Language Policy in programming.md |

Net: −193 lines of language machinery, +72 (mostly the static clause + reworded prompts). All commits explicit-pathspec, local only (never push — repo delivery policy).

## Self-Check: PASSED

- All 9 modified files present on disk; SUMMARY.md created
- Commits 25ed5f7 / e034ad7 / 14f4c91 verified in git log
- Working tree clean except SUMMARY.md (committed in the final docs commit)
