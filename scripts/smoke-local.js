'use strict';

// Local-engine TTFT + memory smoke (PROVE LOCAL, Phase 3 — RESEARCH Flag 1).
//
// This is the scriptable half of the "Local proven" gate: one representative
// multimodal request that simulates the bounded md-notes budget + one image,
// measured warm for first-token latency and decode rate. It is the evidence the
// removal plan (03-08) gates on.
//
// WHY it lives in scripts/ (not test/*.test.js): it needs a REAL running Ollama
// with the pulled `qwen3-vl:8b` model, so it must never run in `make run_tests`
// / CI. The Makefile's single-* glob (`test/*.test.js`) already excludes it.
//
// What it does (per RESEARCH Flag 1's rough-smoke procedure):
//   1. reads host+model from config.get('llm.local');
//   2. WARMS the model (throwaway request) so load_duration ~= 0 (resident case);
//   3. builds a representative prompt: General reply-suggester system prompt
//      + ~12,000 chars of filler md-context + one ~1280px screenshot-shaped PNG
//      + a short question;
//   4. sends it NON-STREAMING via ollama /api/chat and reads prompt_eval_duration
//      (ns -> prefill/TTFT proxy) + eval_count/eval_duration (decode rate), then
//      times WALL-CLOCK to first streamed delta with a streaming call;
//   5. prints a compact report + reminds you to eyeball `ollama ps`
//      (PROCESSOR = 100% GPU, note SIZE) and Activity Monitor (memory pressure
//      green, swap ~= 0);
//   6. prints PASS/FAIL against the lenient Phase-3 timing gate.
//
// Phase-3 bar is deliberately ROUGH (warm, one image, filler notes). The FULL
// sustained-load / minute-45 / real-full-notes validation is DEFERRED to Phase 6
// (per CONTEXT Deferred + RESEARCH Flag 1). Memory-residency + no-swap are
// confirmed by the human via `ollama ps` / Activity Monitor, not by this script.
//
// Usage:   node scripts/smoke-local.js [optional/path/to/screenshot.png]
//   (no path -> a synthetic ~1280px gradient PNG is generated, no deps.)
//
// Exit codes (non-zero on the timing gate so it can be eyeballed, but it is NOT
// a test-glob file so it never blocks CI):
//   0  timing PASS (a local multimodal answer streamed within the gate)
//   1  timing NEEDS-REVIEW (measured, but slow / empty answer)
//   2  Ollama server unreachable          3  configured model not present
//   4  unexpected error

// Load .env first so config.get('llm.local') reflects the same OLLAMA_BASE_URL /
// LOCAL_MODEL / LLM_PROVIDER the app uses (config reads process.env at require).
try { require('dotenv').config(); } catch (_) { /* dotenv optional */ }

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const { Ollama } = require('ollama');
const OpenAI = require('openai');
const config = require('../src/core/config');

// ── Tunables (representative of the bounded-notes budget Phase 5 will send) ──
const NOTES_CHARS = 12000; // ~context.maxChars md-notes budget (ARCHITECTURE.md)
const IMAGE_W = 1280;      // long edge ~1280px = the downscaled frame Phase 5 sends
const IMAGE_H = 800;       // landscape, screenshot-shaped
// Bound decode so the smoke stays fast, but leave headroom for qwen3-vl's thinking:
// on a heavy bounded-notes+image prompt it emits hundreds of <think> tokens before
// content even with /no_think, so a small cap (e.g. 64) starves the answer. 256 is
// enough to reach content in the usual case; override via SMOKE_NUM_PREDICT.
const NUM_PREDICT = Number(process.env.SMOKE_NUM_PREDICT) || 256;
const NUM_CTX = 8192;      // hold system+notes+image (~5k tok) uncut; realistic KV
const TTFT_GATE_MS = 4000; // lenient Phase-3 wall-clock gate (~3–4 s, warm)

const EXIT = { PASS: 0, REVIEW: 1, SERVER_DOWN: 2, MODEL_MISSING: 3, ERROR: 4 };

const DEFAULT_SYSTEM_PROMPT =
  'You are a concise, private copilot that suggests what to say or do next. '
  + 'Given the screen, the conversation, and the notes, reply with a short, '
  + 'ready-to-use suggestion — the actual words or the direct answer, not '
  + 'meta-commentary. Default to 1–3 sentences; expand only when the question '
  + 'clearly needs depth.';

// ── Synthetic PNG (pure Node, no image dep): valid RGB PNG at any size. ──

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'latin1');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

