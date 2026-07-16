// WhisperModelDownloader (STT-02/SC2) — network-free suite. No real 488 MB
// download: a FAKE httpGet returns a small known payload, a tiny INJECTED
// checksum table pins that payload's SHA256, and a real temp dir under
// os.tmpdir() backs the cache. Proves checksum pass/fail, HTTP Range resume,
// already-present short-circuit, offline messaging, and disk-full preflight.
//
// Run with `node --test test/whisper-model-downloader.test.js` (or the phase's
// `node --test test/*.test.js`).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const WhisperModelDownloader = require('../src/core/whisper-model-downloader');

// Keep node:test output clean — the downloader logs on error paths.
const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

// A deterministic fixture standing in for `ggml-tiny.en.bin`, plus a tiny
// injectable checksum table pinning its real SHA256 + byte size — so the suite
// never depends on the true 488 MB hash.
const PAYLOAD = Buffer.from('open-cluely-ggml-whisper-fixture-payload-0123456789');
const PAYLOAD_SHA = crypto.createHash('sha256').update(PAYLOAD).digest('hex');
const FIXTURE_CHECKSUMS = {
  'tiny.en': { file: 'ggml-tiny.en.bin', size: PAYLOAD.length, sha256: PAYLOAD_SHA },
};

const tmpDirs = [];
function mkTmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-dl-'));
  tmpDirs.push(d);
  return d;
}
after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  }
});

// Fake transport: async-iterable response with statusCode + headers. Captures
// the request headers (so the resume test can assert the Range header) and
// honors `Range: bytes=N-` by returning a 206 with the tail slice.
function fakeHttpGet(payload, capture = {}) {
  return async (url, { headers } = {}) => {
    capture.calls = (capture.calls || 0) + 1;
    capture.url = url;
    capture.headers = headers || {};
    const range = headers && headers.Range;
    let body = payload;
    let statusCode = 200;
    if (range) {
      const m = /bytes=(\d+)-/.exec(range);
      const start = m ? Number(m[1]) : 0;
      body = payload.subarray(start);
      statusCode = 206;
    }
    return {
      statusCode,
      headers: { 'content-length': String(body.length) },
      async *[Symbol.asyncIterator]() { yield body; },
    };
  };
}

// ── 1. Checksum pass: verified download is atomically renamed + reported installed ──
test('checksum pass: verified payload is atomically renamed to .bin and reported installed', async () => {
  const dir = mkTmp();
  const capture = {};
  const dl = new WhisperModelDownloader({
    dataDir: dir, checksums: FIXTURE_CHECKSUMS, logger: noopLogger, httpGet: fakeHttpGet(PAYLOAD, capture),
  });

  const events = [];
  const res = await dl.download('tiny.en', { onProgress: (p) => events.push(p) });

  assert.equal(res.ok, true);
  assert.equal(res.present, true);

  const bin = dl.modelPath('tiny.en');
  assert.ok(fs.existsSync(bin), 'final .bin exists');
  assert.ok(!fs.existsSync(`${bin}.part`), '.part cleaned up by the atomic rename');
  assert.equal(fs.readFileSync(bin).toString(), PAYLOAD.toString(), 'contents match the payload');

  assert.ok(events.length > 0, 'structured progress emitted');
  const last = events[events.length - 1];
  assert.equal(last.percent, 100);
  assert.equal(last.downloadedBytes, PAYLOAD.length);
  assert.equal(last.totalBytes, PAYLOAD.length);
});

// ── 2. Checksum fail: partial deleted, NOT renamed, .bin absent (partial-not-installed) ──
test('checksum fail: mismatched payload deletes the .part and never creates the .bin', async () => {
  const dir = mkTmp();
  const corrupt = Buffer.from(PAYLOAD);
  corrupt[0] ^= 0xff; // same length, one byte flipped → SHA256 differs
  const dl = new WhisperModelDownloader({
    dataDir: dir, checksums: FIXTURE_CHECKSUMS, logger: noopLogger, httpGet: fakeHttpGet(corrupt),
  });

  const res = await dl.download('tiny.en');

  assert.equal(res.ok, false);
  assert.equal(res.reason, 'checksum-mismatch');
  const bin = dl.modelPath('tiny.en');
  assert.ok(!fs.existsSync(bin), 'a partial file must never masquerade as installed (Pitfall 5)');
  assert.ok(!fs.existsSync(`${bin}.part`), 'the corrupt .part is deleted');
});

