'use strict';

// Sleep/wake re-warm orchestration (STT-03/SC3 resilience — "survive a full
// session"). openwhispr #766: sleep evicts the local GPU/stream state, so the
// resident whisper-server can die and the mic/tap streams go stale on resume.
//
// This module is intentionally PURE of Electron/powerMonitor: main.js injects
// the managers, the speech service, a re-entrancy flag getter/setter, and a
// settle delay, so the whole guarded sequence is unit-testable under bare node.
// Every step is isolated in its own try/catch and the flag is always reset in a
// finally — degrade-never-crash.
//
// The sequence (mirroring openwhispr's onWakeFromSleep):
//   settle → (a) re-probe/restart whisper-server → (b) reopen the system tap if
//   it was running → (c) replay the LAST known ambient state (re-acquire the mic
//   ONLY if the user was listening; never force-start a paused session).
//
// It does NOT interrupt an in-flight transcription: the whisper-server is only
// restarted when it is actually DOWN (a healthy server is left alone), and the
// mic re-acquire resets just the affected channel's partial buffer via the
// injected reacquireAmbientMic callback.

/**
 * @param {object} deps
 * @param {() => boolean} deps.isInFlight     - true if a re-warm is already running
 * @param {(v:boolean) => void} deps.setInFlight
 * @param {() => object|null} [deps.getWhisperManager]
 * @param {() => object|null} [deps.getTapManager]
 * @param {object} [deps.speechService]
 * @param {(buf:Buffer) => void} [deps.onSystemPcm]
 * @param {(live:boolean) => void} [deps.setSystemChannelEnabled]
 * @param {() => string} [deps.reacquireAmbientMic]
 * @param {number} [deps.settleMs=1500]
 * @param {(ms:number) => Promise<void>} [deps.delay]
 * @param {object} [deps.logger=console]
 * @returns {Promise<object>} a per-section result summary (also useful for tests)
 */
async function rewarmAfterWake(deps = {}) {
  const {
    isInFlight,
    setInFlight,
    getWhisperManager,
    getTapManager,
    speechService,
    onSystemPcm,
    setSystemChannelEnabled,
    reacquireAmbientMic,
    settleMs = 1500,
    delay = (ms) => new Promise((r) => setTimeout(r, ms)),
    logger = console,
  } = deps;

  const warn = (msg, meta) => {
    if (logger && typeof logger.warn === 'function') logger.warn(msg, meta);
  };

  // Re-entrancy guard: a burst of resume events (or a slow re-warm overlapping
  // the next wake) must never re-enter and double-restart the server/tap.
  if (typeof isInFlight === 'function' && isInFlight()) {
    return { skipped: 'reentrant' };
  }
  if (typeof setInFlight === 'function') setInFlight(true);

  const result = { whisper: 'noop', tap: 'noop', mic: 'noop' };
  try {
    // Short settle so the audio/GPU drivers finish coming back before we probe.
    await delay(settleMs);

    // (a) whisper-server: re-probe; restart only if DOWN (never interrupt an
    // in-flight transcription against a healthy server). The manager re-picks a
    // free port on restart (04-01), so a stale/orphan-held port is not an issue.
    try {
      const mgr = typeof getWhisperManager === 'function' ? getWhisperManager() : null;
      if (!mgr) {
        result.whisper = 'noop';
      } else if (typeof mgr.modelPresent === 'function' && !mgr.modelPresent()) {
        // No model on disk yet — nothing to re-warm (onboarding drives the DL).
        result.whisper = 'no-model';
      } else {
        const status = await mgr.getStatus();
        if (status && status.serverUp) {
          result.whisper = 'healthy';
        } else {
          await mgr.start();
          if (speechService && typeof speechService.setWhisperServerManager === 'function') {
            speechService.setWhisperServerManager(mgr);
          }
          result.whisper = 'restarted';
        }
      }
    } catch (e) {
      result.whisper = 'error';
      warn('wake re-warm: whisper-server re-probe failed (continuing)', { error: e && e.message });
    }

    // (b) system tap: reopen ONLY if it was running/granted (respect the
    // persisted grant — never force-open a tap the user never allowed).
    // start() is idempotent (returns early if already running) and routes every
    // failure through its own degrade-to-mic path.
    try {
      const tap = typeof getTapManager === 'function' ? getTapManager() : null;
      if (!tap || typeof tap.isSupported !== 'function' || !tap.isSupported()) {
        result.tap = tap ? 'unsupported' : 'noop';
      } else {
        const st = typeof tap.getStatus === 'function' ? tap.getStatus() : {};
        if (st && (st.running || st.granted)) {
          const tapStatus = await tap.start({ onPcm: onSystemPcm });
          const live = !!(tapStatus && tapStatus.running && tapStatus.granted);
          if (typeof setSystemChannelEnabled === 'function') setSystemChannelEnabled(live);
          result.tap = live ? 'reopened' : 'degraded';
        } else {
          result.tap = 'was-off';
        }
      }
    } catch (e) {
      result.tap = 'error';
      warn('wake re-warm: system tap reopen failed (continuing mic-only)', { error: e && e.message });
    }

    // (c) replay LAST known ambient state: re-acquire the mic stream if the user
    // was listening; do NOT force-start if they had paused (the callback honors
    // that intent).
    try {
      if (typeof reacquireAmbientMic === 'function') {
        result.mic = reacquireAmbientMic() || 'done';
      }
    } catch (e) {
      result.mic = 'error';
      warn('wake re-warm: mic re-acquire failed', { error: e && e.message });
    }

    return result;
  } finally {
    if (typeof setInFlight === 'function') setInFlight(false);
  }
}

module.exports = { rewarmAfterWake };
