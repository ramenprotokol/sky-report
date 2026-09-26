import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { solarPosition, solarCoordinates, refractionDeg, sunVector, julianDay } from '../../src/sun/solar.ts';

/**
 * Independent references from astropy 8.0.1 (IAU SOFA/ERFA), airless apparent altitude and azimuth.
 * Regenerate with: uv run --with astropy tools/sun-reference.py
 */
const ASTROPY = [
  { label: "EGLL sunrise-ish", iso: '2026-09-26T06:50:00Z', lat: 51.477, lon: -0.461, alt: 7.7672, az: 101.976 },
  { label: "KSFO night", iso: '2026-09-26T05:56:00Z', lat: 37.6196, lon: -122.3656, alt: -43.6843, az: 314.23 },
  { label: "RJTT afternoon", iso: '2026-09-26T06:30:00Z', lat: 35.553, lon: 139.781, alt: 23.6249, az: 249.976 },
  { label: "WSSS near noon", iso: '2026-09-26T04:30:00Z', lat: 1.368, lon: 103.982, alt: 83.1109, az: 112.2097 },
  { label: "YSSY late afternoon", iso: '2026-09-26T06:53:00Z', lat: -33.946, lon: 151.173, alt: 11.8294, az: 276.5201 },
  { label: "NZAA dusk", iso: '2026-09-26T06:30:00Z', lat: -37.008, lon: 174.792, alt: -2.7796, az: 266.3084 },
  { label: "KDEN night", iso: '2026-09-26T06:53:00Z', lat: 39.8466, lon: -104.6562, alt: -51.4267, az: 1.1922 },
  { label: "BIKF summer midnight", iso: '2026-06-21T00:00:00Z', lat: 63.987, lon: -22.614, alt: -0.7377, az: 338.9534 },
  { label: "PANC winter noon", iso: '2026-12-21T21:40:00Z', lat: 61.1691, lon: -150.0277, alt: 5.3092, az: 175.7674 },
  { label: "FAOR equinox morning", iso: '2026-03-20T06:00:00Z', lat: -26.139, lon: 28.246, alt: 23.5653, az: 77.8186 },
  { label: "EGLL 2000 J2000 epoch", iso: '2000-01-01T12:00:00Z', lat: 51.477, lon: -0.461, alt: 15.4797, az: 178.7768 },
  { label: "SCEL 2031 winter", iso: '2031-07-15T15:00:00Z', lat: -33.393, lon: -70.786, alt: 29.2663, az: 29.28 },
];

function angleDiff(a: number, b: number): number {
  const d = (((a - b) % 360) + 540) % 360 - 180;
  return Math.abs(d);
}

describe('NOAA solar position vs astropy (independent method)', () => {
  for (const r of ASTROPY) {
    test(`${r.label}: within 0.03° elevation and 0.1° azimuth`, () => {
      const p = solarPosition(new Date(r.iso), r.lat, r.lon);
      assert.ok(Math.abs(p.trueElevationDeg - r.alt) < 0.03, `elevation ${p.trueElevationDeg} vs ${r.alt}`);
      const azTol = r.alt > 80 ? 0.5 : 0.1; // azimuth is ill-conditioned near the zenith
      assert.ok(angleDiff(p.azimuthDeg, r.az) < azTol, `azimuth ${p.azimuthDeg} vs ${r.az}`);
    });
  }
});

describe('Meeus, Astronomical Algorithms (2nd ed.), worked examples', () => {
  // Example 25.a: 1992 October 13.0 TD, JDE 2448908.5.
  // Apparent right ascension 13h13m31.4s = 198.38083°, declination −7°47'06" = −7.78507°.
  const s = solarCoordinates(2448908.5);
  test('Example 25.a: declination −7.78507°', () => {
    assert.ok(Math.abs(s.dec - -7.78507) < 0.0005, String(s.dec));
  });
  test('Example 25.a: right ascension 198.38083°', () => {
    assert.ok(Math.abs(s.ra - 198.38083) < 0.0005, String(s.ra));
  });
  test('Example 25.a: mean longitude 201.80720°, mean anomaly 278.99397°, eccentricity 0.016711668', () => {
    assert.ok(Math.abs(s.e - 0.016711668) < 1e-9, String(s.e));
    assert.ok(Math.abs(s.L0 - 201.8072) < 0.0001, String(s.L0));
    assert.ok(Math.abs((((s.M % 360) + 360) % 360) - 278.99397) < 0.0001, String(s.M));
  });
  test('Example 28.b: equation of time on 1992 Oct 13 is +13 min 42.7 s', () => {
    assert.ok(Math.abs(s.eqTime - (13 + 42.7 / 60)) < 0.02, String(s.eqTime));
  });
});

describe('sanity checks', () => {
  test('Julian Day of the J2000.0 epoch', () => {
    assert.equal(julianDay(new Date('2000-01-01T12:00:00Z')), 2451545);
  });

  test('declination is near +23.44° at the June solstice and −23.44° at the December solstice', () => {
    assert.ok(Math.abs(solarPosition(new Date('2026-06-21T08:24:00Z'), 0, 0).declinationDeg - 23.44) < 0.01);
    assert.ok(Math.abs(solarPosition(new Date('2026-12-21T20:50:00Z'), 0, 0).declinationDeg + 23.44) < 0.01);
  });

  test('refraction lifts the sun about 0.48° at the horizon and nothing overhead', () => {
    assert.ok(Math.abs(refractionDeg(0) - 1735 / 3600) < 1e-9);
    assert.equal(refractionDeg(89), 0);
    assert.ok(refractionDeg(10) > 0.08 && refractionDeg(10) < 0.1);
  });

  test('elevation includes refraction; trueElevation does not', () => {
    const p = solarPosition(new Date('2026-09-26T06:50:00Z'), 51.477, -0.461);
    assert.ok(Math.abs(p.elevationDeg - p.trueElevationDeg - refractionDeg(p.trueElevationDeg)) < 1e-12);
  });

  test('the sun is due south-ish at London solar noon and north of the zenith in Sydney', () => {
    const london = solarPosition(new Date('2026-09-26T11:53:00Z'), 51.477, -0.461);
    assert.ok(angleDiff(london.azimuthDeg, 180) < 2, String(london.azimuthDeg));
    const sydney = solarPosition(new Date('2026-09-26T01:52:00Z'), -33.946, 151.173);
    assert.ok(angleDiff(sydney.azimuthDeg, 0) < 3, String(sydney.azimuthDeg));
  });

  test('sunVector: unit length, east is +x, north is +z, up is +y', () => {
    const v = sunVector(30, 90);
    assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-12);
    assert.ok(v[0] > 0.86 && Math.abs(v[2]) < 1e-12);
    assert.ok(Math.abs(v[1] - 0.5) < 1e-12);
    const n = sunVector(0, 0);
    assert.ok(Math.abs(n[2] - 1) < 1e-12);
  });
});
