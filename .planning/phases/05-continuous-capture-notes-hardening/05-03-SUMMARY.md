---
phase: 05-continuous-capture-notes-hardening
plan: 03
subsystem: llm-context
tags: [cont-05, notes, md-context, context-manager, settings, ipc]

# Dependency graph
requires:
  - phase: 02-provider-abstraction
    provides: "RequestBuilder.mdContext param (last arg of every build*Request) — the pre-wired seam this plan fills"
  - phase: 03-local-model-provider
    provides: "LocalProvider.serialize() [systemPrompt, mdContext] system-prefix join (03-03) + the 12k prefill TTFT validation (03-07)"
provides:
  - "src/core/context.manager.js — ContextManager (load/getContext/getStatus) + pure selectFilesWithinBudget + contextManager singleton"
  - "config.notes { folder: NOTES_FOLDER, budgetChars: NOTES_BUDGET_CHARS || 12000 }"
  - "Every model call (text/image/transcription) carries the loaded notes via contextManager.getContext() at all 3 local.provider build* call sites"
  - "select-notes-folder IPC (native directory picker) + selectNotesFolder preload bridge"
  - "Settings Notes Context section: editable #notesFolder path + #notesBrowse picker + #notesStatus 'N of M files loaded' line"
affects:
  - "05-05 (IPC scoping): NEW channel select-notes-folder must join the channel→audience table (audience: settings; picker is invoked from the settings window)"
  - "05-06 (attended gate): end-to-end folder → restart → answer-reflects-notes verification runs against this plan"
  - "Phase 6 (pause orchestrator): every pause-triggered model call automatically carries the user's notes — no extra wiring needed"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Launch-only config semantics: constructor does NO fs/config reads; config values read at load() time; .env persistence via envUpdates → restart-to-apply (LOCAL_MODEL precedent)"
    - "Prefix-stable budget costing: per-file cost = separator (none for first) + header + content, so pure selectFilesWithinBudget over pre-sorted entries equals the assembled-string length exactly"
    - "Isolated non-blocking onAppReady start (try/catch + info-log status) — same idiom as LocalModelManager/WhisperServerManager starts"

key-files:
  created:
    - src/core/context.manager.js
    - test/context-manager.test.js
  modified:
    - src/core/config.js
    - src/services/providers/local.provider.js
    - main.js
    - preload.js
    - settings.html
    - src/ui/settings-window.js

key-decisions:
  - "Budget applies to the FINAL assembled string (headers + '\\n\\n---\\n\\n' separators included) — the exact string that hits the prompt; proven by a dedicated test (budget 20 loads 1 of 2 files whose raw content alone would fit)"
  - "Browse picker saves immediately after filling the editable field (plan snippet only set the value; a programmatic .value change fires no change/blur event, so the picked path would otherwise not persist without an extra manual blur)"
  - "12k budget NOT re-validated: 03-07's smoke already measured TTFT with ~12k chars of filler mdContext through the real prefill path — cited per plan, not re-run"

# Metrics
duration: 18 min
completed: 2026-07-17
---

# Phase 5 Plan 03: Notes Context Loader (CONT-05) Summary

**One-liner:** Launch-time loader reads a settings-configured folder of top-level `.md` files into ONE 12k-char-bounded string (whole files, alphabetical, stop-before-bust) and feeds it through the pre-wired `RequestBuilder.mdContext` seam so every text/image/transcription call carries the user's notes in the system prefix — with a native folder picker, editable path, and live "N of M files loaded" status in settings.

## What Was Built

### 1. `src/core/context.manager.js` (+ 8 node:test cases)
- **`selectFilesWithinBudget(files, budget)`** — PURE: iterates pre-sorted `[{name, chars}]`, accumulates, breaks at the FIRST file that would exceed the budget (whole files, stable order, no skip-and-continue).
- **`ContextManager`** — `constructor({folder, budgetChars})` DI overrides for tests; does NO fs and NO config reads (lazy-safe singleton). `load()` reads config at call time (launch-only semantics): `readdir(withFileTypes)` → keep `isFile() && endsWith('.md') && !startsWith('.')` (top-level only, no recursion), default codepoint `.sort()`, read utf8, cost each file as `(first ? 0 : separator) + header + content` — since selection is always a prefix, per-file cost is position-stable and the selected total equals the assembled string length exactly. Whole body try/caught → warn-log `{folder, error}`, empty context, never throws.
- **`getContext()`** — cached assembled string ('' before load / on failure); cheap per-request read.
- **`getStatus()`** — `{ folder, loadedCount, totalCount, chars, budget }` (the "N of M" source).
- Assembled shape: `# a.md\n\n<content>\n\n---\n\n# b.md\n\n<content>` — file-name headers give the model attribution.
- **`config.notes`**: `folder: NOTES_FOLDER || ''`, `budgetChars: NOTES_BUDGET_CHARS || 12000`.

Test coverage (tmpdir fixtures, no mocks): stop-before-bust selection, first-file bust → nothing, empty list, top-level/non-dot/.md-only filtering + alphabetical header order, unset folder degrade, nonexistent folder degrade, **assembled-string budgeting** (budget 20 loads 1 of 2 files whose raw content alone would fit both), config 12000 default at load() time.

