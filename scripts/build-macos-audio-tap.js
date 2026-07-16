#!/usr/bin/env node
/**
 * Build the macOS system-audio Core Audio Process Tap helper (STT-04).
 *
 * Compiles resources/mac/system-audio-tap.swift into a universal Mach-O at
 * resources/bin/system-audio-tap. Mirrors OpenWhispr's
 * scripts/build-macos-audio-tap.js (MIT reference) and the repo's own
 * scripts/build-whisper-server.js "compile at build time, verify Mach-O arch,
 * no-op off-darwin, cache" philosophy.
 *
 * Behavior:
 *   - Non-darwin  → exit 0 immediately (system audio is macOS-only this phase).
 *     Overridable for testing via AUDIO_TAP_BUILD_FORCE_PLATFORM.
 *   - darwin      → swiftc per-arch (target macOS 14.4 — NOT 14.2; keeps the tap
 *     in the correct NSAudioCaptureUsageDescription TCC category, 04-RESEARCH
 *     Flag 3), lipo the slices into resources/bin/system-audio-tap, verify its
 *     Mach-O magic + cpu-type, and cache by source-hash so a second run is a fast
 *     no-op.
 *   - Missing swiftc / xcrun → a clear, actionable one-line message (never a raw
 *     stack trace) and a non-zero exit.
 *
 * The TCC prompt itself only fires on a signed build (the phase's PRIMARY RISK,
 * exercised in the 04-05 signing spike); this script just produces the binary.
 * Phase 8 owns the final asarUnpack/entitlements/DMG signing.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const logger = require('../src/core/logger').createServiceLogger('AUDIO-TAP-BUILD');

// ── Constants ──
const DEPLOYMENT_TARGET = '14.4'; // Core Audio Taps in the right TCC bucket (Flag 3)
const ARCHS = ['arm64', 'x86_64'];

const REPO_ROOT = path.join(__dirname, '..');
const SRC_PATH = path.join(REPO_ROOT, 'resources', 'mac', 'system-audio-tap.swift');
const BIN_DIR = path.join(REPO_ROOT, 'resources', 'bin');
const BIN_PATH = path.join(BIN_DIR, 'system-audio-tap');
const MARKER = path.join(BIN_DIR, '.system-audio-tap.hash');

// Mach-O magic + accepted cpu-types (kept local so this script is dependency-free;
// the manager carries its own copy for runtime checks).
const MH_MAGIC_64 = 0xfeedfacf;
const MH_CIGAM_64 = 0xcffaedfe;
const FAT_MAGIC = 0xcafebabe;
const FAT_CIGAM = 0xbebafeca;
const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;

/** Verify a Mach-O binary's magic + cpu-type from its leading bytes. */
function verifyMachO(buffer, expectedArch = process.arch) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return { ok: false, arch: null };
  const magicLE = buffer.readUInt32LE(0);
  const magicBE = buffer.readUInt32BE(0);
  if ([FAT_MAGIC, FAT_CIGAM].includes(magicBE) || [FAT_MAGIC, FAT_CIGAM].includes(magicLE)) {
    return { ok: true, arch: 'universal' }; // fat binary carries every slice
  }
  let cpuType;
  if (magicLE === MH_MAGIC_64) cpuType = buffer.readUInt32LE(4);
  else if (magicLE === MH_CIGAM_64) cpuType = buffer.readUInt32BE(4);
  else return { ok: false, arch: null };
  const arch = cpuType === CPU_TYPE_ARM64 ? 'arm64' : cpuType === CPU_TYPE_X86_64 ? 'x64' : 'unknown';
  return { ok: arch === expectedArch, arch };
}

/** True if `cmd args` runs and exits 0 — used to detect the toolchain. */
function toolPresent(cmd, args = ['--version']) {
  try {
    const r = spawnSync(cmd, args, { stdio: 'ignore' });
    return r.status === 0;
  } catch (_) {
    return false;
  }
}

