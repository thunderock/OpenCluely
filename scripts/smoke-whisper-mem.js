'use strict';

// Resident STT latency + memory-budget + silence-gate smoke — the repeatable,
// keyless spot-check behind the real-world validation gate. It reuses the same
// manager.transcribe() the flush seam uses (POST /inference?response_format=
// verbose_json + the no_speech_prob gate) to:
//   1) measure per-utterance wall-clock latency on a known WAV,
//   2) prove the SC5 silence gate: ~2 s of digital silence → empty gated text,
//   3) log whisper-server RSS + the coexisting VLM (ollama) RSS so a human can
//      confirm they fit the ~32 GB budget with no swap.
//
// KEYLESS + LOOPBACK-ONLY: talks only to the app's own resident whisper-server
// on 127.0.0.1 — no API key, no cloud. It reuses the side-effect-safe WAV
// helpers exported by smoke-whisper.js (whose main() is require.main-guarded),
// and deliberately does NOT require speech.service.js (that module still mutates
// globals via the Azure polyfill until it is removed).
//
// WHY it lives in scripts/ (not test/*.test.js): it needs a REAL built binary
// (scripts/build-whisper-server.js) + the downloaded ggml model, so it must
// never run in `make run_tests` / CI. The Makefile's single-* glob already
// excludes it.
//
// Usage:   node scripts/smoke-whisper-mem.js [optional/path/to/phrase.wav]
//   - No path -> a deterministic synthetic tone (plumbing + gate check only).
//   - A short real spoken-phrase WAV (16 kHz mono) -> also an accuracy check.
//
// Exit codes (non-zero is eyeballable, never blocks CI):
//   0  PASS   (silence gate holds; with a real phrase WAV, a non-empty transcript)
//   1  REVIEW (silence not gated, or a real phrase produced an empty transcript)
//   2  ENGINE DOWN (binary missing, or the server would not start)
//   3  MODEL MISSING (ggml weights not downloaded yet — the keyless waive path)
//   4  unexpected error

try { require('dotenv').config(); } catch (_) { /* dotenv optional */ }

const fs = require('fs');
const { execFileSync } = require('child_process');
const config = require('../src/core/config');
const WhisperServerManager = require('../src/core/whisper-server.manager');
const { makeToneWav, wrapWav } = require('./smoke-whisper');

const EXIT = { PASS: 0, REVIEW: 1, ENGINE_DOWN: 2, MODEL_MISSING: 3, ERROR: 4 };

function line() { console.log('─'.repeat(64)); }
const ms = (n) => (n == null ? 'n/a' : `${Math.round(n)} ms`);
const asMb = (kb) => (kb == null ? 'n/a' : `${(kb / 1024).toFixed(0)} MB`);

// ~2 s of digital silence (16 kHz mono, zero PCM) — the no_speech gate should
// drop it entirely (a repeatable proxy for the SC5 2-minute always-on run).
function makeSilenceWav({ ms: durMs = 2000, sampleRate = 16000 } = {}) {
  const samples = Math.round((durMs / 1000) * sampleRate);
  return wrapWav(Buffer.alloc(samples * 2), sampleRate); // Buffer.alloc = zeros
}

// Resident-set-size (KB) of a pid via `ps` — best-effort, never throws.
function rssKb(pid) {
  if (!pid) return null;
  try {
    const kb = parseInt(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim(), 10);
    return Number.isFinite(kb) ? kb : null;
  } catch (_) { return null; }
}

// Best-effort RSS of the resident VLM (ollama serve) so a human sees both
// engines coexist in the memory budget. Missing ollama must not fail the smoke.
function ollamaRssKb() {
  try {
    const pid = execFileSync('pgrep', ['-f', 'ollama'], { encoding: 'utf8' }).trim().split('\n')[0];
    return rssKb(pid);
  } catch (_) { return null; }
}

