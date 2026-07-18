'use strict';

/**
 * Notes/md-context loader (CONT-05). Reads a settings-configured folder of
 * top-level `.md` files at launch into ONE bounded string that rides every
 * model call as the RequestBuilder `mdContext` system-prefix slot.
 *
 * Locked semantics (05-CONTEXT.md):
 * - Launch-only reload: config values are read at load() time, load() runs
 *   once in onAppReady — edit notes -> restart to apply. No file watching.
 * - Budget applies to the FINAL assembled string (headers + separators
 *   included) — the exact string that hits the prompt. Default 12,000 chars
 *   (pre-validated by the 03-07 prefill smoke), NOTES_BUDGET_CHARS override.
 * - Over budget: whole files in stable alphabetical order; stop before the
 *   first file that would bust the budget (never skip-and-continue, never
 *   mid-file truncation). "N of M files loaded" surfaced via getStatus().
 * - Degrade-never-crash: missing/unset/unreadable folder -> empty context.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger').createServiceLogger('CONTEXT');

const SEPARATOR = '\n\n---\n\n';

/**
 * Pure whole-file budget selection. `files` must be pre-sorted; each entry's
 * `chars` is the cost of appending that file to the assembled string (the
 * caller bakes headers/separators in). Iterates in order, accumulating, and
 * STOPS at the first file that would exceed the budget — whole files, stable
 * order, no skip-and-continue.
 *
 * @param {Array<{name: string, chars: number}>} files - pre-sorted entries.
 * @param {number} budget - max total chars.
 * @returns {{loaded: string[], total: number}} names taken + their char sum.
 */
function selectFilesWithinBudget(files, budget) {
  const loaded = [];
  let total = 0;
  for (const file of files) {
    if (total + file.chars > budget) break;
    loaded.push(file.name);
    total += file.chars;
  }
  return { loaded, total };
}

class ContextManager {
  /**
   * @param {object} [options] - DI overrides for tests.
   * @param {string} [options.folder] - notes folder (default: config
   *   `notes.folder`, read at load() time — launch-only semantics).
   * @param {number} [options.budgetChars] - assembled-string budget
   *   (default: config `notes.budgetChars`).
   */
  constructor(options = {}) {
    // Constructor does NO fs and NO config reads — safe to construct as a
    // module singleton before app/config are fully settled.
    this._folderOverride = options.folder;
    this._budgetOverride = options.budgetChars;
    this._context = '';
    this._status = { folder: '', loadedCount: 0, totalCount: 0, chars: 0, budget: 0 };
  }

  /**
   * Read the notes folder into the bounded context string. Called once from
   * onAppReady; never throws (warn-log + empty context on any failure).
   *
   * @returns {Promise<object>} the same shape as getStatus().
   */
  async load() {
    const folder = this._folderOverride !== undefined
      ? this._folderOverride
      : (config.get('notes.folder') || '');
    const budget = this._budgetOverride !== undefined
      ? this._budgetOverride
      : (config.get('notes.budgetChars') || 12000);

    this._context = '';
    this._status = { folder, loadedCount: 0, totalCount: 0, chars: 0, budget };

    if (!folder) {
      logger.info('No notes folder configured');
      return this.getStatus();
    }

    try {
      const entries = await fs.promises.readdir(folder, { withFileTypes: true });
      const names = entries
        .filter((d) => d.isFile() && d.name.endsWith('.md') && !d.name.startsWith('.'))
        .map((d) => d.name)
        .sort(); // default codepoint sort — locale-independent stable order

      const files = [];
      for (const name of names) {
        const content = await fs.promises.readFile(path.join(folder, name), 'utf8');
        files.push({ name, content });
      }

      // Cost of appending file i = its separator (none for the first) + header
      // + content. Because selection is always a prefix of the sorted list,
      // each file's cost is position-stable and the selected total equals the
      // assembled string length exactly.
      const costed = files.map((f, i) => ({
        name: f.name,
        chars: (i === 0 ? 0 : SEPARATOR.length) + `# ${f.name}\n\n`.length + f.content.length
      }));
      const { loaded, total } = selectFilesWithinBudget(costed, budget);

      this._context = files
        .slice(0, loaded.length)
        .map((f) => `# ${f.name}\n\n${f.content}`)
        .join(SEPARATOR);
      this._status = {
        folder,
        loadedCount: loaded.length,
        totalCount: files.length,
        chars: total,
        budget
      };

      logger.info('Notes context assembled', this._status);
      if (loaded.length < files.length) {
        logger.warn('Notes over budget — some files not loaded', this._status);
      }
    } catch (error) {
      this._context = '';
      this._status = { folder, loadedCount: 0, totalCount: 0, chars: 0, budget };
      logger.warn('Notes folder unreadable — continuing without notes', {
        folder,
        error: error.message
      });
    }

    return this.getStatus();
  }

  /**
   * The cached assembled notes string ('' before load / on failure).
   * Cheap read — safe to call on every model request.
   */
  getContext() {
    return this._context;
  }

  /** @returns {{folder: string, loadedCount: number, totalCount: number, chars: number, budget: number}} */
  getStatus() {
    return { ...this._status };
  }
}

module.exports = {
  ContextManager,
  selectFilesWithinBudget,
  // App-wide singleton: main.js load()s it at startup; LocalProvider reads
  // getContext() per request. Constructor is fs/config-free so requiring this
  // module anywhere is always safe.
  contextManager: new ContextManager()
};
