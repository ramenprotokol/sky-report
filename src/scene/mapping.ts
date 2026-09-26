/**
 * METAR → scene. Every number the shader receives is decided here, in plain TypeScript,
 * so it can be tested and so each visual choice points back to a report field or to the
 * sun calculation. Artistic choices (layer thickness, cloud style, tints) are named
 * constants and are described in the page's "How this is drawn" note.
 */
import type { Metar, CloudLayer } from '../metar/parse.ts';
import { PRECIPITATION } from '../metar/parse.ts';
import { solarPosition, sunVector } from '../sun/solar.ts';
import { skyAmbient } from './atmosphere.ts';

export const FT = 0.3048;
export const MS_PER_KT = 0.514444;
/** Koschmieder: visibility is where contrast drops to 2%, so extinction β = −ln(0.02) / V ≈ 3.912 / V. */
export const KOSCHMIEDER = 3.912;
/** "10 km or more" style reports are drawn as this many times the floor. */
export const OR_MORE_FACTOR = 3;
/** Clouds drift at the reported surface wind times this factor (1 = real time). */
export const DRIFT_TIMELAPSE = 1;
/** Base assumed for a layer reported with an unmeasured base (BKN///). */
export const ASSUMED_BASE_FT = 5000;
export const MAX_LAYERS = 4;
/** Air kept between a layer's top and the next base, m. */
export const LAYER_GAP_M = 30;
/** A layer squeezed thinner than this reads as nothing on screen; it is flagged, not hidden. */
export const MIN_VISIBLE_THICKNESS_M = 120;

export const CLOUD_KIND = { cumulus: 0, stratiform: 1, mid: 2, cirrus: 3, towering: 4 } as const;
export type CloudKind = (typeof CLOUD_KIND)[keyof typeof CLOUD_KIND];

export const COVERAGE: Record<CloudLayer['cover'], number> = {
  // Middle of each okta range: FEW 1–2, SCT 3–4, BKN 5–7, OVC 8 eighths.
  FEW: 1.5 / 8,
  SCT: 3.5 / 8,
  BKN: 6 / 8,
  OVC: 1,
};

/**
 * The coverage value the shader thresholds its noise at, per cloud style, so that the layer seen
 * straight up from below covers the reported amount. One horizontal plane of the noise covers
 * exactly c (it is equalised per plane), but a thick layer shows the union of all its planes,
 * which covers more. These values were found by bisection with the below-view probe
 * (`npm run calibrate`, headless Chrome) and are checked by the smoke test, which requires the
 * measured cover to be within half an okta (±1/16 of the sky) of the target. OVC is always 1.
 */
export const DRAWN_COVERAGE: Record<CloudKind, { FEW: number; SCT: number; BKN: number }> = {
  0: { FEW: 0.15, SCT: 0.293, BKN: 0.537 }, // cumulus
  1: { FEW: 0.171, SCT: 0.358, BKN: 0.679 }, // stratiform
  2: { FEW: 0.163, SCT: 0.323, BKN: 0.598 }, // mid-level
  3: { FEW: 0.208, SCT: 0.394, BKN: 0.705 }, // cirrus
  4: { FEW: 0.118, SCT: 0.248, BKN: 0.462 }, // towering
};

export function drawnCoverage(kind: CloudKind, cover: CloudLayer['cover']): number {
  return cover === 'OVC' ? 1 : DRAWN_COVERAGE[kind][cover];
}

export interface LayerParams {
  baseM: number;
  thicknessM: number;
  /** Reported amount, as a fraction of the sky (the middle of the okta range). */
  coverage: number;
  /** What the shader is given so the drawn column covers `coverage` (see DRAWN_COVERAGE). */
  drawnCoverage: number;
  kind: CloudKind;
  /** Index of the METAR cloud layer this came from (for token highlighting). */
  metarIndex: number;
  baseAssumed: boolean;
  /**
   * Squeezed so thin under the next layer (below MIN_VISIBLE_THICKNESS_M) that it is not really
   * visible as a layer of its own. The trace and the token explanation say so.
   */
  squeezed: boolean;
}

export interface SunParams {
  known: boolean;
  elevationDeg: number;
  azimuthDeg: number;
  dir: [number, number, number];
}

export interface SceneParams {
  layers: LayerParams[];
  droppedLayers: number;
  /** Drift velocity of the clouds, m/s, [east, north] — the direction the air moves toward. */
  drift: [number, number];
  driftDirectionKnown: boolean;
  gustiness: number;
  /** Visibility the haze is drawn for, metres. */
  hazeVisibilityM: number;
  /** Extinction at ground level, 1/m. */
  hazeBeta: number;
  /** Exponential scale height of the haze or fog, metres. */
  hazeHeightM: number;
  hazeTint: [number, number, number];
  obscured: boolean;
  precipKind: 0 | 1 | 2;
  precipIntensity: number;
  sun: SunParams;
  viewHeadingDeg: number;
  viewPitchDeg: number;
  exposure: number;
}

