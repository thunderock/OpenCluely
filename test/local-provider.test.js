'use strict';

// LocalProvider unit tests — fully network-free (no Ollama, no HTTP).
//
// Proves the two things Plan 03-03 must guarantee before a live smoke:
//  1) serialize() emits the exact OpenAI messages shape (system prefix,
//     'model'->'assistant' history rename, base64 data-URL image_url part,
//     plain-string content when there are no images) — the SC4 wire-shape site.
//  2) The provider degrades gracefully with Ollama down (constructs without
//     throwing; canned fallback), and the registry + facade select Local by
//     default (Gemini stays registered).
//
// Mirrors test/gemini-request-parity.test.js + test/request-builder.test.js.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { LocalProvider } = require('../src/services/providers/local.provider');
const config = require('../src/core/config');

// Hand-built neutral structs (the shape RequestBuilder emits) so serialize() is
// exercised in isolation, with no RequestBuilder/session/prompt dependencies.
function textNeutral(overrides = {}) {
  return {
    kind: 'text',
    skill: 'general',
    systemPrompt: 'SYS',
    userText: 'hello',
    images: [],
    history: [
      { role: 'model', content: 'prev-answer' },
      { role: 'user', content: 'prev-question' }
    ],
    mdContext: '',
    ...overrides
  };
}

function imageNeutral(overrides = {}) {
  return {
    kind: 'image',
    skill: 'general',
    systemPrompt: 'IMG-SYS',
    userText: 'describe this',
    images: [{ data: 'AAAA', mimeType: 'image/png' }],
    history: [],
    mdContext: '',
    ...overrides
  };
}

describe('LocalProvider.serialize() → OpenAI messages shape (SC4)', () => {
  test('model comes from config.llm.local.model', () => {
    const p = new LocalProvider();
    const { model } = p.serialize(textNeutral());
    assert.equal(model, config.get('llm.local.model'));
  });

  test('system message present when systemPrompt set; history model→assistant rename', () => {
    const p = new LocalProvider();
    const { messages } = p.serialize(textNeutral());

    assert.equal(messages[0].role, 'system');
    assert.equal(messages[0].content, 'SYS');
    // neutral 'model' → OpenAI 'assistant'; any other role → 'user'
    assert.equal(messages[1].role, 'assistant');
    assert.equal(messages[1].content, 'prev-answer');
    assert.equal(messages[2].role, 'user');
    assert.equal(messages[2].content, 'prev-question');
    // no images → final user turn is a plain string
    const last = messages[messages.length - 1];
    assert.equal(last.role, 'user');
    assert.equal(last.content, 'hello');
  });

  test('no system message when systemPrompt + mdContext are both empty', () => {
    const p = new LocalProvider();
    const { messages } = p.serialize(textNeutral({ systemPrompt: null, mdContext: '', history: [] }));
    assert.equal(messages[0].role, 'user');
  });

  test('mdContext is appended to the system prefix (wired now for Phase 5)', () => {
    const p = new LocalProvider();
    const { messages } = p.serialize(textNeutral({ systemPrompt: 'SYS', mdContext: 'NOTES', history: [] }));
    assert.equal(messages[0].role, 'system');
    assert.equal(messages[0].content, 'SYS\n\nNOTES');
  });

  test('image neutral → user message with a text part + a base64 data-URL image_url part', () => {
    const p = new LocalProvider();
    const { messages } = p.serialize(imageNeutral());
    const userMsg = messages[messages.length - 1];

    assert.equal(userMsg.role, 'user');
    assert.ok(Array.isArray(userMsg.content), 'image turn content must be a parts array');
    assert.deepEqual(userMsg.content[0], { type: 'text', text: 'describe this' });
    assert.deepEqual(userMsg.content[1], {
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,AAAA' }
    });
  });

  test('multiple images → multiple image_url parts on the same user turn', () => {
    const p = new LocalProvider();
    const { messages } = p.serialize(imageNeutral({
      images: [
        { data: 'AAAA', mimeType: 'image/png' },
        { data: 'BBBB', mimeType: 'image/jpeg' }
      ]
    }));
    const userMsg = messages[messages.length - 1];
    assert.equal(userMsg.content.length, 3); // text + 2 images
    assert.equal(userMsg.content[1].image_url.url, 'data:image/png;base64,AAAA');
    assert.equal(userMsg.content[2].image_url.url, 'data:image/jpeg;base64,BBBB');
  });
});

describe('LocalProvider graceful degradation (Ollama down)', () => {
  test('constructor does not throw with no Ollama running', () => {
    assert.doesNotThrow(() => new LocalProvider());
  });

  test('isAvailable() returns a boolean', () => {
    const p = new LocalProvider();
    assert.equal(typeof p.isAvailable(), 'boolean');
  });

  test('generateIntelligentFallbackResponse → { response, metadata:{ usedFallback:true } }', () => {
    const p = new LocalProvider();
    const r = p.generateIntelligentFallbackResponse('x', 'general');
    assert.equal(typeof r.response, 'string');
    assert.ok(r.response.length > 0);
    assert.equal(r.metadata.usedFallback, true);
    assert.equal(r.metadata.skill, 'general');
  });
});

describe('Registry + facade resolve LocalProvider by default (PROV-06)', () => {
  test('registry.getSelected() is the LocalProvider instance', () => {
    const registry = require('../src/services/providers');
    assert.equal(registry.getSelected().getStats().provider, 'local');
  });

  test('gemini stays registered during the transition window', () => {
    const registry = require('../src/services/providers');
    assert.ok(registry.get('gemini'), 'gemini must remain registered until PROV-07');
    assert.ok(registry.get('local'), 'local must be registered');
  });

  test('facade (llm.service) resolves to LocalProvider', () => {
    const facade = require('../src/services/llm.service');
    assert.equal(facade.getStats().provider, 'local');
  });
});
