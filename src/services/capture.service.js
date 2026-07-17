const { desktopCapturer, screen } = require('electron');
const logger = require('../core/logger').createServiceLogger('CAPTURE');
const config = require('../core/config');
const { grayscaleFromBgra, dhash, hamming, blackStats } = require('../core/frame-dedup');

class CaptureService {
  constructor() {
    this.isProcessing = false;

    // Continuous capture loop state (CONT-04). The loop holds the newest
    // deduped frame; Phase 6 pulls it via getLatestFrame() at pause time.
    this._captureTimer = null;
    this._loopBusy = false;
    this._paused = false;
    this._lastHash = null;
    this.latestFrame = null;
    this._blackStreak = 0;
    this._frameStatsListener = null;
  }

  listDisplays() {
    try {
      const displays = screen.getAllDisplays().map(d => ({
        id: d.id,
        bounds: d.bounds,
        size: d.size,
        scaleFactor: d.scaleFactor,
        rotation: d.rotation,
        touchSupport: d.touchSupport || 'unknown'
      }));
      return { success: true, displays };
    } catch (error) {
      logger.error('Failed to list displays', { error: error.message });
      return { success: false, error: error.message };
    }
  }

  /**
   * Capture screenshot and return an image buffer.
   * options: { displayId?: number, area?: { x, y, width, height } }
   */
  async captureAndProcess(options = {}) {
    if (this.isProcessing) throw new Error('Capture already in progress');
    this.isProcessing = true;
    const startTime = Date.now();
    try {
      const { image, metadata } = await this.captureScreenshot(options);

      // Crop if area specified
      let finalImage = image;
      if (options.area && this._isValidArea(options.area)) {
        try {
          finalImage = image.crop(options.area);
        } catch (e) {
          logger.warn('Crop failed, returning full image', { error: e.message, area: options.area });
        }
      }

      const buffer = finalImage.toPNG();
      logger.logPerformance('Screenshot capture', startTime, {
        bytes: buffer.length,
        dimensions: finalImage.getSize()
      });

      return {
        imageBuffer: buffer,
        mimeType: 'image/png',
        metadata: {
          timestamp: new Date().toISOString(),
          source: metadata,
          processingTime: Date.now() - startTime
        }
      };
    } finally {
      this.isProcessing = false;
    }
  }

