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
const { URL } = require('node:url'); // native URL, immune to the Azure polyfill poisoning global.URL
const ServiceSupervisor = require('./service-supervisor');
const { ensureNativeGlobalURL, nodeFetch } = require('./local-transport');

const MIN_RAM_GB = 16; // qwen3-vl:8b recommended unified-memory floor
const MIN_DISK_GB = 7; // ~6 GB model weights + headroom

class LocalModelManager {
  constructor({ supervisor, ollama, spawn, config, logger } = {}) {
    // The Azure STT browser-DOM polyfill (speech.service.js, required at main.js
    // startup) clobbers global.URL with a fake that mis-parses every host to
    // localhost — which breaks the ollama client's formatHost. Restore the
    // native global URL before constructing any client. (Idempotent no-op when
    // unpolluted; see local-transport.js.)
    ensureNativeGlobalURL();

    const cfg = config || require('./config');
    const local = cfg.get('llm.local') || {};
    this.host = local.host || 'http://127.0.0.1:11434';
    this.model = local.model || 'qwen3-vl:8b';
    this.keepAlive = local.keepAlive != null ? local.keepAlive : -1;
    this.curatedModels = Array.isArray(local.curatedModels) ? local.curatedModels : [];

    this.logger = logger || require('./logger').createServiceLogger('MODEL');
    // DI seam: tests pass a fake ollama client; production builds the real one.
    // Hand it a Node-http fetch (nodeFetch): the Electron main-process ambient
    // fetch is Chromium-net-backed and false-negatives the loopback daemon that
    // Node http reaches fine, so list/pull/generate must not use it.
    this.ollama = ollama || new (require('ollama').Ollama)({ host: this.host, fetch: nodeFetch });

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
      // Electron's stripped GUI PATH omits /opt/homebrew/bin etc., so prepend the
      // standard ollama bin dirs (see _buildSpawnPath — it also folds the inherited
      // PATH back in, since the supervisor merges def.env over process.env).
      env: { OLLAMA_HOST: ollamaHost, OLLAMA_KEEP_ALIVE: String(this.keepAlive), PATH: this._buildSpawnPath() },
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

  async getStatus({ probeResponds = true } = {}) {
    // Fuse supervisor lifecycle state with three-level health so the UI can
    // give three distinct messages (server down vs model missing vs unhealthy).
    // `probeResponds:false` skips the (bounded) model-liveness generate for the
    // hot detection path (onboarding runOllamaDetect / status polls), which only
    // needs serverUp — so that path never triggers a generate at all.
    const s = this.supervisor.getStatus(); // { name, state, attempt, pid, owned }
    const serverUp = await this._probeVersion();
    let modelPresent = false;
    let modelResponds = false;
    if (serverUp) {
      // Guard: once the server is proven reachable, a model-probe failure must
      // NEVER flip serverUp false — the three health levels are independent, and
      // the onboarding Continue gate keys off serverUp alone.
      try {
        modelPresent = await this._isModelPresent();
        if (modelPresent && probeResponds) modelResponds = await this._modelResponds();
      } catch (e) {
        this.logger.warn('model probe failed after serverUp; keeping serverUp=true', { error: e.message });
      }
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
    // Probe /api/version over Node `http`, NOT the global `fetch`: in the Electron
    // main process `fetch` is Chromium-net-backed and returns a false negative for
    // the loopback daemon that Node `http` reaches fine. Reuse the supervisor's
    // probeHttp — the same deterministic transport that already adopts the daemon —
    // so a reachable daemon is reported serverUp regardless of the ambient fetch.
    // `URL` here is the module-scoped NATIVE node:url URL (see the top-of-file
    // import), immune to the Azure polyfill poisoning global.URL — without that,
    // `new URL(this.host)` would yield hostname 'localhost' and mis-target the probe.
    try {
      const u = new URL(this.host);
      const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
      return await ServiceSupervisor.probeHttp({
        host: u.hostname,
        port,
        path: '/api/version',
        timeoutMs,
      });
    } catch (_) {
      return false;
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

  async _modelResponds(tag = this.model, { timeoutMs = 2500 } = {}) {
    // Cheap, hard-bounded liveness ping — getStatus() must NEVER hang on it. A
    // cold model load can exceed timeoutMs on the very first probe (resolves
    // false, not a tens-of-seconds hang on "Probing"); once resident
    // (keep_alive:-1 + warmUp) it answers in ms. think:false stops qwen3 from
    // emitting reasoning and num_predict:1 caps decode to a single token, so the
    // probe is a ping, not a full generation.
    let timer;
    try {
      const ping = this.ollama
        .generate({ model: tag, prompt: '', think: false, keep_alive: this.keepAlive, options: { num_predict: 1 } })
        .then(() => true, () => false);
      const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
      return await Promise.race([ping, timeout]);
    } catch (_) {
      return false;
    } finally {
      clearTimeout(timer);
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
    for (const p of this._ollamaBinFallbacks()) {
      try { if (fs.existsSync(p)) return p; } catch (_) { /* ignore */ }
    }
    return null;
  }

  _ollamaBinFallbacks() {
    // Standard install locations checked when `ollama` is not on PATH — Electron's
    // stripped GUI PATH makes `which ollama` fail even when it IS installed, so
    // own-if-started would otherwise never find the binary and never spawn.
    if (process.platform === 'win32') return [];
    const homeBin = path.join(os.homedir(), '.ollama', 'bin', 'ollama'); // official install-to-home
    if (process.platform === 'darwin') {
      return [
        '/opt/homebrew/bin/ollama', // Homebrew (Apple Silicon)
        '/usr/local/bin/ollama', // Homebrew (Intel) / manual
        homeBin,
        '/Applications/Ollama.app/Contents/Resources/ollama', // Ollama.app bundle
      ];
    }
    return ['/usr/local/bin/ollama', '/usr/bin/ollama', homeBin];
  }

  _buildSpawnPath() {
    // Prepend the ollama bin dirs (the resolved binary's dir + the standard
    // fallbacks) to the inherited PATH so a spawned `ollama serve` — and anything
    // it resolves — works under Electron's stripped GUI PATH. Prepend, never
    // replace: the supervisor merges def.env over process.env, so the inherited
    // PATH must be folded back in here or it would be dropped entirely.
    const dirs = new Set();
    if (this.ollamaBin) dirs.add(path.dirname(this.ollamaBin));
    for (const p of this._ollamaBinFallbacks()) dirs.add(path.dirname(p));
    const prepend = [...dirs].join(path.delimiter);
    const base = process.env.PATH || '';
    return base ? `${prepend}${path.delimiter}${base}` : prepend;
  }
}

module.exports = LocalModelManager;
module.exports.LocalModelManager = LocalModelManager;
