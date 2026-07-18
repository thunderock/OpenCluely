'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { grayscaleFromBgra, dhash, hamming, blackStats } = require('../src/core/frame-dedup');

// Default dhash grid is 16x16 bits computed over a (16+1) x 16 = 17x16 luma
// input (272 px). Helpers below build deterministic synthetic luma arrays.
const HASH_W = 16;
const HASH_H = 16;
const ROW_W = HASH_W + 1; // 17
const PX = ROW_W * HASH_H; // 272

/** Horizontal gradient: luma(x, y) = x * 10 — every dhash bit is 0. */
function gradientLuma() {
  const luma = new Uint8Array(PX);
  for (let y = 0; y < HASH_H; y++) {
    for (let x = 0; x < ROW_W; x++) {
      luma[y * ROW_W + x] = x * 10;
    }
  }
  return luma;
}

test('grayscaleFromBgra reads BGRA byte order (blue px -> 29, red px -> 76)', () => {
  // 2x1 image: pixel 0 pure blue (b=255), pixel 1 pure red (r=255).
  const bgra = Buffer.from([255, 0, 0, 255, 0, 0, 255, 255]);
  const luma = grayscaleFromBgra(bgra, 2, 1);
  assert.ok(luma instanceof Uint8Array);
  assert.equal(luma.length, 2);
  // 0.114 * 255 = 29.07 -> 29 ; 0.299 * 255 = 76.245 -> 76
  assert.equal(luma[0], 29);
  assert.equal(luma[1], 76);
});

test('dhash is deterministic and defaults to a 32-byte Buffer', () => {
  const luma = gradientLuma();
  const a = dhash(luma);
  const b = dhash(luma);
  assert.ok(Buffer.isBuffer(a));
  assert.equal(a.length, 32); // 16*16 bits / 8
  assert.ok(a.equals(b), 'same input must hash identically');
});

test('hamming of a hash with itself is 0', () => {
  const h = dhash(gradientLuma(), 16, 16);
  assert.equal(hamming(h, h), 0);
});

test('hamming exceeds threshold when a large region changes', () => {
  const a = gradientLuma();
  const b = gradientLuma();
  // Reverse the gradient across the top half (rows 0-7): every bit in those
  // rows flips 0 -> 1, i.e. 8 rows * 16 bits = 128 differing bits.
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < ROW_W; x++) {
      b[y * ROW_W + x] = (ROW_W - 1 - x) * 10;
    }
  }
  const dist = hamming(dhash(a, 16, 16), dhash(b, 16, 16));
  assert.ok(dist > 10, `expected > 10 differing bits, got ${dist}`);
});

test('hamming tolerates single-pixel noise (cursor blink) within 2 bits', () => {
  const a = gradientLuma();
  const noisy = gradientLuma();
  // One pixel perturbed: affects at most its two neighbor comparisons.
  noisy[5 * ROW_W + 8] += 15;
  const dist = hamming(dhash(a, 16, 16), dhash(noisy, 16, 16));
  assert.ok(dist <= 2, `expected <= 2 differing bits, got ${dist}`);
});

test('hamming throws TypeError on length mismatch', () => {
  assert.throws(() => hamming(Buffer.alloc(32), Buffer.alloc(16)), TypeError);
});

test('blackStats on an all-zero luma array is { mean: 0, variance: 0 }', () => {
  const stats = blackStats(new Uint8Array(PX));
  assert.equal(stats.mean, 0);
  assert.equal(stats.variance, 0);
});

test('blackStats on a high-contrast checkerboard has variance > 1000', () => {
  const luma = new Uint8Array(PX);
  for (let i = 0; i < PX; i++) {
    luma[i] = i % 2 === 0 ? 0 : 255;
  }
  const stats = blackStats(luma);
  assert.ok(stats.variance > 1000, `expected variance > 1000, got ${stats.variance}`);
});
