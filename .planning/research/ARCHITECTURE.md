# Architecture Research

**Domain:** Local-first, always-on multimodal AI desktop copilot (brownfield Electron)
**Researched:** 2026-07-13
**Confidence:** HIGH (existing seams read from source; external service surfaces verified against official docs)

> Scope note: This is a **subsequent-milestone / brownfield** architecture study. The existing app is already mapped in `.planning/codebase/ARCHITECTURE.md` + `STRUCTURE.md`. This document describes **how the new subsystems integrate into the existing Electron CommonJS-singleton app** — component boundaries, data-flow direction, and build-order dependencies — not a re-description of the current app. All code examples are CommonJS to match the repo's `module.exports = new ClassName()` convention (constraint: no TS/bundler/framework rewrite).

---

## Standard Architecture

The vision decomposes into **six new subsystems** that slot onto **existing seams**. The single most important structural fact: the app **already has a pause-triggered pipeline in embryo** — `handleTranscriptionFragment()` → 800 ms coalesce debounce → `dispatchCoalescedUtterance()` → `processTranscriptionWithLLM()` (`main.js:1181-1360`), and VAD-on-silence in `speech.service.js` already emits the "natural pause" signal (`_ingestWhisperAudio` → `_endUtteranceFlush`, `speech.service.js:800-902`). The new work **extends these seams**; it does not build a parallel loop.

The second most important fact: the new subsystems split cleanly into **two supervised long-running local servers** (model + STT) fronted by **dumb transport clients**, plus **three main-process managers** (supervisor, capture scheduler, md-context) feeding **one orchestrator** that reuses the coalesce seam.

### System Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    RENDERERS (vanilla JS, unchanged shell)                 │
│   index.html (pill)   chat.html   llm-response.html (overlay)   settings   │
│        │  mic PCM ↑           ↑ transcription-received   ↑ -start/-chunk/-  │
│        │  (getUserMedia)      │                          │  final broadcast │
└────────┼──────────────────────┼──────────────────────────┼────────────────┘
         │        preload.js (contextBridge — sole IPC crossing)             │
┌────────┼──────────────────────┼──────────────────────────┼────────────────┐
│        ▼           MAIN PROCESS · ApplicationController (main.js)          │
│  ┌───────────────────────────────────────────────────────────────────┐   │
│  │  Orchestrator (extends dispatchCoalescedUtterance seam)      [NEW]  │   │
│  │   onPause(transcript) → gather → relevance gate → provider → stream │   │
│  └───────┬───────────────┬───────────────┬───────────────┬───────────┘   │
│          │ transcript     │ latestFrame   │ mdContext     │ provider call  │
│  ┌───────▼──────┐ ┌───────▼───────┐ ┌─────▼──────┐ ┌──────▼─────────────┐ │
│  │ speech.service│ │capture         │ │context      │ │ llm.service FACADE │ │
│  │ (VAD reused)  │ │scheduler [NEW] │ │manager [NEW]│ │ (call-site shapes  │ │
│  │  _flush→HTTP  │ │ throttle+dscale│ │ watch .md   │ │  preserved)  [NEW] │ │
│  └──────┬────────┘ │ +hash dedup    │ │ bounded cat │ └──────┬─────────────┘ │
│         │          └────────────────┘ └─────────────┘        │ RequestBuilder │
│  ┌──────┼─────────────────────────────────────────────┐  ┌──▼──────────────┐ │
│  │  ServiceSupervisor (generic: spawn/health/backoff/  │  │ Provider registry│ │
│  │  kill-on-quit) — used by BOTH servers        [NEW]  │  │  (select+fallback)│ │
│  └──────┼───────────────────────┼─────────────────────┘  └──┬────┬────┬─────┘ │
│         │ start/stop            │ start/stop                 │    │    │       │
└─────────┼───────────────────────┼───────────────────────────┼────┼────┼───────┘
          ▼                       ▼                            ▼    ▼    ▼
   ┌──────────────┐      ┌─────────────────┐         ┌──────────┐ ┌────────┐ ┌────────┐
   │ whisper-server│      │ local model     │         │  Local   │ │ Claude │ │ Codex  │
   │  /inference   │      │ server (OpenAI- │◄────────│ Provider │ │Provider│ │Provider│
   │ (app-owned)   │      │ compat) :11434  │  HTTP   │(primary) │ │(backup)│ │(backup)│
   │  [NEW server] │      │ [NEW/managed]   │         └──────────┘ └───┬────┘ └───┬────┘
   └──────────────┘      └─────────────────┘                      spawn│ claude   │codex
                                                                       ▼ -p        ▼ exec
