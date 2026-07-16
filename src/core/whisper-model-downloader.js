/**
 * WhisperModelDownloader (STT-02/SC2).
 *
 * First-run downloader for the ggml Whisper weights used by the resident
 * whisper-server (04-01). It fetches `ggml-<model>.bin` from the Hugging Face
 * model repo `ggerganov/whisper.cpp` resumably (HTTP Range) into
 * `<userData>/.whisper-models/`, emits structured progress, and only marks the
 * model installed once its SHA256 matches the pinned git-LFS OID — an atomic
 * rename AFTER verify, so a partial or corrupt download can never masquerade as
 * installed (Pitfall 5). Offline first-launch and disk-full both degrade to a
 * friendly, actionable message instead of a crash.
 *
 * DI shape mirrors LocalModelManager / WhisperInstaller: export the class, take
 * deps via an options object, default to the real singletons; every method
 * returns a status struct instead of throwing. This is a pure download+verify
 * engine — NO venv/pip/Python. The IPC/onboarding wiring that streams this
 * progress lands in 04-03 (IPC) + 04-07 (onboarding UX).
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('crypto');
const { URL } = require('node:url'); // native URL, immune to the Azure polyfill poisoning global.URL

// HF *model* repo — still `ggerganov/whisper.cpp` even though the GitHub org
// renamed to `ggml-org` (`ggml-org/whisper.cpp` on HF returns 401). Files live at
// https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-<model>.bin —
// the same base whisper.cpp's own download-ggml-model.sh uses.
const HF_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

// Pinned model table (RESEARCH Flag 6 — authoritative git-LFS OIDs). OpenCluely
// MUST pin these itself; the upstream download script does NO verification.
const DEFAULT_MODELS = {
  'small.en': { file: 'ggml-small.en.bin', size: 487614201, sha256: 'c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d' },
  'base.en': { file: 'ggml-base.en.bin', size: 147964211, sha256: 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002' },
  'tiny.en': { file: 'ggml-tiny.en.bin', size: 77704715, sha256: '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f' },
};

const DEFAULT_MODEL = 'small.en';
const DISK_HEADROOM_BYTES = 64 * 1024 * 1024; // room for fs overhead beyond the raw model size
const PROGRESS_THROTTLE_MS = 100;
const MAX_REDIRECTS = 5;
const NET_ERROR_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET',
  'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EPIPE',
]);

/**
 * Default transport: a Node http/https GET resolving with the IncomingMessage
 * (statusCode + headers + async-iterable body). ESM `node-fetch` is banned and
 * the ambient global `fetch` is deliberately avoided — keeps the byte stream
 * deterministic and immune to the Electron-main Chromium-net loopback quirks.
 */
function defaultHttpGet(url, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(e); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      headers,
    }, resolve);
    req.on('error', reject);
  });
}

class WhisperModelDownloader {
  constructor({ dataDir, httpGet, fs: fsImpl, statfs, checksums, logger } = {}) {
    this.fs = fsImpl || fs;
    this.httpGet = httpGet || defaultHttpGet;
    this.models = checksums || DEFAULT_MODELS;
    this.logger = logger || require('./logger').createServiceLogger('WHISPER-DL');
    this.dataDir = dataDir || this._resolveDataDir();
    // Injectable disk-space probe (mirrors LocalModelManager.preflight's
    // fs.statfsSync pattern). Returns { bavail, bsize } or null when unavailable.
    this._statfs = statfs || ((p) => {
      try {
        if (typeof this.fs.statfsSync === 'function') return this.fs.statfsSync(p);
      } catch (_) { /* best-effort — leave unmeasured */ }
      return null;
    });
  }

  /** Same `<userData>/.whisper-models/` WhisperInstaller.modelDir / speech.service use. */
  get modelDir() {
    return path.join(this.dataDir, '.whisper-models');
  }

  modelPath(model = DEFAULT_MODEL) {
    const spec = this._spec(model);
    const file = spec ? spec.file : `ggml-${model}.bin`;
    return path.join(this.modelDir, file);
  }

  _spec(model) { return this.models[model] || null; }

  _resolveDataDir() {
    // Electron main: the real userData dir. Non-electron (tests/CLI): mirror the
    // logger's ~/.OpenCluely home so paths stay stable and network-free-testable.
    try {
      const { app } = require('electron');
      const ud = app && typeof app.getPath === 'function' ? app.getPath('userData') : '';
      if (ud) return ud;
    } catch (_) { /* not running under Electron */ }
    return path.join(os.homedir(), '.OpenCluely');
  }

  /** Cheap presence check (path + size). Pass `{ verify:true }` for a full SHA256. */
  async isModelPresent(model = DEFAULT_MODEL, { verify = false } = {}) {
    const p = this.modelPath(model);
    if (!this.fs.existsSync(p)) return false;
    if (verify) {
      const r = await this.verifyChecksum(p, model);
      return r.ok;
    }
    const spec = this._spec(model);
    try { return !spec || this.fs.statSync(p).size === spec.size; } catch (_) { return false; }
  }

