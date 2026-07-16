// WhisperServerManager (STT-01 / SC1) — network-free suite. Models on
// service-supervisor.test.js (DI seams) and local-model-manager.test.js
// (injected supervisor + fake client): no Electron, no real whisper-server, no
// network. Proves the pure logic that must be provably correct — the
// verbose_json segments[] parser + no_speech_prob>0.6 gate (SC5 second gate),
// the multipart/verbose_json request contract, free-port selection, three-level
// health, the conservative thread clamp, and the Mach-O arch verify.
//
// Run with `node --test test/whisper-server-manager.test.js` (or the phase's
// `node --test test/*.test.js`).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WhisperServerManager = require('../src/core/whisper-server.manager');
const { clampThreads, verifyMachO } = WhisperServerManager;
const ServiceSupervisor = require('../src/core/service-supervisor');

// Keep node:test output clean — the manager logs on error paths.
const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

// Fake config exposing only the one key the manager reads (speech.whisper).
function fakeConfig(overrides = {}) {
  const whisper = {
    host: '127.0.0.1',
    port: 0,
    model: 'small.en',
    language: 'en',
    threads: 0,
    noSpeechThreshold: 0.6,
    ...overrides,
  };
  return { get: (k) => (k === 'speech.whisper' ? whisper : undefined) };
}

// Fake supervisor with a fixed status — no real process, no `which` surprises.
function fakeSupervisor(status = { state: 'idle', owned: false, pid: null }) {
  return {
    getStatus: () => status,
    start: async () => status,
    stop: async () => {},
  };
}

// A fetchImpl returning a canned JSON body (mirrors nodeFetch's Response.json()).
function cannedFetch(body, capture) {
  return async (url, init) => {
    if (capture) { capture.url = url; capture.init = init; }
    return { json: async () => body };
  };
}

// ── 1. verbose_json segments[] parser + no_speech_prob>0.6 gate (SC5) ──
test('transcribe drops segments with no_speech_prob > 0.6 and concatenates the survivors', async () => {
  const body = {
    text: 'TOP-LEVEL TEXT THAT MUST BE IGNORED WHEN segments[] EXISTS',
    segments: [
      { id: 0, text: ' Hello', no_speech_prob: 0.05 }, // keep
      { id: 1, text: ' [noise]', no_speech_prob: 0.92 }, // drop (> 0.6)
      { id: 2, text: ' world.', no_speech_prob: 0.1 }, // keep
      { id: 3, text: ' edge', no_speech_prob: 0.6 }, // keep (0.6 is NOT > 0.6)
      { id: 4, text: ' um', no_speech_prob: 0.75 }, // drop (> 0.6)
    ],
  };
  const manager = new WhisperServerManager({
    supervisor: fakeSupervisor(), config: fakeConfig(), logger: noopLogger,
    fetchImpl: cannedFetch(body),
  });

  const r = await manager.transcribe(Buffer.from('RIFFfakewav'), { language: 'en' });
  assert.equal(r.total, 5, 'total = all segments');
  assert.equal(r.dropped, 2, 'the two > 0.6 segments are dropped');
  assert.equal(r.text, 'Hello world. edge', 'survivors concatenated + trimmed; the 0.6 boundary survives');
});

// ── 2. Degrade path: no segments[] → fall back to the top-level .text ──
test('transcribe degrades to the top-level .text when the body has no segments[]', async () => {
  const manager = new WhisperServerManager({
    supervisor: fakeSupervisor(), config: fakeConfig(), logger: noopLogger,
    fetchImpl: cannedFetch({ text: '  just plain text  ' }),
  });

  const r = await manager.transcribe(Buffer.from('RIFF'));
  assert.equal(r.text, 'just plain text');
  assert.equal(r.total, 0);
  assert.equal(r.dropped, 0);
});

// ── 3. Request contract: multipart/form-data to /inference with verbose_json ──
test('transcribe POSTs multipart verbose_json to /inference (never the ambient fetch)', async () => {
  const cap = {};
  const manager = new WhisperServerManager({
    supervisor: fakeSupervisor(), config: fakeConfig(), logger: noopLogger,
    fetchImpl: cannedFetch({ segments: [] }, cap),
  });
  manager.port = 54321;

  await manager.transcribe(Buffer.from('RIFFdata'), { language: 'en' });

  assert.equal(cap.url, 'http://127.0.0.1:54321/inference');
  assert.equal(cap.init.method, 'POST');
  assert.match(cap.init.headers['Content-Type'], /^multipart\/form-data; boundary=/);
  const bodyStr = cap.init.body.toString('latin1');
  assert.match(bodyStr, /name="response_format"\r\n\r\nverbose_json/, 'verbose_json is REQUIRED for no_speech_prob');
  assert.match(bodyStr, /name="language"\r\n\r\nen/);
  assert.match(bodyStr, /name="temperature"\r\n\r\n0/);
  assert.match(bodyStr, /name="file"; filename="segment.wav"/);
  assert.ok(bodyStr.includes('RIFFdata'), 'the WAV bytes are in the file part');
});