```

Legend: `[NEW]` = new main-process module; `[NEW server]` = new supervised child process. Everything else exists today.

### Component Responsibilities

| Component | Responsibility | Communicates With | Where it lives |
|-----------|----------------|-------------------|----------------|
| **LLMProvider interface** | Contract: `generate(req)`, `generateStream(req,onDelta)`, `isAvailable()`, `testConnection()`. Dumb transport — no skill/history/prompt logic. | Called by the facade only | `src/services/providers/provider.js` (doc/base) |
| **LocalProvider** (primary) | HTTP client to a localhost OpenAI-compatible endpoint; multimodal (image as base64 content part); token streaming via SSE. `isAvailable()` = supervisor health. | Local model server; ServiceSupervisor (health) | `src/services/providers/local.provider.js` |
| **ClaudeProvider / CodexProvider** (backup) | Thin adapter: spawn `claude -p` / `codex exec`, feed prompt (+ image path/`-i`), parse stdout stream, resolve `{response,metadata}`. Escalation only — never on the per-pause hot path. | `child_process`; the two CLI binaries | `src/services/providers/claude.provider.js`, `codex.provider.js` |
| **llm.service facade** | Preserves existing call-site shapes (`processImageWithSkillStream`, `processTextWithSkillStream`, `processTranscriptionWithIntelligentResponseStream`, `testConnection`, `getStats`). Builds a provider-neutral request (via RequestBuilder), selects provider, delegates. | main.js (unchanged callers); Provider registry; RequestBuilder | `src/services/llm.service.js` (rewritten internals, same exports) |
| **RequestBuilder** | Turns `(skill, text/image, history, programmingLanguage, mdContext)` into a neutral `{system, messages, image?}`. Owns prompt logic pulled out of today's `buildGeminiRequest*` / `getIntelligentTranscriptionPrompt`. | Facade; prompt-loader; context manager; session manager | `src/services/llm/request-builder.js` |
| **ServiceSupervisor** (generic) | Fills the "no long-running-service supervisor" gap **once**: spawn, health-poll, restart-on-crash with exponential backoff + cap, SIGTERM→SIGKILL on quit. Two configured instances. | Child processes; providers/speech (health + endpoint) | `src/managers/service-supervisor.js` |
| **LocalModelManager** | Configures the supervisor for the model server: ensure binary/daemon, ensure model pulled (progress → onboarding UI), pin resident (`keep_alive:-1`), expose endpoint + health to LocalProvider. | ServiceSupervisor; LocalProvider | `src/managers/local-model.manager.js` |
| **STT server client** | Replaces per-utterance Whisper spawn with an HTTP POST of the WAV segment to `whisper-server /inference`. VAD state machine + EventEmitter API unchanged. | whisper-server (via supervisor); speech.service VAD | edit inside `src/services/speech.service.js` |
| **Capture scheduler** | Continuous throttled capture at reduced resolution (downscale-before-encode), perceptual-hash dedup, holds `latestFrame`. Keeps single-shot `captureAndProcess()` for the manual shortcut. | Electron `desktopCapturer`/`nativeImage`; orchestrator (pull) | `src/services/capture.service.js` (extended) |
| **Context manager** (md-context) | Load a settings-configured dir of `.md` on launch, `fs.watch` for changes, concatenate under a bounded budget, expose `getContextBlock()`. | fs/watch; RequestBuilder | `src/managers/context.manager.js` |
| **Orchestrator** | The composition point. On pause: gather transcript + `latestFrame` + `mdContext` + history → relevance gate → provider stream → existing overlay broadcast envelope. Owns continuous-mode on/off + cooldown + single-flight. | All of the above; windowManager broadcast | extend `ApplicationController` or `src/managers/orchestrator.manager.js` |

---

## Recommended Project Structure

Matches existing conventions: `.service.js` under `src/services/`, `.manager.js` under `src/managers/`, singleton `module.exports = new ClassName()`, cross-cutting infra in `src/core/`. New code **extends**, never rewrites.

```
src/
├── services/
│   ├── llm.service.js            # KEEP EXPORTS: becomes a thin facade over providers
│   ├── llm/
│   │   └── request-builder.js    # NEW: skill+history+mdContext → neutral request
│   ├── providers/                # NEW: pluggable transport layer
│   │   ├── provider.js           #   base/interface doc: generate/generateStream/isAvailable/testConnection
│   │   ├── local.provider.js     #   PRIMARY: OpenAI-compatible localhost HTTP + SSE, multimodal
│   │   ├── claude.provider.js    #   BACKUP: spawn `claude -p`, parse stream-json
│   │   ├── codex.provider.js     #   BACKUP: spawn `codex exec --json -i`, parse JSONL
│   │   └── registry.js           #   NEW: primary + ordered fallback selection
│   ├── capture.service.js        # EXTEND: add continuous scheduler + dedup; keep single-shot
│   └── speech.service.js         # EDIT ONE METHOD: _transcribeWhisperFile → HTTP to whisper-server
├── managers/
│   ├── service-supervisor.js     # NEW: generic spawn/health/backoff/kill-on-quit
│   ├── local-model.manager.js    # NEW: model server lifecycle + model download + keep-warm
│   ├── stt.manager.js            # NEW (thin): whisper-server lifecycle via ServiceSupervisor
│   ├── context.manager.js        # NEW: md-context loader (watch dir, bounded concat)
│   └── orchestrator.manager.js   # NEW (or fold into ApplicationController): pause → suggestion
├── core/
│   └── config.js                 # EXTEND: local model + stt + capture + context + provider config
prompt-loader.js                  # KEEP: skill prompts; md-context is a SEPARATE concern (do not overload)
```

### Structure Rationale

- **`src/services/providers/`:** a directory (not one more mega-file) because there are ≥3 implementations plus a registry; keeps each transport small and independently testable. The current 1655-line `llm.service.js` is the anti-example — do not grow it.
- **Facade keeps its filename + exports:** every `main.js` caller (`main.js:1051, 1118, 1285`, plus `testConnection`/`getStats`/`updateApiKey`/`initializeClient`) keeps working untouched. The refactor is **internal to `llm.service.js`**. This is the lowest-risk way to swap the engine.
- **Generic `ServiceSupervisor` separate from the two managers:** the model server and STT server need *identical* lifecycle machinery (spawn/health/backoff/kill). Write it once; configure it twice. This directly fills the "no supervisor exists" blocker without duplication.
- **`context.manager.js` is NOT bolted into `prompt-loader.js`:** prompt-loader is skill-system-prompt-specific (its Map, its `normalizeSkillName`, its language injection). md-context is a different lifecycle (user dir, file-watch, budget). Generalizing prompt-loader's *dir-scan pattern* is fine; overloading its *object* is not.
- **Orchestrator can start as methods on `ApplicationController`** (it already holds `activeSkill`, coalesce buffers, `_utteranceDispatchInFlight`) and be extracted to its own manager if it grows. Either is consistent with the codebase.

---

## Architectural Patterns

### Pattern 1: Facade-over-providers (preserve call-site shapes)

**What:** Keep `llm.service.js`'s public methods identical; internally build a neutral request and delegate to a selected provider. The provider is a dumb transport.
**When to use:** Always — this is the seam that lets the whole milestone proceed without touching ~6 call sites in `main.js`.
**Trade-offs:** One extra indirection; in exchange, provider swaps and A/B fallback become config, and Gemini deletion is contained to the facade internals + the deleted `GeminiProvider` that never gets written.

```javascript
// src/services/llm.service.js  (same exports as today — callers unchanged)
class LLMService {
  // main.js:1051 calls this exact shape; DO NOT change the signature.
  async processImageWithSkillStream(imageBuffer, mimeType, activeSkill,
                                    sessionMemory = [], programmingLanguage = null, onDelta = null) {
    const req = requestBuilder.build({
      skill: activeSkill, programmingLanguage, history: sessionMemory,
      image: { buffer: imageBuffer, mimeType },
      mdContext: contextManager.getContextBlock(),   // NEW: standing notes
    });
    const provider = registry.select();              // LocalProvider primary
    return this._runWithFallback(provider, req, onDelta);
  }

