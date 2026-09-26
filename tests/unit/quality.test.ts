import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TIERS, TierController, backingSize, initialTierIndex, framesPerSecond, DEFAULT_CONTROLLER, type Decision } from '../../src/scene/quality.ts';

/**
 * Drive a controller with a frame-time model (ms per frame for the current tier) and record what
 * it decides, with the simulated wall-clock time of each decision. Stops at still mode.
 */
function run(c: TierController, msForTier: (index: number) => number, maxSeconds: number) {
  const log: Array<{ at: number; d: Decision }> = [];
  let t = 0;
  while (t < maxSeconds * 1000) {
    const ms = msForTier(c.index);
    t += ms;
    const d = c.sample(ms);
    if (d) log.push({ at: t, d });
    if (d?.kind === 'still') break;
  }
  return log;
}

describe('quality tiers', () => {
  test('tiers get cheaper in every dimension', () => {
    for (let i = 1; i < TIERS.length; i++) {
      const a = TIERS[i - 1]!;
      const b = TIERS[i]!;
      assert.ok(b.scale <= a.scale && b.steps < a.steps && b.lightSteps <= a.lightSteps && b.maxDpr <= a.maxDpr);
    }
  });

  test('backing size honours the tier scale and DPR cap', () => {
    assert.deepEqual(backingSize(1000, 500, 3, TIERS[0]!), { w: 2000, h: 1000 });
    assert.deepEqual(backingSize(1000, 500, 3, TIERS[3]!), { w: 400, h: 200 });
    assert.deepEqual(backingSize(400, 860, 3, TIERS[2]!), { w: 330, h: 710 });
  });

  test('phones and save-data start lower', () => {
    assert.equal(initialTierIndex({ coarsePointer: false, cssPixels: 1_000_000, saveData: false }), 1);
    assert.equal(initialTierIndex({ coarsePointer: true, cssPixels: 400_000, saveData: false }), 2);
    assert.equal(initialTierIndex({ coarsePointer: false, cssPixels: 1_000_000, saveData: true }), 3);
  });
});

describe('automatic fallback on slow GPUs', () => {
  test('40 ms frames step down one tier at a time, and keep animating on minimal', () => {
    const log = run(new TierController(0), () => 40, 120);
    assert.deepEqual(
      log.map((e) => e.d),
      [1, 2, 3].map((index) => ({ kind: 'tier', index })),
    );
  });

  for (const ms of [300, 500, 1000]) {
    test(`sustained ${ms} ms frames: medium → low → minimal → still mode, within seconds`, () => {
      const log = run(new TierController(1), () => ms, 600);
      assert.deepEqual(
        log.map((e) => e.d),
        [{ kind: 'tier', index: 2 }, { kind: 'tier', index: 3 }, { kind: 'still' }],
      );
      // Time-based windows: a slow GPU is judged in seconds, not in 30-frame windows of minutes.
      const seconds = log.at(-1)!.at / 1000;
      assert.ok(seconds <= Math.max(20, (ms / 1000) * 20), `gave up after ${seconds.toFixed(1)} s`);
    });
  }

  test('a software renderer (SwiftShader-like: 1000 → 330 → 140 ms) ends in still mode', () => {
    const cost = [1600, 1000, 330, 140];
    const c = new TierController(1);
    const log = run(c, (i) => cost[i]!, 600);
    assert.deepEqual(
      log.map((e) => e.d.kind),
      ['tier', 'tier', 'still'],
    );
    assert.equal(c.index, 3);
    assert.equal(c.gaveUp, true);
    assert.ok(log.at(-1)!.at < 15_000, `took ${log.at(-1)!.at} ms`);
    // Once given up, it stays quiet.
    for (let i = 0; i < 100; i++) assert.equal(c.sample(140), null);
  });

  test('frames that are slow on one tier but fine on the next stop the fallback there', () => {
    const cost = [60, 30, 16.7, 16.7];
    const c = new TierController(0);
    const log = run(c, (i) => cost[i]!, 60);
    assert.deepEqual(
      log.map((e) => e.d),
      [{ kind: 'tier', index: 1 }, { kind: 'tier', index: 2 }],
    );
    assert.equal(c.index, 2);
  });

  test('an isolated long frame is a hitch and changes nothing', () => {
    const c = new TierController(0);
    const log = run(c, () => 16.7, 1); // settle past warm-up
    assert.deepEqual(log, []);
    for (let k = 0; k < 20; k++) {
      for (let i = 0; i < 40; i++) assert.equal(c.sample(16.7), null);
      assert.equal(c.sample(900), null);
    }
    assert.equal(c.index, 0);
  });

  test('a run of long frames is not a hitch', () => {
    const c = new TierController(0);
    for (let i = 0; i < 60; i++) c.sample(16.7);
    const decisions = [];
    for (let i = 0; i < 6; i++) {
      const d = c.sample(400);
      if (d) decisions.push(d);
    }
    assert.deepEqual(decisions, [{ kind: 'tier', index: 1 }]);
  });

  test('after the tab was hidden, reset() ignores the first frames back', () => {
    const c = new TierController(1);
    for (let i = 0; i < 60; i++) c.sample(16.7);
    c.reset(); // the renderer calls this on visibilitychange
    assert.equal(c.sample(5000), null);
    assert.equal(c.sample(5000), null);
    assert.equal(c.index, 1);
  });

  test('a manual lock is never overridden', () => {
    const c = new TierController(1);
    c.lock(0);
    for (let i = 0; i < 500; i++) assert.equal(c.sample(1000), null);
    assert.equal(c.index, 0);
  });

  test('unlock after giving up tries again from what it learned', () => {
    const c = new TierController(3);
    run(c, () => 200, 60);
    assert.equal(c.gaveUp, true);
    c.unlock();
    assert.equal(c.gaveUp, false);
    const log = run(c, () => 200, 60);
    assert.deepEqual(
      log.map((e) => e.d),
      [{ kind: 'still' }],
    );
  });
});

describe('stepping up', () => {
  test('at 60 Hz (rAF paced to 16.7 ms) a fast GPU climbs from medium to high', () => {
    const c = new TierController(1);
    const log = run(c, () => 16.7, 30);
    assert.deepEqual(
      log.map((e) => e.d),
      [{ kind: 'tier', index: 0 }],
    );
  });

  test('at 120 Hz as well', () => {
    const c = new TierController(2);
    run(c, () => 8.33, 30);
    assert.equal(c.index, 0);
  });

  test('never back into a tier that was too slow (no oscillation)', () => {
    const c = new TierController(1);
    for (let i = 0; i < DEFAULT_CONTROLLER.warmup + DEFAULT_CONTROLLER.window; i++) c.sample(30);
    assert.equal(c.index, 2);
    for (let i = 0; i < 2000; i++) c.sample(16.7);
    assert.equal(c.index, 2);
  });

  test('a display that is only just kept up with does not count as headroom it lacks', () => {
    // Intervals alternate 16.7 / 33.3 ms (missing every other vsync): median 33 ms, which is slow.
    const c = new TierController(0);
    let k = 0;
    const log = run(c, () => (k++ % 2 ? 33.3 : 16.7), 5);
    assert.deepEqual(log[0]?.d, { kind: 'tier', index: 1 });
  });
});

describe('frame rate label', () => {
  test('median interval as frames per second', () => {
    assert.equal(framesPerSecond([]), null);
    assert.equal(Math.round(framesPerSecond([16.7, 16.6, 16.8, 50])!), 60);
    assert.equal(framesPerSecond([1000, 1000, 1000]), 1);
  });
});
