import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, labelLines, traceLines, tokenExplanation, focusFor, formatLatLon, shortName, formatObs } from '../../src/app/report.ts';
import { toSource } from '../../src/app/api.ts';
import { SAMPLES } from '../../src/app/samples.ts';
import { parseMetar } from '../../src/metar/parse.ts';
import { FOCUS } from '../../src/scene/mapping.ts';

const NOW = Date.UTC(2026, 8, 26, 8, 0);
const sample = (id: string) => {
  const s = SAMPLES.find((x) => x.id === id);
  assert.ok(s, id);
  return s;
};

describe('chart label', () => {
  test('degrees and decimal minutes', () => {
    assert.equal(formatLatLon(51.477, -0.461), '51°28.6′N 000°27.7′W');
    assert.equal(formatLatLon(-33.946, 151.173), '33°56.8′S 151°10.4′E');
    assert.equal(formatLatLon(0.99999, 0), '01°00.0′N 000°00.0′E');
  });

  test('station name is shortened to the airport part', () => {
    assert.equal(shortName('London/Heathrow Intl, EN, GB'), 'LONDON/HEATHROW INTL');
    assert.equal(shortName(null), null);
  });

  test('observation time in aviation style', () => {
    assert.equal(formatObs(new Date('2026-09-26T06:50:00Z')), '26 SEP 2026 0650Z');
  });

  test('a recorded sample says so, with position, elevation and the sun', () => {
    const L = labelLines(buildReport(sample('EGLL'), 'sample', NOW));
    assert.equal(L.ident, 'EGLL');
    assert.equal(L.name, 'LONDON/HEATHROW INTL');
    assert.equal(L.position, '51°28.6′N 000°27.7′W · ELEV 85 FT');
    assert.equal(L.observed, 'OBS 26 SEP 2026 0650Z · RECORDED SAMPLE');
    assert.match(L.sun, /^SUN 7\.\d° · BRG 102° · VIEW 077°$/);
  });

  test('live and pasted origins are labelled; night sun says below horizon', () => {
    const live = labelLines(buildReport(sample('KSFO'), 'live', NOW));
    assert.match(live.observed, /· LIVE$/);
    assert.match(live.sun, /^SUN −43\.\d° BELOW HORIZON/);
    const pasted = buildReport({ id: 'ZZZZ', raw: 'METAR ZZZZ 260650Z 27010KT 9999 FEW030 12/10 Q1023', obsTime: null, station: null }, 'pasted', NOW);
    const P = labelLines(pasted);
    assert.match(P.observed, /OBS 26 SEP 2026 0650Z · PASTED REPORT/);
    assert.equal(P.position, 'POSITION UNKNOWN');
    assert.match(P.sun, /NEUTRAL DAYLIGHT, NO SUN DRAWN/);
  });
});

describe('trace lines ("How this is drawn")', () => {
  test('every drawn element names its source', () => {
    const lines = traceLines(buildReport(sample('RJTT'), 'sample', NOW));
    assert.match(lines[0]!, /^Cloud layer 1 \(FEW008\): 1\.5\/8 of the sky from 800 ft/);
    assert.match(lines[1]!, /^Cloud layer 2 \(BKN010\): 6\/8 of the sky from 1,000 ft/);
    assert.ok(lines.some((l) => /^Haze: the report says 10 km or more, so it is drawn for 3× that, 30 km/.test(l)));
    assert.ok(lines.some((l) => /^Drift: clouds move toward south-southwest at 5\.7 m\/s, in real time/.test(l)));
    assert.ok(lines.some((l) => /^Precipitation: rain streaks at 35% strength/.test(l)));
    assert.ok(lines.some((l) => /^Sun: 23\.\d° above the horizon .* NOAA solar position equations for 35\.553, 139\.781/.test(l)));
  });

  test('CAVOK, calm and unknown position are explained too', () => {
    const lines = traceLines(buildReport({ id: 'ZZZZ', raw: 'METAR ZZZZ 260650Z 00000KT CAVOK 12/10 Q1023', obsTime: null, station: null }, 'pasted', NOW));
    assert.ok(lines.includes('No clouds drawn (CAVOK).'));
    assert.ok(lines.includes('Calm: the clouds hold still.'));
    assert.ok(lines.some((l) => /no sun disc is drawn/.test(l)));
  });

  test('a night sun is described as below the horizon, not "−41.6° above"', () => {
    const lines = traceLines(buildReport(sample('KJFK'), 'sample', NOW));
    const sun = lines.find((l) => l.startsWith('Sun:'))!;
    assert.match(sun, /^Sun: 41\.\d° below the horizon at bearing \d+°/);
    assert.ok(!/−/.test(sun));
  });

  test('a layer squeezed under the next one says it is too close to draw separately', () => {
    const r = buildReport({ id: 'EGXX', raw: 'METAR EGXX 260650Z 24010KT 9999 FEW004 BKN005 12/10 Q1010', obsTime: null, station: null }, 'pasted', NOW);
    assert.equal(r.scene.layers[0]!.squeezed, true);
    const lines = traceLines(r);
    assert.match(lines[0]!, /^Cloud layer 1 \(FEW004\): 1\.5\/8 of the sky from 400 ft\. It is too close under the next layer to draw separately \(the next base is only 100 ft higher\): squeezed to \d+ m, it is barely visible\.$/);
    assert.ok(!/drawn as/.test(lines[0]!));
    assert.match(lines[1]!, /^Cloud layer 2 \(BKN005\): .* drawn as/);
    const tok = r.metar.tokens.find((t) => t.text === 'FEW004')!;
    assert.match(tokenExplanation(r, tok), /too close under the next layer to draw separately$/);
    assert.doesNotMatch(tokenExplanation(r, tok), /drawn as cloud layer/);
  });

  test('dropped layers are admitted', () => {
    const lines = traceLines(
      buildReport({ id: 'CYVR', raw: 'METAR CYVR 260500Z 21007KT 6SM -SHRA FEW011 FEW027 SCT042 BKN057 OVC068 12/12 A3001', obsTime: null, station: null }, 'pasted', NOW),
    );
    assert.ok(lines.some((l) => /1 higher layer is reported but not drawn/.test(l)));
  });
});