  async _runWithFallback(provider, req, onDelta) {
    try {
      if (await provider.isAvailable()) return await provider.generateStream(req, onDelta);
    } catch (e) { logger.warn('primary provider failed', { error: e.message }); }
    for (const backup of registry.fallbacks()) {     // Claude/Codex CLI — NOT on the per-pause path
      if (await backup.isAvailable()) return backup.generateStream(req, onDelta);
    }
    return { response: this.generateFallbackResponse(req), metadata: { usedFallback: true } };
  }
}
module.exports = new LLMService();
```

The return contract every caller depends on — `{ response, metadata:{ processingTime, usedFallback, ... } }` — is preserved (`main.js:1064-1080` reads exactly these fields).

### Pattern 2: Generic ServiceSupervisor (spawn / health / backoff / kill-on-quit)

**What:** One reusable module that owns a child process: start on launch, poll a health URL, restart on crash with exponential backoff + a retry cap, and terminate on `will-quit`.
**When to use:** For every app-owned local server (model server, whisper-server). This is the missing "supervisor" the whole always-on vision needs.
**Trade-offs:** Adds process-management complexity to the main process; mitigated by centralizing it once.

```javascript
// src/managers/service-supervisor.js
class ServiceSupervisor {
  constructor({ name, spawnArgv, healthUrl, backoffMs = 500, maxBackoffMs = 15000, maxRestarts = 8 }) {
    Object.assign(this, { name, spawnArgv, healthUrl, backoffMs, maxBackoffMs, maxRestarts });
    this.child = null; this.restarts = 0; this.stopping = false; this.healthy = false;
  }
  async start() {
    this.stopping = false;
    const [cmd, ...args] = this.spawnArgv;
    this.child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child.on('exit', (code) => this._onExit(code));   // NEVER let an unlistened 'error' crash the app
    this.child.on('error', (err) => logger.error(`${this.name} spawn error`, { err: err.message }));
    await this._awaitHealthy();
  }
  _onExit(code) {
    this.healthy = false;
    if (this.stopping) return;                             // expected shutdown
    if (this.restarts++ >= this.maxRestarts) {             // give up → provider.isAvailable() goes false → escalate
      logger.error(`${this.name} exceeded restart cap`); return;
    }
    const delay = Math.min(this.backoffMs * 2 ** (this.restarts - 1), this.maxBackoffMs);
    setTimeout(() => this.start(), delay + Math.random() * 250); // jitter
  }
  async stop() {                                           // called from main.js onWillQuit()
    this.stopping = true;
    if (!this.child) return;
    this.child.kill('SIGTERM');
    setTimeout(() => this.child && this.child.kill('SIGKILL'), 2000).unref();
  }
}
```

Wire-up mirrors existing lifecycle hooks exactly: `app.whenReady().then(onAppReady)` (`main.js:172`) → `supervisor.start()`; `app.on('will-quit', onWillQuit)` (`main.js:175`) → `supervisor.stop()`.

### Pattern 3: Own-if-started vs adopt-if-present (shared daemon nuance)

**What:** How the supervisor treats a server it may not exclusively own.
**When to use:** Critical decision driven by the chosen local-model runtime.

- **App-owned process** (whisper.cpp `whisper-server`, or llama.cpp `llama-server`): the app spawns it on a private port; the supervisor fully owns start/health/restart/**kill-on-quit**. Clean, symmetric, satisfies the stated supervisor contract exactly.
- **Shared daemon** (Ollama): Ollama installs as a background service on macOS/Windows and binds `127.0.0.1:11434` *system-wide* (verified, Ollama FAQ). The supervisor should **probe first, start `ollama serve` only if absent, and NOT kill it on quit** if another client may be using it. "Keep resident" is done via `keep_alive: -1` (or `OLLAMA_KEEP_ALIVE`), not by holding the process.

```javascript
async ensureModelServer() {
  if (await this._probe(this.healthUrl)) { this.adopted = true; return; }   // adopt existing daemon
  await this.supervisor.start();                                           // else own it
}
async stop() { if (!this.adopted) await this.supervisor.stop(); }          // don't kill what you didn't start
```

**Recommendation:** PROJECT.md states "Ollama-style … OpenAI-compatible localhost endpoint," so honor that direction — but be aware Ollama breaks the clean "stop on quit" contract. If the roadmap wants a *fully app-owned, supervisable* server that also mirrors the whisper-server pattern (same spawn/kill machinery), **llama.cpp `llama-server`** is the architecturally symmetric choice (OpenAI-compatible `/v1/chat/completions`, multimodal via mtmd, model resident, app-private port). This is a STACK.md decision; ARCHITECTURE only flags that the supervisor must support both "own" and "adopt" modes.

### Pattern 4: Persistent server instead of per-invocation spawn (STT)

**What:** Stop spawning a Python/Whisper process per utterance; POST each VAD segment to a long-running server. **The VAD state machine and every event upstream stay identical** — only the transcription backend changes at one method.
**When to use:** This is the #1 blocker to continuous listening; it is a surgical swap, not a rewrite.

```javascript
// speech.service.js — replace the body of _transcribeWhisperFile(...) (per-utterance spawn)
// with an HTTP POST of the SAME WAV buffer the VAD path already produces (_createWavBuffer).
async _transcribeViaServer(wavBuffer) {
  const form = new FormData();                        // whisper-server accepts multipart at /inference
  form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'seg.wav');
  const res = await fetch(`${this.sttEndpoint}/inference`, { method: 'POST', body: form });
  const { text } = await res.json();
  return text;                                        // emitted via existing 'transcription' event → main.js
}
```

`_ingestWhisperAudio`/`_endUtteranceFlush` (the pause detector, `speech.service.js:800-902`), the `EventEmitter` surface (`transcription`, `status`, …), and the hallucination filter are all reused unchanged. Continuous ambient listening = "keep the mic + VAD running from launch; each detected pause POSTs one segment." No websocket needed for v1 (whisper-server is request/response); true streaming STT (WhisperLive-style) is a later optional enhancement.

### Pattern 5: Throttle + downscale-before-encode + hash dedup (capture scheduler)

**What:** A timer-driven capture loop that (a) requests a **reduced-resolution** frame so the OS downscales *before* any PNG encode, (b) computes a cheap perceptual hash, (c) stores the frame only if it differs from the last beyond a threshold, and (d) exposes `getLatestFrame()` for the orchestrator to pull at pause time.
**When to use:** Continuous watching. Never encode/store full-res every tick.
**Trade-offs:** A hash per tick costs CPU; keep the hash input small (e.g. 32×32 grayscale). Interval is a battery/freshness knob (start ~1-2 s).

```javascript
// capture.service.js (extended) — downscale happens in desktopCapturer via thumbnailSize
async _tick() {
  const [w, h] = this._downscaledSize();               // e.g. cap long edge ~1280 (or ~640 for the hash)
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: w, height: h } });
  const img = sources[0].thumbnail;                    // already downscaled by the OS — no full-res encode
  const hash = this._dHash(img.resize({ width: 16, height: 16 }).toBitmap()); // nativeImage → no native dep (no sharp)
  if (this._hamming(hash, this._lastHash) <= this.dedupThreshold) return;      // near-identical → skip
  this._lastHash = hash;
  this.latestFrame = { buffer: img.toPNG(), mimeType: 'image/png', hash, ts: Date.now() }; // encode only on change
}
getLatestFrame() { return this.latestFrame; }
```

Note: today's `capture.service.js:71` already sets `thumbnailSize` to the *display* size — lowering it is the entire "downscale-before-encode" mechanism, and Electron `nativeImage` (`.resize()`, `.toBitmap()`) covers the hash without adding `sharp`, which keeps `asarUnpack`/packaging simple.

### Pattern 6: Pause-triggered orchestration with a layered relevance gate

**What:** At a pause, fuse inputs, gate for relevance, then stream from the primary provider — reusing the existing coalesce seam and broadcast envelope.
**When to use:** The core continuous-mode behavior.
**Trade-offs:** A naive "ask the model every pause" wastes latency/compute on chit-chat. Use a **layered** gate: cheap heuristics first, model-abstain last.

```javascript
// orchestrator.manager.js — replaces the body of dispatchCoalescedUtterance()'s LLM call (main.js:1211-1224)
async onPause(transcript) {
  if (!this.continuousMode) return;                              // pause/kill switch
  if (this._inFlight) return;                                    // reuse existing single-flight guard
  // ── Gate layer 1: heuristics (free) ──
  if (transcript.trim().length < this.minChars) return;
  if (Date.now() - this._lastAnswerTs < this.cooldownMs) return; // don't spam
  const frame = captureScheduler.getLatestFrame();
  if (this._answeredFor(transcript, frame?.hash)) return;        // dedup: same words+screen as last answer
  // ── Gate layer 2: model may abstain (bounded) ──
  const req = requestBuilder.build({
    skill: this.activeSkill, history: sessionManager.getOptimizedHistory().recent,
    text: transcript, image: frame, mdContext: contextManager.getContextBlock(),
    mode: 'ambient',                                             // system prompt: "reply only if you can genuinely help, else output nothing"
  });
  const messageId = `amb-${Date.now()}-${++this._seq}`;
  windowManager.broadcastToAllWindows('transcription-llm-response-start', { messageId, skill: this.activeSkill });
  this._inFlight = true;
  try {
    const result = await llmService.generateAmbient(req, (delta) =>
      windowManager.broadcastToAllWindows('transcription-llm-response-chunk', { messageId, delta }));
    if (result.abstained) { windowManager.hideLLMResponse(); return; }   // gate said "nothing useful"
    sessionManager.addModelResponse(result.response, { messageId, isAmbient: true });
    windowManager.showLLMResponse(result.response, { messageId, isAmbient: true }); // existing overlay path
    this._lastAnswerTs = Date.now();
  } finally { this._inFlight = false; }
}
```

The `-start` / `-chunk` / final broadcast envelope already exists (`main.js:1046, 1277`); continuous mode is the reason to finally **wire the overlay renderer to consume `-chunk`** (today only dead `src/ui/chat-window.js` reads it, so streaming is invisible — see Anti-Patterns).

### Pattern 7: Bounded md-context concatenation (no RAG in v1)

**What:** Read a settings-configured dir of `.md`, concatenate under a char/token budget, watch for changes, expose one `getContextBlock()` string injected into the system prompt by RequestBuilder.
**When to use:** "A few md files" — PROJECT.md explicitly scopes out RAG/vectors for v1.
**Trade-offs:** Simple and predictable; if notes grow past the budget you silently truncate — surface which files were included.

```javascript
// context.manager.js — generalizes prompt-loader.js's dir-scan (but is its own module)
class ContextManager {
  load() {
    const dir = config.get('context.mdDir');                    // settings-configured
    if (!dir || !fs.existsSync(dir)) { this.block = ''; return; }
    let budget = config.get('context.maxChars') || 12000, out = [];
    for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.md')).sort()) {
      const body = fs.readFileSync(path.join(dir, f), 'utf8');
      if (body.length > budget) { out.push(`## ${f}\n${body.slice(0, budget)}`); break; }
      out.push(`## ${f}\n${body}`); budget -= body.length;
    }
    this.block = out.join('\n\n');
    this._watcher ??= fs.watch(dir, { persistent: false }, () => this.load()); // reload on change
  }
  getContextBlock() { return this.block || ''; }
}
```

### Pattern 8: Headless CLI-agent adapter (conceptual — thin spawn + stream parse)

**What:** A backup/escalation provider that spawns a coding-agent CLI in **non-interactive/print** mode, feeds the same neutral request, and parses its structured stdout into the `{response, metadata}` contract. Reuses the user's existing terminal login (no managed API keys) — the privacy story stays intact.
**When to use:** Only as fallback or a manual "escalate" action — **never on the per-pause hot path** (cold start + cloud latency + usage cost; PROJECT.md constraint).

This is where the `thunderock/forge` reference applies, but with a key difference: **forge spawns full interactive TUI agents in a PTY for multi-turn orchestration; OpenCluely needs one-shot headless calls.** So borrow forge's *binary discovery + per-agent argument shaping* (`agent-args.ts`, `which('claude'|'codex')`) but use **print/exec mode**, not a PTY.

Verified invocation surfaces (official docs, 2026):

```javascript
// claude.provider.js — auth = existing OAuth login (do NOT pass --bare; bare forces ANTHROPIC_API_KEY)
// Image: no --image flag; Claude Code reads an image by PATH referenced in the prompt (full Claude vision).
spawn('claude', ['-p', promptTextIncludingFramePath,
  '--append-system-prompt', systemBlock,          // skill + md-context
  '--output-format', 'stream-json', '--verbose', '--include-partial-messages', // token deltas → onDelta
  '--allowedTools', 'Read']);                      // so it can Read the temp PNG frame

