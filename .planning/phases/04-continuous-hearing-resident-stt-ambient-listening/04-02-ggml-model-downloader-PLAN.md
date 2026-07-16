---
phase: 04-continuous-hearing-resident-stt-ambient-listening
plan: 02
type: execute
wave: 1
depends_on: []
files_modified:
  - src/core/whisper-model-downloader.js
  - test/whisper-model-downloader.test.js
autonomous: true

must_haves:
  truths:
    - "ggml-small.en.bin downloads resumably (HTTP Range) and is only marked installed after its SHA256 verifies (STT-02/SC2, Pitfall 5)"
    - "A partial/corrupt download never masquerades as installed — atomic rename happens only after checksum passes"
    - "Download progress is emitted as structured {percent, downloadedBytes, totalBytes} for the existing progress UI"
    - "Offline first-launch and disk-full are detected and produce friendly, actionable messages (not a crash)"
  artifacts:
    - path: "src/core/whisper-model-downloader.js"
      provides: "Resumable + SHA256-verified ggml model downloader to <userData>/.whisper-models/, structured progress, offline/disk-full handling, pinned checksum table"
      min_lines: 90
    - path: "test/whisper-model-downloader.test.js"
      provides: "node:test: checksum pass/fail, resume offset, atomic-rename-after-verify, partial-not-installed, offline/disk-full messaging (fake fetch + fake fs)"
      min_lines: 70
  key_links:
    - from: "src/core/whisper-model-downloader.js"
      to: "huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin"
      via: "Node http/https byte stream with Range resume (never ESM node-fetch)"
      pattern: "Range|resolve/main/ggml"
    - from: "src/core/whisper-model-downloader.js"
      to: "<userData>/.whisper-models/ggml-small.en.bin"
      via: "atomic rename after SHA256 verify"
      pattern: "\\.whisper-models"
---

<objective>
Build the first-run STT model downloader: a resumable, SHA256-verified fetcher for `ggml-small.en.bin` (487,614,201 bytes) from Hugging Face `ggerganov/whisper.cpp`, caching into `<userData>/.whisper-models/`, emitting structured progress, and degrading friendly on offline/disk-full. This is a focused new module (the venv/pip `whisper-installer.js` is retired in 04-03) with pure-logic tests.

Purpose: STT-02/SC2 — first run downloads and caches the STT model locally with visible, resumable progress (Pitfall 5). The IPC/onboarding wiring that streams this progress lands in 04-03 (IPC) + 04-07 (onboarding UX); this plan produces the reusable, testable download engine.
Output: `src/core/whisper-model-downloader.js` + node:test suite.
</objective>

<execution_context>
@~/.claude/get-shit-done/workflows/execute-plan.md
@~/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/phases/04-continuous-hearing-resident-stt-ambient-listening/04-CONTEXT.md
@.planning/phases/04-continuous-hearing-resident-stt-ambient-listening/04-RESEARCH.md

# Reuse targets (verified live):
@src/core/local-model.manager.js
@src/core/local-transport.js
@src/core/whisper-installer.js
</context>

<tasks>

<task type="auto">
  <name>Task 1: Resumable, SHA256-verified ggml model downloader</name>
  <files>src/core/whisper-model-downloader.js</files>
  <action>
Create `src/core/whisper-model-downloader.js` exporting `WhisperModelDownloader` (DI shape mirroring `LocalModelManager` / `WhisperInstaller`: deps via an options object, default real singletons, methods return status structs — degrade never crash). Logger tag `'WHISPER-DL'`.

Pinned model table (research Flag 6 — authoritative git-LFS OIDs; verify before marking installed):
- `small.en` → `ggml-small.en.bin`, size 487614201, sha256 `c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d` (DEFAULT)
- `base.en` → `ggml-base.en.bin`, size 147964211, sha256 `a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002` (low-RAM fallback)
- `tiny.en` → `ggml-tiny.en.bin`, size 77704715, sha256 `921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f` (tests/CI)

