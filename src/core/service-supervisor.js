/**
 * Generic process supervisor (FND-04).
 *
 * Spawns and owns a local child process, health-checks it via EITHER a TCP
 * port-open probe OR an HTTP-endpoint probe (chosen per service in its
 * config), restarts it with capped exponential backoff, and — after N failed
 * attempts — gives up by marking state 'failed' and surfacing status instead
 * of crashing or hanging.
 *
 * Adopt-if-present / own-if-started (locked hard requirement, SC4): if a
 * healthy process is already answering on the endpoint and `adopt` is set, the
 * supervisor ADOPTS it (owned=false) and stop() will NEVER kill it. It only
 * terminates (SIGTERM -> SIGKILL) processes it started itself.
 *
 * Written once here and configured twice later, unchanged:
 *   - Ollama (P3):        { healthCheck: { type: 'http', port: 11434, path: '/' }, adopt: true }
 *   - whisper-server (P4): { healthCheck: { type: 'port', port }, adopt: false, pidFile, terminate: { sigtermGraceMs: 5000 } }
 *
 * Shape mirrors WhisperInstaller: export the CLASS, take deps via an options
 * object, and expose the spawn function as an injectable seam (`options.spawn
 * || spawn`) so tests can drive it with a real or fake process.
 */

const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const fs = require('fs');
const EventEmitter = require('events');
const logger = require('./logger').createServiceLogger('SUPERVISOR');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Health probes (timeout-bounded, never hang) ──

/**
 * TCP port-open probe. Resolves true if a connection is accepted before the
 * timeout, false on timeout/error. Always destroys the socket; guards against
 * double-resolve.
 */
function probePort({ host = '127.0.0.1', port, timeoutMs = 1000 }) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let done = false;
    const finish = (ok) => { if (done) return; done = true; socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * HTTP-endpoint probe. Resolves true for any real HTTP response
 * (statusCode > 0), false on timeout/error. Drains the response so the socket
 * frees.
 */
function probeHttp({ host = '127.0.0.1', port, path = '/', timeoutMs = 1000 }) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path, timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode > 0);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

/**
 * Pure, separately-testable backoff: initialDelayMs * multiplier^attempt,
 * capped at maxDelayMs.
 */
function computeBackoffDelay(attempt, backoff) {
  return Math.min(backoff.maxDelayMs, backoff.initialDelayMs * (backoff.multiplier ** attempt));
}

class ServiceSupervisor extends EventEmitter {
  // definition = { name, command, args=[], cwd?, env?, healthCheck, backoff,
  //                startupTimeoutMs?, healthPollMs?, adopt?, pidFile?, terminate? }
  //   healthCheck = { type: 'port'|'http', host?, port, path?, timeoutMs? }
  //   backoff     = { initialDelayMs, multiplier, maxDelayMs, maxRetries }
  //   terminate   = { sigtermGraceMs }
  constructor(definition, options = {}) {
    super();
    this.def = definition;
    this.spawn = options.spawn || spawn;   // ← DI seam (WhisperInstaller pattern)
    this.logger = options.logger || logger;
    this.child = null;
    this.owned = false;                    // true only if WE spawned it
    this.state = 'idle';                   // idle|starting|healthy|restarting|failed|stopped|adopted
    this.attempt = 0;
    this._intentionalStop = false;
    this._backoffTimer = null;
    this._startupSettled = false;
  }

  getStatus() {
    return {
      name: this.def.name,
      state: this.state,
      attempt: this.attempt,
      pid: this.child ? this.child.pid : null,
      owned: this.owned,
    };
  }

  _setState(state, extra = {}) {
    this.state = state;
    this.emit('status', this.getStatus());
    // Logger contract: variable data goes in the meta object, never the message.
    this.logger.info('supervisor state', { state, ...extra });
  }

  _probe() {
    const hc = this.def.healthCheck;
    return hc.type === 'http' ? probeHttp(hc) : probePort(hc);
  }

