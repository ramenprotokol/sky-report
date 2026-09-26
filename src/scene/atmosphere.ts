/**
 * The sky's diffuse light, computed once per scene on the CPU and handed to the shader as the
 * uniform `uSkyAmbient`. It depends only on the sun direction, so evaluating it per pixel (as
 * the shader first did: three 6-sample sky integrals for every pixel) was wasted work.
 *
 * This is a line-by-line port of `shell`, `altAt`, `columnOD`, `transmittance` and `skyScatter`
 * in src/shaders/sky.frag, with the same constants (a unit test checks they match).
 */

export type Vec3 = [number, number, number];

export const R_EARTH = 6371000;
export const ATMOSPHERE = 100000;
export const EYE = 25;
export const BETA_R: Vec3 = [5.802e-6, 13.558e-6, 33.1e-6];
export const BETA_M_S = 3.996e-6;
export const BETA_M_E = 4.4e-6;
export const H_R = 8000;
export const H_M = 1200;
export const OZONE: Vec3 = [0.016, 0.027, 0.0008];
export const SUN_E = 20;
export const NIGHT_SKY: Vec3 = [0.00016, 0.00026, 0.00056];

function miePhase(c: number): number {
  const g = 0.76;
  const g2 = g * g;
  return ((3 / (8 * Math.PI)) * ((1 - g2) * (1 + c * c))) / ((2 + g2) * Math.pow(1 + g2 - 2 * g * c, 1.5));
}

function altAt(h0: number, mu: number, t: number): number {
  const x = h0 * (2 * R_EARTH + h0) + 2 * (R_EARTH + h0) * mu * t + t * t;
  const h = x / (2 * R_EARTH);
  return x / (2 * R_EARTH + h);
}

function shell(h0: number, mu: number, hs: number): [number, number] {
  const b = (R_EARTH + h0) * mu;
  const c = (h0 - hs) * (2 * R_EARTH + h0 + hs);
  const disc = b * b - c;
  if (disc < 0) return [-1, -1];
  const q = -b - (b >= 0 ? 1 : -1) * Math.sqrt(disc);
  const t2 = Math.abs(q) > 1e-6 ? c / q : 0;
  return [Math.min(q, t2), Math.max(q, t2)];
}

function columnOD(h: number, mu: number, H: number): number {
  const r = R_EARTH + h;
  const ch0 = Math.sqrt((0.5 * Math.PI * r) / H);
  if (mu >= 0) return (H * Math.exp(-h / H)) / (mu + 1 / ch0);
  const ht = r * Math.sqrt(Math.max(0, 1 - mu * mu)) - R_EARTH;
  if (ht <= 0) return 1e7;
  const chT = Math.sqrt((0.5 * Math.PI * (R_EARTH + ht)) / H);
  return 2 * H * Math.exp(-ht / H) * chT - (H * Math.exp(-h / H)) / (-mu + 1 / ch0);
}

export function transmittance(h: number, mu: number): Vec3 {
  const r = R_EARTH + h;
  const ro = R_EARTH + 25000;
  const ozoneAirmass = 1 / Math.sqrt(Math.max(2e-3, 1 - ((r * r) / (ro * ro)) * (1 - mu * mu)));
  const odR = columnOD(h, mu, H_R);
  const odM = columnOD(h, mu, H_M);
  return [0, 1, 2].map((i) => Math.exp(-(BETA_R[i]! * odR + BETA_M_E * odM + OZONE[i]! * ozoneAirmass))) as Vec3;
}

function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Single scattering along a view ray from the eye (same as skyScatter in sky.frag). */
export function skyScatter(rd: Vec3, sunDir: Vec3, steps: number, jitter = 0.5): Vec3 {
  const mu = rd[1];
  const g = shell(EYE, mu, 0);
  const tMax = mu < 0 && g[0] > 0 ? g[0] : shell(EYE, mu, ATMOSPHERE)[1];
  const cosT = dot(rd, sunDir);
  const pR = (3 / (16 * Math.PI)) * (1 + cosT * cosT);
  const pM = miePhase(cosT);
  const sum: Vec3 = [0, 0, 0];
  const odView: Vec3 = [0, 0, 0];
  for (let i = 0; i < steps; i++) {
    const f0 = i / steps;
    const f1 = (i + 1) / steps;
    const t0 = tMax * f0 * f0;
    const t1 = tMax * f1 * f1;
    const dt = t1 - t0;
    const t = t0 + (t1 - t0) * jitter;
    const h = Math.max(0, altAt(EYE, mu, t));
    const up = normalize([rd[0] * t, R_EARTH + EYE + rd[1] * t, rd[2] * t]);
    const dR = Math.exp(-h / H_R);
    const dM = Math.exp(-h / H_M);
    const ts = transmittance(h, dot(up, sunDir));
    for (let c = 0; c < 3; c++) {
      const ext = BETA_R[c]! * dR + BETA_M_E * dM;
      const tv = Math.exp(-(odView[c]! + ext * (t - t0)));
      sum[c] = sum[c]! + tv * ts[c]! * (BETA_R[c]! * dR * pR + BETA_M_S * dM * pM) * dt;
      odView[c] = odView[c]! + ext * dt;
    }
  }
  // A small isotropic term stands in for multiple scattering.
  const t3 = transmittance(3000, sunDir[1]);
  return [0, 1, 2].map((c) => sum[c]! * SUN_E + SUN_E * (BETA_R[c]! * H_R) * 0.018 * t3[c]! * (1 - Math.exp(-odView[c]!))) as Vec3;
}

/**
 * Diffuse light a cloud or the ground receives from the open sky: a cheap average of the zenith
 * and two directions 24° up, toward and away from the sun, plus airglow.
 */
export function skyAmbient(sunDir: Vec3): Vec3 {
  const side = normalize([sunDir[0] + 1e-4, 0, sunDir[2]]);
  const a = skyScatter([0, 1, 0], sunDir, 6);
  const b = skyScatter(normalize([side[0], 0.45, side[2]]), sunDir, 6);
  const c = skyScatter(normalize([-side[0], 0.45, -side[2]]), sunDir, 6);
  return [0, 1, 2].map((i) => a[i]! * 0.5 + b[i]! * 0.25 + c[i]! * 0.25 + NIGHT_SKY[i]! * 0.6) as Vec3;
}
