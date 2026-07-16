---
phase: 03-local-engine-cloud-removal
plan: 02
subsystem: prompts
tags: [skills, prompts, gen-01, reply-suggester, transcription, request-builder, onboarding]

# Dependency graph
requires:
  - phase: 02-provider-abstraction
    provides: "RequestBuilder (getIntelligentTranscriptionPrompt, pure/DI) + the network-free Gemini golden-capture harness (scripts/capture-gemini-goldens.js)"
provides:
  - "General concise reply-suggester is the default skill (prompts/general.md)"
  - "Skill picker ships exactly General (default) + Coding; DSA folded into Coding via the programming skill"
  - "Both prompt sources de-interviewed: the .md skill path (prompt-loader) and the hardcoded transcription prompt (request-builder.js)"
  - "Coding language-injection machinery broadened DSA->general-purpose coding (dsa alias -> programming)"
affects: [PROV-07 (Gemini removal retires the transcription golden), 03-06 (onboarding model screens), 08-README, 09-website, in-app-string scrub]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Whitelist-based skill loading (SHIPPED_SKILLS = ['general','programming']) shared by loadPrompts + getAvailableSkills"
    - "Legacy-alias fold: dsa/data-structures/algorithms normalize to programming; getSkillPrompt('dsa') still resolves (via alias) to programming.md"
    - "Skill-aware-but-general transcription prompt: parameterized by activeSkill, short-by-default / expand-on-depth, keeps the programmingLanguage code-fence block"

key-files:
  created:
    - prompts/general.md
  modified:
    - prompt-loader.js
    - src/core/skill-normalizer.js
    - src/core/request-builder.js
    - prompts/programming.md
    - main.js
    - settings.html
    - onboarding.html
    - test/request-builder.test.js
    - test/skill-normalizer.test.js
    - test/fixtures/gemini-requests/transcription.json
  deleted:
    - prompts/dsa.md

key-decisions:
  - "General is the default skill; DSA is retired as a first-class skill and folded into Coding (the programming skill) rather than kept as a third option"
  - "dsa alias preserved (dsa/data-structures/algorithms -> programming) so old refs and captured goldens keep resolving; dsa.md deleted"
  - "Transcription prompt kept its H1 title 'Intelligent Transcription Response System' (stable test marker) but rewritten to a general short-by-default reply-suggester"
  - "Fixed three stale main.js coding-language gating lists + the skill-nav cycler as in-scope deviations (the rename directly broke them)"

patterns-established:
  - "Single source of truth for programming-language skills: skill-normalizer.SKILLS_REQUIRING_PROGRAMMING_LANGUAGE = ['programming']"
  - "Interview-scrub verification (grep -rni interview across the in-scope files must be empty)"

# Metrics
duration: 13min
completed: 2026-07-14
---

# Phase 3 Plan 02: Generalize Skill/Prompt System (GEN-01) Summary

**General concise reply-suggester is now the default skill, DSA folds into an opt-in Coding skill, and both prompt sources — the `.md` skill path and the hardcoded transcription prompt (incl. the interview string at request-builder.js:35) — are de-interviewed.**

## Performance

- **Duration:** 13 min
- **Started:** 2026-07-14T20:25:58Z
- **Completed:** 2026-07-14T20:37:59Z
- **Tasks:** 3
- **Files modified:** 12 (1 created, 10 modified, 1 deleted)

## Accomplishments
- Added `prompts/general.md` (concise reply-suggester) and made it the default answer style — no DSA/interview framing.
- Broadened the skill machinery: `prompt-loader` whitelists General + Coding; `skill-normalizer` folds the legacy `dsa`/`data-structures`/`algorithms` aliases into `programming` and the language-injection `case` fires for `programming` (so Coding keeps optimal-solution behavior).
- Rewrote `getIntelligentTranscriptionPrompt()` into a general, skill-aware, short-by-default / expand-on-depth reply-suggester — deleted the interview line at `request-builder.js:35`, dropped DSA-centric copy, kept the `programmingLanguage` code-fence block and the H1 marker.
- Flipped user-facing defaults: `main.js` default skill `dsa`->`general` (constructor + `getSettings`), settings picker now offers **General (default) + Coding**, and onboarding welcome/star copy repositioned to the private always-on copilot framing.
- Kept the suite coherent: added a no-interview assertion, updated the alias/injection expectations, and regenerated only the transcription golden. 63/63 node:test green, whole-repo eslint 0.

