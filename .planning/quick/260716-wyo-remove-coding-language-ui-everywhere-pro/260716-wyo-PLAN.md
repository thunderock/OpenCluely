---
phase: quick-260716-wyo
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - index.html
  - src/ui/main-window.js
  - settings.html
  - src/ui/settings-window.js
  - preload.js
  - main.js
  - src/services/providers/local.provider.js
  - src/core/request-builder.js
  - src/core/skill-normalizer.js
  - prompt-loader.js
  - src/managers/session.manager.js
  - prompts/programming.md
  - test/skill-normalizer.test.js
  - test/request-builder.test.js
autonomous: true
requirements: [QUICK-LANG-01]

must_haves:
  truths:
    - "The overlay command tab shows no coding-language selector; changing language is impossible from the main window"
    - "The settings window shows no coding-language dropdown"
    - "Programming-skill answers default to Python via a static clause in the prompt; if the question / on-screen code / spoken context clearly indicates another language, the prompt instructs answering in that language"
    - "A stale saveSettings({codingLanguage}) call or leftover persisted value is silently ignored — no crash, no broadcast"
    - "make run_tests and make lint stay green; the ipc-scope reflection test still passes (no ipcMain channels added/removed)"
  artifacts:
    - path: "prompts/programming.md"
      provides: "Static Language Policy section: default Python, context overrides"
      contains: "Language Policy"
    - path: "index.html"
      provides: "Overlay command tab without #languageSelector / #codingLanguage"
    - path: "settings.html"
      provides: "Settings without the Coding Language item"
    - path: "src/core/skill-normalizer.js"
      provides: "Pure normalizeSkillName only — injection machinery deleted"
      exports: ["normalizeSkillName"]
    - path: "main.js"
      provides: "ApplicationController without codingLanguage field/plumbing"
  key_links:
    - from: "prompts/programming.md"
      to: "prompt-loader.js getSkillPrompt"
      via: "loadPrompts reads the .md — the static clause rides into every programming-skill prompt (image path + session-memory initialization)"
      pattern: "Language Policy"
    - from: "main.js llmService.process*Stream call sites"
      to: "src/services/providers/local.provider.js"
      via: "positional args — arity must be updated on BOTH sides in the same task (onDelta shifts left)"
      pattern: "processTextWithSkillStream"
    - from: "src/core/request-builder.js getIntelligentTranscriptionPrompt"
      to: "spoken/transcription answer path"
      via: "hardcoded transcription prompt carries its own default-Python phrasing (programming.md is NOT used on this path)"
      pattern: "default to Python"
---

<objective>
Remove the coding-language concept from all UI and plumbing. The programming skill prompt
gets a static "smart" clause instead: default to Python, but answer in another language when
the question, on-screen code, or spoken context clearly indicates it.

Purpose: the manual language picker (overlay cycler + settings dropdown) is dead weight — a
local multimodal model can infer the target language from context. Removing it simplifies
three prompt-injection paths down to one static clause.

Output: language-free UI (index.html, settings.html, both window scripts, preload), a
plumbing-free call chain (main.js → LocalProvider → RequestBuilder), the injection machinery
deleted (skill-normalizer, prompt-loader, session.manager), and prompts/programming.md +
the transcription prompt carrying the default-Python smart clause.
</objective>

<execution_context>
@$HOME/.config/opencode/get-shit-done/workflows/execute-plan.md
@$HOME/.config/opencode/get-shit-done/templates/summary.md
</execution_context>

<context>
@./MEMORY.md
@.planning/STATE.md

Locked user decisions (do not revisit):
1. Remove the overlay's language control entirely AND the settings coding-language dropdown. No manual language UI anywhere.
2. Replace per-language prompt injection with a static smart clause: default **Python**; question / on-screen code / spoken context clearly indicating another language wins.
3. Minimal + internal-consistency-safe: plumbing may be removed, but stale persisted `codingLanguage` input must be ignored gracefully (never crash).

