/**
 * A report as the page shows it: the raw METAR, where it came from, the parsed result,
 * the scene, and the plain-English lines that trace each visual choice to its source.
 * Pure functions only, so it is unit-tested without a browser.
 */
import { parseMetar, formatFeet, compassName, type Metar } from '../metar/parse.ts';
import { sceneFrom, observationDate, DRIFT_TIMELAPSE, OR_MORE_FACTOR, CLOUD_KIND, MAX_LAYERS, FOCUS, type SceneParams } from '../scene/mapping.ts';
import type { MetarToken } from '../metar/parse.ts';

export interface StationMeta {
  name: string | null;
  lat: number | null;
  lon: number | null;
  elevM: number | null;
}

export interface ReportSource {
  id: string;
  raw: string;
  /** Observation time, Unix seconds, from the upstream feed when known. */
  obsTime: number | null;
  station: StationMeta | null;
}

export type Origin = 'live' | 'sample' | 'pasted';

export interface Report {
  origin: Origin;
  source: ReportSource;
  metar: Metar;
  obs: Date | null;
  scene: SceneParams;
}

export function buildReport(source: ReportSource, origin: Origin, nowMs: number): Report {
  const metar = parseMetar(source.raw);
  const obs = observationDate(metar, nowMs, source.obsTime);
  const scene = sceneFrom(metar, { lat: source.station?.lat ?? null, lon: source.station?.lon ?? null }, obs);
  return { origin, source, metar, obs, scene };
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

/** Degrees and decimal minutes, as on aeronautical charts: 51°28.6′N. */
export function formatLatLon(lat: number, lon: number): string {
  const f = (v: number, w: number, pos: string, neg: string) => {
    const a = Math.abs(v);
    let d = Math.floor(a);
    let m = Math.round((a - d) * 600) / 10;
    if (m >= 60) {
      d += 1;
      m = 0;
    }
    return `${pad(d, w)}°${m.toFixed(1).padStart(4, '0')}′${v >= 0 ? pos : neg}`;
  };
  return `${f(lat, 2, 'N', 'S')} ${f(lon, 3, 'E', 'W')}`;
}

/** "London/Heathrow Intl, EN, GB" → "LONDON/HEATHROW INTL". */
export function shortName(name: string | null | undefined): string | null {
  if (!name) return null;
  const first = name.split(',')[0]?.trim() ?? '';
  return first ? first.toUpperCase() : null;
}

export function formatObs(d: Date): string {
  return `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`;
}

function deg(n: number, digits = 0): string {
  const s = n.toFixed(digits);
  return (s.startsWith('-') ? `−${s.slice(1)}` : s) + '°';
}

export interface LabelLines {
  ident: string;
  name: string | null;
  position: string;
  observed: string;
  sun: string;
}

export function labelLines(r: Report): LabelLines {
  const st = r.source.station;
  const ident = r.metar.station ?? r.source.id;
  const pos: string[] = [];
  if (st && st.lat !== null && st.lon !== null) pos.push(formatLatLon(st.lat, st.lon));
  if (st && st.elevM !== null) pos.push(`ELEV ${Math.round(st.elevM / 0.3048)} FT`);
  const origin = r.origin === 'live' ? 'LIVE' : r.origin === 'sample' ? 'RECORDED SAMPLE' : 'PASTED REPORT';
  const observed = `${r.obs ? `OBS ${formatObs(r.obs)}` : 'OBS TIME UNKNOWN'} · ${origin}`;
  const s = r.scene.sun;
  let sun: string;
  if (!s.known) sun = 'POSITION UNKNOWN · NEUTRAL DAYLIGHT, NO SUN DRAWN';
  else {
    const where = s.elevationDeg < -0.833 ? ' BELOW HORIZON' : '';
    sun = `SUN ${deg(s.elevationDeg, 1)}${where} · BRG ${pad(Math.round(s.azimuthDeg) % 360, 3)}° · VIEW ${pad(Math.round(r.scene.viewHeadingDeg) % 360, 3)}°`;
  }
  return { ident, name: shortName(st?.name), position: pos.join(' · ') || 'POSITION UNKNOWN', observed, sun };
}

const KIND_NAME: Record<number, string> = {
  [CLOUD_KIND.cumulus]: 'heaped cumulus-like cells',
  [CLOUD_KIND.stratiform]: 'a flatter stratocumulus-like deck',
  [CLOUD_KIND.mid]: 'a thin mid-level layer',
  [CLOUD_KIND.cirrus]: 'thin high streaks stretched along the wind',
  [CLOUD_KIND.towering]: 'tall towers (no anvil or lightning yet)',
};

/**
 * One line per visible element, each naming the METAR group or calculation behind it.
 * Shown in the "How this is drawn" note.
 */
export function traceLines(r: Report): string[] {
  const out: string[] = [];
  const m = r.metar;
  const s = r.scene;

  s.layers.forEach((l, i) => {
    const c = m.clouds[l.metarIndex];
    const tok = c ? m.tokens[c.tokenIndex]?.text : undefined;
    const base = l.baseAssumed ? `an assumed ${formatFeet(l.baseM / 0.3048)} (base not measured)` : formatFeet(l.baseM / 0.3048);
    const amount = `${Math.round(l.coverage * 8 * 10) / 10}/8 of the sky from ${base}`;
    if (l.squeezed) {
      const next = s.layers[i + 1];
      const gapFt = next ? ` (the next base is only ${formatFeet((next.baseM - l.baseM) / 0.3048)} higher)` : '';
      out.push(
        `Cloud layer ${i + 1} (${tok ?? '?'}): ${amount}. It is too close under the next layer to draw separately${gapFt}: squeezed to ${Math.round(l.thicknessM)} m, it is barely visible.`,
      );
      return;
    }
    out.push(
      `Cloud layer ${i + 1} (${tok ?? '?'}): ${amount}, ${Math.round(l.thicknessM)} m thick, drawn as ${KIND_NAME[l.kind]}. Thickness and shape are style choices; the report gives only amount and base.`,
    );
  });
  if (s.droppedLayers > 0) out.push(`${s.droppedLayers} higher layer${s.droppedLayers > 1 ? 's are' : ' is'} reported but not drawn (the shader draws up to four).`);
  if (s.layers.length === 0 && !s.obscured) {
    const why = m.cavok ? 'CAVOK' : m.sky === 'unreported' ? 'no cloud group' : m.tokens.find((t) => t.kind === 'skyClear')?.text ?? 'no cloud group';
    out.push(`No clouds drawn (${why}).`);
  }

  const vis = m.visibility;
  const visText = vis
    ? vis.orMore
      ? `the report says ${Math.round(vis.meters / 100) / 10} km or more, so it is drawn for ${OR_MORE_FACTOR}× that, ${Math.round(s.hazeVisibilityM / 100) / 10} km`
      : `${Math.round(vis.meters).toLocaleString('en-US')} m reported`
    : `visibility not reported, drawn for ${Math.round(s.hazeVisibilityM / 1000)} km`;
  out.push(`Haze: ${visText}. Extinction 3.912 ÷ visibility (Koschmieder), fading with height over about ${Math.round(s.hazeHeightM)} m.`);
  if (s.obscured) out.push('Sky obscured (VV): the fog is made deep enough that no sky shows through.');

  const w = m.wind;
  if (!w) out.push('Wind not reported: the clouds hold still.');
  else if (w.calm) out.push('Calm: the clouds hold still.');
  else {
    const speed = Math.hypot(s.drift[0], s.drift[1]);
    const toward = (Math.atan2(s.drift[0], s.drift[1]) * 180) / Math.PI;
    const dirNote = s.driftDirectionKnown ? '' : ' Direction is variable, so the drift direction is a guess.';
    const lapse = DRIFT_TIMELAPSE === 1 ? 'in real time' : `sped up ${DRIFT_TIMELAPSE}×`;
    out.push(
      `Drift: clouds move toward ${compassName((toward + 360) % 360)} at ${speed.toFixed(1)} m/s, ${lapse}, from the surface wind. Winds aloft are usually different.${dirNote}`,
    );
  }

  if (s.precipKind > 0) out.push(`Precipitation: ${s.precipKind === 2 ? 'snow' : 'rain'} streaks at ${Math.round(s.precipIntensity * 100)}% strength, from the weather group.`);

  if (s.sun.known && r.obs) {
    const st = r.source.station;
    const e = s.sun.elevationDeg;
    const where = e < 0 ? `${deg(-e, 1)} below the horizon` : `${deg(e, 1)} above the horizon`;
    out.push(
      `Sun: ${where} at bearing ${Math.round(s.sun.azimuthDeg)}°, from the NOAA solar position equations for ${st?.lat?.toFixed(3)}, ${st?.lon?.toFixed(3)} at ${formatObs(r.obs)}.`,
    );
  } else {
    out.push('Sun: the station position or time is unknown, so the light is a neutral daylight and no sun disc is drawn.');
  }
  return out;
}

/** The one-line explanation shown for a token, with station and layer details filled in. */
export function tokenExplanation(r: Report, t: MetarToken): string {
  if (t.kind === 'station') {
    const name = shortName(r.source.station?.name);
    const pos = r.scene.sun.known ? 'its position sets the sun' : 'its position is unknown, so the light is neutral';
    return `station ${t.text.toUpperCase()}${name ? ` — ${name.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())}` : ''}; ${pos}`;
  }
  if (t.drives.kind === 'layer' && t.drives.index >= MAX_LAYERS) {
    return t.meaning.replace(/ — drawn as cloud layer \d+$/, ' — not drawn (only the lowest four layers are drawn)');
  }
  if (t.drives.kind === 'layer') {
    const index = t.drives.index;
    const layer = r.scene.layers.find((l) => l.metarIndex === index);
    if (layer?.squeezed) return t.meaning.replace(/ — drawn as cloud layer \d+$/, ' — too close under the next layer to draw separately');
  }
  return t.meaning;
}

/** Which highlight a token asks the shader for: [FOCUS kind, index]. */
export function focusFor(t: MetarToken): [number, number] {
  switch (t.drives.kind) {
    case 'layer':
      return [FOCUS.layer, t.drives.index];
    case 'haze':
      return [FOCUS.haze, 0];
    case 'fog':
      return [FOCUS.fog, 0];
    case 'drift':
      return [FOCUS.drift, 0];
    case 'sun':
    case 'station':
      return [FOCUS.sun, 0];
    case 'precip':
      return [FOCUS.precip, 0];
    case 'clear':
      return [FOCUS.clear, 0];
    default:
      return [FOCUS.none, 0];
  }
}
