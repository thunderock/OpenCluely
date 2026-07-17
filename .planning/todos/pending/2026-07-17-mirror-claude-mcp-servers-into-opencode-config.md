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
