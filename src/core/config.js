const path = require('path');
const os = require('os');

class ConfigManager {
  constructor() {
    this.env = process.env.NODE_ENV || 'development';
    this.appDataDir = path.join(os.homedir(), '.OpenCluely');
    this.loadConfiguration();
  }

  loadConfiguration() {
    this.config = {
      app: {
        name: 'OpenCluely',
        version: '1.0.0',
        processTitle: 'OpenCluely',
        dataDir: this.appDataDir,
        isDevelopment: this.env === 'development',
        isProduction: this.env === 'production'
      },
      
      window: {
        defaultWidth: 400,
        defaultHeight: 600,
        minWidth: 300,
        minHeight: 400,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          enableRemoteModule: false,
          preload: path.join(__dirname, '../../preload.js')
        }
      },

      ocr: {
        language: 'eng',
        tempDir: os.tmpdir(),
        cleanupDelay: 5000
      },

      llm: {
        // Provider selection (PROV-06). Local is the only engine after PROV-07
        // removed the cloud path; the key stays env-overridable so Phase-7 CLI
        // backends can be selected without a code change.
        provider: process.env.LLM_PROVIDER || 'local',

        // Per-provider block for the local engine. `host` is the client base
        // URL (scheme included); LocalProvider appends '/v1', LocalModelManager
        // derives the daemon's OLLAMA_HOST ('host:port', no scheme) from it.
        local: {
          host: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
          model: process.env.LOCAL_MODEL || 'qwen3-vl:8b',
          keepAlive: -1,
          // qwen3(-vl) reasons out loud by default; a reply-suggester wants concise,
          // fast answers (GEN-01), so thinking is OFF by default (serialize appends the
          // qwen3 `/no_think` soft-switch). Set LOCAL_THINK=1 to re-enable reasoning.
          think: process.env.LOCAL_THINK === '1' || process.env.LOCAL_THINK === 'true',
          curatedModels: ['qwen3-vl:8b', 'qwen3-vl:30b', 'gemma3:4b', 'gemma3:12b']
        }
      },

      speech: {
        provider: 'azure',
        azure: {
          language: 'en-US',
          enableDictation: true,
          enableAudioLogging: false,
          outputFormat: 'detailed'
        },
        // Resident whisper.cpp whisper-server engine (STT-01). Collapsed to the
        // single whisper-server block; the VAD knobs below are now SHARED by both
        // capture channels (mic + system, 04-04). speech.provider / speech.azure
        // are deliberately left in place until 04-09 (prove-then-remove).
        whisper: {
          host: '127.0.0.1',      // whisper-server bind host (loopback only)
          port: 0,                // 0 = auto-pick a free port at start()
          model: 'small.en',      // → model-weights file ggml-${model}.bin (was 'turbo')
          language: 'en',
          threads: 0,             // 0 = auto (clamp 50% of cores to [2,8])
          noSpeechThreshold: 0.6, // drop a segment if no_speech_prob > this
          // segmentMs is the legacy fixed-window size and now acts as the
          // hard upper bound for a single utterance when VAD is enabled.
          // Retained as a harmless backstop until 04-03 rewrites the flush.
          segmentMs: 4000,
          // Voice-activity-detection driven segmentation. Instead of cutting
          // audio on a blind timer (which splits sentences mid-word), we flush
          // a segment when the speaker pauses. This makes transcription align
          // with natural utterance boundaries.
          vadEnabled: true,
          // Trailing silence (ms) that ends an utterance and triggers a flush.
          silenceHangoverMs: 700,
          // Minimum accumulated speech (ms) before a pause counts as an
          // utterance — guards against coughs/clicks producing empty flushes.
          minUtteranceMs: 350,
          // Hard cap (ms): force-flush a long monologue even without a pause.
          maxUtteranceMs: 15000,
          // Pre-roll (ms) of audio kept before speech onset so the first
          // syllable isn't clipped when we start capturing.
          preRollMs: 300,
          // Absolute RMS energy floor (normalized 0..1). Energy below this is
          // always treated as silence regardless of the adaptive noise floor.
          vadEnergyFloor: 0.008
        }
      },

      session: {
        maxMemorySize: 1000,
        compressionThreshold: 500,
        clearOnRestart: false
      },

      stealth: {
        hideFromDock: true,
        noAttachConsole: true,
        disguiseProcess: true
      }
    };
  }

  get(keyPath) {
    return keyPath.split('.').reduce((obj, key) => obj?.[key], this.config);
  }

  set(keyPath, value) {
    const keys = keyPath.split('.');
    const lastKey = keys.pop();
    const target = keys.reduce((obj, key) => obj[key] = obj[key] || {}, this.config);
    target[lastKey] = value;
  }

  getApiKey(service) {
    const envKey = `${service.toUpperCase()}_API_KEY`;
    return process.env[envKey];
  }

  isFeatureEnabled(feature) {
    return this.get(`features.${feature}`) !== false;
  }
}

module.exports = new ConfigManager();