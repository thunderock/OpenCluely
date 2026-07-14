// LocalModelManager (PROV-05) — network-free suite. Proves the adopt/own
// lifecycle by reusing the ServiceSupervisor `options.spawn` DI seam (real
// processes via test/fixtures/dummy-service.js, mirroring
// service-supervisor.test.js), and proves pull-progress / warm-up / preflight /
// three-level status with a FAKE `ollama` client. No real Ollama, no network.
//
// Run with `node --test test/local-model-manager.test.js` (or the phase's
// `node --test test/*.test.js`, which excludes the fixture).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const http = require('http');
const os = require('os');
const path = require('path');

const LocalModelManager = require('../src/core/local-model.manager');
const ServiceSupervisor = require('../src/core/service-supervisor');
const { probeHttp } = ServiceSupervisor;

const fixturePath = path.join(__dirname, 'fixtures', 'dummy-service.js');

// Keep node:test output clean — both the manager and the supervisor log.
const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, ms, intervalMs = 20) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return false;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// ── Fake ollama clients (no network) ──

// Inert: methods resolve but carry nothing — used where health is stubbed off.
function inertOllama() {
  return {
    list: async () => ({ models: [] }),
    generate: async () => ({}),
    pull: async () => (async function* () {})(),
  };
}

// list() empty so ensureModel() pulls; pull() yields a mid-download percent then
// success; generate() resolves for the warm-up call.
function pullingOllama() {
  return {
    list: async () => ({ models: [] }),
    generate: async () => ({}),
    pull: async () => (async function* () {
      yield { status: 'downloading', total: 100, completed: 50 };
      yield { status: 'success' };
    })(),
  };
}

// A fake supervisor with a fixed status — used by the non-lifecycle tests so no
// real process (and no `which` lookup surprises) affects the assertions.
function fakeSupervisor(status) {
  return {
    getStatus: () => status,
    start: async () => status,
    stop: async () => {},
  };
}

function dummyDef(port, overrides = {}) {
  return {
    name: 'ollama',
    command: process.execPath,
    args: [fixturePath, String(port), 'ok'],
    healthCheck: { type: 'http', host: '127.0.0.1', port, path: '/', timeoutMs: 300 },
    backoff: { initialDelayMs: 10, multiplier: 2, maxDelayMs: 50, maxRetries: 3 },
    startupTimeoutMs: 3000,
    healthPollMs: 25,
    ...overrides,
  };
}

// ── 1. Adopt-if-present: adopt a foreign daemon; stop() leaves it alive (SC3) ──
test('adopt-if-present: reports adopted and never kills the foreign daemon', async () => {
  const port = await getFreePort();
  const foreign = http.createServer((_req, res) => res.end('ok'));
  await new Promise((resolve) => foreign.listen(port, '127.0.0.1', resolve));

  const supervisor = new ServiceSupervisor(
    dummyDef(port, { command: 'true', args: [], adopt: true }),
    { logger: noopLogger },
  );
  const manager = new LocalModelManager({ supervisor, ollama: inertOllama(), logger: noopLogger });
  manager._probeVersion = async () => false; // keep status assertions network-free

  try {
    const status = await manager.start();
    assert.equal(status.owned, false, 'adopted daemon is not owned');
    assert.equal(status.adopted, true, 'state should be adopted');
    assert.equal(status.state, 'adopted');

    await manager.stop(); // must NOT kill the foreign daemon
    assert.equal(await probeHttp({ port, path: '/', timeoutMs: 300 }), true, 'foreign daemon still alive');
  } finally {
    await new Promise((resolve) => foreign.close(resolve));
  }
});

// ── 2. Own-if-started: spawn via the DI seam; stop() reaps it ──
test('own-if-started: spawns the daemon (owned) and stop() reaps it', async () => {
  const port = await getFreePort();
  const supervisor = new ServiceSupervisor(dummyDef(port, { adopt: true }), { logger: noopLogger });
  const manager = new LocalModelManager({ supervisor, ollama: inertOllama(), logger: noopLogger });
  manager._probeVersion = async () => false;

  let pid;
  try {
    const status = await manager.start();
    assert.equal(status.owned, true, 'started daemon is owned');
    assert.equal(status.state, 'healthy');
    pid = manager.supervisor.getStatus().pid;
    assert.equal(typeof pid, 'number');

    await manager.stop();
    const dead = await waitFor(() => {
      try { process.kill(pid, 0); return false; } catch (_) { return true; }
    }, 1500);
    assert.equal(dead, true, 'owned daemon should be reaped by stop()');
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch (_) { /* already dead */ } }
  }
});