Verified facts (from codebase reconnaissance — trust these):
- `codingLanguage` is IN-MEMORY ONLY (`main.js:104`), never persisted to `.env` (CONVENTIONS.md pattern 3). The only stale-input vector is a renderer sending `saveSettings({codingLanguage})`; `saveSettings` is try/catch-wrapped and only acts on keys it explicitly checks — deleting its `codingLanguage` block makes stale sends fall through harmlessly. Nothing else to guard.
- `coding-language-changed` is an OUTBOUND `broadcastToAllWindows` — NOT an `ipcMain` registration. The Phase-5 CHANNEL_AUDIENCES table (src/core/ipc-scope.js) + reflection test (test/ipc-scope.test.js) cover inbound channels only. This change adds/removes ZERO ipcMain registrations and ZERO table rows. `make run_tests` staying green proves it.
- `preload-overlay.js` has no coding-language API (checked). Only `preload.js:148` has the bridge.
- Positional-param hazard: `programmingLanguage` precedes `mdContext` in RequestBuilder builders and precedes `onDelta` in LocalProvider `process*Stream` — callers and callees must change in the same task.
- Baseline gates: `make run_tests` = 193/193, `make lint` = 0. Deps: if node_modules missing, `npm ci --ignore-scripts` (never plain `npm ci`).

<interfaces>
<!-- Current signatures the executor will modify. Extracted from the codebase. -->

main.js call sites (3x, in triggerScreenshotOCR / processWithLLM / transcription handler):
```js
const skillsRequiringProgrammingLanguage = ['programming'];                       // :1677, :1743, :1911
const needsProgrammingLanguage = skillsRequiringProgrammingLanguage.includes(this.activeSkill);
llmService.processImageWithSkillStream(buf, mime, skill, history, needsProgrammingLanguage ? this.codingLanguage : null, onDelta)   // :1687-1699
llmService.processTextWithSkillStream(text, skill, history, needsProgrammingLanguage ? this.codingLanguage : null, onDelta)          // :1754-
llmService.processTranscriptionWithIntelligentResponseStream(text, skill, history, needsProgrammingLanguage ? this.codingLanguage : null, onDelta) // :1927-1938
```

src/services/providers/local.provider.js:
```js
async processImageWithSkillStream(imageBuffer, mimeType, activeSkill, _sessionMemory = [], programmingLanguage = null, onDelta = null)  // :258
async processTextWithSkillStream(text, activeSkill, sessionMemory = [], programmingLanguage = null, onDelta = null)                     // :286
async processTranscriptionWithIntelligentResponseStream(text, activeSkill, sessionMemory = [], programmingLanguage = null, onDelta = null) // :312
// each: buildXRequest(..., programmingLanguage, contextManager.getContext()) -> generateStream(neutral, { programmingLanguage }, onDelta)
// each: metadata: { ..., programmingLanguage, ... }
async generate(neutral, options = {})                 // :139 — reads options.programmingLanguage -> enforceProgrammingLanguage
async generateStream(neutral, options = {}, onDelta)  // :163 — same
enforceProgrammingLanguage(text, programmingLanguage) // :221-243 — DELETE whole method
```

src/core/request-builder.js:
```js
formatImageInstruction(activeSkill, programmingLanguage)             // :26 — langNote appended when set
getIntelligentTranscriptionPrompt(activeSkill, programmingLanguage)  // :31 — CODING CONTEXT block :38-46; ":69 ...runnable solution in the selected programming language..."
buildTextRequest(text, activeSkill, sessionMemory = [], programmingLanguage = null, mdContext = '')           // :80
buildImageRequest(imageBufferOrBase64, mimeType, activeSkill, programmingLanguage = null, mdContext = '')     // :142
buildTranscriptionRequest(text, activeSkill, _sessionMemory = [], programmingLanguage = null, mdContext = '') // :161
```

src/managers/session.manager.js:
```js
getSkillContext(skillName = null, programmingLanguage = null)  // :236 — IMPORTANT: with language null the code ALREADY takes the
// session-memory fallback branch (skill_prompt_initialization lookup). The reduced method must keep ONLY that branch —
// do NOT replace it with a fresh promptLoader.getSkillPrompt call (that would change text-path behavior).
```

prompt-loader.js: `getSkillPrompt(skillName, programmingLanguage = null)` :57 (injection branch :70-72),
`injectProgrammingLanguage` :84, `getRequestComponents(..., programmingLanguage)` :131,
`updateStoredMemory(..., programmingLanguage)` :159, `requiresProgrammingLanguage` :183,
`getSkillsRequiringProgrammingLanguage` :192, constructor list :14, getSessionStats field :237.
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Remove all coding-language UI + renderer/preload bridges</name>
  <files>index.html, src/ui/main-window.js, settings.html, src/ui/settings-window.js, preload.js</files>
  <action>
