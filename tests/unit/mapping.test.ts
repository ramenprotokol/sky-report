import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseMetar } from '../../src/metar/parse.ts';
import {
  sceneFrom,
  sceneUniforms,
  layersFrom,
  driftFrom,
  hazeFrom,
  precipFrom,
  observationDate,
  sunFrom,
  viewFor,
  exposureFor,
  cameraBasis,
  CLOUD_KIND,
  COVERAGE,
  FT,
  KOSCHMIEDER,
  OR_MORE_FACTOR,
  NIGHT_EXPOSURE,
  DAY_EXPOSURE,
  MAX_LAYERS,
  DRAWN_COVERAGE,
  MIN_VISIBLE_THICKNESS_M,
} from '../../src/scene/mapping.ts';

const P = (raw: string) => {
  const m = parseMetar(raw);
  assert.equal(m.ok, true, m.error ?? '');
  return m;
};
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

describe('cloud layers', () => {
  test('BKN025 → base 762 m, coverage 6/8, stratiform', () => {
    const { layers } = layersFrom(P('METAR EGLL 010650Z 27010KT 9999 BKN025 12/10 Q1023'));
    assert.equal(layers.length, 1);
    near(layers[0]!.baseM, 2500 * FT);
    near(layers[0]!.coverage, 0.75);
    assert.equal(layers[0]!.kind, CLOUD_KIND.stratiform);
  });

  test('coverage follows oktas: FEW < SCT < BKN < OVC = 1', () => {
    assert.ok(COVERAGE.FEW < COVERAGE.SCT && COVERAGE.SCT < COVERAGE.BKN && COVERAGE.BKN < COVERAGE.OVC);
    assert.equal(COVERAGE.OVC, 1);
    near(COVERAGE.FEW, 1.5 / 8);
  });

  test('cloud style by height: cumulus low, mid-level, cirrus high, towering for CB/TCU', () => {
    const { layers } = layersFrom(P('METAR WSSS 260630Z 19008KT 4500 HZ FEW018 FEW020TCU SCT100 BKN300 34/23 Q1009'));
    assert.deepEqual(
      layers.map((l) => l.kind),
      [CLOUD_KIND.cumulus, CLOUD_KIND.towering, CLOUD_KIND.mid, CLOUD_KIND.cirrus],
    );
  });

  test('layers never overlap', () => {
    const { layers } = layersFrom(P('METAR EFHK 260650Z 18011KT 8000 -DZRA FEW004 BKN007 BKN012 14/13 Q1011'));
    for (let i = 0; i < layers.length - 1; i++) {
      assert.ok(layers[i]!.baseM + layers[i]!.thicknessM < layers[i + 1]!.baseM, `layer ${i} overlaps`);
    }
  });

  test('a layer squeezed thinner than is visible under the next one is flagged', () => {
    const { layers } = layersFrom(P('METAR EGXX 010650Z 24010KT 9999 FEW004 BKN005 BKN030 12/10 Q1010'));
    assert.equal(layers[0]!.squeezed, true);
    assert.ok(layers[0]!.thicknessM < MIN_VISIBLE_THICKNESS_M);
    assert.equal(layers[1]!.squeezed, false);
    assert.equal(layers[2]!.squeezed, false);
    // Close, but with room for a visible layer: not flagged.
    const ok = layersFrom(P('METAR EGXX 010650Z 24010KT 9999 FEW010 BKN020 12/10 Q1010')).layers;
    assert.ok(ok[0]!.thicknessM >= MIN_VISIBLE_THICKNESS_M);
    assert.equal(ok[0]!.squeezed, false);
  });

  test('drawn coverage is calibrated per style, and still grows FEW < SCT < BKN < OVC', () => {
    for (const kind of Object.values(CLOUD_KIND)) {
      const t = DRAWN_COVERAGE[kind];
      assert.ok(0 < t.FEW && t.FEW < t.SCT && t.SCT < t.BKN && t.BKN < 1, `kind ${kind}`);
    }
    const { layers } = layersFrom(P('METAR WSSS 260630Z 19008KT 4500 HZ FEW018 FEW020TCU SCT100 BKN300 34/23 Q1009'));
    assert.deepEqual(
      layers.map((l) => l.drawnCoverage),
      [DRAWN_COVERAGE[CLOUD_KIND.cumulus].FEW, DRAWN_COVERAGE[CLOUD_KIND.towering].FEW, DRAWN_COVERAGE[CLOUD_KIND.mid].SCT, DRAWN_COVERAGE[CLOUD_KIND.cirrus].BKN],
    );
    // The reported amount is kept for the page; the shader gets the drawn one.
    near(layers[0]!.coverage, 1.5 / 8);
    const u = sceneUniforms(sceneFrom(P('METAR VHHH 260630Z 26008KT 9999 FEW020 OVC100 31/22 Q1009'), { lat: 22.3, lon: 113.9 }, null));
    near((u.uLayers as number[])[2]!, DRAWN_COVERAGE[CLOUD_KIND.cumulus].FEW);
    near((u.uLayers as number[])[6]!, 1);
  });

  test('more than four layers: the lowest four are drawn, the rest counted', () => {
    const { layers, dropped } = layersFrom(P('METAR CYVR 260500Z 21007KT 6SM -SHRA FEW011 FEW027 SCT042 BKN057 OVC068 12/12 A3001'));
    assert.equal(layers.length, MAX_LAYERS);
    assert.equal(dropped, 1);
    near(layers[3]!.baseM, 5700 * FT);
  });

  test('unmeasured base uses an assumed height and says so', () => {
    const { layers } = layersFrom(P('METAR EGXX 010650Z AUTO 24010KT 9999 BKN/// 10/08 Q1010'));
    assert.equal(layers[0]!.baseAssumed, true);
    near(layers[0]!.baseM, 5000 * FT);
  });

  test('CAVOK, NCD and VV give no cloud layers', () => {
    assert.equal(layersFrom(P('METAR LSZH 260650Z 30004KT CAVOK 09/07 Q1023')).layers.length, 0);
    assert.equal(layersFrom(P('METAR EGLL 260650Z AUTO VRB02KT 9999 NCD 12/10 Q1023')).layers.length, 0);
    assert.equal(layersFrom(P('METAR KSFO 260556Z 00000KT 1/4SM FG VV002 12/12 A2996')).layers.length, 0);
  });
});