// A gradient (not a solid fill) so the file resembles real screen content; the
// image-token count that drives prefill is set by resolution, not by contents.
function makeSyntheticPng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  // remaining bytes (compression/filter/interlace) stay 0

  const raw = Buffer.alloc(height * (1 + width * 3));
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // per-scanline filter: none
    for (let x = 0; x < width; x++) {
      raw[o++] = (x * 255 / width) & 0xFF;
      raw[o++] = (y * 255 / height) & 0xFF;
      raw[o++] = ((x + y) * 255 / (width + height)) & 0xFF;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Prompt assembly ──

function loadGeneralPrompt() {
  try {
    const p = path.join(__dirname, '..', 'prompts', 'general.md');
    const txt = fs.readFileSync(p, 'utf8').trim();
    if (txt) return txt;
  } catch (_) { /* fall back to the built-in draft */ }
  return DEFAULT_SYSTEM_PROMPT;
}

function buildFillerNotes(targetChars) {
  const para = [
    '## Working notes',
    '- Roadmap: prove the local-first engine before removing the cloud path.',
    '- Action: measure time-to-first-token on the 32 GB machine, warm, with notes loaded.',
    '- Constraint: the model must stay fully GPU-resident — watch for swap under pressure.',
    'The private copilot watches the screen and hears the conversation, then suggests what to say next.',
    'Notes can grow long, so the context is bounded to keep prefill fast and predictable.',
    '',
  ].join('\n');
  let out = '';
  while (out.length < targetChars) out += para + '\n';
  return out.slice(0, targetChars);
}

// runId at the very top forces full prefix divergence between the two measured
// requests, so neither benefits from the other's KV-cache (independent numbers).
function buildSystem(systemPrompt, runId) {
  // Mirror LocalProvider's default (GEN-01, local.provider.js): qwen3-vl is a
  // reasoning model that otherwise emits a verbose <think> chain. The /no_think
  // soft-switch in the system prompt is the same mechanism the app uses. NOTE: on
  // the native /api/chat path qwen3-vl still routes output to the reasoning channel
  // when an image is present (so message.content is empty there) — hence the answer
  // + wall-clock TTFT are measured over /v1 below (the app's path), which is clean.
  return `<!-- smoke-run:${runId} -->\n${systemPrompt}\n\n`
    + `# User notes (bounded context)\n${buildFillerNotes(NOTES_CHARS)}`
    + '\n\n/no_think';
}

// Ollama native (/api/chat) shape — used only for the authoritative
// prompt_eval_duration (prefill) + decode-rate numbers.
function buildMessages(systemPrompt, runId, imageBase64, question) {
  return [
    { role: 'system', content: buildSystem(systemPrompt, runId) },
    { role: 'user', content: question, images: [imageBase64] },
  ];
}

// OpenAI /v1 shape (image_url data URL) — the app's LocalProvider path; used for the
// answer confirmation + user-perceived TTFT (qwen3-vl honors /no_think here).
function buildV1Messages(systemPrompt, runId, imageBase64, question) {
  return [
    { role: 'system', content: buildSystem(systemPrompt, runId) },
    {
      role: 'user',
      content: [
        { type: 'text', text: question },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
      ],
    },
  ];
}

function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

// ── Health probes (graceful, timeout-bounded) ──

async function serverUp(host) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await fetch(`${host}/api/version`, { signal: ctrl.signal });
    return !!(res && res.ok);
  } catch (_) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Mirrors LocalModelManager._modelInList (Ollama stores an untagged name as :latest).
async function modelPresent(client, model) {
  try {
    const list = await client.list();
    const names = (list && list.models ? list.models : []).map((m) => m.name);
    if (names.includes(model)) return true;
    if (!model.includes(':')) return names.includes(`${model}:latest`);
    return false;
  } catch (_) {
    return false;
  }
}

