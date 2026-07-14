// Trivial spawn target for the ServiceSupervisor demo suite. It lives under
// test/fixtures/ (NOT matching *.test.js) so `node --test test/*.test.js`
// never runs it as a test — see Pitfall 1 in 01-RESEARCH.md.
//
// Modes (argv[3], default 'ok') exercise every supervisor path:
//   ok             — healthy HTTP server; an HTTP listener satisfies BOTH a
//                    TCP port probe and an HTTP endpoint probe.
//   ignore-sigterm — swallow SIGTERM so the supervisor must escalate to SIGKILL.
//   crash          — exit(1) immediately; never becomes healthy (give-up path).
const http = require('http');

const port = Number(process.argv[2]);
const mode = process.argv[3] || 'ok';

if (mode === 'crash') {
  process.exit(1);
}

if (mode === 'ignore-sigterm') {
  process.on('SIGTERM', () => { /* swallow: force the supervisor's SIGKILL path */ });
}

const server = http.createServer((_req, res) => res.end('ok'));
server.listen(port, '127.0.0.1', () => process.stdout.write('LISTENING\n'));
