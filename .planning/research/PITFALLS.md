# Pitfalls Research

**Domain:** Local-first, always-on multimodal AI desktop copilot (Electron + Apple Silicon; continuous audio + screen capture; self-hosted VLM/STT; CLI-agent backup)
**Researched:** 2026-07-13
**Confidence:** MEDIUM-HIGH (Context7 MCP was unavailable this run; grounded instead in official docs — docs.ollama.com, code.claude.com, marked/electron-builder — plus the actual `../forge` release workflow and multiple corroborating community sources. VLM image-token specifics and macOS-TCC-vs-signing behavior are MEDIUM.)

**Scope note:** This is a *brownfield subsequent milestone*. Existing tech-debt (no provider abstraction, per-utterance Whisper subprocess, single-shot capture, no service supervisor, unsanitized `innerHTML`, cert-verify bypass, 5+ background `setInterval` loops) is catalogued in `.planning/codebase/CONCERNS.md` and is referenced but not repeated. The pitfalls below are the ones you can still walk into while *building* the new local-AI + continuous-capture features, even after the known debt is understood.

---

## Critical Pitfalls

Mistakes that cause rewrites, break the core value prop ("a relevant streamed answer appears after each natural pause, from a local model"), or silently ship a broken product.

### Pitfall 1: The per-pause latency budget is blown by image tokens + context prefill, not by generation speed

**What goes wrong:**
Teams optimize tokens/sec (decode) and are shocked that replies still feel slow. For a multimodal per-pause request the dominant cost is **time-to-first-token (TTFT / prefill)**: encoding the screenshot into image tokens + prefilling (transcript window + concatenated md-notes + skill/system prompt + image tokens) through the model before a single word streams. A single screenshot in a Qwen2.5-VL-class model can be hundreds to ~1,280 patch tokens depending on resolution; add a growing transcript and a few md-notes and prefill alone can exceed the "feels real-time" budget on Apple Silicon before generation even starts.

**Why it happens:**
The existing pipeline was built for *occasional, on-demand* screenshots where a 2-4s round trip is fine. In continuous mode the same full-res-image + full-history request now fires on *every pause*, and prefill cost scales with (image tokens + context length), which nobody was measuring.

**How to avoid:**
- Instrument **TTFT specifically**, not just tokens/sec. Set an explicit budget (e.g. first token < ~1.5s) and treat it as a test gate.
- Downscale the screenshot to the *minimum resolution the model still reads accurately* before encoding — fewer pixels → fewer tiles → fewer image tokens (linear latency lever). Prefer JPEG for photographic frames.
- Give md-notes + system prompt a **fixed, capped, position-stable prefix** so the runtime can reuse the KV cache across pauses instead of re-prefilling it every time.
- Cap the transcript window (sliding, token-budgeted) rather than sending all history.
- Consider whether every pause even needs the image — send the screenshot only when the frame changed materially (see Pitfall 9).

**Warning signs:**
TTFT climbs as a session/notes grow; GPU pegged for seconds before any token appears; replies feel fine in a fresh session but sluggish after 10 minutes of talking.

**Phase to address:** Local multimodal (VLM) integration; Continuous always-on mode.

---

### Pitfall 2: OOM / swap on 32 GB when VLM + STT server + Electron/Chromium are all resident at once

**What goes wrong:**
Apple Silicon's unified memory is shared, but macOS caps GPU-*wired* memory at roughly **75% of RAM by default** (~24 GB of 32 GB). Resident simultaneously you have: the VLM weights (a 7B Q4 ≈ 4-6 GB) + its KV cache (grows with context, and scales with `OLLAMA_NUM_PARALLEL` × context length) + a persistent STT server (faster-whisper / whisper.cpp, ~1-2 GB) + Electron with multiple Chromium renderer processes (easily 1-2 GB+) + the existing always-on `setInterval` loops. Cross the wired limit and macOS either **swaps** (fatal on unified memory — inference latency collapses 10×), silently **offloads layers to CPU** (Ollama does this under pressure — quietly slow), or the OS **kills** a process.

**Why it happens:**
Each subsystem is sized in isolation ("7B fits in 32 GB easily"), ignoring that *all of them plus Chromium plus a growing KV cache* must coexist, and that the effective ceiling is ~75% of RAM, not 100%.

**How to avoid:**
- Budget the **total resident footprint** against `32 GB − OS/Chromium headroom (reserve 8+ GB)`, not against 32 GB.
- `OLLAMA_MAX_LOADED_MODELS=1` and `OLLAMA_NUM_PARALLEL=1` — you have one user; parallelism only multiplies KV-cache RAM.
- Pick a quantized VLM sized with headroom for KV growth, not one that *just* fits empty.
- Don't keep a *large* VLM and a *large* STT model both hot if you can avoid it; prefer a small STT model (the STT quality bar is "transcribe conversational speech," not diarize a podcast).
- If you raise `iogpu.wired_limit_mb` to give the GPU more room, still reserve 8-16 GB for macOS — and know it resets on reboot and needs `sudo` (bad fit for a self-contained app; treat as a documented power-user tweak, not a runtime action).
- Coalesce the 5+ background loops (per CONCERNS) so the model gets predictable headroom.

**Warning signs:**
Memory pressure yellow/red in Activity Monitor; sudden 10× latency cliff mid-session; `kernel_task` CPU spike; Ollama logs showing partial GPU offload / `recommendedMaxWorkingSetSize` lower than model needs; beachball + fan spin-up under a quiet screen.

**Phase to address:** VLM sizing; Local-service lifecycle; Continuous mode (memory-budget gate).

