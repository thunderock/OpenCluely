/**
 * SystemAudioTapManager (STT-04 / SC4).
 *
 * Node-side process manager for the macOS Core Audio Process Tap helper
 * (resources/bin/system-audio-tap, built by scripts/build-macos-audio-tap.js).
 * Mirrors OpenWhispr's `audioTapManager.js` (MIT reference) and this repo's
 * WhisperServerManager / LocalModelManager DI shape EXACTLY: export the class,
 * take deps via an options object, default to the real singletons, and every
 * method returns a status/struct instead of throwing — degrade, never crash.
 *
 * Owns:
 *   - isSupported(): darwin && macOS >= 14.4 (robust numeric version compare,
 *     NOT a string compare). platform + systemVersion are INJECTABLE so the
 *     boundary tests run under plain `node --test`, where Electron's
 *     process.getSystemVersion() is undefined.
 *   - binary resolution (dev vs packaged) + Mach-O arch verify (reject wrong arch);
 *   - spawning the helper (DI spawn seam), parsing its stderr line-JSON status
 *     ({"type":"start"} = granted+live; permission_denied / unsupported_os =
 *     degrade-to-mic), and piping its stdout 16 kHz PCM to a consumer callback
 *     (main.js wires this to speechService.handleSystemAudioChunk);
 *   - persisting grant/deny to <userData>/.system-audio-permission so it does
 *     not re-prompt each launch (OpenWhispr pattern);
 *   - start() / stop() (SIGTERM the helper) / getStatus() (supported/granted/running).
 *
 * A SINGLE uniform degrade-to-mic path (_degrade) serves EVERY non-happy case —
 * the <14.4 floor, not-installed, permission-denied, spawn error, unexpected
 * exit, AND the silent no-samples failure mode (the research's PRIMARY RISK on
 * unsigned builds). Mic-only ambient listening is therefore the guaranteed
 * baseline: the system channel is simply never enabled when we degrade.
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn: realSpawn } = require('node:child_process');

// ── Mach-O verification (arm64/x64 guard) — each manager carries its own copy
// so it stays dependency-free (mirrors WhisperServerManager). ──
const MH_MAGIC_64 = 0xfeedfacf;
const MH_CIGAM_64 = 0xcffaedfe;
const FAT_MAGIC = 0xcafebabe;
const FAT_CIGAM = 0xbebafeca;
const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;

/** Verify a Mach-O binary's magic + cpu-type from its leading bytes. Pure + total. */
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
 * True when `version` (e.g. "14.4.1", "26.5") is >= `min` ([14, 4]). Numeric,
 * component-wise compare — a string compare mis-orders "14.10" vs "14.4". Pure.
 */