Remove every user-facing language control and its renderer wiring (locked decision 1). Renderer HTML loads scripts without a bundler — plain surgical edits, no imports to fix.

1. **index.html**: delete the `#languageSelector` command-item (lines ~370-379: the `<div class="command-item" id="languageSelector">` with the `<select id="codingLanguage">`) AND its preceding `<div class="command-separator"></div>` (line ~369) so separators stay balanced. Delete the now-orphaned `.command-item select` CSS rules (the `select`, `select:hover`, `select:focus`, `select option` blocks at ~:194-235) — `#codingLanguage` was the only `<select>` in this file (verified).
2. **src/ui/main-window.js**: delete the whole "Language dropdown" block (lines ~342-378: `this.languageSelect = document.getElementById('codingLanguage')` through the change-listener including its resize `setTimeout`), and the `onCodingLanguageChanged` listener block (lines ~463-475 incl. its comment). Leave all other resize logic untouched — the command tab lays out via flex and existing resize triggers handle the narrower layout.
3. **settings.html**: delete the "Coding Language" `settings-item` (lines ~326-338: label + description + `<select class="input-field" id="codingLanguage">`). Retitle the section from "Language & Skills" to "Skills" (line ~323) since only Active Skill remains.
4. **src/ui/settings-window.js**: delete (a) the `codingLanguageSelect` const (line ~10); (b) the load-time default block (lines ~95-98, incl. the stale "Set C++ as default" comment); (c) the `onCodingLanguageChanged` listener (lines ~154-160) — CAREFUL: it sits inside the `if (window.electronAPI && window.electronAPI.receive)` block with irregular indentation; keep the `settings-window-shown` receive and keep braces balanced; (d) the save aggregation line ~167 (`if (codingLanguageSelect) settings.codingLanguage = ...`); (e) the change-listener block (lines ~318-325).
5. **preload.js**: delete line ~148 `onCodingLanguageChanged: (callback) => ipcRenderer.on('coding-language-changed', callback),`. This is an outbound-listener bridge only — NO ipcMain registration is touched, so the CHANNEL_AUDIENCES table in src/core/ipc-scope.js needs NO change (the reflection test staying green proves it).

Intermediate state is safe: main.js still broadcasts `coding-language-changed` and returns `codingLanguage` from getSettings until Task 2, but nothing sends or listens anymore.

Commit (explicit pathspec — repo rule): `git add index.html src/ui/main-window.js settings.html src/ui/settings-window.js preload.js && git commit -m "feat(quick): remove coding-language UI from overlay + settings" -- index.html src/ui/main-window.js settings.html src/ui/settings-window.js preload.js`
  </action>
  <verify>
    <automated>make run_tests && make lint && ! rg -n "codingLanguage|coding-language|onCodingLanguageChanged|languageSelect" index.html settings.html preload.js preload-overlay.js src/ui/</automated>
  </verify>
  <done>No language selector markup, CSS, listeners, or preload bridge remain in any renderer surface; 193/193 tests (incl. ipc-scope reflection) + lint green.</done>
</task>

<task type="auto">
  <name>Task 2: Remove language plumbing through main.js → LocalProvider → RequestBuilder; reword transcription prompt</name>
  <files>main.js, src/services/providers/local.provider.js, src/core/request-builder.js, test/request-builder.test.js</files>
  <action>
Remove the `programmingLanguage` parameter through the call chain (decided: remove, not keep-dead — we touch every file anyway and dead params would leave live-looking machinery). ARITY HAZARD: the param precedes `onDelta` (provider) and `mdContext` (builder) — both sides of every call MUST change in this one task.

