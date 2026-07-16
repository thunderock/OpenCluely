// Enhanced polyfills for Azure Speech SDK in Node.js environment
if (typeof window === 'undefined') {
  global.window = {
    navigator: {
      userAgent: 'Node.js',
      platform: 'node',
      mediaDevices: {
        getUserMedia: () => Promise.resolve({
          getAudioTracks: () => [],
          getTracks: () => [],
          stop: () => {}
        }),
        getSupportedConstraints: () => ({
          audio: true,
          video: false,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: true,
          sampleSize: true,
          channelCount: true
        }),
        enumerateDevices: () => Promise.resolve([
          {
            deviceId: 'default',
            kind: 'audioinput',
            label: 'Default - Microphone',
            groupId: 'default'
          }
        ])
      }
    },
    document: {
      createElement: (tagName) => {
        const element = {
          addEventListener: () => {},
          removeEventListener: () => {},
          setAttribute: () => {},
          getAttribute: () => null,
          style: {},
          tagName: tagName.toUpperCase(),
          nodeType: 1,
          nodeName: tagName.toUpperCase(),
          appendChild: () => {},
          removeChild: () => {},
          insertBefore: () => {},
          cloneNode: () => element,
          hasAttribute: () => false,
          removeAttribute: () => {},
          click: () => {},
          focus: () => {},
          blur: () => {}
        };

        if (tagName.toLowerCase() === 'audio') {
          Object.assign(element, {
            play: () => Promise.resolve(),
            pause: () => {},
            load: () => {},
            canPlayType: () => 'probably',
            volume: 1,
            muted: false,
            paused: true,
            ended: false,
            currentTime: 0,
            duration: 0,
            playbackRate: 1,
            defaultPlaybackRate: 1,
            readyState: 4,
            networkState: 1,
            autoplay: false,
            loop: false,
            controls: false,
            crossOrigin: null,
            preload: 'metadata',
            src: '',
            currentSrc: ''
          });
        }

        return element;
      },
      getElementById: () => null,
      getElementsByTagName: () => [],
      getElementsByClassName: () => [],
      querySelector: () => null,
      querySelectorAll: () => [],
      body: {
        appendChild: () => {},
        removeChild: () => {},
        insertBefore: () => {},
        style: {}
      },
      head: {
        appendChild: () => {},
        removeChild: () => {},
        insertBefore: () => {},
        style: {}
      }
    },
    location: {
      href: 'file:///',
      protocol: 'file:',
      host: '',
      hostname: '',
      port: '',
      pathname: '/',
      search: '',
      hash: '',
      origin: 'file://'
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: global.setTimeout,
    clearTimeout: global.clearTimeout,
    setInterval: global.setInterval,
    clearInterval: global.clearInterval,
    requestAnimationFrame: (callback) => global.setTimeout(callback, 16),
    cancelAnimationFrame: global.clearTimeout,
    console: global.console || {
      log: () => {},
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {}
    },
    AudioContext: class AudioContext {
      constructor() {
        this.state = 'running';
        this.sampleRate = 16000;
        this.currentTime = 0;
        this.listener = {
          setPosition: () => {},
          setOrientation: () => {}
        };
        this.destination = {
          connect: () => {},
          disconnect: () => {},
          channelCount: 2,
          channelCountMode: 'explicit',
          channelInterpretation: 'speakers'
        };
      }
      createMediaStreamSource(stream) {
        return {
          connect: () => {},
          disconnect: () => {},
          mediaStream: stream
        };
      }
      createGain() {
        return {
          connect: () => {},
          disconnect: () => {},
          gain: {
            value: 1,
            setValueAtTime: () => {},
            linearRampToValueAtTime: () => {},
            exponentialRampToValueAtTime: () => {}
          }
        };
      }
      createScriptProcessor(bufferSize = 4096, inputChannels = 1, outputChannels = 1) {
        return {
          connect: () => {},
          disconnect: () => {},
          onaudioprocess: null,
          bufferSize,
          numberOfInputs: inputChannels,
          numberOfOutputs: outputChannels
        };
      }
      createAnalyser() {
        return {
          connect: () => {},
          disconnect: () => {},
          fftSize: 2048,
          frequencyBinCount: 1024,
          minDecibels: -100,
          maxDecibels: -30,
          smoothingTimeConstant: 0.8,
          getByteFrequencyData: () => {},
          getByteTimeDomainData: () => {},
          getFloatFrequencyData: () => {},
          getFloatTimeDomainData: () => {}
        };
      }
      decodeAudioData() {
        return Promise.resolve({
          length: 44100,
          sampleRate: 44100,
          numberOfChannels: 1,
          duration: 1,
          getChannelData: () => new Float32Array(44100)
        });
      }
      suspend() {
        this.state = 'suspended';
        return Promise.resolve();
      }
      resume() {
        this.state = 'running';
        return Promise.resolve();
      }
      close() {
        this.state = 'closed';
        return Promise.resolve();
      }
    },
    webkitAudioContext: class webkitAudioContext {
      constructor() {
        this.state = 'running';
        this.sampleRate = 16000;
        this.currentTime = 0;
        this.listener = {
          setPosition: () => {},
          setOrientation: () => {}
        };
        this.destination = {
          connect: () => {},
          disconnect: () => {},
          channelCount: 2,
          channelCountMode: 'explicit',
          channelInterpretation: 'speakers'
        };
      }
      createMediaStreamSource(stream) {
        return {
          connect: () => {},
          disconnect: () => {},
          mediaStream: stream
        };
      }
      createGain() {
        return {
          connect: () => {},
          disconnect: () => {},
          gain: {
            value: 1,
            setValueAtTime: () => {},
            linearRampToValueAtTime: () => {},
            exponentialRampToValueAtTime: () => {}
          }
        };
      }
      createScriptProcessor(bufferSize = 4096, inputChannels = 1, outputChannels = 1) {
        return {
          connect: () => {},
          disconnect: () => {},
          onaudioprocess: null,
          bufferSize,
          numberOfInputs: inputChannels,
          numberOfOutputs: outputChannels
        };
      }
      createAnalyser() {
        return {
          connect: () => {},
          disconnect: () => {},
          fftSize: 2048,
          frequencyBinCount: 1024,
          minDecibels: -100,
          maxDecibels: -30,
          smoothingTimeConstant: 0.8,
          getByteFrequencyData: () => {},
          getByteTimeDomainData: () => {},
          getFloatFrequencyData: () => {},
          getFloatTimeDomainData: () => {}
        };
      }
      decodeAudioData() {
        return Promise.resolve({
          length: 44100,
          sampleRate: 44100,
          numberOfChannels: 1,
          duration: 1,
          getChannelData: () => new Float32Array(44100)
        });
      }
      suspend() {
        this.state = 'suspended';
        return Promise.resolve();
      }
      resume() {
        this.state = 'running';
        return Promise.resolve();
      }
      close() {
        this.state = 'closed';
        return Promise.resolve();
      }
    },
    URL: class URL {
      constructor(url) {
        this.href = url;
        this.protocol = 'https:';
        this.host = 'localhost';
        this.hostname = 'localhost';
        this.port = '';
        this.pathname = '/';
        this.search = '';
        this.hash = '';
        this.origin = 'https://localhost';
      }
      toString() {
        return this.href;
      }
    },
    Blob: class Blob {
      constructor(parts = [], options = {}) {
        this.size = 0;
        this.type = options.type || '';
        this.parts = parts;
      }
      slice() {
        return new Blob();
      }
      stream() {
        return new ReadableStream();
      }
      text() {
        return Promise.resolve('');
      }
      arrayBuffer() {
        return Promise.resolve(new ArrayBuffer(0));
      }
    },
    File: class File {
      constructor(parts, name, options = {}) {
        this.name = name;
        this.size = 0;
        this.type = options.type || '';
        this.lastModified = Date.now();
        this.parts = parts;
      }
      slice() {
        return new File([], this.name);
      }
      stream() {
        return new ReadableStream();
      }
      text() {
        return Promise.resolve('');
      }
      arrayBuffer() {
        return Promise.resolve(new ArrayBuffer(0));
      }
    }
  };
  global.document = global.window.document;
  global.navigator = global.window.navigator;
  global.AudioContext = global.window.AudioContext;
  global.webkitAudioContext = global.window.webkitAudioContext;
  global.URL = global.window.URL;
  global.Blob = global.window.Blob;
  global.File = global.window.File;

  if (!global.performance) {
    global.performance = {
      now: () => Date.now(),
      mark: () => {},
      measure: () => {},
      clearMarks: () => {},
      clearMeasures: () => {},
      getEntriesByName: () => [],
      getEntriesByType: () => []
    };
  }

  if (!global.crypto) {
    global.crypto = {
      getRandomValues: (arr) => {
        for (let i = 0; i < arr.length; i++) {
          arr[i] = Math.floor(Math.random() * 256);
        }
        return arr;
      }
    };
  }
}

const fs = require('fs');
const { spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const logger = require('../core/logger').createServiceLogger('SPEECH');
const config = require('../core/config');
const VadSegmenter = require('../core/vad-segmenter');

let sdk = null;
try {
  sdk = require('microsoft-cognitiveservices-speech-sdk');
} catch (error) {
  logger.warn('Azure Speech SDK unavailable', { error: error.message });
}

let recorder = null;
try {
  recorder = require('node-record-lpcm16');
} catch (error) {
  logger.warn('Local audio recorder dependency unavailable', { error: error.message });
}

class SpeechService extends EventEmitter {
  constructor() {
    super();
    this.recognizer = null;
    this.isRecording = false;
    this.audioConfig = null;
    this.speechConfig = null;
    this.sessionStartTime = null;
    this.retryCount = 0;
    this.maxRetries = 3;
    this.pushStream = null;
    this.recording = null;
    this.available = false;
    this.provider = 'disabled';
    this.runtimeSettings = {};
    this.segmentBuffers = [];
    this.segmentBytes = 0;
    this.segmentTimer = null;
    this.transcriptionInFlight = false;
    this.pendingFlush = false;
    this.pendingFinal = false;
    this.audioProgram = null;
    // Injected by main.js after the resident whisper-server is started (04-03).
    // NEVER constructed here: the module export is a singleton and importing it
    // (including in tests) must never spawn a server.
    this.whisperServerManager = null;
    this._segmenter = new VadSegmenter();
    this._resetVadState();

    this.initializeClient();
  }

  initializeClient() {
    this._cleanup();
    this.provider = 'disabled';
    this.available = false;
    this.speechConfig = null;

    const provider = this._getConfiguredProvider();
    this.provider = provider;

    if (provider === 'azure') {
      this._initializeAzureClient();
      return;
    }

    if (provider === 'whisper') {
      this._initializeWhisperClient();
      return;
    }

    const reason = 'Speech recognition disabled. Configure Azure or local Whisper.';
    logger.warn(reason);
    this.emit('status', reason);
  }

  _initializeAzureClient() {
    try {
      if (!sdk) {
        throw new Error('Azure Speech SDK dependency is not installed');
      }

      if (!recorder || typeof recorder.record !== 'function') {
        throw new Error('Local microphone recorder dependency is not installed');
      }

      const subscriptionKey = this._getSetting('azureKey') || process.env.AZURE_SPEECH_KEY;
      const region = this._getSetting('azureRegion') || process.env.AZURE_SPEECH_REGION;

      if (!subscriptionKey || !region) {
        const reason = 'Azure Speech credentials not found. Speech recognition disabled.';
        logger.warn('Speech service disabled (missing Azure credentials)');
        this.emit('status', reason);
        return;
      }

      this.speechConfig = sdk.SpeechConfig.fromSubscription(subscriptionKey, region);

      const azureConfig = config.get('speech.azure') || {};
      this.speechConfig.speechRecognitionLanguage = azureConfig.language || 'en-US';
      this.speechConfig.outputFormat = sdk.OutputFormat.Detailed;
      this.speechConfig.setProperty(sdk.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs, '5000');
      this.speechConfig.setProperty(sdk.PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs, '2000');
      this.speechConfig.setProperty(sdk.PropertyId.Speech_SegmentationSilenceTimeoutMs, '2000');

      if (azureConfig.enableDictation) {
        this.speechConfig.enableDictation();
      }

      if (azureConfig.enableAudioLogging) {
        this.speechConfig.enableAudioLogging();
      }

      this.available = true;
      logger.info('Azure Speech service initialized successfully', {
        region,
        language: azureConfig.language || 'en-US'
      });
      this.emit('status', 'Azure Speech Services ready');
    } catch (error) {
      logger.error('Failed to initialize Azure Speech client', {
        error: error.message,
        stack: error.stack
      });
      this.available = false;
      this.emit('status', 'Azure speech unavailable');
    }
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

      if (this.provider === 'azure') {
        this._startAzureRecording();
        return;
      }

      if (this.provider === 'whisper') {
        this._startWhisperRecording();
        return;
      }

      throw new Error(`Unsupported speech provider: ${this.provider}`);
    } catch (error) {
      logger.error('Critical error in startRecording', { error: error.message, stack: error.stack });
      this.emit('error', `Speech recognition failed to start: ${error.message}`);
      this.isRecording = false;
    }
  }

  _startAzureRecording() {
    if (!this.speechConfig) {
      throw new Error('Azure Speech client not initialized');
    }

    this.isRecording = true;
    this.emit('recording-started');
    this.emit('status', 'Azure recording started');
    this._cleanup();

    try {
      this.pushStream = sdk.AudioInputStream.createPushStream();
      this.audioConfig = sdk.AudioConfig.fromStreamInput(this.pushStream);
      this._startMicrophoneCapture();
      this.recognizer = new sdk.SpeechRecognizer(this.speechConfig, this.audioConfig);
    } catch (error) {
      logger.error('Failed to start Azure recording session', { error: error.message });
      this.emit('error', `Audio configuration failed: ${error.message}`);
      this.isRecording = false;
      return;
    }

    this.recognizer.recognizing = (s, e) => {
      try {
        if (e.result.reason === sdk.ResultReason.RecognizingSpeech) {
          this.emit('interim-transcription', e.result.text);
        }
      } catch (error) {
        logger.error('Error in recognizing handler', { error: error.message });
      }
    };

    this.recognizer.recognized = (s, e) => {
      try {
        if (e.result.reason === sdk.ResultReason.RecognizedSpeech && e.result.text && e.result.text.trim()) {
          this.emit('transcription', e.result.text);
        }
      } catch (error) {
        logger.error('Error in recognized handler', { error: error.message });
      }
    };

    this.recognizer.canceled = (s, e) => {
      logger.warn('Recognition session canceled', {
        reason: e.reason,
        errorCode: e.errorCode,
        errorDetails: e.errorDetails
      });

      if (e.reason === sdk.CancellationReason.Error) {
        const details = e.errorDetails || '';
        if (details.includes('1006')) {
          this.emit('error', 'Network connection failed. Please check your internet connection.');
        } else if (details.includes('InvalidServiceCredentials')) {
          this.emit('error', 'Invalid Azure Speech credentials. Please check AZURE_SPEECH_KEY and AZURE_SPEECH_REGION.');
        } else if (details.includes('Forbidden')) {
          this.emit('error', 'Access denied. Please check your Azure Speech service subscription and region.');
        } else if (details.includes('AudioInputMicrophone_InitializationFailure')) {
          this.emit('error', 'Microphone initialization failed. Please check microphone permissions and availability.');
        } else {
          this.emit('error', `Recognition error: ${details}`);
        }
      }

      this.stopRecording();
    };

    this.recognizer.sessionStarted = (s, e) => {
      logger.info('Recognition session started', { sessionId: e.sessionId });
    };

    this.recognizer.sessionStopped = () => {
      this.stopRecording();
    };

    const startTimeout = setTimeout(() => {
      logger.error('Recognition start timeout');
      this.emit('error', 'Speech recognition start timeout. Please try again.');
      this.stopRecording();
    }, 10000);

    this.recognizer.startContinuousRecognitionAsync(
      () => {
        clearTimeout(startTimeout);
        logger.info('Continuous Azure speech recognition started successfully');
        if (global.windowManager) {
          global.windowManager.handleRecordingStarted();
        }
      },
      (error) => {
        clearTimeout(startTimeout);
        logger.error('Failed to start continuous recognition', { error: error.toString() });
        this.emit('error', `Recognition startup failed: ${error}`);
        this.isRecording = false;
        this._cleanup();
      }
    );
  }

  _startWhisperRecording() {
    this._cleanup();
    this.isRecording = true;
    this.segmentBuffers = [];
    this.segmentBytes = 0;
    this.transcriptionInFlight = false;
    this.pendingFlush = false;
    this.pendingFinal = false;
    this._resetVadState();
    this.emit('recording-started');
    this.emit('status', 'Local Whisper recording started');

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
    // Legacy (VAD-disabled) path + watchdog still read these; the full
    // speech/silence/noise-floor/pre-roll state now lives in this._segmenter.
    this.vadSpeaking = false;        // currently inside an utterance
    this.vadSpeechMs = 0;            // accumulated voiced audio in this segment
    this.vadLastChunkAt = 0;         // timestamp of the last ingested chunk
    this._segmenter.reset();
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

      // VAD disabled (fallback): preserve the legacy fixed-window behaviour by
      // flushing once the accumulated audio reaches the configured segment size.
      if (!this._isVadEnabled()) {
        if (this.segmentBytes && this.vadSpeechMs >= this._getWhisperSegmentMs()) {
          this._endUtteranceFlush();
        }
        return;
      }

      // If we're mid-utterance and no audio has arrived recently, the mic may
      // have stalled — flush what we captured rather than holding it forever.
      const sinceLastChunk = this.vadLastChunkAt ? Date.now() - this.vadLastChunkAt : 0;
      const stalled = this._segmenter.speaking && sinceLastChunk > 1500;
      const tooLong = this._segmenter.speaking && this._segmenter.speechMs >= this._getMaxUtteranceMs();
      if (stalled || tooLong) {
        this._endUtteranceFlush();
      }
    }, 500);
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
    this._ingestWhisperAudio(buffer);
  }

  /**
   * Single ingest path for both capture backends. Runs the VAD state machine:
   * accumulate audio while the user speaks, and flush the segment to Whisper
   * once a natural pause (trailing silence) is detected. Falls back to plain
   * buffering when VAD is disabled.
   */
  _ingestWhisperAudio(buffer) {
    if (!buffer || !buffer.length) {
      return;
    }

    if (!this._isVadEnabled()) {
      // Legacy behaviour: the watchdog/max-utterance cap drives flushing.
      this.segmentBuffers.push(buffer);
      this.segmentBytes += buffer.length;
      this.vadSpeaking = true;
      this.vadSpeechMs += this._chunkDurationMs(buffer);
      this.vadLastChunkAt = Date.now();
      return;
    }

    this.vadLastChunkAt = Date.now();
    // Building the tuning object from the getters each call preserves the
    // original per-chunk re-read of settings. The segmenter owns the VAD
    // decision and returns an action; buffer storage stays here.
    const action = this._segmenter.ingest(buffer, {
      energyFloor: this._getVadEnergyFloor(),
      silenceHangoverMs: this._getSilenceHangoverMs(),
      minUtteranceMs: this._getMinUtteranceMs(),
      maxUtteranceMs: this._getMaxUtteranceMs(),
      preRollMs: this._getPreRollMs(),
    });
    for (const buf of action.buffers) {
      this.segmentBuffers.push(buf);
      this.segmentBytes += buf.length;
    }
    if (action.type === 'flush') {
      this._endUtteranceFlush();
    } else if (action.type === 'discard') {
      // Net-identical to the original push-then-clear: drop the whole segment.
      this.segmentBuffers = [];
      this.segmentBytes = 0;
    }
  }

  /** Flush the accumulated utterance and reset VAD for the next one. */
  _endUtteranceFlush() {
    this.vadSpeaking = false;
    this.vadSpeechMs = 0;
    this._segmenter.endUtterance();
    this._flushWhisperSegment({ final: false }).catch((error) => {
      logger.error('Whisper segment transcription failed', { error: error.message });
    });
  }

  _chunkDurationMs(buffer) {
    return VadSegmenter.chunkDurationMs(buffer);
  }

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

    if (this.provider === 'azure' && this.recognizer) {
      try {
        this.recognizer.stopContinuousRecognitionAsync(
          () => {
            this._finalizeStop('Recording stopped');
          },
          (error) => {
            logger.error('Error during recognition stop', { error: error.toString() });
            this._finalizeStop('Recording stopped');
          }
        );
      } catch (error) {
        logger.error('Error stopping recognizer', { error: error.message });
        this._finalizeStop('Recording stopped');
      }
      return;
    }

    if (this.provider === 'whisper') {
      this._finalizeWhisperStop();
      return;
    }

    this._finalizeStop('Recording stopped');
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
      await this._flushWhisperSegment({ final: true });
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

    if (this.recognizer) {
      try {
        this.recognizer.close();
      } catch (error) {
        logger.error('Error closing recognizer', { error: error.message });
      }
      this.recognizer = null;
    }

    if (this.audioConfig) {
      try {
        if (typeof this.audioConfig.close === 'function') {
          this.audioConfig.close();
        }
      } catch (error) {
        logger.error('Error closing audio config', { error: error.message });
      }
      this.audioConfig = null;
    }

    if (this.recording) {
      try {
        this.recording.stop();
      } catch (error) {
        logger.error('Error stopping audio recording', { error: error.message });
      }
      this.recording = null;
    }

    if (this.pushStream) {
      try {
        if (typeof this.pushStream.close === 'function') {
          this.pushStream.close();
        }
      } catch (error) {
        logger.error('Error closing push stream', { error: error.message });
      }
      this.pushStream = null;
    }

    this.segmentBuffers = [];
    this.segmentBytes = 0;
    this.transcriptionInFlight = false;
    this.pendingFlush = false;
    this.pendingFinal = false;
    this._resetVadState();
    this._audioDataLogged = false;
    this.useRendererCapture = false;
  }

  async recognizeFromFile(audioFilePath) {
    if (this.provider === 'azure') {
      if (!this.speechConfig) {
        throw new Error('Speech service not initialized');
      }

      if (!fs.existsSync(audioFilePath)) {
        throw new Error(`Audio file not found: ${audioFilePath}`);
      }

      const audioConfig = sdk.AudioConfig.fromWavFileInput(audioFilePath);
      const recognizer = new sdk.SpeechRecognizer(this.speechConfig, audioConfig);

      return await new Promise((resolve, reject) => {
        recognizer.recognizeOnceAsync(
          (result) => {
            resolve(result.reason === sdk.ResultReason.RecognizedSpeech ? result.text : '');
            recognizer.close();
            audioConfig.close();
          },
          (error) => {
            reject(new Error(`File recognition error: ${error}`));
            recognizer.close();
            audioConfig.close();
          }
        );
      });
    }

    if (this.provider === 'whisper') {
      const mgr = this.whisperServerManager;
      if (!mgr || typeof mgr.transcribe !== 'function') {
        throw new Error('Resident Whisper engine not initialized');
      }
      if (!fs.existsSync(audioFilePath)) {
        throw new Error(`Audio file not found: ${audioFilePath}`);
      }
      const result = await mgr.transcribe(fs.readFileSync(audioFilePath), {
        language: this._getWhisperLanguage(),
      });
      return result && typeof result.text === 'string' ? result.text : '';
    }

    throw new Error('Speech service not initialized');
  }

  async testConnection() {
    if (this.provider === 'azure') {
      if (!this.speechConfig) {
        throw new Error('Speech service not initialized');
      }

      try {
        const audioConfig = sdk.AudioConfig.fromDefaultMicrophoneInput();
        const recognizer = new sdk.SpeechRecognizer(this.speechConfig, audioConfig);
        recognizer.close();
        audioConfig.close();
        return { success: true, message: 'Azure connection test successful' };
      } catch (error) {
        return { success: false, message: error.message };
      }
    }

    if (this.provider === 'whisper') {
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

    return { success: false, message: 'Speech service not initialized' };
  }

  getStatus() {
    const whisperHealth = this._whisperResidentHealth();
    return {
      provider: this.provider,
      isRecording: this.isRecording,
      isInitialized: this.provider === 'azure' ? !!this.speechConfig : !!this.whisperServerManager,
      sessionDuration: this.sessionStartTime ? Date.now() - this.sessionStartTime : 0,
      retryCount: this.retryCount,
      // Three-level resident-engine health (binary / model / server up) so the
      // overlay + settings can surface three distinct voice messages (Pitfall 4).
      whisperHealth,
      effectiveSettings: {
        speechProvider: this.provider,
        azureKey: this._getSetting('azureKey') || '',
        azureRegion: this._getSetting('azureRegion') || process.env.AZURE_SPEECH_REGION || '',
        whisperModel: this._getWhisperModel(),
        whisperLanguage: this._getWhisperLanguage(),
        whisperSegmentMs: String(this._getWhisperSegmentMs())
      },
      config: {
        azure: config.get('speech.azure') || {},
        whisper: config.get('speech.whisper') || {},
        selectedProvider: this.provider
      }
    };
  }

  isAvailable() {
    if (this.provider === 'azure') {
      return !!this.speechConfig && !!this.available;
    }

    if (this.provider === 'whisper') {
      // Live three-level check: the resident engine is usable only when its
      // server is up AND the model is on disk. Recomputed each call so a
      // mid-session engine-down flips availability off → the overlay shows
      // "voice unavailable" + retry. Typing + screenshot are unaffected.
      const health = this._whisperResidentHealth();
      return !!(health.serverUp && health.modelPresent);
    }

    return false;
  }

  updateSettings(settings = {}) {
    const speechKeys = ['speechProvider', 'azureKey', 'azureRegion', 'whisperCommand', 'whisperModelDir', 'whisperModel', 'whisperLanguage', 'whisperSegmentMs'];
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

  _getConfiguredProvider() {
    const provider = String(this._getSetting('speechProvider') || process.env.SPEECH_PROVIDER || '').trim().toLowerCase();

    if (provider === 'azure' || provider === 'whisper') {
      return provider;
    }

    const hasAzure = !!((this._getSetting('azureKey') || process.env.AZURE_SPEECH_KEY) &&
      (this._getSetting('azureRegion') || process.env.AZURE_SPEECH_REGION));

    if (hasAzure) {
      return 'azure';
    }

    return 'whisper';
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

    if (this.provider === 'azure' && this.pushStream) {
      try {
        this.pushStream.write(chunk);
      } catch (error) {
        logger.error('Error writing audio data to Azure push stream', { error: error.message });
      }
      return;
    }

    if (this.provider === 'whisper') {
      this._ingestWhisperAudio(Buffer.from(chunk));
    }
  }

  async _flushWhisperSegment({ final }) {
    if (this.transcriptionInFlight) {
      // A flush was requested while a transcription is still running. Record
      // that we owe a follow-up flush for ANY request (not just a final one),
      // otherwise an utterance that ended mid-transcription stays stranded in
      // the buffer until the next utterance ends or the session stops. Track
      // final-ness separately so a queued stop still finalises correctly.
      this.pendingFlush = true;
      if (final) {
        this.pendingFinal = true;
      }
      return;
    }

    if (!this.segmentBytes) {
      return;
    }

    const audioBuffer = Buffer.concat(this.segmentBuffers, this.segmentBytes);
    this.segmentBuffers = [];
    this.segmentBytes = 0;

    this.transcriptionInFlight = true;

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
      if (clean && !this._isHallucinatedTranscript(clean)) {
        this.emit('transcription', clean);
      } else if (clean) {
        logger.debug('Dropped likely Whisper silence hallucination', { transcript: clean });
      }
    } finally {
      this.transcriptionInFlight = false;

      if (this.pendingFlush) {
        this.pendingFlush = false;
        const runFinal = this.pendingFinal;
        this.pendingFinal = false;
        await this._flushWhisperSegment({ final: runFinal });
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
