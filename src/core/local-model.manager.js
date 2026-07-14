/**
 * LocalModelManager (PROV-05).
 *
 * First real consumer of the generic ServiceSupervisor: it adopts a running
 * Ollama daemon if present and only starts one when absent (never killing a
 * daemon it did not spawn), ensures the configured model is pulled with
 * visible, resumable progress, keeps it resident (keep_alive:-1), does a
 * friendly disk/RAM preflight (warn, never block), and reports owned-vs-adopted
 * plus three-level health (server up / model present / model responds).
 *
 * DI shape mirrors ServiceSupervisor/WhisperInstaller: export the class, take
 * deps via an options object, default to the real singletons. Degrade
 * gracefully — every method returns a status/struct instead of throwing.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ServiceSupervisor = require('./service-supervisor');

const MIN_RAM_GB = 16; // qwen3-vl:8b recommended unified-memory floor
const MIN_DISK_GB = 7; // ~6 GB model weights + headroom

class LocalModelManager {
  constructor({ supervisor, ollama, spawn, config, logger } = {}) {
    const cfg = config || require('./config');
    const local = cfg.get('llm.local') || {};
    this.host = local.host || 'http://127.0.0.1:11434';
    this.model = local.model || 'qwen3-vl:8b';
    this.keepAlive = local.keepAlive != null ? local.keepAlive : -1;
    this.curatedModels = Array.isArray(local.curatedModels) ? local.curatedModels : [];

    this.logger = logger || require('./logger').createServiceLogger('MODEL');
    // DI seam: tests pass a fake ollama client; production builds the real one.
    this.ollama = ollama || new (require('ollama').Ollama)({ host: this.host });

    // Resolve the system `ollama` binary once (guide-install path when absent).
    this.ollamaBin = this._resolveOllamaBin();

    // Supervisor definition (RESEARCH Flag 3, verbatim from the
    // service-supervisor header). `env` is applied only when WE spawn the
    // daemon; an adopted daemon keeps its own env, so warmUp() also sends an
    // explicit keep_alive request (belt-and-suspenders for resident behavior).
    const ollamaHost = this.host.replace(/^https?:\/\//, ''); // '127.0.0.1:11434'
    const def = {
      name: 'ollama',
      command: this.ollamaBin || 'ollama',
      args: ['serve'],
      env: { OLLAMA_HOST: ollamaHost, OLLAMA_KEEP_ALIVE: String(this.keepAlive) },
      healthCheck: { type: 'http', port: 11434, path: '/', timeoutMs: 1000 },
      backoff: { initialDelayMs: 500, multiplier: 2, maxDelayMs: 15000, maxRetries: 8 },
      startupTimeoutMs: 30000,
      adopt: true, // adopt a running daemon; supervisor.stop() never kills it
    };
    this._ownsSupervisor = !supervisor;
    this.supervisor = supervisor || new ServiceSupervisor(def, { spawn });
  }

  // ── Lifecycle ──

  async start() {
    // Guide-install path: no binary to spawn and we own the supervisor. Do NOT
    // spawn; surface not-installed so the UI can point the user at Ollama.
    if (this._ownsSupervisor && !this.ollamaBin) {
      return this._offlineStatus({ ok: false, reason: 'not-installed', installed: false });
    }
    try {
      await this.supervisor.start(); // adopts if present, else spawns + health-polls
    } catch (e) {
      this.logger.error('ollama supervisor failed to start', { error: e.message });
      return this._offlineStatus({ ok: false, reason: 'start-failed', error: e.message });
    }
    return this.getStatus();
  }

  async stop() {
    try {
      await this.supervisor.stop(); // no-op if adopted (never kills a foreign daemon)
    } catch (e) {
      this.logger.warn('ollama supervisor failed to stop', { error: e.message });
    }
  }

  async detect() {
    return { running: await this._probeVersion(), installed: !!this.ollamaBin };
  }

  // ── Model provisioning ──

  async ensureModel(tag = this.model, { onProgress } = {}) {
    try {
      const list = await this.ollama.list();
      const names = (list && list.models ? list.models : []).map((m) => m.name);
      if (!this._modelInList(names, tag)) {
        await this.pullModel(tag, { onProgress });
      }
      await this.warmUp(tag);
      return { ok: true, present: true, model: tag };
    } catch (e) {
      this.logger.error('ensureModel failed', { model: tag, error: e.message });
      return { ok: false, present: false, model: tag, error: e.message };
    }
  }

  async pullModel(tag = this.model, { onProgress } = {}) {
    // `ollama pull` resumes interrupted layers + verifies sha256 before
    // 'success' (resumable + checksummed for free — do NOT hand-roll range
    // requests). Cache stays at Ollama's default (~/.ollama/models); no custom
    // path is set. Progress is emitted as structured { status, percent }.
    for await (const part of await this.ollama.pull({ model: tag, stream: true })) {
      const percent = part.completed && part.total
        ? Math.round((part.completed / part.total) * 100)
        : null;
      if (typeof onProgress === 'function') {
        onProgress({ status: part.status, percent, completed: part.completed, total: part.total });
      }
    }
    return { ok: true, model: tag };
  }

  async warmUp(tag = this.model) {
    // Enforce resident behavior regardless of adopt/own with a one-shot
    // keep_alive request. Best-effort — swallow errors.
    try {
      await this.ollama.generate({ model: tag, prompt: '', keep_alive: this.keepAlive });
    } catch (_) { /* best-effort warm-up */ }
  }

  async listInstalledModels() {
    // Feeds the advanced "any installed" model picker (03-05).
    try {
      const list = await this.ollama.list();
      return (list && list.models ? list.models : []).map((m) => m.name);
    } catch (_) {
      return [];
    }
  }

  // ── Health / status ──

  async getStatus() {
    // Fuse supervisor lifecycle state with three-level health so the UI can
    // give three distinct messages (server down vs model missing vs unhealthy).
    const s = this.supervisor.getStatus(); // { name, state, attempt, pid, owned }
    const serverUp = await this._probeVersion();
    let modelPresent = false;
    let modelResponds = false;
    if (serverUp) {
      modelPresent = await this._isModelPresent();
      if (modelPresent) modelResponds = await this._modelResponds();
    }
    return {
      owned: !!s.owned,
      adopted: s.state === 'adopted',
      state: s.state,
      pid: s.pid || null,
      serverUp,
      modelPresent,
      modelResponds,
      model: this.model,
    };
  }

  async preflight() {
    // Warn, never block (locked friendly-failure decision). Small disk/RAM
    // produce warnings; the caller shows them and proceeds anyway.
    const warnings = [];

    const ramGb = Math.round((os.totalmem() / 1e9) * 10) / 10;
    if (ramGb < MIN_RAM_GB) {
      warnings.push(
        `Only ${ramGb} GB of memory detected. ${this.model} runs best with ${MIN_RAM_GB} GB or more — `
        + 'it may run slowly or fall back to CPU. Continuing anyway.',
      );
    }

    let diskOk = true;
    let freeDiskGb = null;
    try {
      if (typeof fs.statfsSync === 'function') {
        const st = fs.statfsSync(this._cacheVolumePath());
        freeDiskGb = Math.round(((st.bavail * st.bsize) / 1e9) * 10) / 10;
        diskOk = freeDiskGb >= MIN_DISK_GB;
        if (!diskOk) {
          warnings.push(
            `Only ${freeDiskGb} GB free where models are stored. The model needs about ${MIN_DISK_GB} GB — `
            + 'free up space to avoid a failed download. Continuing anyway.',
          );
        }
      }
    } catch (_) { /* best-effort — leave diskOk true if statfs is unavailable */ }

    return { ok: warnings.length === 0, diskOk, ramGb, freeDiskGb, warnings };
  }

  // ── Internals ──

  _offlineStatus(extra = {}) {
    const s = this.supervisor
      ? this.supervisor.getStatus()
      : { state: 'idle', owned: false, pid: null };
    return {
      owned: !!s.owned,
      adopted: s.state === 'adopted',
      state: s.state,
      pid: s.pid || null,
      serverUp: false,
      modelPresent: false,
      modelResponds: false,
      model: this.model,
      ...extra,
    };
  }

  async _probeVersion(timeoutMs = 1000) {
    // Built-in fetch (Electron 29 / Node 18+), timeout-bounded so it never hangs.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.host}/api/version`, { signal: ctrl.signal });
      return !!(res && res.ok);
    } catch (_) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async _isModelPresent(tag = this.model) {
    try {
      const list = await this.ollama.list();
      const names = (list && list.models ? list.models : []).map((m) => m.name);
      return this._modelInList(names, tag);
    } catch (_) {
      return false;
    }
  }

  async _modelResponds(tag = this.model) {
    try {
      await this.ollama.generate({ model: tag, prompt: '', keep_alive: this.keepAlive });
      return true;
    } catch (_) {
      return false;
    }
  }

  _modelInList(names, tag) {
    if (!Array.isArray(names)) return false;
    if (names.includes(tag)) return true;
    // Ollama stores an untagged name as `<name>:latest`.
    if (!tag.includes(':')) return names.includes(`${tag}:latest`);
    return false;
  }

  _cacheVolumePath() {
    // Ollama's default cache is ~/.ollama/models; statfs needs an existing path,
    // so fall back to the home dir (same volume) before the cache dir exists.
    try {
      const base = path.join(os.homedir(), '.ollama');
      if (fs.existsSync(base)) return base;
    } catch (_) { /* ignore */ }
    return os.homedir();
  }

  _resolveOllamaBin() {
    // Resolve `ollama` on PATH via which/where (mirrors whisper-installer's
    // _detectPython), then check common install locations. Returns the path or
    // null (null drives the guide-install UX — start() never throws).
    const isWin = process.platform === 'win32';
    const finder = isWin ? 'where' : 'which';
    const names = isWin ? ['ollama.exe', 'ollama'] : ['ollama'];
    for (const n of names) {
      try {
        const r = spawnSync(finder, [n], { windowsHide: true, encoding: 'utf8' });
        if (r.status === 0) {
          const line = (r.stdout || '')
            .toString()
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean)[0];
          if (line) return line;
        }
      } catch (_) { /* ignore */ }
    }
    const fallbacks = isWin
      ? []
      : process.platform === 'darwin'
        ? ['/opt/homebrew/bin/ollama', '/usr/local/bin/ollama', '/Applications/Ollama.app/Contents/Resources/ollama']
        : ['/usr/local/bin/ollama', '/usr/bin/ollama'];
    for (const p of fallbacks) {
      try { if (fs.existsSync(p)) return p; } catch (_) { /* ignore */ }
    }
    return null;
  }
}

module.exports = LocalModelManager;
module.exports.LocalModelManager = LocalModelManager;