// codex.provider.js — auth = saved codex login OR CODEX_API_KEY. Native image via -i (prompt MUST precede -i in exec).
spawn('codex', ['exec', promptText, '-i', framePngPath,
  '--json',                                        // JSONL ThreadEvents on stdout → parse final message
  '--sandbox', 'read-only', '--ephemeral', '--skip-git-repo-check']); // safe one-shot, no repo mutation
```

Both are: spawn → parse streamed stdout → resolve `{response, metadata}`. `isAvailable()` = `which` finds the binary AND a cached auth check passes. The frame is written to a temp PNG the agent reads (Claude: path-in-prompt; Codex: `-i`).

---

## Data Flow

### Continuous always-on flow (the core path)

```
LAUNCH  (main.js onAppReady, :172)
  ServiceSupervisor.start(modelServer)  ── health-gated ──►  LocalProvider.isAvailable = true
  ServiceSupervisor.start(whisper-server)
  contextManager.load()                 (md dir → bounded block)
  captureScheduler.start()              (throttled/deduped → latestFrame)
  speechService.startRecording()        (ambient VAD from launch)

AMBIENT LOOP
  mic PCM16 (renderer getUserMedia, main-window.js) ─► speech.service VAD
     └─ silence hangover reached ─► WAV segment ─► POST whisper-server /inference ─► text
                                                                                     │
  text ─► ApplicationController.handleTranscriptionFragment (main.js:1181)          │
     ├─ broadcast 'transcription-received' (live caption in chat)                    │
     └─ buffer + 800ms coalesce debounce ─► orchestrator.onPause(transcript) ◄───────┘
            gather: transcript + captureScheduler.getLatestFrame() + contextManager.getContextBlock() + history
            ▼ relevance gate (heuristics → model-abstain)
            ▼ requestBuilder.build() ─► registry.select() = LocalProvider
            ▼ LocalProvider.generateStream(req, onDelta)   [escalate to Claude/Codex only if local is down]
            ▼ onDelta ─► broadcast 'transcription-llm-response-chunk' ─► overlay streams tokens
            ▼ final ─► sessionManager.addModelResponse + windowManager.showLLMResponse

