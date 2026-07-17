'use strict';

// Bare-node unit tests for the pure TCC permission-loss cross-check monitor
// (05-04, SEC-02). Proves the LOCKED cross-check semantics: screen loss needs
// BOTH the black-frame streak AND a non-granted status; mic loss needs BOTH a
// recorded stream failure AND a non-granted status; emission is transition-only
// (no per-tick spam); signal disagreements surface through the greppable
// onDisagreement seam instead of a banner; non-darwin platforms are inert.

const { test } = require('node:test');
const assert = require('node:assert');
const { createTccMonitor } = require('../src/core/tcc-monitor');

function makeMonitor(overrides = {}) {
  const emissions = [];
  const disagreements = [];
  const env = {
    screenStatus: 'granted',
    micStatus: 'granted',
    emissions,
    disagreements,
  };
  const monitor = createTccMonitor({
    getScreenStatus: () => env.screenStatus,
    getMicStatus: () => env.micStatus,
    onStateChange: (state) => emissions.push(state),
    onDisagreement: (d) => disagreements.push(d),
    platform: 'darwin',
    ...overrides,
  });
  return { monitor, env };
}

test('screen loss: 3 black frames + non-granted status ⇒ ONE transition (black-frames reason)', () => {
  const { monitor, env } = makeMonitor();
  env.screenStatus = 'denied';

  monitor.recordFrameStats({ isBlack: true });
  monitor.recordFrameStats({ isBlack: true });
  assert.deepStrictEqual(env.emissions, [], 'below-threshold streak must not emit');

  monitor.recordFrameStats({ isBlack: true });
  assert.deepStrictEqual(env.emissions, [
    { screen: 'lost', mic: 'ok', reason: 'black-frames' },
  ]);
  assert.deepStrictEqual(monitor.getState(), { screen: 'lost', mic: 'ok' });
});

test('cross-check blocks the false alarm: black frames WITH granted ⇒ no state change, one disagreement', () => {
  const { monitor, env } = makeMonitor();
  env.screenStatus = 'granted';

  for (let i = 0; i < 4; i++) monitor.recordFrameStats({ isBlack: true });

  assert.deepStrictEqual(env.emissions, [], 'granted status must veto the black-frame signal');
  assert.deepStrictEqual(
    env.disagreements,
    [{ kind: 'screen', streak: 3, status: 'granted' }],
    'disagreement fires once on entry (streak hitting threshold), not per tick'
  );
  assert.deepStrictEqual(monitor.getState(), { screen: 'ok', mic: 'ok' });
});

test('streak resets on a non-black frame: 2 black + 1 clear + 2 black ⇒ no emission', () => {
  const { monitor, env } = makeMonitor();
  env.screenStatus = 'denied';

  monitor.recordFrameStats({ isBlack: true });
  monitor.recordFrameStats({ isBlack: true });
  monitor.recordFrameStats({ isBlack: false });
  monitor.recordFrameStats({ isBlack: true });
  monitor.recordFrameStats({ isBlack: true });

  assert.deepStrictEqual(env.emissions, [], 'streak never reaches threshold');
  assert.deepStrictEqual(monitor.getState(), { screen: 'ok', mic: 'ok' });
});

test('transition-only: lost emits once; recovery via checkNow(granted + non-black frame) emits ok exactly once', () => {
  const { monitor, env } = makeMonitor();
  env.screenStatus = 'denied';

  monitor.recordFrameStats({ isBlack: true });
  monitor.recordFrameStats({ isBlack: true });
  monitor.recordFrameStats({ isBlack: true });
  assert.strictEqual(env.emissions.length, 1, 'loss emitted once');

  // Further black frames + denied re-checks must emit NOTHING new.
  monitor.recordFrameStats({ isBlack: true });
  monitor.recordFrameStats({ isBlack: true });
  monitor.checkNow('focus');
  assert.strictEqual(env.emissions.length, 1, 'no re-emission while still lost');

  // A non-black frame alone (status still denied) is not recovery.
  monitor.recordFrameStats({ isBlack: false });
  assert.strictEqual(env.emissions.length, 1, 'non-black frame with non-granted status stays lost');

  // Status re-granted AND a non-black frame has arrived ⇒ ok, exactly once.
  env.screenStatus = 'granted';
  monitor.checkNow('resume');
  assert.deepStrictEqual(env.emissions[1], { screen: 'ok', mic: 'ok', reason: 'resume' });

  monitor.checkNow('focus');
  assert.strictEqual(env.emissions.length, 2, 'recovery emitted exactly once');
});

