// SystemAudioTapManager (STT-04 / SC4) — network-free, GUI-free suite. No real
// helper is spawned: a fake spawn returns an EventEmitter "child" whose
// stdout/stderr we drive by hand, and grant/deny persistence uses a real temp
// file. Proves the logic that must be provably correct BEFORE the signing spike
// can even run: the isSupported() platform/version gate, the stderr line-JSON
// status parser, grant/deny persistence, and the uniform degrade-to-mic path.
//
// Run: `node --test test/system-audio-tap.test.js` (or `node --test test/*.test.js`).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const SystemAudioTapManager = require('../src/core/system-audio-tap.manager');
const { verifyMachO, versionGte } = SystemAudioTapManager;

// Keep node:test output clean — the manager logs on degrade paths.
const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };
const fakeConfig = { get: () => undefined };

// A temp dir for the trusted-binary stand-in + per-test permission files.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'opencluely-sysaudio-'));

// A fake "binary" that passes _isTrustedBinary: universal Mach-O magic
// (0xCAFEBABE big-endian) padded to 32 bytes. On darwin the manager arch-verifies
// the leading bytes; off-darwin mere existence is enough — this satisfies both.
const FAKE_BIN = path.join(TMP, 'system-audio-tap');
fs.writeFileSync(FAKE_BIN, Buffer.concat([Buffer.from([0xca, 0xfe, 0xba, 0xbe]), Buffer.alloc(28)]));
fs.chmodSync(FAKE_BIN, 0o755);

/** A fake child process: EventEmitter with stdout/stderr streams + a kill spy. */
function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.lastSignal = null;
  child.kill = (sig) => {
    child.killed = true;
    child.lastSignal = sig;
    setImmediate(() => child.emit('exit', null, sig));
    return true;
  };
  return child;
}

/** A fake spawn recording its calls and returning a controllable child. */
function fakeSpawn() {
  const child = makeFakeChild();
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return child;
  };
  return { spawn, child, calls };
}

/** Build a manager wired to the fake binary + a fresh permission file. */
function makeManager(overrides = {}) {
  const permissionPath = path.join(TMP, `perm-${Math.random().toString(36).slice(2)}`);
  return new SystemAudioTapManager({
    logger: noopLogger,
    config: fakeConfig,
    platform: 'darwin',
    systemVersion: '14.4',
    permissionPath,
    ...overrides,
  });
}

// Point binary resolution at the fake binary for the whole suite (constructors
// run inside the test callbacks, after this executes).
process.env.SYSTEM_AUDIO_TAP_BIN = FAKE_BIN;

// ── versionGte (pure) ──

test('versionGte: numeric component compare (not string)', () => {
  assert.equal(versionGte('14.4', [14, 4]), true);
  assert.equal(versionGte('14.4.1', [14, 4]), true);
  assert.equal(versionGte('14.3.9', [14, 4]), false);
  assert.equal(versionGte('13.6', [14, 4]), false);
  assert.equal(versionGte('15.0', [14, 4]), true);
  assert.equal(versionGte('26.5.2', [14, 4]), true);
  // The whole point of a numeric compare: "14.10" >= "14.4" (a string compare
  // would call "14.10" < "14.4").
  assert.equal(versionGte('14.10', [14, 4]), true);
  assert.equal(versionGte(undefined, [14, 4]), false);
  assert.equal(versionGte('', [14, 4]), false);
});

// ── isSupported() platform + version boundaries ──

test('isSupported: darwin >= 14.4 only', () => {
  const cases = [
    ['darwin', '13.6', false],
    ['darwin', '14.2', false], // Taps exist at 14.2 but 14.4 is the TCC-correct floor
    ['darwin', '14.4', true],
    ['darwin', '15.0', true],
    ['darwin', '14.10', true],
    ['darwin', undefined, false], // bare node: getSystemVersion undefined → degrade
    ['win32', '14.4', false],
    ['linux', '20.0', false],
  ];
  for (const [platform, systemVersion, expected] of cases) {
    const m = new SystemAudioTapManager({ logger: noopLogger, config: fakeConfig, platform, systemVersion });
    assert.equal(m.isSupported(), expected, `${platform} ${systemVersion}`);
  }
});

