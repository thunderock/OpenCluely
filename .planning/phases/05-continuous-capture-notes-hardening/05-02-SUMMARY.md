---
phase: 05-continuous-capture-notes-hardening
plan: 02
subsystem: security
tags: [sec-01, xss, dompurify, sanitize, renderer, innerHTML]

# Dependency graph
requires:
  - phase: 03-local-model-provider
    provides: "llm-response.html / chat.html model-output render paths (marked@15 + bundled lib/markdown.js fallback) that this plan hardens"
provides:
  - "src/core/sanitize-policy.js — THE single locked DOMPurify config + pure applyAnchorPolicy hook (dual-load: CJS + window.SanitizePolicy)"
  - "src/ui/sanitize.js — window.sanitizeHtml(html) fail-closed browser glue"
  - "Every dynamic/model-content innerHTML sink in llm-response.html, chat.html, chat-window.js, main-window.js routed through sanitizeHtml"
  - "Delegated openExternal link-click routing in llm-response.html + chat.html"
affects:
  - "05-05 (IPC scoping): overlay preload must keep openExternal — sanitized-link clicks now call it from llmResponse + chat windows"
  - "05-06 (attended gate): hostile-markdown XSS verification (<img onerror>, javascript: link) runs against this plan's sinks"
  - "Phase 8 (dead-code deletion): chat-window.js sinks are patched defensively; safe to delete the file whenever"

# Tech tracking
tech-stack:
  added: ["dompurify@3.4.12 (--ignore-scripts; CJS main + UMD browser build)"]
  patterns:
    - "Dual-load module (typeof module / typeof window guards) for CJS-tests + script-tag renderers — lib/markdown.js precedent"
    - "Fail-closed sanitize glue: missing DOMPurify/policy ⇒ return '' + console.warn, never raw render"
    - "Sanitize FINAL composed string → assign innerHTML → THEN Prism/renderMath on live DOM"
    - "createElement interactive elements AFTER sanitized shell assignment (FORBID_TAGS includes button)"

key-files:
  created:
    - src/core/sanitize-policy.js
    - src/ui/sanitize.js
    - test/sanitize-policy.test.js
  modified:
    - package.json
    - package-lock.json
    - eslint.config.js
    - llm-response.html
    - chat.html
    - index.html
    - src/ui/chat-window.js
    - src/ui/main-window.js

key-decisions:
  - "Recovery panel (main-window.js:703): took the plan's createElement route — sanitized button-free shell + document.createElement'd buttons appended post-assignment; shell inline styles moved into the lu-* class stylesheet because FORBID_ATTR strips style="
  - "eslint dual-load fix: scoped Block 1b (browser globals for src/core/sanitize-policy.js only) — plan-sanctioned targeted fix, no repo-wide rule weakening"
  - "chat-window.js (dead code): defensive (window.sanitizeHtml ? sanitize : raw) form so the file can't crash in whatever context might load it"

# Metrics
duration: 12 min
completed: 2026-07-17
---

# Phase 5 Plan 02: DOMPurify at Every Model-Output Sink Summary

**One-liner:** dompurify@3.4.12 wired through ONE locked policy module (http(s)-only anchors w/ rel forced, img/button/style dead, svg/mathml namespaces killed) into every dynamic innerHTML sink across both markdown paths, with sanitized-link clicks routed through the validated open-external IPC.

## What Was Built

### 1. Central sanitize policy (`src/core/sanitize-policy.js`)
The single greppable policy (SEC-01 locked decisions):
- `SANITIZE_CONFIG`: `USE_PROFILES {html:true}` (svg/mathml namespace tricks dead), `FORBID_TAGS` [img, picture, source, video, audio, iframe, object, embed, form, input, button, style], `FORBID_ATTR` [style], `ALLOWED_URI_REGEXP /^https?:/i` (javascript:/data:/file: die).
- `applyAnchorPolicy(node)`: pure afterSanitizeAttributes hook — forces `rel="noopener noreferrer"` + `target="_blank"` on every `<a>`, strips any non-http(s) href; non-anchors untouched; null-safe.
- Dual-load tail: `module.exports` (CJS tests) + `window.SanitizePolicy` (script tag) — lib/markdown.js expose precedent.

### 2. Browser glue (`src/ui/sanitize.js`)
`window.sanitizeHtml(html)` binds UMD DOMPurify + the policy, registers the anchor hook once, and is **fail-closed**: missing DOMPurify/policy ⇒ `console.warn` + `return ''` — hostile markup never renders raw.

### 3. All dynamic sinks patched (sanitize parsed HTML, never markdown source)
| File | Sink | Content |
|---|---|---|
| llm-response.html:840 | `text-content` | model markdown (split layout) |
| llm-response.html:853 | code-block template | `block.language` + escaped code |
| llm-response.html:885 | `full-markdown` | full model markdown |
| chat.html:873 | assistant bubble | `formatMarkdown(text)` |
| chat.html:1105 | code snippet | `escapeHtml(code)` (composite — wrapped anyway) |
| chat-window.js:365, 487 | dead code | defensive `(window.sanitizeHtml ? … : …)` form |
| main-window.js:722 | recovery panel shell | status-derived strings |
| main-window.js:1270 | skill notification | `${arrow} ${displayName}` |
| main-window.js:1478 | menu item | `${iconClass}` + `${text}` |

Ordering preserved at every sink: sanitize → assign → `Prism.highlightAll()` / `renderMathInElement` on the live DOM (both already ran post-assignment; untouched).