/** Run a build step; throw a clean error (never a raw stack) on failure. */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts });
  if (r.error) throw new Error(`${cmd} could not be launched: ${r.error.message}`);
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout || '').toString().trim().split('\n').slice(-3).join(' ');
    throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.status})${detail ? `: ${detail}` : ''}`);
  }
  return r;
}

function sourceHash() {
  const src = fs.readFileSync(SRC_PATH);
  return crypto.createHash('sha256').update(src).update(DEPLOYMENT_TARGET).digest('hex');
}

function binaryUpToDate(hash) {
  try {
    if (!fs.existsSync(BIN_PATH) || !fs.existsSync(MARKER)) return false;
    if (fs.readFileSync(MARKER, 'utf8').trim() !== hash) return false;
    const fd = fs.openSync(BIN_PATH, 'r');
    try {
      const head = Buffer.alloc(32);
      fs.readSync(fd, head, 0, 32, 0);
      return verifyMachO(head).ok;
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
    return false;
  }
}

/**
 * Resolve how to invoke swiftc: prefer `xcrun swiftc` (picks the active SDK),
 * fall back to a bare `swiftc` on PATH. Returns { cmd, prefixArgs } or null.
 */
function resolveSwiftc() {
  if (toolPresent('xcrun', ['swiftc', '--version'])) {
    return { cmd: 'xcrun', prefixArgs: ['swiftc'] };
  }
  if (toolPresent('swiftc', ['--version'])) {
    return { cmd: 'swiftc', prefixArgs: [] };
  }
  return null;
}

function ensureToolchain() {
  if (!resolveSwiftc()) {
    throw new Error(
      'Cannot build system-audio-tap — swiftc not found. Install the Xcode '
      + 'Command Line Tools (`xcode-select --install`) and re-run '
      + '`npm run compile:audio-tap`.',
    );
  }
}

function buildAndInstall(hash) {
  const swift = resolveSwiftc();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencluely-audio-tap-'));
  const slices = [];
  try {
    // Compile one slice per arch, each pinned to the 14.4 deployment target.
    // -swift-version 5 keeps the C-callback/global-state helper building under
    // the Swift 6 toolchain (strict concurrency would otherwise reject it).
    for (const arch of ARCHS) {
      const out = path.join(tmpDir, `system-audio-tap-${arch}`);
      run(swift.cmd, [
        ...swift.prefixArgs,
        SRC_PATH,
        '-O',
        '-swift-version', '5',
        '-target', `${arch}-apple-macosx${DEPLOYMENT_TARGET}`,
        '-o', out,
      ]);
      slices.push(out);
      logger.info('compiled arch slice', { arch });
    }

    fs.mkdirSync(BIN_DIR, { recursive: true });
    // lipo the slices into one universal binary (single slice → still valid).
    run('lipo', ['-create', ...slices, '-output', BIN_PATH]);
    fs.chmodSync(BIN_PATH, 0o755);

    const head = Buffer.alloc(32);
    const fd = fs.openSync(BIN_PATH, 'r');
    try { fs.readSync(fd, head, 0, 32, 0); } finally { fs.closeSync(fd); }
    const machO = verifyMachO(head);
    if (!machO.ok) {
      fs.rmSync(BIN_PATH, { force: true });
      throw new Error(
        `Built system-audio-tap is not a valid ${process.arch}/universal Mach-O `
        + `(got arch=${machO.arch || 'unknown'}) — refusing to install it.`,
      );
    }

    fs.writeFileSync(MARKER, hash);
    logger.info('system-audio-tap built and installed', { path: BIN_PATH, arch: machO.arch });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function main() {
  const platform = process.env.AUDIO_TAP_BUILD_FORCE_PLATFORM || process.platform;
  if (platform !== 'darwin') {
    logger.info('non-darwin platform — skipping system-audio-tap build (no-op)', { platform });
    process.exit(0);
  }

  if (!fs.existsSync(SRC_PATH)) {
    logger.error('system-audio-tap source missing', { path: SRC_PATH });
    process.exit(1);
  }

  try {
    const hash = sourceHash();
    if (binaryUpToDate(hash)) {
      logger.info('system-audio-tap already built and current — nothing to do', { path: BIN_PATH });
      process.exit(0);
    }
    ensureToolchain();
    buildAndInstall(hash);
    process.exit(0);
  } catch (e) {
    logger.error('system-audio-tap build failed', { error: e.message });
    process.exit(1);
  }
}

main();
