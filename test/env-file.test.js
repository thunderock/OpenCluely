'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// Requires ONLY the extracted pure module — never main.js / first-run.js.
const { parseEnv, formatEnvValue, upsertEnvContent } = require('../src/core/env-file');

describe('formatEnvValue', () => {
  test('leaves a simple value unquoted', () => {
    assert.equal(formatEnvValue('turbo'), 'turbo');
  });

  test('wraps whitespace-containing values in single quotes', () => {
    assert.equal(formatEnvValue('a b'), "'a b'");
  });

  test('preserves Windows backslashes and single-quote-wraps a spaced path', () => {
    const out = formatEnvValue('C:\\Users\\Jane Doe\\python.exe');
    assert.equal(out, "'C:\\Users\\Jane Doe\\python.exe'");
    assert.ok(out.includes('\\'), 'backslashes must be preserved verbatim');
  });

  test('collapses newlines to a single space', () => {
    assert.equal(formatEnvValue('line1\nline2'), "'line1 line2'");
    assert.equal(formatEnvValue('a\n\r\nb'), "'a b'");
  });

  test('falls back to double quotes when the value contains a single quote', () => {
    // Needs whitespace (or " / #) too, else it would return unquoted.
    assert.equal(formatEnvValue("can't do"), `"can't do"`);
  });

  test('escapes interior double quotes in the double-quote fallback', () => {
    const out = formatEnvValue(`he said "hi" it's ok`);
    assert.ok(out.startsWith('"') && out.endsWith('"'));
    assert.ok(out.includes('\\"hi\\"'), 'interior double quotes escaped');
    assert.ok(out.includes("it's"), 'the single quote stays raw');
  });
});

describe('parseEnv', () => {
  test('skips blank + comment lines and reads KEY=value', () => {
    assert.deepEqual(parseEnv('# comment\n\nKEY=value\n'), { KEY: 'value' });
  });

  test('unwraps double- and single-quoted values', () => {
    assert.deepEqual(parseEnv(`A="hello world"\nB='single'`), {
      A: 'hello world',
      B: 'single'
    });
  });

  test('strips a trailing unquoted inline comment', () => {
    assert.deepEqual(parseEnv('K=val # trailing comment'), { K: 'val' });
  });

  test('handles CRLF line endings', () => {
    assert.deepEqual(parseEnv('A=1\r\nB=2\r\n'), { A: '1', B: '2' });
  });

  test('returns an empty object for empty content', () => {
    assert.deepEqual(parseEnv(''), {});
  });
});

describe('upsertEnvContent', () => {
  test('replaces an existing key in place, preserving a leading comment', () => {
    const existing = '# my config\nGEMINI_API_KEY=old\nSPEECH_PROVIDER=whisper';
    const out = upsertEnvContent(existing, { GEMINI_API_KEY: 'new' });
    assert.equal(
      out,
      '# my config\nGEMINI_API_KEY=new\nSPEECH_PROVIDER=whisper'
    );
  });

  test('appends a genuinely new key', () => {
    assert.equal(upsertEnvContent('EXISTING=1', { NEW_KEY: 'v' }), 'EXISTING=1\nNEW_KEY=v');
  });

  test('leaves unrelated lines (comments, blanks, other keys) untouched', () => {
    const existing = '# top\n\nA=1\n\n# mid\nB=2';
    assert.equal(upsertEnvContent(existing, { B: '22' }), '# top\n\nA=1\n\n# mid\nB=22');
  });

  test('appends into empty content and applies formatEnvValue to values', () => {
    assert.equal(upsertEnvContent('', { WHISPER_COMMAND: 'a b' }), "WHISPER_COMMAND='a b'");
  });

  test('round-trip: upsert then parse recovers a spaced Windows command', () => {
    const value = 'C:\\Users\\Jane Doe\\python.exe -m whisper';
    const content = upsertEnvContent('', { WHISPER_COMMAND: value });
    assert.equal(parseEnv(content).WHISPER_COMMAND, value);
  });
});
