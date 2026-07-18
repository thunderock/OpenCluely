'use strict';

/**
 * Pure perceptual-hash + frame-stat math for the continuous capture loop
 * (CONT-04). Zero Electron/fs dependencies so `node --test` covers it under
 * bare node — the capture service feeds it `nativeImage.toBitmap()` output.
 *
 * Pipeline per tick: downscaled frame -> tiny 17x16 resize -> BGRA bitmap ->
 * grayscaleFromBgra -> { dhash + hamming (dedup), blackStats (TCC signal) }.
 */

/**
 * Convert a BGRA pixel buffer to a luma (grayscale) array.
 *
 * Electron's `nativeImage.toBitmap()` on macOS yields BGRA byte order:
 * b = buf[i*4], g = buf[i*4+1], r = buf[i*4+2], a = buf[i*4+3].
 *
 * @param {Buffer|Uint8Array} buffer - BGRA bytes, length >= width*height*4.
 * @param {number} width - pixel width.
 * @param {number} height - pixel height.
 * @returns {Uint8Array} luma array of length width*height
 *   (luma = round(0.299*R + 0.587*G + 0.114*B), 0..255).
 */
function grayscaleFromBgra(buffer, width, height) {
  const px = width * height;
  const luma = new Uint8Array(px);
  for (let i = 0; i < px; i++) {
    const b = buffer[i * 4];
    const g = buffer[i * 4 + 1];
    const r = buffer[i * 4 + 2];
    luma[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  return luma;
}

/**
 * Difference hash (dHash) over a tiny luma image.
 *
 * The input luma MUST be (hashW+1) x hashH row-major — one extra column so
 * each of the hashW horizontal comparisons per row has a right neighbor
 * (defaults: 17x16 = 272 px). Bit k (row-major x,y) is 1 when
 * luma[y*(hashW+1)+x] > luma[y*(hashW+1)+x+1], packed MSB-first.
 *
 * @param {Uint8Array} luma - (hashW+1)*hashH luma values.
 * @param {number} [hashW=16] - hash width in bits per row.
 * @param {number} [hashH=16] - hash height in rows.
 * @returns {Buffer} hashW*hashH/8 bytes (32 bytes for the 16x16 default).
 */
function dhash(luma, hashW = 16, hashH = 16) {
  const out = Buffer.alloc((hashW * hashH) / 8);
  const rowW = hashW + 1;
  let k = 0;
  for (let y = 0; y < hashH; y++) {
    for (let x = 0; x < hashW; x++) {
      if (luma[y * rowW + x] > luma[y * rowW + x + 1]) {
        out[k >> 3] |= 0x80 >> (k & 7);
      }
      k++;
    }
  }
  return out;
}

/**
 * Hamming distance (differing-bit count) between two equal-length hashes.
 *
 * @param {Buffer|Uint8Array} a
 * @param {Buffer|Uint8Array} b
 * @returns {number} popcount of a XOR b.
 * @throws {TypeError} if lengths differ (programmer error, not runtime input).
 */
function hamming(a, b) {
  if (a.length !== b.length) {
    throw new TypeError(`hamming: hash lengths differ (${a.length} vs ${b.length})`);
  }
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    let x = a[i] ^ b[i];
    while (x !== 0) {
      dist += x & 1;
      x >>= 1;
    }
  }
  return dist;
}

/**
 * Mean and variance of a luma array — the all-black-frame signal for the
 * SEC-02 TCC cross-check (revoked screen capture yields uniform black:
 * mean ~ 0, variance ~ 0). Plain full-array math; the 272-px tick input is
 * tiny, so no sampling.
 *
 * @param {Uint8Array} luma - luma values (0..255).
 * @returns {{ mean: number, variance: number }}
 */
function blackStats(luma) {
  const n = luma.length;
  if (n === 0) {
    return { mean: 0, variance: 0 };
  }
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += luma[i];
  }
  const mean = sum / n;
  let sqSum = 0;
  for (let i = 0; i < n; i++) {
    const d = luma[i] - mean;
    sqSum += d * d;
  }
  return { mean, variance: sqSum / n };
}

module.exports = { grayscaleFromBgra, dhash, hamming, blackStats };
