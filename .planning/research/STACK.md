# Stack Research — Local-First Multimodal Copilot (New Milestone)

**Domain:** Always-on, local-first, multimodal AI desktop copilot (Electron, Apple Silicon primary)
**Researched:** 2026-07-13
**Confidence:** HIGH on core runtime/model/STT decisions; MEDIUM on specific latency/memory numbers and younger supporting libs.

> Scope: this covers only the **NEW** stack for the local-first pivot — (a) local multimodal LLM serving, (b) persistent local STT, (c) CLI-agent backup providers, plus supervision/cache/download plumbing. The existing Electron + CommonJS + vanilla-JS app is already mapped in `.planning/codebase/` and is **not** re-litigated here. All choices respect the locked constraints: **CommonJS, no bundler, no TS, no framework rewrite; Apple Silicon 32 GB+ primary; keep Windows/Linux building.**

---

## TL;DR Recommendations

| Layer | Pick | One-line why |
|-------|------|--------------|
| **Local LLM runtime (PRIMARY)** | **Ollama ≥ 0.19** | Only option that combines OpenAI-compatible `/v1`, automatic model download+cache, cross-platform single binary, MLX acceleration on Apple Silicon, resident-model keep-alive, and an official CJS Node client. Matches the project's stated "à la Ollama" direction. |
| **Multimodal model (PRIMARY)** | **`qwen3-vl:8b`** (6.1 GB, 256K ctx) | Purpose-built "visual agent": strong OCR (32 langs), UI-element understanding, document/chart parsing — exactly what screen-watching needs. Comfortable on 32 GB. |
| **Multimodal model (quality upgrade)** | **`qwen3-vl:30b`** (20 GB, MoE ~3B active) | Near-32B quality at ~3B-active decode speed. Fits 32 GB but tight — use only if other apps are closed / RAM ≥ 36 GB. |
| **Multimodal model (light alt)** | **`gemma3:4b`** / **`gemma3:12b`** (3.3 / 8.1 GB) | Smaller footprint, Google lineage, solid general multimodal; good "second opinion" or low-RAM fallback. |
| **STT engine** | **whisper.cpp v1.9.x** (Metal + Core ML) | No Python, single native core, GPU-accelerated on Apple Silicon (~4–10× realtime). faster-whisper is **CPU-only** on Apple Silicon. |
| **STT embedding** | **`smart-whisper`** (in-process, resident model) | Loads the model once and keeps it resident → directly eliminates the per-utterance Python spawn (the #1 continuous-listening blocker). Cross-platform, auto model manager, Metal on macOS. |
| **LocalProvider transport** | **`openai` npm ≥ 6** → `baseURL: http://127.0.0.1:11434/v1` | One OpenAI-compatible client works for Ollama today and any `/v1` runtime later (llama-server, LM Studio, mlx-vlm). CJS-compatible. |
| **CLI backup providers** | **`claude -p` / `codex exec` via `child_process.spawn`** | Headless one-shot, reuses existing terminal auth (no app-stored keys). Never on the per-pause hot path. |
| **Service supervision** | **`node:child_process` + built-in `fetch` health-check + `tree-kill`** | Reuses existing spawn patterns; zero-friction in CommonJS. `electron-ollama` is an optional accelerator. |

---

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| **Ollama** | **≥ 0.19** (0.19 = MLX-on-Apple-Silicon preview, Mar 2026) | Local model server: OpenAI-compatible `/v1`, model download+cache, resident model, multimodal engine | The single best fit for *all six* requirements at once. `GET /v1/chat/completions` is OpenAI-shaped (base64 image parts, `stream:true`). `ollama pull` auto-downloads + caches. One binary runs on macOS/Win/Linux (keeps the cross-platform build). Since **0.19** it runs on **Apple's MLX** on Apple Silicon (big speedup; requires **>32 GB** unified memory for the MLX path — the Metal/GGML path still works below that). `OLLAMA_KEEP_ALIVE=-1` (or `keep_alive:-1`) pins the model in memory. HIGH. |
| **`openai` (Node SDK)** | **6.46.0** | Transport for `LocalProvider` → Ollama `/v1` | Point `baseURL` at `http://127.0.0.1:11434/v1`, `apiKey:'ollama'` (required-but-ignored). Handles SSE streaming for you. Publishes a **CommonJS** build (`require` → `./index.js`), so it drops into the existing CJS codebase. Runtime-agnostic: swap `baseURL` to move to llama-server/LM Studio/mlx-vlm with no code change. HIGH. |
| **whisper.cpp** | **v1.9.1** (Jun 2026) | Local speech-to-text engine | Pure C/C++, **no Python / venv / torch** — deletes the current per-utterance Python dependency outright. Runs **fully on GPU via Metal** and can offload the encoder to the **ANE via Core ML** (~3× encoder speedup). ~4–10× realtime on Apple Silicon. Cross-platform (also covers the Win/Linux build). HIGH. |
| **`smart-whisper`** | **latest (native Node addon over whisper.cpp)** | Keep the Whisper model **resident** and transcribe VAD segments in-process | "Load model once, run many (parallel) inferences," automatic model offload/reload, built-in model downloader/manager, Win/macOS/Linux out of the box, auto GPU accel on macOS. This is the cleanest way to satisfy "persistent local STT" — no separate process/port/HTTP to supervise; each VAD-flushed segment calls `transcribe()` against the already-loaded model. **Native module** → needs `electron-rebuild`/prebuilds (see Version Compatibility). MEDIUM (single-maintainer lib; validate on your Electron ABI early). |

### Multimodal Models (served by Ollama, image input over `/v1`)

All are pulled with `ollama pull <tag>` and cached automatically; all accept base64 image parts via the OpenAI-compatible endpoint.

| Model tag | Download | Context | Approx. resident RAM* | Latency / quality profile | When to use |
|-----------|----------|---------|----------------------|---------------------------|-------------|
| **`qwen3-vl:8b`** ⭐ | 6.1 GB | 256K (→1M) | ~7–9 GB | Fast dense-8B decode; **best default**. Excellent OCR (32 langs, robust to low-light/blur/tilt), **UI-element/"visual agent" understanding**, document & chart parsing | **Primary** — screen-watching, on-demand screenshot Q&A, notes+speech synthesis on 32 GB |
| **`qwen3-vl:30b`** | 20 GB | 256K (→1M) | ~22–24 GB | MoE (~3B active) → decode speed close to an 8B while quality approaches 32B | Quality upgrade; **tight on 32 GB** (close other apps) — prefer at ≥36 GB |
| **`qwen3-vl:4b`** | 3.3 GB | 256K | ~4–5 GB | Faster, lighter; still strong vision for its size | Lower-RAM machines / lower latency budget |
| **`gemma3:4b`** | 3.3 GB | 128K | ~4–5 GB | Fastest multimodal here; good general vision, weaker dense-text/UI than Qwen3-VL | Light alternative / "second opinion" / 16–24 GB machines |
| **`gemma3:12b`** | 8.1 GB | 128K | ~9–11 GB | Mid; strong general multimodal | Balanced alt to Qwen3-VL:8b |
| **`gemma3:27b`** | 17 GB | 128K | ~19–21 GB | Higher quality, slower image prefill; tight on 32 GB | Quality alt if you prefer Gemma lineage |
| **`minicpm-v` (4.5, 8b)** | ~6 GB | — | ~7–9 GB | Punches above weight on OCR/documents | OCR-heavy alternative to Qwen3-VL:8b |

*Resident RAM ≈ weights + KV cache (grows with context & image tokens) + a working margin. **Budget for the whole system on 32 GB:** VLM (7–9 GB) + resident Whisper (~1.5 GB) + Electron/Chromium (~1.5–2 GB) + macOS baseline (~8–10 GB) → `qwen3-vl:8b` fits comfortably; `qwen3-vl:30b`/`gemma3:27b` (20/17 GB) leave little headroom and risk swap. MEDIUM (hardware-dependent estimates).

**Recommended default:** ship `qwen3-vl:8b`, expose `qwen3-vl:30b` and `gemma3:4b`/`gemma3:12b` as user-selectable in settings. HIGH on tags/sizes/capabilities; MEDIUM on RAM/latency figures.

### STT Model (whisper.cpp / smart-whisper)

| Model | Disk | Profile | When to use |
|-------|------|---------|-------------|
| **`ggml-large-v3-turbo`** (Q5_0) ⭐ | ~1.0–1.6 GB | 809M params, near-large-v3 accuracy at ~4–8× realtime on Apple Silicon; the consensus best single choice for 2026 | **Default** for continuous listening |
| `ggml-small.en` / `ggml-base.en` | ~150–500 MB | Lower latency, English-only, lower accuracy | Latency-critical / English-only / low-RAM |
| Core ML encoder bundle (optional) | +~. | Offloads encoder to ANE (~15–20% faster on some workloads); ~10–15 min one-time conversion | macOS optimization once baseline works |

### CLI-Agent Backup Providers (BACKUP / escalation only — never per-pause)

| Provider | Invocation (headless, one-shot) | Notes |
|----------|--------------------------------|-------|
| **ClaudeProvider** | `claude -p "<prompt>" --output-format stream-json --verbose --include-partial-messages` (add `--allowedTools`/`--permission-mode` for unattended) | `-p/--print` = non-interactive; reads stdin, prints NDJSON deltas, exits. Reuses existing `claude` terminal login — **no API key stored by the app**. Spawn with `child_process.spawn`, parse NDJSON. |
| **CodexProvider** | `codex exec "<prompt>" -c model="gpt-5.x-codex" --sandbox read-only` | `codex exec` = non-interactive. Reuses existing Codex/ChatGPT login. Spawn + parse stdout. |

Prior art: `thunderock/forge` (`../forge`) launches these via **`node-pty`** with per-agent MCP config injection and command-basename detection (`isCodexCommand`, etc.). That PTY machinery is for *interactive* multi-agent orchestration; a **one-shot backup provider only needs plain `child_process.spawn`** (print/exec modes run fine without a TTY). Reach for `node-pty` **only** if a CLI refuses to run without a TTY. Image input via CLI is awkward/text-first (file-path references) — the **local VLM is the multimodal path**; CLI backups are text-first escalation. MEDIUM-HIGH (official Claude Code headless docs + forge source).

### Supporting Libraries

| Library | Version | Purpose | When to Use | CJS-safe? |
|---------|---------|---------|-------------|-----------|
| `openai` | 6.46.0 | OpenAI-compatible client for `LocalProvider` → Ollama `/v1` | Recommended transport | ✅ (ships `require` build) |
| `ollama` (ollama-js, official) | 0.6.3 | Native Ollama client: `chat`/`generate` (images as base64/Uint8Array, `stream:true`), **`pull` with progress events**, `ps` | Use its `pull()` for the first-run download progress UI; use for Ollama-specific calls (`/api/ps`, keep-alive) | ✅ (dual `import`/`require`) |
| `tree-kill` | 1.2.2 | Kill the Ollama/STT **process tree** on `app.will-quit` | Clean shutdown of spawned services | ✅ |
| `wait-on` | 9.0.10 | Wait for the health endpoint/port to become ready after spawn | Optional convenience vs. a hand-rolled fetch-retry loop; requires Node ≥ 20 | ✅ |
| `electron-ollama` | 0.1.25 | Turnkey Ollama sidecar: per-OS/arch binary pick, `isRunning()`, `serve()` (waits until ready), `stop()` (5 s graceful) | Optional accelerator if you'd rather not hand-roll spawn+health; **young (0.1.x, single maintainer)** — evaluate, don't hard-depend | ✅ |
| `node-pty` | 1.1.0 | PTY for CLI agents that demand a TTY | **Only** if `claude -p`/`codex exec` misbehave without a TTY; it's a native module (adds rebuild cost) | ✅ (native) |
| `@kutalia/whisper-node-addon` | latest | Prebuilt whisper.cpp `.node` binaries for Node **& Electron**, all platforms | Fallback if `smart-whisper` native build/ABI is painful in your Electron packaging | ✅ (native, prebuilt) |

**Zero-dependency alternative for the transport:** the existing `llm.service.js` already hand-rolls `https` requests **and** an SSE line-parser for Gemini. You can point that same machinery at `http://127.0.0.1:11434/v1/...` and delete nothing but the Gemini host — no new client dep at all. Prefer the `openai` SDK for cleanliness/runtime-swappability; keep built-in `fetch`/`https` as the zero-dep escape hatch (Electron's bundled Node has global `fetch`).

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| `@electron/rebuild` | Rebuild native addons (`smart-whisper`, `node-pty`) against Electron's ABI | Add to `setup-dev`; or use prebuilt-binary bindings to skip it |
| `ollama` CLI | Local dev: `ollama pull qwen3-vl:8b`, `ollama ps`, `ollama serve` | Devs install once; the app can also bundle/manage its own binary |
| Onboarding progress UI (existing pattern) | Stream `pull`/model-download progress | Mirror the existing `download-whisper-model` IPC + progress flow in `whisper-installer.js` |

---

## Model Cache & Download UX

**Ollama model cache (default):**
- macOS: `~/.ollama/models` · Windows: `C:\Users\%username%\.ollama\models` · Linux (service): `/usr/share/ollama/.ollama/models`
- Override with **`OLLAMA_MODELS`** — point it at an app-managed dir (e.g. `<userData>/models` or `~/.cache/opencluely/models`) so the app controls location and can report disk usage. HIGH (official FAQ).
- Bind/host: **`OLLAMA_HOST`** (default `127.0.0.1:11434`). Keep-resident: **`OLLAMA_KEEP_ALIVE=-1`** (or `keep_alive:-1` per request).

**Download UX:** trigger `ollama pull qwen3-vl:8b` on first run (or lazily on first inference). The official `ollama` npm `pull()` yields **progress events** — stream them to the onboarding/settings UI exactly like the current `WhisperInstaller` model-download progress. First pull of `qwen3-vl:8b` is ~6 GB (one-time). HIGH.

**Whisper model cache:** `smart-whisper`'s model manager downloads `ggml-*.bin` to its own dir; or reuse the existing **`<userData>/.whisper-models`** location (just store `ggml-large-v3-turbo` instead of the Python Whisper cache). Source of truth for weights: the `ggml-org/whisper.cpp` HF repo. MEDIUM.

**`~/.cache/huggingface`** is only relevant if you go the **MLX/transformers** route (mlx-vlm) — **not** used by the Ollama path. Note it only if you adopt an MLX alternative.

---

## Electron Service Supervision Pattern

Reuses the existing `child_process` patterns (`whisper-installer.js`) and the `app.on('will-quit')` teardown hook. No framework needed.

| Concern | Approach |
|---------|----------|
| **Already running?** | `fetch('http://127.0.0.1:11434/api/version')` (or `GET /` → `"Ollama is running"`); if it answers, **reuse it — don't spawn a second server.** HIGH on `/api/version`/root behavior. |
| **Spawn** | `child_process.spawn(ollamaBin, ['serve'], { env: { ...process.env, OLLAMA_MODELS, OLLAMA_HOST, OLLAMA_KEEP_ALIVE: '-1' } })`. Bundle the `ollama` binary per-platform as a packaged resource (sidecar), or detect a system install and fall back to prompting/auto-install (openwhispr-style). |
| **Port selection** | Ollama uses a **fixed** default port (11434); make it **configurable** and health-check it rather than allocating dynamically. Avoid `get-port` (ESM-only, breaks `require`) — if you truly need a free port, probe with `net.createServer().listen(0)`. |
| **Health / readiness** | Poll `/api/version` with backoff after spawn (or `wait-on`) before marking the service ready. |
| **Restart-on-crash** | Listen for `child.on('exit')`; restart with exponential backoff + jitter (the same shape `llm.service.js` already uses for Gemini retries). |
| **Shutdown on quit** | In `app.on('will-quit')`, `tree-kill(child.pid)` (Ollama can spawn model-runner subprocesses; a plain `child.kill()` can orphan them). If using `electron-ollama`, call `getServer()?.stop()`. |
| **STT lifecycle** | With `smart-whisper` (in-process) there's **no separate process to supervise** — just `free()` the model on quit. If you instead run `whisper-server`, supervise it identically to Ollama (spawn `-m <model> --host 127.0.0.1 --port <p>`, health-check, `tree-kill` on quit). |

`electron-ollama` (0.1.25) packages this exact lifecycle (`isRunning()` / `serve()` / `stop()`, per-OS/arch binary pick, runtime binary download). Good accelerator; its 0.1.x/single-maintainer status argues for keeping the DIY path as the primary and treating the lib as optional. MEDIUM.

---

## Installation

```bash
# --- App runtime deps (all CommonJS-compatible) ---
npm install openai ollama tree-kill wait-on
# STT (native addon over whisper.cpp) — pick ONE embedding strategy:
npm install smart-whisper                 # in-process resident model (recommended)
#   or, if native build is painful in your Electron packaging:
# npm install @kutalia/whisper-node-addon  # prebuilt .node binaries incl. Electron
# Optional: turnkey Ollama sidecar/supervisor
# npm install electron-ollama
# Optional: only if a CLI agent needs a TTY
# npm install node-pty

# --- Dev deps ---
npm install -D @electron/rebuild
npx electron-rebuild   # rebuild smart-whisper/node-pty against Electron's ABI

# --- Local runtime + models (dev machine) ---
# Install Ollama (or bundle the binary as a sidecar for shipped builds)
ollama pull qwen3-vl:8b        # primary VLM (~6 GB)
ollama pull gemma3:4b          # light alternative (~3.3 GB)
# Whisper model auto-downloads via smart-whisper's model manager (large-v3-turbo)

# --- CLI backup providers (reuse existing terminal auth; no app keys) ---
# `claude` and `codex` are expected to already be installed & logged in by the user.

# --- REMOVE (Gemini/Azure exit) ---
npm uninstall @google/genai microsoft-cognitiveservices-speech-sdk
```

---

## Alternatives Considered

| Recommended | Alternative | When to Use the Alternative |
|-------------|-------------|-----------------------------|
| **Ollama** | **llama.cpp `llama-server`** | You want a **single self-built binary** with zero background daemon and full control of `--mmproj`/quant. Supports OpenAI `/chat/completions` with image/audio/video. **Cost:** you manage model + `mmproj` files and download UX yourself (no `ollama pull` catalog). Good "power-user" path if Ollama's daemon model or bundle size becomes a problem. |
| **Ollama** | **mlx-vlm** (`Blaizzy/mlx-vlm`) or **vllm-metal** | You want **maximum Apple-Silicon vision throughput** and are macOS-only. `mlx-vlm` has a FastAPI OpenAI-compatible server (Qwen2-VL, Pixtral, etc.). **Cost:** Python dependency, **macOS-only (breaks the Win/Linux build)**, weaker auto-download UX. Note: Ollama 0.19 already uses MLX under the hood on Apple Silicon, shrinking this gap. |
| **Ollama** | **LM Studio (headless `lms`)** | You're doing **manual local dev** and like its MLX vision engine + GUI. **Not for shipping**: it's a proprietary GUI app you can't redistribute/bundle as a dependency; users must install LM Studio separately. |
| **`qwen3-vl:8b`** | **`gemma3:12b`** / **`minicpm-v`** | Prefer Google lineage / smaller footprint (`gemma3`), or OCR-first small model (`minicpm-v`). |
| **`qwen3-vl:8b`** | **`qwen3-vl:30b` / `:32b`** | Quality matters more than headroom **and** RAM ≥ 36 GB (or willing to close other apps). |
| **whisper.cpp / smart-whisper** | **whisper.cpp `whisper-server`** (separate process) | You want **crash isolation** (STT out of the Electron process) and to supervise STT exactly like Ollama. Resident model, `/inference` multipart endpoint (not OpenAI-shaped, but you don't need OpenAI-compat for STT). |
| **whisper.cpp** | **macOS-native `SpeechAnalyzer`/`SpeechTranscriber`** (macOS 26+) | **Fastest + most accurate on macOS**: on-device, streaming **partial** results, ~2× faster than Whisper large-v3-turbo, 3.5–4× lower WER, **zero model download**. **Cost:** macOS 26+ only, **no HTTP server** (spawn a small **Swift helper** binary and talk over stdio/socket), doesn't help Win/Linux. Strong **macOS-only fast-path** to layer on after the portable whisper.cpp baseline works. |
| **`openai` SDK** | Built-in `fetch`/`https` (zero-dep) | You'd rather add no dependency and reuse the existing hand-rolled SSE parser in `llm.service.js` pointed at localhost. |

---

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| **`@google/genai` (Gemini)** & **`microsoft-cognitiveservices-speech-sdk` (Azure)** | The whole point of the milestone is local-first; Azure SDK also drags a ~380-line browser-DOM polyfill into the main process | Ollama (`LocalProvider`) + whisper.cpp; Claude/Codex CLI as backup |
| **faster-whisper / whisperX / CTranslate2** on Apple Silicon | **No Metal/GPU on Apple Silicon — CPU-only** via Accelerate; Python dependency; whisperX adds alignment/diarization you don't need and isn't a streaming server | whisper.cpp (Metal + Core ML, no Python) |
| **distil-whisper** | It's a *model*, not a server; English-leaning; `large-v3-turbo` largely supersedes its speed/quality tradeoff | `ggml-large-v3-turbo` (Q5) via whisper.cpp |
| **vanilla vLLM** (non-Metal) | Built for datacenter CUDA; on Mac it needs the `vllm-metal` plugin which is Docker/server-oriented and heavy for a single-user desktop | Ollama (has MLX backend) |
| **LM Studio as the *bundled* runtime** | Proprietary GUI app; can't be embedded/redistributed as a dependency; forces a separate user install | Ollama (bundleable single binary) |
| **Legacy VLM tags: `llava`, `llama3.2-vision`, `qwen2.5-vl`** | Superseded in 2026 by `qwen3-vl`/`gemma3` on quality (esp. OCR/UI/documents) | `qwen3-vl:8b` / `gemma3` |
| **`moondream`** as the main model | Too small/limited for reliable screen + document understanding | `qwen3-vl:4b` minimum; `moondream` only for ultra-low-RAM toy mode |
| **`get-port@7`, `execa@9`, `node-fetch@3`** | **ESM-only** — cannot be `require()`d in this CommonJS app (verified: `"type":"module"`) | `net.createServer` port probe / `node:child_process` / built-in global `fetch`. If you must, pin `get-port@5.1.1` / `execa@5` (last CJS majors). |
| **Ollama Image-URL parts** | Ollama's OpenAI-compat accepts **base64 data URLs only**, not remote `image_url` refs | Base64-encode the (downscaled) screenshot into the `image_url` data URL — the app already base64-encodes PNGs for Gemini |
| **`node-pty` for the backup providers by default** | Native module (rebuild cost) you don't need for headless `claude -p`/`codex exec` | Plain `child_process.spawn`; add `node-pty` only if a CLI demands a TTY |

---

## Stack Patterns by Variant

**If Apple Silicon, 32 GB (primary target):**
- Ollama + `qwen3-vl:8b` (leaves headroom for KV cache, resident Whisper, Electron, OS). `OLLAMA_KEEP_ALIVE=-1`.
- `smart-whisper` + `ggml-large-v3-turbo`. Optionally add the Core ML encoder later.
- **Do not** default to `qwen3-vl:30b`/`gemma3:27b` here — 17–20 GB weights + everything else risks swap.

**If Apple Silicon, ≥ 36–48 GB:**
- Promote default to `qwen3-vl:30b` (MoE, fast decode) for noticeably better answers; keep `:8b` as the low-latency option.
- Ollama 0.19+ MLX path is fully in play (MLX preview requires **>32 GB**).

**If macOS 26+ and you want peak STT:**
- Add a **`SpeechAnalyzer` Swift helper** as a macOS-only STT provider (streaming partials, no model download); keep whisper.cpp as the cross-platform default and non-macOS-26 fallback.

**If Windows / Linux (keep-building requirement):**
- Same Ollama + `qwen3-vl` path (Ollama is cross-platform). Vision runs via Metal-equivalent GPU or CPU.
- whisper.cpp via `smart-whisper`/prebuilt bindings still applies (CUDA/CPU). SpeechAnalyzer is **not** available — whisper.cpp is the only STT here.

**If you outgrow Ollama (bundle size / daemon model):**
- Switch `LocalProvider.baseURL` to a self-managed `llama-server` (`-m model.gguf --mmproj mmproj.gguf`) — same OpenAI-compatible code path, you just own model/download management.

---

## Version Compatibility

| Item | Constraint / Note |
|------|-------------------|
| **CommonJS `require` compatibility** | ✅ CJS-safe (verified via npm registry): `openai@6.46.0`, `ollama@0.6.3` (dual), `electron-ollama@0.1.25`, `wait-on@9.0.10`, `tree-kill@1.2.2`. ❌ **ESM-only** (`"type":"module"`, will throw on `require`): `get-port@7.2.0`, `execa@9.6.1`. |
| **Ollama MLX backend** | Preview since **0.19** (Mar 2026); requires **>32 GB** unified memory for the MLX path (exactly 32 GB is borderline — Metal/GGML path still serves vision). MLX-backend *vision* support not explicitly confirmed in the announcement → vision is safe via the standard multimodal engine regardless. MEDIUM. |
| **Node / Electron** | `ollama-js` targets Node ≥ 20; `wait-on@9` needs Node ≥ 20. Existing app runs Electron 29 (Node 20-class). Electron is several majors behind (see `CONCERNS.md`) — **native addons (`smart-whisper`, `node-pty`) must be rebuilt against Electron's ABI** (`@electron/rebuild`) and re-tested on each Electron bump. |
| **whisper.cpp** | v1.9.1 (Jun 2026). Core ML encoder needs a one-time model conversion; Metal works out of the box on Apple Silicon. |
| **Ollama OpenAI-compat surface** | `/v1/chat/completions`, `/v1/completions`, `/v1/models`, `/v1/embeddings`; `stream:true` supported; images = **base64 data URL** parts; `apiKey` required-but-ignored (`'ollama'`). HIGH. |
| **`ollama pull` catalog freshness** | Tags/sizes (`qwen3-vl:{2b,4b,8b,30b,32b}`, `gemma3:{1b,4b,12b,27b}`) verified on ollama.com library pages 2026-07-13; the catalog evolves — re-check exact tags at build time. |

---

## Sources

- **Ollama OpenAI compatibility** — https://docs.ollama.com/api/openai-compatibility — endpoints, base64 image parts, `stream:true`, `apiKey:'ollama'`, `qwen3-vl:8b` vision example. HIGH.
- **Ollama FAQ** — https://docs.ollama.com/faq — `OLLAMA_MODELS` default paths, `OLLAMA_KEEP_ALIVE=-1`, `OLLAMA_HOST` default `127.0.0.1:11434`, `keep_alive:-1`. HIGH.
- **Ollama MLX blog** — https://ollama.com/blog/mlx — MLX on Apple Silicon since **0.19** (Mar 30 2026), requires >32 GB, prefill 1154→1810 tok/s, decode 58→112 tok/s. HIGH.
- **Ollama Qwen3-VL blog** — https://ollama.com/blog/qwen3-vl (Oct 14 2025) + **library page** https://ollama.com/library/qwen3-vl — local tags 2b/4b/8b/30b/32b/235b, 256K→1M ctx, OCR (32 langs), UI/"visual agent", document/chart understanding. HIGH.
- **Ollama Gemma3 library** — https://ollama.com/library/gemma3 — 1b (text) / 4b·12b·27b (multimodal), 128K ctx, sizes. HIGH.
- **Ollama vision search** — https://ollama.com/search?c=vision — vision-model catalog (some newer tags unverifiable via fetch — treated cautiously). MEDIUM.
- **whisper.cpp** — https://github.com/ggml-org/whisper.cpp (v1.9.1, Jun 19 2026) + server README — Metal + Core ML (ANE ~3×), `whisper-server` `/inference` (multipart, resident model, `--host/--port`), `stream` example. HIGH.
- **faster-whisper Apple Silicon** — https://github.com/SYSTRAN/faster-whisper/issues/515 + comparison articles — CTranslate2 has **no Metal/MPS**; CPU-only on Apple Silicon; whisper.cpp is the Metal-accelerated choice. MEDIUM-HIGH.
- **smart-whisper** — https://github.com/JacobLinCool/smart-whisper — native Node addon over whisper.cpp: load-once resident model, parallel inference, auto model manager, Win/macOS/Linux, macOS GPU accel. MEDIUM (single maintainer). Prebuilt Electron binaries: https://github.com/Kutalia/whisper-node-addon. MEDIUM.
- **whisper large-v3-turbo** — model-size guides (2026) — 809M params, ~1.6 GB, near-large-v3 accuracy at ~4–8× realtime, best single choice on Apple Silicon; Q5_0 ~40% smaller. MEDIUM.
- **macOS SpeechAnalyzer** — https://developer.apple.com/documentation/speech/speechanalyzer + MacStories/benchmark writeups — macOS 26+, on-device, streaming partials, ~2× faster than Whisper large-v3-turbo, WER 9.02%→2.12% clean, on-device-only (no server path). MEDIUM (Apple docs HIGH; benchmark figures MEDIUM).
- **mlx-vlm / vllm-metal** — https://github.com/Blaizzy/mlx-vlm , https://github.com/vllm-project/vllm-metal — OpenAI-compatible Apple-Silicon VLM serving (Python/Docker; macOS-only). MEDIUM.
- **LM Studio headless** — https://lmstudio.ai/docs/developer/core/headless — `lms` CLI daemon, OpenAI/Anthropic-compatible, MLX engine; proprietary GUI app. MEDIUM.
- **llama.cpp multimodal** — https://github.com/ggml-org/llama.cpp/blob/master/docs/multimodal.md + tools/server/README — `llama-server` OpenAI `/chat/completions` with `--mmproj`, image/audio/video. HIGH.
- **electron-ollama** — https://github.com/antarasi/electron-ollama (0.1.25) — per-OS/arch binary pick, `isRunning()`, `serve()`, `stop()` (5 s graceful), runtime binary download. MEDIUM.
- **Claude Code headless** — https://code.claude.com/docs/en/headless — `claude -p`, `--output-format stream-json` (needs `--verbose`; deltas need `--include-partial-messages`), `--allowedTools`/`--permission-mode`, stdin piping. MEDIUM-HIGH.
- **Codex CLI** — `codex exec ... -c model=... --sandbox read-only` non-interactive (community + forge source). MEDIUM.
- **forge (local prior art)** — `/Users/ashutosh/personal/forge/electron/mcp/agent-args.ts`, `electron/ipc/register.ts` — PTY-based agent launch, command-basename detection, per-agent MCP config. HIGH (read directly).
- **npm registry** (versions + module type, fetched 2026-07-13) — `openai@6.46.0` (cjs), `ollama@0.6.3` (dual), `electron-ollama@0.1.25` (cjs), `wait-on@9.0.10` (cjs), `tree-kill@1.2.2` (cjs), `get-port@7.2.0` (**esm**), `execa@9.6.1` (**esm**), `node-pty@1.1.0`. HIGH.

---
*Stack research for: local-first multimodal Electron copilot (Apple Silicon 32 GB+)*
*Researched: 2026-07-13*