QUIT  (main.js onWillQuit, :175)
  supervisor.stop(app-owned servers)  (SIGTERM→SIGKILL; do NOT kill an adopted Ollama daemon)
  captureScheduler.stop(); speechService.stopRecording()
```

### Provider selection / escalation

```
request ─► registry.select()
              ├─ LocalProvider.isAvailable()?  ── yes ─► stream (primary, hot path)
              └─ no (supervisor unhealthy after restart cap)
                     ├─ ClaudeProvider.isAvailable()? ─► spawn claude -p        (backup)
                     ├─ CodexProvider.isAvailable()?  ─► spawn codex exec       (backup)
                     └─ none ─► generateFallbackResponse()  (canned; keeps UI non-empty)
```

### Key data flows

1. **Screen frame is pulled, not pushed:** the scheduler maintains `latestFrame`; the orchestrator reads it at pause time. This decouples capture cadence from answer cadence and means a pause always has a recent frame without a synchronous capture on the hot path.
2. **STT text re-enters the exact existing seam:** the server swap is invisible above `speech.service` — `handleTranscriptionFragment` and the coalesce debounce are unchanged.
3. **md-context and skill prompt are composed in RequestBuilder,** not in providers — so both the local model and the CLI agents receive the same standing context via their respective system-prompt mechanisms (`local`: system message; `claude`: `--append-system-prompt`; `codex`: prompt preamble).

---

## Scaling Considerations

Single-user desktop app — the honest scaling axes are **idle cost, per-pause latency, and unbounded growth**, not user count.

| Axis | What breaks first | Mitigation |
|------|-------------------|------------|
| **Idle CPU/battery** (always-on) | Capture loop + VAD run continuously | Throttle capture interval (1-2 s), dedup so unchanged screens cost ~one hash, downscale before encode, pause on screen-lock/idle. VAD already gates on energy floor. |
| **Per-pause latency** (must feel real-time) | Multimodal generation on the hot path | Local model resident (`keep_alive:-1`) to avoid reload; small/quantized VLM sized for 32 GB Apple Silicon; relevance gate to skip non-questions; cap `maxOutputTokens`; stream so first token shows fast. CLI agents never on this path. |
| **Memory** | Two resident models (VLM + Whisper) + Electron | whisper "base/small" is light; the VLM dominates — size it for headroom on 32 GB. Supervisor can unload STT when listening is off. |
| **Context growth** | md-context + session history bloat the prompt | Bounded md budget (truncate + report); `sessionManager.getOptimizedHistory()` already trims. Watch total prompt tokens. |
| **Overlapping pauses** | Two answers racing | Existing `_utteranceDispatchInFlight` single-flight guard + cooldown; queue-or-drop, don't stack. |

**First bottleneck to expect:** per-pause end-to-end latency (VAD hangover + STT round-trip + VLM first-token). Instrument each stage; the `logPerformance` helper already exists.

---

## Anti-Patterns

### Anti-Pattern 1: Spawning a process per event
**What people do:** Keep the current "spawn Whisper per utterance" model and add "spawn a model process per pause."
**Why it's wrong:** Process/model cold-start is the dominant latency and the #1 blocker to continuous mode; at pause cadence it is untenable.
**Do this instead:** Two persistent, supervised servers; clients make HTTP calls. (Patterns 2, 4.)

### Anti-Pattern 2: Killing a shared daemon you didn't start
**What people do:** `supervisor.stop()` unconditionally SIGKILLs the model server on quit.
**Why it's wrong:** If it's a shared Ollama daemon (system-wide :11434), you break other clients and fight the OS service manager.
**Do this instead:** Own-if-started, adopt-if-present; only stop what you spawned. (Pattern 3.)

### Anti-Pattern 3: Full-res capture + encode every tick
**What people do:** Reuse `captureAndProcess()` (full display `thumbnailSize` → `toPNG()`) on a 1 s timer.
**Why it's wrong:** Encodes megabytes/sec of mostly-identical frames, burning CPU/battery for nothing.
**Do this instead:** Downscale via `thumbnailSize`, hash-dedup, encode only on change, pull latest at pause. (Pattern 5.)

### Anti-Pattern 4: Putting prompt/skill/history logic inside providers
**What people do:** Each provider builds its own skill prompt / history formatting.
**Why it's wrong:** Duplicates logic 3×, and swapping providers changes answer behavior.
**Do this instead:** RequestBuilder produces one neutral request; providers are dumb transports. (Patterns 1, 8.)

### Anti-Pattern 5: CLI agents on the per-pause hot path
**What people do:** Route ambient suggestions through Claude/Codex for quality.
**Why it's wrong:** Cold-start + cloud latency + per-call cost violates the real-time + privacy + cost constraints.
**Do this instead:** Local model only on the hot path; CLI agents are manual escalation / offline-local-down backup. (Pattern 8.)

### Anti-Pattern 6: Broadcasting stream chunks no renderer consumes
**What people do:** Emit `-start`/`-chunk` events (as today) while no live renderer listens — so streaming is invisible and answers appear all-at-once.
**Why it's wrong:** The backend streams but the UX doesn't; the effort is wasted (this is the current shipped state — only dead `src/ui/chat-window.js` reads `-chunk`).
**Do this instead:** As part of continuous mode, wire `llm-response.html` (and chat) to consume `-chunk` and progressively render.

### Anti-Pattern 7: Blocking `will-quit` on slow child shutdown
**What people do:** Await a graceful child exit synchronously in `onWillQuit`.
**Why it's wrong:** Hangs quit; Electron may force-terminate mid-write.
**Do this instead:** SIGTERM then a short SIGKILL timer (`.unref()`); don't await. (Pattern 2.)

---

## Integration Points

### External Services

| Service | Integration Pattern | Notes / gotchas |
|---------|---------------------|-----------------|
| **Local model server** (Ollama or llama-server) | HTTP OpenAI-compatible (`/v1/chat/completions`, SSE stream); image as base64 content part | Ollama = shared daemon on :11434, `keep_alive:-1` to pin resident, default unload 5 min; llama-server = app-owned, private port, symmetric with whisper-server. Supervisor must support own+adopt. |
| **whisper.cpp `whisper-server`** | HTTP `POST /inference` multipart WAV; `/load` to swap; `-m --host --port` | App-owned, model resident, request/response (no streaming socket) — fine, VAD already segments. Not OpenAI-shaped (it's `/inference`), so the STT client is bespoke, not the OpenAI client. |
| **Claude Code CLI** (`claude -p`) | `child_process.spawn`; `--output-format stream-json --verbose --include-partial-messages`; `--append-system-prompt`; image by path-in-prompt + `--allowedTools Read` | Auth = existing OAuth login (reused); **do not** pass `--bare` (it skips OAuth and requires `ANTHROPIC_API_KEY`). ~5 s background-task grace at exit. |
| **OpenAI Codex CLI** (`codex exec`) | `child_process.spawn`; `--json` (JSONL); native image via `-i` (prompt must precede `-i`); `--sandbox read-only --ephemeral --skip-git-repo-check` | Auth = saved codex login or `CODEX_API_KEY`. No `-m` documented in exec; set model via config if needed. |
| **Model weights download** (first run) | Ollama `pull` (`POST /api/pull`) / llama-server GGUF fetch; progress → onboarding UI | Mirror existing `whisper-installer.js` progress-streaming UX (openwhispr-style). Cache under `~/.ollama` or `~/.cache`. |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| main.js callers ↔ `llm.service` facade | Direct method calls, unchanged signatures | The whole refactor hides behind this — preserve `processImageWithSkillStream`/`processTextWithSkillStream`/`processTranscriptionWithIntelligentResponseStream`/`testConnection`/`getStats`. |
| facade ↔ providers | `generate` / `generateStream(req, onDelta)` / `isAvailable` / `testConnection` | Neutral request in, `{response, metadata}` out. |
| ServiceSupervisor ↔ providers/speech | Health flag + resolved endpoint | `LocalProvider.isAvailable()` and STT client read supervisor health; drives escalation + the UI indicator. |
| speech.service VAD ↔ STT client | Internal method swap (`_transcribeWhisperFile` → HTTP) | Everything above the swap (VAD, events, coalesce) is untouched. |
| capture scheduler ↔ orchestrator | Pull (`getLatestFrame()`) | Decouples capture cadence from answer cadence. |
| orchestrator ↔ windowManager | `broadcastToAllWindows` + `showLLMResponse` | Existing broadcast envelope + overlay path reused. |
| context manager ↔ RequestBuilder | `getContextBlock()` string | Injected into system prompt for every provider. |
| main.js lifecycle ↔ supervisor/scheduler | `onAppReady` start, `onWillQuit` stop | Hooks already exist (`main.js:172,175`). |

---

## Build Order (dependency-driven — primary roadmap input)

Ordered by "what must exist before what." Each step is independently shippable/testable.

```
0. Test + lint + Makefile baseline           (no deps; enables safe refactor of 1655-line files)
1. ServiceSupervisor (generic)               (no deps; foundational for 2 & 4)
2. Local model server + LocalProvider        (deps: 1) ── proves the "if all else fails, this works" core
   + provider.js interface + registry
