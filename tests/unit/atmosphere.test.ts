import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as A from '../../src/scene/atmosphere.ts';
import { sunVector } from '../../src/sun/solar.ts';

const shader = readFileSync(new URL('../../src/shaders/sky.frag', import.meta.url), 'utf8');
const glslConst = (name: string): number[] => {
  const m = new RegExp(`const\\s+(?:float|vec3)\\s+${name}\\s*=\\s*([^;]+);`).exec(shader);
  assert.ok(m, `${name} not found in sky.frag`);
  const body = m[1]!.replace(/^vec3\(/, '').replace(/\)$/, '');
  return [...body.matchAll(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g)].map((x) => Number(x[0]));
};

describe('sky ambient (TypeScript port of the shader)', () => {
  test('constants match sky.frag exactly', () => {
    assert.deepEqual(glslConst('R_EARTH'), [A.R_EARTH]);
    assert.deepEqual(glslConst('ATMOSPHERE'), [A.ATMOSPHERE]);
    assert.deepEqual(glslConst('EYE'), [A.EYE]);
    assert.deepEqual(glslConst('BETA_R'), A.BETA_R);
    assert.deepEqual(glslConst('BETA_M_S'), [A.BETA_M_S]);
    assert.deepEqual(glslConst('BETA_M_E'), [A.BETA_M_E]);
    assert.deepEqual(glslConst('H_R'), [A.H_R]);
    assert.deepEqual(glslConst('H_M'), [A.H_M]);
    assert.deepEqual(glslConst('OZONE'), A.OZONE);
    assert.deepEqual(glslConst('SUN_E'), [A.SUN_E]);
    assert.deepEqual(glslConst('NIGHT_SKY'), A.NIGHT_SKY);
  });

  test('a high sun gives a bright, blue ambient; a low one a dimmer, warmer one', () => {
    const noon = A.skyAmbient(sunVector(60, 180));
    const low = A.skyAmbient(sunVector(3, 90));
    assert.ok(noon[2] > noon[1] && noon[1] > noon[0], `noon ${noon}`);
    const lum = (c: number[]) => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    assert.ok(lum(noon) > 2 * lum(low));
    assert.ok(low[0] / low[2] > noon[0] / noon[2], 'low sun is warmer');
  });

  test('deep night is just the airglow term', () => {
    const night = A.skyAmbient(sunVector(-40, 0));
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(night[i]! - A.NIGHT_SKY[i]! * 0.6) < 1e-6, `${night}`);
  });

  test('finite and non-negative for every sun elevation', () => {
    for (let e = -90; e <= 90; e += 2.5) {
      for (const v of A.skyAmbient(sunVector(e, 123))) assert.ok(Number.isFinite(v) && v >= 0, `elevation ${e}: ${v}`);
    }
  });
});
