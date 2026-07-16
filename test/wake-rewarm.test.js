'use strict';

// Network-free + Electron-free unit tests for the sleep/wake re-warm
// orchestrator (04-06, STT-03/SC3 resilience). Proves the guarded sequence is
// re-entrancy-safe, degrade-never-crash with null managers, restarts the
// whisper-server ONLY when down (never interrupts a healthy in-flight
// transcription), reopens the tap ONLY when it was running/granted (respects
// the persisted grant), and always clears the in-flight flag.

const { test } = require('node:test');
const assert = require('node:assert');
const { rewarmAfterWake } = require('../src/core/wake-rewarm');

const noDelay = () => Promise.resolve();
const silentLogger = { info() {}, warn() {}, debug() {}, error() {} };

function baseDeps(overrides = {}) {
  let inFlight = false;
  return {
    isInFlight: () => inFlight,
    setInFlight: (v) => { inFlight = v; },
    getWhisperManager: () => null,
    getTapManager: () => null,
    delay: noDelay,
    settleMs: 0,
    logger: silentLogger,
    ...overrides,
  };
}

test('re-entrancy: skips when a re-warm is already in flight', async () => {
  const deps = baseDeps({
    isInFlight: () => true,
    setInFlight: () => { throw new Error('must not set flag on a skipped re-warm'); },
  });
  const r = await rewarmAfterWake(deps);
  assert.deepStrictEqual(r, { skipped: 'reentrant' });
});

test('degrade-never-crash: null whisper manager + null tap do not throw', async () => {
  const r = await rewarmAfterWake(baseDeps());
  assert.strictEqual(r.whisper, 'noop');
  assert.strictEqual(r.tap, 'noop');
  assert.strictEqual(r.mic, 'noop');
});

test('whisper: a healthy server is a NO-OP (not restarted → no in-flight interruption)', async () => {
  let started = false;
  const mgr = {
    modelPresent: () => true,
    getStatus: async () => ({ serverUp: true }),
    start: async () => { started = true; },
  };
  const r = await rewarmAfterWake(baseDeps({ getWhisperManager: () => mgr }));
  assert.strictEqual(r.whisper, 'healthy');
  assert.strictEqual(started, false, 'a healthy server must not be restarted');
});

test('whisper: a DOWN server is restarted + re-injected into the speech service', async () => {
  let started = false;
  let injected = false;
  const mgr = {
    modelPresent: () => true,
    getStatus: async () => ({ serverUp: false }),
    start: async () => { started = true; },
  };
  const speechService = { setWhisperServerManager: () => { injected = true; } };
  const r = await rewarmAfterWake(baseDeps({ getWhisperManager: () => mgr, speechService }));
  assert.strictEqual(r.whisper, 'restarted');
  assert.ok(started, 'a down server must be restarted');
  assert.ok(injected, 're-injects the manager so the flush seam re-binds');
});

test('whisper: no model on disk → nothing to re-warm (never spawns)', async () => {
  const mgr = {
    modelPresent: () => false,
    getStatus: async () => { throw new Error('should not probe'); },
    start: async () => { throw new Error('should not start'); },
  };
  const r = await rewarmAfterWake(baseDeps({ getWhisperManager: () => mgr }));
  assert.strictEqual(r.whisper, 'no-model');
});

test('whisper: a probe/restart error degrades (does not throw) and still clears the flag', async () => {
  let inFlight = false;
  const mgr = {
    modelPresent: () => true,
    getStatus: async () => { throw new Error('probe boom'); },
  };
  const r = await rewarmAfterWake(baseDeps({
    isInFlight: () => inFlight,
    setInFlight: (v) => { inFlight = v; },
    getWhisperManager: () => mgr,
  }));
  assert.strictEqual(r.whisper, 'error');
  assert.strictEqual(inFlight, false, 'the in-flight flag is always cleared in finally');
});

test('tap: reopened ONLY when it was running/granted (respects the persisted grant)', async () => {
  let startCalls = 0;
  let enabled = null;
  const tap = {
    isSupported: () => true,
    getStatus: () => ({ running: true, granted: true }),
    start: async () => { startCalls++; return { running: true, granted: true }; },
  };
  const r = await rewarmAfterWake(baseDeps({
    getTapManager: () => tap,
    setSystemChannelEnabled: (v) => { enabled = v; },
    onSystemPcm: () => {},
  }));
  assert.strictEqual(r.tap, 'reopened');
  assert.strictEqual(startCalls, 1);
  assert.strictEqual(enabled, true);
});

test('tap: was-off stays off (never force-opens a tap the user never granted)', async () => {
  let startCalls = 0;
  const tap = {
    isSupported: () => true,
    getStatus: () => ({ running: false, granted: false }),
    start: async () => { startCalls++; return {}; },
  };
  const r = await rewarmAfterWake(baseDeps({ getTapManager: () => tap }));
  assert.strictEqual(r.tap, 'was-off');
  assert.strictEqual(startCalls, 0);
});

test('tap: unsupported OS → skipped (no spawn)', async () => {
  const tap = {
    isSupported: () => false,
    getStatus: () => ({}),
    start: async () => { throw new Error('should not start on an unsupported OS'); },
  };
  const r = await rewarmAfterWake(baseDeps({ getTapManager: () => tap }));
  assert.strictEqual(r.tap, 'unsupported');
});

test('tap: a live grant that reopens but degrades reports "degraded" (mic-only baseline)', async () => {
  const tap = {
    isSupported: () => true,
    getStatus: () => ({ running: true, granted: true }),
    start: async () => ({ running: false, granted: false, degraded: true }),
  };
  let enabled = null;
  const r = await rewarmAfterWake(baseDeps({
    getTapManager: () => tap,
    setSystemChannelEnabled: (v) => { enabled = v; },
  }));
  assert.strictEqual(r.tap, 'degraded');
  assert.strictEqual(enabled, false);
});

test('mic: replays the last ambient state via reacquireAmbientMic', async () => {
  let called = 0;
  const r = await rewarmAfterWake(baseDeps({
    reacquireAmbientMic: () => { called++; return 'reacquired'; },
  }));
  assert.strictEqual(r.mic, 'reacquired');
  assert.strictEqual(called, 1);
});

test('full sequence: settle → whisper restart → tap reopen → mic replay, order + flag reset', async () => {
  const order = [];
  let inFlight = false;
  const mgr = {
    modelPresent: () => true,
    getStatus: async () => ({ serverUp: false }),
    start: async () => { order.push('whisper'); },
  };
  const tap = {
    isSupported: () => true,
    getStatus: () => ({ running: true, granted: true }),
    start: async () => { order.push('tap'); return { running: true, granted: true }; },
  };
  const r = await rewarmAfterWake(baseDeps({
    isInFlight: () => inFlight,
    setInFlight: (v) => { inFlight = v; },
    getWhisperManager: () => mgr,
    getTapManager: () => tap,
    speechService: { setWhisperServerManager: () => {} },
    setSystemChannelEnabled: () => {},
    reacquireAmbientMic: () => { order.push('mic'); return 'reacquired'; },
    delay: () => { order.push('settle'); return Promise.resolve(); },
  }));
  assert.deepStrictEqual(order, ['settle', 'whisper', 'tap', 'mic']);
  assert.strictEqual(r.whisper, 'restarted');
  assert.strictEqual(r.tap, 'reopened');
  assert.strictEqual(r.mic, 'reacquired');
  assert.strictEqual(inFlight, false);
});
