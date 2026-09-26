import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { blockFor, blockRadius, blockMask, union, FADE_TO } from '../../src/app/scrim.ts';
import { equaliseSlices } from '../../src/app/equalise.ts';

const desktop = { width: 1280, height: 800 };

describe('text dimming blocks', () => {
  const label = { left: 40, top: 40, right: 343, bottom: 163 };
  const readout = { left: 40, top: 668, right: 862, bottom: 757 };

  const corners = (b: { left: number; top: number; right: number; bottom: number }) => [
    [b.left, b.top],
    [b.right, b.top],
    [b.left, b.bottom],
    [b.right, b.bottom],
  ];

  test('every corner of each text block gets the full brightness cap (radius ≤ 1)', () => {
    for (const [box, anchor] of [
      [label, 'top-left'],
      [readout, 'bottom-left'],
      [{ left: 320, top: 200, right: 960, bottom: 420 }, 'centre'],
    ] as const) {
      const b = blockFor(box, anchor, desktop);
      for (const [x, y] of corners(box)) assert.ok(blockRadius(b, x!, y!) <= 1, `${anchor} (${x}, ${y}): ${blockRadius(b, x!, y!)}`);
    }
  });

  test('the label block is anchored to the top-left corner and leaves the middle of the sky alone', () => {
    const b = blockFor(label, 'top-left', desktop);
    assert.deepEqual([b.cx, b.cy], [0, 0]);
    assert.ok(blockRadius(b, 640, 400) >= FADE_TO);
    assert.ok(blockRadius(b, 1200, 60) >= FADE_TO, 'the top-right corner is not dimmed by it');
  });

  test('a readout wider than most of the screen becomes a band along the bottom edge', () => {
    const b = blockFor(readout, 'bottom-left', desktop);
    assert.equal(b.cy, 800);
    // Across the whole width, dimming depends only on the height.
    assert.ok(Math.abs(blockRadius(b, 0, 700) - blockRadius(b, 1280, 700)) < 0.01);
    assert.ok(blockRadius(b, 640, 400) >= FADE_TO);
    // A short readout stays a corner falloff.
    const short = blockFor({ ...readout, right: 500 }, 'bottom-left', desktop);
    assert.ok(blockMask(short, 1280, 790) < 0.01);
    assert.equal(blockMask(short, 100, 790), 1);
  });

  test('union ignores empty boxes', () => {
    assert.equal(union([]), null);
    assert.deepEqual(union([{ left: 5, top: 5, right: 5, bottom: 9 }, label]), label);
  });
});

describe('noise equalisation per slice', () => {
  test('every slice of every channel becomes uniform, so any horizontal plane covers exactly c', () => {
    const n = 64 * 64;
    const slices = 4;
    const data = new Uint8Array(n * slices * 4);
    // Skewed input that differs between slices (like one slice of a low-frequency noise).
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let z = 0; z < slices; z++) for (let i = 0; i < n * 4; i++) data[z * n * 4 + i] = Math.floor(255 * rnd() ** (1 + 0.3 * z));
    equaliseSlices(data, n);
    for (let z = 0; z < slices; z++) {
      for (let c = 0; c < 4; c++) {
        for (const t of [0.25, 0.5, 0.8125]) {
          let above = 0;
          for (let i = 0; i < n; i++) if (data[(z * n + i) * 4 + c]! / 255 > 1 - t) above++;
          assert.ok(Math.abs(above / n - t) < 0.02, `slice ${z} channel ${c}: ${above / n} for ${t}`);
        }
      }
    }
  });

  test('rejects data that is not whole slices', () => {
    assert.throws(() => equaliseSlices(new Uint8Array(10), 4));
  });
});
