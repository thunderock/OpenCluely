'use strict';

// Resident STT loopback smoke (STT-01/SC1 — the first end-to-end proof of the
// mic /inference path). This is the scriptable half of "resident transcription
// works": it starts the supervised whisper-server, POSTs a known 16 kHz mono
// WAV through the SAME manager.transcribe() the flush seam uses (which hits
// POST /inference?response_format=verbose_json and applies the no_speech_prob
// gate), and logs wall-clock latency + the per-segment no_speech_prob values.
//
// KEYLESS + LOOPBACK-ONLY: no API key, no cloud, no network beyond the local
// whisper-server on 127.0.0.1. It talks ONLY to the app's own resident engine.
//
// WHY it lives in scripts/ (not test/*.test.js): it needs a REAL built binary
// (scripts/build-whisper-server.js, 04-01) + the downloaded ggml model, so it
// must never run in `make run_tests` / CI. The Makefile's single-* glob
// (`test/*.test.js`) already excludes it — this file is intentionally NOT a
// test-glob file.
//
// Usage:   node scripts/smoke-whisper.js [optional/path/to/phrase.wav]
//   - No path  -> a deterministic synthetic 16 kHz mono WAV is generated (no
//     deps). A synthetic tone is NOT speech, so the no_speech gate will likely
//     drop it (empty gated text) — that still proves the round-trip + verbose_json
//     parsing + the gate wiring. For an ACCURACY check (non-empty transcript),
//     pass a short real spoken-phrase WAV (16 kHz mono).
//
// Exit codes (non-zero is eyeballable, never blocks CI — not a test-glob file):
//   0  PASS  (round-trip OK; with a real phrase WAV, a non-empty transcript)
//   1  REVIEW (ran, but a real phrase WAV produced an empty transcript)
//   2  ENGINE DOWN (binary missing, or the server would not start)
//   3  MODEL MISSING (ggml weights not downloaded yet)
//   4  unexpected error

// Load .env so config + the manager see the same WHISPER_* / SPEECH_PROVIDER the
// app uses (config/manager read process.env at require time).
try { require('dotenv').config(); } catch (_) { /* dotenv optional */ }

const fs = require('fs');
const crypto = require('crypto');
const config = require('../src/core/config');
const WhisperServerManager = require('../src/core/whisper-server.manager');
const { nodeFetch } = require('../src/core/local-transport');

const EXIT = { PASS: 0, REVIEW: 1, ENGINE_DOWN: 2, MODEL_MISSING: 3, ERROR: 4 };

function line() { console.log('─'.repeat(64)); }
const ms = (n) => (n == null ? 'n/a' : `${Math.round(n)} ms`);

// ── Deterministic synthetic 16 kHz mono 16-bit WAV (pure Node, no deps) ──

function wrapWav(pcm, sampleRate = 16000) {
  const header = Buffer.alloc(44);
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// A short amplitude-enveloped tone (deterministic). Not speech — it exercises
// the plumbing + the no_speech gate, not transcription accuracy.
function makeToneWav({ ms: durMs = 1200, freq = 220, amplitude = 0.2, sampleRate = 16000 } = {}) {
  const samples = Math.round((durMs / 1000) * sampleRate);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const env = Math.sin((Math.PI * i) / samples); // fade in/out (no click)
    const v = Math.round(amplitude * env * Math.sin((2 * Math.PI * freq * i) / sampleRate) * 32767);
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2);
  }
  return wrapWav(pcm, sampleRate);
}

// ── Raw /inference verbose_json probe (loopback) so we can LOG the per-segment
// no_speech_prob values the manager's gate consumes but does not surface. ──

function buildMultipart(boundary, wav, fields) {
  const CRLF = '\r\n';
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`,
    ));
  }
  parts.push(Buffer.from(
    `--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="smoke.wav"${CRLF}`
    + `Content-Type: audio/wav${CRLF}${CRLF}`,
  ));
  parts.push(wav);
  parts.push(Buffer.from(`${CRLF}--${boundary}--${CRLF}`));
  return Buffer.concat(parts);
}

async function rawVerboseJson({ host, port, wav, language }) {
  const boundary = `----OpenCluelySmoke${crypto.randomBytes(6).toString('hex')}`;
  const body = buildMultipart(boundary, wav, {
    response_format: 'verbose_json',
    language,
    temperature: '0',
  });
  const res = await nodeFetch(`http://${host}:${port}/inference`, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.length),
    },
    body,
  });
  return res.json();
}

// ── Main ──

