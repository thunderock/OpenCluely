// Provider registry (PROV-06 selection).
//
// Instantiates the concrete providers and resolves the "selected provider" from
// config (`llm.provider`, env-overridable via LLM_PROVIDER). Local is the
// default; Gemini stays registered/selectable through the Phase-3 transition
// window so validation can flip back to the proven cloud path — the gemini
// registration is removed only at PROV-07 (03-08).
//
// The facade (src/services/llm.service.js) calls `getSelected()` ON this object
// (preserving `this`), so keep the singleton-object export shape.

const { GeminiProvider } = require('./gemini.provider');
const { LocalProvider } = require('./local.provider');
const config = require('../../core/config');

const gemini = new GeminiProvider();
const local = new LocalProvider();

const registry = {
  providers: { gemini, local },
  // Config-driven selection (Local default). Was hardcoded 'gemini' in Phase 2.
  selected: config.get('llm.provider'),

  register(name, provider) {
    this.providers[name] = provider;
    return provider;
  },

  get(name) {
    return this.providers[name];
  },

  // Harden against a mis-set/unknown selection: never return undefined (which
  // would break the facade). Fall back to Local, then Gemini.
  getSelected() {
    return this.providers[this.selected] || this.providers.local || this.providers.gemini;
  }
};

module.exports = registry;