describe('wind → drift', () => {
  test('27015KT (from the west) drifts clouds toward the east at 15 kt', () => {
    const { drift, known } = driftFrom(P('METAR EGLL 010650Z 27015KT 9999 FEW030 12/10 Q1023'));
    near(drift[0], 15 * 0.514444, 1e-5);
    near(drift[1], 0, 1e-5);
    assert.equal(known, true);
  });

  test('36010KT (from the north) drifts south', () => {
    const { drift } = driftFrom(P('METAR EGLL 010650Z 36010KT 9999 FEW030 12/10 Q1023'));
    near(drift[0], 0, 1e-5);
    near(drift[1], -10 * 0.514444, 1e-5);
  });

  test('calm and missing wind hold the clouds still', () => {
    assert.deepEqual(driftFrom(P('METAR MMMX 260546Z 00000KT 10SM BKN020 18/11 A3035')).drift, [0, 0]);
    assert.deepEqual(driftFrom(P('METAR EGXX 010650Z AUTO /////KT 9999 FEW030 12/10 Q1010')).drift, [0, 0]);
  });

  test('VRB uses the middle of a reported sector, flagged as not known', () => {
    const m = P('METAR EGLL 010650Z VRB04KT 300V060 9999 FEW030 12/10 Q1023');
    const { drift, known } = driftFrom(m);
    assert.equal(known, false);
    // Sector 300°→060° has middle 000°: from the north, so drift is southward.
    near(drift[0], 0, 1e-5);
    assert.ok(drift[1] < 0);
  });

  test('MPS is converted: 21003MPS', () => {
    const { drift } = driftFrom(P('METAR ZBAA 260630Z 21003MPS 120V270 CAVOK 27/17 Q1009'));
    near(Math.hypot(drift[0], drift[1]), 3 * 1.943844 * 0.514444, 1e-4);
  });

  test('gustiness is the gust excess as a fraction of the mean, capped at 1', () => {
    near(driftFrom(P('METAR KJFK 260651Z 02027G44KT 5SM -RA OVC070 14/11 A2983')).gustiness, 17 / 27);
    assert.equal(driftFrom(P('METAR ZBAA 260530Z VRB02G10MPS CAVOK 26/16 Q1009')).gustiness, 1);
  });
});