---

### Pitfall 3: macOS screen-recording / mic permission silently lost on every unsigned update — the always-on product just stops working

**What goes wrong:**
macOS **TCC ties a permission grant to the app's code signature (CDHash) + bundle ID**, not just its name/path. This app ships **unsigned** (no Apple Developer account, `xattr -cr` workaround). An unsigned or ad-hoc build gets a *new identity essentially every build*, so after a user updates to a new DMG, macOS **forgets** the previously granted Screen Recording and Microphone permissions. For an *always-on* copilot the failure is silent and total: capture returns black/empty frames and the mic delivers nothing, with **no error** — the overlay just stops surfacing answers. Worse, a truly unsigned app can fail to *register* in TCC at all, so the permission prompt never even appears. Compounding it: macOS Sequoia (15) removed the Control-click Gatekeeper bypass and periodically (monthly) re-prompts for Screen Recording for apps using the legacy capture path that Electron 29's `desktopCapturer` relies on; and the app's **process-name disguise** means the System Settings permission entry / the OS "is recording your screen" indicator shows a *confusing or wrong* name.

**Why it happens:**
TCC-vs-signature behavior is invisible during development on a single machine (you grant once and never rebuild-with-a-new-identity in a way that trips it). It only bites real users across the *update* boundary — exactly the path that's never tested.

**How to avoid:**
- Give the app a **stable bundle identifier forever** and at least an **ad-hoc signature** applied consistently in CI (unsigned-but-ad-hoc-signed is far better for TCC than truly unsigned).
- **Detect missing permission at runtime and recover gracefully**: for mic use `systemPreferences.getMediaAccessStatus('microphone')`; for screen recording there is no status API — *probe* by attempting a capture and detecting an all-black / empty frame, then surface a clear "Re-grant Screen Recording in System Settings" flow with a deep link.
- Document the **re-grant-after-update** step prominently (it will happen on unsigned builds).
- Investigate the Chromium feature flag that forces the older screen-capture permission system to reduce Sequoia's periodic re-prompts (flagged in Electron's desktopCapturer docs).
- Decide deliberately how process-name disguise interacts with the TCC entry a user must find and toggle — a disguised name they can't locate = unfixable-by-user.

**Warning signs:**
Capture returns blank/black frames right after an app update; no permission dialog on a clean install; the Screen Recording toggle appears OFF (or under a weird name) in System Settings; mic "recording" UI shows active but no transcript ever arrives.

**Phase to address:** Continuous screen capture; macOS DMG/packaging in CI; Permissions/onboarding UX. (This is the single most likely way to ship a "works on my machine, broken for everyone who updates" product.)

---

### Pitfall 4: Local-service lifecycle — port conflicts, "already running," orphaned processes, and clobbering the user's own Ollama

**What goes wrong:**
The target audience very likely **already runs Ollama** on the default `127.0.0.1:11434`. Self-starting your own server naively causes one of: (a) `EADDRINUSE` on launch; (b) you connect to *their* Ollama, find your model absent → "model not found"; (c) you spawn a *second* Ollama that fights over the port; (d) you inherit *their* `keep_alive`/`OLLAMA_MODELS` and behave unpredictably; or (e) on app crash your spawned server **orphans**, keeps the port, and the next launch can't bind. There is currently **no process supervisor** in the codebase (CONCERNS) — nothing health-checks, restarts-with-backoff, or stops the service on quit.

**Why it happens:**
"Just run Ollama" hides a lot: whose Ollama, on what port, with which models, owned by whom, cleaned up by whom. The happy path (no pre-existing Ollama, clean quit) is the only one that gets exercised in dev.

**How to avoid:**
- **Health-ping before spawn.** If a compatible server already answers, *reuse it* — but then verify your required model is present and `pull` it if not; never assume.
- If you spawn your own, run it on an **app-scoped non-default port** and with an **app-scoped `OLLAMA_MODELS`** so you never touch the user's install or models.
- Build the supervisor CONCERNS says is missing: track the child PID, health-check on an interval, restart-on-crash with backoff, and register a shutdown hook in `app.on('will-quit')` alongside the existing teardown.
- **Only ever kill processes you started.** Killing a user's pre-existing Ollama on quit is a support nightmare.
- Distinguish "server up" from "model ready" from "model responding" — three separate checks, three separate error messages.

**Warning signs:**
`EADDRINUSE` / bind failures on launch; "model not found" only on machines that already had Ollama; two `ollama` processes in Activity Monitor; port still held after a crash; the app hangs on startup waiting for a server that already exists.

**Phase to address:** LocalProvider + local-service lifecycle supervisor (foundational — everything downstream depends on it).

---

### Pitfall 5: Multi-GB first-run download with no resume, no checksum, broken offline first-launch, and a wrong cache-location assumption

**What goes wrong:**
First run pulls several GB of model weights. Naive implementations: restart from 0% when the connection drops or the laptop sleeps; leave a **corrupted partial file that "looks present"** so later loads fail with cryptic "invalid magic"/truncated errors; give no progress/ETA (user thinks it hung and force-quits mid-download); and **crash or hang on an offline first launch** instead of explaining that the *first* run needs the internet. There is also a **latent location mismatch**: PROJECT.md says the model caches under `~/.cache`, but Ollama's real default is **`~/.ollama/models`** (macOS/Linux) — if you rely on `ollama pull`, the cache is Ollama's, controlled by `OLLAMA_MODELS`, not `~/.cache`.

