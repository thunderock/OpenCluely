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
const { URL: NodeURL } = require('node:url');

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
    p.think = true; // isolate wire-shape assertions from the /no_think concise switch
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
    p.think = true; // with thinking on there is no /no_think system message to prepend
    const { messages } = p.serialize(textNeutral({ systemPrompt: null, mdContext: '', history: [] }));
    assert.equal(messages[0].role, 'user');
  });

  test('mdContext is appended to the system prefix (wired now for Phase 5)', () => {
    const p = new LocalProvider();
    p.think = true; // isolate the mdContext prefix from the /no_think switch
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

describe('LocalProvider concise mode: qwen3 /no_think soft-switch (GEN-01)', () => {
  test('think OFF (default) → /no_think appended to the system message', () => {
    const p = new LocalProvider();
    p.think = false;
    const { messages } = p.serialize(textNeutral({ systemPrompt: 'SYS', mdContext: '', history: [] }));
    assert.equal(messages[0].role, 'system');
    assert.ok(messages[0].content.startsWith('SYS'), 'original system prompt preserved');
    assert.ok(messages[0].content.endsWith('/no_think'), 'system message carries the /no_think switch');
  });

  test('think OFF with no systemPrompt → a bare /no_think system message is prepended', () => {
    const p = new LocalProvider();
    p.think = false;
    const { messages } = p.serialize(textNeutral({ systemPrompt: null, mdContext: '', history: [] }));
    assert.equal(messages[0].role, 'system');
    assert.equal(messages[0].content, '/no_think');
  });

  test('think ON → no /no_think switch (full reasoning preserved)', () => {
    const p = new LocalProvider();
    p.think = true;
    const { messages } = p.serialize(textNeutral({ systemPrompt: 'SYS', mdContext: '', history: [] }));
    assert.equal(messages[0].content, 'SYS');
    assert.ok(!messages[0].content.includes('/no_think'));
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

describe('LocalProvider robustness vs the Azure browser-DOM polyfill (ollama-not-detected)', () => {
  // speech.service.js (required at main.js startup) sets global.window +
  // global.document + global.navigator — the openai SDK's isRunningInBrowser
  // triad, so `new OpenAI()` throws "browser-like environment" unless
  // dangerouslyAllowBrowser is set — AND replaces global.URL with a fake that
  // has no `searchParams`, which the SDK's internal buildURL relies on. A
  // faithful, hermetic proxy for that shim:
  class FakeBrowserURL {
    constructor(href) {
      this.href = href;
      this.protocol = 'https:';
      this.host = 'localhost';
      this.hostname = 'localhost';
      this.port = '';
      this.pathname = '/';
      this.search = '';
    }
    toString() { return this.href; }
  }

  test('client initializes under the polyfilled globals and the poisoned global URL is repaired', () => {
    // Use defineProperty for the whole triad: on Node 21+ `navigator` is a
    // getter-only global (plain assignment throws), whereas Electron 29's Node
    // 20.9 has no global navigator (the real polyfill just assigns it). This
    // override + descriptor restore is robust either way.
    const orig = {
      window: Object.getOwnPropertyDescriptor(global, 'window'),
      document: Object.getOwnPropertyDescriptor(global, 'document'),
      navigator: Object.getOwnPropertyDescriptor(global, 'navigator'),
      URL: Object.getOwnPropertyDescriptor(globalThis, 'URL'),
    };
    const set = (key, value) => Object.defineProperty(global, key, { value, writable: true, configurable: true, enumerable: true });
    const restore = (obj, key, desc) => { if (desc) Object.defineProperty(obj, key, desc); else delete obj[key]; };

    // Install the openai isRunningInBrowser triad + poisoned URL before construct.
    set('window', { navigator: { userAgent: 'Node.js' }, document: { createElement: () => ({}) } });
    set('document', global.window.document);
    set('navigator', global.window.navigator);
    Object.defineProperty(globalThis, 'URL', { value: FakeBrowserURL, writable: true, configurable: true });

    try {
      const p = new LocalProvider();
      // (a) the openai client constructed despite the browser-like environment
      assert.equal(p.isAvailable(), true, 'client must initialize under polyfilled globals (dangerouslyAllowBrowser)');
      // (b) the provider repaired the poisoned global URL to the native one
      assert.equal(globalThis.URL, NodeURL, 'provider must restore the native global URL');
      const u = new globalThis.URL('http://127.0.0.1:11434/v1');
      assert.equal(u.hostname, '127.0.0.1', 'repaired URL parses loopback host correctly');
      assert.equal(u.port, '11434', 'repaired URL parses loopback port correctly');
    } finally {
      restore(global, 'window', orig.window);
      restore(global, 'document', orig.document);
      restore(global, 'navigator', orig.navigator);
      restore(globalThis, 'URL', orig.URL);
    }
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