3. llm.service FACADE routing + remove Gemini (deps: 2) ── swap engine behind unchanged call sites
   + RequestBuilder (skill/history/prompt logic moves here)
4. Persistent STT server + speech.service swap(deps: 1) ── unblocks continuous listening  [∥ with 3]
5. md-context loader                          (deps: RequestBuilder from 3)                [∥ with 4]
6. Continuous capture scheduler               (deps: none beyond capture.service)          [∥ with 3,4,5]
7. Pause-triggered orchestrator + relevance   (deps: 3,4,5,6) ── composes everything; wire overlay -chunk
   gate + continuous-mode UI (indicator/kill)
8. CLI backup providers (Claude/Codex)        (deps: 2,3 facade+registry) ── escalation; off hot path
9. Security + cleanup                          (sanitize innerHTML, drop cert bypass, dead code) [∥ throughout]
```

**Why this order:**
- **Supervisor (1) is the true foundation** — both the model server (2) and STT server (4) need identical lifecycle machinery; building it once unblocks two subsystems.
- **Local engine (2) before the facade swap (3):** stand up a working primary transport in isolation, *then* re-point the call sites and delete Gemini — a working local engine de-risks Gemini removal (otherwise you delete the only working path first).
- **STT (4), md-context (5), capture (6) are mutually independent** and can parallelize once their upstreams exist; none of them alone changes user-visible behavior much.
- **Orchestrator (7) is necessarily last among features** — it is the composition point that fuses providers + STT + context + frame. Do it after its inputs exist, or it has nothing to fuse. This is also where the dead-streaming UX bug finally gets fixed (wire `-chunk`).
- **CLI backup (8) is deliberately late** — it is not on the hot path and the local path must prove out first.

**Research flags for the roadmap:**
- **Phase 2 (local model server):** needs deeper research — exact runtime (Ollama vs llama-server), a 32 GB-Apple-Silicon-appropriate multimodal model, and the OpenAI-compatible multimodal request shape. STACK.md territory. **HIGH-impact, MEDIUM-certainty.**
- **Phase 7 (relevance gate):** needs product-tuning research — heuristic thresholds vs model-abstain vs a cheap classify call; how to avoid answering the assistant's own speech and how to set cooldown. **MEDIUM-certainty.**
- **Phases 3, 4, 5, 6, 8:** standard patterns, integration seams are read and known; unlikely to need deep research beyond the API details captured here.

---

## Sources

- Claude Code — Run Claude Code programmatically (headless `-p`, `--output-format stream-json`, `--append-system-prompt`, `--allowedTools`, `--bare`/auth) — https://code.claude.com/docs/en/headless — **HIGH** (official)
- Claude Code image handling (path-in-prompt, full Claude vision, formats/limits) — https://smartscope.blog/en/generative-ai/claude/claude-code-image-guide/ , https://felloai.com/claude-code-images/ — **MEDIUM** (community, multiple agree)
- OpenAI Codex CLI non-interactive mode (`codex exec`, `--json`, `--output-schema`, `-o`, `--sandbox`, `--ephemeral`, auth) — https://learn.chatgpt.com/docs/non-interactive-mode — **HIGH** (official)
- Codex CLI image input (`-i`/`--image`, prompt-before-`-i` in exec, formats) — https://inventivehq.com/knowledge-base/openai/how-to-use-image-input , https://codex.danielvaughan.com/2026/03/28/codex-cli-image-workflows/ — **MEDIUM** (community, multiple agree)
- Ollama FAQ (serve/daemon, :11434, `OLLAMA_KEEP_ALIVE`/`keep_alive:-1`, `OLLAMA_MODELS`, preload) — https://docs.ollama.com/faq — **HIGH** (official)
- Ollama OpenAI-compatibility + multimodal — https://deepwiki.com/ollama/ollama/3.4-openai-compatibility-layer , https://deepwiki.com/ollama/ollama/7.3-multimodal-and-vision-support — **MEDIUM**
- whisper.cpp HTTP server (`whisper-server`, `/inference`, `/load`, `-m --host --port`, multipart WAV) — https://github.com/ggml-org/whisper.cpp/blob/master/examples/server/README.md — **HIGH** (official README)
- whisper.cpp vs faster-whisper on Apple Silicon (Metal/Core ML) — https://codersera.com/blog/faster-whisper-vs-whisper-cpp-speech-to-text-2026/ — **MEDIUM**
- Existing code (read directly): `main.js` (lifecycle :172-175, LLM call sites :1028-1360, coalesce seam :1181-1237), `src/services/llm.service.js` (method signatures), `src/services/speech.service.js` (VAD :800-902), `src/services/capture.service.js`, `prompt-loader.js`, `src/core/config.js` — **HIGH** (source of truth)
- `.planning/codebase/ARCHITECTURE.md` + `STRUCTURE.md` + `.planning/PROJECT.md` (milestone scope, constraints, decisions) — **HIGH**
- `thunderock/forge` (`/Users/ashutosh/personal/forge`): binary discovery + per-agent arg shaping (`electron/mcp/agent-args.ts`), PTY vs one-shot distinction, DMG release workflow — **HIGH** (local source)

---
*Architecture research for: local-first always-on multimodal desktop copilot (brownfield Electron)*
*Researched: 2026-07-13*
