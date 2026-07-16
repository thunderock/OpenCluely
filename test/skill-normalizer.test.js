'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// Requires ONLY the extracted pure module — never prompt-loader.js.
const {
  normalizeSkillName,
  injectProgrammingLanguage,
  SKILLS_REQUIRING_PROGRAMMING_LANGUAGE
} = require('../src/core/skill-normalizer');

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

describe('injectProgrammingLanguage', () => {
  test('programming + cpp produces the implementation-language block with C++ and a cpp fence tag', () => {
    const out = injectProgrammingLanguage('BASE PROMPT', 'cpp', 'programming');
    assert.ok(out.startsWith('BASE PROMPT'), 'original prompt is preserved as a prefix');
    assert.ok(out.includes('IMPLEMENTATION LANGUAGE: C++'));
    assert.ok(out.includes('```cpp'), 'uses the cpp fence tag');
    assert.ok(
      out.trimEnd().endsWith('correctness, clarity, and efficiency.'),
      'ends with the strict-requirements block'
    );
  });

  test('programming + js resolves to JavaScript with a javascript fence tag', () => {
    const out = injectProgrammingLanguage('BASE', 'js', 'programming');
    assert.ok(out.includes('JavaScript'));
    assert.ok(out.includes('```javascript'));
  });

  test('non-programming skill uses the default PROGRAMMING LANGUAGE block', () => {
    const out = injectProgrammingLanguage('BASE', 'python', 'general');
    assert.ok(out.includes('PROGRAMMING LANGUAGE:'));
    assert.ok(!out.includes('IMPLEMENTATION LANGUAGE:'), 'default case is not the implementation block');
  });

  test('unknown languages are title-cased', () => {
    const out = injectProgrammingLanguage('BASE', 'rust', 'general');
    assert.ok(out.includes('Rust'), 'rust is title-cased to Rust');
  });
});

describe('SKILLS_REQUIRING_PROGRAMMING_LANGUAGE', () => {
  test('is the single-source-of-truth list [programming]', () => {
    assert.deepStrictEqual(SKILLS_REQUIRING_PROGRAMMING_LANGUAGE, ['programming']);
  });
});