1. **main.js**:
   - Delete `this.codingLanguage = "cpp"` (line ~104) + its comment.
   - Delete the three `skillsRequiringProgrammingLanguage`/`needsProgrammingLanguage` const pairs (~:1677-1678, ~:1743-1744, ~:1911-1912) and drop the `needsProgrammingLanguage ? this.codingLanguage : null` argument from the three `llmService.process*Stream(...)` calls (~:1692, ~:1758, ~:1931) — `onDelta` becomes the 5th arg for image / 4th for text+transcription, matching the new provider signatures in step 2.
   - Delete the two `programmingLanguage: needsProgrammingLanguage ? ... : 'not applicable'` logger fields (~:1771, ~:1965).
   - getSettings(): delete the `codingLanguage: this.codingLanguage || "cpp",` field (~:2198).
   - saveSettings(): delete the whole `if (settings.codingLanguage) { ... broadcastToAllWindows("coding-language-changed", ...) }` block (~:2231-2236). Graceful-stale-input guarantee (locked decision 3): saveSettings only acts on keys it explicitly checks and is try/catch-wrapped, so an old renderer or stale caller sending `codingLanguage` now falls through silently — no error path exists.
2. **src/services/providers/local.provider.js**:
   - `processImageWithSkillStream` / `processTextWithSkillStream` / `processTranscriptionWithIntelligentResponseStream`: drop the `programmingLanguage = null` param (onDelta shifts left); drop it from the `this.requestBuilder.build*Request(...)` calls (mdContext / `contextManager.getContext()` shifts left, matching step 3); change `this.generateStream(neutral, { programmingLanguage }, onDelta)` to `this.generateStream(neutral, {}, onDelta)`; delete the `programmingLanguage,` field from each metadata object (~:269, :297, :323).
   - `generate()` / `generateStream()`: delete the `const lang = options.programmingLanguage || null;` + `return lang ? this.enforceProgrammingLanguage(...) : ...` logic (~:150-151, ~:185-186) — return the text directly. Update the generate() doc comment (drop "language-normalized when options.programmingLanguage is set").
   - Delete the entire `enforceProgrammingLanguage` method (~:221-243) + its doc comment. Grep-confirm no remaining callers.