describe('visibility → haze and fog', () => {
  test('Koschmieder: 4500 m gives β = 3.912 / 4500', () => {
    const h = hazeFrom(P('METAR WSSS 260630Z 19008KT 4500 HZ FEW018 34/23 Q1009'));
    near(h.hazeBeta, KOSCHMIEDER / 4500);
    assert.equal(h.hazeVisibilityM, 4500);
    assert.deepEqual(h.hazeTint, [1.0, 0.93, 0.8]);
  });

  test('"10 km or more" is drawn at the documented multiple', () => {
    const h = hazeFrom(P('METAR EGLL 260650Z AUTO VRB02KT 9999 NCD 12/10 Q1023'));
    assert.equal(h.hazeVisibilityM, 10000 * OR_MORE_FACTOR);
  });

  test('lower visibility means denser haze', () => {
    const a = hazeFrom(P('METAR LFPG 260630Z 28004KT 2000 BR OVC002 15/14 Q1020')).hazeBeta;
    const b = hazeFrom(P('METAR LFPG 260630Z 28004KT 8000 OVC002 15/14 Q1020')).hazeBeta;
    assert.ok(a > b);
  });

  test('VV: the fog is deep enough to hide the sky (β·H ≥ 4.5)', () => {
    const h = hazeFrom(P('METAR KSFO 260556Z 00000KT 1/4SM FG VV002 12/12 A2996'));
    assert.equal(h.obscured, true);
    assert.ok(h.hazeBeta * h.hazeHeightM >= 4.5 - 1e-9);
    assert.ok(h.hazeHeightM >= 200 * FT);
  });

  test('shallow fog (MIFG) stays near the ground', () => {
    const h = hazeFrom(P('METAR EGXX 010650Z 00000KT 0800 MIFG SKC 05/05 Q1020'));
    assert.equal(h.hazeHeightM, 40);
    assert.equal(h.obscured, false);
  });

  test('missing visibility falls back to a clear-day haze', () => {
    const h = hazeFrom(P('METAR EGXX 010650Z AUTO 24010KT //// FEW030 10/08 Q1010'));
    assert.equal(h.hazeVisibilityM, 10000 * OR_MORE_FACTOR);
  });
});

describe('precipitation', () => {
  test('rain intensity from the - / (none) / + prefix', () => {
    assert.deepEqual(precipFrom(P('METAR KJFK 260651Z 02027KT 5SM -RA OVC070 14/11 A2983')), { kind: 1, intensity: 0.35 });
    assert.deepEqual(precipFrom(P('METAR VTBS 260500Z 22010KT 5000 RA BKN020 26/25 Q1008')), { kind: 1, intensity: 0.65 });
    assert.deepEqual(precipFrom(P('SPECI YSSY 260653Z AUTO 33025G46KT 6000 +SHRA SCT057 27/09 Q1020')), { kind: 1, intensity: 1 });
  });
  test('snow is kind 2; drizzle is lighter; vicinity is ignored', () => {
    assert.equal(precipFrom(P('METAR KDEN 010651Z 36010KT 3/4SM -SN BR OVC005 M02/M03 A3001')).kind, 2);
    assert.equal(precipFrom(P('METAR ESSA 260650Z 17008KT 9999 DZ BKN005 11/10 Q1008')).intensity, 0.325);
    assert.deepEqual(precipFrom(P('METAR KMIA 010653Z 34005KT 10SM VCSH FEW025 25/22 A2989')), { kind: 0, intensity: 0 });
  });
});

describe('time and sun', () => {
  test('upstream observation time wins', () => {
    const m = P('METAR EGLL 260650Z AUTO VRB02KT 9999 NCD 12/10 Q1023');
    assert.equal(observationDate(m, Date.UTC(2026, 8, 26, 7), 1790405400)?.toISOString(), '2026-09-26T06:50:00.000Z');
  });
  test('day/hour/minute resolve to the latest matching date', () => {
    const m = P('METAR EGLL 302350Z AUTO VRB02KT 9999 NCD 12/10 Q1023');
    // Now is 1 October: the 30th at 23:50 is last September.
    assert.equal(observationDate(m, Date.UTC(2026, 9, 1, 0, 10))?.toISOString(), '2026-09-30T23:50:00.000Z');
    // The 31st does not exist in September, so it resolves to 31 August.
    const n = P('METAR EGLL 311200Z AUTO VRB02KT 9999 NCD 12/10 Q1023');
    assert.equal(observationDate(n, Date.UTC(2026, 9, 1, 0, 10))?.toISOString(), '2026-08-31T12:00:00.000Z');
  });

  test('Heathrow just after sunrise on 26 Sep 2026: sun low in the east', () => {
    const sun = sunFrom({ lat: 51.477, lon: -0.461 }, new Date('2026-09-26T06:50:00Z'));
    assert.equal(sun.known, true);
    assert.ok(sun.elevationDeg > 7 && sun.elevationDeg < 9, String(sun.elevationDeg));
    assert.ok(sun.azimuthDeg > 100 && sun.azimuthDeg < 104);
    assert.ok(sun.dir[0] > 0.9); // east is +x
  });

  test('unknown station → neutral daylight, flagged', () => {
    const sun = sunFrom({ lat: null, lon: null }, new Date('2026-09-26T06:50:00Z'));
    assert.equal(sun.known, false);
    assert.equal(sun.elevationDeg, 50);
    assert.equal(sceneUniforms(sceneFrom(P('METAR ZZZZ 260650Z 27010KT 9999 FEW030 12/10 Q1023'), { lat: null, lon: null }, null)).uSunKnown, 0);
  });

  test('view faces a low sun, and turns its back on a high one', () => {
    const low = viewFor({ known: true, elevationDeg: 8, azimuthDeg: 102, dir: [0, 0, 0] });
    assert.equal(low.heading, 77);
    const dusk = viewFor({ known: true, elevationDeg: -5, azimuthDeg: 10, dir: [0, 0, 0] });
    assert.equal(dusk.heading, 345);
    const high = viewFor({ known: true, elevationDeg: 44, azimuthDeg: 350, dir: [0, 0, 0] });
    assert.equal(high.heading, 150);
    assert.equal(viewFor({ known: false, elevationDeg: 50, azimuthDeg: 180, dir: [0, 0, 0] }).heading, 0);
  });

  test('exposure opens up monotonically from day to night, continuously', () => {
    assert.equal(exposureFor(30), DAY_EXPOSURE);
    near(exposureFor(-20), DAY_EXPOSURE * NIGHT_EXPOSURE);
    let prev = exposureFor(20);
    for (let e = 20; e >= -20; e -= 0.25) {
      const x = exposureFor(e);
      assert.ok(x >= prev - 1e-12, `not monotonic at ${e}`);
      assert.ok(x / prev < 1.2, `jump at ${e}`);
      prev = x;
    }
  });
});