**Recovery panel button survival:** the locked policy forbids `<button>`, so the 03-06 panel shell is now button-free sanitized HTML; the three buttons (dismiss ×, primary action, close) are `document.createElement('button')`'d and appended AFTER assignment — status-derived strings can never become interactive elements, and the panel keeps working. Shell inline styles moved to `lu-*` classes in `_ensureRecoveryStyles` (FORBID_ATTR strips `style=`), rendering identically.

### 4. Script-tag distribution (prismjs precedent — node_modules path, no vendoring)
Trio in strict order (`purify.js` UMD → `sanitize-policy.js` → `sanitize.js`) added to:
- llm-response.html `<head>` (after lib/markdown.js + lib/mathrender.js)
- chat.html (existing script block at ~713, before the inline UI script)
- index.html (before `src/ui/main-window.js`)

### 5. Link-click routing
One delegated `click` listener each in llm-response.html + chat.html: `closest('a[href]')` → `preventDefault()` → http(s)-only regex → `electronAPI.openExternal(href)`. Verified the bridge exists (preload.js:46 → main.js:863 http(s)-validated handler). Window-level will-navigate/setWindowOpenHandler (window.manager.js) stays as belt-and-suspenders.

## Static-Sink Audit (reviewed, deliberately NOT wrapped)

| File | Line (post-edit) | Content | Why left |
|---|---|---|---|
| llm-response.html | 845 | `codeContainer.innerHTML = ''` | static clear |
| llm-response.html | 848 | `'<div class="no-code">No code examples found</div>'` | static literal |
| llm-response.html | 911 | `return div.innerHTML` | escape-READ (escapeHtml impl) |
| chat.html | 804 | `chatMessages.innerHTML = ''` | static clear |
| chat.html | 924 | thinking dots spans | static literal |
| chat.html | 1055 | `return div.innerHTML` | escape-read |
| src/ui/chat-window.js | 497 | `return div.innerHTML` | escape-read |
| src/ui/chat-window.js | 556 | thinking dots spans | static literal |
| src/ui/main-window.js | 740 | `dismissX.innerHTML = '&times;'` | static literal on createElement'd button |
| src/ui/main-window.js | 779, 808 | spinner + 'Restarting…'/'Downloading…' | static literals on createElement'd button |
| src/ui/settings-window.js | 186, 444 | `= ''` clears | static; file NOT touched per plan (settings.html gets no script tags) |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] eslint no-undef on the dual-load `window` guard**
- **Found during:** Task 1 verify
- **Issue:** `src/core/sanitize-policy.js` sits in eslint Block 1 (node globals) — the `window.SanitizePolicy = …` assignment inside the `typeof window` guard flagged `no-undef`
- **Fix:** added scoped Block 1b to eslint.config.js granting browser globals to exactly that file (the plan pre-authorized this: "include sanitize-policy.js in the appropriate files block — do NOT weaken rules repo-wide")
- **Files modified:** eslint.config.js
- **Commit:** 4b51212

**2. [Rule 2 - Missing critical] Recovery panel shell styling moved from inline `style=` attrs to classes**
- **Found during:** Task 2 (anticipated by the plan's IMPORTANT note)
- **Issue:** the locked `FORBID_ATTR: ['style']` strips every inline style from the sanitized panel shell — the panel would render unstyled
- **Fix:** all shell styling relocated to `lu-*` classes in the existing `_ensureRecoveryStyles` injected stylesheet; visual result identical
- **Files modified:** src/ui/main-window.js
- **Commit:** 055a266

No other deviations — plan executed as written.

## Verification Results

| Gate | Result |
|---|---|
| `node --test test/sanitize-policy.test.js` | 10/10 pass (≥7 required) |
| `require('dompurify')` under bare node | `function` (CJS confirmed, ESM ban respected) |
| `node_modules/dompurify/dist/purify.js` | present (UMD for script tags) |
| `make run_tests` | 163/163 pass |
| `make lint` (`npx eslint .`) | 0 errors |
| `dompurify/dist/purify.js` script tag | in all 3 HTML files, documented order |
| `sanitizeHtml(` counts | llm-response.html 3, chat.html 2, chat-window.js 2, main-window.js 3 (all ≥ required) |
| `openExternal` delegated handler | both llm-response.html + chat.html |
| `createElement('button'` near panel | 3 hits (dismiss/primary/close) |
| Remaining unsanitized `innerHTML =` | static literals + escape-reads only (table above) |

Attended XSS verification (hostile `<img onerror>` + `javascript:` link rendering inert in the real renderer) is deferred to the 05-06 gate by design — this plan's job was complete sink coverage + policy proof.

## Commits

| Task | Commit | Type | Description |
|---|---|---|---|
| 1 (RED) | 2d7c247 | test | failing tests for central sanitize policy |
| 1 (GREEN) | 4b51212 | feat | dompurify + central sanitize policy + glue |
| 2 | 055a266 | feat | sanitize all model-output innerHTML sinks |

## Known Stubs

None — no placeholder values, empty-data wirings, or TODO markers introduced. The `chat-window.js` defensive ternary is dead-code hardening (file slated for Phase 8 deletion), not a stub.

## Next Phase Readiness

- 05-05 (IPC scoping) must keep `openExternal` on the overlay/chat preload surface — both renderers now invoke it for sanitized-link clicks (already in the 05-05 plan's audited union).
- 05-06 attended gate: paste a hostile-markdown answer (`<img src=x onerror=alert(1)>`, `[x](javascript:alert(1))`) through overlay + chat; verify inert render, link opens externally, code blocks keep Prism highlighting, recovery panel buttons still work.

## Self-Check: PASSED

- Created files exist: src/core/sanitize-policy.js, src/ui/sanitize.js, test/sanitize-policy.test.js ✓
- Commits exist: 2d7c247, 4b51212, 055a266 ✓
- sanitize-policy tests: 10/10 pass ✓
