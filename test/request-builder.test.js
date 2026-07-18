'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { RequestBuilder } = require('../src/core/request-builder');

// ── DI fakes: fully network-free, deterministic collaborators ──

const evt = (role, content) => ({ role, content });

// Mimics session.manager: getConversationHistory(n) returns the last n events
// (the real singleton caps with .slice(-maxEntries)); records the cap it was
// asked for so tests can prove RequestBuilder requests the right limit.
function makeSession(events, skillContext = { skillPrompt: 'SYS' }) {
  const calls = { historyCaps: [], skillContextArgs: null };
  return {
    calls,
    getConversationHistory(n) {
      calls.historyCaps.push(n);
      return events.slice(-n);
    },
    getSkillContext(skill) {
      calls.skillContextArgs = { skill };
      return skillContext;
    }
  };
}

function makePromptLoader(overrides = {}) {
  return {
    getSkillPrompt: overrides.getSkillPrompt || (() => 'IMG-SYS'),
    getRequestComponents: overrides.getRequestComponents || (() => ({ shouldUseModelMemory: true, skillPrompt: 'FALLBACK-SYS' }))
  };
}

const WIRE_KEYS = ['contents', 'parts', 'systemInstruction', 'generationConfig'];
function assertNoWireKeys(struct) {
  for (const k of WIRE_KEYS) {
    assert.ok(!(k in struct), `neutral struct must not contain Gemini wire key: ${k}`);
  }
}

// 20 valid alternating user/model events — used to prove history caps.
const many = [];
for (let i = 0; i < 20; i++) many.push(evt(i % 2 === 0 ? 'user' : 'model', `E${i}`));

// Mixed events to prove filtering + role mapping + trimming.
const mixed = [
  evt('system', 'SYSTEM-INIT'),   // dropped (system)
  evt('user', '  U1  '),          // kept, trimmed -> 'U1'
  evt('model', 'M1'),             // kept
  evt('user', '   '),             // dropped (whitespace-only)
  evt('assistant', 'A1'),         // kept, non-model role -> 'user'
  evt('model', '')                // dropped (empty)
];

describe('buildTextRequest', () => {
  test('history branch: systemPrompt from skillContext, formatted userText, kind/skill/images', () => {
    const session = makeSession(mixed);
    const rb = new RequestBuilder({ sessionManager: session, promptLoader: makePromptLoader() });
    const r = rb.buildTextRequest('the problem', 'dsa');

    assert.equal(r.kind, 'text');
    assert.equal(r.skill, 'dsa');
    assert.equal(r.systemPrompt, 'SYS');
    assert.equal(r.userText, 'Context: DSA analysis request\n\nText to analyze:\nthe problem');
    assert.deepEqual(r.images, []);
  });

  test('history branch: filters system + empty events, trims, maps roles', () => {
    const session = makeSession(mixed);
    const rb = new RequestBuilder({ sessionManager: session, promptLoader: makePromptLoader() });
    const r = rb.buildTextRequest('t', 'dsa');

    assert.deepEqual(r.history, [
      { role: 'user', content: 'U1' },
      { role: 'model', content: 'M1' },
      { role: 'user', content: 'A1' }   // non-model role maps to 'user'
    ]);
  });

  test('history branch: honors the 15-event cap (feeds >15)', () => {
    const session = makeSession(many);
    const rb = new RequestBuilder({ sessionManager: session, promptLoader: makePromptLoader() });
    const r = rb.buildTextRequest('t', 'dsa');

    assert.deepEqual(session.calls.historyCaps, [15]);           // requested the 15 cap
    assert.equal(r.history.length, 15);                          // sliced to the last 15
    assert.equal(r.history[0].content, 'E5');                    // window is E5..E19
    assert.equal(r.history[14].content, 'E19');
  });

  test('never emits Gemini wire keys', () => {
    const rb = new RequestBuilder({ sessionManager: makeSession(mixed), promptLoader: makePromptLoader() });
    assertNoWireKeys(rb.buildTextRequest('t', 'dsa'));
  });

  test('mdContext defaults to empty and passes through', () => {
    const rb = new RequestBuilder({ sessionManager: makeSession(mixed), promptLoader: makePromptLoader() });
    assert.equal(rb.buildTextRequest('t', 'dsa').mdContext, '');
    assert.equal(rb.buildTextRequest('t', 'dsa', [], 'MD-NOTES').mdContext, 'MD-NOTES');
  });

  test('fallback branch (no getConversationHistory): promptLoader components, empty history', () => {
    const rb = new RequestBuilder({
      sessionManager: {},
      promptLoader: makePromptLoader({ getRequestComponents: () => ({ shouldUseModelMemory: true, skillPrompt: 'FB' }) })
    });
    const r = rb.buildTextRequest('hi', 'dsa', []);

    assert.equal(r.systemPrompt, 'FB');
    assert.deepEqual(r.history, []);
    assert.equal(r.userText, 'Context: DSA analysis request\n\nText to analyze:\nhi');
    assertNoWireKeys(r);
  });

  test('fallback branch: systemPrompt null when model memory not indicated', () => {
    const rb = new RequestBuilder({
      sessionManager: {},
      promptLoader: makePromptLoader({ getRequestComponents: () => ({ shouldUseModelMemory: false, skillPrompt: 'FB' }) })
    });
    assert.equal(rb.buildTextRequest('hi', 'dsa', []).systemPrompt, null);
  });
});

