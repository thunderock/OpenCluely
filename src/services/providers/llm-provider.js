// Provider-agnostic LLM contract (PROV-01 / SC2).
//
// Declares the four interface methods every provider must implement. The
// default implementations throw so a subclass is forced to override them.
// Contract only — no config, registry, or Gemini/wire logic lives here.

class LLMProvider {
  // Non-streaming answer for a neutral request struct.
  generate(_neutralRequest, _options) {
    throw new Error('LLMProvider.generate not implemented');
  }

  // Streaming answer; onDelta(deltaText) is invoked per chunk.
  generateStream(_neutralRequest, _options, _onDelta) {
    throw new Error('LLMProvider.generateStream not implemented');
  }

  // Boolean: provider is configured and ready to serve.
  isAvailable() {
    throw new Error('LLMProvider.isAvailable not implemented');
  }

  // Connectivity probe returning { success, ... }.
  testConnection() {
    throw new Error('LLMProvider.testConnection not implemented');
  }
}

module.exports = { LLMProvider };