**Why it happens:**
Downloads always succeed on the developer's fast, stable connection; the failure modes (sleep, flaky wifi, disk-full, offline) never occur in dev, so no resume/verify/offline path gets built.

**How to avoid:**
- Use **resumable downloads** (HTTP range) — if delegating to `ollama pull`, its downloader resumes; if you fetch GGUF yourself, implement range + resume explicitly.
- **Verify a SHA256 checksum before marking a model "installed."** Download to a temp path and atomic-rename only after verification — never let a partial file masquerade as complete.
- Show real progress: percentage, transfer speed, ETA, and a resumable **Retry**; make it clear this is a one-time ~N GB download that then works fully offline.
- **Detect offline on first launch** and show a specific message ("connect to the internet once to download the local model, ~N GB; after that OpenCluely runs offline") instead of a generic failure.
- Be explicit and *consistent* about the cache location. Pick one truth: either use Ollama's `~/.ollama/models` (and set `OLLAMA_MODELS` if you want app-scoping) or your own dir under `~/.cache`/`userData` — don't half-document `~/.cache` while the runtime uses `~/.ollama`.
- Handle **disk-full** mid-download (multi-GB models routinely surprise users with 40 GB free).

**Warning signs:**
Progress resets to 0% after a network blip; model load fails with truncation/magic-byte errors; `.incomplete`/`.partial` files accumulating; first launch offline hangs or crashes; users report "downloaded twice."

**Phase to address:** LocalProvider first-run / model-download UX.

---

### Pitfall 6: Whisper silence-hallucination and VAD mis-triggering, amplified by always-on capture

**What goes wrong:**
Whisper's decoder **emits plausible text during silence** ("thank you", "you", "please subscribe", "Amara.org"...) and can loop. The existing code has an English-only hard-coded phrase blocklist (`_isHallucinatedTranscript`), but **continuous listening massively amplifies the problem**: long quiet gaps produce fake transcripts that then trigger the pause → VLM pipeline, so the overlay confidently answers things *nobody said*. Simultaneously, **VAD over-triggering** on keyboard clatter / fan / HVAC fires constant false utterances → constant VLM calls → battery, heat, and noise; **VAD under-triggering** drops real speech and the product feels dead. Noise-reduction preprocessing can make hallucination *dramatically worse* (turns a few seconds of false-positive into minutes).

**Why it happens:**
The current design assumes discrete, user-initiated recording sessions with a human present and speaking; an always-on stream spends most of its time in ambiguous near-silence, which is precisely Whisper's worst case.

**How to avoid:**
- Gate on the STT server's **`no_speech_probability` / `no_speech_threshold`** (e.g. drop segments where no-speech confidence > 0.6) — a probabilistic filter, not just an English phrase list.
- Require a **minimum speech duration and energy** before a segment is accepted; use a real VAD (Silero) with a tuned `min_silence_duration_ms`.
- Make the phrase blocklist **language-aware** (it's applied regardless of `WHISPER_LANGUAGE` today) and don't let it swallow legitimate one-word answers ("okay", "bye").
- Add a second gate before firing the VLM: the **relevance filter** (already planned) plus optionally "did the screen also change?" — so a lone hallucinated line can't trigger a response.
- Be cautious with noise reduction; measure whether it helps or hurts hallucination on *your* mic path.

**Warning signs:**
Overlay responds during silence; the same short transcript repeats; VLM firing with nobody talking; battery draining in a quiet room; legitimate short answers never reach the model.

**Phase to address:** Persistent STT server; Continuous listening / relevance gating.

---

### Pitfall 7: Prompt injection → XSS through the unsanitized `innerHTML` render path (blast radius explodes with screen-watch + md-notes)

**What goes wrong:**
Model output is rendered with `marked.parse()` → `.innerHTML` with **no sanitizer** (confirmed in CONCERNS). In the *old* cloud model this was already a risk; in the *new* design it becomes critical because **continuous screen capture funnels arbitrary on-screen text into the VLM** — a malicious webpage, a crafted image, a Slack message, a PDF — and md-notes may be pasted from untrusted sources. An attacker who merely gets text onto your screen can cause the VLM to emit HTML (`<img src=x onerror=...>`, `javascript:` links, `<script>`) that then executes in the overlay renderer, which has a **broad privileged preload** (`openExternal`, clipboard write, `get-settings` returning stored keys, `quit`, `restartAppForStealth`). Note **`marked` removed its built-in `sanitize` option in v5** — there is no "just turn on sanitize" anymore; you must add a real sanitizer.

**Why it happens:**
"It's just markdown from our own model" — but the model's *input* is now attacker-influenced (that's the definition of prompt injection), so its output must be treated as fully hostile HTML. The volume of untrusted input grows with every screen frame and every note.

**How to avoid:**
- Run **DOMPurify** on the HTML at **every `innerHTML` sink** before insertion (chat, overlay/`llm-response`, math render). Treat *all* model output as untrusted.
- Check `DOMPurify.removed.length > 0` as a signal that a response tried to inject — log/flag it.
- Keep `contextIsolation: true` / `nodeIntegration: false` (already set) and **scope the privileged IPC** so the response window can't reach `get-settings`/`openExternal` (check `event.sender` against the settings window) — defense in depth if a bypass is found.
- Prefer rendering as text where formatting isn't essential.
- **Sequence this into the same phase (or before) continuous capture / md-notes land — not "later."** The threat surface is created by exactly those features.

**Warning signs:**
Model output containing raw HTML renders as live DOM rather than escaped text; unexpected external-URL opens; `DOMPurify.removed` non-empty in logs; clipboard/settings activity you didn't trigger.