function layerKind(l: CloudLayer, baseFt: number): CloudKind {
  if (l.convective) return CLOUD_KIND.towering;
  if (baseFt >= 20000) return CLOUD_KIND.cirrus;
  if (baseFt >= 6500) return CLOUD_KIND.mid;
  return l.cover === 'BKN' || l.cover === 'OVC' ? CLOUD_KIND.stratiform : CLOUD_KIND.cumulus;
}

/** Artistic: METARs report only the base, so thickness is a style choice per cloud kind. */
export function layerThicknessM(kind: CloudKind, convective: CloudLayer['convective'], baseM: number): number {
  switch (kind) {
    case CLOUD_KIND.towering:
      return convective === 'CB' ? 6000 : 3000;
    case CLOUD_KIND.cumulus:
      return Math.min(1500, Math.max(500, 0.5 * baseM + 400));
    case CLOUD_KIND.stratiform:
      return Math.min(900, Math.max(350, 0.4 * baseM + 250));
    case CLOUD_KIND.mid:
      return 600;
    default:
      return 900;
  }
}

export function layersFrom(metar: Metar): { layers: LayerParams[]; dropped: number } {
  const drawn = metar.clouds.slice(0, MAX_LAYERS);
  const layers: LayerParams[] = drawn.map((c, i) => {
    const baseFt = c.baseFt ?? ASSUMED_BASE_FT;
    const baseM = Math.max(30, baseFt * FT);
    const kind = layerKind(c, baseFt);
    return {
      baseM,
      thicknessM: layerThicknessM(kind, c.convective, baseM),
      coverage: COVERAGE[c.cover],
      drawnCoverage: drawnCoverage(kind, c.cover),
      kind,
      metarIndex: i,
      baseAssumed: c.baseFt === null,
      squeezed: false,
    };
  });
  layers.sort((a, b) => a.baseM - b.baseM);
  // Keep each layer's top below the next base so the shells never overlap.
  for (let i = 0; i < layers.length - 1; i++) {
    const a = layers[i]!;
    const b = layers[i + 1]!;
    const room = b.baseM - a.baseM - LAYER_GAP_M;
    if (a.thicknessM > room) {
      a.thicknessM = Math.max(20, room);
      a.squeezed = a.thicknessM < MIN_VISIBLE_THICKNESS_M;
    }
  }
  return { layers, dropped: Math.max(0, metar.clouds.length - MAX_LAYERS) };
}

export function driftFrom(metar: Metar): { drift: [number, number]; known: boolean; gustiness: number } {
  const w = metar.wind;
  if (!w || w.calm || w.speedKt <= 0) return { drift: [0, 0], known: w !== null, gustiness: 0 };
  let dir = w.directionDeg;
  let known = true;
  if (dir === null) {
    // Variable wind: use the middle of the reported sector, else an arbitrary westerly.
    if (w.rangeDeg) {
      const [a, b] = w.rangeDeg;
      const span = (b - a + 360) % 360;
      dir = (a + span / 2) % 360;
    } else {
      dir = 270;
    }
    known = false;
  }
  const speed = w.speedKt * MS_PER_KT * DRIFT_TIMELAPSE;
  const rad = (dir * Math.PI) / 180;
  // Wind direction is where the air comes FROM; it moves toward dir + 180°.
  const drift: [number, number] = [-Math.sin(rad) * speed, -Math.cos(rad) * speed];
  const gustiness = w.gustKt ? Math.min(1, Math.max(0, (w.gustKt - w.speedKt) / Math.max(1, w.speedKt))) : 0;
  return { drift: [round6(drift[0]), round6(drift[1])], known, gustiness };
}