function versionGte(version, min) {
  if (version == null || version === '') return false;
  const parts = String(version).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < min.length; i += 1) {
    const a = parts[i] || 0;
    const b = min[i];
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

const MACOS_FLOOR = [14, 4]; // Core Audio Taps in the correct TCC category (Flag 3)
const NO_SAMPLES_TIMEOUT_MS = 12000; // silent zero-sample failure watchdog
const START_TIMEOUT_MS = 8000; // no start/error status → degrade

class SystemAudioTapManager {
  constructor({ spawn, config, logger, platform, systemVersion, onPcm, permissionPath } = {}) {
    this.config = config || require('./config');
    this.logger = logger || require('./logger').createServiceLogger('SYSAUDIO');
    this.spawn = spawn || realSpawn;

    // Injectable platform/version so isSupported() boundary tests run under plain
    // `node --test` (process.getSystemVersion is an Electron-only API — undefined
    // in a bare node process, where it must resolve to NOT supported → degrade).
    this.platform = platform || process.platform;
    this.systemVersion = systemVersion != null
      ? systemVersion
      : (typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : null);

    // PCM consumer (main.js → speechService.handleSystemAudioChunk). Overridable
    // per start() call.
    this.onPcm = typeof onPcm === 'function' ? onPcm : null;

    // Grant/deny persistence file (OpenWhispr pattern).
    this.permissionPath = permissionPath || path.join(this._userDataDir(), '.system-audio-permission');

    // Resolve + arch-verify the helper once (null → build/guide UX).
    this.binaryPath = this._resolveBinary();

    // Runtime state.
    this.child = null;
    this.running = false; // tap live + emitting (post {"type":"start"})
    this.granted = false; // OS permission observed granted this session
    this.degraded = false; // degrade-to-mic engaged
    this.degradeReason = null;
    this.bytesReceived = 0;
    this._stderrBuf = '';
    this._startResolved = false;
    this._noSamplesTimer = null;
    this._startTimer = null;
  }

  // ── Support gate ──

  /** darwin && macOS >= 14.4. Below the floor → not supported → degrade-to-mic. */
  isSupported() {
    return this.platform === 'darwin' && versionGte(this.systemVersion, MACOS_FLOOR);
  }

  // ── Lifecycle ──

  /**
   * Start the tap behind isSupported() → persisted-consent → spawn. Resolves with
   * a status struct once the helper reports {"type":"start"} (granted) or a
   * definitive failure (degrade). NEVER throws — every failure path routes
   * through _degrade so mic-only stays the guaranteed baseline.
   */
  async start({ onPcm } = {}) {
    if (typeof onPcm === 'function') this.onPcm = onPcm;

    if (!this.isSupported()) {
      return this._degrade('unsupported_os');
    }
    if (!this.binaryPath) {
      return this._degrade('not-installed');
    }
    // Honor a persisted denial without re-spawning (avoids re-prompting each
    // launch — the whole point of persistence).
    if (this._readPermission() === 'denied') {
      return this._degrade('permission_denied');
    }
    if (this.running && this.child) {
      return this.getStatus();
    }

    return new Promise((resolve) => {
      this._startResolved = false;
      const settle = (status) => {
        if (this._startResolved) return;
        this._startResolved = true;
        this._clearStartTimer();
        resolve(status);
      };

      let child;
      try {
        child = this.spawn(this.binaryPath, ['--sample-rate', '16000'], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        this.logger.warn('system-audio-tap spawn threw', { error: e.message });
        settle(this._degrade('spawn_failed'));
        return;
      }
      this.child = child;
      this.bytesReceived = 0;

      // stdout: raw 16 kHz mono s16le PCM → the consumer (system ingest path).
      if (child.stdout) {
        child.stdout.on('data', (chunk) => {
          this.bytesReceived += chunk.length;
          this._clearNoSamplesTimer(); // real samples arrived → cancel the watchdog
          if (this.onPcm) {
            try { this.onPcm(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); } catch (_) { /* never crash on consumer error */ }
          }
        });
      }

      // stderr: line-delimited JSON status.
      if (child.stderr) {
        child.stderr.on('data', (chunk) => this._onStderr(chunk, settle));
      }

      child.on('error', (e) => {
        this.logger.warn('system-audio-tap child error', { error: e.message });
        settle(this._degrade('spawn_failed'));
      });

      child.on('exit', (code, signal) => {
        this.child = null;
        this.running = false;
        this._clearNoSamplesTimer();
        // A clean SIGTERM (our stop()) is expected; anything else while we
        // thought we were live degrades.
        if (!this._startResolved) {
          settle(this._degrade('exited_early'));
        } else if (signal !== 'SIGTERM' && code !== 0 && !this.degraded) {
          this._degrade('exited');
        }
      });

      // No start/error status within the window → degrade (never hang).
      this._startTimer = setTimeout(() => {
        settle(this._degrade('start_timeout'));
      }, START_TIMEOUT_MS);
    });
  }

  /** SIGTERM the helper (fire-and-forget friendly). Never throws. */
  async stop() {
    this._clearNoSamplesTimer();
    this._clearStartTimer();
    const child = this.child;
    this.child = null;
    this.running = false;
    if (!child) return;
    try {
      child.kill('SIGTERM');
    } catch (e) {
      this.logger.warn('system-audio-tap failed to SIGTERM', { error: e.message });
    }
  }

  // ── Status ──

  getStatus() {
    return {
      supported: this.isSupported(),
      granted: this.granted,
      running: this.running,
      degraded: this.degraded,
      reason: this.degradeReason,
      bytesReceived: this.bytesReceived,
      binaryPresent: !!this.binaryPath,
    };
  }

  // ── Internals ──

  /**
   * Parse buffered stderr line-JSON. {"type":"start"} = granted + live (persist
   * granted, arm the no-samples watchdog); permission_denied = degrade + persist
   * denied; unsupported_os / other errors = degrade (do NOT persist a denial for
   * an OS-version failure — that is not a user choice).
   */
  _onStderr(chunk, settle) {
    this._stderrBuf += chunk.toString('utf8');
    let idx = this._stderrBuf.indexOf('\n');
    while (idx !== -1) {
      const line = this._stderrBuf.slice(0, idx).trim();
      this._stderrBuf = this._stderrBuf.slice(idx + 1);
      if (line) this._handleStatusLine(line, settle);
      idx = this._stderrBuf.indexOf('\n');
    }
  }

  _handleStatusLine(line, settle) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (_) {
      return; // non-JSON diagnostic noise — ignore
    }
    if (msg.type === 'start') {
      this.granted = true;
      this.running = true;
      this.degraded = false;
      this.degradeReason = null;
      this._writePermission('granted');
      this._armNoSamplesWatchdog();
      this.logger.info('system audio tap live', { sampleRate: msg.sampleRate || null });
      settle(this.getStatus());
      return;
    }
    if (msg.type === 'error') {
      const code = msg.code || 'error';
      if (code === 'permission_denied') {
        this._writePermission('denied');
      }
      settle(this._degrade(code));
    }
  }

  /**
   * THE single degrade-to-mic path. Stops any child, marks degraded, logs a clear
   * mic-only note, and returns the status. Shared by the <14.4 floor,
   * not-installed, permission-denied, spawn errors, and the no-samples watchdog —
   * so mic-only ambient listening is always the fallback and never crashes.
   */
  _degrade(reason) {
    this.degraded = true;
    this.degradeReason = reason;
    this.running = false;
    this._clearNoSamplesTimer();
    if (this.child) {
      try { this.child.kill('SIGTERM'); } catch (_) { /* best effort */ }
      this.child = null;
    }
    this.logger.info('system audio unavailable — using microphone only', { reason });
    return this.getStatus();
  }

  /**
   * Watchdog for the research's PRIMARY RISK: on an unsigned build the tap can
   * report {"type":"start"} yet silently emit ZERO samples. If no PCM arrives
   * within the window, degrade-to-mic through the same uniform path.
   */
  _armNoSamplesWatchdog() {
    this._clearNoSamplesTimer();
    this._noSamplesTimer = setTimeout(() => {
      if (this.bytesReceived === 0) {
        this.logger.warn('system audio tap reported start but produced no samples — degrading to mic');
        this._degrade('no_samples');
      }
    }, NO_SAMPLES_TIMEOUT_MS);
    if (typeof this._noSamplesTimer.unref === 'function') this._noSamplesTimer.unref();
  }

  _clearNoSamplesTimer() {
    if (this._noSamplesTimer) {
      clearTimeout(this._noSamplesTimer);
      this._noSamplesTimer = null;
    }
  }

  _clearStartTimer() {
    if (this._startTimer) {
      clearTimeout(this._startTimer);
      this._startTimer = null;
    }
  }

  /** Read the persisted grant/deny ('granted' | 'denied' | null). */
  _readPermission() {
    try {
      if (!fs.existsSync(this.permissionPath)) return null;
      const raw = fs.readFileSync(this.permissionPath, 'utf8').trim();
      if (raw === 'granted' || raw === 'denied') return raw;
      // Tolerate a JSON form { granted: true/false } (OpenWhispr shape).
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.granted === 'boolean') return parsed.granted ? 'granted' : 'denied';
      } catch (_) { /* fall through */ }
      return null;
    } catch (_) {
      return null;
    }
  }

  /** Persist grant/deny so a later launch does not re-prompt. Best-effort. */
  _writePermission(value) {
    try {
      fs.mkdirSync(path.dirname(this.permissionPath), { recursive: true });
      fs.writeFileSync(this.permissionPath, value, 'utf8');
    } catch (e) {
      this.logger.warn('failed to persist system-audio permission', { error: e.message });
    }
  }

  _resolveBinary() {
    // Dev: <appRoot>/resources/bin/system-audio-tap. Packaged:
    // process.resourcesPath/bin/system-audio-tap (asarUnpack'd — Phase 8).
    // SYSTEM_AUDIO_TAP_BIN overrides (tests / spike).
    const candidates = [];
    if (process.env.SYSTEM_AUDIO_TAP_BIN) candidates.push(process.env.SYSTEM_AUDIO_TAP_BIN);
    if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'bin', 'system-audio-tap'));
    candidates.push(path.join(__dirname, '..', '..', 'resources', 'bin', 'system-audio-tap'));
    for (const candidate of candidates) {
      if (this._isTrustedBinary(candidate)) return candidate;
    }
    return null;
  }

  _isTrustedBinary(binPath) {
    try {
      if (!binPath || !fs.existsSync(binPath)) return false;
      // Off-darwin the helper is never actually present; existence is enough.
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

  _userDataDir() {
    // app.getPath('userData') under Electron; else mirror WhisperServerManager's
    // dev/test default so the permission file lives with the rest of userData.
    let app;
    try { ({ app } = require('electron')); } catch (_) { /* not under electron */ }
    if (app && typeof app.getPath === 'function') {
      try { return app.getPath('userData'); } catch (_) { /* fall through */ }
    }
    return path.join(os.homedir(), '.OpenCluely');
  }
}

module.exports = SystemAudioTapManager;
module.exports.SystemAudioTapManager = SystemAudioTapManager;
module.exports.verifyMachO = verifyMachO;
module.exports.versionGte = versionGte;