describe('token explanations and highlights', () => {
  test('station token names the airport; layer beyond four says not drawn', () => {
    const r = buildReport(sample('EGLL'), 'sample', NOW);
    const st = r.metar.tokens.find((t) => t.kind === 'station')!;
    assert.equal(tokenExplanation(r, st), 'station EGLL — London/Heathrow Intl; its position sets the sun');
    const r5 = buildReport({ id: 'CYVR', raw: 'METAR CYVR 260500Z 21007KT 6SM FEW011 FEW027 SCT042 BKN057 OVC068 12/12 A3001', obsTime: null, station: null }, 'pasted', NOW);
    const fifth = r5.metar.tokens.find((t) => t.text === 'OVC068')!;
    assert.match(tokenExplanation(r5, fifth), /not drawn \(only the lowest four layers are drawn\)$/);
  });

  test('each kind of token asks for the matching highlight', () => {
    const m = parseMetar('METAR KSFO 260556Z 27012KT 1/4SM -RA FG VV002 FEW009 12/12 A2996');
    const f = (text: string) => focusFor(m.tokens.find((t) => t.text === text)!);
    assert.deepEqual(f('KSFO'), [FOCUS.sun, 0]);
    assert.deepEqual(f('260556Z'), [FOCUS.sun, 0]);
    assert.deepEqual(f('27012KT'), [FOCUS.drift, 0]);
    assert.deepEqual(f('1/4SM'), [FOCUS.haze, 0]);
    assert.deepEqual(f('-RA'), [FOCUS.precip, 0]);
    assert.deepEqual(f('VV002'), [FOCUS.fog, 0]);
    assert.deepEqual(f('FEW009'), [FOCUS.layer, 0]);
    assert.deepEqual(f('A2996'), [FOCUS.none, 0]);
  });
});

describe('bundled samples', () => {
  test('every sample parses cleanly and has a known position', () => {
    assert.ok(SAMPLES.length >= 8);
    for (const s of SAMPLES) {
      const r = buildReport(s, 'sample', NOW);
      assert.equal(r.metar.ok, true, s.id);
      assert.deepEqual(r.metar.unparsed, [], s.id);
      assert.equal(r.metar.station, s.id);
      assert.equal(r.scene.sun.known, true, s.id);
    }
  });

  test('samples cover day, twilight and night', () => {
    const elevs = SAMPLES.map((s) => buildReport(s, 'sample', NOW).scene.sun.elevationDeg);
    assert.ok(elevs.some((e) => e > 20));
    assert.ok(elevs.some((e) => e < 0 && e > -12));
    assert.ok(elevs.some((e) => e < -18));
  });
});

describe('API response validation (client side)', () => {
  test('accepts the Worker shape and caps strings', () => {
    const s = toSource({ id: 'EGLL', raw: 'METAR EGLL …', obsTime: 1, station: { name: 'x'.repeat(500), lat: 51.4, lon: -0.4, elevM: 26 } });
    assert.equal(s?.station?.name?.length, 120);
    assert.equal(s?.obsTime, 1);
  });
  test('rejects junk', () => {
    for (const bad of [null, 'text', 42, {}, { id: 1, raw: 'x' }, { id: 'EGLL' }]) assert.equal(toSource(bad), null);
  });
  test('non-numeric coordinates become null', () => {
    const s = toSource({ id: 'EGLL', raw: 'M', obsTime: 'soon', station: { lat: '51', lon: null } });
    assert.deepEqual([s?.obsTime, s?.station?.lat, s?.station?.lon], [null, null, null]);
  });
});