test('mic loss: recorded failure + non-granted status ⇒ { mic: lost }', () => {
  const { monitor, env } = makeMonitor();
  env.micStatus = 'denied';

  monitor.recordMicFailure();

  assert.deepStrictEqual(env.emissions, [
    { screen: 'ok', mic: 'lost', reason: 'mic-failure' },
  ]);
  assert.deepStrictEqual(monitor.getState(), { screen: 'ok', mic: 'lost' });
});

test('mic cross-check: failure WITH granted status ⇒ no emission, mic disagreement logged', () => {
  const { monitor, env } = makeMonitor();
  env.micStatus = 'granted';

  monitor.recordMicFailure();

  assert.deepStrictEqual(env.emissions, [], 'both signals required for mic loss');
  assert.deepStrictEqual(env.disagreements, [{ kind: 'mic', status: 'granted' }]);
  assert.deepStrictEqual(monitor.getState(), { screen: 'ok', mic: 'ok' });
});

test('mic recovery: recordMicRecovered() with granted status emits ok exactly once', () => {
  const { monitor, env } = makeMonitor();
  env.micStatus = 'denied';

  monitor.recordMicFailure();
  assert.strictEqual(env.emissions.length, 1);

  env.micStatus = 'granted';
  monitor.recordMicRecovered();
  assert.deepStrictEqual(env.emissions[1], { screen: 'ok', mic: 'ok', reason: 'mic-recovered' });

  monitor.checkNow('focus');
  assert.strictEqual(env.emissions.length, 2, 'no re-emission once recovered');
});

test('checkNow(startup) with denied status but streak 0 ⇒ no banner, disagreement warn-logged', () => {
  const { monitor, env } = makeMonitor();
  env.screenStatus = 'denied';

  monitor.checkNow('startup');

  assert.deepStrictEqual(env.emissions, [], 'status alone is insufficient for screen loss (locked cross-check)');
  assert.deepStrictEqual(env.disagreements, [{ kind: 'screen', streak: 0, status: 'denied' }]);
  assert.deepStrictEqual(monitor.getState(), { screen: 'ok', mic: 'ok' });
});

test('non-darwin: all methods are inert no-ops (never emit, state stays ok)', () => {
  const { monitor, env } = makeMonitor({ platform: 'linux' });
  env.screenStatus = 'denied';
  env.micStatus = 'denied';

  for (let i = 0; i < 5; i++) monitor.recordFrameStats({ isBlack: true });
  monitor.recordMicFailure();
  monitor.checkNow('startup');

  assert.deepStrictEqual(env.emissions, []);
  assert.deepStrictEqual(env.disagreements, []);
  assert.deepStrictEqual(monitor.getState(), { screen: 'ok', mic: 'ok' });
});

test('a throwing listener never breaks the monitor (state machine keeps advancing)', () => {
  const { monitor, env } = makeMonitor({
    onStateChange: () => { throw new Error('listener boom'); },
    onDisagreement: () => { throw new Error('listener boom'); },
  });
  env.screenStatus = 'denied';

  for (let i = 0; i < 3; i++) monitor.recordFrameStats({ isBlack: true });
  assert.deepStrictEqual(monitor.getState(), { screen: 'lost', mic: 'ok' });

  env.screenStatus = 'granted';
  monitor.recordFrameStats({ isBlack: false });
  assert.deepStrictEqual(monitor.getState(), { screen: 'ok', mic: 'ok' });
});

test('blackStreakThreshold is a constructor param (threshold 2 ⇒ loss on the 2nd black frame)', () => {
  const { monitor, env } = makeMonitor({ blackStreakThreshold: 2 });
  env.screenStatus = 'denied';

  monitor.recordFrameStats({ isBlack: true });
  assert.deepStrictEqual(env.emissions, []);

  monitor.recordFrameStats({ isBlack: true });
  assert.deepStrictEqual(env.emissions, [
    { screen: 'lost', mic: 'ok', reason: 'black-frames' },
  ]);
});

test('trusts the capture loop streak counter when provided (the 05-01 seam contract)', () => {
  const { monitor, env } = makeMonitor();
  env.screenStatus = 'denied';

  monitor.recordFrameStats({ isBlack: true, streak: 3 });

  assert.deepStrictEqual(env.emissions, [
    { screen: 'lost', mic: 'ok', reason: 'black-frames' },
  ]);
});
