/**
 * WhisperServerManager (STT-01 / SC1 foundation).
 *
 * The resident STT engine's supervised process manager. It mirrors
 * LocalModelManager's DI shape EXACTLY (export the class, take deps via an
 * options object, default to the real singletons, every method returns a
 * status/struct instead of throwing — degrade, never crash) and is the whisper
 * analogue of that Ollama manager:
 *
 *   - resolves a from-source-built `whisper-server` binary (dev vs packaged) and
 *     verifies its Mach-O magic + cpu-type before trusting it;
 *   - resolves the ggml model file under <userData>/.whisper-models;
 *   - picks a FREE loopback port at start() (re-picked on every start so an
 *     orphan-held fixed port never causes EADDRINUSE);
 *   - supervises the binary via the Phase-1 ServiceSupervisor with the header's
 *     pre-spec'd whisper-server config (adopt:false, pidFile, SIGTERM grace);
 *   - reports three-level health (server up / model present / responding);
 *   - transcribes a WAV buffer over POST /inference?response_format=verbose_json,
 *     dropping segments whose no_speech_prob > threshold (the SC5 second gate)
 *     before concatenating surviving text.
 *
 * No speech.service.js wiring here — this produces the reusable, unit-testable
 * piece; the per-utterance flush rewire lands in 04-03. VAD stays in JS (locked),
 * so the server is launched WITHOUT --vad (avoids double-VAD).
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const ServiceSupervisor = require('./service-supervisor');
const { nodeFetch } = require('./local-transport');

// ── Mach-O verification (arm64/x64 guard, mirrors the openwhispr arch-verify /
// LocalModelManager binary-trust pattern). Kept here for runtime resolution;
// scripts/build-whisper-server.js carries its own copy so it stays dependency-free.
const MH_MAGIC_64 = 0xfeedfacf;
const MH_CIGAM_64 = 0xcffaedfe;
const FAT_MAGIC = 0xcafebabe;
const FAT_CIGAM = 0xbebafeca;
const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;

/**
 * Verify a Mach-O binary's magic + cpu-type from its leading bytes. Accepts a
 * thin 64-bit Mach-O whose cpu-type matches `expectedArch`, or any fat/universal
 * binary (it carries every slice). Rejects garbage / wrong-arch. Pure + total.
 */
function verifyMachO(buffer, expectedArch = process.arch) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return { ok: false, arch: null };
  const magicLE = buffer.readUInt32LE(0);
  const magicBE = buffer.readUInt32BE(0);
  if ([FAT_MAGIC, FAT_CIGAM].includes(magicBE) || [FAT_MAGIC, FAT_CIGAM].includes(magicLE)) {
    return { ok: true, arch: 'universal' };
  }
  let cpuType;
  if (magicLE === MH_MAGIC_64) cpuType = buffer.readUInt32LE(4);
  else if (magicLE === MH_CIGAM_64) cpuType = buffer.readUInt32BE(4);
  else return { ok: false, arch: null };
  const arch = cpuType === CPU_TYPE_ARM64 ? 'arm64' : cpuType === CPU_TYPE_X86_64 ? 'x64' : 'unknown';
  return { ok: arch === expectedArch, arch };
}

/**
 * Conservative thread count for whisper-server: 50% of cores, clamped to [2,8].
 * Deliberately more conservative than openwhispr's 75%/[4,12] to leave cores for
 * the resident VLM (Pitfall 2). Pure + separately testable.
 */
function clampThreads(cores) {
  const n = Math.floor((Number(cores) || 0) * 0.5);
  return Math.max(2, Math.min(8, n));
}

class WhisperServerManager {
  constructor({ supervisor, spawn, config, logger, fetchImpl } = {}) {
    this.config = config || require('./config');
    const w = this.config.get('speech.whisper') || {};
    this.host = w.host || '127.0.0.1';
    this.model = w.model || 'small.en';
    this.language = w.language || 'en';
    this.noSpeechThreshold = typeof w.noSpeechThreshold === 'number' ? w.noSpeechThreshold : 0.6;
    this._configuredThreads = w.threads; // 0 = auto

    this.logger = logger || require('./logger').createServiceLogger('WHISPER');
    // Transport: NEVER the ambient global fetch — in the Electron main process it
    // is Chromium-net-backed and false-negatives loopback (the same gotcha the
    // Ollama path hit). Default to the Node-http nodeFetch; injectable for tests.
    this.fetchImpl = fetchImpl || nodeFetch;

    // Resolve + arch-verify the binary once (null → guide-install/build UX).
    this.binaryPath = this._resolveBinary();
    // Selected at start(); null until then (transcribe before start degrades).
    this.port = null;

    // Supervisor definition — verbatim from the ServiceSupervisor header's
    // whisper-server pre-spec. args + healthCheck.port are filled at start()
    // (the port is only known then); the supervisor holds `this.def` BY REFERENCE,
    // so mutating it before supervisor.start() is what the child actually gets.
    this.def = {
      name: 'whisper-server',
      command: this.binaryPath || 'whisper-server',
      args: [],
      healthCheck: { type: 'port', host: this.host, port: 0, timeoutMs: 1000 },
      adopt: false, // app-private, own-only (unlike Ollama's adopt:true)
      pidFile: path.join(this._userDataDir(), '.whisper-server.pid'),
      terminate: { sigtermGraceMs: 5000 },
      backoff: { initialDelayMs: 500, multiplier: 2, maxDelayMs: 15000, maxRetries: 8 },
      startupTimeoutMs: 30000,
    };
    // Guard mirrors LocalModelManager: an INJECTED supervisor is trusted (tests);
    // only a self-built supervisor triggers the binary-not-found not-installed path.
    this._ownsSupervisor = !supervisor;
    this.supervisor = supervisor || new ServiceSupervisor(this.def, { spawn });
  }