  /**
   * Streamed SHA256 over the whole file (correct for both fresh AND resumed
   * downloads) plus an exact size check against the pinned spec. Returns a
   * struct — never throws.
   */
  verifyChecksum(filePath, model) {
    const spec = this._spec(model);
    return new Promise((resolve) => {
      let size = 0;
      const hash = crypto.createHash('sha256');
      let rs;
      try {
        rs = this.fs.createReadStream(filePath);
      } catch (e) {
        resolve({ ok: false, sha256: null, size: 0, expected: spec ? spec.sha256 : null, error: e.message });
        return;
      }
      rs.on('data', (c) => { size += c.length; hash.update(c); });
      rs.on('error', (e) => resolve({ ok: false, sha256: null, size, expected: spec ? spec.sha256 : null, error: e.message }));
      rs.on('end', () => {
        const sha256 = hash.digest('hex');
        const ok = !!spec && sha256 === spec.sha256 && size === spec.size;
        resolve({ ok, sha256, size, expected: spec ? spec.sha256 : null });
      });
    });
  }

  /**
   * Download + verify `ggml-<model>.bin` into <userData>/.whisper-models/.
   * Resumable via HTTP Range; atomic-rename only after the SHA256 matches.
   * Degrades to friendly { ok:false, reason } structs on offline/disk-full/etc.
   */
  async download(model = DEFAULT_MODEL, { onProgress } = {}) {
    const spec = this._spec(model);
    if (!spec) {
      return { ok: false, reason: 'unknown-model', model, message: `Unknown Whisper model "${model}".` };
    }
    const target = this.modelPath(model);
    const part = `${target}.part`;

    // Already installed + verified → short-circuit (no re-download, no fetch).
    if (this.fs.existsSync(target)) {
      const check = await this.verifyChecksum(target, model);
      if (check.ok) return { ok: true, present: true, path: target, model };
      // A corrupt final file — drop it and re-download.
      this._remove(target);
    }

    // Disk preflight (reuse LocalModelManager.preflight's statfs pattern): do
    // NOT start the download when there isn't room for the model + headroom.
    const resumeOffset = this._partSize(part);
    const disk = this._checkDiskSpace(spec, resumeOffset);
    if (!disk.ok) return disk;

    try {
      try { this.fs.mkdirSync(this.modelDir, { recursive: true }); } catch (_) { /* exists */ }
      const streamed = await this._streamToPart({ spec, model, part, resumeOffset, onProgress });
      if (!streamed.ok) return streamed;

      const check = await this.verifyChecksum(part, model);
      if (!check.ok) {
        // Never let a partial/corrupt file masquerade as installed (Pitfall 5).
        this._remove(part);
        this.logger.error('model checksum verification failed; deleted partial', {
          model, expected: check.expected, actual: check.sha256, size: check.size,
        });
        return {
          ok: false, reason: 'checksum-mismatch', model, path: target,
          expected: check.expected, actual: check.sha256,
          message: 'The downloaded voice model failed its integrity check and was discarded. Please try downloading again.',
        };
      }

      // Atomic rename ONLY after the checksum passes.
      this.fs.renameSync(part, target);
      this.logger.info('whisper model installed', { model, path: target, bytes: check.size });
      this._emit(onProgress, { percent: 100, downloadedBytes: spec.size, totalBytes: spec.size });
      return { ok: true, present: true, path: target, model, bytes: check.size };
    } catch (e) {
      if (this._isNetworkError(e)) {
        this.logger.warn('offline during model download', { model, error: e.message });
        return {
          ok: false, reason: 'offline', model, resumable: true,
          message: 'Connect to the internet once to download the ~488 MB voice model — after that, OpenCluely works offline.',
        };
      }
      this.logger.error('model download failed', { model, error: e.message });
      return { ok: false, reason: 'error', model, resumable: true, message: `Voice model download failed: ${e.message}` };
    }
  }

  // ── Internals ──