test('constructor does not spawn; getStatus reports the gate', () => {
  const { spawn, calls } = fakeSpawn();
  const m = new SystemAudioTapManager({
    logger: noopLogger, config: fakeConfig, platform: 'darwin', systemVersion: '14.4', spawn,
  });
  assert.equal(calls.length, 0, 'no spawn at construction');
  const s = m.getStatus();
  assert.equal(s.supported, true);
  assert.equal(s.running, false);
  assert.equal(s.granted, false);
});

// ── start(): the isSupported / consent gate (no spawn) ──

test('start: unsupported OS degrades to mic without spawning', async () => {
  const { spawn, calls } = fakeSpawn();
  const m = new SystemAudioTapManager({
    logger: noopLogger, config: fakeConfig, platform: 'darwin', systemVersion: '13.6', spawn,
  });
  const status = await m.start();
  assert.equal(calls.length, 0, 'must not spawn when unsupported');
  assert.equal(status.running, false);
  assert.equal(status.degraded, true);
  assert.equal(status.reason, 'unsupported_os');
});

test('start: a persisted denial degrades without re-spawning (no re-prompt)', async () => {
  const { spawn, calls } = fakeSpawn();
  const permissionPath = path.join(TMP, `perm-denied-${Date.now()}`);
  fs.writeFileSync(permissionPath, 'denied');
  const m = new SystemAudioTapManager({
    logger: noopLogger, config: fakeConfig, platform: 'darwin', systemVersion: '14.4', spawn, permissionPath,
  });
  const status = await m.start();
  assert.equal(calls.length, 0, 'must not re-spawn on a persisted denial');
  assert.equal(status.degraded, true);
  assert.equal(status.reason, 'permission_denied');
});

// ── start(): stderr status parsing ──

test('start: {"type":"start"} → granted + live, persists granted, pipes PCM', async () => {
  const { spawn, child, calls } = fakeSpawn();
  const permissionPath = path.join(TMP, `perm-grant-${Date.now()}`);
  const received = [];
  const m = new SystemAudioTapManager({
    logger: noopLogger, config: fakeConfig, platform: 'darwin', systemVersion: '14.4', spawn, permissionPath,
  });
  const p = m.start({ onPcm: (buf) => received.push(buf) });
  // Listeners are attached synchronously inside start()'s promise executor.
  child.stderr.emit('data', Buffer.from('{"type":"start","sampleRate":16000,"channels":1,"format":"pcm_s16le"}\n'));
  const status = await p;

  assert.equal(calls.length, 1, 'spawned the helper once');
  assert.deepEqual(calls[0].args, ['--sample-rate', '16000']);
  assert.equal(status.granted, true);
  assert.equal(status.running, true);
  assert.equal(status.degraded, false);
  assert.equal(fs.readFileSync(permissionPath, 'utf8'), 'granted');

  // Stdout PCM flows to the consumer + increments bytesReceived.
  child.stdout.emit('data', Buffer.from([1, 2, 3, 4]));
  assert.equal(received.length, 1);
  assert.equal(received[0].length, 4);
  assert.equal(m.getStatus().bytesReceived, 4);

  await m.stop();
  assert.equal(child.lastSignal, 'SIGTERM');
});

test('start: permission_denied → degrade + persists denied', async () => {
  const { spawn, child } = fakeSpawn();
  const permissionPath = path.join(TMP, `perm-deny2-${Date.now()}`);
  const m = new SystemAudioTapManager({
    logger: noopLogger, config: fakeConfig, platform: 'darwin', systemVersion: '14.4', spawn, permissionPath,
  });
  const p = m.start();
  child.stderr.emit('data', Buffer.from('{"type":"error","code":"permission_denied"}\n'));
  const status = await p;
  assert.equal(status.running, false);
  assert.equal(status.degraded, true);
  assert.equal(status.reason, 'permission_denied');
  assert.equal(fs.readFileSync(permissionPath, 'utf8'), 'denied');
});

