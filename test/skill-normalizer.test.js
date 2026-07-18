'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// Requires ONLY the extracted pure module — never prompt-loader.js.
const { normalizeSkillName } = require('../src/core/skill-normalizer');

describe('normalizeSkillName', () => {
  test('lowercases and folds the legacy dsa aliases into programming', () => {
    assert.equal(normalizeSkillName('DSA'), 'programming');
    assert.equal(normalizeSkillName('algorithms'), 'programming');
    assert.equal(normalizeSkillName('data-structures'), 'programming');
  });

  test('maps ml alias to data-science', () => {
    assert.equal(normalizeSkillName('ml'), 'data-science');
  });

  test('passes unknown skills through lowercased and trimmed', () => {
    assert.equal(normalizeSkillName('  Rust  '), 'rust');
  });

  test('falls back to general for empty / null / undefined', () => {
    assert.equal(normalizeSkillName(''), 'general');
    assert.equal(normalizeSkillName(null), 'general');
    assert.equal(normalizeSkillName(undefined), 'general');
  });
});
