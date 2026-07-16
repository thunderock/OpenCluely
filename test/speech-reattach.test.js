'use strict';

// Network-free + spawn-free test for the mic-device-change / sleep-wake
// re-attach path on the REAL SpeechService singleton (04-06). The singleton's
// constructor never spawns (whisperServerManager is injected later), so
// importing it here is side-effect-safe. Node's test runner runs each test file
// in its own process, so the Azure DOM polyfill this module installs at import
// stays isolated to this file.
//
// Proves resetChannelForReattach: (1) drops the truncated partial + resets the
// affected channel's VAD, (2) DELIBERATELY leaves an in-flight flush's
// serialization untouched (no double-flush / no stranded segment), (3) is
// per-channel (mic and system are independent), (4) degrades — never throws —
// on an unknown/absent channel.

const { test } = require('node:test');
const assert = require('node:assert');
const speechService = require('../src/services/speech.service');

test('resetChannelForReattach clears the mic channel buffers + VAD state', () => {
  const mic = speechService._channels.mic;
  mic.buffers = [Buffer.alloc(320)];
  mic.bytes = 320;
  mic.vadSpeaking = true;
  mic.vadSpeechMs = 500;
  mic.vadLastChunkAt = Date.now();

  speechService.resetChannelForReattach('mic');

  assert.strictEqual(mic.bytes, 0);
  assert.deepStrictEqual(mic.buffers, []);
  assert.strictEqual(mic.vadSpeaking, false);
  assert.strictEqual(mic.vadSpeechMs, 0);
  assert.strictEqual(mic.vadLastChunkAt, 0);
});

test('resetChannelForReattach preserves in-flight flush serialization (no double-flush)', () => {
  const sys = speechService._channels.system;
  sys.inFlight = true;
  sys.pendingFlush = true;
  sys.pendingFinal = true;
  sys.buffers = [Buffer.alloc(160)];
  sys.bytes = 160;

  speechService.resetChannelForReattach('system');

  // The truncated partial is dropped…
  assert.strictEqual(sys.bytes, 0);
  assert.deepStrictEqual(sys.buffers, []);
  // …but the running flush's serialization is untouched so it completes cleanly.
  assert.strictEqual(sys.inFlight, true);
  assert.strictEqual(sys.pendingFlush, true);
  assert.strictEqual(sys.pendingFinal, true);

  // Restore for isolation between tests.
  sys.inFlight = false;
  sys.pendingFlush = false;
  sys.pendingFinal = false;
});

test('resetChannelForReattach is per-channel (resetting mic never touches system)', () => {
  const sys = speechService._channels.system;
  sys.buffers = [Buffer.alloc(64)];
  sys.bytes = 64;

  speechService.resetChannelForReattach('mic');

  assert.strictEqual(sys.bytes, 64, 'a mic re-attach must not disturb the system channel');

  // cleanup
  sys.buffers = [];
  sys.bytes = 0;
});

test('resetChannelForReattach degrades (never throws) on an unknown / missing channel', () => {
  assert.doesNotThrow(() => speechService.resetChannelForReattach('nope'));
  assert.doesNotThrow(() => speechService.resetChannelForReattach());
});
