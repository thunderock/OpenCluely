#!/usr/bin/env node
/**
 * Build whisper.cpp `whisper-server` from source into resources/bin (STT-01).
 *
 * whisper.cpp v1.9.1 ships NO prebuilt macOS CLI/server binary (its darwin
 * release asset is an xcframework library, not a runnable server), so — like
 * the repo's "compile the Swift helper at build time, verify Mach-O arch,
 * no-op off-darwin" philosophy — we compile it ourselves with CMake. Metal is
 * ON by default on Apple Silicon (do NOT disable it); it is a 30-60% latency
 * win on this model class.
 *
 * Behavior:
 *   - Non-darwin  → exit 0 immediately (Windows/Linux STT is out of scope this
 *     phase). Overridable for testing via WHISPER_BUILD_FORCE_PLATFORM.
 *   - darwin      → clone/checkout whisper.cpp pinned to a tag, CMake-build the
 *     `whisper-server` target, copy build/bin/whisper-server → resources/bin,
 *     verify its Mach-O magic + cpu-type, and write a version marker so a second
 *     run is a fast no-op.
 *   - Missing Xcode CLT / CMake / git → a clear, actionable one-line message
 *     (never a raw stack trace) and a non-zero exit.
 *
 * Phase 8 owns the final asarUnpack/DMG/CI fetch-vs-build decision; this only
 * needs the binary resolvable in dev at resources/bin/whisper-server.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const logger = require('../src/core/logger').createServiceLogger('WHISPER-BUILD');

// ── Constants ──
const TAG = process.env.WHISPER_CPP_VERSION || 'v1.9.1';
const REPO_URL = 'https://github.com/ggml-org/whisper.cpp.git';

const REPO_ROOT = path.join(__dirname, '..');
const RESOURCES_DIR = path.join(REPO_ROOT, 'resources');
const BIN_DIR = path.join(RESOURCES_DIR, 'bin');
const BIN_PATH = path.join(BIN_DIR, 'whisper-server');
const SRC_DIR = path.join(RESOURCES_DIR, '.whisper-cpp-src');
const BUILD_DIR = path.join(SRC_DIR, 'build');
const MARKER = path.join(BIN_DIR, '.whisper-server.version');

// Mach-O 64-bit magic + the two cpu-types we accept (kept local so this script
// stays dependency-free — the manager carries its own copy for runtime checks).
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

/** Run a build step with inherited stdio (live progress); throw a clean error on failure. */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) throw new Error(`${cmd} could not be launched: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed with exit code ${r.status}`);
}

function binaryUpToDate() {
  try {
    if (!fs.existsSync(BIN_PATH) || !fs.existsSync(MARKER)) return false;
    if (fs.readFileSync(MARKER, 'utf8').trim() !== TAG) return false;
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

function ensureToolchain() {
  const missing = [];
  if (!toolPresent('git')) missing.push('git');
  if (!toolPresent('cmake')) missing.push('cmake (install with `brew install cmake`)');
  // Xcode Command Line Tools provide the C/C++ compiler CMake needs.
  const cltOk = toolPresent('xcode-select', ['-p']) && (toolPresent('clang') || toolPresent('cc'));
  if (!cltOk) missing.push('Xcode Command Line Tools (install with `xcode-select --install`)');
  if (missing.length) {
    throw new Error(
      `Cannot build whisper-server — missing build tools: ${missing.join(', ')}. `
      + 'Install them and re-run `npm run compile:whisper-server`.',
    );
  }
}

function fetchSource() {
  if (!fs.existsSync(SRC_DIR)) {
    logger.info('cloning whisper.cpp', { tag: TAG });
    run('git', ['clone', '--depth', '1', '--branch', TAG, REPO_URL, SRC_DIR]);
    return;
  }
  // Existing checkout — try to move it to the pinned tag; re-clone if it is
  // broken or the tag is unreachable, so a stale/corrupt cache never wins.
  logger.info('reusing whisper.cpp checkout; pinning tag', { tag: TAG });
  const fetched = spawnSync('git', ['-C', SRC_DIR, 'fetch', '--depth', '1', 'origin', 'tag', TAG], { stdio: 'inherit' });
  const checkedOut = fetched.status === 0
    ? spawnSync('git', ['-C', SRC_DIR, 'checkout', '-q', TAG], { stdio: 'inherit' }).status === 0
    : false;
  if (!checkedOut) {
    logger.warn('existing checkout unusable; re-cloning', { tag: TAG });
    fs.rmSync(SRC_DIR, { recursive: true, force: true });
    run('git', ['clone', '--depth', '1', '--branch', TAG, REPO_URL, SRC_DIR]);
  }
}

function buildAndInstall() {
  // Metal is ON by default on Apple Silicon — pass no flag to disable it.
  run('cmake', ['-S', SRC_DIR, '-B', BUILD_DIR, '-DCMAKE_BUILD_TYPE=Release']);
  run('cmake', ['--build', BUILD_DIR, '--target', 'whisper-server', '--config', 'Release', '-j']);

  const built = path.join(BUILD_DIR, 'bin', 'whisper-server');
  if (!fs.existsSync(built)) {
    throw new Error(`Build finished but ${built} is missing — check the CMake output above.`);
  }

  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.copyFileSync(built, BIN_PATH);
  fs.chmodSync(BIN_PATH, 0o755);

  const head = Buffer.alloc(32);
  const fd = fs.openSync(BIN_PATH, 'r');
  try { fs.readSync(fd, head, 0, 32, 0); } finally { fs.closeSync(fd); }
  const machO = verifyMachO(head);
  if (!machO.ok) {
    fs.rmSync(BIN_PATH, { force: true });
    throw new Error(
      `Built binary is not a valid ${process.arch} Mach-O (got arch=${machO.arch || 'unknown'}) — refusing to install it.`,
    );
  }

  fs.writeFileSync(MARKER, TAG);
  logger.info('whisper-server built and installed', { path: BIN_PATH, arch: machO.arch, tag: TAG });
}

function main() {
  const platform = process.env.WHISPER_BUILD_FORCE_PLATFORM || process.platform;
  if (platform !== 'darwin') {
    logger.info('non-darwin platform — skipping whisper-server build (no-op)', { platform });
    process.exit(0);
  }

  if (binaryUpToDate()) {
    logger.info('whisper-server already built and current — nothing to do', { path: BIN_PATH, tag: TAG });
    process.exit(0);
  }

  try {
    ensureToolchain();
    fs.mkdirSync(RESOURCES_DIR, { recursive: true });
    fetchSource();
    buildAndInstall();
    process.exit(0);
  } catch (e) {
    // Actionable one-liner, never a raw stack trace.
    logger.error('whisper-server build failed', { error: e.message });
    process.exit(1);
  }
}

main();
