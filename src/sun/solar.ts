/**
 * Solar position, following NOAA's "General Solar Position Calculations" as used in the
 * NOAA Global Monitoring Laboratory solar calculator spreadsheets. Those equations come from
 * Jean Meeus, "Astronomical Algorithms" (low-accuracy solar coordinates, chapter 25, and the
 * equation of time, chapter 28). NOAA states the result is accurate to about 0.0167° for
 * years between 1800 and 2100, before atmospheric refraction.
 *
 * Conventions: latitude north-positive, longitude east-positive, azimuth in degrees clockwise
 * from true north, elevation in degrees above the horizon.
 */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

export interface SolarPosition {
  /** Elevation above the horizon, with NOAA's approximate refraction correction applied. */
  elevationDeg: number;
  /** Geometric elevation (no refraction). */
  trueElevationDeg: number;
  /** Degrees clockwise from true north. */
  azimuthDeg: number;
  declinationDeg: number;
  rightAscensionDeg: number;
  /** Equation of time in minutes (apparent minus mean solar time). */
  equationOfTimeMin: number;
  julianDay: number;
}

export function julianDay(date: Date): number {
  return date.getTime() / 86400000 + 2440587.5;
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/** Sun coordinates for a Julian Day (UT). Exposed for testing against Meeus' worked example. */
export function solarCoordinates(jd: number) {
  const T = (jd - 2451545) / 36525; // Julian centuries since J2000.0
  const L0 = mod(280.46646 + T * (36000.76983 + T * 0.0003032), 360); // geometric mean longitude
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T); // mean anomaly
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T); // orbit eccentricity
  const C =
    Math.sin(M * RAD) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * T) +
    Math.sin(3 * M * RAD) * 0.000289; // equation of centre
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD); // apparent longitude
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD); // corrected obliquity
  const ra = mod(Math.atan2(Math.cos(eps * RAD) * Math.sin(appLong * RAD), Math.cos(appLong * RAD)) * DEG, 360);
  const dec = Math.asin(Math.sin(eps * RAD) * Math.sin(appLong * RAD)) * DEG;
  const y = Math.tan((eps / 2) * RAD) ** 2;
  const eqTime =
    4 *
    DEG *
    (y * Math.sin(2 * L0 * RAD) -
      2 * e * Math.sin(M * RAD) +
      4 * e * y * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD) -
      0.5 * y * y * Math.sin(4 * L0 * RAD) -
      1.25 * e * e * Math.sin(2 * M * RAD));
  return { T, L0, M, e, C, appLong, eps, ra, dec, eqTime };
}

/** NOAA's approximate atmospheric refraction, in degrees, for a geometric elevation in degrees. */
export function refractionDeg(elev: number): number {
  if (elev > 85) return 0;
  const te = Math.tan(elev * RAD);
  let arcsec: number;
  if (elev > 5) arcsec = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5;
  else if (elev > -0.575) arcsec = 1735 + elev * (-518.2 + elev * (103.4 + elev * (-12.79 + elev * 0.711)));
  else arcsec = -20.772 / te;
  return arcsec / 3600;
}

export function solarPosition(date: Date, latDeg: number, lonDeg: number): SolarPosition {
  const jd = julianDay(date);
  const s = solarCoordinates(jd);
  const minutesUtc = mod(date.getTime() / 60000, 1440);
  const trueSolarTime = mod(minutesUtc + s.eqTime + 4 * lonDeg, 1440);
  const hourAngle = trueSolarTime / 4 < 0 ? trueSolarTime / 4 + 180 : trueSolarTime / 4 - 180;

  const lat = latDeg * RAD;
  const dec = s.dec * RAD;
  const cosZen = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(hourAngle * RAD);
  const zenith = Math.acos(Math.min(1, Math.max(-1, cosZen))) * DEG;
  const trueElevation = 90 - zenith;

  let azimuth: number;
  const denom = Math.cos(lat) * Math.sin(zenith * RAD);
  if (Math.abs(denom) < 1e-12) {
    azimuth = latDeg > 0 ? 180 : 0; // sun at the zenith or observer at a pole
  } else {
    const a = Math.acos(Math.min(1, Math.max(-1, (Math.sin(lat) * Math.cos(zenith * RAD) - Math.sin(dec)) / denom))) * DEG;
    azimuth = hourAngle > 0 ? mod(a + 180, 360) : mod(540 - a, 360);
  }

  return {
    elevationDeg: trueElevation + refractionDeg(trueElevation),
    trueElevationDeg: trueElevation,
    azimuthDeg: azimuth,
    declinationDeg: s.dec,
    rightAscensionDeg: s.ra,
    equationOfTimeMin: s.eqTime,
    julianDay: jd,
  };
}

/** Unit vector toward the sun in the scene's frame: x = east, y = up, z = north. */
export function sunVector(elevationDeg: number, azimuthDeg: number): [number, number, number] {
  const el = elevationDeg * RAD;
  const az = azimuthDeg * RAD;
  return [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];
}