**Phase to address:** Security hardening — sequenced *with or before* continuous capture and md-context injection.

---

### Pitfall 8: Treating the Claude/Codex CLI backup as if it were a low-latency, well-behaved fallback

**What goes wrong:**
The CLI agents (`claude -p`, `codex exec`) are the escalation path, but they have failure modes that differ entirely from a local HTTP model: **cold-start is seconds** (process spawn + auth check + cloud round-trip) — correctly excluded from the per-pause path per PROJECT.md, but easy to accidentally reintroduce; **auth expiry** — a ChatGPT/Claude session token expires and a headless spawn drops into an *interactive login prompt that hangs forever*; **rate-limit exhaustion** → non-zero exit at reset boundaries; **output parsing** — scraping human-readable text breaks constantly (you must use `--output-format json` for Claude Code / `--json` JSONL for Codex); **non-zero exit codes** need explicit handling (Claude Code returns non-zero on errors, tool failures, and rate-limit exhaustion; `--max-turns` and a 10 MB stdin cap also exit non-zero); and the **auth choice silently sets your bill and limits** (ChatGPT/Claude subscription auth vs API key).

**Why it happens:**
It's tempting to model the CLI like any subprocess. But it's an interactive, authenticated, rate-limited cloud agent wearing a CLI costume; the hang-on-expired-auth and text-scraping failures only appear days/weeks later in real use.

**How to avoid:**
- **Never on the per-pause path** — keep it strictly manual/escalation (PROJECT.md already commits to this; guard it).
- Use structured output (`--output-format json` / `--json`) and parse events; never scrape prose.
- **Pre-flight auth** (`claude auth status` exits 0/1) and detect logged-out state *before* spawning, prompting the user out-of-band instead of letting a headless process hang on an interactive login.
- Always set a **timeout**, run non-interactively (`CODEX_NON_INTERACTIVE=1`), treat any non-zero exit as a surfaced failure (never silent), and respect the 10 MB stdin cap.
- Surface rate-limit / auth errors as user-facing messages; don't let the backup fail invisibly (the overlay would just go quiet).

**Warning signs:**
Backup invocation hangs (blocked on interactive auth); intermittent parse errors from text output; failures clustering at rate-limit reset times; unexpected spend.

**Phase to address:** CLI backup providers (Claude/Codex).

---

### Pitfall 9: Continuous capture drives a battery/thermal death spiral that kills the real-time promise exactly when the machine is hot

**What goes wrong:**
Always-on screen capture + per-pause VLM inference + a resident STT server + the existing 5+ `setInterval` loops = sustained GPU/CPU load. On Apple Silicon, sustained GPU load sharply raises **thermal-throttling** probability; once throttled, inference latency balloons — so the "real-time" reply dies precisely in a long, important session (a live interview) when the Mac is hottest. On battery this drains fast, and **fan noise breaks the "stealth" premise** (an audible fan in a quiet interview room defeats the invisible overlay).

**Why it happens:**
Dev testing is short, plugged in, and cool. The failure is emergent over a 30-60 minute session on battery — never reproduced at the desk.

