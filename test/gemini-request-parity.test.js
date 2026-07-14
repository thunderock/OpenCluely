'use strict';

// Byte-identical parity guard (the anti-drift heart of the whole refactor).
//
// Proves the refactored pipeline — RequestBuilder (neutral struct) +
// GeminiProvider.serialize (neutral -> Gemini wire) — reproduces the exact
// outgoing Gemini request TODAY's llm.service.js sends, for the three shapes
// (text / image / transcription) and across BOTH interface paths (generate +
// generateStream). Comparison is exact string equality against the committed
// goldens (regenerate with `node scripts/capture-gemini-goldens.js`).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { RequestBuilder } = require('../src/core/request-builder');
const { GeminiProvider } = require('../src/services/providers/gemini.provider');
const config = require('../src/core/config');
const {
  FIXED,
  makeFakeSession,
  makeFakePromptLoader,
  FIXTURE_DIR
} = require('../scripts/capture-gemini-goldens');

// A RequestBuilder wired with the SAME deterministic fakes used at capture, so
// the neutral struct it emits matches the golden baseline's inputs.
function makeRB() {
  return new RequestBuilder({ sessionManager: makeFakeSession(), promptLoader: makeFakePromptLoader() });
}

function goldenString(name) {
  return fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8');
}

function neutralFor(shape, rb) {
  switch (shape) {
    case 'text':
      return rb.buildTextRequest(FIXED.text, FIXED.skill, [], FIXED.programmingLanguage);
    case 'image':
      return rb.buildImageRequest(FIXED.imageBuffer, FIXED.mimeType, FIXED.skill, FIXED.programmingLanguage);
    case 'transcription':
      return rb.buildTranscriptionRequest(FIXED.text, FIXED.skill, [], FIXED.programmingLanguage);
    default:
      throw new Error(`unknown shape: ${shape}`);
  }
}

const SHAPES = ['text', 'image', 'transcription'];

describe('Gemini request parity (byte-identical golden)', () => {
  for (const shape of SHAPES) {
    test(`serialize(build${shape}Request) reproduces the golden byte-for-byte`, () => {
      const provider = new GeminiProvider();
      const actual = JSON.stringify(provider.serialize(neutralFor(shape, makeRB())), null, 2);
      assert.equal(actual, goldenString(shape));
    });
  }

  // Both interface paths consume the same neutral+serialize, so each constructs
  // a request byte-identical to the golden. Capture the outgoing request from
  // generate and generateStream network-free (transport is patched); the
  // streaming TRANSPORT itself is smoke-tested in Plan 03.
  for (const shape of SHAPES) {
    test(`generate and generateStream construct the identical ${shape} request`, async () => {
      const neutral = neutralFor(shape, makeRB());

      const provider = new GeminiProvider();
      provider.isInitialized = true; // let generate/generateStream proceed; no client needed

      let nonStreamReq = null;
      let streamReq = null;
      provider.executeRequest = (req) => { nonStreamReq = req; return Promise.resolve(''); };
      provider.executeAlternativeRequest = (req) => { nonStreamReq = req; return Promise.resolve(''); };
      provider.executeStreamingRequest = (req) => { streamReq = req; return Promise.resolve(''); };

      await provider.generate(neutral);
      await provider.generateStream(neutral, {}, () => {});

      const golden = goldenString(shape);
      assert.equal(JSON.stringify(nonStreamReq, null, 2), golden, 'generate request must equal golden');
      assert.equal(JSON.stringify(streamReq, null, 2), golden, 'generateStream request must equal golden');
      assert.equal(
        JSON.stringify(streamReq, null, 2),
        JSON.stringify(nonStreamReq, null, 2),
        'stream and non-stream must build the identical request'
      );
    });
  }

  test('generationConfig is sourced from config.get(llm.gemini.generation)', () => {
    const provider = new GeminiProvider();
    const req = provider.serialize(neutralFor('text', makeRB()));
    const gen = config.get('llm.gemini.generation');
    assert.equal(req.generationConfig.temperature, gen.temperature);
    assert.equal(req.generationConfig.topK, gen.topK);
    assert.equal(req.generationConfig.topP, gen.topP);
    assert.equal(req.generationConfig.maxOutputTokens, gen.maxOutputTokens);
    assert.deepEqual(req.generationConfig.thinkingConfig, gen.thinkingConfig);
  });
});