## Task Commits

Each task was committed atomically (explicit pathspec — parallel-safe with executor 03-01):

1. **Task 1: Add general.md, broaden loader + normalizer, reframe coding skill** - `22cae12` (feat)
2. **Task 2: Neutralize transcription prompt + flip skill defaults + scrub onboarding** - `b5fe940` (feat)
3. **Task 3: Update tests + regenerate the Gemini transcription golden** - `1147042` (test)

## Files Created/Modified
- `prompts/general.md` (created) - Concise reply-suggester; the new default skill prompt.
- `prompts/programming.md` - Reframed "Programming Interview Helper" -> general-purpose Coding assistant; folded the DSA guidance in as an "Algorithmic & DSA Problems" section (no interview framing).
- `prompts/dsa.md` (deleted) - The `dsa` alias now resolves to `programming.md`.
- `prompt-loader.js` - `SHIPPED_SKILLS = ['general','programming']` whitelist drives `loadPrompts` + `getAvailableSkills`.
- `src/core/skill-normalizer.js` - dsa aliases -> programming; `SKILLS_REQUIRING_PROGRAMMING_LANGUAGE = ['programming']`; injection `case 'dsa'` -> `case 'programming'`; removed the `behavioral-interview` alias.
- `src/core/request-builder.js` - `getIntelligentTranscriptionPrompt` rewritten general (interview line deleted; code-fence block + H1 preserved).
- `main.js` - default `activeSkill` -> `general` (x2); `navigateSkill` cycles `general`+`programming`; three coding-language gating lists `['dsa']` -> `['programming']`.
- `settings.html` - `#activeSkill` offers General (default) + Coding.
- `onboarding.html` - welcome + star copy repositioned off interview framing.
- `test/request-builder.test.js` - asserts transcription prompt has no interview framing (H1 marker retained).
- `test/skill-normalizer.test.js` - dsa aliases -> programming; injection tests use `programming`; SKILLS list `['programming']`.
- `test/fixtures/gemini-requests/transcription.json` - regenerated to the general prompt (text/image goldens unchanged).

