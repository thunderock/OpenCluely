'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const VadSegmenter = require('../src/core/vad-segmenter');

// 16kHz mono 16-bit PCM => 16 samples/ms, 32 bytes/ms. A constant-amplitude
// buffer has RMS energy exactly |amplitude| / 32768, which makes energy
// deterministic and independent of duration.
function pcm(ms, amplitude = 0) {
  const samples = Math.round(ms * 16);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(amplitude, i * 2);
  }
  return buf;
}

// 3277 / 32768 ~= 0.1 — well above the enter threshold for the tuning below.
const LOUD = 3277;

// Tiny deterministic tuning so scenarios reach their transitions in a few
// chunks. energyFloor 0.01 with LOUD ~0.1 clears both enter/exit thresholds.
const TUNING = {
  energyFloor: 0.01,
  silenceHangoverMs: 100,
  minUtteranceMs: 100,
  maxUtteranceMs: 500,
  preRollMs: 40,
};

test('static helpers: chunkDurationMs and rmsEnergy', () => {
  assert.equal(VadSegmenter.chunkDurationMs(pcm(100)), 100);
  assert.equal(VadSegmenter.rmsEnergy(pcm(50, 0)), 0);
  assert.ok(Math.abs(VadSegmenter.rmsEnergy(pcm(20, LOUD)) - 0.1) < 1e-3);
  assert.equal(VadSegmenter.rmsEnergy(Buffer.alloc(0)), 0);
});

test('onset prepends the pre-roll ring', () => {
  const seg = new VadSegmenter();
  // Background silence builds the pre-roll; each returns noop.
  for (let i = 0; i < 3; i++) {
    assert.equal(seg.ingest(pcm(20, 0), TUNING).type, 'noop');
  }
  const action = seg.ingest(pcm(20, LOUD), TUNING);
  assert.equal(action.type, 'accumulate');
  assert.ok(action.buffers.length >= 2, 'pre-roll prepended + current chunk');
  assert.equal(seg.speaking, true);
});

test('flush on pause after real speech includes the final chunk', () => {
  const seg = new VadSegmenter();
  seg.ingest(pcm(50, LOUD), TUNING); // onset -> speechMs 50
  seg.ingest(pcm(50, LOUD), TUNING); // speechMs 100 >= minUtteranceMs

  let flush = null;
  for (let i = 0; i < 20 && !flush; i++) {
    const chunk = pcm(50, 0);
    const action = seg.ingest(chunk, TUNING);
    if (action.type === 'flush') {
      flush = { action, chunk };
    }
  }
  assert.ok(flush, 'expected a flush after the silence hangover');
  assert.ok(flush.action.buffers.includes(flush.chunk), 'final chunk is flushed');
});

test('discard short noise without emitting a segment', () => {
  const seg = new VadSegmenter();
  seg.ingest(pcm(40, LOUD), TUNING); // onset -> speechMs 40 (< minUtteranceMs)

  let discarded = false;
  for (let i = 0; i < 20 && !discarded; i++) {
    const action = seg.ingest(pcm(50, 0), TUNING);
    if (action.type === 'discard') {
      discarded = true;
    }
  }
  assert.ok(discarded, 'expected a discard for sub-minimum noise');
  assert.equal(seg.speaking, false);
});

test('max-utterance flush without a pause', () => {
  const seg = new VadSegmenter();
  seg.ingest(pcm(50, LOUD), TUNING); // onset

  let flushed = false;
  for (let i = 0; i < 30 && !flushed; i++) {
    const action = seg.ingest(pcm(50, LOUD), TUNING); // no silence, ever
    if (action.type === 'flush') {
      flushed = true;
    }
  }
  assert.ok(flushed, 'expected a flush driven by the max-utterance cap');
});

test('endUtterance resets the segment state', () => {
  const seg = new VadSegmenter();
  seg.ingest(pcm(50, LOUD), TUNING); // onset
  let flushed = false;
  for (let i = 0; i < 30 && !flushed; i++) {
    if (seg.ingest(pcm(50, LOUD), TUNING).type === 'flush') {
      flushed = true;
    }
  }
  assert.ok(flushed, 'set up a flush first');
  // Flush does NOT reset — the caller drives endUtterance().
  seg.endUtterance();
  assert.equal(seg.speaking, false);
  assert.equal(seg.speechMs, 0);
  assert.equal(seg.silenceMs, 0);
  assert.equal(seg.preRoll.length, 0);
});