**How to avoid:**
- **Frame-diff / hash to skip unchanged frames** — don't capture-encode-and-infer when the screen didn't change (CONCERNS notes there's no dedup today). This is the single biggest lever: no new information → no inference.
- Throttle the capture interval; **downshift or pause on battery** via Electron `powerMonitor`, and **back off when `powerMonitor.getCurrentThermalState()` reports `serious`/`critical`.**
- Coalesce the background `setInterval` loops into one scheduler (CONCERNS) so idle overhead is minimal.
- Use the smallest VLM that meets the quality bar; prefer JPEG + downscaled frames (also helps Pitfall 1).
- Pause capture when the screen is locked / display asleep / no user present.

**Warning signs:**
`powerMonitor` thermal state → `serious`/`critical`; audible fan under a static screen; latency degrading over a long session; battery %/hour spikes; CPU busy while nothing on screen is changing.

**Phase to address:** Continuous screen capture (throttle/dedup); Continuous mode (power/thermal awareness).

---

### Pitfall 10: Unbounded context — md-notes + transcript + history re-sent every pause overflow the local model's smaller window

**What goes wrong:**
CONCERNS notes session memory is trimmed by **event count, not tokens**, and md-context is planned as bounded concatenation. In continuous mode a request fires every pause; if each carries the full md-notes + a growing transcript + conversation history + a full skill prompt as `systemInstruction`, token count balloons. Local models generally have **smaller context windows than Gemini did**, so you hit context-length errors, silent oldest-first truncation (the model "forgets" the actual current question), and ever-growing prefill latency (feeds Pitfall 1).

**Why it happens:**
The history/skill-prompt machinery was tuned for a large cloud context and occasional calls; it has no *size* budget, only a *count* cap, and md-context is new surface with no budget at all.

**How to avoid:**
- Impose a **hard token budget with explicit, capped slots**: system+md-notes = fixed capped slot (ideally a stable prefix for KV reuse); transcript = sliding token-budgeted window; screenshot = exactly one image.
- **Measure token/char counts at insertion time** (CONCERNS recommends this for `getConversationHistory`), and cap individual event content length so one huge paste/response can't dominate.
- Make md-context a **separate, explicitly-budgeted context slot**, not more `sessionMemory` events (PROJECT.md already leans this way — enforce it).
- Choose a VLM whose context window comfortably holds (system + md-notes + a realistic transcript window + image tokens) with margin.

**Warning signs:**
Model returns context-length errors; responses ignore the most recent input (oldest-first truncation); TTFT grows monotonically over a session; behavior degrades as md-notes folder grows.

**Phase to address:** md-context injection; Session-memory refactor; Continuous mode.

---

### Pitfall 11: Bundling local binaries (Ollama / whisper server / Python) across macOS/Win/Linux collides with asar, arch, and the unsigned Gatekeeper path

**What goes wrong:**
Shipping or depending on native helpers has several traps: (a) **binaries inside the asar archive cannot be spawned** (`child_process.spawn`/`exec` can't execute inside asar) — they must be `asarUnpack`ed / placed in `extraResources`; (b) **spawn paths differ dev vs packaged** — a relative path that works in dev resolves wrong under `process.resourcesPath` in the DMG; (c) on macOS, **nested/bundled binaries and dylibs each carry their own quarantine attribute**, so even after `xattr` on the `.app` the *helper* can be Gatekeeper-killed ("damaged"/"killed") — the `xattr -cr` must be **recursive** over the whole bundle, and unsigned nested binaries are exactly what Gatekeeper distrusts; (d) a **universal (arm64 + x64)** build needs universal or per-arch copies of every native binary — a single-arch helper crashes on the other Mac; (e) **Python is especially painful to bundle** — the current design depends on a *system* Python + venv (CONCERNS flags `node-record-lpcm16` and the Whisper venv path as fragile), and stuffing a Python runtime into a cross-platform Electron app is a known quagmire.

**Why it happens:**
It works in `npm start` (unpacked, dev arch, no quarantine) and only breaks in the *packaged, downloaded, other-arch* build — the build users actually get.

**How to avoid:**
- `asarUnpack` every spawned binary; resolve paths via `process.resourcesPath` with a dev fallback.
- **Prefer detecting/reusing a user-installed Ollama over bundling it** (smaller DMG, no arch/signing headache, dovetails with Pitfall 4's reuse logic).
- Test the **packaged** build on **both arm64 and x64** and on a **clean machine that never had the dev toolchain** (this is where "works on my machine" dies).
- Document `xattr -cr /Applications/OpenCluely.app` (recursive) — mirror the `../forge` DMG note.
- Keep Python **out of the bundle**: either a managed/downloaded runtime or a documented system dependency; prefer a self-contained STT server binary (whisper.cpp) over a Python (`faster-whisper`) process to sidestep the Python-packaging quagmire entirely.

**Warning signs:**
`ENOENT`/"not found" for a helper only in the packaged app; "damaged"/"killed" dialogs for nested binaries; works on your Mac's arch, crashes on the other; DMG balloons in size.

**Phase to address:** Packaging / macOS DMG in CI; LocalProvider; STT server.

---

### Pitfall 12: Ripping out Gemini/Azure before the provider seam exists breaks preserved call-sites and leaves dead global startup coupling

**What goes wrong:**
Gemini isn't behind an interface — `llm.service.js` *is* Gemini; the host is hardcoded in ~6 places; the **cert-verify bypass + User-Agent override run unconditionally at app startup** (`main.js` `setupNetworkConfiguration`), independent of any provider; and the Azure SDK needs a **~380-line browser-DOM polyfill loaded in the main process**. Deleting these naively (a) breaks the `main.js` call-site shapes PROJECT.md wants preserved, (b) leaves TLS/cert code running with no provider that needs it, and (c) can remove the polyfill while leaving code that still references browser globals — a startup crash.

**Why it happens:**
The instinct is to "just delete the cloud stuff." But it's threaded through global startup and the LLM service internals, not isolated behind a seam.

**How to avoid:**
- **Land the `LLMProvider` abstraction FIRST**, wrapping the existing Gemini code *verbatim*; verify `main.js`/`sessionManager` call-sites are unchanged and the app still works on Gemini.
- Move the network/cert/UA special-casing **into the Gemini provider** (registered only when active), so it disappears cleanly when the provider is removed — not left as dead global startup code.
- Add `LocalProvider` next; only **then** delete Gemini + Azure (and the polyfill) as a *final* step, with tests around the preserved call-site shapes.
- Sequence: abstraction → LocalProvider → removal. Never removal-first.

**Warning signs:**
Startup errors referencing `window`/`AudioContext` after Azure removal; TLS/cert code running with no cloud provider; IPC handlers still named `set-gemini-*`; call-site signature drift.

**Phase to address:** Provider abstraction (first) → Gemini/Azure removal (last).

---

## Technical Debt Patterns

Shortcuts that seem reasonable but create long-term problems in this domain.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Spawn a duplicate Ollama on the default port instead of detecting/reusing an existing one | Simplest possible startup | Port conflicts, clobbering the user's models, orphaned processes | Never — health-ping + app-scoped port/`OLLAMA_MODELS` is not much more code |
| Send full-resolution screenshot + full history on every pause | No downscale/window logic to write | Blows TTFT budget; OOM/context overflow; battery burn | Never for continuous mode; fine for the *old* on-demand screenshot only |
| Keep the English-only hard-coded hallucination phrase list as the sole silence filter | Reuses existing code | Fires VLM on hallucinated silence; drops legit one-word answers; wrong per language | Only as a *secondary* filter behind `no_speech_threshold` + VAD |
| Ship truly unsigned (not even ad-hoc) to skip all signing setup | Zero signing config | TCC forgets screen/mic grants every update; capture silently breaks | Never once continuous capture ships — ad-hoc sign at minimum |
| Render model output straight to `innerHTML` (marked, no sanitizer) | Works today; no dependency | Prompt-injection XSS into a privileged renderer; grows with screen-watch | Never once screen-watch/md-notes feed the model |
| Bundle a Python `faster-whisper` server into the cross-platform DMG | Familiar Python stack | Python-in-Electron packaging quagmire × 3 OSes × 2 arches | Only if a self-contained binary (whisper.cpp) truly can't meet quality |
| Reuse the count-only session-memory trim for the new md-context + transcript | No new budgeting code | Context overflow / silent truncation on smaller local windows | Never — token budget is a prerequisite for continuous mode |
| `iogpu.wired_limit_mb` bump as a runtime action to fit a bigger model | Bigger model "fits" | Needs `sudo`, resets on reboot, starves macOS → pressure/swap | Only as a *documented, optional* power-user tweak — never automated |

## Integration Gotchas

Common mistakes when connecting to the external runtimes/services this project embeds.

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Ollama (local server) | Assume you own `:11434`; assume model cached at `~/.cache` | Health-ping + reuse-or-spawn on an app-scoped port; real default is `~/.ollama/models` (`OLLAMA_MODELS` to relocate) |
| Ollama keep-alive | Leave the 5-minute default → model unloads between quiet spells → cold reload mid-conversation | Set `keep_alive: -1` (or `OLLAMA_KEEP_ALIVE=-1`) for the always-on model so it stays resident |
| Ollama OpenAI-compat endpoint | Hardcode `/api/generate` shapes | Use the documented OpenAI-compatible `/v1/chat/completions` path so the provider seam matches the CLI/other providers |
| whisper / STT server | Per-utterance subprocess (current) → seconds of model-reload latency each pause | Persistent server process talked to over socket/HTTP (CONCERNS: the #1 continuous-listening blocker) |
| Claude Code CLI | Scrape human-readable stdout; let it hang on expired auth | `--output-format json`; pre-flight `claude auth status`; timeout + non-zero-exit handling; honor 10 MB stdin cap |
| Codex CLI | Interactive login in a headless spawn; wrong auth type | `CODEX_NON_INTERACTIVE=1`, device-auth/API-key up front, `--json` JSONL, `--ephemeral` |
| macOS `desktopCapturer` | Assume permission persists across updates; poll `getSources` just to check availability (existing 5s loop) | Probe-and-detect-black-frame + re-grant flow; consider the older-permission-system Chromium flag; coalesce the availability poll |
| Electron `powerMonitor` | Ignore battery/thermal/sleep | Downshift on battery, back off on `thermalState` serious/critical, pause capture on `suspend`/`lock-screen` |

## Performance Traps

Patterns that work at small scale (a demo, a fresh session, plugged in) but fail as usage grows.

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Prefill/TTFT ignored in favor of tokens/sec | Replies sluggish despite "fast" decode | Budget & test TTFT; downscale image; KV-reuse stable prefix | As soon as image + context are non-trivial (first real screenshot) |
| No frame dedup on continuous capture | Fan spin-up on a static screen; battery drain | Hash/diff frames; skip inference when unchanged | Within minutes of always-on use |
| KV cache + weights + STT + Chromium all resident | 10× latency cliff; memory pressure red; CPU offload | Total-footprint budget vs ~75%-of-RAM ceiling; `MAX_LOADED_MODELS=1`, `NUM_PARALLEL=1` | When context grows or a second model loads (~mid-session on 32 GB) |
| Count-based (not token-based) history trim | Context-length errors; model "forgets" current question | Token budget with capped slots; measure at insertion | When history/notes exceed the local model's window |
| Sustained GPU load → thermal throttle | Latency degrades over a long session | Throttle/pause on `thermalState`; smallest viable model | 30-60 min sessions on battery |
| 5+ always-on `setInterval` loops competing with inference | Background CPU wake-ups; jittery latency | Coalesce into one scheduler (CONCERNS) | Compounds once the model is also hungry |

## Security Mistakes

Domain-specific security issues beyond general web security.

| Mistake | Risk | Prevention |
|---------|------|------------|
| `innerHTML` model output with no sanitizer | Prompt-injection XSS from screen/notes content into a privileged renderer | DOMPurify at every sink; treat all model output as hostile; check `removed.length` |
| Broad IPC (`get-settings` returns keys, `openExternal`) reachable from the response window | Injected markup exfiltrates settings / opens URLs | Scope IPC by `event.sender`; minimize preload surface |
| Cert-verify bypass running unconditionally at startup | MITM of any traffic to the trusted host (legacy Gemini) | Delete with Gemini; never global; opt-in "network compat mode" if ever needed |
| Secrets (any CLI/provider tokens) in plaintext `.env`, `0600` not re-applied on rewrite | Local secret disclosure | Prefer Electron `safeStorage`/keychain; re-apply `0600` on every write; local-first ideally needs *no* stored key |
| Trusting md-notes as "safe" because they're the user's | Notes pasted from untrusted sources carry injected instructions/markup | md-context is untrusted input to the model too; sanitize output regardless of source |
| Capturing/persisting screen frames without minimization | Sensitive on-screen content (passwords, PII) lands in logs/history/model context | Don't persist raw frames; downscale; never log frames; keep frames in-memory transient |

## UX Pitfalls

Common user-experience mistakes specific to an always-on local copilot.

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Silent permission loss after update (Pitfall 3) | Product "just stops working," no error | Runtime permission probe + clear re-grant flow + documented post-update step |
| No visible "listening/watching" indicator for always-on mode | Trust/creep; user unsure if it's on or off | Persistent, hard-to-miss indicator + one-tap pause/kill switch (already in scope — treat as required, not optional) |
| Multi-GB download with no progress/ETA/resume | User force-quits mid-download → corrupt state | Progress + speed + ETA + resumable retry + "one-time, then offline" messaging |
| Overlay answers during silence (hallucination) | Feels broken/creepy; distracting in a call | `no_speech` gating + relevance filter + require speech energy before firing |
| Fan noise + heat during a "stealth" interview | Defeats the invisible premise; audible tell | Thermal-aware throttle; smallest model; frame dedup so idle = quiet |
| First launch offline = crash/hang | Looks broken on day one | Detect offline; explain the one-time download requirement gracefully |
| No pause/downshift on battery | Laptop dies fast; user distrusts always-on | `powerMonitor` battery-aware behavior + user-visible power mode |

## "Looks Done But Isn't" Checklist

Things that appear complete in a dev demo but are missing critical pieces for real users.

- [ ] **Local model service:** Works in dev — but does it detect/reuse a *pre-existing* user Ollama, survive its own crash without orphaning the port, and stop cleanly on quit? Verify with an Ollama already running on `:11434`.
- [ ] **First-run download:** Shows a progress bar — but does it *resume* after a killed connection, *checksum* before marking complete, and give a real message when *offline* or *disk-full*? Verify by pulling the network mid-download.
- [ ] **Screen/mic permission:** Granted on your machine — but does capture still work after installing a *new build* (new signature)? Verify the *update* path, not just first install.
- [ ] **Continuous listening:** Transcribes when you talk — but does it stay quiet during 2 minutes of silence, and survive unplugging the mic / lid-close-sleep / resume? Verify a long quiet session and a device-unplug.
- [ ] **Per-pause latency:** Fast in a fresh session — but is TTFT still within budget after 10 minutes of conversation and a full md-notes folder? Verify at session end, not start.
- [ ] **Memory:** Fine right after launch — but does it hold under a long session with VLM + STT + Chromium all hot and KV cache grown? Verify Activity Monitor pressure at minute 45.
- [ ] **Model output rendering:** Renders markdown nicely — but is it sanitized? Verify by making the model echo `<img src=x onerror=alert(1)>` from screen content.
- [ ] **CLI backup:** Returns an answer when logged in — but what happens when auth is *expired* (does it hang?) and when *rate-limited* (does it fail loudly)? Verify with a logged-out CLI.
- [ ] **Packaged build:** Runs from `npm start` — but does the *DMG* run on a clean Mac of the *other* arch with helper binaries intact after `xattr -cr`? Verify on a second machine.
- [ ] **Gemini/Azure removal:** App builds — but do the preserved `main.js` call-sites still work, and is the global cert/UA startup code gone (not just dead)? Verify no `window`/`AudioContext` refs remain in main.

## Recovery Strategies

When pitfalls occur despite prevention, how to recover.

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Corrupted/partial model download | LOW | Delete the partial (temp) file; re-pull with resume; verify checksum before use |
| Orphaned local server holding the port | LOW | Detect on startup (health-ping a stale PID); kill *only* your tracked PID; rebind |
| TCC permission lost after update | MEDIUM | Runtime probe detects black frames/no audio → deep-link user to System Settings → re-grant; document as expected on unsigned updates |
| OOM / swap mid-session | MEDIUM | Unload STT or downshift VLM (`keep_alive:0` on the idle one); reduce `NUM_PARALLEL`; smaller model; cap context |
| XSS/injection discovered in overlay | MEDIUM | Add DOMPurify at all sinks; audit preload surface; ship as a patch (renderer-only change, no model retrain) |
| Blown TTFT budget in continuous mode | MEDIUM | Downscale image, cap transcript window, KV-reuse the md-notes prefix, drop image on unchanged frames |
| Bundled helper Gatekeeper-killed on user Macs | MEDIUM-HIGH | Recursive `xattr -cr`; ad-hoc sign helpers; or pivot to reusing user-installed Ollama / self-contained binary |
| Gemini removal broke call-sites | HIGH | Revert to the provider-seam checkpoint; re-do removal *after* the abstraction is proven (why abstraction must land first) |

## Pitfall-to-Phase Mapping

How roadmap phases should address these pitfalls. Phase names are *suggested groupings* from PROJECT.md's Active scope; the roadmapper defines final phases.

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| 12 — Gemini removal breaks call-sites | Provider abstraction (first) → removal (last) | App runs on Gemini through the new seam before any deletion; call-site tests green |
| 4 — Service lifecycle / port conflicts | LocalProvider + lifecycle supervisor | Launch with a pre-existing Ollama running; crash-and-relaunch; clean quit leaves no orphan |
| 5 — First-run download | LocalProvider first-run/download | Kill network mid-download → resumes + checksums; offline first-launch shows guidance |
| 2 / 10 — OOM & context bloat | VLM sizing + continuous mode | Minute-45 memory-pressure check; token-budget enforced; no context-length errors |
| 1 — Per-pause TTFT | VLM integration + continuous mode | TTFT budget met at session *end* with full notes, not just fresh |
| 6 — Whisper hallucination / VAD | Persistent STT server + continuous listening | 2-minute silence produces zero overlay responses; device-unplug handled |
| 9 — Battery/thermal | Continuous screen capture + continuous mode | `thermalState` back-off verified; idle static screen stays quiet; battery downshift works |
| 3 — TCC permission loss on update | Continuous capture + macOS DMG + permissions UX | Capture still works after installing a *new* signed-identity build; re-grant flow appears |
| 7 — Injection/XSS | Security hardening (with/before capture+notes) | Model echoing `<img onerror>` from screen renders inert; `DOMPurify.removed` logged |
| 11 — Binary packaging | Packaging / macOS DMG in CI | DMG runs on clean 2nd machine, both arches, helpers intact after `xattr -cr` |
| 8 — CLI backup gotchas | CLI backup providers | Logged-out CLI fails loudly (no hang); JSON parsed; timeout enforced; never per-pause |

## Sources

**Official docs (HIGH confidence):**
- Ollama FAQ — model storage (`~/.ollama/models`), `OLLAMA_MODELS`, port 11434, `OLLAMA_HOST`, 5-min `keep_alive` default + `-1` for indefinite, `OLLAMA_MAX_LOADED_MODELS` / `OLLAMA_NUM_PARALLEL` RAM scaling: https://docs.ollama.com/faq
- Claude Code headless / `-p` mode — JSON/stream-json output, non-zero exits on error/rate-limit, 10 MB stdin cap, `claude auth status` 0/1: https://code.claude.com/docs/en/headless
- Electron `desktopCapturer` — macOS 14.2+ permission behavior, Chromium flag for the older permission system, prompt-once semantics: https://www.electronjs.org/docs/latest/api/desktop-capturer
- Electron `powerMonitor` — thermal state (`nominal`/`fair`/`serious`/`critical`), battery/suspend events: https://www.electronjs.org/docs/latest/api/power-monitor
- electron-builder Application Contents — asar can't spawn binaries, `extraResources`/`asarUnpack`, `Contents/Resources`: https://www.electron.build/docs/contents/
- marked — sanitizer removed; bring your own (DOMPurify): https://github.com/markedjs/marked/discussions/1232
- DOMPurify — XSS sanitization, `removed` array: https://github.com/cure53/DOMPurify
- `../forge/.github/workflows/release.yml` (local prior art) — unsigned DMG pattern: `CSC_IDENTITY_AUTO_DISCOVERY: 'false'`, `--universal -c.mac.notarize=false --publish always`

**Community / corroborated (MEDIUM confidence):**
- Apple Silicon Metal ~75%-of-RAM GPU cap, `iogpu.wired_limit_mb`, `recommendedMaxWorkingSetSize`, reserve 8-16 GB headroom: https://github.com/ivanopcode/devnote-override-macos-metal-vram-cap , https://stencel.io/posts/apple-silicon-limitations-with-usage-on-local-llm%20.html
- Ollama memory management / keep-alive / OOM on Mac: https://markaicode.com/ollama-keep-alive-memory-management/ , https://www.aimadetools.com/blog/ollama-out-of-memory-fix/ , https://modelpiper.com/blog/ollama-multi-model-mac
- Whisper silence-hallucination + VAD false positives + `no_speech_threshold`: https://github.com/openai/whisper/discussions/679 , https://github.com/SYSTRAN/faster-whisper/issues/843 , https://dev.to/nareshipme/whisper-hallucination-on-silence-why-your-transcript-loops-the-same-phrase-2pg4
- macOS TCC tied to code signature/CDHash; unsigned/ad-hoc builds lose grants on rebuild: https://developer.apple.com/forums/thread/730043 , https://github.com/NousResearch/hermes-agent/issues/49110 , https://hacktricks.wiki/en/macos-hardening/macos-security-and-privilege-escalation/macos-security-protections/macos-tcc/index.html
- macOS Sequoia Gatekeeper Control-click removal + `xattr -d com.apple.quarantine`: https://www.idownloadblog.com/2024/08/07/apple-macos-sequoia-gatekeeper-change-install-unsigned-apps-mac/ , https://mjtsai.com/blog/2024/07/05/sequoia-removes-gatekeeper-contextual-menu-override/
- Qwen2.5-VL dynamic resolution ~1,280 patch tokens/image; local inference speed: https://huggingface.co/docs/transformers/model_doc/qwen2_5_vl , https://arxiv.org/pdf/2502.13923
- HuggingFace download resume default + `hf_transfer` for large/flaky downloads + corrupt `.incomplete` class of errors: https://discuss.huggingface.co/t/with-hf-cli-how-do-i-resume-an-interrupted-model-download/174935 , https://github.com/huggingface/huggingface_hub/issues/4196
- Codex CLI non-interactive `exec`, `CODEX_NON_INTERACTIVE=1`, `--json`, `--ephemeral`, device-auth vs API key: https://www.developersdigest.tech/blog/codex-exec-ci-headless-guide , https://computingforgeeks.com/codex-cli-cheat-sheet/
- LLM output = untrusted input (OWASP LLM05 Improper Output Handling); sanitize streamed responses: https://github.com/focused-dot-io/owasp-LLM05 , https://developer.chrome.com/docs/ai/render-llm-responses
- Electron GPU/battery cost on macOS + thermal-throttle sensitivity: https://stanislas.blog/2025/12/macos-thermal-throttling-app/

**Internal (HIGH confidence — repo ground truth):**
- `.planning/codebase/CONCERNS.md` — existing tech-debt this milestone must not re-create (no provider abstraction, per-utterance Whisper, single-shot capture, no supervisor, unsanitized `innerHTML`, cert bypass, 5+ `setInterval` loops, count-only session trim, Electron 29).
- `.planning/PROJECT.md` — scope, constraints, and the forge/openwhispr prior-art references.

---
*Pitfalls research for: local-first always-on multimodal AI desktop copilot (Electron / Apple Silicon)*
*Researched: 2026-07-13*