// ── 3. Pull progress: structured { status, percent } then success ──
test('ensureModel pulls a missing model with structured resumable progress', async () => {
  const manager = new LocalModelManager({
    supervisor: fakeSupervisor({ state: 'idle', owned: false, pid: null }),
    ollama: pullingOllama(),
    logger: noopLogger,
  });

  const events = [];
  const res = await manager.ensureModel('qwen3-vl:8b', { onProgress: (p) => events.push(p) });

  assert.equal(res.ok, true);
  assert.equal(res.present, true);

  const downloading = events.find((e) => e.status === 'downloading');
  assert.ok(downloading, 'a downloading progress event was emitted');
  assert.equal(downloading.percent, 50, 'percent = completed/total*100');
  assert.ok(events.some((e) => e.status === 'success'), 'a success event was emitted');
});

// ── 4a. Preflight: returns a shape and never throws ──
test('preflight returns { ramGb, warnings } and never throws', async () => {
  const manager = new LocalModelManager({
    supervisor: fakeSupervisor({ state: 'idle', owned: false, pid: null }),
    ollama: inertOllama(),
    logger: noopLogger,
  });

  const pf = await manager.preflight();
  assert.equal(typeof pf.ramGb, 'number');
  assert.ok(Array.isArray(pf.warnings));
  assert.equal(typeof pf.diskOk, 'boolean');
});

// ── 4b. Preflight: WARNS (never blocks) on low RAM ──
test('preflight warns but does not block on low RAM', async () => {
  const manager = new LocalModelManager({
    supervisor: fakeSupervisor({ state: 'idle', owned: false, pid: null }),
    ollama: inertOllama(),
    logger: noopLogger,
  });

  const origTotalmem = os.totalmem;
  os.totalmem = () => 8 * 1e9; // 8 GB — below the 16 GB floor
  try {
    const pf = await manager.preflight();
    assert.equal(pf.ramGb, 8, 'ramGb reflects the stubbed total memory');
    assert.ok(pf.warnings.some((w) => /memory/i.test(w)), 'a low-memory warning is present');
    assert.equal(pf.ok, false, 'ok=false signals a warning, not a block');
  } finally {
    os.totalmem = origTotalmem;
  }
});

// ── 5. getStatus: owned/adopted + three-level health fields ──
test('getStatus reports owned/adopted and three distinct health levels', async () => {
  const manager = new LocalModelManager({
    supervisor: fakeSupervisor({ name: 'ollama', state: 'healthy', owned: true, pid: 4242, attempt: 0 }),
    ollama: {
      list: async () => ({ models: [{ name: 'qwen3-vl:8b' }] }),
      generate: async () => ({}),
      pull: async () => (async function* () {})(),
    },
    logger: noopLogger,
  });
  manager._probeVersion = async () => true; // version reachable stub

  const st = await manager.getStatus();
  // Three distinct fields so the UI can give three distinct messages.
  assert.equal(st.serverUp, true);
  assert.equal(st.modelPresent, true);
  assert.equal(st.modelResponds, true);
  // Owned vs adopted.
  assert.equal(st.owned, true);
  assert.equal(st.adopted, false);
  assert.equal(st.model, 'qwen3-vl:8b');
});

// ── 6. getStatus short-circuits the model checks when the server is down ──
test('getStatus does not touch the model when the server is down', async () => {
  const manager = new LocalModelManager({
    supervisor: fakeSupervisor({ state: 'failed', owned: true, pid: null }),
    // Throw if the model is queried — proves the serverUp guard short-circuits.
    ollama: {
      list: async () => { throw new Error('list must not be called when server is down'); },
      generate: async () => { throw new Error('generate must not be called when server is down'); },
      pull: async () => (async function* () {})(),
    },
    logger: noopLogger,
  });
  manager._probeVersion = async () => false;

  const st = await manager.getStatus();
  assert.equal(st.serverUp, false);
  assert.equal(st.modelPresent, false);
  assert.equal(st.modelResponds, false);
});

// ── 7. Guide-install: no binary + owned supervisor → not-installed, no spawn ──
test('start() returns not-installed (no spawn) when the ollama binary is absent', async () => {
  const manager = new LocalModelManager({ ollama: inertOllama(), logger: noopLogger });
  // Simulate "binary not resolvable" deterministically.
  manager._ownsSupervisor = true;
  manager.ollamaBin = null;
  manager.supervisor.start = async () => { throw new Error('must not spawn when not installed'); };

  const st = await manager.start();
  assert.equal(st.ok, false);
  assert.equal(st.reason, 'not-installed');
  assert.equal(st.installed, false);
});