  async captureScreenshot(options = {}) {
    const targetDisplay = this._getTargetDisplay(options.displayId);
    const { width, height } = targetDisplay.size || { width: 1920, height: 1080 };

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height }
    });

    if (sources.length === 0) {
      throw new Error('No screen sources available for capture');
    }

    // Find source matching the target display by comparing sizes as heuristic
    let source = sources[0];
    const match = sources.find(s => {
      const size = s.thumbnail.getSize();
      return size.width === width && size.height === height;
    });
    if (match) source = match;

    const image = source.thumbnail;
    if (!image) throw new Error('Failed to capture screen thumbnail');

    logger.debug('Screenshot captured successfully', {
      sourceName: source.name,
      imageSize: image.getSize()
    });

    return {
      image,
      metadata: {
        displayId: targetDisplay.id,
        sourceName: source.name,
        dimensions: image.getSize(),
        captureTime: new Date().toISOString()
      }
    };
  }

  _getTargetDisplay(displayId) {
    const all = screen.getAllDisplays();
    if (!all || all.length === 0) return screen.getPrimaryDisplay();
    if (displayId == null) return screen.getPrimaryDisplay();
    const found = all.find(d => d.id === displayId);
    return found || screen.getPrimaryDisplay();
  }

  _isValidArea(area) {
    return area && Number.isFinite(area.x) && Number.isFinite(area.y) &&
      Number.isFinite(area.width) && Number.isFinite(area.height) &&
      area.width > 0 && area.height > 0;
  }

  // --- Continuous capture loop (CONT-04) ------------------------------------
  // A 2s tick captures the primary display directly at downscaled resolution
  // (thumbnailSize), dedups via perceptual hash (idle screen => hash-only
  // cost, no encode), and holds the newest JPEG as `latestFrame`. Nothing is
  // pushed to the model per-capture — the Phase-6 orchestrator pulls.

  /** Start the tick loop. Idempotent — a second call is a no-op. */
  startContinuousCapture() {
    if (this._captureTimer) return;
    this._paused = false;
    const intervalMs = config.get('capture.intervalMs') || 2000;
    this._captureTimer = setInterval(() => this._tick().catch(e =>
      logger.warn('Continuous capture tick failed', { error: e.message })), intervalMs);
    logger.info('Continuous capture started', { intervalMs });
  }

  /** Stop the tick loop entirely (app quit). */
  stopContinuousCapture() {
    if (!this._captureTimer) return;
    clearInterval(this._captureTimer);
    this._captureTimer = null;
    logger.info('Continuous capture stopped');
  }

  /** Pause ticks without tearing down the timer (screen lock / sleep). */
  pauseContinuousCapture() {
    this._paused = true;
    logger.debug('Continuous capture paused');
  }

  /** Resume ticks after unlock / wake. */
  resumeContinuousCapture() {
    this._paused = false;
    logger.debug('Continuous capture resumed');
  }

  /**
   * Newest deduped frame, or null until the first capture.
   * @returns {{ buffer: Buffer, mimeType: string, timestamp: number,
   *             hash: string, dimensions: { width: number, height: number } } | null}
   */
  getLatestFrame() {
    return this.latestFrame;
  }

  /** Consecutive all-black-frame count (SEC-02 TCC cross-check consumes). */
  getBlackStreak() {
    return this._blackStreak;
  }

  /**
   * SEC-02 seam: `fn({ isBlack, streak })` is invoked on every tick that
   * actually captures a frame.
   */
  setFrameStatsListener(fn) {
    this._frameStatsListener = fn;
  }

  /**
   * Capture the primary display at the downscale target — requesting the
   * scaled size via thumbnailSize IS the downscale-before-encode step.
   */
  async _captureDownscaled() {
    const display = screen.getPrimaryDisplay();
    const { width: dw, height: dh } = display.size;
    const scale = Math.min(1, (config.get('capture.longEdgePx') || 1280) / Math.max(dw, dh));
    const thumbnailSize = { width: Math.round(dw * scale), height: Math.round(dh * scale) };
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
    if (!sources || sources.length === 0) {
      throw new Error('No screen sources available for continuous capture');
    }
    // display_id match — the size heuristic breaks under downscaled thumbnails.
    const source = sources.find(s => s.display_id === String(display.id)) || sources[0];
    return source.thumbnail;
  }

  /** One loop tick: capture -> black-stats -> dedup hash -> maybe encode. */
  async _tick() {
    if (this._paused || this._loopBusy || this.isProcessing) return; // yield to single-shot
    this._loopBusy = true;
    try {
      const image = await this._captureDownscaled();
      const tiny = image.resize({ width: 17, height: 16 });
      const luma = grayscaleFromBgra(tiny.toBitmap(), 17, 16);
      const { mean, variance } = blackStats(luma);
      const isBlack = mean < 4 && variance < 2;
      this._blackStreak = isBlack ? this._blackStreak + 1 : 0;
      this._frameStatsListener?.({ isBlack, streak: this._blackStreak });
      const hash = dhash(luma, 16, 16);
      if (this._lastHash && hamming(hash, this._lastHash) <= (config.get('capture.dedupThreshold') ?? 10)) {
        logger.debug('Continuous capture tick skipped (unchanged frame)');
        return; // idle screen: hash-only cost, no encode
      }
      this._lastHash = hash;
      const buffer = image.toJPEG(config.get('capture.jpegQuality') ?? 80);
      this.latestFrame = {
        buffer,
        mimeType: 'image/jpeg',
        timestamp: Date.now(),
        hash: hash.toString('hex'),
        dimensions: image.getSize()
      };
      logger.debug('Continuous capture frame refreshed', {
        bytes: buffer.length,
        dimensions: this.latestFrame.dimensions
      });
    } finally {
      this._loopBusy = false;
    }
  }
}

module.exports = new CaptureService();
