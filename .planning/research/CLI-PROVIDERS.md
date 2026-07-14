# CLI Providers — implementation-ready spec (Claude Code + Codex CLI as OpenCluely LLM backups)

Research basis: the local **forge** repo (`/Users/ashutosh/personal/forge`), which shells out to
`claude` / `codex` / `opencode` in production, plus the official Claude Code and Codex CLI docs
for the parts forge does not exercise (headless Codex, image input). All `file:line` citations
below are into the forge repo unless prefixed `OpenCluely:`.

---

## 1. Overview

Forge runs the CLIs **two different ways**, and only one of them is what OpenCluely wants:

| Mode | Where in forge | Mechanism | Prompt delivery | Used for |
|---|---|---|---|---|
| **Headless one-shot** (what OpenCluely needs) | `electron/ipc/ask-code.ts` | `child_process.spawn` | argv (`-p <prompt>`) | "Ask about code" Q&A. **Claude only.** |
| **Interactive TUI** (forge's main product) | `electron/ipc/pty.ts` (`spawnAgent`) | `node-pty` `pty.spawn` | typed into PTY (bracketed paste) | Full agent sessions in a git worktree per agent. |

Key takeaways for OpenCluely:

- **Forge's `ask-code.ts` is the proven headless template — copy it.** It runs `claude -p … --output-format text`, streams stdout chunks, and enforces a timeout. `ask-code.ts:57-78`.
- **Forge has NO headless Codex or Gemini path.** Codex/OpenCode only run as interactive TUIs; Gemini isn't even a default agent (`electron/ipc/agents.ts:21-49` — only `claude`, `codex`, `opencode`). The Codex headless spec below comes from official docs.
- **Forge is 100% text-only to the CLIs.** No screenshot/image is ever passed. Image support is researched from official docs (§4).
- **Auth is inherited, never injected.** Forge relies on the user's already-logged-in CLI session; it propagates the login-shell environment into the child (`electron/main.ts:49-80`) and clears a few nested-session guards. No API keys are set by forge.

---

## 2. Per-CLI invocation spec

### 2a. `claude` (Claude Code) — headless

**Forge's exact production command** (`electron/ipc/ask-code.ts:57-78`):

```js
spawn('claude', [
  '-p', prompt,                    // prompt via argv (positional after -p)
  '--output-format', 'text',       // text | json | stream-json
  '--model', 'sonnet',             // opus | sonnet | haiku | <full id>
  '--tools', '',                   // '' => DISABLE all tools (fast pure Q&A)
  '--no-session-persistence',      // don't write a session to disk
  '--append-system-prompt', 'Answer concisely about the selected code. Use markdown.',
], { cwd, env: filteredEnv, stdio: ['ignore', 'pipe', 'pipe'] });
```

Flag reference (verified against forge's model/arg builders and official docs):

| Concern | Flag | Notes / source |
|---|---|---|
| Headless | `-p` / `--print` | prompt as positional arg after `-p`, or piped via stdin (`echo p \| claude -p`). |
| Output | `--output-format text\|json\|stream-json` | `ask-code.ts:61-62`. `json` = one object w/ final text in `.result`; `stream-json` = line-delimited events (needs `--verbose`). |
| Model | `--model <alias\|id>` | `src/lib/agent-args.ts:49-51` (`opus\|sonnet\|haiku`). Model flags are **PREPENDED** so they sit ahead of subcommands (`src/lib/agent-args.ts:71-84`). |
| Reasoning | `--effort low\|medium\|high\|xhigh\|max` | `src/lib/agent-args.ts:51`; `max` is claude-only (`src/lib/agent-models.ts:14-19`). |
| System prompt | `--append-system-prompt <text>` (append) / `--system-prompt <text>` (replace) | `ask-code.ts:70-71`. |
| Tools | `--tools ''` / `--allowedTools "Read,Edit"` / `--disallowedTools "Bash(rm *)"` | `ask-code.ts:67` disables tools. **Enabling `Read` is required for image input (§4).** |
| Permissions | `--permission-mode <mode>` / `--dangerously-skip-permissions` | Skip flag: `agents.ts:28`. Modes incl. `acceptEdits`/`bypassPermissions` (`default` prompts). |
| Extra dirs | `--add-dir <path…>` | needed if the screenshot temp file lives outside `cwd` (§4). |
| Session | `--no-session-persistence` | `ask-code.ts:69`. |
| Resume | `--continue` | `agents.ts:27`. |
| MCP | `--mcp-config <path>` | `src/lib/agent-args.ts:68`. Not needed for OpenCluely. |
| cwd | via spawn `cwd` option | `ask-code.ts:74`. |

Docs: <https://code.claude.com/docs/en/headless.md>, <https://code.claude.com/docs/en/cli-reference.md>.

### 2b. `codex` (OpenAI Codex CLI) — headless (`codex exec`)

Forge only launches bare `codex` as a TUI (`agents.ts:32-39`); the headless subcommand below is from official docs (<https://learn.chatgpt.com/docs/developer-commands>, <https://learn.chatgpt.com/docs/non-interactive-mode>).

```bash
codex exec [FLAGS] "<PROMPT>"        # 'codex e' is the short form
echo "<PROMPT>" | codex exec -       # prompt via stdin using the '-' sentinel
```

| Concern | Flag | Notes |
|---|---|---|
| Headless subcommand | `codex exec` / `codex e` | prompt = positional arg, or stdin via `-`. |
| Output | plain: **progress→stderr, final answer→stdout only.** `--json` = JSONL event stream. | `--json` events: `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*`. |
| Final message to file | `-o` / `--output-last-message <path>` | cleanest way to grab the answer without parsing JSONL. |
| Model | `-m` / `--model <id>` | forge uses `gpt-5.5\|gpt-5.4\|gpt-5.4-mini` (`src/lib/agent-models.ts:15`). |
| Reasoning | `-c model_reasoning_effort=<low\|medium\|high\|xhigh>` | forge: `src/lib/agent-args.ts:53-54`. |
| Sandbox | `-s` / `--sandbox read-only\|workspace-write\|danger-full-access` | use `read-only` for pure Q&A. |
| Approvals | `-a` / `--ask-for-approval untrusted\|on-request\|never` | use `never` for non-interactive. |
| Bypass all | `--dangerously-bypass-approvals-and-sandbox` (alias `--yolo`) | forge's skip-perms value (`agents.ts:37`). Heavier than needed for read-only Q&A. |
| Working dir | `-C` / `--cd <path>` | |
| Non-repo | `--skip-git-repo-check` | required when cwd isn't a git repo. |
| Ephemeral | `--ephemeral` | don't persist session rollout files (recommended for one-shot). |
| Image | `-i` / `--image <path[,path]>` | repeatable or comma-separated; **works with `codex exec`** (§4). |
| Resume | `codex exec resume --last "<followup>"` | forge TUI equivalent: `resume --last` (`agents.ts:36`). |

### 2c. `gemini` (brief)

Not used headlessly by forge and not a default agent. Forge only recognizes Gemini's TUI input prompt for readiness detection (`electron/mcp/prompt-detect.ts:36` — `> Type your message`). If needed later, the Gemini CLI exposes `gemini -p "<prompt>"` for non-interactive output and reads image paths referenced in the prompt; treat it like the Claude file-path pattern. Out of scope for the initial Claude+Codex backup.

---

## 3. Auth model

**Both CLIs reuse the user's existing terminal login by default — no key injection required.** This is the whole point: OpenCluely inherits whatever the user already authed in their shell.

- **Forge injects nothing.** It builds the child env from `process.env` and only *removes* nested-session guards; it never sets `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` (`ask-code.ts:48-55`, `pty.ts:283-318`).
- **Env propagation (important for a packaged app):** launched from Finder/Dock, an Electron app inherits a minimal `PATH` and won't find `claude`/`codex`, nor their creds. Forge fixes this at startup by running the user's login+interactive shell (`$SHELL -ilc`), dumping its env, and merging it into `process.env` (`electron/main.ts:49-80`, `fixEnv`). **OpenCluely must do the same** (or use `fix-path`/`shell-env`) so the child inherits `PATH` + `HOME` + auth.
- **Claude auth precedence** (docs `authentication.md`): Bedrock/Vertex env → `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` → `apiKeyHelper` → `CLAUDE_CODE_OAUTH_TOKEN` → **subscription OAuth in `~/.claude/.credentials.json`** (from `claude login`). Just spawning `claude -p` with inherited env reuses the subscription automatically. ⚠️ **Do NOT pass `--bare`** if relying on subscription login — `--bare` skips OAuth/keychain and forces `ANTHROPIC_API_KEY`.
- **Codex auth** (docs): `codex exec` "reuses saved CLI authentication by default" (ChatGPT login under `~/.codex`). `CODEX_API_KEY` env is honored **only** in `codex exec` if you want an explicit key.
- **Clear these before spawning** (prevents "nested agent session" refusals) — forge does exactly this: `CLAUDECODE`, `CLAUDE_CODE_SESSION`, `CLAUDE_CODE_ENTRYPOINT` (`ask-code.ts:52-55`, `pty.ts:315-318`).

---

## 4. Image / file input — how to pass a screenshot

**Neither CLI accepts an in-memory image in headless mode; both read an image from a FILE PATH.** Since OpenCluely's capture service already returns an in-memory PNG `Buffer` (`OpenCluely:src/services/capture.service.js:30-65` → `{ imageBuffer, mimeType: 'image/png' }`), the provider must **write the buffer to a temp `.png` and pass its path**.

### Claude Code (`claude -p`) — file-path reference, NOT base64
- **Headless `-p` does NOT support base64 image content blocks.** Only the Agent **SDK** streaming input mode accepts `{"type":"image","source":{"type":"base64",…}}`; the CLI's single-message `-p` mode explicitly does not (docs `agent-sdk/streaming-vs-single-mode.md`). There is **no `--image` flag** and no `--input-format stream-json` image path in headless CLI.
- **Supported approach:** reference the file path in the prompt and let Claude read it with the **Read tool** (Read handles images). Requires:
  1. Tools enabled — i.e. **do NOT use forge's `--tools ''`**; use `--allowedTools Read`.
  2. A non-prompting permission mode so the read isn't blocked — `--permission-mode acceptEdits` (or `bypassPermissions`), or `--dangerously-skip-permissions` for the simplest guaranteed non-interactive run.
  3. The temp file inside `cwd`, or add it with `--add-dir <tmpdir>`.

```bash
claude -p "Screenshot at /tmp/oc-<id>.png. <user question>" \
  --allowedTools Read \
  --permission-mode acceptEdits \
  --add-dir /tmp \
  --model sonnet \
  --output-format json      # parse .result for the answer
```

### Codex (`codex exec`) — native `-i/--image`
Simpler: Codex is natively multimodal in exec mode.

```bash
codex exec -i /tmp/oc-<id>.png -s read-only -a never --skip-git-repo-check \
  "<user question about the screenshot>"
```
Supported formats PNG/JPEG/GIF/WebP; keep <~5 MB. (One official page omits `-i` for exec, but the command reference + multiple sources confirm it — verify on the installed Codex version.)

### Recommendation
Write the PNG buffer to `os.tmpdir()/oc-<uuid>.png`, pass the absolute path to both CLIs, and delete it in a `finally`. This is one uniform "materialize buffer → temp file → pass path → cleanup" step shared by both providers. Prefer it over base64/stream-json (unsupported for Claude CLI, more brittle).

---

## 5. Output parsing

### Claude
- **`--output-format text`** (forge's choice, `ask-code.ts:61-62`): stdout is the raw answer — stream chunks straight through. Simplest.
- **`--output-format json`**: single JSON object; final answer in `.result`. Best for one-shot "collect then return."
- **`--output-format stream-json --verbose`**: line-delimited events for token streaming:
  - init: `{"type":"system","subtype":"…init…","session_id":…,"model":…}`
  - deltas: `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"…"}}}` → feed each `.text` to `onDelta`.
  - done: `{"type":"result","subtype":"success","result":"<final text>","total_cost_usd":…}`.
  - error: `{"type":"result","subtype":"error","error_type":"authentication_failed|rate_limit|…"}`.

### Codex
- **Plain `codex exec`:** progress→**stderr**, final answer→**stdout** only. Collect stdout = the answer (or use `-o <file>`). Easiest and reliable.
- **`--json`:** parse JSONL; final text arrives in the assistant `item.*` / `turn.completed` events. More work; only if you want event-level UI.

### Forge's streaming contract (mirror it)
Forge streams to the renderer as `{ type: 'chunk' | 'error' | 'done' }` messages (`src/components/AskCodeCard.tsx:20-48`): `chunk` appends stdout text, `error` carries stderr / spawn error, `done` carries the exit code. In the main process: stdout→`chunk` (`ask-code.ts:99-101`), stderr→`error` (`:103-105`), `close`→`done` w/ exit code (`:107-113`), spawn `error`→error+done (`:115-122`).

### Error / auth-failure / non-zero-exit detection
- Non-zero `close` code ⇒ failure; surface stderr text. Forge treats any `close` as terminal and forwards `exitCode` (`ask-code.ts:107-113`).
- Spawn failure (binary missing) fires `proc.on('error')` (`:115-122`); forge pre-checks with `validateCommand('claude')` (`ask-code.ts:46`; `pty.ts:144-168`, uses `which`).
- Auth failures print to **stderr** (text mode) or appear as `subtype:"error"` / `error_type:"authentication_failed"` (Claude stream-json) / `turn.failed` (Codex `--json`). For OpenCluely, detect an empty stdout + non-zero exit and inspect stderr for `login`/`auth`/`credit`/`rate limit` to distinguish "not logged in" from "rate limited," then fall back to the primary Gemini provider.

---

## 6. Process lifecycle

Forge's headless lifecycle (`electron/ipc/ask-code.ts`) — the template:

- **Spawn:** `child_process.spawn('claude', args, { cwd, env, stdio:['ignore','pipe','pipe'] })` (`:57-78`). `stdin` ignored (prompt is in argv).
- **Guards:** `MAX_PROMPT_LENGTH = 50_000`, `MAX_CONCURRENT = 5`, tracked in an `activeRequests` map keyed by requestId (`:20-24, 36-44, 80`).
- **Timeout:** `TIMEOUT_MS = 120_000` → on fire, mark finished, emit error+done, `SIGTERM` (`:22, 124-136`). Set `finished` *before* killing to dodge the close/timeout race (`:88, 124-127`).
- **Cancel:** `proc.kill('SIGTERM')` + clear timers (`:139-155`).
- **Completion:** `proc.on('close', code)` (`:107-113`); the `finished` flag guarantees a single `done`.
- **No restart-on-failure** in the headless path — it's one-shot; a failure just returns and OpenCluely falls back.

Interactive-mode lifecycle (context, not needed for OpenCluely): `node-pty` `pty.spawn(cmd,args,{name,cols,rows,cwd,env})` (`pty.ts:450-456`); output batched to base64 (`:512-544`); session map per `agentId` supports reattach on renderer reload (`:244-259`) and kill-on-respawn (`:275-281`); exit handled at `:546+`.

### Git-worktree-per-agent isolation (interactive mode)
Each interactive agent gets its own worktree so parallel agents never collide: `createWorktree` runs `git worktree add -b <branch> <repoRoot>/.worktrees/<branch> [baseBranch]` (`electron/ipc/git.ts:693-754`) and the agent spawns with `cwd` = that worktree. Optional Docker mode adds filesystem isolation (`pty.ts:334+`). **OpenCluely does NOT need this** — a headless read-only Q&A about a screenshot has no repo side effects; just run in a stable `cwd` (or a scratch dir) with a read-only/no-tools posture.

---

## 7. Gotchas

- **Claude `--tools ''` kills image reading.** Forge disables tools for speed, but image input *requires* `--allowedTools Read`. Pick per query: text-only Q&A → `--tools ''`; screenshot Q&A → `--allowedTools Read` + non-prompting permission mode.
- **`--bare` (Claude) breaks subscription auth** — it forces `ANTHROPIC_API_KEY`. Omit it when reusing `claude login`.
- **Model flags must be prepended** ahead of any subcommand (forge does this so they stay valid before codex `resume`) — `src/lib/agent-args.ts:36-60, 71-84`.
- **Flag divergence between CLIs** (build per-CLI, never share): skip-perms — claude `--dangerously-skip-permissions` vs codex `--dangerously-bypass-approvals-and-sandbox` (`agents.ts:28,37`); model — claude `--model` vs codex `-m`; reasoning — claude `--effort` vs codex `-c model_reasoning_effort=`; resume — claude `--continue` vs codex `resume --last`.
- **Nested-session env vars** (`CLAUDECODE`, `CLAUDE_CODE_SESSION`, `CLAUDE_CODE_ENTRYPOINT`) cause refusals if leaked — clear them (`ask-code.ts:52-55`).
- **PATH/auth invisibility when launched from GUI** — must resolve login-shell env at boot (`main.ts:49-80`).
- **Binary presence / version drift** — detect with `which <cmd>` before spawning (`agents.ts:51-58`, `pty.ts:144-168`); cache the result (forge TTL-caches, `agents.ts:60-85`). Flags shift across CLI versions (esp. Codex `-i` on exec, Claude permission-mode names) — probe once at startup and degrade gracefully.
- **Cold-start latency & rate limits** — first CLI call is slow (auth handshake, model spin-up); the 120 s timeout accommodates it. On rate-limit/credit errors, fall back to the primary provider rather than retrying tightly.
- **Codex plain-mode stdout is clean** (final answer only; progress on stderr) — don't merge stderr into the answer stream.
- **Prompt size** — forge caps at 50 k chars; a large base64 blob would blow argv limits anyway, another reason to use a temp file path, not inline data.

---

## 8. Recommended OpenCluely provider design

Add two adapters behind the existing LLM surface. OpenCluely's current `LLMService` (`OpenCluely:src/services/llm.service.js`) exposes the methods a provider must satisfy: `processImageWithSkill(imageBuffer, mimeType, activeSkill, sessionMemory, programmingLanguage)` (`:124`), its streaming twin `processImageWithSkillStream(…, onDelta)` (`:228`), and `processTextWithSkill` (`:305`) / `…Stream`. Keep Gemini primary; Claude/Codex are fallbacks selected when Gemini is unavailable or errors.

**Interface** (`LLMProvider`): `isAvailable()`, `processText(prompt, opts)`, `processImage(imageBuffer, mimeType, prompt, opts)`, each with an optional `onDelta` for streaming. `imageBuffer`+`mimeType` in, assistant text out — matching the current signatures so it drops in behind the same call sites.

**Shared spawn helper** (port `ask-code.ts` almost verbatim):
1. `resolveEnv()` once at boot — merge login-shell env into `process.env` like `main.ts:fixEnv` (or `fix-path`), so children find the binaries + creds.
2. Per call, build `childEnv = {…process.env}` minus `CLAUDECODE`, `CLAUDE_CODE_SESSION`, `CLAUDE_CODE_ENTRYPOINT`; do **not** set any `*_API_KEY`.
3. `validateCommand(cmd)` via `which`, cached; if missing → `isAvailable()=false`.
4. `spawn(cmd, args, { cwd, env: childEnv, stdio:['ignore','pipe','pipe'] })`; 120 s timeout → `SIGTERM`; `MAX_CONCURRENT` guard; single-`done` `finished` flag; `close` code + stderr = error classification (auth vs rate-limit vs other).
5. Stream stdout to `onDelta`; resolve the accumulated text on `close(0)`; reject on non-zero.

**Image handling (shared):** `writeTempImage(buffer) → os.tmpdir()/oc-<uuid>.png`, pass the path, `unlink` in `finally`.

**ClaudeProvider.processImage:**
```
claude -p "Screenshot at <tmpPath>. <prompt>"
  --allowedTools Read --permission-mode acceptEdits --add-dir <tmpdir>
  --model sonnet --output-format text          # or stream-json+--verbose for onDelta
  --no-session-persistence
  --append-system-prompt "<active skill prompt>"
```
- Text-only path: keep forge's `--tools ''` for speed.
- Parse: `text` → stream raw; `stream-json` → `stream_event.event.delta.text_delta` → `onDelta`, end on `result`.

**CodexProvider.processImage:**
```
codex exec -i <tmpPath> -s read-only -a never --skip-git-repo-check --ephemeral
  -m gpt-5.4 "<active skill prompt>\n\n<prompt>"
```
- Collect stdout (final answer only) or `-o <file>`; for pseudo-streaming, forward stdout chunks to `onDelta`.

**Fallback wiring:** a `ProviderChain` tries Gemini → Claude → Codex (config-ordered). A provider is "eligible" if `isAvailable()` and (for CLIs) not currently rate-limited. On an auth/rate error from one, log and advance to the next; surface a single user-facing error only if all fail. Cache `isAvailable()` (30 s TTL, like `agents.ts:63`) so the UI can show which backups are ready — mirror OpenCluely's existing "Gemini status" IPC (`OpenCluely:main.js:610`) with per-provider status.

---

## 9. forge macOS DMG release job (reference)

`.github/workflows/release.yml`, job `build-macos` (`:44-66`):

- **Runner:** `macos-latest` (`:46`).
- **Node:** `actions/setup-node@v4`, node 22, npm cache (`:50-53`); `npm ci` (`:55`).
- **Build+publish (unsigned):** `:61-66`
  ```yaml
  env:
    NODE_OPTIONS: '--max-old-space-size=4096'
    CSC_IDENTITY_AUTO_DISCOVERY: 'false'     # skip code-signing cert lookup
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  run: npm run build -- --universal -c.mac.notarize=false --publish always
  ```
- `--universal` = universal2 (x64 + arm64) binary; `-c.mac.notarize=false` disables notarization; `--publish always` uploads to the GitHub draft release. Underlying `npm run build` = vite builds + `tsc` + esbuild MCP bundle + `electron-builder` (root `package.json` `build` script; electron-builder config under `package.json > build`, appId `com.forge.app`).
- The comment at `:57-60` documents how to restore signing/notarization (re-add cert-import + notarization-key steps, set `APPLE_API_KEY*`, drop the two overrides). Note forge still ships macOS here — the "Windows+Linux only" decision in the recent git log belongs to **OpenCluely**, not forge.
