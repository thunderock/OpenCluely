'use strict';

// Capture the golden outgoing Gemini request from TODAY's live
// src/services/llm.service.js (still the live path this plan) so the refactored
// RequestBuilder + GeminiProvider.serialize pipeline can be proven
// byte-identical against the real source of truth.
//
// Run once to (re)generate the committed fixtures:
//   node scripts/capture-gemini-goldens.js
//
// The fixed inputs + deterministic fakes are exported so
// test/gemini-request-parity.test.js consumes the SAME values — importing this
// module is side-effect-free (the live singletons are required lazily inside
// captureGoldens(), and capture only runs when invoked as the main module).

const fs = require('fs');
const path = require('path');

// ── Fixed, deterministic inputs shared with the parity test. Changing any of
// these requires regenerating the fixtures. ──
const FIXED = {
  skill: 'dsa',
  programmingLanguage: null,
  text: 'Given an array of integers, return the indices of the two numbers that add up to a target.',
  mimeType: 'image/png',
  imageBuffer: Buffer.from('OPENCLUELY-GOLDEN-IMAGE-BYTES'),
  // system + user + model + empty — exercises the history filter (system and
  // whitespace-only events are dropped; roles are mapped model->model / *->user).
  history: [
    { role: 'system', content: 'SYSTEM INITIALIZATION PROMPT (filtered out)' },
    { role: 'user', content: 'What is the time complexity of binary search?' },
    { role: 'model', content: 'Binary search runs in O(log n) time on a sorted array.' },
    { role: 'user', content: '   ' }
  ],
  skillContext: { skillPrompt: 'SYSTEM_PROMPT_FIXED', requiresProgrammingLanguage: false },
  imageSkillPrompt: 'IMG_SKILL_PROMPT_FIXED'
};

// Deterministic, network-free collaborators. getConversationHistory ignores the
// requested cap and returns the full fixed array — the cap/slice behavior is
// unit-tested in request-builder.test.js; here we only need a stable,
// representative shape that both capture and test share.
function makeFakeSession() {
  return {
    getConversationHistory: () => FIXED.history.map(e => ({ ...e })),
    getSkillContext: () => ({ ...FIXED.skillContext })
  };
}

function makeFakePromptLoader() {
  return {
    getSkillPrompt: () => FIXED.imageSkillPrompt
  };
}

const FIXTURE_DIR = path.join(__dirname, '..', 'test', 'fixtures', 'gemini-requests');

async function captureGoldens() {
  // Require the live singletons HERE (not at module top) so importing this file
  // from the parity test does not instantiate them.
  const llm = require('../src/services/llm.service');
  const sessionManager = require('../src/managers/session.manager');
  const { promptLoader } = require('../prompt-loader');

  // Determinism: fixed history + skill context (used by text/transcription) and
  // fixed image skill prompt (used by the image path via the real promptLoader).
  const fakeSession = makeFakeSession();
  sessionManager.getConversationHistory = fakeSession.getConversationHistory;
  sessionManager.getSkillContext = fakeSession.getSkillContext;
  promptLoader.getSkillPrompt = makeFakePromptLoader().getSkillPrompt;

  // Let the process* methods proceed without a real client/API key.
  llm.isInitialized = true;

  // Network-free transport: capture the outgoing geminiRequest, resolve ''.
  const capture = async (fn) => {
    let captured = null;
    const grab = (geminiRequest) => { captured = geminiRequest; return Promise.resolve(''); };
    llm.executeRequest = grab;
    llm.executeAlternativeRequest = grab;
    llm.executeStreamingRequest = (geminiRequest) => { captured = geminiRequest; return Promise.resolve(''); };
    await fn();
    return captured;
  };

  const goldens = {
    text: await capture(() =>
      llm.processTextWithSkill(FIXED.text, FIXED.skill, [], FIXED.programmingLanguage)),
    image: await capture(() =>
      llm.processImageWithSkill(FIXED.imageBuffer, FIXED.mimeType, FIXED.skill, [], FIXED.programmingLanguage)),
    transcription: await capture(() =>
      llm.processTranscriptionWithIntelligentResponse(FIXED.text, FIXED.skill, [], FIXED.programmingLanguage))
  };

  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const root = path.join(__dirname, '..');
  for (const [name, request] of Object.entries(goldens)) {
    if (!request) {
      throw new Error(`Failed to capture golden request for '${name}'`);
    }
    const file = path.join(FIXTURE_DIR, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify(request, null, 2));
    console.log(`wrote ${path.relative(root, file)}`);
  }
}

if (require.main === module) {
  captureGoldens().then(() => process.exit(0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { FIXED, makeFakeSession, makeFakePromptLoader, FIXTURE_DIR };
