'use strict';

// LocalProvider unit tests — fully network-free (no Ollama, no HTTP).
//
// Proves the two things Plan 03-03 must guarantee before a live smoke:
//  1) serialize() emits the exact OpenAI messages shape (system prefix,
//     'model'->'assistant' history rename, base64 data-URL image_url part,
//     plain-string content when there are no images) — the SC4 wire-shape site.
//  2) The provider degrades gracefully with Ollama down (constructs without
//     throwing; canned fallback), and the registry + facade select Local
//     (the sole engine after PROV-07 removed the cloud path).
//
// Mirrors test/request-builder.test.js.

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

describe('LocalProvider initializes network-free', () => {
  test('constructs the openai client without touching Ollama', () => {
    const p = new LocalProvider();
    // Network-free: constructing the client never pings the daemon, so it must
    // report initialized without a live server.
    assert.equal(p.isAvailable(), true, 'client must initialize without a running daemon');
    assert.equal(typeof p.generateStream, 'function');
  });

  test('client still constructs if a window/document/navigator triad is on the global', () => {
    // dangerouslyAllowBrowser is set defensively: even if some other code puts
    // the openai SDK's isRunningInBrowser triad on the global, `new OpenAI()`
    // must not throw "browser-like environment" in the Electron MAIN process.
    const orig = {
      window: Object.getOwnPropertyDescriptor(global, 'window'),
      document: Object.getOwnPropertyDescriptor(global, 'document'),
      navigator: Object.getOwnPropertyDescriptor(global, 'navigator'),
    };
    const set = (key, value) => Object.defineProperty(global, key, { value, writable: true, configurable: true, enumerable: true });
    const restore = (obj, key, desc) => { if (desc) Object.defineProperty(obj, key, desc); else delete obj[key]; };

    set('window', { navigator: { userAgent: 'Node.js' }, document: { createElement: () => ({}) } });
    set('document', global.window.document);
    set('navigator', global.window.navigator);

    try {
      const p = new LocalProvider();
      assert.equal(p.isAvailable(), true, 'client must initialize despite a browser-like global (dangerouslyAllowBrowser)');
    } finally {
      restore(global, 'window', orig.window);
      restore(global, 'document', orig.document);
      restore(global, 'navigator', orig.navigator);
    }
  });
});

describe('Registry + facade resolve LocalProvider by default (PROV-06)', () => {
  test('registry.getSelected() is the LocalProvider instance', () => {
    const registry = require('../src/services/providers');
    assert.equal(registry.getSelected().getStats().provider, 'local');
  });

  test('cloud provider is removed; only local is registered (PROV-07)', () => {
    const registry = require('../src/services/providers');
    assert.ok(registry.get('local'), 'local must be registered');
    assert.equal(registry.get('gemini'), undefined, 'the cloud provider must be gone after PROV-07');
  });

  test('an unknown/stale selection falls back to local', () => {
    const registry = require('../src/services/providers');
    const prev = registry.selected;
    try {
      registry.selected = 'gemini'; // simulate a stale LLM_PROVIDER=gemini in an old .env
      assert.equal(registry.getSelected().getStats().provider, 'local');
    } finally {
      registry.selected = prev;
    }
  });

  test('facade (llm.service) resolves to LocalProvider', () => {
    const facade = require('../src/services/llm.service');
    assert.equal(facade.getStats().provider, 'local');
  });
});