// ── 3. Resume offset: a pre-existing .part triggers a Range: bytes=N- request ──
test('resume offset: a pre-existing .part requests Range: bytes=N- and completes', async () => {
  const dir = mkTmp();
  const capture = {};
  const dl = new WhisperModelDownloader({
    dataDir: dir, checksums: FIXTURE_CHECKSUMS, logger: noopLogger, httpGet: fakeHttpGet(PAYLOAD, capture),
  });

  const N = 10;
  fs.mkdirSync(dl.modelDir, { recursive: true });
  const part = `${dl.modelPath('tiny.en')}.part`;
  fs.writeFileSync(part, PAYLOAD.subarray(0, N)); // simulate an interrupted download

  const res = await dl.download('tiny.en');

  assert.equal(capture.headers.Range, `bytes=${N}-`, 'the resume offset is sent as an HTTP Range');
  assert.equal(res.ok, true, 'the resumed download completes and verifies');
  assert.equal(fs.readFileSync(dl.modelPath('tiny.en')).toString(), PAYLOAD.toString());
});

// ── 4. Already-present short-circuit: a verified .bin returns immediately, no fetch ──
test('already-present short-circuit: a verified .bin returns immediately without a fetch', async () => {
  const dir = mkTmp();
  const dl = new WhisperModelDownloader({
    dataDir: dir, checksums: FIXTURE_CHECKSUMS, logger: noopLogger,
    httpGet: async () => { throw new Error('fetch must not run when the model is already present'); },
  });

  fs.mkdirSync(dl.modelDir, { recursive: true });
  fs.writeFileSync(dl.modelPath('tiny.en'), PAYLOAD); // an already-installed, verified model

  const res = await dl.download('tiny.en');

  assert.equal(res.ok, true, 'short-circuits on the verified file (a fetch would have thrown → ok:false)');
  assert.equal(res.present, true);
});

// ── 5. Offline: a connect/DNS error yields the friendly offline message (not a throw) ──
test('offline: a connect error yields a friendly offline message, never a throw', async () => {
  const dir = mkTmp();
  const dl = new WhisperModelDownloader({
    dataDir: dir, checksums: FIXTURE_CHECKSUMS, logger: noopLogger,
    httpGet: async () => {
      const e = new Error('getaddrinfo ENOTFOUND huggingface.co');
      e.code = 'ENOTFOUND';
      throw e;
    },
  });

  const res = await dl.download('tiny.en');

  assert.equal(res.ok, false);
  assert.equal(res.reason, 'offline');
  assert.match(res.message, /offline|connect/i);
  assert.ok(!fs.existsSync(dl.modelPath('tiny.en')), 'no .bin created while offline');
});

// ── 6. Disk-full: a stubbed statfs under the required size blocks before any fetch ──
test('disk-full: a statfs reporting < required space blocks the download before fetching', async () => {
  const dir = mkTmp();
  let fetched = false;
  const dl = new WhisperModelDownloader({
    dataDir: dir, checksums: FIXTURE_CHECKSUMS, logger: noopLogger,
    statfs: () => ({ bavail: 1, bsize: 1 }), // effectively ~1 byte free
    httpGet: async () => { fetched = true; throw new Error('must not fetch when the disk is full'); },
  });

  const res = await dl.download('tiny.en');

  assert.equal(res.ok, false);
  assert.equal(res.reason, 'disk-full');
  assert.equal(res.started, false);
  assert.equal(fetched, false, 'the download is never started');
  assert.ok(!fs.existsSync(dl.modelPath('tiny.en')));
});

// ── 7. Sanity: network-free construction + cache under <dataDir>/.whisper-models ──
test('modelPath resolves under <dataDir>/.whisper-models and construction is network-free', () => {
  const dir = mkTmp();
  const dl = new WhisperModelDownloader({ dataDir: dir, logger: noopLogger });
  const p = dl.modelPath('small.en');
  assert.ok(p.startsWith(path.join(dir, '.whisper-models')), 'cached under <dataDir>/.whisper-models');
  assert.ok(p.endsWith('ggml-small.en.bin'), 'default model filename is ggml-small.en.bin');
});
