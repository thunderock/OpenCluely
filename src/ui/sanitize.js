'use strict';

// Browser glue for SEC-01: binds the UMD DOMPurify global to the ONE locked
// policy (src/core/sanitize-policy.js → window.SanitizePolicy). Loaded via
// script tag AFTER dompurify/dist/purify.js and sanitize-policy.js:
//   <script src="./node_modules/dompurify/dist/purify.js"></script>
//   <script src="./src/core/sanitize-policy.js"></script>
//   <script src="./src/ui/sanitize.js"></script>
// FAIL-CLOSED: if either dependency is missing, rendering is suppressed
// (returns '') — hostile markup must never reach an innerHTML sink raw.
(function () {
  let hooked = false;
  window.sanitizeHtml = function sanitizeHtml(html) {
    if (!window.DOMPurify || !window.SanitizePolicy) { // fail-CLOSED: never render raw
      console.warn('[SANITIZE] DOMPurify/policy missing — rendering suppressed');
      return '';
    }
    if (!hooked) {
      window.DOMPurify.addHook('afterSanitizeAttributes', window.SanitizePolicy.applyAnchorPolicy);
      hooked = true;
    }
    return window.DOMPurify.sanitize(String(html == null ? '' : html), window.SanitizePolicy.SANITIZE_CONFIG);
  };
})();
