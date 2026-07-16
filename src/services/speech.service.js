const { spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const logger = require('../core/logger').createServiceLogger('SPEECH');
const config = require('../core/config');
const VadSegmenter = require('../core/vad-segmenter');

let recorder = null;
try {
  recorder = require('node-record-lpcm16');
} catch (error) {
  logger.warn('Local audio recorder dependency unavailable', { error: error.message });
}

class SpeechService extends EventEmitter {
  constructor() {
    super();
    this.isRecording = false;
    this.sessionStartTime = null;
    this.retryCount = 0;
    this.recording = null;
    this.available = false;
    this.provider = 'disabled';
    this.runtimeSettings = {};
    this.segmentTimer = null;
    this.audioProgram = null;
    // Injected by main.js after the resident whisper-server is started (04-03).
    // NEVER constructed here: the module export is a singleton and importing it
    // (including in tests) must never spawn a server.
    this.whisperServerManager = null;

    // Two independent per-channel pipelines (STT-04): the mic renderer path and
    // the macOS system-audio tap path (04-05), each with its own VadSegmenter +
    // buffers + flush serialization so a mic flush in-flight never strands a
    // system utterance and vice-versa. Both SHARE one VAD tuning block (read via
    // the _get*() getters) — do NOT diverge the tuning. The system channel stays
    // dormant until its tap enables it, so the mic-only path is unchanged.
    this.systemChannelEnabled = false;
    this._channels = {
      mic: this._makeChannel('mic'),
      system: this._makeChannel('system'),
    };
    this._resetVadState();

    this.initializeClient();
  }

  /**
   * One independent capture→segment→flush pipeline. Created twice (mic +
   * system). Holds its own VadSegmenter + segment buffers + the
   * inFlight/pendingFlush/pendingFinal serialization so the two channels
   * transcribe independently against the same resident whisper-server. Both
   * channels read ONE shared VAD tuning block (the _get*() getters); the two
   * segmenter instances are intentionally identical for Phase 4. NOTE:
   * system/line-level audio MAY want a per-channel vadEnergyFloor override in a
   * future tuning pass — do NOT diverge now (locked).
   */
  _makeChannel(source) {
    return {
      source,
      segmenter: new VadSegmenter(),
      buffers: [],
      bytes: 0,
      inFlight: false,
      pendingFlush: false,
      pendingFinal: false,
      vadSpeaking: false,
      vadSpeechMs: 0,
      vadLastChunkAt: 0,
    };
  }

  /**
   * Enable/disable the system-audio channel. 04-05's SystemAudioTapManager
   * flips this on once the macOS Core Audio process tap is capturing; until
   * then handleSystemAudioChunk is a no-op and the mic path is the only active
   * pipeline.
   */
  setSystemChannelEnabled(enabled) {
    this.systemChannelEnabled = !!enabled;
  }

  initializeClient() {
    this._cleanup();
    // The resident whisper.cpp engine is the SOLE speech provider now — the
    // former cloud STT SDK and its ~380-line browser-DOM polyfill were removed,
    // so there is no provider selection: STT always initializes the local engine.
    this.provider = 'whisper';
    this.available = false;

    this._initializeWhisperClient();
  }

  /**
   * Inject the started resident whisper-server manager (04-03, STT-01/SC1).
   * main.js hands the singleton in after app.whenReady() →
   * getWhisperServerManager().start(), so the flush seam transcribes against
   * the RESIDENT engine (no per-utterance spawn). Re-evaluates availability +
   * status the moment it lands — the constructor ran at import time, before any
   * manager existed. NEVER constructs a manager here (tests must not spawn).
   */
  setWhisperServerManager(manager) {
    this.whisperServerManager = manager || null;
    if (this.provider === 'whisper') {
      this._initializeWhisperClient();
    }
  }

  _initializeWhisperClient() {
    try {
      // The resident engine IS the whisper provider now (no Python CLI). Read
      // its three health levels and surface three distinct inline messages
      // (Pitfall 4): binary → model → server up. Availability requires the
      // server up AND the model on disk.
      const health = this._whisperResidentHealth();
      this.available = false;

      if (!this.whisperServerManager) {
        // Injected by main.js after app-ready start(); until then the resident
        // engine simply isn't ready. Not an error — degrade quietly.
        this.emit('status', 'Voice engine initializing…');
        return;
      }
      if (!health.binaryPresent) {
        this.emit('status', 'Voice engine unavailable — build the whisper-server binary');
        return;
      }
      if (!health.modelPresent) {
        this.emit('status', 'Voice model missing — download the voice model');
        return;
      }
      if (!health.serverUp) {
        this.emit('status', 'Voice engine down — retry');
        return;
      }

      this.available = true;
      logger.info('Resident Whisper engine ready', {
        model: this._getWhisperModel(),
        language: this._getWhisperLanguage(),
      });
      this.emit('status', 'Local Whisper ready');
    } catch (error) {
      logger.error('Failed to initialize resident Whisper client', {
        error: error.message,
        stack: error.stack,
      });
      this.available = false;
      this.emit('status', 'Local Whisper unavailable');
    }
  }

  /**
   * Synchronous three-level health of the injected resident whisper-server,
   * read straight off the manager's sync surface (resolved binary path,
   * on-disk model, supervisor lifecycle state) so isAvailable()/getStatus()
   * stay synchronous. The level-4 responding probe is async and used only by
   * testConnection().
   */
  _whisperResidentHealth() {
    const mgr = this.whisperServerManager;
    if (!mgr) {
      return { binaryPresent: false, modelPresent: false, serverUp: false };
    }
    let binaryPresent = false;
    let modelPresent = false;
    let serverUp = false;
    try { binaryPresent = !!mgr.binaryPath; } catch (_) { binaryPresent = false; }
    try { modelPresent = typeof mgr.modelPresent === 'function' ? !!mgr.modelPresent() : false; } catch (_) { modelPresent = false; }
    try {
      const s = mgr.supervisor && typeof mgr.supervisor.getStatus === 'function'
        ? mgr.supervisor.getStatus()
        : null;
      serverUp = !!s && (s.state === 'healthy' || s.state === 'adopted');
    } catch (_) { serverUp = false; }
    return { binaryPresent, modelPresent, serverUp };
  }

  /**
   * Start (ambient) listening. STT-03/SC3: main.js auto-calls this from launch
   * so the stream stays open launch→quit; the mic button + Alt+R re-enter it as
   * the interim on/off. IDEMPOTENT: a second call while already recording is a
   * no-op (the `isRecording` guard below), so a double auto-start / mic-button
   * mash can't spawn two capture pipelines. Starting brings up BOTH channels —
   * the mic pipeline (renderer getUserMedia or the native recorder) and, once
   * the 04-05 tap enables it, the system pipeline (its ingest is gated on
   * `isRecording`, so it follows this start/stop too).
   */
  startRecording() {
    try {
      if (!this.available) {
        const errorMsg = `Speech provider "${this.provider}" is not available`;
        logger.error(errorMsg);
        this.emit('error', errorMsg);
        return;
      }

      if (this.isRecording) {
        logger.warn('Recording already in progress');
        return;
      }

      this.sessionStartTime = Date.now();
      this.retryCount = 0;

      this._startWhisperRecording();
    } catch (error) {
      logger.error('Critical error in startRecording', { error: error.message, stack: error.stack });
      this.emit('error', `Speech recognition failed to start: ${error.message}`);
      this.isRecording = false;
    }
  }

  _startWhisperRecording() {
    this._cleanup();
    this.isRecording = true;
    this._resetChannelBuffers();
    this._resetVadState();
    this.emit('recording-started');
    this.emit('status', 'Ambient listening started');

    // Capture microphone audio in the renderer via the Web Audio API on Windows
    // and macOS. Windows lacks the Unix sox/rec/arecord tools node-record-lpcm16
    // needs; macOS would otherwise require a Homebrew `sox` install (not bundled)
    // and a child-process mic that the system TCC prompt can't attribute. The
    // renderer path uses getUserMedia, which macOS prompts for cleanly via the
    // app's NSMicrophoneUsageDescription. Linux keeps the native recorder path.
    this.useRendererCapture = process.platform === 'win32' || process.platform === 'darwin';
    if (this.useRendererCapture) {
      this.emit('status', 'Waiting for microphone audio…');
      // The renderer starts sending chunks once it receives the recording-started event.
      this._startSegmentWatchdog();
      if (global.windowManager) {
        global.windowManager.handleRecordingStarted();
      }
      return;
    }

    this._startMicrophoneCapture();
    this._startSegmentWatchdog();

    if (global.windowManager) {
      global.windowManager.handleRecordingStarted();
    }
  }

  /**
   * Reset the voice-activity-detection state machine. VAD replaces the old
   * fixed-interval segmentation: instead of cutting audio every N seconds
   * (which split sentences mid-word and transcribed silent windows), we
   * accumulate audio while the user is speaking and flush a segment once a
   * natural pause is detected. State is intentionally simple so it works for
   * both the renderer (Web Audio) and native (sox/arecord) capture paths.
   */
  _resetVadState() {
    // Reset the VAD state machine for BOTH channels. The legacy (VAD-disabled)
    // path + watchdog read the per-channel vad* scalars; the full
    // speech/silence/noise-floor/pre-roll state lives in each channel.segmenter.
    for (const channel of Object.values(this._channels)) {
      channel.vadSpeaking = false;      // currently inside an utterance
      channel.vadSpeechMs = 0;          // accumulated voiced audio in this segment
      channel.vadLastChunkAt = 0;       // timestamp of the last ingested chunk
      channel.segmenter.reset();
    }
  }

  /**
   * Reset ONE channel's VAD state + segment buffers for a mid-session re-attach
   * (a mic device swap via the renderer's devicechange handler, or a sleep/wake
   * re-acquire). Drops the truncated partial captured from the now-dead stream
   * rather than transcribing a half-word, and resets the segmenter so the
   * re-acquired stream begins a FRESH utterance. RE-ATTACH-SAFE: if a
   * transcription is in-flight we DELIBERATELY leave the
   * inFlight/pendingFlush/pendingFinal serialization untouched so the running
   * flush completes cleanly — no double-flush, no stranded segment. Never
   * throws (degrade-never-crash).
   */
  resetChannelForReattach(source = 'mic') {
    const channel = this._channels[source];
    if (!channel) {
      return;
    }
    try {
      channel.buffers = [];
      channel.bytes = 0;
      channel.vadSpeaking = false;
      channel.vadSpeechMs = 0;
      channel.vadLastChunkAt = 0;
      channel.segmenter.reset();
    } catch (_) {
      // A reset must never take down the capture pipeline.
    }
  }

  /** Reset the segment buffers + flush serialization for BOTH channels. */
  _resetChannelBuffers() {
    for (const channel of Object.values(this._channels)) {
      channel.buffers = [];
      channel.bytes = 0;
      channel.inFlight = false;
      channel.pendingFlush = false;
      channel.pendingFinal = false;
    }
  }

  /**
   * Lightweight watchdog. Silence is normally detected from incoming chunks
   * (which keep flowing at low energy), but if the capture pipeline stalls
   * mid-utterance we still want to flush what we have. The watchdog also
   * enforces the max-utterance cap as a backstop.
   */
  _startSegmentWatchdog() {
    if (this.segmentTimer) {
      clearInterval(this.segmentTimer);
    }
    this.segmentTimer = setInterval(() => {
      if (!this.isRecording || this.provider !== 'whisper') {
        return;
      }
      // Backstop each channel independently (stall + max-utterance cap).
      for (const channel of Object.values(this._channels)) {
        this._watchdogTickChannel(channel);
      }
    }, 500);
  }

  /** Per-channel watchdog tick: flush a stalled or over-long utterance. */
  _watchdogTickChannel(channel) {
    // The system channel only ticks once its tap is enabled; the mic channel
    // always ticks (mic behaviour unchanged).
    if (channel.source === 'system' && !this.systemChannelEnabled) {
      return;
    }

    // VAD disabled (fallback): preserve the legacy fixed-window behaviour by
    // flushing once the accumulated audio reaches the configured segment size.
    if (!this._isVadEnabled()) {
      if (channel.bytes && channel.vadSpeechMs >= this._getWhisperSegmentMs()) {
        this._endUtteranceFlush(channel);
      }
      return;
    }

    // If we're mid-utterance and no audio has arrived recently, the source may
    // have stalled — flush what we captured rather than holding it forever.
    const sinceLastChunk = channel.vadLastChunkAt ? Date.now() - channel.vadLastChunkAt : 0;
    const stalled = channel.segmenter.speaking && sinceLastChunk > 1500;
    const tooLong = channel.segmenter.speaking && channel.segmenter.speechMs >= this._getMaxUtteranceMs();
    if (stalled || tooLong) {
      this._endUtteranceFlush(channel);
    }
  }

  /**
   * Receive raw 16kHz mono 16-bit PCM audio from the renderer and add it to
   * the current Whisper segment buffer.
   */
  handleAudioChunkFromRenderer(chunk) {
    if (!this.isRecording || this.provider !== 'whisper' || !this.useRendererCapture) {
      return;
    }
    if (!chunk || !chunk.length) {
      return;
    }
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this._ingestWhisperAudio(buffer, this._channels.mic);
  }

  /**
   * Ingest path for the macOS system-audio tap (STT-04). 04-05's
   * SystemAudioTapManager feeds raw 16 kHz mono 16-bit PCM here; gated on
   * recording + systemChannelEnabled so the mic-only path is untouched until
   * the tap lands. Drives the SECOND VadSegmenter + segment pipeline →
   * whisper-server → transcript tagged source:'system'.
   */
  handleSystemAudioChunk(buffer) {
    if (!this.isRecording || this.provider !== 'whisper' || !this.systemChannelEnabled) {
      return;
    }
    if (!buffer || !buffer.length) {
      return;
    }
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    this._ingestWhisperAudio(buf, this._channels.system);
  }

  /**
   * Single ingest path for both capture backends. Runs the VAD state machine:
   * accumulate audio while the user speaks, and flush the segment to Whisper
   * once a natural pause (trailing silence) is detected. Falls back to plain
   * buffering when VAD is disabled.
   */
  _ingestWhisperAudio(buffer, channel = this._channels.mic) {
    if (!buffer || !buffer.length) {
      return;
    }

    if (!this._isVadEnabled()) {
      // Legacy behaviour: the watchdog/max-utterance cap drives flushing.
      channel.buffers.push(buffer);
      channel.bytes += buffer.length;
      channel.vadSpeaking = true;
      channel.vadSpeechMs += this._chunkDurationMs(buffer);
      channel.vadLastChunkAt = Date.now();
      return;
    }

    channel.vadLastChunkAt = Date.now();
    // Building the tuning object from the getters each call preserves the
    // original per-chunk re-read of settings. BOTH channels read this ONE
    // shared tuning block (locked). The channel's segmenter owns the VAD
    // decision and returns an action; buffer storage stays here.
    const action = channel.segmenter.ingest(buffer, {
      energyFloor: this._getVadEnergyFloor(),
      silenceHangoverMs: this._getSilenceHangoverMs(),
      minUtteranceMs: this._getMinUtteranceMs(),
      maxUtteranceMs: this._getMaxUtteranceMs(),
      preRollMs: this._getPreRollMs(),
    });
    for (const buf of action.buffers) {
      channel.buffers.push(buf);
      channel.bytes += buf.length;
    }
    if (action.type === 'flush') {
      this._endUtteranceFlush(channel);
    } else if (action.type === 'discard') {
      // Net-identical to the original push-then-clear: drop the whole segment.
      channel.buffers = [];
      channel.bytes = 0;
    }
  }

  /** Flush the accumulated utterance and reset VAD for the next one. */
  _endUtteranceFlush(channel = this._channels.mic) {
    channel.vadSpeaking = false;
    channel.vadSpeechMs = 0;
    channel.segmenter.endUtterance();
    this._flushWhisperSegment({ final: false }, channel).catch((error) => {
      logger.error('Whisper segment transcription failed', { error: error.message, source: channel.source });
    });
  }

  _chunkDurationMs(buffer) {
    return VadSegmenter.chunkDurationMs(buffer);
  }

  /**
   * Stop (pause) listening — the HONEST interim off switch this phase. Halts
   * BOTH channels: the mic capture is torn down (the renderer stops its
   * getUserMedia tracks on `recording-stopped`; the native recorder is stopped
   * below) and the system-tap ingest is gated off (`handleSystemAudioChunk`
   * no-ops while `isRecording` is false). IDEMPOTENT: a double-stop is a no-op
   * (the guard below). The tap PROCESS itself keeps its 04-05 launch→quit
   * lifecycle — pausing simply discards its samples.
   */
  stopRecording() {
    if (!this.isRecording) {
      return;
    }

    this.isRecording = false;
    const sessionDuration = this.sessionStartTime ? Date.now() - this.sessionStartTime : 0;
    logger.info('Stopping speech recognition session', {
      provider: this.provider,
      sessionDuration: `${sessionDuration}ms`
    });

    this._finalizeWhisperStop();
  }

  async _finalizeWhisperStop() {
    if (this.segmentTimer) {
      clearInterval(this.segmentTimer);
      this.segmentTimer = null;
    }

    if (this.recording) {
      try {
        this.recording.stop();
      } catch (error) {
        logger.error('Error stopping audio recording', { error: error.message });
      }
      this.recording = null;
    }

    try {
      // Finalise BOTH channels. The system channel is empty (no bytes) when its
      // tap is disabled, so this is a no-op there and the mic flush is unchanged.
      await Promise.all(
        Object.values(this._channels).map((channel) =>
          this._flushWhisperSegment({ final: true }, channel)
        )
      );
    } catch (error) {
      logger.error('Final Whisper transcription failed', { error: error.message });
      this.emit('error', `Whisper transcription failed: ${error.message}`);
    } finally {
      this._finalizeStop('Recording stopped');
    }
  }

  _finalizeStop(statusMessage) {
    this._cleanup();
    this.emit('recording-stopped');
    this.emit('status', statusMessage);
    if (global.windowManager) {
      global.windowManager.handleRecordingStopped();
    }
  }

  _cleanup() {
    if (this.segmentTimer) {
      clearInterval(this.segmentTimer);
      this.segmentTimer = null;
    }

    if (this.recording) {
      try {
        this.recording.stop();
      } catch (error) {
        logger.error('Error stopping audio recording', { error: error.message });
      }
      this.recording = null;
    }

    this._resetChannelBuffers();
    this._resetVadState();
    this._audioDataLogged = false;
    this.useRendererCapture = false;
  }

  async testConnection() {
    const mgr = this.whisperServerManager;
    if (!mgr) {
      return { success: false, message: 'Resident voice engine not initialized' };
    }
    try {
      // Level-4 responding probe (the only async health level): confirms the
      // resident server actually answers, not just that its port is open.
      const st = await mgr.getStatus({ probeResponding: true });
      if (!st.binaryPresent) {
        return { success: false, message: 'Voice engine binary not found — build the whisper-server first' };
      }
      if (!st.modelPresent) {
        return { success: false, message: 'Voice model not downloaded yet' };
      }
      if (!st.serverUp) {
        return { success: false, message: 'Voice engine is not running' };
      }
      if (!st.responding) {
        return { success: false, message: 'Voice engine is running but not responding' };
      }
      return { success: true, message: 'Local voice engine is responding' };
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  getStatus() {
    const whisperHealth = this._whisperResidentHealth();
    return {
      provider: this.provider,
      isRecording: this.isRecording,
      isInitialized: !!this.whisperServerManager,
      sessionDuration: this.sessionStartTime ? Date.now() - this.sessionStartTime : 0,
      retryCount: this.retryCount,
      // Three-level resident-engine health (binary / model / server up) so the
      // overlay + settings can surface three distinct voice messages (Pitfall 4).
      whisperHealth,
      effectiveSettings: {
        speechProvider: this.provider,
        whisperModel: this._getWhisperModel(),
        whisperLanguage: this._getWhisperLanguage(),
        whisperSegmentMs: String(this._getWhisperSegmentMs())
      },
      config: {
        whisper: config.get('speech.whisper') || {},
        selectedProvider: this.provider
      }
    };
  }

  isAvailable() {
    // The resident engine is usable only when its server is up AND the model is
    // on disk. Recomputed each call so a mid-session engine-down flips
    // availability off → the overlay shows "voice unavailable" + retry. Typing +
    // screenshot are unaffected.
    const health = this._whisperResidentHealth();
    return !!(health.serverUp && health.modelPresent);
  }

  updateSettings(settings = {}) {
    const speechKeys = ['whisperModel', 'whisperLanguage', 'whisperSegmentMs'];
    let changed = false;

    for (const key of speechKeys) {
      if (Object.prototype.hasOwnProperty.call(settings, key)) {
        this.runtimeSettings[key] = settings[key];
        changed = true;
      }
    }

    if (changed) {
      this.initializeClient();
    }

    return this.getStatus();
  }

  _getWhisperModel() {
    // Default collapsed to the resident engine's ggml model (was Python 'turbo').
    return this._getSetting('whisperModel') || process.env.WHISPER_MODEL || config.get('speech.whisper.model') || 'small.en';
  }

  _getWhisperLanguage() {
    return this._getSetting('whisperLanguage') || process.env.WHISPER_LANGUAGE || config.get('speech.whisper.language') || 'en';
  }

  _getWhisperSegmentMs() {
    const rawValue = this._getSetting('whisperSegmentMs') || process.env.WHISPER_SEGMENT_MS || config.get('speech.whisper.segmentMs') || 4000;
    const parsed = Number(rawValue);
    return Number.isFinite(parsed) ? Math.max(2000, parsed) : 4000;
  }

  _vadNumber(settingKey, envKey, configPath, fallback, min) {
    const raw = this._getSetting(settingKey) || process.env[envKey] || config.get(configPath) || fallback;
    const parsed = Number(raw);
    const value = Number.isFinite(parsed) ? parsed : fallback;
    return typeof min === 'number' ? Math.max(min, value) : value;
  }

  _isVadEnabled() {
    const override = this._getSetting('whisperVadEnabled');
    if (override === false || override === 'false') return false;
    if (override === true || override === 'true') return true;
    if (process.env.WHISPER_VAD_ENABLED === 'false') return false;
    const configured = config.get('speech.whisper.vadEnabled');
    return configured !== false;
  }

  _getSilenceHangoverMs() {
    return this._vadNumber('whisperSilenceHangoverMs', 'WHISPER_SILENCE_HANGOVER_MS', 'speech.whisper.silenceHangoverMs', 700, 200);
  }

  _getMinUtteranceMs() {
    return this._vadNumber('whisperMinUtteranceMs', 'WHISPER_MIN_UTTERANCE_MS', 'speech.whisper.minUtteranceMs', 350, 100);
  }

  _getMaxUtteranceMs() {
    return this._vadNumber('whisperMaxUtteranceMs', 'WHISPER_MAX_UTTERANCE_MS', 'speech.whisper.maxUtteranceMs', 15000, 2000);
  }

  _getPreRollMs() {
    return this._vadNumber('whisperPreRollMs', 'WHISPER_PRE_ROLL_MS', 'speech.whisper.preRollMs', 300, 0);
  }

  _getVadEnergyFloor() {
    return this._vadNumber('whisperVadEnergyFloor', 'WHISPER_VAD_ENERGY_FLOOR', 'speech.whisper.vadEnergyFloor', 0.008, 0.0005);
  }

  _getSetting(key) {
    const value = this.runtimeSettings[key];
    return value === '' ? null : value;
  }

  _startMicrophoneCapture() {
    if (!recorder || typeof recorder.record !== 'function') {
      this.emit('error', 'Local microphone capture dependency is missing. Run npm install to restore speech recording support.');
      return;
    }

    // node-record-lpcm16 only ships two recorder modules: `sox` and `arecord`.
    // `recorder` is the option it actually reads (the old `recordProgram` name
    // was silently ignored, so every attempt fell back to sox). Each entry maps
    // the recorder module to the binary we must verify is on PATH.
    //   - macOS: sox (via Homebrew)
    //   - Linux: arecord (ALSA, usually preinstalled) then sox
    const candidates = process.platform === 'darwin'
      ? [{ recorder: 'sox', bin: 'sox' }]
      : [{ recorder: 'arecord', bin: 'arecord' }, { recorder: 'sox', bin: 'sox' }];
    this._startMicrophoneCaptureWithFallback(candidates);
  }

  /**
   * Whether an audio capture binary is on PATH. node-record-lpcm16 spawns
   * these directly and, when the binary is missing, emits an `error` on its
   * child process with no listener — which would otherwise crash the whole
   * app. We pre-filter to binaries that exist so the library never receives a
   * missing program.
   */
  _audioProgramExists(bin) {
    try {
      const r = spawnSync(
        process.platform === 'win32' ? 'where' : 'which',
        [bin],
        { windowsHide: true, timeout: 4000 }
      );
      return r.status === 0;
    } catch (_) {
      return false;
    }
  }

  _startMicrophoneCaptureWithFallback(candidates) {
    const available = candidates.filter((c) => this._audioProgramExists(c.bin));

    if (available.length === 0) {
      const hint = process.platform === 'darwin'
        ? 'Install one with `brew install sox`.'
        : process.platform === 'linux'
          ? 'Install one with `sudo apt install alsa-utils` (arecord) or `sudo apt install sox`.'
          : 'No supported microphone capture tool was found.';
      logger.warn('No audio capture program available', {
        tried: candidates.map((c) => c.bin),
        platform: process.platform,
      });
      this.isRecording = false;
      this.emit('error', `Microphone capture needs sox or arecord, but none was found. ${hint}`);
      return;
    }

    const queue = [...available];

    const tryNextProgram = () => {
      const candidate = queue.shift();
      if (!candidate) {
        this.isRecording = false;
        this.emit('error', 'Could not start microphone capture with any available audio program');
        return;
      }

      const program = candidate.bin;
      try {
        this.recording = recorder.record({
          sampleRate: 16000,
          sampleRateHertz: 16000,
          channels: 1,
          threshold: 0,
          verbose: false,
          recorder: candidate.recorder,
          silence: '10.0s'
        });

        const stream = this.recording.stream();
        this.audioProgram = program;

        // Guard the spawned child process directly. A spawn failure (e.g. the
        // binary disappeared between our probe and the spawn, or a permission
        // error) emits `error` on the child, which node-record-lpcm16 leaves
        // unhandled — fatal without this listener.
        const child = this.recording.process;
        if (child && typeof child.on === 'function') {
          child.on('error', (error) => {
            logger.error('Audio recording process error', { error: error.message, program });
            if (this.recording) {
              try { this.recording.stop(); } catch (_) { /* ignore */ }
              this.recording = null;
            }
            if (this.isRecording) tryNextProgram();
          });
        }

        stream.on('error', (error) => {
          logger.error('Audio recording stream error', { error: error.message, program });
          if (this.recording) {
            try {
              this.recording.stop();
            } catch (stopError) {
              logger.error('Error stopping failed recording program', { error: stopError.message });
            }
            this.recording = null;
          }

          if (this.isRecording) {
            tryNextProgram();
          }
        });

        stream.on('data', (chunk) => {
          this._handleAudioChunk(chunk);
        });
      } catch (error) {
        logger.error('Failed to start microphone capture program', { program, error: error.message });
        tryNextProgram();
      }
    };

    tryNextProgram();
  }

  _handleAudioChunk(chunk) {
    if (!chunk || !chunk.length || !this.isRecording) {
      return;
    }
    this._ingestWhisperAudio(Buffer.from(chunk), this._channels.mic);
  }

  async _flushWhisperSegment({ final }, channel = this._channels.mic) {
    if (channel.inFlight) {
      // A flush was requested while a transcription is still running. Record
      // that we owe a follow-up flush for ANY request (not just a final one),
      // otherwise an utterance that ended mid-transcription stays stranded in
      // the buffer until the next utterance ends or the session stops. Track
      // final-ness separately so a queued stop still finalises correctly. This
      // serialization is PER CHANNEL: a mic flush in-flight never strands a
      // system utterance and vice-versa.
      channel.pendingFlush = true;
      if (final) {
        channel.pendingFinal = true;
      }
      return;
    }

    if (!channel.bytes) {
      return;
    }

    const audioBuffer = Buffer.concat(channel.buffers, channel.bytes);
    channel.buffers = [];
    channel.bytes = 0;

    channel.inFlight = true;

    try {
      // STT-01/SC1: transcribe against the RESIDENT whisper-server — no
      // per-utterance process/model spawn, no cold-start. Build the 16 kHz mono
      // WAV and POST it through the injected manager (/inference verbose_json,
      // which drops no_speech_prob > 0.6 segments — the SECOND of the three
      // gates). Engine-down degrades to '' (no crash); there is NO Python
      // fallback (that path is deleted).
      let transcript = '';
      const mgr = this.whisperServerManager;
      if (mgr && typeof mgr.transcribe === 'function') {
        const wav = this._createWavBuffer(audioBuffer);
        const result = await mgr.transcribe(wav, { language: this._getWhisperLanguage() });
        transcript = result && typeof result.text === 'string' ? result.text : '';
      } else {
        logger.warn('Resident Whisper engine unavailable; dropping segment (no fallback)');
      }
      const clean = transcript ? transcript.trim() : '';
      // THIRD gate: the phrase-list hallucination filter still guards
      // emit('transcription') (VAD segmenter → no_speech_prob>0.6 → this).
      // Tag every transcript with its channel so the sink can thread
      // source:'mic'|'system' end-to-end (Phase 6 consumes the tag; Phase 4
      // only preserves it).
      if (clean && !this._isHallucinatedTranscript(clean)) {
        this.emit('transcription', { text: clean, source: channel.source });
      } else if (clean) {
        logger.debug('Dropped likely Whisper silence hallucination', { transcript: clean, source: channel.source });
      }
    } finally {
      channel.inFlight = false;

      if (channel.pendingFlush) {
        channel.pendingFlush = false;
        const runFinal = channel.pendingFinal;
        channel.pendingFinal = false;
        await this._flushWhisperSegment({ final: runFinal }, channel);
      }
    }
  }

  /**
   * Whisper reliably hallucinates a small set of stock phrases when fed near-
   * silence or non-speech audio (training-data artifacts from video captions).
   * VAD already prevents most silent flushes; this is the final guard so these
   * phantom phrases never reach the chat or the LLM.
   */
  _isHallucinatedTranscript(text) {
    const normalized = text.toLowerCase().replace(/[\s.,!?¡¿"'`]+/g, ' ').trim();
    if (!normalized) {
      return true;
    }
    const HALLUCINATIONS = new Set([
      'thank you',
      'thank you for watching',
      'thanks for watching',
      'thank you so much for watching',
      'please subscribe',
      'like and subscribe',
      'you',
      'bye',
      'bye bye',
      'okay',
      'ok',
      'so',
      'the end',
      'subtitles by the amara org community'
    ]);
    return HALLUCINATIONS.has(normalized);
  }

  _createWavBuffer(rawPcmBuffer) {
    const header = Buffer.alloc(44);
    const sampleRate = 16000;
    const channels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    const blockAlign = channels * (bitsPerSample / 8);

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + rawPcmBuffer.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(rawPcmBuffer.length, 40);

    return Buffer.concat([header, rawPcmBuffer]);
  }
}

module.exports = new SpeechService();