### 2. Provider + startup + persistence wiring
- **`local.provider.js`**: one require + exactly 3 changed lines — `contextManager.getContext()` passed as the trailing `mdContext` arg at `buildImageRequest` / `buildTextRequest` / `buildTranscriptionRequest`. NO serialize/RequestBuilder changes: `serialize()` already joins `[systemPrompt, mdContext].filter(Boolean).join('\n\n')` (03-03 pre-wiring, position-stable prefix, `/no_think` appended after).
- **`main.js`**: `contextManager.load()` in onAppReady (isolated try/catch, before the local-model start so notes precede the first possible model call); `select-notes-folder` IPC → `dialog.showOpenDialog({properties:['openDirectory']})` (plain `ipcMain.handle` for now — 05-05 converts all handlers to the sender-scoped guarded form); `getSettings()` adds `notesFolder`/`notesBudgetChars`/`notesStatus`; `saveSettings()` persists `envUpdates.NOTES_FOLDER` (restart-to-apply, matching LOCAL_MODEL).
- **`preload.js`**: `selectNotesFolder: () => ipcRenderer.invoke('select-notes-folder')` in the settings group.

### 3. Settings UI
"Notes Context" section (mirrors AI Model section classes): editable `#notesFolder` text input, `#notesBrowse` native-picker button, `#notesStatus` muted line, and the hint "Loaded once at launch — restart the app to apply changes." Renderer populates from `getSettings().notesFolder`, renders `Loaded ${loadedCount} of ${totalCount} files (${chars} of ${budget} chars)` (or "No notes folder configured"), Browse → `selectNotesFolder()` → field + save, manual edits save on change/blur, `notesFolder: value.trim()` rides the existing save payload. All DOM lookups null-guarded (file's existing style).

## Pre-validated Budget (cited, not re-run)

The 12,000-char default is the size Phase 3 already validated: **03-07's smoke measured TTFT with ~12k chars of filler mdContext through the real prefill path** (documented in 05-RESEARCH.md and the 03-07 artifacts). Per the plan, this evidence is cited rather than re-measured; sustained-load validation belongs to Phase 6.

## For the 05-05 IPC Table

New channel this plan introduces: **`select-notes-folder`** — audience `settings` (invoked only by the settings window's Browse button; returns `{canceled}` or `{canceled:false, path}`; no URL/path is accepted FROM the renderer).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical] Browse picker now saves after filling the field**
- **Found during:** Task 3
- **Issue:** the plan's snippet only assigned `notesFolder.value = r.path` — a programmatic value assignment fires neither `change` nor `blur`, so the picked folder would silently not persist unless the user happened to focus+blur the field afterwards
- **Fix:** `saveSettings()` called right after the assignment (matches the file's existing change-handler idiom)
- **Files modified:** src/ui/settings-window.js
- **Commit:** e87316c

**2. [Rule 1 - Bug] Headless-boot verification initially blocked by a stale disguised process (environment, not code)**
- **Found during:** Task 2 verify
- **Issue:** boot log stopped at module load — a stale dev instance held the single-instance lock; it evaded `pkill -f` because the app renames its process to `"Terminal "` (stealth). The known MEMORY.md lesson, now with the extra wrinkle that pattern-kills can't find the disguised main process
- **Fix:** located via parent-PID of the orphan Electron Helpers, killed by PID, re-ran boot cleanly (no app-code change)
- **Files modified:** none

Minor hardening beyond plan snippets (not behavior changes): the `select-notes-folder` handler wraps the dialog in try/catch returning `{canceled:true, error}` (degrade-never-crash convention).

## Verification Results

| Gate | Result |
|---|---|
| `node --test test/context-manager.test.js` | 8/8 pass (≥7 required) |
| `make run_tests` | 171/171 pass (163 pre-plan + 8 new; frame-dedup + sanitize-policy + context-manager suites all present) |
| `make lint` (`npx eslint .`) | 0 errors |
| `rg -c "contextManager.getContext\(\)" local.provider.js` | 3 (all call sites) |
| main.js greps | `select-notes-folder` ✓, `contextManager.load()` ✓, `envUpdates.NOTES_FOLDER` ✓, `notesFolder`+`notesStatus` in getSettings ✓ |
| `preload.js` | `selectNotesFolder` ✓ |
| `fs.watch` | zero matches in src/ + main.js + preload.js (launch-only, locked) |
| Headless boot (empty folder) | "Notes context loaded" `{loadedCount: 0}`, zero uncaught |
| Headless boot (`NOTES_FOLDER=` 2-file fixture) | "Notes context assembled" `{loadedCount: 2, totalCount: 2, chars: 83, budget: 12000}`, zero uncaught |
| `test/local-provider.test.js` | still green (call sites only ADD a trailing arg) |

End-to-end attended check (pick folder in settings → restart → answer reflects notes) is deferred to the 05-06 gate by design.

## Commits

| Task | Commit | Type | Description |
|---|---|---|---|
| 1 (RED) | 8c58d75 | test | failing tests for notes context manager |
| 1 (GREEN) | febb3ca | feat | notes context manager with whole-file budget |
| 2 | 0f21483 | feat | wire notes context into provider + settings persistence |
| 3 | e87316c | feat | notes folder settings UI |

## Known Stubs

None — the empty-context default ('' when no folder is configured) is the specified degrade behavior, not a stub; the settings status line renders live launch-time load data.

## Next Phase Readiness

- **05-05 must add `select-notes-folder` to the channel→audience table** (audience: `settings`) and keep `get-settings`/`save-settings` on the settings surface — the notes UI rides them.
- 05-06 attended gate: create a notes folder with a distinctive fact, pick it in settings, restart, ask a question whose answer requires the fact; verify the status line reads "Loaded N of M files" and the answer reflects the note.
- Phase 6: pause-triggered calls automatically carry notes (all three build* call sites covered) — no additional wiring.

## Self-Check: PASSED

- Created files exist: src/core/context.manager.js, test/context-manager.test.js ✓
- Commits exist: 8c58d75, febb3ca, 0f21483, e87316c ✓
- context-manager tests: 8/8 pass; full suite 171/171; lint 0 ✓