  // ── Lifecycle ──

  async start() {
    // Guide-install/build path: no binary to spawn and we own the supervisor.
    // Surface not-installed instead of spawning a bogus command.
    if (this._ownsSupervisor && !this.binaryPath) {
      return this._notInstalledStatus();
    }
    try {
      const port = await this._pickFreePort();
      this.port = port;
      const threads = this._resolveThreads();
      const modelPath = this._modelPath();
      // Re-pick the port and rebuild args on every start so a stale/orphan-held
      // port never causes EADDRINUSE. No server --vad (VAD stays in JS).
      this.def.healthCheck.port = port;
      this.def.args = [
        '--host', this.host,
        '--port', String(port),
        '-m', modelPath,
        '-t', String(threads),
      ];
      await this.supervisor.start();
    } catch (e) {
      this.logger.error('whisper-server supervisor failed to start', { error: e.message });
      return this._offlineStatus({ error: e.message });
    }
    return this.getStatus();
  }

  async stop() {
    try {
      await this.supervisor.stop();
    } catch (e) {
      this.logger.warn('whisper-server supervisor failed to stop', { error: e.message });
    }
  }

  // ── Health / status (three levels, Pitfall 4) ──

  async getStatus({ probeResponding = false } = {}) {
    const s = this.supervisor.getStatus(); // { name, state, attempt, pid, owned }
    const binaryPresent = !!this.binaryPath;
    const modelPresent = this.modelPresent();
    // Level 1 — server up: the supervisor reached a healthy/adopted state (its
    // port probe already passed). Computed from state so this stays network-free.
    const serverUp = s.state === 'healthy' || s.state === 'adopted';
    // Level 3 — responding: an optional tiny HTTP probe. GUARD: a responding-probe
    // failure must NEVER flip serverUp false (the levels are independent), so it is
    // isolated in its own try/catch and only runs when explicitly requested.
    let responding = false;
    if (serverUp && probeResponding && this.port) {
      try {
        responding = await ServiceSupervisor.probeHttp({
          host: this.host, port: this.port, path: '/', timeoutMs: 1000,
        });
      } catch (_) {
        responding = false;
      }
    }
    return { binaryPresent, modelPresent, serverUp, responding, state: s.state, pid: s.pid || null };
  }

  /** Level 2 — model ready: the ggml .bin is present on disk. */
  modelPresent() {
    try {
      return fs.existsSync(this._modelPath());
    } catch (_) {
      return false;
    }
  }

  // ── Transcription ──