function round6(n: number): number {
  const r = Math.round(n * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
}

const TINTS: Record<string, [number, number, number]> = {
  HZ: [1.0, 0.93, 0.8],
  FU: [0.92, 0.84, 0.74],
  DU: [1.0, 0.86, 0.66],
  SA: [1.0, 0.84, 0.62],
  VA: [0.8, 0.78, 0.76],
  BR: [0.94, 0.97, 1.0],
  FG: [0.96, 0.98, 1.0],
};

export function hazeFrom(metar: Metar): Pick<SceneParams, 'hazeVisibilityM' | 'hazeBeta' | 'hazeHeightM' | 'hazeTint' | 'obscured'> {
  const vis = metar.visibility;
  let visM = vis ? vis.meters : 10000;
  if (!vis || vis.orMore) visM *= OR_MORE_FACTOR;
  visM = Math.max(30, visM);
  const beta = KOSCHMIEDER / visM;

  const phen = metar.weather.filter((w) => w.intensity !== 'vicinity').flatMap((w) => w.phenomena.map((p) => ({ p, d: w.descriptor })));
  const fog = phen.find((x) => x.p === 'FG');
  let height: number;
  if (visM >= 5000) height = 700;
  else if (visM >= 1000) height = 600;
  else height = 150;
  if (fog && (fog.d === 'MI' || fog.d === 'BC' || fog.d === 'PR')) height = 40; // shallow or patchy fog

  const obscured = metar.sky === 'obscured';
  if (obscured) {
    // VV: the sky is hidden. Make the fog deep enough that its vertical optical depth
    // (β·H) is at least 4.5, i.e. no sky shows through, but never below the VV height.
    const vvM = (metar.verticalVisibilityFt ?? 300) * FT;
    height = Math.max(height, vvM, 4.5 / beta);
  }

  let tint: [number, number, number] = [1, 1, 1];
  for (const code of ['FU', 'DU', 'SA', 'VA', 'HZ', 'FG', 'BR']) {
    if (phen.some((x) => x.p === code)) {
      tint = TINTS[code]!;
      break;
    }
  }
  return { hazeVisibilityM: visM, hazeBeta: beta, hazeHeightM: height, hazeTint: tint, obscured };
}

export function precipFrom(metar: Metar): { kind: 0 | 1 | 2; intensity: number } {
  let kind: 0 | 1 | 2 = 0;
  let intensity = 0;
  for (const w of metar.weather) {
    if (w.intensity === 'vicinity') continue;
    const p = w.phenomena.filter((x) => PRECIPITATION.has(x));
    if (p.length === 0) continue;
    const frozen = p.some((x) => x !== 'RA' && x !== 'DZ' && x !== 'UP');
    const base = w.intensity === 'light' ? 0.35 : w.intensity === 'heavy' ? 1 : 0.65;
    const scale = p.every((x) => x === 'DZ') ? 0.5 : 1;
    const v = base * scale;
    if (v > intensity) {
      intensity = v;
      kind = frozen ? 2 : 1;
    }
  }
  return { kind, intensity };
}

/** Observation time as a Date. Uses the upstream time when given, else the report's day/hour/minute. */
export function observationDate(metar: Metar, nowMs: number, upstreamObsTimeSec?: number | null): Date | null {
  if (typeof upstreamObsTimeSec === 'number' && Number.isFinite(upstreamObsTimeSec)) {
    return new Date(upstreamObsTimeSec * 1000);
  }
  const { day, hour, minute } = metar;
  if (day === null || hour === null || minute === null) return null;
  // The report gives only day-of-month: pick the latest such date not more than an hour ahead of now.
  const now = new Date(nowMs);
  for (let back = 0; back < 3; back++) {
    const candidate: Date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, day, hour, minute));
    if (candidate.getUTCDate() !== day) continue; // e.g. the 31st in a 30-day month
    if (candidate.getTime() <= nowMs + 3600_000) return candidate;
  }
  return null;
}

export interface StationInfo {
  lat: number | null;
  lon: number | null;
}

/** Neutral daylight used when the station's position is unknown: soft light from high behind the viewer. */
export const NEUTRAL_SUN = { elevationDeg: 50, azimuthDeg: 180 };

export function sunFrom(station: StationInfo, obs: Date | null): SunParams {
  if (station.lat === null || station.lon === null || obs === null || !Number.isFinite(station.lat) || !Number.isFinite(station.lon)) {
    return { known: false, ...NEUTRAL_SUN, dir: sunVector(NEUTRAL_SUN.elevationDeg, NEUTRAL_SUN.azimuthDeg) };
  }
  const p = solarPosition(obs, station.lat, station.lon);
  return { known: true, elevationDeg: p.elevationDeg, azimuthDeg: p.azimuthDeg, dir: sunVector(p.elevationDeg, p.azimuthDeg) };
}

/** Above this sun elevation the view turns away from the sun, so clouds are front-lit. */
export const HIGH_SUN_DEG = 20;

/**
 * Where the "window" looks. A low sun, twilight or night: toward the sun's side, with the sun
 * 25° right of centre. A high sun: away from it (sun behind the viewer), like most daylight
 * photographs, so the sky reads blue and clouds are lit from the front.
 */
export function viewFor(sun: SunParams): { heading: number; pitch: number } {
  const norm = (d: number) => ((d % 360) + 360) % 360;
  if (!sun.known) return { heading: 0, pitch: 14 };
  if (sun.elevationDeg >= HIGH_SUN_DEG) return { heading: norm(sun.azimuthDeg + 160), pitch: 14 };
  return { heading: norm(sun.azimuthDeg - 25), pitch: 12 };
}

