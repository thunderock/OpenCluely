// SEC-03 — sender-scoped IPC allowlist tests (05-05).
//
// Covers: the privileged trio denial for the overlay/chat renderers,
// default-deny on unknown channels AND unknown/null window types, the
// Phase-5 channel rows (select-notes-folder / open-privacy-settings /
// relaunch-app), and a COMPLETENESS reflection test that extracts every
// ipcMain/guarded registration from main.js source and asserts each has
// a declared audience row — so a future channel added without a table row
// fails CI (and is denied at runtime by default-deny).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { CHANNEL_AUDIENCES, isChannelAllowed } = require('../src/core/ipc-scope');

const KNOWN_WINDOW_TYPES = ['main', 'chat', 'llmResponse', 'settings', 'onboarding'];

test('SEC-03 trio: get-settings/save-settings denied for the model-output renderers', () => {
  assert.equal(isChannelAllowed('get-settings', 'llmResponse'), false);
  assert.equal(isChannelAllowed('get-settings', 'chat'), false);
  assert.equal(isChannelAllowed('save-settings', 'llmResponse'), false);
  assert.equal(isChannelAllowed('save-settings', 'chat'), false);
});

test('get-settings allowed for the privileged window classes', () => {
  assert.equal(isChannelAllowed('get-settings', 'settings'), true);
  assert.equal(isChannelAllowed('get-settings', 'main'), true);
  assert.equal(isChannelAllowed('get-settings', 'onboarding'), true);
});

test('open-external: overlay (sanitized links) yes, main no (not in audited usage)', () => {
  assert.equal(isChannelAllowed('open-external', 'llmResponse'), true);
  assert.equal(isChannelAllowed('open-external', 'chat'), true);
  assert.equal(isChannelAllowed('open-external', 'onboarding'), true);
  assert.equal(isChannelAllowed('open-external', 'main'), false);
});

test('copy-to-clipboard: main/chat/llmResponse only', () => {
  assert.equal(isChannelAllowed('copy-to-clipboard', 'main'), true);
  assert.equal(isChannelAllowed('copy-to-clipboard', 'chat'), true);
  assert.equal(isChannelAllowed('copy-to-clipboard', 'llmResponse'), true);
  assert.equal(isChannelAllowed('copy-to-clipboard', 'onboarding'), false);
});

test('SEC-02 recovery channels scoped to the main overlay', () => {
  assert.equal(isChannelAllowed('open-privacy-settings', 'main'), true);
  assert.equal(isChannelAllowed('open-privacy-settings', 'chat'), false);
  assert.equal(isChannelAllowed('open-privacy-settings', 'llmResponse'), false);
  assert.equal(isChannelAllowed('relaunch-app', 'main'), true);
  assert.equal(isChannelAllowed('relaunch-app', 'llmResponse'), false);
});

test('CONT-05 select-notes-folder scoped to the settings window', () => {
  assert.equal(isChannelAllowed('select-notes-folder', 'settings'), true);
  assert.equal(isChannelAllowed('select-notes-folder', 'llmResponse'), false);
  assert.equal(isChannelAllowed('select-notes-folder', 'chat'), false);
  assert.equal(isChannelAllowed('select-notes-folder', 'main'), false);
});

test('default-deny: unknown channel is denied for every window type', () => {
  assert.equal(isChannelAllowed('made-up-channel', 'main'), false);
  for (const t of KNOWN_WINDOW_TYPES) {
    assert.equal(isChannelAllowed('made-up-channel', t), false);
  }
});

test('default-deny: unknown/null/undefined window type is denied on every channel', () => {
  assert.equal(isChannelAllowed('get-settings', null), false);
  assert.equal(isChannelAllowed('get-settings', undefined), false);
  assert.equal(isChannelAllowed('get-settings', 'not-a-window'), false);
  assert.equal(isChannelAllowed('copy-to-clipboard', null), false);
  // Non-string window types never pass (e.g. an array that .includes would match)
  assert.equal(isChannelAllowed('get-settings', ['main']), false);
});

test('table hygiene: every audience is a non-empty array of known window types', () => {
  const channels = Object.keys(CHANNEL_AUDIENCES);
  assert.ok(channels.length >= 55, `expected a full table, got ${channels.length} rows`);
  for (const [channel, audience] of Object.entries(CHANNEL_AUDIENCES)) {
    assert.ok(Array.isArray(audience) && audience.length > 0, `${channel} audience must be a non-empty array`);
    for (const t of audience) {
      assert.ok(KNOWN_WINDOW_TYPES.includes(t), `${channel} has unknown window type '${t}'`);
    }
  }
});

test('COMPLETENESS: every ipcMain channel registered in main.js has a declared audience', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  // Matches BOTH the raw form (ipcMain.handle/on) and the guarded form
  // (guardedHandle/guardedOn) so this test is green before AND after the
  // Task-3 mechanical conversion.
  const re = /(?:ipcMain|guarded[A-Za-z]*)\.?(?:handle|on|Handle|On)\(\s*["']([^"']+)["']/g;
  const registered = new Set();
  let m;
  while ((m = re.exec(source)) !== null) {
    registered.add(m[1]);
  }
  // Guard against the regex silently matching nothing (vacuous pass).
  assert.ok(registered.size >= 55, `expected >= 55 registered channels extracted, got ${registered.size}`);
  const missing = [...registered].filter((ch) => !(ch in CHANNEL_AUDIENCES));
  assert.deepEqual(missing, [], `channels registered in main.js without a CHANNEL_AUDIENCES row: ${missing.join(', ')}`);
});
