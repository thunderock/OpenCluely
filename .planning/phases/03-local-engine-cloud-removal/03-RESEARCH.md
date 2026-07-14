# Phase 3: Local Engine + Cloud Removal - Research

**Researched:** 2026-07-14
**Domain:** Local-first multimodal LLM serving (Ollama `qwen3-vl:8b` over OpenAI-compatible `/v1`) behind the Phase 2 `LLMProvider` seam; adopt/own service lifecycle; general-purpose prompt system; gated cloud (Gemini + Azure) removal — Electron 29, CommonJS, vanilla JS, Apple Silicon 32 GB primary.
**Confidence:** HIGH on transport/request-shape/lifecycle/Azure-scope/GEN-01 (verified against live code + official Ollama docs); MEDIUM on empirical TTFT/memory numbers (hardware-dependent — the point of the flag-1 smoke is to measure on the actual machine).

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions (do not re-litigate; research THESE, no alternatives)

**From the domain / Locked section:**
- **Runtime:** Ollama ≥ 0.19. **Model:** `qwen3-vl:8b` default. **Endpoint:** `127.0.0.1:11434/v1`, OpenAI-compatible. **Resident:** `keep_alive:-1`.
- **Lifecycle:** adopt-if-present / own-if-started — **never kill an Ollama daemon it did not start** — via the Phase 1 `ServiceSupervisor`. **Cache:** Ollama default (`~/.ollama/models`), not `~/.cache`.
- **Multimodal-direct:** screenshot goes straight to the VLM, **no OCR step**.
- **Sequencing (load-bearing):** abstraction first → **Local proven** → cloud removed **last** (never removal-first — Pitfall 12).
- **Local is the default** provider; **bounded md-context, no RAG**.
- **Keep the `OpenCluely` name** (reposition messaging only).
- **CommonJS + vanilla JS**, no bundler / TypeScript / framework; match existing conventions (incl. the `assests/` misspelling).
- **`LLMProvider` seam is fixed:** `LocalProvider` implements the same 4 methods and slots into the registry (`src/services/providers/`). **`RequestBuilder` owns prompt assembly**; the provider only **serializes** the neutral struct to its wire format — **no prompt logic in the provider** (mirror `GeminiProvider.serialize()`).
- **Logging:** `require('./core/logger').createServiceLogger('<TAG>')`; never interpolate variable data into the message. **Error philosophy:** degrade gracefully, never crash.
- **Tests:** Node's built-in `node:test` / `node --test`; no new framework.

**First-run model setup (locked):**
- **Ollama provisioning = guide the user to install** (openwhispr-style link/instructions). Do **not** bundle the Ollama binary this phase.
- **Model pull timing = auto-pull on first launch** (`qwen3-vl:8b`, ~6 GB) up front so the app is answer-ready.
- **Progress + status UI = both onboarding AND settings.** Settings gets a **"Model"** section with a **re-download / repair** action. Reuse `whisper-installer.js` `download-*-model` IPC + progress flow.
- **Preflight check + warn** on free disk (~6 GB+) and unified memory; friendly failure, then proceed.

**Cloud-removal gate (locked):**
- **"Proven" = functional + a latency/memory smoke.** All 3 on-demand entry points work locally in the overlay (text streaming, screenshot answer, a general non-coding question), **plus** a rough TTFT + memory-under-ceiling check on a representative prompt (simulate the md-notes budget). **Full** sustained-load validation is deferred to Phase 6.
- **Deletion is a HARD MANUAL CHECKPOINT.** The phase **pauses** after Local is proven; the user personally verifies and **approves** the irreversible Gemini + Azure deletion as a **separate, clearly-labeled plan/commit**. Do not auto-delete on criteria pass.
- **Post-removal Local-down UX = error + one-click recovery** ("Local model unavailable" → restart Ollama / re-pull / open settings).
- **Keep STT working throughout (Azure timing).** Remove the **Gemini LLM path + the Azure browser-DOM polyfill** now; if Azure also powers **STT**, **defer that specific removal** (or ensure the existing Python-Whisper path still works) until **Phase 4**. ⚠ Researcher must first CONFIRM what Azure actually powers before scoping the deletion.

**Provider & model settings (locked):**
- **Model list = curated + "advanced: any installed"** (`qwen3-vl:8b` default, `qwen3-vl:30b`, `gemma3:4b`/`gemma3:12b`; advanced = any installed, query `ollama list` / `/v1/models`).
- **Keep a minimal provider switcher** (just Local after Gemini removal, so Phase 7 slots CLI providers with no UI rework).
- **Per-provider config blocks** (Local owns host/model/keep_alive).
- **Transition window = Local default, Gemini selectable until deleted.**

**General-purpose default & skills — GEN-01 (locked):**
- **Default answer style = concise reply-suggester** (short, ready-to-say suggestions; expands when explicitly asked).
- **Skill switch = settings picker, default = General.** Reuse `prompt-loader.js` skill-from-markdown with minimal change. (In-overlay toggle/hotkey NOT chosen.)
- **Coding overlay: keep the machinery as-is, but broaden its scope** (DSA-specific → general-purpose coding).
- **Initial skill set = General (default) + Coding.** Two skills, no interview branding.

**Positioning (locked):** reposition messaging → *"a private, always-on copilot that watches your screen + hears the conversation and helps with anything"* (auto-reply suggester, general — not interview/DSA). KEEP the `OpenCluely` name. Functional scrub (GEN-01) this phase; copy/branding scrub spans README (P8) + website (P9).

### Claude's Discretion (research options, recommend)
- Exact module paths/names (`local.provider.js` in `src/services/providers/`; a `LocalModelManager` in `src/core/` or `src/services/`).
- **Transport:** `openai` npm SDK vs. reusing the hand-rolled `https`+SSE parser — a research call (see Flag 5).
- Health-check / readiness mechanics (`/api/version` poll + backoff), tree-kill on quit, how the manager reports "adopted vs owned".
- Preflight thresholds, exact settings-UI layout, concrete config key names for per-provider blocks.
- The concrete default General system prompt (draft for review during planning).

### Deferred Ideas (OUT OF SCOPE — do not pull in)
- Rename the product — **declined**; keep `OpenCluely`.
- Interview skill overlay — **declined for v1**.
- Bundle the Ollama binary as a sidecar — deferred to **Phase 8**.
- Quick in-overlay skill toggle / hotkey — settings picker only this phase.
- Mode-aware verbosity (terse vs. full) — **Phase 6**.
- **Full sustained-load TTFT/memory validation** (session-end + minute-45 pressure, full md-notes) — **Phase 6**; only a rough smoke here.
- Also out of scope (from ROADMAP): resident STT engine (Phase 4), continuous capture + md-context source + DOMPurify/TCC/IPC-scoping (Phase 5), pause orchestrator / relevance gate (Phase 6), CLI backup providers (Phase 7), DMG CI (Phase 8), website (Phase 9). **The `RequestBuilder` md-context input exists but stays empty/unused until Phase 5.**
</user_constraints>

## Summary

Phase 3 is well-scoped and low-risk because Phases 1–2 already built the exact seams it plugs into. The **`ServiceSupervisor`** (`src/core/service-supervisor.js`) already implements adopt-if-present / own-if-started with a health probe, backoff, and "never kill an adopted process" — its own header comment even pre-specifies the Phase-3 Ollama config (`{ healthCheck: { type: 'http', port: 11434, path: '/' }, adopt: true }`). The **`RequestBuilder`** (`src/core/request-builder.js`) already emits a neutral struct carrying base64 images as `images: [{ data, mimeType }]`. The **provider registry + thin `llm.service` facade** already resolve a selected provider and re-export it as the singleton every `main.js` call-site uses. So `LocalProvider` is a *sibling* of `GeminiProvider` that mirrors its full public method surface, and `LocalModelManager` is the *first real consumer* of the supervisor.