3. **src/core/request-builder.js**:
   - `formatImageInstruction(activeSkill)`: drop the param and the `langNote` logic — return the instruction with no language suffix (the programming.md system prompt now governs language via Task 3's clause).
   - `getIntelligentTranscriptionPrompt(activeSkill)`: drop the param; delete the entire `if (programmingLanguage) { ... CODING CONTEXT ... }` block (~:38-46 incl. languageMap/fenceTagMap). Reword line ~69 from "produce a complete, runnable solution in the selected programming language without asking for more details" to "produce a complete, runnable solution — default to Python unless the question, on-screen code, or spoken context clearly indicates another language — without asking for more details" (this hardcoded prompt does NOT load programming.md, so the smart clause must live here for the spoken path; locked decision 2).
   - `buildTextRequest(text, activeSkill, sessionMemory = [], mdContext = '')`: drop the 4th param; call `sessionManager.getSkillContext(activeSkill)` (session.manager's optional 2nd param defaults null until Task 3 removes it — safe); fallback branch calls `this.promptLoader.getRequestComponents(activeSkill, text, sessionMemory)` (3 args).
   - `buildImageRequest(imageBufferOrBase64, mimeType, activeSkill, mdContext = '')`: drop the param; call `this.promptLoader.getSkillPrompt(activeSkill)`; `formatImageInstruction(activeSkill)`.
   - `buildTranscriptionRequest(text, activeSkill, _sessionMemory = [], mdContext = '')`: drop the param; `getIntelligentTranscriptionPrompt(activeSkill)`.
   - Update the file-header comment if it mentions language injection.
4. **test/request-builder.test.js** (keep fakes honest with the new contract):
   - `makeSession`: default skillContext becomes `{ skillPrompt: 'SYS' }`; `getSkillContext(skill)` records `{ skill }` (drop `lang`).
   - `makePromptLoader`: remove the `requiresProgrammingLanguage` fake.
   - Fix the shifted positional mdContext calls: `rb.buildTextRequest('t', 'dsa', [], null, 'MD-NOTES')` becomes `('t', 'dsa', [], 'MD-NOTES')`; `rb.buildImageRequest(buf, 'image/png', 'dsa', null, 'MD')` becomes `(buf, 'image/png', 'dsa', 'MD')`; `rb.buildTranscriptionRequest('q', 'dsa', [], null, 'MD')` becomes `('q', 'dsa', [], 'MD')`.
   - In the first buildTranscriptionRequest test, add two pins: `assert.ok(!r.systemPrompt.includes('CODING CONTEXT'))` and `assert.ok(r.systemPrompt.includes('default to Python'))`.

Commit: `git add main.js src/services/providers/local.provider.js src/core/request-builder.js test/request-builder.test.js && git commit -m "feat(quick): remove programmingLanguage plumbing through main/provider/builder; default-Python transcription clause" -- main.js src/services/providers/local.provider.js src/core/request-builder.js test/request-builder.test.js`
  </action>
  <verify>
    <automated>make run_tests && make lint && ! rg -n "codingLanguage|coding-language|needsProgrammingLanguage|enforceProgrammingLanguage" main.js src/services/ src/core/request-builder.js && node -e "const {RequestBuilder}=require('./src/core/request-builder');const rb=new RequestBuilder({sessionManager:{},promptLoader:{getRequestComponents:()=>({shouldUseModelMemory:false})}});const p=rb.getIntelligentTranscriptionPrompt('programming');if(!p.includes('default to Python')||p.includes('CODING CONTEXT'))process.exit(1);console.log('transcription clause OK')"</automated>
  </verify>
  <done>No codingLanguage/needsProgrammingLanguage in main.js; provider + builder signatures language-free with arities consistent end-to-end; transcription prompt carries the default-Python smart phrasing; stale saveSettings({codingLanguage}) provably falls through (no key check remains); tests + lint green.</done>
</task>

<task type="auto">
  <name>Task 3: Retire injection machinery; add the static Language Policy clause to programming.md</name>
  <files>src/core/skill-normalizer.js, prompt-loader.js, src/managers/session.manager.js, prompts/programming.md, test/skill-normalizer.test.js</files>
  <action>
Delete the now-unreachable injection machinery (Task 2 removed every producer/caller of a language) and put the static smart clause where every programming-skill prompt path picks it up (locked decision 2).

1. **prompts/programming.md**: insert a `## Language Policy` section between the intro paragraph (line 3) and `## Response Structure`:

   ```markdown
   ## Language Policy
   - Default to **Python** for all code.
   - If the question, on-screen code, or spoken context clearly indicates another language (e.g., a C++/Java template in the problem, or the user asks for a specific language), answer in that language instead.
   - Tag every code fence with the language actually used (```python, ```cpp, ...). Never mix languages in one answer.
   ```

   Because loadPrompts() reads this file, the clause automatically rides into BOTH remaining prompt paths: the image path (`getSkillPrompt` → systemPrompt) and the text path (session-memory `skill_prompt_initialization` content). Leave the illustrative ```language placeholder fence in "### 4. Production Code" as-is.
2. **src/core/skill-normalizer.js**: delete `injectProgrammingLanguage` (whole function ~:54-82) and `SKILLS_REQUIRING_PROGRAMMING_LANGUAGE` (~:6-8); exports become `module.exports = { normalizeSkillName };`. Update the header comment (drop "programming-language injection"). Keep the `skillMap` (incl. the `'coding': 'programming'` and legacy dsa aliases) untouched.
3. **prompt-loader.js**: constructor — delete `this.skillsRequiringProgrammingLanguage = [...]` (~:14) + comment. `getSkillPrompt(skillName)` — drop the 2nd param + the injection branch (~:70-72) + related JSDoc. Delete methods `injectProgrammingLanguage` (~:84-86), `requiresProgrammingLanguage` (~:183-186), `getSkillsRequiringProgrammingLanguage` (~:192-194). `getRequestComponents(skillName, userMessage, storedMemory)` — drop the 4th param; call `this.getSkillPrompt(normalizedSkillName)`; delete the `programmingLanguage` and `requiresProgrammingLanguage` fields from the returned object. `updateStoredMemory(...)` — drop the trailing `programmingLanguage` param + the `programmingLanguage: ...` field in memoryEntry. getSessionStats — delete the `skillsRequiringProgrammingLanguage` field.
4. **src/managers/session.manager.js** `getSkillContext(skillName = null)` (~:236-265): drop the 2nd param; keep ONLY the session-memory fallback branch (the `skill_prompt_initialization` lookup — this is the branch that already executes with language null, so runtime behavior is unchanged); delete the `if (programmingLanguage && promptLoader.requiresProgrammingLanguage(...))` branch; delete `programmingLanguage` and `requiresProgrammingLanguage: promptLoader.requiresProgrammingLanguage(targetSkill)` from the returned object; update the JSDoc. Before touching the `promptLoader` require, grep the file for other `promptLoader.` usages — it is used elsewhere for skill prompt initialization; keep the import if any usage remains.
5. **test/skill-normalizer.test.js**: delete the `describe('injectProgrammingLanguage', ...)` and `describe('SKILLS_REQUIRING_PROGRAMMING_LANGUAGE', ...)` blocks + those two names from the require destructuring. Keep all `normalizeSkillName` tests.
6. Sweep for stragglers before committing: `rg -n "programmingLanguage|injectProgrammingLanguage|SKILLS_REQUIRING|requiresProgrammingLanguage" main.js preload.js prompt-loader.js src/ test/` must return nothing. `.planning/` and `webapp/` are historical/marketing docs — out of scope, leave them.

Commit: `git add src/core/skill-normalizer.js prompt-loader.js src/managers/session.manager.js prompts/programming.md test/skill-normalizer.test.js && git commit -m "feat(quick): retire language-injection machinery; static default-Python Language Policy in programming.md" -- src/core/skill-normalizer.js prompt-loader.js src/managers/session.manager.js prompts/programming.md test/skill-normalizer.test.js`
  </action>
  <verify>
    <automated>make run_tests && make lint && ! rg -n "programmingLanguage|injectProgrammingLanguage|SKILLS_REQUIRING_PROGRAMMING_LANGUAGE|requiresProgrammingLanguage|codingLanguage|coding-language" main.js preload.js preload-overlay.js prompt-loader.js index.html settings.html src/ test/ && node -e "const {promptLoader}=require('./prompt-loader');const p=promptLoader.getSkillPrompt('programming');if(!p.includes('Language Policy')||!p.includes('Default to **Python**'))process.exit(1);console.log('programming.md clause loads OK')"</automated>
  </verify>
  <done>skill-normalizer exports only normalizeSkillName; prompt-loader/session-manager are language-free; programming.md carries the Language Policy clause and it loads through getSkillPrompt; repo-wide absence grep clean (runtime files); full suite + lint green.</done>
</task>

</tasks>

<verification>
Final state, all three tasks landed:

1. `make run_tests` — all tests pass (count may drop slightly from 193 after removing the injection describes; zero failures). The ipc-scope reflection test passing proves no channel/table drift.
2. `make lint` — exit 0 (watch for `no-unused-vars` on anything orphaned by the deletions).
3. Absence sweep (runtime files only; `.planning/` + `webapp/` exempt):
   `! rg -n "codingLanguage|coding-language|programmingLanguage|needsProgrammingLanguage|injectProgrammingLanguage|SKILLS_REQUIRING_PROGRAMMING_LANGUAGE|requiresProgrammingLanguage|enforceProgrammingLanguage|onCodingLanguageChanged" main.js preload.js preload-overlay.js prompt-loader.js index.html settings.html src/ test/`
4. Prompt behavior: `getSkillPrompt('programming')` includes the Language Policy (default Python + context-override); `getIntelligentTranscriptionPrompt('programming')` includes "default to Python" and no CODING CONTEXT block.
5. Three atomic commits with explicit pathspecs (parallel-executor sweep guard, MEMORY.md rule). Local only — never push (repo delivery policy).
</verification>

<success_criteria>
- No coding-language UI anywhere: overlay command tab has no selector (markup + CSS gone), settings has no dropdown, no cycler notification path remains.
- The programming skill prompt statically defaults to Python with a context-override clause, on all three answer paths (typed text via session-memory prompt, screenshot via getSkillPrompt, spoken via the transcription prompt's own phrasing).
- `codingLanguage`/`programmingLanguage` plumbing fully removed from main.js, preload, provider, builder, prompt-loader, skill-normalizer, session-manager; stale `saveSettings({codingLanguage})` input is ignored without error (no key check remains, body try/catch-wrapped).
- Zero ipcMain registrations added/removed — CHANNEL_AUDIENCES table untouched, reflection test green.
- `make run_tests` + `make lint` green after every task (each task independently consistent).
</success_criteria>

<output>
After completion, create `.planning/quick/260716-wyo-remove-coding-language-ui-everywhere-pro/260716-wyo-SUMMARY.md`
</output>