async function main() {
  const w = config.get('speech.whisper') || {};
  const language = w.language || 'en';

  line();
  console.log('Resident STT latency + memory + silence-gate smoke');
  console.log(`  model: ${w.model || 'small.en'}   language: ${language}   host: ${w.host || '127.0.0.1'}`);
  line();

  const manager = new WhisperServerManager();

  if (!manager.binaryPath) {
    console.error('\nENGINE DOWN: the whisper-server binary was not found.');
    console.error('  Build it first:  node scripts/build-whisper-server.js');
    process.exit(EXIT.ENGINE_DOWN);
  }
  console.log(`✓ binary: ${manager.binaryPath}`);

  if (!manager.modelPresent()) {
    console.error('\nMODEL MISSING: the ggml voice model is not downloaded yet.');
    console.error(`  Expected at:  ${manager._modelPath()}`);
    console.error('  Download it via the app onboarding/settings first, then re-run this smoke.');
    process.exit(EXIT.MODEL_MISSING);
  }
  console.log('✓ model present on disk');

  console.log('\nStarting the resident whisper-server…');
  const status = await manager.start();
  if (!status || !status.serverUp) {
    console.error('\nENGINE DOWN: the whisper-server did not reach a healthy state.');
    console.error(`  status: ${JSON.stringify(status)}`);
    try { await manager.stop(); } catch (_) { /* ignore */ }
    process.exit(EXIT.ENGINE_DOWN);
  }
  console.log(`✓ server up on ${manager.host}:${manager.port} (state=${status.state}, pid=${status.pid || '?'})`);

  try {
    // 1) Per-utterance latency (+ accuracy when a real phrase WAV is given).
    const argPath = process.argv[2];
    let wav;
    let usingRealPhrase = false;
    if (argPath && fs.existsSync(argPath)) {
      wav = fs.readFileSync(argPath);
      usingRealPhrase = true;
      console.log(`\nUsing provided WAV: ${argPath} (${wav.length} bytes)`);
    } else {
      wav = makeToneWav();
      console.log('\nUsing synthetic tone WAV (not speech → transcript likely empty; pass a real phrase WAV for accuracy).');
    }
    const t0 = Date.now();
    const phrase = await manager.transcribe(wav, { language });
    const latencyMs = Date.now() - t0;

    // 2) SC5 silence-gate spot-check: 2 s of silence must gate to empty.
    const silence = makeSilenceWav({ ms: 2000 });
    const sil = await manager.transcribe(silence, { language });
    const silenceGated = !(sil.text && sil.text.trim());

    // 3) Memory budget (Pitfall 2): whisper-server RSS + coexisting VLM RSS.
    const wRss = rssKb(status.pid);
    const oRss = ollamaRssKb();

    line();
    console.log('RESULTS');
    console.log(`  utterance latency (manager.transcribe): ${ms(latencyMs)}`);
    console.log(`  transcript: ${phrase.text ? `“${phrase.text}”` : '(empty)'}   segments: ${phrase.total} total / ${phrase.dropped} dropped (>${manager.noSpeechThreshold})`);
    console.log(`  silence(2 s) gated: ${silenceGated ? 'YES — empty (gate holds)' : `NO — “${sil.text}”`}   segments: ${sil.total} total / ${sil.dropped} dropped`);
    console.log(`  whisper-server RSS: ${asMb(wRss)}   ollama/VLM RSS: ${asMb(oRss)}`);
    if (wRss != null && oRss != null) {
      console.log(`  combined resident STT+VLM: ${asMb(wRss + oRss)} (confirm it fits the ~32 GB budget with no swap)`);
    }
    line();

    const pass = silenceGated && (usingRealPhrase ? !!(phrase.text && phrase.text.trim()) : true);
    if (pass) {
      console.log(usingRealPhrase
        ? `PASS: phrase transcribed in ${ms(latencyMs)}; silence gate holds; memory logged.`
        : `PASS (wiring): round-trip OK in ${ms(latencyMs)}; silence gate holds; memory logged. Pass a real phrase WAV for accuracy.`);
    } else if (!silenceGated) {
      console.log('REVIEW: 2 s of silence was NOT gated to empty — the no_speech/VAD gate needs a look (SC5).');
    } else {
      console.log('REVIEW: a real phrase WAV produced an empty transcript — check the model/audio.');
    }

    await manager.stop();
    process.exit(pass ? EXIT.PASS : EXIT.REVIEW);
  } catch (e) {
    try { await manager.stop(); } catch (_) { /* ignore */ }
    throw e;
  }
}

// Guard so the pure helper can be required side-effect-free.
if (require.main === module) {
  main().catch((err) => {
    console.error('\nUnexpected error running the latency/memory smoke:');
    console.error(`  ${err && err.message ? err.message : err}`);
    process.exit(EXIT.ERROR);
  });
}

module.exports = { makeSilenceWav };