  /**
   * Transcribe a 16 kHz mono WAV buffer over POST /inference. Uses
   * response_format=verbose_json (REQUIRED — no_speech_prob exists ONLY in
   * verbose_json; the basic json format omits it), drops every segment whose
   * no_speech_prob > noSpeechThreshold (the SC5 second gate, behind JS VAD +
   * the phrase list), concatenates the survivors, and returns
   * { text, dropped, total }. If a build returns no segments[], degrades to the
   * top-level .text (the gate falls back to VAD + phrase-list only — still correct).
   */
  async transcribe(wavBuffer, { language } = {}) {
    const lang = language || this.language || 'en';
    const boundary = `----OpenCluelyWhisper${crypto.randomBytes(8).toString('hex')}`;
    const body = this._buildMultipart(boundary, wavBuffer, {
      response_format: 'verbose_json',
      language: lang,
      temperature: '0',
    });
    const url = `http://${this.host}:${this.port}/inference`;
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(body.length),
        },
        body,
      });
      const json = await res.json();
      return this._parseTranscription(json);
    } catch (e) {
      this.logger.error('whisper-server transcribe request failed', { error: e.message });
      return { text: '', dropped: 0, total: 0, error: e.message };
    }
  }

  /** Apply the verbose_json segments[] no_speech gate; degrade to top-level .text. */
  _parseTranscription(json) {
    if (json && Array.isArray(json.segments)) {
      const total = json.segments.length;
      const survivors = json.segments.filter(
        (seg) => !(typeof seg.no_speech_prob === 'number' && seg.no_speech_prob > this.noSpeechThreshold),
      );
      const text = survivors.map((seg) => seg.text || '').join('').trim();
      return { text, dropped: total - survivors.length, total };
    }
    const text = json && typeof json.text === 'string' ? json.text.trim() : '';
    return { text, dropped: 0, total: 0 };
  }

  /** Hand-built multipart/form-data body (no ESM form-data dep). file = the WAV. */
  _buildMultipart(boundary, wavBuffer, fields) {
    const CRLF = '\r\n';
    const parts = [];
    for (const [name, value] of Object.entries(fields)) {
      parts.push(Buffer.from(
        `--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`,
      ));
    }
    parts.push(Buffer.from(
      `--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="segment.wav"${CRLF}`
      + `Content-Type: audio/wav${CRLF}${CRLF}`,
    ));
    parts.push(Buffer.isBuffer(wavBuffer) ? wavBuffer : Buffer.from(wavBuffer || []));
    parts.push(Buffer.from(`${CRLF}--${boundary}--${CRLF}`));
    return Buffer.concat(parts);
  }

  // ── Internals ──

  _pickFreePort() {
    // Bind :0 on loopback, read the assigned port, release it. get-port is
    // ESM-banned; use net directly. Small TOCTOU race is acceptable on own-only
    // loopback — the supervisor's backoff covers a rare collision.
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const { port } = srv.address();
        srv.close(() => resolve(port));
      });
    });
  }

  _resolveThreads() {
    const envT = parseInt(process.env.WHISPER_THREADS, 10);
    if (Number.isFinite(envT) && envT > 0) return envT;
    const cfgT = Number(this._configuredThreads);
    if (Number.isFinite(cfgT) && cfgT > 0) return cfgT;
    const cores = typeof os.availableParallelism === 'function'
      ? os.availableParallelism()
      : (os.cpus() || []).length;
    return clampThreads(cores);
  }

  _resolveBinary() {
    // Dev: <appRoot>/resources/bin/whisper-server. Packaged: process.resourcesPath/
    // bin/whisper-server (asarUnpack'd — Phase 8). WHISPER_SERVER_BIN overrides.
    const candidates = [];
    if (process.env.WHISPER_SERVER_BIN) candidates.push(process.env.WHISPER_SERVER_BIN);
    if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'bin', 'whisper-server'));
    candidates.push(path.join(__dirname, '..', '..', 'resources', 'bin', 'whisper-server'));
    for (const candidate of candidates) {
      if (this._isTrustedBinary(candidate)) return candidate;
    }
    return null;
  }

  _isTrustedBinary(binPath) {
    try {
      if (!binPath || !fs.existsSync(binPath)) return false;
      // Off-darwin STT is out of scope this phase; existence is enough there
      // (the binary is never actually present). On darwin, verify the Mach-O.
      if (process.platform !== 'darwin') return true;
      const head = Buffer.alloc(32);
      const fd = fs.openSync(binPath, 'r');
      try {
        fs.readSync(fd, head, 0, 32, 0);
      } finally {
        fs.closeSync(fd);
      }
      return verifyMachO(head).ok;
    } catch (_) {
      return false;
    }
  }

  _modelPath() {
    return path.join(this._userDataDir(), '.whisper-models', `ggml-${this.model}.bin`);
  }

  _userDataDir() {
    // Electron app.getPath('userData') when running under Electron; else mirror
    // WhisperInstaller's dev/test default so the download location and the
    // transcription model path always agree (whisper-installer.js:152-154).
    let app;
    try { ({ app } = require('electron')); } catch (_) { /* not under electron */ }
    if (app && typeof app.getPath === 'function') {
      try { return app.getPath('userData'); } catch (_) { /* fall through */ }
    }
    return path.join(os.homedir(), '.OpenCluely');
  }

  _notInstalledStatus() {
    return {
      binaryPresent: false,
      modelPresent: this.modelPresent(),
      serverUp: false,
      responding: false,
      state: 'idle',
      pid: null,
      ok: false,
      reason: 'not-installed',
    };
  }

  _offlineStatus(extra = {}) {
    const s = this.supervisor ? this.supervisor.getStatus() : { state: 'idle', pid: null };
    return {
      binaryPresent: !!this.binaryPath,
      modelPresent: this.modelPresent(),
      serverUp: false,
      responding: false,
      state: s.state,
      pid: s.pid || null,
      ...extra,
    };
  }
}

module.exports = WhisperServerManager;
module.exports.WhisperServerManager = WhisperServerManager;
module.exports.clampThreads = clampThreads;
module.exports.verifyMachO = verifyMachO;