describe('buildImageRequest', () => {
  const buf = Buffer.from('hello world');

  test('encodes buffer to base64, sets mimeType, image instruction userText, empty history', () => {
    const rb = new RequestBuilder({ sessionManager: makeSession([]), promptLoader: makePromptLoader() });
    const r = rb.buildImageRequest(buf, 'image/png', 'dsa');

    assert.equal(r.kind, 'image');
    assert.equal(r.skill, 'dsa');
    assert.equal(r.images[0].data, buf.toString('base64'));
    assert.equal(r.images[0].mimeType, 'image/png');
    assert.ok(r.userText.startsWith('Analyze this image for a DSA question'));
    assert.deepEqual(r.history, []);
    assert.equal(r.systemPrompt, 'IMG-SYS');
    assertNoWireKeys(r);
  });

  test('base64 string input passes through unchanged', () => {
    const rb = new RequestBuilder({ sessionManager: makeSession([]), promptLoader: makePromptLoader() });
    const r = rb.buildImageRequest('YWJj', 'image/jpeg', 'dsa');
    assert.equal(r.images[0].data, 'YWJj');
    assert.equal(r.images[0].mimeType, 'image/jpeg');
  });

  test('whitespace-only skill prompt yields null systemPrompt (matches trim gate)', () => {
    const rb = new RequestBuilder({
      sessionManager: makeSession([]),
      promptLoader: makePromptLoader({ getSkillPrompt: () => '   ' })
    });
    assert.equal(rb.buildImageRequest(buf, 'image/png', 'dsa').systemPrompt, null);
  });

  test('missing skill prompt yields null systemPrompt', () => {
    const rb = new RequestBuilder({
      sessionManager: makeSession([]),
      promptLoader: makePromptLoader({ getSkillPrompt: () => null })
    });
    assert.equal(rb.buildImageRequest(buf, 'image/png', 'dsa').systemPrompt, null);
  });

  test('mdContext passes through', () => {
    const rb = new RequestBuilder({ sessionManager: makeSession([]), promptLoader: makePromptLoader() });
    assert.equal(rb.buildImageRequest(buf, 'image/png', 'dsa').mdContext, '');
    assert.equal(rb.buildImageRequest(buf, 'image/png', 'dsa', 'MD').mdContext, 'MD');
  });
});

describe('buildTranscriptionRequest', () => {
  test('sets intelligent-transcription systemPrompt, trims userText, kind/images', () => {
    const rb = new RequestBuilder({ sessionManager: makeSession(mixed), promptLoader: makePromptLoader() });
    const r = rb.buildTranscriptionRequest('  hi  ', 'dsa');

    assert.equal(r.kind, 'transcription');
    assert.equal(r.skill, 'dsa');
    assert.ok(r.systemPrompt.includes('Intelligent Transcription Response System'));
    assert.ok(!/interview/i.test(r.systemPrompt), 'transcription prompt has no interview framing (GEN-01)');
    assert.ok(!r.systemPrompt.includes('CODING CONTEXT'), 'per-language CODING CONTEXT block is gone');
    assert.ok(r.systemPrompt.includes('default to Python'), 'static default-Python smart clause present');
    assert.equal(r.userText, 'hi');   // cleanText trims
    assert.deepEqual(r.images, []);
    assertNoWireKeys(r);
  });

  test('history honors 10-then-last-8 (feeds >10)', () => {
    const session = makeSession(many);
    const rb = new RequestBuilder({ sessionManager: session, promptLoader: makePromptLoader() });
    const r = rb.buildTranscriptionRequest('q', 'dsa');

    assert.deepEqual(session.calls.historyCaps, [10]);   // requested the 10 cap
    assert.equal(r.history.length, 8);                   // then trimmed to last 8
    assert.equal(r.history[0].content, 'E12');           // last-8 of the last-10 window (E10..E19)
    assert.equal(r.history[7].content, 'E19');
  });

  test('history filters system + empty and maps roles', () => {
    const rb = new RequestBuilder({ sessionManager: makeSession(mixed), promptLoader: makePromptLoader() });
    const r = rb.buildTranscriptionRequest('q', 'dsa');
    assert.deepEqual(r.history, [
      { role: 'user', content: 'U1' },
      { role: 'model', content: 'M1' },
      { role: 'user', content: 'A1' }
    ]);
  });

  test('empty / whitespace / non-string text throws', () => {
    const rb = new RequestBuilder({ sessionManager: makeSession(mixed), promptLoader: makePromptLoader() });
    assert.throws(() => rb.buildTranscriptionRequest('', 'dsa'), /Empty or invalid transcription text/);
    assert.throws(() => rb.buildTranscriptionRequest('   ', 'dsa'), /Empty or invalid transcription text/);
    assert.throws(() => rb.buildTranscriptionRequest(null, 'dsa'), /Empty or invalid transcription text/);
  });

  test('fallback branch (no getConversationHistory): systemPrompt set, empty history', () => {
    const rb = new RequestBuilder({ sessionManager: {}, promptLoader: makePromptLoader() });
    const r = rb.buildTranscriptionRequest('q', 'dsa', []);
    assert.ok(r.systemPrompt.includes('Intelligent Transcription Response System'));
    assert.deepEqual(r.history, []);
    assertNoWireKeys(r);
  });

  test('mdContext passes through', () => {
    const rb = new RequestBuilder({ sessionManager: makeSession(mixed), promptLoader: makePromptLoader() });
    assert.equal(rb.buildTranscriptionRequest('q', 'dsa').mdContext, '');
    assert.equal(rb.buildTranscriptionRequest('q', 'dsa', [], 'MD').mdContext, 'MD');
  });
});