**The Azure scope question (Flag 4) resolves cleanly and it changes the removal plan:** Azure is **STT-only** (`microsoft-cognitiveservices-speech-sdk`, one of two speech providers), **not** an LLM path. The "Azure browser-DOM polyfill" is the ~380-line `global.window`/`document`/`AudioContext` block at the **top of `src/services/speech.service.js` (lines 1–~380)** whose *only* purpose is to let the browser-oriented Azure Speech SDK load under Node. Removing that polyfill **is** removing Azure STT — they are inseparable. Therefore, honoring the higher-priority locked decision "keep STT working throughout," **Phase 3 removes Gemini entirely and leaves the Azure SDK + its polyfill in place**; the Azure STT removal is **deferred to Phase 4** when the resident whisper.cpp engine replaces the whole STT layer. This overrides ROADMAP SC5's literal "remove the Azure browser-DOM polyfill" wording, exactly as Flag 4 anticipated.

The remaining work is mechanical and prescriptive: pick the **`openai` npm SDK** for the `LocalProvider` transport (native OpenAI SSE + multimodal + `baseURL` portability; the existing hand-rolled parser is Gemini-shaped and would have to be rewritten anyway), use the **official `ollama` npm client** for lifecycle (`pull()` progress, `ps()`, adopt-probe), neutralize the one hardcoded interview string (`request-builder.js:35`) plus add a `general.md` skill for GEN-01, restructure config into per-provider blocks, and gate the irreversible Gemini deletion behind a manual checkpoint.