  async _streamToPart({ spec, model, part, resumeOffset, onProgress }) {
    // GET https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-<model>.bin
    const url = `${HF_BASE}/${spec.file}`;
    const headers = { 'User-Agent': 'OpenCluely' };
    // HTTP Range resume: request bytes from the existing .part offset onward.
    if (resumeOffset > 0) headers.Range = `bytes=${resumeOffset}-`;

    const res = await this._getFollowingRedirects(url, headers);
    const status = res.statusCode;
    if (status !== 200 && status !== 206) {
      try { if (typeof res.resume === 'function') res.resume(); } catch (_) { /* drain */ }
      return { ok: false, reason: 'http-error', model, statusCode: status, message: `Download failed with HTTP ${status}.` };
    }

    // If we asked for a Range but the server ignored it (200 = full body),
    // rewrite the .part from scratch rather than appending onto stale bytes.
    const appending = resumeOffset > 0 && status === 206;
    const total = spec.size;
    let downloaded = appending ? resumeOffset : 0;

    let lastEmit = 0;
    const tick = (force) => {
      const now = Date.now();
      if (!force && now - lastEmit < PROGRESS_THROTTLE_MS) return;
      lastEmit = now;
      const percent = total > 0 ? Math.min(100, Math.floor((downloaded / total) * 100)) : 0;
      this._emit(onProgress, { percent, downloadedBytes: downloaded, totalBytes: total });
    };

    const out = this.fs.createWriteStream(part, { flags: appending ? 'a' : 'w' });
    let outErr = null;
    out.on('error', (e) => { outErr = e; });
    try {
      for await (const chunk of res) {
        if (outErr) throw outErr;
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        downloaded += buf.length;
        if (!out.write(buf)) await this._drain(out);
        tick(false);
      }
      await new Promise((resolve, reject) => { out.end(() => resolve()); out.once('error', reject); });
      if (outErr) throw outErr;
    } catch (e) {
      try { out.destroy(); } catch (_) { /* ignore */ }
      throw e;
    }
    tick(true);
    return { ok: true };
  }

  async _getFollowingRedirects(url, headers) {
    let current = url;
    for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
      const res = await this.httpGet(current, { headers });
      const status = res.statusCode;
      if (status >= 300 && status < 400 && res.headers && res.headers.location) {
        // Follow the 302 → CDN redirect (cross-host — fine here: this is a direct
        // downloader, not the WebFetch tool).
        try { if (typeof res.resume === 'function') res.resume(); } catch (_) { /* drain */ }
        current = new URL(res.headers.location, current).toString();
        continue;
      }
      return res;
    }
    const e = new Error('Too many redirects while downloading the voice model.');
    e.code = 'ETOOMANYREDIRECTS';
    throw e;
  }

  _checkDiskSpace(spec, resumeOffset) {
    const needed = Math.max(0, spec.size - resumeOffset) + DISK_HEADROOM_BYTES;
    let st = null;
    try { st = this._statfs(this._diskProbePath()); } catch (_) { st = null; }
    if (!st || typeof st.bavail !== 'number' || typeof st.bsize !== 'number') {
      return { ok: true }; // can't measure → don't block
    }
    const free = st.bavail * st.bsize;
    if (free < needed) {
      const freeMb = Math.round(free / 1e6);
      const needMb = Math.round(needed / 1e6);
      return {
        ok: false, reason: 'disk-full', started: false, freeBytes: free, neededBytes: needed,
        message: `Not enough free disk space to download the voice model (needs about ${needMb} MB, ${freeMb} MB free). Free up some space and try again.`,
      };
    }
    return { ok: true, freeBytes: free };
  }

  _diskProbePath() {
    // statfs needs an existing path; fall back to the data dir / home before the
    // model dir exists.
    try { if (this.fs.existsSync(this.modelDir)) return this.modelDir; } catch (_) { /* ignore */ }
    try { if (this.fs.existsSync(this.dataDir)) return this.dataDir; } catch (_) { /* ignore */ }
    return os.homedir();
  }

  _partSize(part) {
    try { return this.fs.existsSync(part) ? this.fs.statSync(part).size : 0; } catch (_) { return 0; }
  }

  _remove(p) {
    try {
      if (typeof this.fs.rmSync === 'function') this.fs.rmSync(p, { force: true });
      else this.fs.unlinkSync(p);
    } catch (_) { /* already gone */ }
  }

  _emit(onProgress, payload) {
    if (typeof onProgress !== 'function') return;
    try { onProgress(payload); } catch (_) { /* never let a progress handler break the download */ }
  }

  _drain(out) {
    // Resolve on 'drain', but settle cleanly on error/close so a mid-stream write
    // failure can never leave this awaiting forever.
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        out.removeListener('drain', onDrain);
        out.removeListener('error', onError);
        out.removeListener('close', onClose);
      };
      const onDrain = () => { cleanup(); resolve(); };
      const onError = (e) => { cleanup(); reject(e); };
      const onClose = () => { cleanup(); resolve(); };
      out.once('drain', onDrain);
      out.once('error', onError);
      out.once('close', onClose);
    });
  }

  _isNetworkError(e) {
    if (!e) return false;
    if (e.code && NET_ERROR_CODES.has(e.code)) return true;
    return /getaddrinfo|ENOTFOUND|ECONNREFUSED|network|offline|dns|socket hang up/i.test(e.message || '');
  }
}

module.exports = WhisperModelDownloader;
module.exports.WhisperModelDownloader = WhisperModelDownloader;
module.exports.DEFAULT_MODELS = DEFAULT_MODELS;
