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

// ── 8. Regression (ollama-not-detected): serverUp must NOT depend on global fetch ──
// The 2026-07-14 logs show the daemon ADOPTED (the supervisor's Node-http probe
// succeeded → state:'adopted') while getStatus().serverUp was false at the SAME
// instant/process — because _probeVersion used the ambient global `fetch`, whose
// transport in the Electron MAIN process (Chromium net stack) fails for the
// loopback daemon that Node's http reaches fine. A reachable daemon must count as
// running regardless of the global fetch, so the probe must use a deterministic
// Node http transport (mirroring the supervisor's probeHttp).
test('getStatus().serverUp stays true when the daemon is HTTP-reachable but global fetch is broken', async () => {
  const port = await getFreePort();
  const daemon = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ version: '0.32.0' })); // Ollama /api/version shape
  });
  await new Promise((resolve) => daemon.listen(port, '127.0.0.1', resolve));

  // Reproduce the Electron main-process condition without a network: the global
  // fetch is unusable, but the daemon answers over Node http on loopback.
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('fetch failed (Electron main net stack)'); };

  const manager = new LocalModelManager({
    supervisor: fakeSupervisor({ name: 'ollama', state: 'adopted', owned: false, pid: null }),
    ollama: inertOllama(),
    logger: noopLogger,
  });
  manager.host = `http://127.0.0.1:${port}`; // point the version probe at the test daemon

  try {
    const st = await manager.getStatus();
    assert.equal(st.serverUp, true, 'a reachable daemon must count as running regardless of global fetch');
  } finally {
    globalThis.fetch = origFetch;
    await new Promise((resolve) => daemon.close(resolve));
  }
});

// A faithful, hermetic proxy for the Azure Speech SDK browser-DOM shim that
// speech.service.js installs at main.js startup (speech.service.js:293-308,354):
// it replaces global.URL with a class that parses ANY input to
// { hostname:'localhost', port:'', protocol:'https:' } and has no searchParams.
class FakeBrowserURL {
  constructor(href) {
    this.href = href;
    this.protocol = 'https:';
    this.host = 'localhost';
    this.hostname = 'localhost';
    this.port = '';
    this.pathname = '/';
    this.search = '';
    // NB: no `searchParams` — mirrors the real shim.
  }
  toString() { return this.href; }
}

// ── 9. Regression (ollama-not-detected, DEEPER root cause): serverUp must
// survive the Azure polyfill poisoning global.URL. The prior fix probes over
// Node http but parsed this.host with the *global* URL; under the shim that
// yields hostname 'localhost' + empty port, so probeHttp targets localhost:443
// instead of 127.0.0.1:<port> → false. _probeVersion must parse with the NATIVE
// node:url URL so a reachable daemon reports serverUp regardless of the global.
test('getStatus().serverUp stays true when the Azure polyfill has poisoned global.URL', async () => {
  const port = await getFreePort();
  const daemon = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ version: '0.32.0' }));
  });
  await new Promise((resolve) => daemon.listen(port, '127.0.0.1', resolve));

  const manager = new LocalModelManager({
    supervisor: fakeSupervisor({ name: 'ollama', state: 'adopted', owned: false, pid: null }),
    ollama: inertOllama(),
    logger: noopLogger,
  });
  manager.host = `http://127.0.0.1:${port}`;

  // Poison AFTER construction so this isolates _probeVersion's CALL-TIME URL
  // parsing (independent of any constructor-time global repair): the probe must
  // use the native URL even while the ambient global URL is the browser shim.
  const origURL = globalThis.URL;
  globalThis.URL = FakeBrowserURL;
  try {
    const st = await manager.getStatus();
    assert.equal(st.serverUp, true, 'a reachable daemon must be serverUp even under a poisoned global URL');
  } finally {
    globalThis.URL = origURL;
    await new Promise((resolve) => daemon.close(resolve));
  }
});

// ── 10. getStatus() guard: a downstream model-probe failure must NEVER flip
// serverUp false (three independent health levels). Once the server is proven
// reachable, an exception from the model probe is swallowed, not propagated.
test('getStatus() keeps serverUp true when a downstream model probe throws', async () => {
  const manager = new LocalModelManager({
    supervisor: fakeSupervisor({ name: 'ollama', state: 'adopted', owned: false, pid: null }),
    ollama: inertOllama(),
    logger: noopLogger,
  });
  manager._probeVersion = async () => true; // server reachable
  manager._isModelPresent = async () => { throw new Error('model probe blew up'); };

  const st = await manager.getStatus();
  assert.equal(st.serverUp, true, 'a model-probe failure must never flip serverUp false');
  assert.equal(st.modelPresent, false);
  assert.equal(st.modelResponds, false);
});

