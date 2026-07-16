const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * First-run detection and onboarding helper.
 *
 * Responsibilities:
 *   - Decide whether this is the user's first launch of OpenCluely
 *   - Auto-create a default `.env` from `env.example` if one is missing
 *   - Persist a "first-run completed" sentinel so we don't nag on every launch
 *
 * The onboarding wizard guides local model + speech setup; the settings UI is
 * the source of truth thereafter. This module only handles the bootstrap so the
 * user has something to edit on first launch.
 */
class FirstRunManager {
  constructor(options = {}) {
    this.cwd = options.cwd || process.cwd();
    this.envPath = options.envPath || path.join(this.cwd, '.env');
    this.sentinelPath = options.sentinelPath || path.join(this.cwd, '.opencluely-firstrun-completed');
    this.logger = options.logger || console;
  }

  /**
   * Returns true if this looks like a fresh install — no "first-run completed"
   * sentinel, or no .env yet. Local is the default engine and needs no cloud
   * key, so once onboarding completes (sentinel written) we never nag again.
   */
  needsOnboarding() {
    if (!fs.existsSync(this.sentinelPath)) return true;
    if (!fs.existsSync(this.envPath)) return true;
    return false;
  }

  /**
   * Ensures a .env file exists. If not, copies env.example (if available)
   * or writes a minimal template.
   */
  ensureEnv() {
    if (fs.existsSync(this.envPath)) {
      return { created: false, path: this.envPath };
    }

    const template = this._readTemplate();
    const dir = path.dirname(this.envPath);
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.envPath, template, 'utf8');
      try {
        fs.chmodSync(this.envPath, 0o600);
      } catch (_) { /* best effort */ }
      return { created: true, path: this.envPath };
    } catch (e) {
      this.logger.error && this.logger.error('Failed to create .env', { error: e.message });
      return { created: false, path: this.envPath, error: e.message };
    }
  }

  /**
   * Mark the first-run as completed so we don't keep prompting.
   */
  markCompleted() {
    try {
      fs.writeFileSync(this.sentinelPath, new Date().toISOString(), 'utf8');
    } catch (e) {
      this.logger.warn && this.logger.warn('Could not write first-run sentinel', {
        error: e.message
      });
    }
  }

  /**
   * Get a snapshot of the current setup state for UI / logging.
   */
  getStatus() {
    return {
      envExists: fs.existsSync(this.envPath),
      sentinelExists: fs.existsSync(this.sentinelPath),
      needsOnboarding: this.needsOnboarding()
    };
  }

  _readTemplate() {
    // Prefer env.example if it ships in the project; otherwise write a
    // minimal template that the user can extend.
    const candidates = [
      path.join(this.cwd, 'env.example'),
      path.join(__dirname, '..', '..', 'env.example'),
    ];
    for (const candidate of candidates) {
      try {
        return fs.readFileSync(candidate, 'utf8');
      } catch (_) { /* try next */ }
    }
    return [
      '# OpenCluely configuration',
      '# OpenCluely answers locally via Ollama — no cloud API key required.',
      '# Install Ollama (https://ollama.com/download); onboarding pulls the model.',
      '',
      '# Speech is transcribed locally by the built-in whisper.cpp engine. The voice',
      '# model (ggml) is downloaded by the onboarding wizard into a stable app-data',
      '# folder — no Python, no CLI, no PATH change or restart needed. config.js',
      '# supplies sensible defaults; no speech-specific .env keys are required.',
      ''
    ].join(os.EOL);
  }
}

module.exports = FirstRunManager;
module.exports.FirstRunManager = FirstRunManager;