test('start: unsupported_os error → degrade, does NOT persist a denial', async () => {
  const { spawn, child } = fakeSpawn();
  const permissionPath = path.join(TMP, `perm-unsup-${Date.now()}`);
  const m = new SystemAudioTapManager({
    logger: noopLogger, config: fakeConfig, platform: 'darwin', systemVersion: '14.4', spawn, permissionPath,
  });
  const p = m.start();
  child.stderr.emit('data', Buffer.from('{"type":"error","code":"unsupported_os"}\n'));
  const status = await p;
  assert.equal(status.degraded, true);
  assert.equal(status.reason, 'unsupported_os');
  assert.equal(fs.existsSync(permissionPath), false, 'an OS-version failure is not a user denial');
});

test('start: partial + multi-line stderr framing is parsed correctly', async () => {
  const { spawn, child } = fakeSpawn();
  const m = makeManager({ spawn });
  const p = m.start();
  // Split a status line across two chunks + prepend non-JSON noise on its own line.
  child.stderr.emit('data', Buffer.from('warming up\n{"type":"sta'));
  child.stderr.emit('data', Buffer.from('rt","sampleRate":16000}\n'));
  const status = await p;
  assert.equal(status.running, true);
  assert.equal(status.granted, true);
});

// ── grant/deny persistence read/write ──

test('permission persistence: read/write round-trip + JSON tolerance', () => {
  const permissionPath = path.join(TMP, `perm-rt-${Date.now()}`);
  const m = new SystemAudioTapManager({
    logger: noopLogger, config: fakeConfig, platform: 'darwin', systemVersion: '14.4', permissionPath,
  });
  assert.equal(m._readPermission(), null, 'no file → null');
  m._writePermission('granted');
  assert.equal(m._readPermission(), 'granted');
  m._writePermission('denied');
  assert.equal(m._readPermission(), 'denied');
  // Tolerate the OpenWhispr JSON shape { granted: bool }.
  fs.writeFileSync(permissionPath, JSON.stringify({ granted: true }));
  assert.equal(m._readPermission(), 'granted');
  fs.writeFileSync(permissionPath, JSON.stringify({ granted: false }));
  assert.equal(m._readPermission(), 'denied');
  // Garbage → null (never throws).
  fs.writeFileSync(permissionPath, 'nonsense');
  assert.equal(m._readPermission(), null);
});

// ── degrade path: missing / untrusted binary ──

test('start: a missing binary degrades to mic (not-installed), no spawn', async () => {
  const { spawn, calls } = fakeSpawn();
  const m = new SystemAudioTapManager({
    logger: noopLogger,
    config: fakeConfig,
    platform: 'darwin',
    systemVersion: '14.4',
    spawn,
    binaryPath: undefined,
  });
  // Force the resolved binary to nothing (simulate an unbuilt helper).
  m.binaryPath = null;
  const status = await m.start();
  assert.equal(calls.length, 0, 'no spawn without a trusted binary');
  assert.equal(status.degraded, true);
  assert.equal(status.reason, 'not-installed');
});

test('verifyMachO: accepts universal + matching arch, rejects wrong arch / garbage', () => {
  const fat = Buffer.concat([Buffer.from([0xca, 0xfe, 0xba, 0xbe]), Buffer.alloc(28)]);
  assert.equal(verifyMachO(fat).ok, true);
  assert.equal(verifyMachO(fat).arch, 'universal');

  // Thin arm64 Mach-O (magic 0xFEEDFACF LE, cpu-type ARM64).
  const arm64 = Buffer.alloc(32);
  arm64.writeUInt32LE(0xfeedfacf, 0);
  arm64.writeUInt32LE(0x0100000c, 4);
  assert.equal(verifyMachO(arm64, 'arm64').ok, true);
  assert.equal(verifyMachO(arm64, 'x64').ok, false, 'wrong arch rejected');

  // Garbage / too short.
  assert.equal(verifyMachO(Buffer.from([0, 1, 2])).ok, false);
  assert.equal(verifyMachO(Buffer.alloc(32)).ok, false);
});

// ── stop() is safe when nothing is running ──

test('stop: safe no-op when idle', async () => {
  const m = makeManager();
  await m.stop(); // must not throw
  assert.equal(m.getStatus().running, false);
});
