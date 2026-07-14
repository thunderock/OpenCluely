// Provider registry (SC3 groundwork).
//
// Instantiates the concrete providers and exposes a "selected provider" notion.
// This phase the selection is a HARDCODED default ('gemini') — there is no
// user-facing config/env switch yet (nothing to switch to until the Local
// engine lands in Phase 3, which adds the config-driven switch). SC3's "when
// Gemini is selected" is expressed here so the cert-bypass/UA gating in Plan 03
// has a selection to key off of.

const { GeminiProvider } = require('./gemini.provider');

const gemini = new GeminiProvider();

const registry = {
  providers: { gemini },
  // Hardcoded default this phase (Phase 3 introduces LLM_PROVIDER or similar).
  selected: 'gemini',

  register(name, provider) {
    this.providers[name] = provider;
    return provider;
  },

  get(name) {
    return this.providers[name];
  },

  getSelected() {
    return this.providers[this.selected];
  }
};

module.exports = registry;