**Primary recommendation:** `LocalProvider` (mirrors `GeminiProvider`'s public surface, `serialize()` → OpenAI `messages` with `image_url` data-URL parts, streams via `openai` SDK) + `LocalModelManager` (owns Ollama through the existing `ServiceSupervisor`, pulls `qwen3-vl:8b` via `ollama` npm `pull()` progress reusing the `download-*-model` IPC) + GEN-01 prompt generalization → prove with a scripted TTFT/memory smoke → **then** delete Gemini only (defer Azure STT to Phase 4) behind a hard manual checkpoint.

---

## Research Flag Findings (implementation-ready)

### Flag 4 — ⚠ CONFIRM WHAT AZURE POWERS (gates scope; do this FIRST) — RESOLVED

**Finding (HIGH confidence, from live code + `INTEGRATIONS.md` + `CONCERNS.md`):**

| Question | Answer |
|----------|--------|
| Does Azure power the **LLM**? | **No.** Gemini (`@google/genai`) is the *only* LLM. `grep` for azure returns zero hits in any LLM path. |
| Does Azure power **STT/voice**? | **Yes — STT only.** `microsoft-cognitiveservices-speech-sdk` (`^1.40.0`) is one of **two** speech providers (Azure cloud vs. local Python Whisper), selected by `SPEECH_PROVIDER`. Requires `AZURE_SPEECH_KEY` + `AZURE_SPEECH_REGION`; if either is missing, `_getConfiguredProvider()` silently falls back to `whisper`. |
| What is the "Azure browser-DOM polyfill"? | The `if (typeof window === 'undefined') { global.window = {...} }` block at **`src/services/speech.service.js:1`–~380** (fake `navigator`/`document`/`AudioContext`/`Blob`/`location`). It exists **solely** so the browser-targeted Azure Speech SDK can `require()` under Node in the main process. It loads **unconditionally at module import** (not gated on Azure being selected). |
| Is the polyfill separable from Azure STT? | **No.** The polyfill has no other consumer. Deleting it breaks the Azure STT path; deleting Azure STT makes the polyfill dead. They are one unit. |
| Is Azure the default STT? | **No.** Default is local Python Whisper. `config.js:60` sets a **dead** `speech.provider: 'azure'` that `_getConfiguredProvider()` never reads (it reads `SPEECH_PROVIDER`, defaults `whisper`). Most users have Azure unconfigured. |

**Scope decision for the planner (this overrides ROADMAP SC5's literal wording):**

- **SAFE to delete in Phase 3 (the Gemini LLM path, entirely):**
  - `package.json`: `@google/genai` dependency.
  - `src/services/providers/gemini.provider.js` (the whole file, incl. `configureNetworkSession` = the cert-verify bypass + User-Agent override; `generativelanguage.googleapis.com` hardcoded hosts live here now, relocated in Phase 2).
  - `main.js`: the Gemini IPC handlers `set-gemini-api-key` (605/583), `get-gemini-status` (588), `test-gemini-connection` (618), `run-gemini-diagnostics` (622); the `configureNetworkSession` call site is already a no-op guard (`main.js:289–297` — see below).
  - `preload.js:34–37`: `setGeminiApiKey`, `getGeminiStatus`, `testGeminiConnection`.
  - `src/ui/main-window.js:1004–1096`: the orphaned Gemini-config modal (`showGeminiConfig`/`createGeminiConfigModal`/`configureGemini`) + `preload.js:112` `onOpenGeminiConfig`.
  - `src/core/config.js:41–57`: the `llm.gemini` block (after the config restructure below).
  - `test/gemini-request-parity.test.js` + `test/fixtures/gemini-requests/*` + `scripts/capture-gemini-goldens.js` (Gemini goldens; they also embed the interview prompt that GEN-01 changes).
  - The `gemini.provider.js:1193` behavioral keyword list ("interview") vanishes with the file.
- **MUST DEFER to Phase 4 (the Azure STT path — keep voice working):**
  - `package.json`: `microsoft-cognitiveservices-speech-sdk` — **keep**.
  - `src/services/speech.service.js:1–~380` polyfill + `_initializeAzureClient`/`_startAzureRecording` — **keep**.
  - `main.js` Azure settings plumbing (`azureKey`/`azureRegion`/`SPEECH_PROVIDER` in `getSettings`/`saveSettings`, ~1481–1533) — **keep**.
  - Azure UI in `settings.html`/`onboarding.html`/`settings-window.js` — **keep** (it's STT config).
- **Rationale:** The locked decision "keep STT working throughout" is higher priority than SC5's literal "Azure browser-DOM polyfill" line. Phase 4 replaces Python-Whisper **and** Azure STT with resident whisper.cpp, at which point the SDK + polyfill + Python Whisper are deleted together. Note this explicitly in PROV-07's plan so the planner does not attempt the polyfill removal in Phase 3.

**One clean-up win available now (already done in Phase 2):** `main.js:289–297` `setupNetworkConfiguration()` already delegates to `provider.configureNetworkSession(ses)` and guards on the method existing. When Gemini is removed, `LocalProvider` simply won't define that method, so the cert-bypass disappears with **zero dead global startup code** — no edit to `setupNetworkConfiguration` needed beyond confirming LocalProvider omits the method.

---

### Flag 2 — EXACT MULTIMODAL REQUEST SHAPE for Ollama `/v1/chat/completions` — CONFIRMED

**Finding (HIGH confidence — official Ollama OpenAI-compat docs + corroborating sources):** Ollama's OpenAI-compatible endpoint accepts the **OpenAI-standard nested `image_url` object** with a **base64 data-URL** (not a remote URL, not a bare string). Ollama extracts the base64 into its internal `images` slice.

```jsonc
// One user message with text + image, OpenAI /v1 shape:
{
  "role": "user",
  "content": [
    { "type": "text", "text": "Analyze this screenshot and answer the question." },
    { "type": "image_url",
      "image_url": { "url": "data:image/png;base64,iVBORw0KGgoAAA..." } }
  ]
}
```

- `image_url` MUST be the object `{ "url": "data:<mime>;base64,<b64>" }`. (One doc excerpt rendered it as a bare string; the authoritative + corroborating sources and the OpenAI standard use the nested object — use the object. The `openai` npm SDK builds this form for you.)
- Multiple images = multiple `image_url` parts in the same message's `content` array.
- Streaming: `stream: true` → SSE chunks in standard OpenAI shape; incremental text at `choices[0].delta.content`; terminated by `data: [DONE]`. Timing/usage arrive in the final chunk.
- `apiKey`: required-but-ignored; use the literal `'ollama'`.

**How the neutral struct serializes (`LocalProvider.serialize()` — mirror `GeminiProvider.serialize()` at `gemini.provider.js:142`):** The `RequestBuilder` neutral struct is:
```js
{ kind, skill, systemPrompt, userText, images: [{ data /*base64*/, mimeType }], history: [{ role:'user'|'model', content }], mdContext }
```
Map it to OpenAI `messages`:
```js
// src/services/providers/local.provider.js
serialize(neutral) {
  const messages = [];
  // system: skill/general prompt + (Phase 5) mdContext prefix. Keep mdContext appended
  // to the system message as a fixed, position-stable prefix (KV-reuse friendly).
  const sys = [neutral.systemPrompt, neutral.mdContext].filter(Boolean).join('\n\n');
  if (sys) messages.push({ role: 'system', content: sys });
  // history: neutral 'model' role → OpenAI 'assistant'
  for (const h of neutral.history) {
    messages.push({ role: h.role === 'model' ? 'assistant' : 'user', content: h.content });
  }
  // final user turn: text + optional image parts
  if (neutral.images && neutral.images.length) {
    messages.push({ role: 'user', content: [
      { type: 'text', text: neutral.userText },
      ...neutral.images.map(i => ({
        type: 'image_url',
        image_url: { url: `data:${i.mimeType};base64,${i.data}` }
      }))
    ]});
  } else {
    messages.push({ role: 'user', content: neutral.userText });
  }
  return { model: this.model, messages, stream: true /* set per call */ };
}
```
Note the neutral→OpenAI role rename: neutral uses `'model'` (Gemini's word); OpenAI uses `'assistant'`. That single rename is the only semantic difference in history handling. `mdContext` is empty until Phase 5 but wire it into the system prefix now so no rework later.

---

### Flag 5 — TRANSPORT CHOICE — RECOMMEND: `openai` npm SDK (inference) + `ollama` npm (lifecycle)

**Recommendation (HIGH confidence):** Use **two thin, CJS-safe dependencies**, split by concern:
- **`openai` (v6.x)** for `LocalProvider` *inference* — `baseURL: 'http://127.0.0.1:11434/v1'`, `apiKey: 'ollama'`.
- **`ollama` (ollama-js, v0.6.x, official)** for `LocalModelManager` *lifecycle* — `pull()` progress, `ps()`, `list()`, adopt-probe (`/api/version`).

**Why `openai` SDK over reusing the hand-rolled `https`+SSE parser (the discretion call):**

| Criterion | `openai` SDK | Reuse existing hand-rolled `https`+SSE |
|-----------|--------------|----------------------------------------|
| SSE parsing | Native async-iterable of OpenAI chunks (`chunk.choices[0].delta.content`), `[DONE]` handled | Existing parser is **Gemini-shaped** (`candidates[].content.parts[].text`) — would need a **full rewrite** for OpenAI deltas. No real reuse. |
| Multimodal | Content-array with `image_url` object built for you | Hand-assemble JSON body + base64 data URL yourself |
| Runtime portability | Swap `baseURL` → llama-server / LM Studio / mlx-vlm later, zero code change (matches STACK.md "if you outgrow Ollama") | Locked to bespoke request code |
| Error/timeout/abort | Built-in | Re-implement |
| CJS-safe? | ✅ ships a `require` build (`openai@6.x`); `const OpenAI = require('openai')` | ✅ (built-in `https`) |
| Dependency weight | One well-maintained lib | Zero new dep (only upside) |

The "reuse the existing SSE parser" option's *only* advantage is adding no dependency, but because the existing parser is Gemini-specific you'd be writing a new OpenAI parser regardless — so you pay the complexity without the reuse. The `openai` SDK is the clean choice and directly honors the locked "OpenAI-compatible `/v1`" decision.

**Why also `ollama` npm (not openai SDK alone):** The openai `/v1` surface does **not** expose model management. `pull()` with progress events, `ps()` (resident-memory check for the smoke), and `list()` (advanced "any installed" model picker) are Ollama-native (`/api/*`). `ollama-js` gives these in one CJS-safe lib. (Alternative single-dep path: use `ollama-js` for *both* inference and lifecycle — it has `chat({ messages, images, stream })` with base64-string images and `pull()`. Viable and drops the openai dep, but loses the `baseURL`-swap portability and the standard OpenAI shape the roadmap is built around. **Recommend the two-lib split.**)

**CJS / ESM guardrails (locked constraint — verified):** `openai@6.x` and `ollama@0.6.x` are `require()`-safe. **Do NOT** add `get-port@7` / `execa@9` / `node-fetch@3` — all ESM-only, throw on `require`. For lifecycle plumbing use `node:child_process` (`spawn`), the built-in global `fetch` (Electron 29 has it), and `net.createServer().listen(0)` if a free-port probe is ever needed (not needed — Ollama's port is the fixed 11434). This matches how `service-supervisor.js` already probes (`net`/`http`, no external dep).

**Install:**
```bash
npm install openai ollama
# Phase 3 removal step (AFTER proven, at the manual checkpoint):
npm uninstall @google/genai      # Gemini LLM SDK — remove
# DO NOT uninstall microsoft-cognitiveservices-speech-sdk this phase (Azure STT → Phase 4)
```

---

### Flag 3 — OLLAMA ADOPT/OWN LIFECYCLE via the Phase 1 `ServiceSupervisor` — MAPPED

**Finding (HIGH confidence — read `src/core/service-supervisor.js` directly):** The supervisor already implements everything Flag 3 asks for. `LocalModelManager` is a thin configurator over it. Real API (verbatim from the source):

- `new ServiceSupervisor(definition, options)` where `definition = { name, command, args, cwd?, env?, healthCheck, backoff, startupTimeoutMs?, healthPollMs?, adopt?, pidFile?, terminate? }` and `options = { spawn?, logger? }` (the `spawn` is a **DI seam** for tests).
- `healthCheck = { type: 'http'|'port', host?, port, path?, timeoutMs? }`.
- `backoff = { initialDelayMs, multiplier, maxDelayMs, maxRetries }`.
- `async start()` → if `adopt` and the probe already passes, sets `owned=false`, state `'adopted'`, returns (does NOT spawn). Else `_attemptStart()` spawns, sets `owned=true`, health-polls to `startupTimeoutMs`, then attaches a crash monitor that restarts with capped exponential backoff; after `maxRetries` → state `'failed'` (surfaces, never crashes/hangs).
- `async stop()` → **NEVER kills** an adopted/foreign process or an already-exited child; only SIGTERM→(grace)→SIGKILL a child it owns; clears `pidFile`.
- `getStatus()` → `{ name, state, attempt, pid, owned }`. Emits `'status'` events. `state ∈ idle|starting|healthy|restarting|failed|stopped|adopted`.

**Exact Ollama config (from the supervisor's own header comment — use it verbatim):**
```js
// LocalModelManager builds this and hands it to ServiceSupervisor:
const def = {
  name: 'ollama',
  command: ollamaBinPath,                 // resolved: system `ollama` on PATH (guide-install if absent)
  args: ['serve'],
  env: { OLLAMA_HOST: '127.0.0.1:11434', OLLAMA_KEEP_ALIVE: '-1' },  // keep model resident
  healthCheck: { type: 'http', port: 11434, path: '/', timeoutMs: 1000 },
  backoff: { initialDelayMs: 500, multiplier: 2, maxDelayMs: 15000, maxRetries: 8 },
  startupTimeoutMs: 30000,
  adopt: true,                            // ← adopt a user's running daemon; never kill it
};
```
- `adopt: true` is the locked "never kill a daemon you didn't start" behavior — the supervisor already enforces it. On quit, `manager.stop()` → `supervisor.stop()` → no-op if adopted.
- **`OLLAMA_HOST` / `OLLAMA_KEEP_ALIVE` via `env`** are only applied when the app *spawns* `ollama serve`. If the daemon is **adopted**, the app cannot dictate its env; enforce keep-alive **per request** instead (`keep_alive: -1` in the chat body, or via ollama-js). Do both: set env when owning; always pass `keep_alive:-1` per request so resident behavior holds regardless of adopt/own.
- **Health probe note:** the generic probe passes on any HTTP response (`statusCode > 0`); Ollama's `/` returns `200 "Ollama is running"`. That proves *server up*. `LocalModelManager` must then do the **two further checks** (Pitfall 4): *model present* (`ollama.list()` / `GET /v1/models`) and *model responds* (a trivial `testConnection`). Three distinct checks, three distinct error messages.
- **"Adopted vs owned" reporting:** surface `supervisor.getStatus().owned` (and `state === 'adopted'`) up to `LocalModelManager.getStatus()` → settings "Model" section shows "Using your running Ollama" (adopted) vs "Managed by OpenCluely" (owned). Drives the Local-down recovery UI (restart only offered when owned; when adopted, guide the user to restart their own daemon).
- **`pidFile`:** the supervisor supports it (writes on own-spawn, unlinks on clean stop). Ollama is typically adopted, so `pidFile` is optional here; if the app owns the daemon, set one so a crashed prior session's orphan can be reaped (openwhispr's `sidecarPidFile` pattern). `tree-kill` is **not needed** — the supervisor's SIGTERM→SIGKILL on the owned child is the locked mechanism; only reach for tree-kill if `ollama serve` is observed to orphan model-runner subprocesses on the target OS (verify empirically; not observed to be required for adopt-mode).

**Where `LocalModelManager` lives (discretion):** `src/core/local-model.manager.js` (co-located with `service-supervisor.js` and `request-builder.js` in `src/core/`, matching the Phase-1 DI shape: export the class, inject deps, default to real singletons). Wire `start()` into `main.js` `onAppReady` (`main.js:160`) and `stop()` into `onWillQuit` (`main.js:163`) — hooks already exist.

---

### Flag 6 — MODEL-PULL PROGRESS — WIRED to the existing `download-*-model` IPC

**Finding (HIGH confidence for event shape; the wiring pattern is read from live code):** The official `ollama` npm `pull({ model, stream: true })` returns an **`AsyncGenerator`**; each yielded event is a `ProgressResponse`:
```ts
{ status: string, digest?: string, total?: number, completed?: number }
```
- `status` progresses through: `"pulling manifest"` → `"pulling <digest>"`/`"downloading <digest>"` → `"verifying sha256 digest"` → `"writing manifest"` → `"removing any unused layers"` → `"success"`.
- `total` = bytes for the current layer; `completed` = bytes done so far (**may be absent** until a layer starts — guard it). Percent = `completed && total ? Math.round(completed/total*100) : null`.
- **Resumable + verified for free:** `ollama pull` resumes interrupted layer downloads and verifies the sha256 before `"success"` (satisfies Pitfall 5's resume/checksum requirements without hand-rolling range requests). The app just re-invokes `pull()`; already-complete layers are skipped.

**Existing pattern to mirror (read from live code):**
- Main: `ipcMain.handle("download-whisper-model", (event, modelName) => installer.downloadModel(modelName, { onProgress: (line) => event.sender.send("install-progress", line) }))` (`main.js:755`).
- Preload: `downloadWhisperModel: (m) => ipcRenderer.invoke('download-whisper-model', m)` + `onInstallProgress(cb)` subscribes to `'install-progress'` and returns an unsubscribe fn (`preload.js:52–58`).
- Onboarding: a `model-download` screen with `state.modelDownloading`/`modelDownloaded`, subscribes via `onInstallProgress`, appends lines (`onboarding.js:118–119, 274–279`).

**Recommended Phase-3 additions (structured progress, not just log lines):** The whisper flow streams opaque *strings*; a pull has real percent, so emit a **structured** event for a progress bar while keeping the same IPC shape:
```js
// main.js — new handler alongside download-whisper-model
ipcMain.handle("download-model", async (event, modelTag) => {
  try {
    return await localModelManager.pullModel(modelTag || 'qwen3-vl:8b', {
      onProgress: (p) => { try { event.sender.send("model-pull-progress", p); } catch (_) {} }
    });
  } catch (e) {
    logger.error("Model pull failed", { error: e.message });   // never interpolate into the message
    return { ok: false, message: e.message };
  }
});

// local-model.manager.js
async pullModel(tag, { onProgress } = {}) {
  for await (const part of await this.ollama.pull({ model: tag, stream: true })) {
    const percent = part.completed && part.total ? Math.round(part.completed / part.total * 100) : null;
    if (typeof onProgress === 'function') onProgress({ status: part.status, percent, completed: part.completed, total: part.total });
  }
  return { ok: true, model: tag };
}
```
- Preload: `pullModel: (t) => ipcRenderer.invoke('download-model', t)` + `onModelPullProgress(cb)` (same subscribe/unsubscribe shape as `onInstallProgress`).
- UI: onboarding first-run pull screen + a Settings **"Model"** section (status + **re-download / repair** button that just re-invokes `pullModel`). Reuse the onboarding progress plumbing; render `percent` as a bar, `status` as the label.
- **Preflight before pull:** check free disk (`fs.statfs`/`check-disk-space`-free via `fs`) ≥ ~7 GB and unified memory (`os.totalmem()`); warn if `< ~16 GB` RAM (qwen3-vl:8b's recommended floor) but proceed (friendly failure per locked decision).

---

### Flag 1 — EMPIRICAL TTFT + MEMORY smoke for `qwen3-vl:8b` on 32 GB Apple Silicon — PROCEDURE

**What's known (MEDIUM confidence on numbers — hardware-dependent, which is why the smoke measures on the real machine):**
- `qwen3-vl:8b` GGUF ≈ **6.1 GB** on disk (Q4_K_M); recommended **≥ 16 GB** unified memory; comfortable on 32 GB. Peak resident (weights + KV + working set) commonly cited **~9–12 GB** for the 8B at bounded context. (STACK.md estimated 7–9 GB; a bounded-notes + one-image prompt lands in the 8–12 GB band.)
- **macOS GPU-wired ceiling:** by default macOS wires ~**75% of RAM** to the GPU (~**24 GB of 32 GB**); reserve **8–16 GB** for macOS + Chromium. Crossing it → macOS **swaps** (unified-memory swap collapses inference latency ~10×) or Ollama **partially offloads layers to CPU** (silently slow). No-swap is the hard requirement.
- TTFT for the *vision* path is dominated by **image-token prefill** (a screenshot can be hundreds–~1280 patch tokens) + md-notes/system prefill — *not* decode speed. (Text-only Qwen3-8B first token is ~0.7 s on an M2/16 GB; the VLM will be higher because of image prefill — measure it.)
- The **prefill metric** to read is `prompt_eval_duration` (nanoseconds) from `/api/chat` or `/api/generate` (and printed by `ollama run --verbose`); it is the TTFT proxy. `total_duration`, `load_duration`, `prompt_eval_count`, `eval_count`, `eval_duration` are the other timing fields; usage arrives in the final stream chunk (`done:true`).

**Concrete "rough smoke" procedure (satisfies the Phase-3 "proven" bar; NOT the Phase-6 sustained run):**

*Goal:* one representative multimodal request that simulates the bounded md-notes budget, measured for first-token latency and peak resident memory, on the actual 32 GB machine.

*Preconditions:* `ollama pull qwen3-vl:8b` done; daemon up; `keep_alive:-1` (warm — measure the resident case, not cold load).

*Representative prompt (simulate the md-notes budget):*
- system = the draft General reply-suggester prompt **+ ~12,000 chars of filler md-context** (the `context.maxChars` budget ARCHITECTURE.md proposes for Phase 5) so prefill reflects loaded notes;
- one **downscaled screenshot** PNG (long edge ~1280px — the resolution Phase 5 will actually send) as an `image_url` data URL;
- a short user question.

*Measure (cheap, scriptable):*
1. **Warm the model** (one throwaway request) so `load_duration` ≈ 0.
2. Send the representative request **non-streaming** via `/api/chat` (or ollama-js `chat`) and read `prompt_eval_duration` (prefill → TTFT proxy) and `eval_count/eval_duration` (decode rate). Also time **wall-clock to first streamed delta** with a streaming call (the user-perceived TTFT).
3. **Memory:** run `ollama ps` — confirm `PROCESSOR` shows **100% GPU** (a `CPU`/`XX%/YY% CPU/GPU` split = fail: model doesn't fit wired memory) and note `SIZE`. Cross-check **Activity Monitor → Memory pressure stays green, Swap Used ≈ 0** with Electron running.
4. Repeat 3× with the app's other subsystems idle-resident (Electron + Python-Whisper idle) and report the **median**.

*Pass / fail budget (Phase-3 rough bar — deliberately lenient; the strict <1.5 s continuous gate is Phase 6):*
- ✅ **Functional:** all 3 on-demand entry points answer locally (text streams; screenshot answered directly, no OCR; a general non-coding question gets a relevant answer).
- ✅ **TTFT:** first streamed token within a **few seconds** (suggested gate **≤ 3–4 s** wall-clock for the bounded-notes + one-image prompt, warm). A short answer streams to completion without stalling.
- ✅ **Memory:** `ollama ps` shows the model **fully GPU-resident** (no CPU offload); Activity Monitor memory pressure **green**, **no swap**, with VLM + Electron (+ idle Python-Whisper) co-resident. Resident VLM `SIZE` in the ~8–12 GB band, comfortably under the ~24 GB wired ceiling.
- ❌ **Fail signals:** `ollama ps` shows CPU offload / partial GPU; memory pressure yellow/red or swap > 0; TTFT double-digit seconds; model reloads between requests (keep-alive not `-1`).

*Cheap CLI-only variant (no script):*
```bash
ollama ps                                   # confirm resident + PROCESSOR=100% GPU, note SIZE
echo "…12k chars of filler md-notes… <question>" | ollama run qwen3-vl:8b --verbose ./shot.png
#   --verbose prints load/prompt-eval/eval durations & rates; prompt-eval = TTFT proxy
# (Programmatic: read prompt_eval_duration from /api/chat response — authoritative.)
```
*Explicitly NOT in this smoke (deferred to Phase 6):* sustained multi-minute session, minute-45 memory-pressure check, full real md-notes folder, continuous capture, resident-Whisper-hot co-residency, thermal/battery behavior.

---

## Standard Stack

### Core
| Library | Version | Purpose | Why standard |
|---------|---------|---------|--------------|
| **Ollama** (runtime, user-installed) | **≥ 0.19** | Local model server: OpenAI-compatible `/v1`, `pull`+cache, resident model, multimodal engine | Locked. Single binary, `/v1` OpenAI-shape, `keep_alive:-1`, MLX on Apple Silicon, official CJS Node client. Guide-install this phase (no bundling). |
| **`qwen3-vl:8b`** (model) | current tag | Primary VLM (text + screenshot) | Locked default. ~6.1 GB, strong OCR/UI/document understanding, comfortable on 32 GB. |
| **`openai`** (npm) | **^6.x** (CJS-safe) | `LocalProvider` transport → `http://127.0.0.1:11434/v1`, `apiKey:'ollama'` | Native OpenAI SSE + multimodal + `baseURL` portability; `require`-safe. |
| **`ollama`** (ollama-js, npm) | **^0.6.x** (dual CJS/ESM) | `LocalModelManager` lifecycle: `pull()` progress, `ps()`, `list()`, `/api/version` | Ollama-native model management the openai SDK lacks; `require`-safe. |

### Reused (already in the repo — no new dependency)
| Module | Path | Role in Phase 3 |
|--------|------|-----------------|
| `ServiceSupervisor` | `src/core/service-supervisor.js` | Ollama adopt/own lifecycle (Flag 3) — first real consumer. |
| `RequestBuilder` | `src/core/request-builder.js` | Neutral struct (already carries base64 images); GEN-01 edits the interview prompt here. |
| provider registry + facade | `src/services/providers/index.js`, `src/services/llm.service.js` | Register `local`; select via config; facade re-exports the selected singleton. |
| `WhisperInstaller` download flow | `src/core/whisper-installer.js` + `main.js:755` + `preload.js:52` | Progress IPC pattern to mirror for `pull()` (Flag 6). |
| `prompt-loader` / `skill-normalizer` | `prompt-loader.js`, `src/core/skill-normalizer.js` | GEN-01 skill machinery (broaden from dsa-only). |
| `enforceProgrammingLanguage` | `gemini.provider.js:651` (pure post-processor) | Copy into `LocalProvider` (or extract to shared helper) for coding-skill code-fence parity. |

### Removed (at the manual checkpoint, after proven)
| Package | Reason |
|---------|--------|
| `@google/genai` | Gemini LLM SDK — gone with the Gemini provider. |
| `microsoft-cognitiveservices-speech-sdk` | **NOT removed this phase** — Azure STT → Phase 4. |

**Install:** `npm install openai ollama` · (checkpoint) `npm uninstall @google/genai`

---

## Architecture Patterns

### Pattern 1: `LocalProvider` mirrors `GeminiProvider`'s FULL public surface (not just the 4 interface methods)
**What:** The facade `module.exports = providers.getSelected()` re-exports the selected provider *as* `llmService`. So `main.js` calls the provider's methods directly. `LocalProvider` must implement the **entire call-site surface**, mapping Gemini semantics to local. The exact surface `main.js` uses:

| `llmService.*` call site (main.js) | LocalProvider responsibility |
|--------------------------------------|------------------------------|
| `processImageWithSkillStream(imageBuffer, mimeType, activeSkill, sessionMemory, programmingLanguage, onDelta)` (1029) | `serialize(requestBuilder.buildImageRequest(...))` → `openai` streaming → `onDelta(delta)` → `{response, metadata}` |
| `processTextWithSkillStream(text, activeSkill, sessionMemory, programmingLanguage, onDelta)` (1096) | `serialize(requestBuilder.buildTextRequest(...))` → stream → `{response, metadata}` |
| `processTranscriptionWithIntelligentResponseStream(text, activeSkill, sessionMemory, programmingLanguage, onDelta)` (1263) | `serialize(requestBuilder.buildTranscriptionRequest(...))` → stream → `{response, metadata}` |
| `generateIntelligentFallbackResponse(text, activeSkill)` (1315) | canned local-down text (reused by the Local-down UX) |
| `testConnection()` (619/625) | trivial `/v1/chat/completions` ping or `/api/version` → `{success, ...}` |
| `checkNetworkConnectivity()` (624) | local health: Ollama up? model present? (repurposed from Gemini's TCP probe) |
| `getStats()` (585/589) | `{requestCount, errorCount, model, provider:'local', ...}` |
| `updateApiKey(key)` (584) | no-op / re-read host+model (Local has no key; `apiKey:'ollama'`) — keep the method so the shared IPC path doesn't break during the transition |
| `initializeClient()` (1566) | (re)construct the `openai` client from `config.llm.local.*` |

Plus the 4 interface methods (`isAvailable`, `generate`, `generateStream`, `testConnection`) from `llm-provider.js`, and `serialize(neutral)` (Flag 2). Keep `{ response, metadata:{ processingTime, usedFallback, streamed, ... } }` byte-compatible so callers at `main.js:1064–1080` keep reading the same fields.

**Return contract (from `gemini.provider.js:396`):** `{ response: string, metadata: { skill, programmingLanguage, processingTime, requestId, usedFallback, streamed, isImageAnalysis?, mimeType? } }`.

### Pattern 2: `LocalProvider.serialize()` — the ONLY place OpenAI wire shape is built
Mirror `GeminiProvider.serialize()` exactly in spirit: neutral struct in, OpenAI `{model, messages, stream}` out; **no prompt/skill/history logic** (that stays in `RequestBuilder`). See Flag 2 for the code. The neutral→OpenAI role rename (`'model'`→`'assistant'`) is the only history difference.

### Pattern 3: `LocalModelManager` configures the supervisor (adopt/own) + owns pull + resident
See Flag 3. Lives in `src/core/local-model.manager.js`. Owns: build supervisor def → `start()`/`stop()` wired to app lifecycle; `ensureModel()` (list → pull-if-missing with progress); `keep_alive:-1` per request; three-level health (server/model/responds); `getStatus()` surfacing `owned` vs `adopted`.

### Pattern 4: GEN-01 — generalize the skill/prompt system (minimal change)
**Two prompt sources exist — GEN-01 must handle both:**
1. **Text/image path** uses `.md` skill prompts via `prompt-loader.getSkillPrompt(skill)`. Currently `prompt-loader.js:32` (`if (skillName !== 'dsa') continue;`) loads **only** `dsa.md`, and `getAvailableSkills()` hard-returns `['dsa']` (line 308).
2. **Transcription path** uses the **hardcoded** `getIntelligentTranscriptionPrompt()` in `request-builder.js:31–85` — independent of the `.md` files.

**Prescriptive GEN-01 changes:**
- **Add `prompts/general.md`** — the concise reply-suggester (draft below). This becomes the default skill. (`skill-normalizer.normalizeSkillName('')` already returns `'general'`, so 'general' is the natural default name — it just has no prompt file today.)
- **Broaden `prompt-loader.js`:** replace the `dsa`-only filter (line 32) with a whitelist `['general','programming']` (or drop the filter and load all `.md`); update `getAvailableSkills()` (line 308) to return `['general','programming']`.
- **Reframe the coding skill:** rename/rewrite `prompts/programming.md` from "Programming Interview Helper Agent" → a **general-purpose coding assistant** (keep the structure); **keep the language-injection machinery** (`skill-normalizer.injectProgrammingLanguage` + `SKILLS_REQUIRING_PROGRAMMING_LANGUAGE`). Add `'programming'` to `SKILLS_REQUIRING_PROGRAMMING_LANGUAGE` (currently `['dsa']`) if the coding skill should take a language, or keep `dsa` as an alias mapping to `programming`. Reframe `prompts/dsa.md` title too (or retire it into `programming`).
- **Neutralize `request-builder.js:35`** — the `"Assume you are in an interview and you need to perform best in ${skill} mode."` line (the #1 functional interview-ism). Rewrite `getIntelligentTranscriptionPrompt()` toward a general concise reply-suggester: default = short ready-to-say suggestions; expand when the question clearly needs depth; drop all "interview" framing and DSA-centricity.
- **Settings skill picker:** a dropdown (General default + Coding) → existing `update-active-skill` IPC (`main.js:779`) already broadcasts `skill-changed`. Persist the selection in settings/config.
- **Expected test churn (not a regression):** the Gemini golden fixtures embed the interview prompt; they change when the prompt generalizes — they're deleted with Gemini at PROV-07 anyway.

**Draft General system prompt (for planning review — Claude's discretion):**
> "You are a concise, private copilot that suggests what to say or do next. Given the user's screen, the conversation, and their notes, reply with a short, ready-to-use suggestion — the actual words to say or the direct answer — not meta-commentary. Default to 1–3 sentences or a tight list; expand only when the question clearly needs depth (e.g., a coding problem or a detailed explanation). Never mention that you are an AI or that you are assisting. If nothing useful can be added, say nothing of substance."

### Pattern 5: Config restructure — per-provider blocks + a selection key (PROV-06)
Today `config.js` has a flat `llm.gemini` block and the registry hardcodes `selected: 'gemini'`. Restructure:
```js
llm: {
  provider: 'local',                 // NEW selection key (env override: LLM_PROVIDER)
  local: {                           // NEW per-provider block
    host: 'http://127.0.0.1:11434',  // env: OLLAMA_HOST
    model: 'qwen3-vl:8b',            // env: LOCAL_MODEL
    keepAlive: -1,
    curatedModels: ['qwen3-vl:8b', 'qwen3-vl:30b', 'gemma3:4b', 'gemma3:12b']
  },
  gemini: { /* KEEP until PROV-07 deletion */ }
}
```
- Registry reads `config.get('llm.provider')` instead of the hardcoded default; register both `local` and `gemini` providers so the user can flip back to Gemini during validation (locked transition window). After PROV-07: drop `gemini` from the registry + config; keep the provider switcher UI showing just Local (Phase 7 slots CLI providers in with no UI rework).
- Also clean the dead `speech.provider:'azure'` default (`config.js:60`) if convenient — but that's STT config; leave the rest of the `speech.*` block alone (Azure STT stays until Phase 4).

### Pattern 6: Cloud-removal gate as a SEPARATE, gated plan (PROV-07 / SC5)
Encode PROV-07 as its **own plan that runs LAST**, after a plan/step that records the smoke result, and that **does not auto-execute** — it's a hard manual checkpoint the user approves. The removal plan's scope is the "SAFE to delete" list in Flag 4 (Gemini only). Structure so a reviewer can read exactly what gets deleted before approving the irreversible commit. Keep the `main.js` call-site shapes green via tests after removal.

### Pattern 7: Post-removal Local-down UX (sole-engine recovery)
After Gemini is gone (and before Phase 7 CLI backups), Local is the only engine, so failure must be first-class. When `LocalProvider.isAvailable()` is false or a request throws (Ollama down / model missing / OOM), surface an inline **"Local model unavailable"** message in the overlay with one-click actions keyed off `LocalModelManager.getStatus()`:
- **owned + not running** → "Restart Ollama" (supervisor `start()`).
- **model missing** → "Re-download model" (`pullModel`).
- **adopted daemon down** → "Open settings" / guidance to start their own Ollama (don't offer to kill/restart a daemon the app doesn't own).
- Reuse `generateIntelligentFallbackResponse()` as the canned body so the overlay never goes silently blank. IPC: a new `model-status` query + `onModelStatus` event mirroring the existing speech-availability pattern (`preload.js:102`).

### Anti-Patterns to avoid (Phase-3-specific)
- **Removal-first** — never delete Gemini before Local is proven (Pitfall 12; the whole phase sequencing).
- **Killing an adopted Ollama** — the supervisor already prevents it; don't add a `tree-kill` on quit that ignores `owned`.
- **Prompt logic in the provider** — serialize only; assembly stays in `RequestBuilder` (SC4).
- **Removing the Azure polyfill this phase** — breaks STT (Flag 4); defer to Phase 4.
- **Full-res screenshot to the model** — send a downscaled frame (Pitfall 1); the on-demand path is fine as-is for Phase 3, but the smoke should use the ~1280px frame Phase 5 will send.
- **Hardcoded model strings scattered** — centralize in `config.llm.local` (CONCERNS flagged Gemini's scattered model ids).

---

## Don't Hand-Roll

| Problem | Don't build | Use instead | Why |
|---------|-------------|-------------|-----|
| OpenAI SSE streaming + multimodal request | A new `https`+SSE parser pointed at localhost | `openai` npm SDK | Existing parser is Gemini-shaped; SDK handles OpenAI deltas, `[DONE]`, image parts, abort/timeout |
| Multi-GB model download w/ resume + checksum | Range requests + sha256 + temp-rename | `ollama` npm `pull()` | Resumes layers + verifies sha256 before `success`; yields structured progress (Flag 6) |
| Process spawn / health / restart / adopt / kill-on-quit | A new supervisor | `src/core/service-supervisor.js` (Phase 1) | Already implements adopt/own, backoff, never-kill-adopted; pre-configured for Ollama |
| Neutral request assembly (skill/history/prompt) | Per-provider prompt logic | `src/core/request-builder.js` | SC4: one neutral struct; providers only serialize |
| Free-port allocation | `get-port` (ESM, breaks require) | Fixed 11434 + `net.createServer` probe if ever needed | Ollama's port is fixed; ESM dep incompatible with CJS |
| Progress IPC to onboarding | New channel design | Mirror `download-*-model` → `install-progress`/`onInstallProgress` | Proven pattern; add a structured `model-pull-progress` twin |

**Key insight:** Phases 1–2 pre-built the two hardest pieces (adopt/own supervisor, neutral-struct seam). Phase 3 is mostly *configuration + a sibling provider*, not new infrastructure.

---

## Common Pitfalls (Phase-3 subset — full catalog in `.planning/research/PITFALLS.md`)

### Pitfall 12: Removal-first breaks the app (the load-bearing sequencing)
**What goes wrong:** Deleting Gemini/cert-bypass before Local is proven leaves the only working path gone. **Avoid:** abstraction (done P2) → Local proven → removal LAST, behind the manual checkpoint. **Warning signs:** cert/TLS code running with no provider; `set-gemini-*` IPC still referenced; call-site drift. (Phase 2 already relocated the cert-bypass into the provider and made `setupNetworkConfiguration` a guarded delegate, so removal is clean — verify LocalProvider omits `configureNetworkSession`.)

### Pitfall 4: Service lifecycle — clobbering the user's Ollama
**What goes wrong:** Spawning a second daemon on :11434 (EADDRINUSE), connecting to their Ollama but missing your model, or killing their daemon on quit. **Avoid:** the supervisor's `adopt:true` (probe→adopt→never-kill); then verify model present (`list()`) and pull if missing; three-level health with three error messages. **Warning signs:** EADDRINUSE; "model not found" only on machines that already had Ollama; two ollama processes.

### Pitfall 5: Multi-GB download — no resume/checksum/offline handling, wrong cache path
**What goes wrong:** Restart-from-0 on a blip; corrupt partial that "looks present"; crash on offline first-launch; assuming `~/.cache` when Ollama uses `~/.ollama/models`. **Avoid:** `ollama pull` (resumes + checksums); detect offline and explain the one-time ~6 GB download; cache stays at Ollama's default (locked); handle disk-full in preflight. **Warning signs:** progress resets; `invalid magic`/truncation on load; offline hang.

### Pitfall 2 / 10: OOM/swap + unbounded context on 32 GB
**What goes wrong:** VLM + KV + Electron cross the ~75%-of-RAM wired ceiling → swap (10× latency) or CPU offload. Context bloat (full history + notes every call) grows prefill. **Avoid (Phase-3 scope):** `keep_alive:-1` (avoid reload) but `OLLAMA_MAX_LOADED_MODELS=1`/`OLLAMA_NUM_PARALLEL=1` (one user); the smoke's `ollama ps` GPU-resident + no-swap check is the gate; keep the system+mdContext as a fixed capped prefix (KV-reuse). Full token-budget enforcement + minute-45 checks are Phase 5/6. **Warning signs:** `ollama ps` shows CPU offload; memory pressure yellow/red; latency cliff.

### Pitfall 1: TTFT dominated by image + context prefill, not decode
**What goes wrong:** Optimizing tokens/sec while first-token lags because image-token + notes prefill is the cost. **Avoid:** measure `prompt_eval_duration` / wall-clock-to-first-delta (the smoke); send a downscaled (~1280px) frame; stable system prefix. **Warning signs:** GPU pegged for seconds before any token; fine fresh, slow after notes grow.

---

## Code Examples (verified patterns)

### LocalProvider streaming via `openai` SDK
```js
// Source: openai npm (v6, CJS) + Ollama OpenAI-compat docs
const OpenAI = require('openai');
this.client = new OpenAI({ baseURL: 'http://127.0.0.1:11434/v1', apiKey: 'ollama' });

async generateStream(neutral, options = {}, onDelta) {
  const { messages } = this.serialize(neutral);               // Flag 2
  const stream = await this.client.chat.completions.create({
    model: this.model, messages, stream: true,
    // resident behavior regardless of adopt/own:
    // (ollama-specific keep_alive is honored on /v1 via the request; also set via serve env when owned)
  });
  let full = '';
  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content || '';
    if (delta) { full += delta; if (typeof onDelta === 'function') onDelta(delta); }
  }
  const lang = options.programmingLanguage || null;
  return lang ? this.enforceProgrammingLanguage(full, lang) : full;  // reuse Gemini's pure post-processor
}
```

### `pull()` with structured progress
```js
// Source: ollama npm (ollama-js) — pull returns an AsyncGenerator of {status,digest?,total?,completed?}
const { Ollama } = require('ollama');
this.ollama = new Ollama({ host: 'http://127.0.0.1:11434' });
for await (const part of await this.ollama.pull({ model: 'qwen3-vl:8b', stream: true })) {
  const percent = part.completed && part.total ? Math.round(part.completed / part.total * 100) : null;
  onProgress({ status: part.status, percent });   // → IPC 'model-pull-progress' → onboarding/settings bar
}
```

### Supervisor config for Ollama (adopt/own)
```js
// Source: src/core/service-supervisor.js header comment + read of start()/stop()
const supervisor = new ServiceSupervisor({
  name: 'ollama', command: ollamaBin, args: ['serve'],
  env: { OLLAMA_HOST: '127.0.0.1:11434', OLLAMA_KEEP_ALIVE: '-1' },
  healthCheck: { type: 'http', port: 11434, path: '/', timeoutMs: 1000 },
  backoff: { initialDelayMs: 500, multiplier: 2, maxDelayMs: 15000, maxRetries: 8 },
  startupTimeoutMs: 30000, adopt: true,           // adopt-if-present; stop() never kills an adopted daemon
});
await supervisor.start();                          // 'adopted' if a daemon already answers, else 'healthy'
supervisor.getStatus();                            // { name, state, pid, owned }  → owned=false when adopted
```

### TTFT/memory smoke (CLI variant)
```bash
ollama ps                                          # PROCESSOR must read 100% GPU; note SIZE (~8–12 GB)
ollama run qwen3-vl:8b --verbose ./downscaled-shot.png   # --verbose prints prompt-eval (TTFT proxy) + eval rates
# Programmatic: POST /api/chat, read response.prompt_eval_duration (ns) = prefill/TTFT proxy
```

### Test pattern (mirror Phase 2, network-free)
```js
// LocalProvider.serialize() unit test (analog of test/gemini-request-parity.test.js):
//   RequestBuilder(neutral) → LocalProvider.serialize() → assert OpenAI messages shape,
//   incl. image part { type:'image_url', image_url:{ url:'data:image/png;base64,...' } }.
// LocalModelManager lifecycle test: reuse ServiceSupervisor's options.spawn DI seam
//   (see test/service-supervisor.test.js + test/fixtures/dummy-service.js) to prove
//   adopt-if-present / own-if-started with a FAKE process — no real Ollama needed.
```

---

## State of the Art

| Old (this repo, pre-Phase 3) | New (Phase 3) | Impact |
|------------------------------|---------------|--------|
| Gemini cloud LLM, host hardcoded, cert-bypass global | Local `qwen3-vl:8b` over `/v1`, primary/default | Offline, private, "if all else fails, this works" |
| No provider selection (registry hardcodes `gemini`) | `config.llm.provider` selection; Local default; Gemini selectable until deleted | PROV-06; enables safe validation window |
| DSA-only skills (`prompt-loader` loads only `dsa.md`) | General reply-suggester default + Coding skill | GEN-01; matches repositioning |
| Gemini `contents`/`parts`/`inlineData` wire shape | OpenAI `messages` + `image_url` data-URL parts | Standard shape; runtime-swappable via `baseURL` |
| `@google/genai` LLM SDK | `openai` (inference) + `ollama` (lifecycle) | Both CJS-safe |

**Deprecated / to remove (at checkpoint):** `@google/genai`, Gemini provider + IPC + cert-bypass, orphaned Gemini modal, Gemini goldens. **NOT yet:** Azure Speech SDK + polyfill (Phase 4).

---

## Open Questions

1. **Exact `keep_alive:-1` delivery for an *adopted* daemon.**
   - Known: env `OLLAMA_KEEP_ALIVE` only applies when the app spawns `serve`; per-request `keep_alive:-1` works via ollama-js `chat`/`generate`.
   - Unclear: the pure OpenAI `/v1` body doesn't have a standard `keep_alive` field — Ollama accepts it as an extension, but confirm the `openai` SDK passes unknown fields through (it generally does via the request body).
   - Recommendation: set keep-alive via a one-shot ollama-js `generate({ model, keep_alive: -1 })` warm-up in `LocalModelManager.ensureModel()`, independent of the inference SDK. Belt-and-suspenders: env when owned + explicit warm-up call always.

2. **`ollama run --verbose` stat fields** (CLI convenience for the smoke).
   - Known: `/api/chat` + `/api/generate` return `prompt_eval_duration` etc. (authoritative TTFT source).
   - Unclear: exact CLI label formatting of `--verbose` across Ollama versions.
   - Recommendation: rely on the API `prompt_eval_duration` in the scripted smoke; treat `--verbose` as a human convenience.

3. **Whether to retire `prompts/dsa.md` or keep it as a Coding alias.**
   - Known: locked decision keeps the coding machinery, broadens DSA→general coding.
   - Recommendation (planner call): fold DSA into a single `programming.md` general-coding skill; map `dsa` via `normalizeSkillName` alias so old references don't break. Minimal, matches "keep machinery as-is."

4. **Preflight memory threshold wording.** Recommended floor ≥ 16 GB (qwen3-vl:8b), target 32 GB. Warn (don't block) below 16 GB. Exact copy is discretion.

---

## Sources

### Primary (HIGH confidence)
- **Live repo code (read directly, source of truth):** `src/core/service-supervisor.js` (adopt/own API), `src/core/request-builder.js` (neutral struct + interview string line 35), `src/services/providers/{llm-provider,index,gemini.provider}.js` (interface, registry, serialize, full method surface, cert-bypass relocation), `src/services/llm.service.js` (facade), `src/services/speech.service.js:1–120` (Azure polyfill), `src/core/config.js` (config shape, dead `speech.provider`), `src/core/whisper-installer.js` + `main.js` (download IPC, lifecycle hooks, call sites), `preload.js` (IPC bridge), `prompt-loader.js` + `src/core/skill-normalizer.js` + `prompts/*.md` (GEN-01), `test/*.test.js` + `scripts/capture-gemini-goldens.js` (test patterns), `package.json` (deps: `@google/genai`, `microsoft-cognitiveservices-speech-sdk`, Electron 29.4.6; `openai`/`ollama` not yet installed).
- **Ollama OpenAI-compatibility** — https://docs.ollama.com/api/openai-compatibility — `/v1/chat/completions`, base64 data-URL `image_url` parts, `stream:true`, `apiKey:'ollama'`, endpoint list. HIGH.
- **Ollama API usage (timing fields)** — https://docs.ollama.com/api/usage — `total_duration`/`load_duration`/`prompt_eval_count`/`prompt_eval_duration`/`eval_count`/`eval_duration` (ns), usage in final stream chunk. HIGH.
- **ollama-js** — https://github.com/ollama/ollama-js — `new Ollama({host})`, `pull({model,stream})` → AsyncGenerator, `chat` images (Uint8Array|base64 string[]), `ps()`. HIGH.
- **Planning docs (repo ground truth):** `.planning/research/STACK.md`, `PITFALLS.md` (Pitfalls 1,2,4,5,10,12), `ARCHITECTURE.md`, `OPENWHISPR-NOTES.md`, `.planning/codebase/{CONCERNS,INTEGRATIONS,ARCHITECTURE}.md`, `PROJECT.md`, `ROADMAP.md`, `REQUIREMENTS.md`, `03-CONTEXT.md`. HIGH.

### Secondary (MEDIUM confidence — verified against ≥1 authoritative source)
- **ProgressResponse fields** (`status`/`digest`/`total`/`completed`; status stages) — Ollama Go `api` package + docs + community, cross-checked. MEDIUM-HIGH.
- **Ollama image_url nested `{url}` object** — corroborated by Ollama OpenAI-compat docs + issue threads (#3690, #6753, #8026) + OpenAI standard. HIGH on the object form; the bare-string variant seen in one summary is superseded.
- **`openai` npm v6 CJS + baseURL + streaming + image content array** — openai-node README + community; STACK.md pinned `openai@6.46.0` CJS. MEDIUM-HIGH.

### Tertiary (LOW-MEDIUM — hardware-dependent, validate via the smoke)
- **qwen3-vl:8b memory/latency** — codersera (GGUF ~6.1 GB Q4_K_M, ≥16 GB unified), willitrunai, llmcheck (text-only 8B ~0.7 s first token M2/16 GB). Numbers vary by machine; the flag-1 smoke measures the real target.
- **macOS ~75% GPU-wired ceiling / no-swap** — PITFALLS.md sources (ivanopcode devnote, stencel.io). MEDIUM.

---

## Metadata

**Confidence breakdown:**
- Azure scope (Flag 4): HIGH — live-code confirmed STT-only; polyfill inseparable from Azure SDK; defer to Phase 4.
- Multimodal shape (Flag 2): HIGH — official docs + OpenAI standard; nested `image_url:{url}` data URL.
- Transport (Flag 5): HIGH — `openai` (inference) + `ollama` (lifecycle); both CJS-safe; existing parser is Gemini-shaped.
- Adopt/own lifecycle (Flag 3): HIGH — supervisor already implements it and pre-specifies the Ollama config.
- Pull progress (Flag 6): HIGH on event shape + existing IPC pattern; structured-progress twin recommended.
- TTFT/memory (Flag 1): MEDIUM on numbers (hardware-dependent by design); HIGH on the procedure + metrics (`prompt_eval_duration`, `ollama ps` GPU-resident, no-swap).
- GEN-01: HIGH — two prompt sources identified (`request-builder.js:35` + `.md`); minimal-change path clear.
- Provider surface / config / removal gate: HIGH — full `llmService.*` call surface enumerated from `main.js`.

**Research date:** 2026-07-14
**Valid until:** ~2026-08-14 (30 days) for the codebase seams (stable) and the request/lifecycle shapes; ~7–14 days for the exact Ollama model tags/sizes (catalog evolves — re-check `qwen3-vl:8b`/`gemma3` tags at build time).
