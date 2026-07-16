'use strict';

// local-transport — hermetic, no external network (loopback http only). Locks in
// the transport primitive the local engine relies on in the Electron main
// process:
//   - nodeFetch(): a WHATWG-fetch over Node http that (a) parses the host with
//     the NATIVE URL (correct regardless of the global) and (b) returns a native
//     Response supporting .json() and streamed .body.getReader() for the
//     openai/ollama clients, with header containers normalized for node:http.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('net');

const { nodeFetch, normalizeHeaders } = require('../src/core/local-transport');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// A hostile global.URL: every input parses to localhost, empty port, and there
// is no `searchParams`. Used to prove nodeFetch parses the host with the NATIVE
// URL and is unaffected by whatever sits on globalThis.URL.
class FakeBrowserURL {
  constructor(href) {
    this.href = href;
    this.protocol = 'https:';
    this.host = 'localhost';
    this.hostname = 'localhost';
    this.port = '';
    this.pathname = '/';
    this.search = '';
  }
  toString() { return this.href; }
}

async function withServer(handler, fn) {
  const port = await getFreePort();
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  try {
    return await fn(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('nodeFetch() GET returns a native Response with a correct .json() body', async () => {
  await withServer(
    (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ version: '0.32.0' })); },
    async (port) => {
      const res = await nodeFetch(`http://127.0.0.1:${port}/api/version`);
      assert.equal(res.ok, true);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { version: '0.32.0' });
    },
  );
});

test('nodeFetch() exposes a streamed body via .body.getReader() (ollama/openai stream path)', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(JSON.stringify({ status: 'downloading' }) + '\n');
      res.write(JSON.stringify({ status: 'success' }) + '\n');
      res.end();
    },
    async (port) => {
      const res = await nodeFetch(`http://127.0.0.1:${port}/api/pull`, { method: 'POST', body: '{}' });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      assert.ok(text.includes('downloading') && text.includes('success'), 'both stream chunks received');
    },
  );
});

test('nodeFetch() streamed body: reader.cancel() mid-stream closes cleanly (no ERR_INVALID_STATE double-close)', async () => {
  // Regression (ollama-not-detected follow-on): the openai SDK reads a streamed
  // completion then cancels the reader; the ensuing socket 'close' must NOT
  // double-close the web ReadableStream controller. Readable.toWeb(res) threw an
  // uncaught ERR_INVALID_STATE here and crashed the app mid-answer; the hand-built
  // stream closes exactly once. A regression re-crashes as an uncaught exception,
  // failing this run.
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
      // Intentionally do not end — the client cancels mid-stream, then the socket
      // closes; both the 'close' handler and cancel() must be no-throw.
    },
    async (port) => {
      const res = await nodeFetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', body: '{}' });
      const reader = res.body.getReader();
      const first = await reader.read();
      assert.ok(first.value && first.value.length > 0, 'received the first streamed SSE chunk');
      await reader.cancel(); // mimic the openai SDK closing the stream early
    },
  );
  // Let any deferred socket 'end'/'close' handlers fire; a double-close would
  // surface as an uncaught ERR_INVALID_STATE and fail the test run.
  await new Promise((resolve) => setTimeout(resolve, 40));
});

test('nodeFetch() normalizes a WHATWG Headers instance so node:http sends them', async () => {
  await withServer(
    (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ct: req.headers['content-type'], auth: req.headers['authorization'] })); },
    async (port) => {
      const headers = new Headers({ 'Content-Type': 'application/json', Authorization: 'Bearer ollama' });
      const res = await nodeFetch(`http://127.0.0.1:${port}/v1/models`, { headers });
      const body = await res.json();
      assert.equal(body.ct, 'application/json');
      assert.equal(body.auth, 'Bearer ollama');
    },
  );
});

test('nodeFetch() parses the host with the NATIVE URL even when global.URL is hostile', async () => {
  await withServer(
    (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true })); },
    async (port) => {
      const orig = Object.getOwnPropertyDescriptor(globalThis, 'URL');
      Object.defineProperty(globalThis, 'URL', { value: FakeBrowserURL, writable: true, configurable: true });
      try {
        // With a hostile global a `new URL()` would yield localhost:443; nodeFetch
        // must still reach the real loopback host:port and get a 200.
        const res = await nodeFetch(`http://127.0.0.1:${port}/api/version`);
        assert.equal(res.status, 200, 'reached the real loopback host regardless of the global URL');
      } finally {
        if (orig) Object.defineProperty(globalThis, 'URL', orig); else delete globalThis.URL;
      }
    },
  );
});

test('normalizeHeaders() flattens Headers, arrays, and plain objects', () => {
  assert.deepEqual(normalizeHeaders({ a: '1' }), { a: '1' });
  assert.deepEqual(normalizeHeaders([['a', '1'], ['b', '2']]), { a: '1', b: '2' });
  const h = new Headers({ 'x-test': 'y' });
  assert.equal(normalizeHeaders(h)['x-test'], 'y');
  assert.deepEqual(normalizeHeaders(null), {});
});
