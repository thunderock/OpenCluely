---
created: 2026-07-17T01:34:42.019Z
title: Mirror Claude MCP servers into opencode config
area: tooling
files:
  - ~/.claude.json (mcpServers blocks)
  - ashutosh_setup/setup.bash (existing Claude+Codex MCP mirroring)
---

## Problem

All MCP servers (filesystem, git, github, playwright, sequentialthinking, huggingface, Adobe internal via `adobe-mcp-add`) are registered for Claude Code (and mirrored into Codex by `setup.bash`), but opencode has none of them. Want the same MCP set available when using opencode.

## Solution

TBD — likely: read server definitions from Claude's config (`~/.claude.json` / `claude mcp list`) and translate them into opencode's config format (`~/.config/opencode/opencode.json`, `mcp` key — local servers use `command` arrays, remote ones `url`). Ideally extend `setup.bash` so opencode is mirrored alongside Claude and Codex rather than a one-off manual copy. Watch for auth differences (OAuth-based Adobe MCPs may need re-auth per client).

## Resolution (2026-07-17)

DONE — scope grew to "union across all three clients" per follow-up request.

- Union = filesystem, git, sequentialthinking, playwright, github, huggingface, ada, repo-context (+ conditional postgres). Only diff found: `repo-context` was Codex-only (and pointed at stale `~/slurm_scripts`).
- Claude: added `repo-context` at user scope (correct `~/personal/slurm_scripts` path). Codex: fixed the stale path. opencode: added all 8 under `mcp` in `~/.config/opencode/opencode.json` — secrets as `{env:VAR}`, never embedded.
- setup.bash (ashutosh_setup): new opencode mirroring section — jq-merge under `.mcp`, idempotent per name, never clobbers existing entries; mirrors the Claude/Codex conditionals (HF_TOKEN / GITHUB_PERSONAL_ACCESS_TOKEN / GLIMMER_DB).
- Verified: `opencode mcp list` 7/8 connected; `claude mcp list` 7/8; `codex mcp list` parses all. `ada` fails to connect in Claude AND opencode alike (needs OAuth / VPN — pre-existing, not a mirroring defect).
- Note: setup.bash still writes `~/slurm_scripts` paths (its clone location); live configs on this machine use `~/personal/slurm_scripts`. Re-running setup on this machine will no-op (idempotency guard), so no clobber.
