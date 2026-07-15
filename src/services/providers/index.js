// Provider registry (PROV-06 selection).
//
// Instantiates the concrete providers and resolves the "selected provider" from
// config (`llm.provider`, env-overridable via LLM_PROVIDER). Local is the only
// engine (PROV-07 removed the cloud path); the registry keeps its multi-provider
// shape so Phase-7 CLI backends slot in with no rework.
//
// The facade (src/services/llm.service.js) calls `getSelected()` ON this object
// (preserving `this`), so keep the singleton-object export shape.

const { LocalProvider } = require('./local.provider');
const config = require('../../core/config');

const local = new LocalProvider();

const registry = {
  providers: { local },
  // Config-driven selection (Local default).
  selected: config.get('llm.provider'),

  register(name, provider) {
    this.providers[name] = provider;
    return provider;
  },

  get(name) {
    return this.providers[name];
  },

  // Harden against a mis-set/unknown selection (e.g. a stale cloud value left in
  // an old .env's LLM_PROVIDER): never return undefined (which would break the
  // facade). Any unknown selection resolves to Local — the only engine.
  getSelected() {
    return this.providers[this.selected] || this.providers.local;
  }
};

module.exports = registry;