_Note: `src/ui/settings-window.js` (listed in the plan's files_modified) required **no** change — it already wires `#activeSkill` generically and preselects the first option (General) when `settings.activeSkill` is `general`/unset. Verified, not modified._

## Decisions Made
- **General default; DSA retired as a skill, folded into Coding.** Shipping exactly two skills matches GEN-01; the `dsa` alias + injection `case 'programming'` preserve algorithmic-problem behavior without a separate DSA option.
- **Kept `getSkillPrompt('dsa')` resolvable via alias** (-> programming.md) so captured goldens and any stray refs don't break; deleted `dsa.md` per the plan's "prefer deletion".
- **Retained the transcription H1 title** as the stable test marker; rewrote only the framing/body.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Removed the `behavioral-interview` skill alias**
- **Found during:** Task 1 (broaden the normalizer)
- **Issue:** Task 1's own verify (`grep -ri interview ... src/core/skill-normalizer.js` must be empty) and the must-have "no interview framing in the skill machinery" were violated by the legacy `'behavioral-interview': 'behavioral'` alias.
- **Fix:** Deleted that single map entry (a dead alias for a non-shipped skill; `'behavioral'`/`'behavior'` remain). Zero functional impact — `behavioral` is not loadable or selectable.
- **Files modified:** src/core/skill-normalizer.js
- **Verification:** `grep -rni interview` across the in-scope set now returns nothing; eslint 0.
- **Committed in:** `22cae12` (Task 1 commit)

**2. [Rule 1 - Bug] Fixed the global-shortcut skill cycler for the new defaults**
- **Found during:** Task 2 (flip main.js defaults)
- **Issue:** `navigateSkill()` hardcoded `availableSkills = ["dsa"]`. After the default rename, `["dsa"].indexOf("general") === -1` made the cycler log a warning and no-op on every keypress.
- **Fix:** `["dsa"]` -> `["general", "programming"]` so the shortcut cycles the two shipped skills.
- **Files modified:** main.js
- **Verification:** node smoke of the default skill + skills list; eslint 0.
- **Committed in:** `b5fe940` (Task 2 commit)

**3. [Rule 1 - Bug] Repointed the three main.js coding-language gating lists dsa->programming**
- **Found during:** Task 2 (flip main.js defaults)
- **Issue:** Three copies of `const skillsRequiringProgrammingLanguage = ['dsa']` (image / chat-text / transcription paths) gate whether main.js passes the coding language into the (now-broadened) injection machinery. After canonical `dsa`->`programming`, `['dsa'].includes('programming')` is false — the Coding skill would silently stop receiving language injection, breaking the must-have "Coding help works via the existing programming-language-injection machinery."
- **Fix:** All three `['dsa']` -> `['programming']`.
- **Files modified:** main.js
- **Verification:** `getSkillPrompt('dsa','cpp')` and the transcription prompt for `('programming','cpp')` both still emit the language block; 63/63 tests; eslint 0.
- **Committed in:** `b5fe940` (Task 2 commit)

---

**Total deviations:** 3 auto-fixed (1 blocking, 2 bug). All directly caused by this plan's dsa->general/programming rename and load-bearing for GEN-01 must-haves. No scope creep.

## Deferred / Out-of-Scope Discoveries

Not fixed here (outside this plan's file scope and its interview-scrub set; part of the broader in-app-string reposition stream / soon-removed provider). Recorded for the orchestrator to fold into a phase-level `deferred-items.md` (avoided writing that shared file directly to prevent a write race with executor 03-01):

- `src/managers/session.manager.js:11` - `this.currentSkill = 'dsa'` default is stale (still resolves via alias; app default is now `general`).
- `src/ui/main-window.js` - renderer default skill `'dsa'` (l.13/28/294) + skill label maps `'dsa': 'DSA'` (l.522/761/874) have no `general`/`programming` entries.
- `src/ui/chat-window.js:301` - skill emoji map keyed `'dsa'` only.
- `src/services/providers/gemini.provider.js` - `'dsa'` hint maps (l.1166/1190) + a comment (l.271); the whole provider is removed at PROV-07.

## Issues Encountered
None. The transcription golden regeneration behaved exactly as the plan predicted (only `transcription.json` changed; text/image use faked prompts and were untouched).

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- GEN-01 (functional half) satisfied: general default, General+Coding picker, coding via injection, both prompt sources de-interviewed, tests + golden coherent.
- The transcription golden set is retired at PROV-07 (Gemini removal) per the plan — no action needed until then.
- Remaining interview/DSA copy in the renderer + session default + Gemini provider is logged above for the README (P8) / website (P9) / in-app-string scrub.

## Self-Check: PASSED

- Files verified on disk: `prompts/general.md`, `prompt-loader.js`, `src/core/skill-normalizer.js`, `src/core/request-builder.js`, `03-02-SUMMARY.md` all present; `prompts/dsa.md` confirmed deleted.
- Commits verified: `22cae12`, `b5fe940`, `1147042` all in git log.
- Plan verification: interview scrub empty across in-scope files; `getAvailableSkills() = ['general','programming']`; `getSkillPrompt('general')` + `getSkillPrompt('dsa')` (alias) non-null; main.js defaults `general`; 63/63 node:test pass; `npx eslint .` exit 0.

---
*Phase: 03-local-engine-cloud-removal*
*Completed: 2026-07-14*