Source URL: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model}.bin` (the HF *model* repo is still `ggerganov/whisper.cpp`; `ggml-org/whisper.cpp` returns 401 — do NOT use it).

Cache dir: `<userData>/.whisper-models/` — the SAME location `WhisperInstaller.modelDir` / `speech.service._getUserDataModelDir()` use. Store `ggml-${model}.bin`.

`async download(model='small.en', { onProgress } = {})`:
1. Resolve target path + a sibling `.part` temp path.
2. If the final `.bin` already exists AND its SHA256 matches the pinned value → return `{ ok:true, present:true, path }` immediately (no re-download).
3. Preflight disk space (reuse the `LocalModelManager.preflight` `fs.statfsSync` pattern): if free space < model size + headroom → return a friendly disk-full message (do not start).
4. Determine resume offset = size of any existing `.part` file. Issue an HTTP GET with `Range: bytes=<offset>-` (HF serves `Accept-Ranges`; verified `Content-Length: 487614201`). Follow the 302 → CDN redirect (cross-host — follow it here since this is a direct downloader, not the WebFetch tool). Append bytes to `.part`.
5. Stream bytes with a running SHA256 (seed the hash from existing `.part` bytes on resume, or re-hash the whole file at the end — whichever is simpler and correct). Emit `onProgress({ percent, downloadedBytes, totalBytes })` throttled to ~100ms.
6. On completion: verify total size == pinned size AND SHA256 == pinned hash. Only then `fs.renameSync(.part, .bin)` (atomic-rename-after-verify). A mismatch → delete `.part`, return an error (never let a partial file masquerade as installed — Pitfall 5).
7. **Offline detection**: a connect/DNS error on the first attempt → friendly "connect once to download the ~488 MB voice model; after that OpenCluely works offline" message.
Transport: Node `http`/`https` byte stream (or the existing `nodeFetch`). ESM `node-fetch` is banned. No global `fetch` for the download (keep it deterministic).
Also expose `isModelPresent(model)` (path + optional checksum) and `modelPath(model)` helpers, and a `verifyChecksum(path, model)` helper (streamed SHA256).
Drop ALL venv/pip/Python machinery — this module is pure download + verify.
  </action>
  <verify>`node -e "const D=require('./src/core/whisper-model-downloader'); const d=new D(); console.log(typeof d.download, d.modelPath('small.en').endsWith('ggml-small.en.bin'))"` prints `function true`. `npx eslint src/core/whisper-model-downloader.js` clean. (Do NOT trigger a real 488 MB download in verify — that is exercised at the 04-08 validation gate / onboarding.)</verify>
  <done>The downloader resumes via HTTP Range, verifies SHA256 before an atomic rename into <userData>/.whisper-models/, emits structured progress, and returns friendly offline/disk-full messages — no venv/pip.</done>
</task>

<task type="auto">
  <name>Task 2: node:test suite (fake fetch + fake fs)</name>
  <files>test/whisper-model-downloader.test.js</files>
  <action>
Pure node:test (no network, no real 488 MB file). Inject a fake fetch/http returning a small known byte payload with a known SHA256, and use a temp dir (`os.tmpdir()` + fs) for the cache. Cover:
- **checksum pass**: a fully-downloaded temp file whose SHA256 matches the (test-injected) pinned value is atomically renamed to the final `.bin` and reported installed.
- **checksum fail**: a mismatched payload → `.part` deleted, NOT renamed, error returned, final `.bin` absent (partial-not-installed).
- **resume offset**: a pre-existing `.part` of N bytes causes a `Range: bytes=N-` request (assert via the fake fetch capturing the header).
- **already-present short-circuit**: an existing verified `.bin` returns immediately without a fetch.
- **offline**: a fake fetch that throws a connect error yields the friendly offline message (not a throw).
- **disk-full**: a stubbed `statfsSync` reporting < required space yields the friendly disk-full message and does not start the download.
Use a tiny injectable checksum table for the fixture so tests do not depend on the real 488 MB hash.
  </action>
  <verify>`node --test test/whisper-model-downloader.test.js` all pass. `make run_tests` green. `make lint` clean.</verify>
  <done>Checksum pass/fail, resume offset, already-present short-circuit, offline, and disk-full paths are all covered by passing, network-free node:test cases.</done>
</task>

</tasks>

<verification>
- `make run_tests` green (new suite + existing).
- `make lint` exits 0.
- Module constructs network-free; `modelPath('small.en')` resolves under `<userData>/.whisper-models/`.
- No venv/pip/Python references in the new module.
</verification>

<success_criteria>
- STT-02/SC2 engine: resumable + SHA256-verified download of ggml-small.en.bin to userData, structured progress, friendly offline/disk-full handling — proven by network-free tests.
- Atomic-rename-after-verify guarantees a partial file never masquerades as installed (Pitfall 5).
</success_criteria>

<output>
After completion, create `.planning/phases/04-continuous-hearing-resident-stt-ambient-listening/04-02-SUMMARY.md`
</output>