  /**
   * Poll the health probe until it passes or the deadline elapses. Bails early
   * (returns false) if startup already settled (e.g. the child exited), so a
   * dead child doesn't keep the caller waiting for the full timeout.
   */
  async _waitHealthy(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this._startupSettled) return false;
      if (await this._probe()) return true;
      await sleep(this.def.healthPollMs || 50);
    }
    return false;
  }

  async start() {
    this._intentionalStop = false;
    // ADOPT-IF-PRESENT: something already healthy on the endpoint and we didn't
    // spawn it → adopt, never own. stop() must NOT kill this (SC4).
    if (this.def.adopt && await this._probe()) {
      this.owned = false;
      this._setState('adopted');
      return this.getStatus();
    }
    return this._attemptStart();   // OWN-IF-STARTED
  }

  async _attemptStart() {
    this._startupSettled = false;
    this._setState('starting', { attempt: this.attempt });

    try {
      this.child = this.spawn(this.def.command, this.def.args || [], {
        cwd: this.def.cwd,
        env: this.def.env ? { ...process.env, ...this.def.env } : process.env,
        windowsHide: true,
      });
    } catch (e) {
      return this._handleStartupFailure(e.message);
    }

    this.owned = true;
    if (this.def.pidFile) {
      try { fs.writeFileSync(this.def.pidFile, String(this.child.pid)); } catch (_) { /* best effort */ }
    }

    // One-shot startup listeners: a spawn error or an exit *during startup*
    // marks settled and routes to the backoff path exactly once.
    const onStartupExit = (code, signal) => {
      if (this._startupSettled) return;
      this._startupSettled = true;
      this._handleStartupFailure('exited during startup', { code, signal });
    };
    this.child.once('error', (err) => {
      if (this._startupSettled) return;
      this._startupSettled = true;
      this._handleStartupFailure(err.message);
    });
    this.child.once('exit', onStartupExit);

    const healthy = await this._waitHealthy(this.def.startupTimeoutMs || 30000);

    // A startup exit/error already scheduled the restart — don't double up.
    if (this._startupSettled) return this.getStatus();

    this._startupSettled = true;
    this.child.removeListener('exit', onStartupExit);

    if (!healthy) {
      return this._handleStartupFailure('health check did not pass within startup timeout');
    }

    // Healthy: reset the attempt counter and hand off to the long-running crash
    // monitor. An exit now is a real crash (unless we asked for it in stop()).
    this.attempt = 0;
    this.child.once('exit', (code, signal) => {
      if (this._intentionalStop) return;
      this.logger.warn('managed process exited', { code, signal });
      this._scheduleRestart('crashed');
    });
    this._setState('healthy', { pid: this.child.pid });
    return this.getStatus();
  }

  _handleStartupFailure(reason, extra = {}) {
    this.logger.error('managed process failed to start', { reason, ...extra });
    try { if (this.child) this.child.kill('SIGKILL'); } catch (_) { /* best effort */ }
    this._scheduleRestart(reason);
    return this.getStatus();
  }

  _scheduleRestart(reason) {
    if (this._intentionalStop) return;
    if (this._backoffTimer) return;   // guard against double-scheduling
    if (this.attempt >= this.def.backoff.maxRetries) {
      this._setState('failed', { reason });   // give up + surface
      return;
    }
    const delay = computeBackoffDelay(this.attempt, this.def.backoff);
    this.attempt += 1;
    this._setState('restarting', { attempt: this.attempt, delayMs: delay, reason });
    this._backoffTimer = setTimeout(() => {
      this._backoffTimer = null;
      if (!this._intentionalStop) this._attemptStart();
    }, delay);
  }

  async stop() {
    this._intentionalStop = true;
    if (this._backoffTimer) { clearTimeout(this._backoffTimer); this._backoffTimer = null; }

    // NEVER kill an adopted/foreign process (SC4). Also nothing to reap if we
    // never spawned one, or if our owned child has ALREADY exited (e.g. it
    // crashed and we're in 'failed') — otherwise we'd wait the full SIGTERM
    // grace for an 'exit' event that can never fire again, making shutdown
    // needlessly slow after a crash.
    const alreadyExited = this.child && (this.child.exitCode !== null || this.child.signalCode !== null);
    if (!this.owned || !this.child || alreadyExited) {
      this._setState('stopped');
      return;
    }

    const child = this.child;
    const grace = (this.def.terminate && this.def.terminate.sigtermGraceMs) || 5000;
    child.kill('SIGTERM');
    const exited = await new Promise((res) => {
      const t = setTimeout(() => res(false), grace);
      child.once('exit', () => { clearTimeout(t); res(true); });
    });
    if (!exited) {
      child.kill('SIGKILL');
      // SIGKILL reaping is asynchronous — wait for the actual 'exit' before we
      // settle, so a caller's immediate process.kill(pid, 0) liveness check
      // doesn't race the OS. The bounded timeout guarantees we never hang.
      await new Promise((res) => {
        const t = setTimeout(res, 2000);
        child.once('exit', () => { clearTimeout(t); res(); });
      });
    }

    if (this.def.pidFile) {
      try { fs.unlinkSync(this.def.pidFile); } catch (_) { /* best effort */ }
    }
    this._setState('stopped');
  }
}

module.exports = ServiceSupervisor;
module.exports.ServiceSupervisor = ServiceSupervisor;
module.exports.probePort = probePort;
module.exports.probeHttp = probeHttp;
module.exports.computeBackoffDelay = computeBackoffDelay;
