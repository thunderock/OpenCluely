// Demo suite for the generic ServiceSupervisor (FND-04). Proves Success
// Criteria 3 and 4 with REAL OS processes spawned against
// test/fixtures/dummy-service.js — spawn+health (both probe types),
// restart-with-backoff after a kill, give-up -> 'failed' without hanging,
// SIGTERM -> SIGKILL reaping a stubborn child, and adopt-if-present leaving a
// foreign process ALIVE after stop().
//
// Run with `node --test test/service-supervisor.test.js` (or the phase's
// `node --test test/*.test.js`, which excludes the fixture).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ServiceSupervisor = require('../src/core/service-supervisor');
const { probePort, probeHttp, computeBackoffDelay } = ServiceSupervisor;

const fixturePath = path.join(__dirname, 'fixtures', 'dummy-service.js');

// Keep node:test output clean — the supervisor logs on every state change.
const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll `predicate` (sync or async, returning truthy) until it passes or `ms`
// elapses. Bounded — never hangs. Preferred over fixed sleeps.
async function waitFor(predicate, ms, intervalMs = 20) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return false;
}

// Grab a free ephemeral loopback port by binding :0, then release it.
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

function baseDef(port, mode, overrides = {}) {
  return {
    name: 'dummy',
    command: process.execPath,
    args: [fixturePath, String(port), mode],
    healthCheck: { type: 'port', host: '127.0.0.1', port, timeoutMs: 300 },
    backoff: { initialDelayMs: 10, multiplier: 2, maxDelayMs: 50, maxRetries: 3 },
    startupTimeoutMs: 3000,
    healthPollMs: 25,
    ...overrides,
  };
}

// ── 1. Backoff math (pure, no spawn) ──
test('computeBackoffDelay is exponential and capped', () => {
  const b = { initialDelayMs: 10, multiplier: 2, maxDelayMs: 50, maxRetries: 3 };
  assert.equal(computeBackoffDelay(0, b), 10);
  assert.equal(computeBackoffDelay(1, b), 20);
  assert.equal(computeBackoffDelay(2, b), 40);
  assert.equal(computeBackoffDelay(3, b), 50); // 80 -> capped at maxDelayMs
});

// ── 2. Both probe types: true against a live server, false (bounded) against a dead port ──
test('probePort and probeHttp resolve true against a live server, false against nothing', async () => {
  const port = await getFreePort();
  const child = spawn(process.execPath, [fixturePath, String(port), 'ok']);
  try {
    const up = await waitFor(() => probePort({ port, timeoutMs: 200 }), 3000);
    assert.equal(up, true, 'fixture should come up');
    assert.equal(await probePort({ host: '127.0.0.1', port, timeoutMs: 200 }), true);
    assert.equal(await probeHttp({ host: '127.0.0.1', port, path: '/', timeoutMs: 200 }), true);

    // Unused port: both probes return false, bounded by timeoutMs (no hang).
    const dead = await getFreePort();
    assert.equal(await probePort({ port: dead, timeoutMs: 200 }), false);
    assert.equal(await probeHttp({ port: dead, path: '/', timeoutMs: 200 }), false);
  } finally {
    child.kill('SIGKILL');
  }
});

// ── 3. Spawn + health -> healthy, owned ──
test('start() spawns the process and reaches healthy (owned=true)', async () => {
  const port = await getFreePort();
  const supervisor = new ServiceSupervisor(baseDef(port, 'ok'), { logger: noopLogger });
  try {
    const status = await supervisor.start();
    assert.equal(status.state, 'healthy');
    assert.equal(typeof status.pid, 'number');
    assert.equal(status.owned, true);
  } finally {
    await supervisor.stop();
  }
});