// ── 4. Free-port selection: numeric port → both spawn args AND supervisor healthCheck ──
test('start() picks a free numeric port and threads them into args + supervisor healthCheck', async () => {
  const origThreadsEnv = process.env.WHISPER_THREADS;
  delete process.env.WHISPER_THREADS; // make the configured threads deterministic
  const manager = new WhisperServerManager({
    supervisor: fakeSupervisor({ state: 'healthy', owned: true, pid: 4242 }),
    config: fakeConfig({ threads: 3 }),
    logger: noopLogger,
  });
  try {
    await manager.start();
    assert.equal(typeof manager.port, 'number');
    assert.ok(manager.port > 0, 'a real ephemeral port was selected');

    const args = manager.def.args;
    const portIdx = args.indexOf('--port');
    assert.ok(portIdx >= 0, '--port present in the spawn args');
    assert.equal(args[portIdx + 1], String(manager.port), 'the selected port is in the args');
    assert.equal(args[args.indexOf('--host') + 1], '127.0.0.1');
    assert.ok(args.includes('-m'), 'the model path is passed with -m');
    assert.equal(args[args.indexOf('-t') + 1], '3', 'configured threads passed');

    assert.equal(manager.def.healthCheck.port, manager.port, 'the same port reaches the supervisor healthCheck');
  } finally {
    if (origThreadsEnv === undefined) delete process.env.WHISPER_THREADS;
    else process.env.WHISPER_THREADS = origThreadsEnv;
  }
});

// ── 4b. The owned manager shares its def BY REFERENCE with the real supervisor,
// so the port/args mutated at start() are exactly what the child is spawned with.
test('an owned manager hands the SAME def object to the real ServiceSupervisor', () => {
  const manager = new WhisperServerManager({ config: fakeConfig(), logger: noopLogger, spawn: () => {} });
  assert.ok(manager.supervisor instanceof ServiceSupervisor);
  assert.equal(manager.supervisor.def, manager.def, 'supervisor holds the manager def by reference');
  assert.equal(manager.def.adopt, false, 'whisper-server is own-only (adopt:false)');
  assert.equal(manager.def.terminate.sigtermGraceMs, 5000);
  assert.ok(manager.def.pidFile.endsWith('.whisper-server.pid'));
});

// ── 5. Three-level health: server up (state) + model present (disk file) ──
test('getStatus reports serverUp + modelPresent when healthy and the model file exists', async () => {
  const modelFile = path.join(os.tmpdir(), `ggml-present-${process.pid}-${Date.now()}.bin`);
  fs.writeFileSync(modelFile, 'weights');
  const manager = new WhisperServerManager({
    supervisor: fakeSupervisor({ name: 'whisper-server', state: 'healthy', owned: true, pid: 99 }),
    config: fakeConfig(), logger: noopLogger,
  });
  manager._modelPath = () => modelFile;
  try {
    const st = await manager.getStatus();
    assert.equal(st.serverUp, true, 'supervisor healthy → server up');
    assert.equal(st.modelPresent, true, 'model .bin present on disk');
    assert.equal(st.state, 'healthy');
    assert.equal(st.pid, 99);
    assert.equal(st.responding, false, 'responding not probed by default (cheap path)');
  } finally {
    fs.rmSync(modelFile, { force: true });
  }
});

test('getStatus reports modelPresent:false when the model file is absent', async () => {
  const manager = new WhisperServerManager({
    supervisor: fakeSupervisor({ state: 'healthy', owned: true, pid: 1 }),
    config: fakeConfig(), logger: noopLogger,
  });
  manager._modelPath = () => path.join(os.tmpdir(), `ggml-absent-${process.pid}-${Math.random()}.bin`);
  const st = await manager.getStatus();
  assert.equal(st.serverUp, true);
  assert.equal(st.modelPresent, false);
});

// ── 5b. A responding-probe failure must NEVER flip serverUp false (independent levels) ──
test('getStatus keeps serverUp true when the responding probe throws', async () => {
  const manager = new WhisperServerManager({
    supervisor: fakeSupervisor({ state: 'healthy', owned: true, pid: 7 }),
    config: fakeConfig(), logger: noopLogger,
  });
  manager.port = 65000;
  const origProbe = ServiceSupervisor.probeHttp;
  ServiceSupervisor.probeHttp = async () => { throw new Error('responding probe blew up'); };
  try {
    const st = await manager.getStatus({ probeResponding: true });
    assert.equal(st.serverUp, true, 'a responding-probe failure must not flip serverUp false');
    assert.equal(st.responding, false);
  } finally {
    ServiceSupervisor.probeHttp = origProbe;
  }
});

