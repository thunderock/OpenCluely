'use strict';

// macOS TCC permission-loss cross-check monitor (SEC-02, 05-04).
//
// Pure of Electron (wake-rewarm idiom): main.js injects the status getters
// (systemPreferences.getMediaAccessStatus bound per media kind) and the two
// listener seams, so the whole fusion state machine is unit-testable under
// bare node. Every injected callback is try/caught — a listener throw must
// never break the monitor (degrade-never-crash).
//
// LOCKED cross-check semantics (05-CONTEXT):
//   - Screen 'lost' requires BOTH signals: a consecutive all-black-frame
//     streak >= threshold (from the 05-01 capture-loop seam) AND
//     getScreenStatus() !== 'granted'. Black frames WITH 'granted' are a
//     signal disagreement (genuinely black screen / post-update stale-grant
//     edge) — surfaced through onDisagreement, never a banner.
//   - Screen back to 'ok' requires status 'granted' AND a non-black frame
//     having actually arrived (sticky-lost hysteresis; a mere streak reset
//     under a non-granted status is not recovery).
//   - Mic 'lost' requires BOTH: a recorded stream failure (sticky until
//     recordMicRecovered()) AND getMicStatus() !== 'granted'.
//   - Emission is TRANSITION-ONLY: onStateChange fires only when the fused
//     { screen, mic } state actually changes — no per-tick spam.
//   - Re-checks are event-driven only (startup / black-frame signal / focus
//     regain / powerMonitor resume call checkNow) — no polling timer here.
//   - platform !== 'darwin' => every method is an inert no-op (TCC is
//     macOS-only; state stays all-'ok').

const OK = 'ok';
const LOST = 'lost';

/**
 * @param {object} deps
 * @param {() => string} deps.getScreenStatus - e.g. () => systemPreferences.getMediaAccessStatus('screen')
 * @param {() => string} deps.getMicStatus    - e.g. () => systemPreferences.getMediaAccessStatus('microphone')
 * @param {(state:{screen:'ok'|'lost', mic:'ok'|'lost', reason:string}) => void} [deps.onStateChange]
 *        Fired on TRANSITIONS ONLY.
 * @param {(d:{kind:'screen'|'mic', streak?:number, status:string}) => void} [deps.onDisagreement]
 *        The greppable warn seam — fired once on entry into a signal-disagreement
 *        condition (never per tick).
 * @param {number} [deps.blackStreakThreshold=3]
 * @param {string} [deps.platform=process.platform]
 * @returns {{ recordFrameStats(stats:{isBlack:boolean, streak?:number}):void,
 *             recordMicFailure():void, recordMicRecovered():void,
 *             checkNow(reason?:string):void,
 *             getState():{screen:string, mic:string} }}
 */
function createTccMonitor(deps = {}) {
  const {
    getScreenStatus,
    getMicStatus,
    onStateChange,
    onDisagreement,
    blackStreakThreshold = 3,
    platform = process.platform,
  } = deps;

  const inert = platform !== 'darwin';

  const state = { screen: OK, mic: OK };
  let streak = 0; // consecutive all-black captured frames
  let lastFrameIsBlack = null; // null until the first frame arrives
  let micFailed = false; // sticky until recordMicRecovered()

  // Entry-tracked disagreement conditions: each fires onDisagreement once when
  // the condition becomes true, then stays quiet until it clears and re-enters
  // (greppable without a warn line every capture tick).
  const active = {
    screenBlackGranted: false, // black streak at threshold but status says granted
    screenStatusOnly: false, // status non-granted but the frame signal hasn't confirmed
    micFailedGranted: false, // mic stream failed but status says granted
  };

  const safeCall = (fn, payload) => {
    if (typeof fn !== 'function') return;
    try {
      fn(payload);
    } catch {
      // A listener throw must never break the monitor.
    }
  };

  const readStatus = (fn) => {
    if (typeof fn !== 'function') return 'unknown';
    try {
      return fn();
    } catch {
      return 'unknown';
    }
  };

  function noteDisagreements(screenStatus, micStatus) {
    const blackGranted = streak >= blackStreakThreshold && screenStatus === 'granted';
    if (blackGranted && !active.screenBlackGranted) {
      safeCall(onDisagreement, { kind: 'screen', streak, status: screenStatus });
    }
    active.screenBlackGranted = blackGranted;

    const statusOnly =
      state.screen === OK && screenStatus !== 'granted' && streak < blackStreakThreshold;
    if (statusOnly && !active.screenStatusOnly) {
      safeCall(onDisagreement, { kind: 'screen', streak, status: screenStatus });
    }
    active.screenStatusOnly = statusOnly;

    const micGranted = micFailed && micStatus === 'granted';
    if (micGranted && !active.micFailedGranted) {
      safeCall(onDisagreement, { kind: 'mic', status: micStatus });
    }
    active.micFailedGranted = micGranted;
  }

  function nextScreenState(screenStatus) {
    if (state.screen === OK) {
      // Loss needs BOTH pillars (the locked cross-check).
      return streak >= blackStreakThreshold && screenStatus !== 'granted' ? LOST : OK;
    }
    // Sticky-lost: recovery needs status granted AND an actual non-black frame.
    return screenStatus === 'granted' && lastFrameIsBlack === false ? OK : LOST;
  }

  function nextMicState(micStatus) {
    if (state.mic === OK) {
      return micFailed && micStatus !== 'granted' ? LOST : OK;
    }
    return micStatus === 'granted' && !micFailed ? OK : LOST;
  }

  function evaluate(reason) {
    const screenStatus = readStatus(getScreenStatus);
    const micStatus = readStatus(getMicStatus);

    const nextScreen = nextScreenState(screenStatus);
    const nextMic = nextMicState(micStatus);

    // Transition-only guard: emit ONLY when the fused state actually changes.
    if (nextScreen !== state.screen || nextMic !== state.mic) {
      state.screen = nextScreen;
      state.mic = nextMic;
      safeCall(onStateChange, { screen: state.screen, mic: state.mic, reason });
    }

    noteDisagreements(screenStatus, micStatus);
  }

  return {
    /**
     * Per-captured-tick signal from the 05-01 capture-loop seam
     * (captureService.setFrameStatsListener).
     */
    recordFrameStats(stats) {
      if (inert) return;
      const s = stats || {};
      const isBlack = !!s.isBlack;
      if (!isBlack) {
        streak = 0;
      } else if (Number.isFinite(s.streak) && s.streak > 0) {
        // Trust the capture loop's own consecutive-black counter when provided.
        streak = Math.floor(s.streak);
      } else {
        streak += 1;
      }
      lastFrameIsBlack = isBlack;
      evaluate(isBlack ? 'black-frames' : 'frame');
    },

    /** Speech-path stream failure signal (sticky until recovered). */
    recordMicFailure() {
      if (inert) return;
      micFailed = true;
      evaluate('mic-failure');
    },

    /** Mic stream (re)started successfully — clears the sticky failure. */
    recordMicRecovered() {
      if (inert) return;
      micFailed = false;
      evaluate('mic-recovered');
    },

    /** Event-driven re-check (startup / focus regain / powerMonitor resume). */
    checkNow(reason) {
      if (inert) return;
      evaluate(reason || 'check');
    },

    getState() {
      return { screen: state.screen, mic: state.mic };
    },
  };
}

module.exports = { createTccMonitor };
