/**
 * Pure voice-activity-detection segmentation state machine.
 *
 * Lifted verbatim from SpeechService so the VAD decision logic can be unit
 * tested without booting the app (SpeechService mutates global.window,
 * try/requires the Azure SDK, and reads config/process.env at import time, so
 * it cannot be required in a test). This module owns ONLY the VAD-decision
 * state — energy/hysteresis/noise-floor adaptation, the pre-roll ring, and
 * speech/silence accumulation. Buffer storage and the Whisper spawn/flush stay
 * in SpeechService; ingest() returns an action telling the caller what to do
 * with each chunk. Nothing here reads config/process.env/child_process — the
 * per-call `tuning` object supplies every threshold.
 */
class VadSegmenter {
  constructor() {
    this.reset();
  }

  /** Full reset — mirrors the VAD-owned half of SpeechService._resetVadState. */
  reset() {
    this.speaking = false;          // currently inside an utterance
    this.speechMs = 0;              // accumulated voiced audio in this segment
    this.silenceMs = 0;             // trailing silence since last voiced chunk
    this.noiseFloor = 0;            // adaptive EMA of background energy
    this.noiseInit = false;         // has the noise floor been seeded
    this.preRoll = [];              // ring of recent pre-speech chunks
    this.preRollBufferedMs = 0;     // duration held in the pre-roll ring
  }

  /** End-of-utterance reset — mirrors the state half of _endUtteranceFlush. */
  endUtterance() {
    this.speaking = false;
    this.speechMs = 0;
    this.silenceMs = 0;
    this.preRoll = [];
    this.preRollBufferedMs = 0;
  }

  /**
   * RMS energy (normalized 0..1) of a 16-bit little-endian PCM buffer. Used as
   * the voice-activity signal.
   */
  static rmsEnergy(buffer) {
    const sampleCount = Math.floor(buffer.length / 2);
    if (sampleCount === 0) {
      return 0;
    }
    let sumSquares = 0;
    for (let i = 0; i < sampleCount; i++) {
      const sample = buffer.readInt16LE(i * 2) / 32768;
      sumSquares += sample * sample;
    }
    return Math.sqrt(sumSquares / sampleCount);
  }

  static chunkDurationMs(buffer) {
    // 16kHz mono 16-bit => 2 bytes/sample => 32 bytes/ms.
    return buffer.length / 32;
  }

  /**
   * Run one chunk through the VAD-enabled decision. `tuning` supplies the
   * per-call thresholds (the caller re-reads settings each chunk so runtime
   * changes take effect): { energyFloor, silenceHangoverMs, minUtteranceMs,
   * maxUtteranceMs, preRollMs }.
   *
   * Returns { type, buffers } where type is one of:
   *   - 'accumulate': push `buffers` onto the current segment (onset prepends
   *     the pre-roll ring + current chunk; mid-utterance appends the chunk).
   *   - 'flush': push `buffers`, then flush the segment (a pause after real
   *     speech, or the max-utterance cap). The caller then calls endUtterance().
   *   - 'discard': drop the whole segment (a pause with no real speech — just
   *     noise). State is reset here; the caller clears its own buffer.
   *   - 'noop': background silence buffered into the pre-roll ring only.
   */
  ingest(buffer, tuning) {
    const chunkMs = VadSegmenter.chunkDurationMs(buffer);
    const energy = VadSegmenter.rmsEnergy(buffer);

    const floor = tuning.energyFloor;
    // Seed / adapt the background noise floor while not actively speaking so
    // the threshold tracks the room rather than a hard-coded constant. Seed
    // conservatively: if the very first chunk is already loud (the user started
    // talking immediately), clamp to the configured floor so a high seed can't
    // push the enter-threshold out of reach and stall VAD for the whole session.
    if (!this.noiseInit) {
      this.noiseFloor = Math.min(energy, floor);
      this.noiseInit = true;
    }
    // Hysteresis: it takes more energy to *start* an utterance than to keep
    // one going, so a brief dip mid-sentence doesn't end it prematurely.
    const enterThreshold = Math.max(floor, this.noiseFloor * 2.5);
    const exitThreshold = Math.max(floor * 0.7, this.noiseFloor * 1.6);
    const isVoiced = this.speaking ? energy >= exitThreshold : energy >= enterThreshold;

    if (!this.speaking) {
      if (isVoiced) {
        // Speech onset: prepend the pre-roll so the first syllable survives.
        this.speaking = true;
        this.speechMs = 0;
        this.silenceMs = 0;
        const buffers = [...this.preRoll, buffer];
        this.preRoll = [];
        this.preRollBufferedMs = 0;
        this.speechMs += chunkMs;
        return { type: 'accumulate', buffers };
      }
      // Background: adapt the noise floor and keep a short pre-roll ring.
      this.noiseFloor = this.noiseFloor * 0.95 + energy * 0.05;
      this.preRoll.push(buffer);
      this.preRollBufferedMs += chunkMs;
      while (this.preRollBufferedMs > tuning.preRollMs && this.preRoll.length > 1) {
        const dropped = this.preRoll.shift();
        this.preRollBufferedMs -= VadSegmenter.chunkDurationMs(dropped);
      }
      return { type: 'noop', buffers: [] };
    }

    // Already speaking: keep capturing (including trailing silence so word
    // endings aren't clipped) and watch for a pause that ends the utterance.
    if (isVoiced) {
      this.speechMs += chunkMs;
      this.silenceMs = 0;
    } else {
      this.silenceMs += chunkMs;
    }

    const pausedLongEnough = this.silenceMs >= tuning.silenceHangoverMs;
    const haveRealSpeech = this.speechMs >= tuning.minUtteranceMs;
    const tooLong = this.speechMs >= tuning.maxUtteranceMs;

    if ((pausedLongEnough && haveRealSpeech) || tooLong) {
      // Flush WITHOUT resetting here — the caller's _endUtteranceFlush() calls
      // endUtterance() after pushing this final chunk to the segment.
      return { type: 'flush', buffers: [buffer] };
    }
    if (pausedLongEnough && !haveRealSpeech) {
      // Just noise (cough/click) with no real speech — discard, don't waste a
      // Whisper spawn or risk a hallucinated transcript. The original pushed
      // this chunk then cleared the whole segment (net empty); returning an
      // empty buffer list + the caller clearing its segment is identical.
      this.speaking = false;
      this.speechMs = 0;
      this.silenceMs = 0;
      return { type: 'discard', buffers: [] };
    }

    return { type: 'accumulate', buffers: [buffer] };
  }
}

module.exports = VadSegmenter;
module.exports.VadSegmenter = VadSegmenter;
