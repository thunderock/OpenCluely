// Thin facade over the registry-selected LLM provider (SC1 / SC2).
//
// The 1654-line Gemini god-file that used to live here was relocated VERBATIM
// into src/services/providers/gemini.provider.js in Plan 02. This file now only
// resolves the selected provider from the registry and re-exports that
// singleton instance. Because the provider preserves the identical method
// surface (every method main.js calls) and the same { response, metadata }
// return shapes, every `llmService.*` call-site stays byte-for-byte unchanged.
//
// Selection is the hardcoded 'gemini' default this phase (no user/config switch
// until Phase 3). getSelected() is invoked on the registry object — never
// destructured and bare-called — so its `this` binding to
// registry.providers/registry.selected is preserved.

const providers = require('./providers');

module.exports = providers.getSelected();