export const DAY_EXPOSURE = 0.9;
/** Night exposure as a multiple of day exposure. */
export const NIGHT_EXPOSURE = 50;

/**
 * Exposure opens up as the sun sets, the way eyes adapt, so twilight shows its colours and
 * night reads as a dark sky rather than black. Artistic: log-linear between these points
 * (sun elevation in degrees → log10 of the multiple of day exposure).
 */
const EXPOSURE_CURVE: Array<[number, number]> = [
  [8, 0],
  [0, 0.55],
  [-4, 1.05],
  [-8, 1.45],
  [-12, Math.log10(NIGHT_EXPOSURE)],
];

export function exposureFor(sunElevationDeg: number): number {
  const c = EXPOSURE_CURVE;
  if (sunElevationDeg >= c[0]![0]) return DAY_EXPOSURE;
  for (let i = 1; i < c.length; i++) {
    const [e1, k1] = c[i]!;
    const [e0, k0] = c[i - 1]!;
    if (sunElevationDeg >= e1) {
      const f = (e0 - sunElevationDeg) / (e0 - e1);
      return DAY_EXPOSURE * Math.pow(10, k0 + (k1 - k0) * f);
    }
  }
  return DAY_EXPOSURE * NIGHT_EXPOSURE;
}

export function sceneFrom(metar: Metar, station: StationInfo, obs: Date | null): SceneParams {
  const { layers, dropped } = layersFrom(metar);
  const { drift, known, gustiness } = driftFrom(metar);
  const haze = hazeFrom(metar);
  const precip = precipFrom(metar);
  const sun = sunFrom(station, obs);
  const view = viewFor(sun);
  return {
    layers,
    droppedLayers: dropped,
    drift,
    driftDirectionKnown: known,
    gustiness,
    ...haze,
    precipKind: precip.kind,
    precipIntensity: precip.intensity,
    sun,
    viewHeadingDeg: view.heading,
    viewPitchDeg: view.pitch,
    exposure: exposureFor(sun.known ? sun.elevationDeg : NEUTRAL_SUN.elevationDeg),
  };
}

/** What a token highlights in the shader. Mirrors `uFocus` in sky.frag. */
export const FOCUS = { none: 0, layer: 1, haze: 2, drift: 3, sun: 4, fog: 5, precip: 6, clear: 7 } as const;

export type UniformValue = number | number[];

/**
 * Scene → the shader's uniforms (names match sky.frag). Time, resolution, camera
 * basis and quality are added by the renderer each frame.
 */
export function sceneUniforms(s: SceneParams): Record<string, UniformValue> {
  const layers: number[] = [];
  const kinds: number[] = [];
  for (let i = 0; i < MAX_LAYERS; i++) {
    const l = s.layers[i];
    if (l) {
      layers.push(l.baseM, l.thicknessM, l.drawnCoverage, l.metarIndex);
      kinds.push(l.kind);
    } else {
      layers.push(0, 0, 0, -1);
      kinds.push(0);
    }
  }
  return {
    uLayerCount: s.layers.length,
    uLayers: layers,
    uLayerKinds: kinds,
    uDrift: [...s.drift],
    uGust: s.gustiness,
    uHazeBeta: s.hazeBeta,
    uHazeHeight: s.hazeHeightM,
    uHazeTint: [...s.hazeTint],
    uObscured: s.obscured ? 1 : 0,
    uPrecip: [s.precipKind, s.precipIntensity],
    uSunDir: [...s.sun.dir],
    uSunKnown: s.sun.known ? 1 : 0,
    uExposure: s.exposure,
    uSkyAmbient: skyAmbient(s.sun.dir),
  };
}

/** Camera basis for a heading (deg clockwise from north) and pitch (deg up). Columns: right, up, forward. */
export function cameraBasis(headingDeg: number, pitchDeg: number): number[] {
  const h = (headingDeg * Math.PI) / 180;
  const p = (pitchDeg * Math.PI) / 180;
  const fwd = [Math.cos(p) * Math.sin(h), Math.sin(p), Math.cos(p) * Math.cos(h)];
  const right = [Math.cos(h), 0, -Math.sin(h)];
  // up = forward × right (x = east, y = up, z = north)
  const up = [
    fwd[1]! * right[2]! - fwd[2]! * right[1]!,
    fwd[2]! * right[0]! - fwd[0]! * right[2]!,
    fwd[0]! * right[1]! - fwd[1]! * right[0]!,
  ];
  return [...right, ...up, ...fwd];
}
