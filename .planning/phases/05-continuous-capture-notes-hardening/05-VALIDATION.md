---
phase: 5
slug: continuous-capture-notes-hardening
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-07-16
---

# Phase 5 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | node:test (Node built-in; repo standard) |
| **Config file** | none — `Makefile` targets wrap the commands |
| **Quick run command** | `node --test test/<file>.test.js` |
| **Full suite command** | `make run_tests` (= `node --test test/*.test.js`) + `make lint` (= `npx eslint .`) |
| **Estimated runtime** | ~20-30 seconds full suite |

Pre-phase baseline: 145/145 tests green, lint 0.

---

## Sampling Rate

- **After every task commit:** Run the targeted quick command for the module touched (e.g. `node --test test/frame-dedup.test.js`)
- **After every plan wave:** Run `make run_tests && make lint`
- **After main.js/window.manager.js-touching plans:** headless boot check (Phase 3/4 pattern) — zero uncaught exceptions
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| (filled by planner) | — | — | CONT-04 | unit | `node --test test/frame-dedup.test.js` | ❌ W0 (created with module) | ⬜ pending |
| (filled by planner) | — | — | CONT-05 | unit | `node --test test/context-manager.test.js` | ❌ W0 (created with module) | ⬜ pending |
| (filled by planner) | — | — | SEC-01 | unit | `node --test test/sanitize-policy.test.js` | ❌ W0 (created with module) | ⬜ pending |
| (filled by planner) | — | — | SEC-03 | unit | `node --test test/ipc-scope.test.js` | ❌ W0 (created with module) | ⬜ pending |
| (filled by planner) | — | — | SEC-02 | unit (pure cross-check logic) + manual | `node --test test/tcc-monitor.test.js` | ❌ W0 (created with module) | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

New tests follow the repo pattern: TDD alongside the pure `src/core/*` module in the same plan (no separate Wave 0 plan needed — the repo convention is test-with-module, matching Phases 1–4).

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements (node:test + Makefile + eslint already in place). No framework install needed. Test files are created in the same task as their pure module (repo TDD convention), so no standalone Wave 0 scaffold plan is required.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Hostile-markdown answer renders inert | SEC-01 | Real DOMPurify in a real renderer | Ask a question whose answer echoes `<img src=x onerror=alert(1)>` + a `javascript:` link; overlay + chat show inert text, no dialog, no nav |
| TCC loss → banner → deep-link → relaunch | SEC-02 | System Settings interaction | Revoke Screen Recording in System Settings; observe banner; click "Open System Settings" (correct pane) + "Relaunch app"; re-grant; capture recovers |
| Idle-screen dedup skips encode | CONT-04 | Live visual behavior | Leave screen idle 30s → logs show skipped ticks; move a window → `latestFrame` refreshes; screenshot hotkey still works |
| Notes end-to-end | CONT-05 | Restart flow | Pick folder in settings; restart; settings show "N of M files loaded"; ask a question answered only by notes content |
| Overlay denied privileged IPC | SEC-03 | Live probe | From llm-response devtools: `electronAPI.getSettings` undefined; forged invoke → `{ok:false,error:'denied'}` + warn log |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or same-task test creation
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