describe('uniforms', () => {
  const shader = readFileSync(new URL('../../src/shaders/sky.frag', import.meta.url), 'utf8');
  const declared = new Set([...shader.matchAll(/^uniform\s+\w+\s+(\w+)/gm)].map((m) => m[1]!));

  test('every scene uniform is declared in the shader', () => {
    const u = sceneUniforms(sceneFrom(P('METAR EGLL 260650Z AUTO VRB02KT 9999 NCD 12/10 Q1023'), { lat: 51.477, lon: -0.461 }, new Date('2026-09-26T06:50:00Z')));
    for (const name of Object.keys(u)) assert.ok(declared.has(name), `${name} not declared in sky.frag`);
  });

  test('the sky ambient is computed once per scene, not per pixel', () => {
    const u = sceneUniforms(sceneFrom(P('METAR VHHH 260630Z 26008KT 9999 FEW020 31/22 Q1009'), { lat: 22.309, lon: 113.922 }, new Date('2026-09-26T06:30:00Z')));
    const a = u.uSkyAmbient as number[];
    assert.equal(a.length, 3);
    assert.ok(a[2]! > a[0]!, 'daylight ambient is bluish');
    assert.ok(!/skyAmbient\s*\(/.test(shader), 'the shader no longer evaluates skyAmbient() itself');
  });

  test('layer arrays are always 4 wide, with -1 marking empty slots', () => {
    const u = sceneUniforms(sceneFrom(P('METAR RJTT 260630Z 02011KT 9999 -SHRA FEW008 BKN010 20/18 Q1012'), { lat: 35.553, lon: 139.781 }, new Date('2026-09-26T06:30:00Z')));
    assert.equal(u.uLayerCount, 2);
    assert.equal((u.uLayers as number[]).length, 16);
    assert.equal((u.uLayers as number[])[11], -1);
    assert.equal((u.uLayers as number[])[3], 0); // first layer → METAR layer 0
    assert.deepEqual(u.uPrecip, [1, 0.35]);
  });

  test('a full report maps without NaN anywhere', () => {
    const fixture = JSON.parse(readFileSync(new URL('../fixtures/awc-metars-2026-09-26.json', import.meta.url), 'utf8')) as {
      reports: Array<{ rawOb: string; obsTime: number }>;
    };
    for (const r of fixture.reports) {
      const m = parseMetar(r.rawOb);
      const u = sceneUniforms(sceneFrom(m, { lat: 40, lon: -3 }, new Date(r.obsTime * 1000)));
      for (const [k, v] of Object.entries(u)) {
        for (const x of Array.isArray(v) ? v : [v]) assert.ok(Number.isFinite(x), `${r.rawOb}: ${k}`);
      }
    }
  });

  test('camera basis is orthonormal; heading 90 looks east', () => {
    const b = cameraBasis(90, 15);
    const r = b.slice(0, 3);
    const u = b.slice(3, 6);
    const f = b.slice(6, 9);
    const dot = (a: number[], c: number[]) => a[0]! * c[0]! + a[1]! * c[1]! + a[2]! * c[2]!;
    near(dot(r, u), 0, 1e-12);
    near(dot(r, f), 0, 1e-12);
    near(dot(u, f), 0, 1e-12);
    near(dot(f, f), 1, 1e-12);
    assert.ok(f[0]! > 0.9);
    assert.ok(u[1]! > 0.9); // up is mostly up
    assert.ok(r[2]! < -0.9); // facing east, right-hand side is south
  });
});