// ── 4. Restart with backoff after the process is killed (SC3) ──
test('restarts with backoff after a kill and returns to healthy', async () => {
  const port = await getFreePort();
  const supervisor = new ServiceSupervisor(baseDef(port, 'ok'), { logger: noopLogger });
  const states = [];
  supervisor.on('status', (s) => states.push(s.state));
  try {
    await supervisor.start();
    const firstPid = supervisor.getStatus().pid;
    assert.equal(supervisor.getStatus().state, 'healthy');

    process.kill(firstPid, 'SIGKILL'); // simulate an unexpected death

    const recovered = await waitFor(
      () => supervisor.getStatus().state === 'healthy' && supervisor.getStatus().pid !== firstPid,
      6000,
    );
    assert.equal(recovered, true, `never recovered to a fresh healthy process; states=${states.join(',')}`);
    assert.ok(states.includes('restarting'), `expected a 'restarting' state; saw ${states.join(',')}`);
  } finally {
    await supervisor.stop();
  }
});

// ── 5. Give up after maxRetries and surface 'failed' without hanging (SC3) ──
test("gives up after maxRetries and surfaces 'failed' without hanging", async () => {
  const port = await getFreePort();
  const supervisor = new ServiceSupervisor(
    baseDef(port, 'crash', { backoff: { initialDelayMs: 10, multiplier: 2, maxDelayMs: 50, maxRetries: 2 } }),
    { logger: noopLogger },
  );
  try {
    await supervisor.start(); // resolves fast; restart chain runs in the background
    const failed = await waitFor(() => supervisor.getStatus().state === 'failed', 3000);
    assert.equal(failed, true, 'should reach terminal failed state');
    assert.equal(supervisor.getStatus().state, 'failed');
  } finally {
    await supervisor.stop();
  }
});

// ── 6. SIGTERM -> SIGKILL reaps a stubborn child (SC3) ──
test('stop() escalates SIGTERM -> SIGKILL to reap a process that ignores SIGTERM', async () => {
  const port = await getFreePort();
  const supervisor = new ServiceSupervisor(
    baseDef(port, 'ignore-sigterm', { terminate: { sigtermGraceMs: 200 } }),
    { logger: noopLogger },
  );
  let pid;
  try {
    await supervisor.start();
    assert.equal(supervisor.getStatus().state, 'healthy');
    pid = supervisor.getStatus().pid;

    await supervisor.stop(); // SIGTERM ignored -> SIGKILL; awaits reaping before settling
    assert.equal(supervisor.getStatus().state, 'stopped');

    // stop() awaited the post-SIGKILL 'exit', so the child is reaped: kill(pid,0) throws ESRCH.
    const dead = await waitFor(() => {
      try { process.kill(pid, 0); return false; } catch (_) { return true; }
    }, 1000);
    assert.equal(dead, true, 'child should be dead after stop()');
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch (_) { /* already dead */ } }
  }
});

// ── 7. Adopt-if-present never kills a foreign process (SC4) ──
test('adopt: adopts a foreign process and stop() leaves it alive', async () => {
  const port = await getFreePort();
  // A "foreign" server we started ourselves — NOT via the supervisor.
  const foreign = http.createServer((_req, res) => res.end('ok'));
  await new Promise((resolve) => foreign.listen(port, '127.0.0.1', resolve));

  const supervisor = new ServiceSupervisor(
    baseDef(port, 'ok', {
      adopt: true,
      healthCheck: { type: 'http', host: '127.0.0.1', port, path: '/', timeoutMs: 300 },
    }),
    { logger: noopLogger },
  );
  try {
    const status = await supervisor.start();
    assert.equal(status.state, 'adopted');
    assert.equal(status.owned, false);
    assert.equal(status.pid, null, 'adopting must not spawn a child');

    await supervisor.stop(); // must NOT kill the foreign process
    assert.equal(supervisor.getStatus().state, 'stopped');

    // The foreign process is still answering — the SC4 guarantee.
    assert.equal(await probePort({ port, timeoutMs: 300 }), true);
    assert.equal(await probeHttp({ port, path: '/', timeoutMs: 300 }), true);
  } finally {
    await new Promise((resolve) => foreign.close(resolve));
  }
});
