// Thin facade over the registry-selected LLM provider (SC1 / SC2).
//
// The original 1654-line cloud god-file that used to live here was decomposed
// into the provider abstraction in Phase 2; the cloud path was removed at
// PROV-07, leaving LocalProvider as the sole engine. This file resolves the
// selected provider from the registry and re-exports that singleton instance.
// Because the provider preserves the method surface every main.js call-site
// uses and the same { response, metadata } return shapes, all `llmService.*`
// call-sites stay unchanged.
//
// getSelected() is invoked on the registry object — never destructured and
// bare-called — so its `this` binding to registry.providers/registry.selected
// is preserved.

const providers = require('./providers');

module.exports = providers.getSelected();
