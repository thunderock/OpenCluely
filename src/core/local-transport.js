/**
 * Local-engine transport primitives — robustness against the Azure STT
 * browser-DOM polyfill (ollama-not-detected, deeper root cause).
 *
 * speech.service.js installs an Azure Speech SDK browser-DOM shim at process
 * startup (required from main.js top-level). That shim CLOBBERS a set of Node
 * globals; two of them break the local (Ollama) engine:
 *
 *   1. global.URL → a fake class that parses EVERY input to
 *      { hostname:'localhost', port:'', protocol:'https:' } and has NO
 *      `searchParams` (speech.service.js:293-308). This silently mis-targets
 *      every `new URL()` in the process: our _probeVersion (probe hits
 *      localhost:443, not 127.0.0.1:11434), the openai SDK's internal buildURL
 *      (`Object.fromEntries(url.searchParams)` throws), and the ollama client's
 *      formatHost (host becomes `https://localhost:443…`). The real Node URL is
 *      a full WHATWG superset; the shim's constant-garbage output cannot be
 *      relied on for correctness, so restoring the native URL is SAFE for Azure
 *      and repairs every downstream consumer at once.
 *
 *   2. the ambient fetch → in the Electron MAIN process the global fetch is
 *      Chromium-net-backed and FALSE-NEGATIVES the loopback Ollama daemon that
 *      Node's http reaches fine (the same gotcha ServiceSupervisor already
 *      sidesteps with a Node-http probe). So we hand every client a Node-http
 *      `fetch` instead of the ambient one.
 *
 * We do NOT remove the polyfill (Phase 4 / STT-05 owns that) — we make the
 * local engine robust against it.
 */

const http = require('node:http');
const https = require('node:https');
const { ReadableStream } = require('node:stream/web'); // native web stream, captured independent of any polyfill
const { URL } = require('node:url'); // native, captured independent of the (poisoned) global URL

// Idempotent: restore the native global URL when the polyfill has clobbered it.
// A no-op when unpolluted (globalThis.URL === node:url URL). Best-effort: a
// frozen/non-writable global still leaves our own captured `URL` usable.
function ensureNativeGlobalURL() {
  try {
    if (globalThis.URL !== URL) globalThis.URL = URL;
  } catch (_) { /* best-effort */ }
}

// Flatten any header container (WHATWG Headers, Map, entries array, plain
// object) to the plain object node:http expects. The openai SDK passes a
// Headers instance — handed to http.request raw it would silently drop every
// header (Content-Type, Authorization).
function normalizeHeaders(h) {
  if (!h) return {};
  if (typeof h.forEach === 'function' && !Array.isArray(h)) {
    const out = {};
    h.forEach((v, k) => { out[k] = v; });
    return out;
  }
  if (Array.isArray(h)) return Object.fromEntries(h);
  return h;
}

function abortError() {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

/**
 * A WHATWG-`fetch`-shaped function backed by Node's http/https so it reaches
 * the loopback daemon regardless of the ambient (Chromium-net / polyfilled)
 * fetch. Returns a native Response with a web ReadableStream body — supports
 * both the openai SDK (.json(), streamed `.body.getReader()`) and the ollama
 * client (list/pull/generate). Honors init.method/headers/body/signal.
 */
function nodeFetch(input, init = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      const urlStr = typeof input === 'string' ? input : (input && input.url) || String(input);
      u = new URL(urlStr); // native URL — immune to the poisoned global
    } catch (e) {
      reject(e);
      return;
    }

    const { signal } = init;
    if (signal && signal.aborted) { reject(abortError()); return; }

    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method: (init.method || 'GET').toUpperCase(),
        headers: normalizeHeaders(init.headers),
      },
      (res) => {
        // Build the web ReadableStream by hand rather than Readable.toWeb(res):
        // toWeb's adapter double-closes the controller when an IncomingMessage
        // fires BOTH 'end' and 'close' (or 'close' after the consumer cancels)
        // during a streamed response — throwing an uncaught ERR_INVALID_STATE
        // ("Controller is already closed") that crashed the app mid-answer. A
        // single guarded close/error is robust to end+close and reader.cancel().
        let settled = false;
        const body = new ReadableStream({
          start(controller) {
            const finish = () => {
              if (settled) return;
              settled = true;
              try { controller.close(); } catch (_) { /* already closed */ }
            };
            res.on('data', (chunk) => {
              try { controller.enqueue(new Uint8Array(chunk)); } catch (_) { /* consumer cancelled */ }
            });
            res.on('end', finish);
            res.on('close', finish);
            res.on('error', (err) => {
              if (settled) return;
              settled = true;
              try { controller.error(err); } catch (_) { /* already settled */ }
            });
          },
          cancel() { res.destroy(); },
        });
        resolve(new Response(body, {
          status: res.statusCode,
          statusText: res.statusMessage,
          headers: res.headers,
        }));
      },
    );

    const onAbort = () => { req.destroy(); reject(abortError()); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    req.on('close', () => { if (signal) signal.removeEventListener('abort', onAbort); });
    req.on('error', reject);

    if (init.body != null) {
      req.write(typeof init.body === 'string' ? init.body : Buffer.from(init.body));
    }
    req.end();
  });
}

module.exports = { URL, ensureNativeGlobalURL, nodeFetch, normalizeHeaders };