// ── 11. "Probing" hang: _modelResponds must be hard-bounded, never blocking on a
// cold model load. The old probe did a full ollama.generate() with no timeout, so
// getStatus() (onboarding/status poll) sat on "Probing" for tens of seconds while
// the 10 GB model cold-loaded. The liveness ping must return within its timeout.
test('_modelResponds returns false (never hangs) when the model generate stalls', { timeout: 3000 }, async () => {
  const manager = new LocalModelManager({
    supervisor: fakeSupervisor({ state: 'adopted', owned: false, pid: null }),
    ollama: {
      list: async () => ({ models: [] }),
      pull: async () => (async function* () {})(),
      generate: () => new Promise(() => {}), // never resolves — simulates a cold-loading model
    },
    logger: noopLogger,
  });

  const started = Date.now();
  const responds = await manager._modelResponds('qwen3-vl:8b', { timeoutMs: 80 });
  assert.equal(responds, false, 'a stalled generate resolves false, not a hang');
  assert.ok(Date.now() - started < 1500, 'bounded by timeoutMs, not the never-resolving generate');
});

// ── 12. Liveness ping is CHEAP: think:false (no qwen3 reasoning) + num_predict:1
// (no full decode) — so even when the model does respond, the probe is a ping.
test('_modelResponds issues a cheap liveness ping (think:false, num_predict:1)', async () => {
  let seen = null;
  const manager = new LocalModelManager({
    supervisor: fakeSupervisor({ state: 'adopted', owned: false, pid: null }),
    ollama: {
      list: async () => ({ models: [] }),
      pull: async () => (async function* () {})(),
      generate: async (opts) => { seen = opts; return {}; },
    },
    logger: noopLogger,
  });

  const responds = await manager._modelResponds('qwen3-vl:8b');
  assert.equal(responds, true);
  assert.ok(seen, 'generate was called');
  assert.equal(seen.think, false, 'think disabled so qwen3 emits no reasoning');
  assert.equal(seen.options && seen.options.num_predict, 1, 'decode capped at a single token');
});

// ── 13. Fast detection path: getStatus({ probeResponds:false }) reports
// serverUp/modelPresent WITHOUT a model generate — the serverUp-gated onboarding
// detect (onboarding.js runOllamaDetect) uses it so it never triggers a generate.
test('getStatus({ probeResponds:false }) reports server/model health without any generate', async () => {
  let generated = false;
  const manager = new LocalModelManager({
    supervisor: fakeSupervisor({ name: 'ollama', state: 'adopted', owned: false, pid: null }),
    ollama: {
      list: async () => ({ models: [{ name: 'qwen3-vl:8b' }] }),
      pull: async () => (async function* () {})(),
      generate: async () => { generated = true; return {}; },
    },
    logger: noopLogger,
  });
  manager._probeVersion = async () => true;

  const st = await manager.getStatus({ probeResponds: false });
  assert.equal(st.serverUp, true);
  assert.equal(st.modelPresent, true);
  assert.equal(st.modelResponds, false, 'not probed on the fast detection path');
  assert.equal(generated, false, 'no model generate on the detection path (no "Probing" hang)');
});

// ── 14. Binary resolution: the fallback list must cover the official
// ~/.ollama/bin install plus the standard macOS locations, so own-if-started
// finds the binary under Electron's stripped GUI PATH (where `which` fails).
test('_ollamaBinFallbacks covers ~/.ollama/bin and the standard install locations', () => {
  const manager = new LocalModelManager({
    supervisor: fakeSupervisor({ state: 'idle', owned: false, pid: null }),
    ollama: inertOllama(),
    logger: noopLogger,
  });
  const fallbacks = manager._ollamaBinFallbacks();
  const homeBin = path.join(os.homedir(), '.ollama', 'bin', 'ollama');
  assert.ok(fallbacks.includes(homeBin), 'the official ~/.ollama/bin/ollama path is a fallback');
  if (process.platform === 'darwin') {
    assert.ok(fallbacks.includes('/opt/homebrew/bin/ollama'), 'Homebrew (Apple Silicon) path present');
    assert.ok(fallbacks.includes('/usr/local/bin/ollama'), 'Homebrew (Intel)/manual path present');
  }
});

// ── 15. Spawn PATH: Electron's GUI PATH omits /opt/homebrew/bin, so a spawned
// `ollama serve` (and any subprocess it resolves) must run with the standard bin
// dirs PREPENDED to PATH — while preserving the inherited PATH at the tail.
test('the ollama supervisor spawns with bin dirs prepended to PATH (Electron GUI PATH gap)', () => {
  const origPath = process.env.PATH;
  process.env.PATH = '/usr/bin:/bin';
  try {
    // No injected supervisor → the manager builds the real ServiceSupervisor with
    // its internal def, so def.env.PATH is observable. Construction never spawns.
    const manager = new LocalModelManager({ ollama: inertOllama(), logger: noopLogger });
    const envPath = manager.supervisor.def.env.PATH;
    assert.equal(typeof envPath, 'string', 'def.env.PATH is set');
    assert.ok(envPath.endsWith('/usr/bin:/bin'), 'inherited PATH preserved at the tail');
    assert.ok(envPath.length > '/usr/bin:/bin'.length, 'extra bin dirs prepended');
    const dirs = envPath.split(path.delimiter);
    assert.ok(dirs.some((d) => d.endsWith(path.join('.ollama', 'bin'))), '~/.ollama/bin prepended');
    if (process.platform === 'darwin') {
      assert.ok(dirs.includes('/opt/homebrew/bin'), 'Homebrew bin dir prepended');
    }
  } finally {
    process.env.PATH = origPath;
  }
});
