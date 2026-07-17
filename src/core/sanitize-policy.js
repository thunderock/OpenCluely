'use strict';

// THE single locked sanitize policy (SEC-01). Every model-output innerHTML
// sink routes through DOMPurify configured with exactly this object plus the
// afterSanitizeAttributes anchor hook below. One policy — greppable, pure,
// node:test-able. Dual-loaded: CJS require (tests) + renderer script tag
// (window.SanitizePolicy), mirroring the lib/markdown.js expose pattern.
//
// Locked decisions (05-CONTEXT.md):
// - Links: http(s) only; javascript:/data: die; rel="noopener noreferrer" forced.
// - Images: stripped entirely (<img src=remote> is a beacon/exfil channel).
// - USE_PROFILES {html:true} kills svg/mathml namespace tricks.
// - pre/code/span/class survive by default → Prism highlighting unaffected.

const SANITIZE_CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['img', 'picture', 'source', 'video', 'audio', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'style'],
  FORBID_ATTR: ['style'],
  ALLOWED_URI_REGEXP: /^https?:/i,
};

/**
 * afterSanitizeAttributes hook body — pure, testable with fake nodes.
 * Forces rel/target on every anchor and strips any non-http(s) href
 * (belt-and-suspenders behind ALLOWED_URI_REGEXP).
 * @param {object} node DOM node (or fake) with get/set/removeAttribute
 */
function applyAnchorPolicy(node) {
  if (!node || String(node.tagName).toUpperCase() !== 'A') return;
  node.setAttribute('rel', 'noopener noreferrer');
  node.setAttribute('target', '_blank');
  const href = node.getAttribute('href') || '';
  if (href && !/^https?:\/\//i.test(href)) node.removeAttribute('href');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SANITIZE_CONFIG, applyAnchorPolicy };
}
if (typeof window !== 'undefined') {
  window.SanitizePolicy = { SANITIZE_CONFIG, applyAnchorPolicy };
}
