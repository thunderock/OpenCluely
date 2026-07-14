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
  test('lowercases and maps known aliases to dsa', () => {
    assert.equal(normalizeSkillName('DSA'), 'dsa');
    assert.equal(normalizeSkillName('algorithms'), 'dsa');
    assert.equal(normalizeSkillName('data-structures'), 'dsa');
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
  test('dsa + cpp produces the DSA block with C++ and a cpp fence tag', () => {
    const out = injectProgrammingLanguage('BASE PROMPT', 'cpp', 'dsa');
    assert.ok(out.startsWith('BASE PROMPT'), 'original prompt is preserved as a prefix');
    assert.ok(out.includes('IMPLEMENTATION LANGUAGE: C++'));
    assert.ok(out.includes('```cpp'), 'uses the cpp fence tag');
    assert.ok(
      out.trimEnd().endsWith('correctness, clarity, and efficiency.'),
      'ends with the DSA strict-requirements block'
    );
  });

  test('dsa + js resolves to JavaScript with a javascript fence tag', () => {
    const out = injectProgrammingLanguage('BASE', 'js', 'dsa');
    assert.ok(out.includes('JavaScript'));
    assert.ok(out.includes('```javascript'));
  });

  test('non-dsa skill uses the default PROGRAMMING LANGUAGE block', () => {
    const out = injectProgrammingLanguage('BASE', 'python', 'general');
    assert.ok(out.includes('PROGRAMMING LANGUAGE:'));
    assert.ok(!out.includes('IMPLEMENTATION LANGUAGE:'), 'default case is not the DSA block');
  });

  test('unknown languages are title-cased', () => {
    const out = injectProgrammingLanguage('BASE', 'rust', 'general');
    assert.ok(out.includes('Rust'), 'rust is title-cased to Rust');
  });
});

describe('SKILLS_REQUIRING_PROGRAMMING_LANGUAGE', () => {
  test('is the single-source-of-truth list [dsa]', () => {
    assert.deepStrictEqual(SKILLS_REQUIRING_PROGRAMMING_LANGUAGE, ['dsa']);
  });
});