// ── 6. Thread clamp: clamp(floor(cores*0.5), 2, 8) boundaries ──
test('clampThreads = clamp(floor(cores * 0.5), 2, 8)', () => {
  assert.equal(clampThreads(0), 2, 'guard: 0 cores → floor of the [2,8] range');
  assert.equal(clampThreads(1), 2, 'floor(0.5)=0 → 2');
  assert.equal(clampThreads(2), 2, 'floor(1)=1 → 2');
  assert.equal(clampThreads(4), 2, 'floor(2)=2 → 2');
  assert.equal(clampThreads(8), 4, 'floor(4)=4');
  assert.equal(clampThreads(12), 6, 'floor(6)=6');
  assert.equal(clampThreads(16), 8, 'floor(8)=8');
  assert.equal(clampThreads(32), 8, 'floor(16)=16 → clamped down to 8');
});

test('_resolveThreads prefers WHISPER_THREADS, then config, then the auto clamp', () => {
  const manager = new WhisperServerManager({
    supervisor: fakeSupervisor(), config: fakeConfig({ threads: 5 }), logger: noopLogger,
  });
  const orig = process.env.WHISPER_THREADS;
  delete process.env.WHISPER_THREADS;
  try {
    assert.equal(manager._resolveThreads(), 5, 'non-zero config threads honored');
    process.env.WHISPER_THREADS = '7';
    assert.equal(manager._resolveThreads(), 7, 'env overrides config');
  } finally {
    if (orig === undefined) delete process.env.WHISPER_THREADS;
    else process.env.WHISPER_THREADS = orig;
  }
});

test('_resolveThreads falls back to the auto clamp [2,8] when threads=0 (auto)', () => {
  const manager = new WhisperServerManager({
    supervisor: fakeSupervisor(), config: fakeConfig({ threads: 0 }), logger: noopLogger,
  });
  const orig = process.env.WHISPER_THREADS;
  delete process.env.WHISPER_THREADS;
  try {
    const n = manager._resolveThreads();
    assert.ok(Number.isInteger(n) && n >= 2 && n <= 8, `auto clamp within [2,8], got ${n}`);
  } finally {
    if (orig !== undefined) process.env.WHISPER_THREADS = orig;
  }
});

// ── 7. Mach-O arch verify: garbage rejected, valid host-arch accepted ──
test('verifyMachO accepts a valid host-arch Mach-O and rejects garbage/wrong-arch', () => {
  assert.equal(verifyMachO(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7])).ok, false, 'garbage magic rejected');
  assert.equal(verifyMachO(Buffer.from([0xcf, 0xfa])).ok, false, 'too-short buffer rejected');

  const good = Buffer.alloc(32);
  good.writeUInt32LE(0xfeedfacf, 0); // MH_MAGIC_64
  good.writeUInt32LE(process.arch === 'arm64' ? 0x0100000c : 0x01000007, 4);
  const res = verifyMachO(good);
  assert.equal(res.ok, true, 'valid host-arch Mach-O accepted');
  assert.equal(res.arch, process.arch);

  // Explicit expectedArch → host-independent wrong-arch rejection.
  const arm = Buffer.alloc(32);
  arm.writeUInt32LE(0xfeedfacf, 0);
  arm.writeUInt32LE(0x0100000c, 4);
  assert.equal(verifyMachO(arm, 'arm64').ok, true, 'arm64 magic accepted for arm64');
  assert.equal(verifyMachO(arm, 'x64').ok, false, 'arm64 magic rejected for x64');

  // Fat/universal binary carries every slice → accepted regardless of arch.
  const fat = Buffer.alloc(32);
  fat.writeUInt32BE(0xcafebabe, 0);
  assert.equal(verifyMachO(fat, 'arm64').ok, true, 'fat/universal binary accepted');
});

// ── 8. Guide-install/build path: no binary + owned supervisor → not-installed, no spawn ──
test('start() returns not-installed (never spawns) when the binary is absent and we own the supervisor', async () => {
  const manager = new WhisperServerManager({
    config: fakeConfig(), logger: noopLogger,
    spawn: () => { throw new Error('must not spawn when the binary is absent'); },
  });
  manager._ownsSupervisor = true;
  manager.binaryPath = null;

  const st = await manager.start();
  assert.equal(st.reason, 'not-installed');
  assert.equal(st.binaryPresent, false);
  assert.equal(st.serverUp, false);
});