// Best-effort `ollama ps` so the resident SIZE / PROCESSOR table is visible
// inline; returns null if the CLI is not on PATH (adopted GUI daemon, etc.).
function tryOllamaPs() {
  try {
    const r = spawnSync('ollama', ['ps'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (r.status === 0 && r.stdout && r.stdout.trim()) return r.stdout.trim();
  } catch (_) { /* CLI not found */ }
  return null;
}

// ── Report helpers ──

const ms = (n) => (n == null ? 'n/a' : `${Math.round(n)} ms`);
const nsToMs = (n) => (n ? n / 1e6 : 0);

function line() { console.log('─'.repeat(64)); }

// ── Main ──

async function main() {
  const local = config.get('llm.local') || {};
  const host = local.host || 'http://127.0.0.1:11434';
  const model = local.model || 'qwen3-vl:8b';
  const keepAlive = local.keepAlive != null ? local.keepAlive : -1;

  line();
  console.log('Local engine smoke — Phase 3 rough TTFT/memory gate');
  console.log(`  host:  ${host}`);
  console.log(`  model: ${model}`);
  line();

  if (!(await serverUp(host))) {
    console.error(`\nFAIL: Ollama is not reachable at ${host}.`);
    console.error('  Start Ollama, or run the app once so onboarding installs + pulls it,');
    console.error('  then retry. (Settings → AI Model shows engine status.)');
    process.exit(EXIT.SERVER_DOWN);
  }

  const client = new Ollama({ host });
  // The app's LocalProvider talks OpenAI /v1; use it for the answer + TTFT check.
  const v1 = new OpenAI({ baseURL: `${host}/v1`, apiKey: 'ollama' });

  if (!(await modelPresent(client, model))) {
    console.error(`\nFAIL: model "${model}" is not present on the local Ollama.`);
    console.error(`  Pull it with:  ollama pull ${model}`);
    console.error('  or open Settings → AI Model → Re-download. Then retry.');
    process.exit(EXIT.MODEL_MISSING);
  }

  const systemPrompt = loadGeneralPrompt();

  // Prepare images: a small warm-up image + the representative ~1280px frame.
  const argPath = process.argv[2];
  let bigImageB64;
  if (argPath && fs.existsSync(argPath)) {
    bigImageB64 = fs.readFileSync(argPath).toString('base64');
    console.log(`Using provided image: ${argPath}`);
  } else {
    bigImageB64 = makeSyntheticPng(IMAGE_W, IMAGE_H).toString('base64');
    console.log(`Using synthetic ${IMAGE_W}x${IMAGE_H} PNG (pass a path to override).`);
  }
  const warmImageB64 = makeSyntheticPng(48, 48).toString('base64');

  // 1) WARM: load LLM weights + vision path so the measured load_duration ~= 0.
  console.log('\nWarming the model (throwaway request)…');
  try {
    await client.chat({
      model,
      messages: [{ role: 'user', content: 'Reply with OK.', images: [warmImageB64] }],
      stream: false,
      keep_alive: keepAlive,
      options: { num_predict: 1 },
    });
  } catch (e) {
    console.warn(`  warm-up warning (continuing): ${e.message}`);
  }

  // 2) NON-STREAMING measured request: authoritative prefill + decode rate.
  console.log('Measuring prefill + decode (non-streaming)…');
  const q1 = 'Based on my notes and this screen, what is the single most important thing to say next? One sentence.';
  const msgs1 = buildMessages(systemPrompt, randomId(), bigImageB64, q1);
  const nsStart = Date.now();
  const res = await client.chat({
    model,
    messages: msgs1,
    stream: false,
    keep_alive: keepAlive,
    options: { num_predict: NUM_PREDICT, num_ctx: NUM_CTX },
  });
  const nsWallMs = Date.now() - nsStart;
  const prefillMs = nsToMs(res.prompt_eval_duration);
  const loadMs = nsToMs(res.load_duration);
  const promptTokens = res.prompt_eval_count || 0;
  const evalCount = res.eval_count || 0;
  const evalMs = nsToMs(res.eval_duration);
  const decodeTps = evalMs > 0 ? (evalCount / (evalMs / 1000)) : null;
  const answer1 = (res.message && res.message.content) ? res.message.content.trim() : '';

  // 3) STREAMING over /v1 (the app's LocalProvider path, fresh prefix):
  //    user-perceived wall-clock TTFT to the first CONTENT token + a real answer
  //    sample. /v1 (not the native /api/chat above) is where qwen3-vl honors
  //    /no_think with an image, so content is clean — this mirrors what the overlay
  //    actually streams to the user.
  console.log('Measuring wall-clock to first token (streaming, /v1 app path)…');
  const q2 = 'Summarize the on-screen content and my notes in one short suggestion of what to say.';
  const msgs2 = buildV1Messages(systemPrompt, randomId(), bigImageB64, q2);
  const stStart = Date.now();
  let firstDeltaMs = null;
  let streamed = '';
  const stream = await v1.chat.completions.create({
    model,
    messages: msgs2,
    stream: true,
    max_tokens: NUM_PREDICT,
  });
  for await (const part of stream) {
    const delta = part.choices && part.choices[0] ? (part.choices[0].delta.content || '') : '';
    if (delta) {
      if (firstDeltaMs === null) firstDeltaMs = Date.now() - stStart;
      streamed += delta;
    }
  }

  // ── Report ──
  line();
  console.log('RESULTS (warm, representative bounded-notes + one image)');
  console.log(`  prompt tokens (notes+image+q): ${promptTokens}   [num_ctx=${NUM_CTX}]`);
  console.log(`  load_duration (warm, want ~0): ${ms(loadMs)}`);
  console.log(`  prefill  (prompt_eval_duration, TTFT proxy): ${ms(prefillMs)}`);
  console.log(`  wall-clock to first streamed token:          ${ms(firstDeltaMs)}`);
  console.log(`  decode rate: ${decodeTps ? decodeTps.toFixed(1) + ' tok/s' : 'n/a'} (${evalCount} tok / ${ms(evalMs)})`);
  console.log(`  non-streaming wall-clock (full ${NUM_PREDICT}-tok answer): ${ms(nsWallMs)}`);
  const sample = (streamed || answer1).replace(/\s+/g, ' ').slice(0, 120);
  console.log(`  answer sample (/v1 app path): ${sample ? '“' + sample + '…”' : '(empty)'}`);
  line();

  // Memory residency is a human eyeball check; surface `ollama ps` if we can.
  const ps = tryOllamaPs();
  console.log('MEMORY CHECK (confirm by hand — not gated by this script):');
  if (ps) {
    console.log('  $ ollama ps');
    ps.split('\n').forEach((l) => console.log('    ' + l));
  } else {
    console.log('  Run:  ollama ps   (ollama CLI not found on PATH from here)');
  }
  console.log('  → PROCESSOR must read 100% GPU (no CPU offload); note SIZE (~8–12 GB band).');
  console.log('  → Activity Monitor: memory pressure GREEN, Swap Used ~= 0, with the app running.');
  line();

  // ── Verdict (timing only; memory + the 3 overlay entry points = human gate) ──
  const gotAnswer = !!(streamed && streamed.trim());
  const ttftPass = firstDeltaMs !== null && firstDeltaMs <= TTFT_GATE_MS;
  const pass = gotAnswer && ttftPass;

  if (pass) {
    console.log(`PASS (timing): local multimodal answer streamed in ${ms(firstDeltaMs)} `
      + `(gate ≤ ${TTFT_GATE_MS} ms, warm).`);
  } else {
    console.log('NEEDS REVIEW:');
    if (!gotAnswer) {
      console.log(evalCount > 0
        ? `  - no CONTENT within the ${NUM_PREDICT}-token budget: the model generated ${evalCount} tokens but they were <think> reasoning. qwen3-vl over-reasons on this heavy bounded-notes+image prompt even with /no_think — raise SMOKE_NUM_PREDICT, and treat the slow time-to-first-content as a real "fast answer" concern (consider a non-reasoning default model).`
        : '  - model returned an empty answer.');
    }
    if (firstDeltaMs === null) console.log('  - no first CONTENT token observed over /v1 within the budget (reasoning likely consumed it).');
    else if (!ttftPass) console.log(`  - TTFT ${ms(firstDeltaMs)} exceeds the ${TTFT_GATE_MS} ms gate.`);
  }
  console.log('\nNOTE: this is the Phase-3 ROUGH smoke. Full sustained-load / minute-45 /');
  console.log('real-full-notes validation is DEFERRED to Phase 6. This script proves the');
  console.log('local multimodal round-trip + rough TTFT only — the human still verifies all');
  console.log('three overlay entry points, GPU-residency/no-swap, and Local-down recovery.');
  line();

  process.exit(pass ? EXIT.PASS : EXIT.REVIEW);
}

// Guard execution so this module can be required side-effect-free (network-free
// sanity checks of the pure helpers), mirroring capture-gemini-goldens.js.
if (require.main === module) {
  main().catch((err) => {
    console.error('\nUnexpected error running the local smoke:');
    console.error(`  ${err && err.message ? err.message : err}`);
    console.error('  (If this is a connection/timeout error, confirm Ollama is running and');
    console.error('   the model is pulled, then retry.)');
    process.exit(EXIT.ERROR);
  });
}

module.exports = { makeSyntheticPng, buildFillerNotes, buildMessages, crc32, loadGeneralPrompt };