async function main() {
  const w = config.get('speech.whisper') || {};
  const language = w.language || 'en';

  line();
  console.log('Resident STT loopback smoke — POST /inference?response_format=verbose_json');
  console.log(`  model: ${w.model || 'small.en'}   language: ${language}   host: ${w.host || '127.0.0.1'}`);
  line();

  const manager = new WhisperServerManager();

  if (!manager.binaryPath) {
    console.error('\nENGINE DOWN: the whisper-server binary was not found.');
    console.error('  Build it first:  node scripts/build-whisper-server.js');
    console.error('  (dev builds land it at resources/bin/whisper-server; Phase 8 packages it.)');
    process.exit(EXIT.ENGINE_DOWN);
  }
  console.log(`✓ binary: ${manager.binaryPath}`);

  if (!manager.modelPresent()) {
    console.error('\nMODEL MISSING: the ggml voice model is not downloaded yet.');
    console.error(`  Expected at:  ${manager._modelPath()}`);
    console.error('  Download it via the app onboarding/settings, or:');
    console.error("    node -e \"require('./src/core/whisper-model-downloader')"
      + ".prototype && new (require('./src/core/whisper-model-downloader'))()"
      + ".download('small.en',{onProgress:p=>process.stdout.write('\\r'+p.percent+'%')}).then(r=>console.log('\\n',r))\"");
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
  console.log(`✓ server up on 127.0.0.1:${manager.port} (state=${status.state})`);

  // Load a known WAV: a real spoken-phrase file (accuracy check) or the
  // deterministic synthetic tone (plumbing + gate check).
  const argPath = process.argv[2];
  let wav;
  let usingRealPhrase = false;
  if (argPath && fs.existsSync(argPath)) {
    wav = fs.readFileSync(argPath);
    usingRealPhrase = true;
    console.log(`Using provided WAV: ${argPath} (${wav.length} bytes)`);
  } else {
    wav = makeToneWav();
    console.log(`Using synthetic ${wav.length}-byte 16 kHz mono WAV `
      + '(tone, not speech → the no_speech gate will likely drop it; pass a real phrase WAV for accuracy).');
  }

  try {
    // 1) The REAL app path: the same manager.transcribe() the flush seam calls.
    const t0 = Date.now();
    const result = await manager.transcribe(wav, { language });
    const latencyMs = Date.now() - t0;

    // 2) Raw verbose_json (loopback) so we can log the no_speech_prob values.
    let noSpeechProbs = [];
    let rawSegments = 0;
    let rawText = '';
    try {
      const raw = await rawVerboseJson({ host: manager.host, port: manager.port, wav, language });
      if (raw && Array.isArray(raw.segments)) {
        rawSegments = raw.segments.length;
        noSpeechProbs = raw.segments.map((s) => s.no_speech_prob);
      }
      if (raw && typeof raw.text === 'string') rawText = raw.text.trim();
    } catch (e) {
      console.warn(`  (raw verbose_json probe failed — no_speech_prob unavailable: ${e.message})`);
    }

    line();
    console.log('RESULTS');
    console.log(`  wall-clock latency (manager.transcribe): ${ms(latencyMs)}`);
    console.log(`  gated transcript: ${result.text ? `“${result.text}”` : '(empty)'}`);
    console.log(`  segments: ${result.total} total, ${result.dropped} dropped by the no_speech gate (>${manager.noSpeechThreshold})`);
    console.log(`  raw verbose_json: ${rawSegments} segment(s)${rawText ? `, text “${rawText.slice(0, 80)}”` : ''}`);
    console.log(`  no_speech_prob values: ${noSpeechProbs.length ? noSpeechProbs.map((p) => (typeof p === 'number' ? p.toFixed(3) : String(p))).join(', ') : 'n/a'}`);
    line();

    // Round-trip is the wiring assertion: we got a parseable verbose_json
    // response (segments[] or top-level text) back from /inference.
    const roundTripOk = rawSegments > 0 || rawText !== '' || result.total > 0 || typeof result.text === 'string';
    const gotText = !!(result.text && result.text.trim());
    const pass = roundTripOk && (usingRealPhrase ? gotText : true);

    if (pass) {
      console.log(usingRealPhrase
        ? `PASS: resident /inference transcribed the phrase in ${ms(latencyMs)}.`
        : `PASS (wiring): resident /inference round-trip OK in ${ms(latencyMs)} — verbose_json parsed + no_speech gate applied. `
          + 'Pass a real phrase WAV for a transcript-accuracy check.');
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

// Guard execution so the pure helpers can be required side-effect-free.
if (require.main === module) {
  main().catch((err) => {
    console.error('\nUnexpected error running the resident STT smoke:');
    console.error(`  ${err && err.message ? err.message : err}`);
    process.exit(EXIT.ERROR);
  });
}

module.exports = { makeToneWav, wrapWav, buildMultipart };
