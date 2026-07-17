'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Requires ONLY the pure/core module — never main.js or the provider.
const {
  ContextManager,
  selectFilesWithinBudget
} = require('../src/core/context.manager');

describe('selectFilesWithinBudget (pure)', () => {
  test('stop-before-bust: loads whole files in order until the next would exceed', () => {
    const files = [
      { name: 'a.md', chars: 5000 },
      { name: 'b.md', chars: 5000 },
      { name: 'c.md', chars: 5000 }
    ];
    const result = selectFilesWithinBudget(files, 12000);
    assert.deepEqual(result, { loaded: ['a.md', 'b.md'], total: 10000 });
  });

  test('first file alone exceeding the budget loads nothing (no skip-and-continue)', () => {
    const files = [
      { name: 'huge.md', chars: 20000 },
      { name: 'tiny.md', chars: 10 }
    ];
    const result = selectFilesWithinBudget(files, 12000);
    assert.deepEqual(result, { loaded: [], total: 0 });
  });

  test('empty list yields empty selection', () => {
    assert.deepEqual(selectFilesWithinBudget([], 12000), { loaded: [], total: 0 });
  });
});

describe('ContextManager.load (tmpdir integration)', () => {
  function makeFixtureDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-'));
    return dir;
  }

  function rmrf(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  test('loads only top-level non-dot .md files, alphabetical, with per-file headers', async () => {
    const dir = makeFixtureDir();
    try {
      // Deliberately write b before a — order must come from the sort, not fs.
      fs.writeFileSync(path.join(dir, 'b.md'), 'beta notes');
      fs.writeFileSync(path.join(dir, 'a.md'), 'alpha notes');
      fs.writeFileSync(path.join(dir, '.hidden.md'), 'dotfile must be ignored');
      fs.writeFileSync(path.join(dir, 'notes.txt'), 'txt must be ignored');
      fs.mkdirSync(path.join(dir, 'subdir'));
      fs.writeFileSync(path.join(dir, 'subdir', 'd.md'), 'nested must be ignored');

      const manager = new ContextManager({ folder: dir, budgetChars: 12000 });
      await manager.load();

      const context = manager.getContext();
      assert.ok(context.includes('# a.md'), 'context carries the a.md header');
      assert.ok(context.includes('# b.md'), 'context carries the b.md header');
      assert.ok(
        context.indexOf('# a.md') < context.indexOf('# b.md'),
        'a.md comes before b.md (alphabetical)'
      );
      assert.ok(context.includes('alpha notes'));
      assert.ok(context.includes('beta notes'));
      assert.ok(!context.includes('dotfile must be ignored'), 'dotfiles skipped');
      assert.ok(!context.includes('txt must be ignored'), 'non-md skipped');
      assert.ok(!context.includes('nested must be ignored'), 'subdirs skipped (top-level only)');

      const status = manager.getStatus();
      assert.equal(status.loadedCount, 2);
      assert.equal(status.totalCount, 2);
      assert.equal(status.folder, dir);
      assert.equal(status.budget, 12000);
      assert.equal(status.chars, context.length);
    } finally {
      rmrf(dir);
    }
  });

  test('folder unset yields empty context and zero counts without throwing', async () => {
    const manager = new ContextManager({ folder: '', budgetChars: 12000 });
    const status = await manager.load();
    assert.equal(manager.getContext(), '');
    assert.equal(manager.getStatus().loadedCount, 0);
    assert.equal(status.loadedCount, 0);
  });

  test('nonexistent folder degrades to empty context without throwing', async () => {
    const missing = path.join(os.tmpdir(), 'notes-definitely-missing-xyz');
    const manager = new ContextManager({ folder: missing, budgetChars: 12000 });
    await manager.load();
    assert.equal(manager.getContext(), '');
    assert.equal(manager.getStatus().loadedCount, 0);
    assert.equal(manager.getStatus().totalCount, 0);
  });

  test('budget bounds the ASSEMBLED string (headers + separators included)', async () => {
    const dir = makeFixtureDir();
    try {
      // Block for a.md = '# a.md\n\nhello' = 13 chars (fits in 20).
      // Block for b.md = '\n\n---\n\n# b.md\n\nworld' = 20 chars -> 13+20=33 > 20, stop.
      // Raw content is only 10 chars, so a content-only budget would load BOTH —
      // this distinguishes assembled-string budgeting from content budgeting.
      fs.writeFileSync(path.join(dir, 'a.md'), 'hello');
      fs.writeFileSync(path.join(dir, 'b.md'), 'world');

      const manager = new ContextManager({ folder: dir, budgetChars: 20 });
      await manager.load();

      const context = manager.getContext();
      assert.ok(context.length <= 20, `assembled length ${context.length} must be <= 20`);
      assert.equal(context, '# a.md\n\nhello');
      const status = manager.getStatus();
      assert.equal(status.loadedCount, 1);
      assert.equal(status.totalCount, 2);
      assert.equal(status.chars, 13);
    } finally {
      rmrf(dir);
    }
  });

  test('without overrides, budget defaults to 12000 from config.notes at load() time', async () => {
    const manager = new ContextManager();
    await manager.load(); // NOTES_FOLDER unset in the test env -> empty state
    assert.equal(manager.getStatus().budget, 12000);
    assert.equal(manager.getContext(), '');
  });
});
