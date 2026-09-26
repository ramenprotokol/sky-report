/**
 * METAR parser.
 *
 * A METAR is the standard aviation weather report (WMO FM 15; ICAO Annex 3; in the
 * US, FAA Order JO 7900.5 adds statute-mile visibility, CLR and the RMK section).
 *
 * Design rules:
 *  - Never throws. Any input string gives back a Metar with whatever could be read,
 *    plus `ok: false` and a plain-English `error` when it is not usable.
 *  - Every whitespace-separated group becomes a token with its exact character span
 *    in the raw string, a kind, a one-line plain-English meaning and what it drives
 *    in the picture. The UI underlines tokens straight from this list.
 *  - Trend groups (TEMPO, BECMG, NOSIG) are forecasts and remarks (RMK) are local
 *    extras: both are kept as tokens but never feed the current-conditions fields.
 */

export type Cover = 'FEW' | 'SCT' | 'BKN' | 'OVC';

export type TokenKind =
  | 'type'
  | 'modifier'
  | 'station'
  | 'time'
  | 'wind'
  | 'windVariation'
  | 'visibility'
  | 'minVisibility'
  | 'rvr'
  | 'weather'
  | 'cloud'
  | 'verticalVisibility'
  | 'skyClear'
  | 'cavok'
  | 'temperature'
  | 'altimeter'
  | 'recentWeather'
  | 'windShear'
  | 'runwayState'
  | 'seaState'
  | 'trend'
  | 'remarks'
  | 'missing'
  | 'unknown';

/** What a token changes in the rendered sky. */
export type Drive =
  | { kind: 'station' }
  | { kind: 'sun' }
  | { kind: 'drift' }
  | { kind: 'haze' }
  | { kind: 'fog' }
  | { kind: 'layer'; index: number }
  | { kind: 'clear' }
  | { kind: 'precip' }
  | { kind: 'none' };

export interface MetarToken {
  text: string;
  start: number;
  end: number;
  kind: TokenKind;
  meaning: string;
  /** Short form used when summarising a trend group. */
  short: string;
  drives: Drive;
  section: 'body' | 'trend' | 'remarks';
}

export interface Wind {
  /** Direction the wind blows FROM, degrees true. Null when variable (VRB) or not reported. */
  directionDeg: number | null;
  variable: boolean;
  calm: boolean;
  /** Speed in knots (converted from MPS/KMH when needed). */
  speedKt: number;
  gustKt: number | null;
  unit: 'KT' | 'MPS' | 'KMH';
  /** Direction range from a dddVddd group, if reported. */
  rangeDeg: [number, number] | null;
  /** Speed reported with a P prefix ("more than"). */
  aboveReported: boolean;
}

export interface Visibility {
  meters: number;
  /** The report gives a floor, not a value: 9999, P6SM, 10SM, CAVOK. */
  orMore: boolean;
  /** The report says "less than" (M1/4SM). */
  lessThan: boolean;
  unit: 'm' | 'SM' | 'km';
}

export interface WeatherGroup {
  raw: string;
  intensity: 'light' | 'moderate' | 'heavy' | 'vicinity';
  descriptor: string | null;
  phenomena: string[];
}

export interface CloudLayer {
  cover: Cover;
  /** Base above the airport in feet, null when reported as ///. */
  baseFt: number | null;
  convective: 'CB' | 'TCU' | null;
  tokenIndex: number;
}

export type SkyState = 'layers' | 'clear' | 'nsc' | 'ncd' | 'cavok' | 'obscured' | 'unreported';

export interface Metar {
  ok: boolean;
  error: string | null;
  raw: string;
  reportType: 'METAR' | 'SPECI' | null;
  station: string | null;
  day: number | null;
  hour: number | null;
  minute: number | null;
  auto: boolean;
  corrected: boolean;
  nil: boolean;
  wind: Wind | null;
  visibility: Visibility | null;
  weather: WeatherGroup[];
  clouds: CloudLayer[];
  /** Present when the sky is obscured (VV group). Null means VV/// (height unknown). */
  verticalVisibilityFt: number | null;
  sky: SkyState;
  cavok: boolean;
  temperatureC: number | null;
  dewpointC: number | null;
  altimeterHpa: number | null;
  tokens: MetarToken[];
  /** Tokens in the current-conditions part that could not be decoded. */
  unparsed: string[];
}

const KT_PER_MPS = 1.943844;
const KT_PER_KMH = 0.539957;
export const M_PER_SM = 1609.344;
const HPA_PER_INHG = 33.8639;

const COVER_TEXT: Record<Cover, { name: string; oktas: string }> = {
  FEW: { name: 'a few clouds', oktas: '1–2 eighths of the sky' },
  SCT: { name: 'scattered cloud', oktas: '3–4 eighths of the sky' },
  BKN: { name: 'broken cloud', oktas: '5–7 eighths of the sky' },
  OVC: { name: 'overcast', oktas: 'the whole sky' },
};

const DESCRIPTORS: Record<string, string> = {
  MI: 'shallow',
  PR: 'partial',
  BC: 'patches of',
  DR: 'low drifting',
  BL: 'blowing',
  SH: 'showers of',
  TS: 'thunderstorm with',
  FZ: 'freezing',
};

const PHENOMENA: Record<string, string> = {
  DZ: 'drizzle',
  RA: 'rain',
  SN: 'snow',
  SG: 'snow grains',
  IC: 'ice crystals',
  PL: 'ice pellets',
  GR: 'hail',
  GS: 'small hail',
  UP: 'unknown precipitation',
  BR: 'mist',
  FG: 'fog',
  FU: 'smoke',
  VA: 'volcanic ash',
  DU: 'dust',
  SA: 'sand',
  HZ: 'haze',
  PY: 'spray',
  PO: 'dust whirls',
  SQ: 'squalls',
  FC: 'funnel cloud',
  SS: 'sandstorm',
  DS: 'duststorm',
};

export const PRECIPITATION = new Set(['DZ', 'RA', 'SN', 'SG', 'IC', 'PL', 'GR', 'GS', 'UP']);
export const OBSCURATION = new Set(['BR', 'FG', 'FU', 'VA', 'DU', 'SA', 'HZ', 'PY']);

const TREND_KEYWORDS = new Set(['TEMPO', 'BECMG', 'NOSIG']);

const COMPASS16 = [
  'north', 'north-northeast', 'northeast', 'east-northeast',
  'east', 'east-southeast', 'southeast', 'south-southeast',
  'south', 'south-southwest', 'southwest', 'west-southwest',
  'west', 'west-northwest', 'northwest', 'north-northwest',
];

export function compassName(deg: number): string {
  const i = Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;
  return COMPASS16[i] ?? 'north';
}

export function formatFeet(ft: number): string {
  return `${Math.round(ft).toLocaleString('en-US')} ft`;
}

function formatMeters(m: number): string {
  if (m >= 5000) {
    const km = m / 1000;
    return `${Number.isInteger(km) ? km : km.toFixed(1)} km`;
  }
  return `${Math.round(m).toLocaleString('en-US')} m`;
}

function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  const last = n % 10;
  return `${n}${last === 1 ? 'st' : last === 2 ? 'nd' : last === 3 ? 'rd' : 'th'}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

const FRACTIONS: Record<string, string> = {
  '1/2': '½', '1/4': '¼', '3/4': '¾', '1/8': '⅛', '3/8': '⅜', '5/8': '⅝', '7/8': '⅞',
  '1/16': '1/16', '3/16': '3/16', '5/16': '5/16',
};

function milesText(whole: number, num: number, den: number): string {
  const frac = num > 0 ? (FRACTIONS[`${num}/${den}`] ?? `${num}/${den}`) : '';
  const w = whole > 0 ? String(whole) : '';
  const txt = w && frac ? `${w}${frac}` : w || frac || '0';
  const value = whole + (den ? num / den : 0);
  return `${txt} ${value > 1 ? 'miles' : 'mile'}`;
}

function weatherText(g: WeatherGroup): string {
  const phen = g.phenomena.map((p) => PHENOMENA[p] ?? p);
  let core = phen.join(' and ');
  if (g.descriptor) {
    const d = DESCRIPTORS[g.descriptor] ?? g.descriptor;
    if (g.descriptor === 'TS' && phen.length === 0) core = 'thunderstorm';
    else if (g.descriptor === 'SH' && phen.length === 0) core = 'showers';
    else core = `${d} ${core}`.trim();
  }
  if (!core) core = 'weather';
  switch (g.intensity) {
    case 'light':
      return `light ${core}`;
    case 'heavy':
      return `heavy ${core}`;
    case 'vicinity':
      return `${core} nearby (within 8 km, not at the airport)`;
    default:
      return core;
  }
}

function parseWeather(text: string): WeatherGroup | null {
  const m = /^(-|\+|VC)?(MI|PR|BC|DR|BL|SH|TS|FZ)?((?:DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS)*)$/.exec(text);
  if (!m) return null;
  const descriptor = m[2] ?? null;
  const phenStr = m[3] ?? '';
  if (!descriptor && !phenStr) return null;
  // A descriptor on its own is only valid for TS and SH (e.g. "TS", "VCSH").
  if (!phenStr && descriptor !== 'TS' && descriptor !== 'SH') return null;
  const phenomena: string[] = [];
  for (let i = 0; i < phenStr.length; i += 2) phenomena.push(phenStr.slice(i, i + 2));
  const intensity =
    m[1] === '-' ? 'light' : m[1] === '+' ? 'heavy' : m[1] === 'VC' ? 'vicinity' : 'moderate';
  return { raw: text, intensity, descriptor, phenomena };
}

interface RawTok {
  text: string;
  start: number;
  end: number;
}

function tokenize(raw: string): RawTok[] {
  const out: RawTok[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    let text = m[0];
    let end = m.index + text.length;
    // A trailing '=' ends the message in many feeds; it is not part of the group.
    while (text.endsWith('=')) {
      text = text.slice(0, -1);
      end -= 1;
    }
    if (text) out.push({ text, start: m.index, end });
  }
  return out;
}

function emptyMetar(raw: string): Metar {
  return {
    ok: false,
    error: null,
    raw,
    reportType: null,
    station: null,
    day: null,
    hour: null,
    minute: null,
    auto: false,
    corrected: false,
    nil: false,
    wind: null,
    visibility: null,
    weather: [],
    clouds: [],
    verticalVisibilityFt: null,
    sky: 'unreported',
    cavok: false,
    temperatureC: null,
    dewpointC: null,
    altimeterHpa: null,
    tokens: [],
    unparsed: [],
  };
}

type Classified = Omit<MetarToken, 'start' | 'end' | 'text' | 'section'> & { apply?: (m: Metar) => void };

const NONE: Drive = { kind: 'none' };

function tempValue(s: string): number | null {
  if (!s || s.includes('/')) return null;
  const neg = s.startsWith('M') || s.startsWith('-');
  const n = Number(s.replace(/^[M-]/, ''));
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

/**
 * Classify one group of the current-conditions part. `ctx` carries what has already
 * been seen so that order-dependent groups (station, 4-digit visibility) are read
 * the way the format intends.
 */
function classify(text: string, ctx: { m: Metar; index: number; seenTime: boolean; forTrend: boolean }): Classified | null {
  const { m } = ctx;

  if (/^(METAR|SPECI)$/.test(text) && ctx.index === 0) {
    const special = text === 'SPECI';
    return {
      kind: 'type',
      meaning: special
        ? 'special report — issued between routine reports because conditions changed'
        : 'routine weather report',
      short: special ? 'special report' : 'routine report',
      drives: NONE,
      apply: (x) => (x.reportType = special ? 'SPECI' : 'METAR'),
    };
  }
  if (text === 'COR' || text === 'CCA' || text === 'CCB') {
    return { kind: 'modifier', meaning: 'corrected report — replaces an earlier one with a mistake', short: 'corrected', drives: NONE, apply: (x) => (x.corrected = true) };
  }
  if (text === 'AUTO') {
    return { kind: 'modifier', meaning: 'automated report — made by sensors with no human observer', short: 'automated', drives: NONE, apply: (x) => (x.auto = true) };
  }
  if (text === 'NIL') {
    return { kind: 'modifier', meaning: 'missing report — the station sent no observation', short: 'missing report', drives: NONE, apply: (x) => (x.nil = true) };
  }
  if (!ctx.forTrend && !m.station && !ctx.seenTime && /^[A-Z][A-Z0-9]{3}$/.test(text) && !['AUTO', 'CAVOK', 'NOSIG', 'TEMPO', 'BECMG'].includes(text) && !/^(SKC|CLR|NSC|NCD)$/.test(text)) {
    return {
      kind: 'station',
      meaning: `station ${text} — the airport this report comes from`,
      short: `station ${text}`,
      drives: { kind: 'station' },
      apply: (x) => (x.station = text),
    };
  }

  let r: RegExpExecArray | null;

  if ((r = /^(\d{2})(\d{2})(\d{2})Z$/.exec(text))) {
    const day = Number(r[1]);
    const hour = Number(r[2]);
    const minute = Number(r[3]);
    if (day >= 1 && day <= 31 && hour <= 24 && minute <= 59) {
      return {
        kind: 'time',
        meaning: `observed on the ${ordinal(day)} at ${pad2(hour)}:${pad2(minute)} UTC — sets the sun's position`,
        short: `${pad2(hour)}:${pad2(minute)} UTC`,
        drives: { kind: 'sun' },
        apply: (x) => {
          x.day = day;
          x.hour = hour;
          x.minute = minute;
        },
      };
    }
  }

  // Wind: dddff(f)Gff(f)KT | VRBffKT | 00000KT | /////KT, also MPS and KMH, and P-prefixed speeds.
  if ((r = /^(\d{3}|VRB|\/{3})(P?\d{2,3}|\/\/)(?:G(P?\d{2,3}))?(KT|MPS|KMH)$/.exec(text))) {
    const dirS = r[1] ?? '';
    const spdS = r[2] ?? '';
    const gstS = r[3];
    const unit = r[4] as Wind['unit'];
    const factor = unit === 'KT' ? 1 : unit === 'MPS' ? KT_PER_MPS : KT_PER_KMH;
    if (dirS === '///' || spdS === '//') {
      return {
        kind: 'missing',
        meaning: 'wind not reported — the sensor gave no reading, so the clouds do not drift',
        short: 'wind missing',
        drives: { kind: 'drift' },
      };
    }
    const rawSpeed = Number(spdS.replace('P', ''));
    const rawGust = gstS ? Number(gstS.replace('P', '')) : null;
    const speedKt = rawSpeed * factor;
    const gustKt = rawGust === null ? null : rawGust * factor;
    const variable = dirS === 'VRB';
    const directionDeg = variable ? null : Number(dirS);
    if (directionDeg !== null && directionDeg > 360) return null;
    const calm = rawSpeed === 0;
    const unitWord = unit === 'KT' ? 'knots' : unit === 'MPS' ? 'm/s' : 'km/h';
    const inKt = unit === 'KT' ? '' : ` (${Math.round(speedKt)} knots)`;
    const spd = `${spdS.startsWith('P') ? 'more than ' : ''}${rawSpeed} ${unitWord}${inKt}`;
    const gust = rawGust !== null ? `, gusting ${rawGust}` : '';
    let meaning: string;
    let short: string;
    if (calm) {
      meaning = 'calm — no wind, so the clouds hold still';
      short = 'calm';
    } else if (variable) {
      meaning = `light and variable wind at ${spd}${gust} — drifts the clouds`;
      short = `variable wind ${rawSpeed} ${unit === 'KT' ? 'kt' : unitWord}`;
    } else {
      meaning = `wind from ${directionDeg}° (${compassName(directionDeg ?? 0)}) at ${spd}${gust} — drifts the clouds`;
      short = `wind ${pad3(directionDeg ?? 0)}° ${rawSpeed} ${unit === 'KT' ? 'kt' : unitWord}${rawGust !== null ? ` gusting ${rawGust}` : ''}`;
    }
    return {
      kind: 'wind',
      meaning,
      short,
      drives: { kind: 'drift' },
      apply: (x) =>
        (x.wind = {
          directionDeg,
          variable,
          calm,
          speedKt,
          gustKt,
          unit,
          rangeDeg: null,
          aboveReported: spdS.startsWith('P'),
        }),
    };
  }

  if ((r = /^(\d{3})V(\d{3})$/.exec(text))) {
    const a = Number(r[1]);
    const b = Number(r[2]);
    if (a <= 360 && b <= 360) {
      return {
        kind: 'windVariation',
        meaning: `wind direction swinging between ${a}° and ${b}°`,
        short: `wind ${a}°–${b}°`,
        drives: { kind: 'drift' },
        apply: (x) => {
          if (x.wind) x.wind.rangeDeg = [a, b];
        },
      };
    }
  }

  if (text === 'CAVOK') {
    return {
      kind: 'cavok',
      meaning: 'ceiling and visibility OK — 10 km or more, no cloud below 5,000 ft, no significant weather',
      short: 'CAVOK (clear, 10 km+)',
      drives: { kind: 'clear' },
      apply: (x) => {
        x.cavok = true;
        x.sky = 'cavok';
        x.visibility = { meters: 10000, orMore: true, lessThan: false, unit: 'm' };
      },
    };
  }

  // Metric visibility, 4 digits (9999 = 10 km or more), optionally NDV (no directional variation).
  if ((r = /^(\d{4})(NDV)?$/.exec(text)) && (ctx.forTrend || !m.visibility)) {
    const v = Number(r[1]);
    const orMore = v === 9999;
    const meters = orMore ? 10000 : v;
    return {
      kind: 'visibility',
      meaning: orMore
        ? 'visibility 10 km or more — sets the haze'
        : v === 0
          ? 'visibility less than 50 m — thick fog'
          : `visibility ${formatMeters(meters)} — sets the haze`,
      short: orMore ? 'visibility 10 km+' : `visibility ${formatMeters(meters)}`,
      drives: { kind: 'haze' },
      apply: (x) => (x.visibility = { meters: v === 0 ? 50 : meters, orMore, lessThan: v === 0, unit: 'm' }),
    };
  }
  if ((r = /^(\d{4})(N|NE|E|SE|S|SW|W|NW)?$/.exec(text)) && m.visibility) {
    const v = Number(r[1]);
    const dir = r[2] ? ` toward the ${compassName({ N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 }[r[2]] ?? 0)}` : '';
    return {
      kind: 'minVisibility',
      meaning: `lowest visibility ${formatMeters(v)}${dir} — not drawn`,
      short: `lowest visibility ${formatMeters(v)}`,
      drives: NONE,
    };
  }
  if ((r = /^(\d{4})(N|NE|E|SE|S|SW|W|NW)$/.exec(text)) && !m.visibility) {
    // Some stations give only a directional visibility; treat it as the prevailing value.
    const v = Number(r[1]);
    return {
      kind: 'visibility',
      meaning: `visibility ${formatMeters(v)} (${r[2]}) — sets the haze`,
      short: `visibility ${formatMeters(v)}`,
      drives: { kind: 'haze' },
      apply: (x) => (x.visibility = { meters: v, orMore: false, lessThan: false, unit: 'm' }),
    };
  }
  if (text === '////') {
    return { kind: 'missing', meaning: 'visibility not reported', short: 'visibility missing', drives: { kind: 'haze' } };
  }
  if ((r = /^(\d{1,2})KM$/.exec(text))) {
    const km = Number(r[1]);
    return {
      kind: 'visibility',
      meaning: `visibility ${km} km — sets the haze`,
      short: `visibility ${km} km`,
      drives: { kind: 'haze' },
      apply: (x) => (x.visibility = { meters: km * 1000, orMore: false, lessThan: false, unit: 'km' }),
    };
  }

  // Statute miles (US, Canada): 10SM, P6SM, M1/4SM, 3/4SM, 1 1/2SM (merged before classify).
  if ((r = /^(M|P)?(?:(\d{1,2}) )?(?:(\d{1,2})\/(\d{1,2}))?(\d{1,2})?SM$/.exec(text))) {
    const prefix = r[1];
    let whole = 0;
    let num = 0;
    let den = 0;
    if (r[2] !== undefined) whole = Number(r[2]);
    if (r[3] !== undefined && r[4] !== undefined) {
      num = Number(r[3]);
      den = Number(r[4]);
    }
    if (r[5] !== undefined) {
      if (r[3] !== undefined || r[2] !== undefined) return null;
      whole = Number(r[5]);
    }
    if (r[2] !== undefined && r[3] === undefined) return null;
    if ((r[3] === undefined && r[5] === undefined) || (den === 0 && num !== 0)) return null;
    const miles = whole + (den ? num / den : 0);
    const meters = miles * M_PER_SM;
    // US stations cap visibility at 10SM, so a plain 10SM means "10 miles or more".
    const orMore = prefix === 'P' || (prefix === undefined && miles === 10);
    const lessThan = prefix === 'M';
    const words = milesText(whole, num, den);
    const qual = lessThan ? 'less than ' : prefix === 'P' ? 'more than ' : '';
    const plus = orMore && prefix !== 'P' ? ' or more' : '';
    return {
      kind: 'visibility',
      meaning: `visibility ${qual}${words}${plus} (about ${formatMeters(Math.round(meters / 10) * 10)}) — sets the haze`,
      short: `visibility ${qual}${words}${plus}`,
      drives: { kind: 'haze' },
      apply: (x) => (x.visibility = { meters, orMore, lessThan, unit: 'SM' }),
    };
  }

  // Runway visual range: R27L/0600N, R09/P2000, R24/1200V1800FT/U, R06//////.
  if ((r = /^R(\d{2}[LCR]?)\/([PM]?\d{4})(?:V([PM]?\d{4}))?(FT)?(?:\/?([UDN]))?$/.exec(text))) {
    const ft = r[4] === 'FT';
    const val = (s: string) => {
      const q = s.startsWith('P') ? 'more than ' : s.startsWith('M') ? 'less than ' : '';
      return `${q}${Number(s.replace(/^[PM]/, '')).toLocaleString('en-US')} ${ft ? 'ft' : 'm'}`;
    };
    const range = r[3] ? `${val(r[2] ?? '')} to ${val(r[3])}` : val(r[2] ?? '');
    const trend = r[5] === 'U' ? ', improving' : r[5] === 'D' ? ', getting worse' : r[5] === 'N' ? ', steady' : '';
    return {
      kind: 'rvr',
      meaning: `runway ${r[1]}: you can see ${range} along it${trend} — not drawn`,
      short: `runway ${r[1]} range ${range}`,
      drives: NONE,
    };
  }
  if (/^R\d{2}[LCR]?\/\/{4,}/.test(text)) {
    return { kind: 'rvr', meaning: 'runway visual range not available — not drawn', short: 'runway range missing', drives: NONE };
  }
  // Runway state (European, 8 digits after the designator) and closed-for-snow.
  if (/^R\d{2}[LCR]?\/(?:[0-9/]{6}|CLRD\d{2}|CLRD\/\/)$/.test(text) || text === 'R/SNOCLO' || text === 'SNOCLO') {
    return { kind: 'runwayState', meaning: 'runway surface condition (deposits, braking) — not drawn', short: 'runway condition', drives: NONE };
  }

  if (text === '//') {
    return { kind: 'missing', meaning: 'present weather not observable by the automatic station', short: 'weather missing', drives: NONE };
  }

  // Recent weather: RERA, RESHRA, RETS …
  if (text.startsWith('RE') && text.length > 2) {
    const g = parseWeather(text.slice(2));
    if (g) {
      return {
        kind: 'recentWeather',
        meaning: `recent ${weatherText(g)} — ended within the last hour, not drawn`,
        short: `recent ${weatherText(g)}`,
        drives: NONE,
      };
    }
  }

  if (text === 'NSW') {
    return { kind: 'weather', meaning: 'no significant weather expected', short: 'no significant weather', drives: NONE };
  }

  {
    const g = parseWeather(text);
    if (g) {
      const hasPrecip = g.phenomena.some((p) => PRECIPITATION.has(p));
      const hasObsc = g.phenomena.some((p) => OBSCURATION.has(p));
      const drawn = g.intensity !== 'vicinity' && (hasPrecip || hasObsc);
      const drives: Drive = !drawn ? NONE : hasPrecip ? { kind: 'precip' } : { kind: 'haze' };
      const tail = drawn ? (hasPrecip ? ' — adds falling streaks' : ' — tints the haze') : ' — not drawn';
      return {
        kind: 'weather',
        meaning: `${weatherText(g)}${tail}`,
        short: weatherText(g),
        drives,
        apply: (x) => x.weather.push(g),
      };
    }
  }

  // Cloud layers: FEW020, SCT025CB, BKN030TCU, OVC///, BKN016///, //////CB, ///015.
  if ((r = /^(FEW|SCT|BKN|OVC|\/{3})(\d{3}|\/{3})(CB|TCU|\/{3})?$/.exec(text))) {
    const coverS = r[1] ?? '';
    const baseS = r[2] ?? '';
    const typeS = r[3];
    const convective = typeS === 'CB' || typeS === 'TCU' ? typeS : null;
    const convText = convective === 'CB' ? ' cumulonimbus (thunderstorm cloud)' : convective === 'TCU' ? ' towering cumulus' : '';
    if (coverS === '///') {
      return {
        kind: 'missing',
        meaning: `cloud${convText} detected but the amount was not measured — not drawn`,
        short: 'cloud amount unknown',
        drives: NONE,
      };
    }
    const cover = coverS as Cover;
    const baseFt = baseS === '///' ? null : Number(baseS) * 100;
    const index = ctx.forTrend ? -1 : m.clouds.length;
    const c = COVER_TEXT[cover];
    const at = baseFt === null ? ' at an unmeasured height' : ` at ${formatFeet(baseFt)}`;
    const layerNote = ctx.forTrend ? '' : ` — drawn as cloud layer ${index + 1}`;
    const cbNote = convective ? ` (${convText.trim()}; drawn as a tall cumulus)` : '';
    return {
      kind: 'cloud',
      meaning: `${c.name}${at} above the airport, ${c.oktas}${cbNote}${layerNote}`,
      short: `${c.name}${at}${convText}`,
      drives: ctx.forTrend ? NONE : { kind: 'layer', index },
      apply: (x) => {
        x.clouds.push({ cover, baseFt, convective, tokenIndex: -1 });
        x.sky = 'layers';
      },
    };
  }
  if (text === '//////') {
    return { kind: 'missing', meaning: 'cloud not reported by the automatic station', short: 'cloud missing', drives: NONE };
  }

  if ((r = /^VV(\d{3}|\/{3})$/.exec(text))) {
    const ft = r[1] === '///' ? null : Number(r[1]) * 100;
    return {
      kind: 'verticalVisibility',
      meaning:
        ft === null
          ? 'sky hidden by fog or similar; how far up you can see was not measured — fills the view with fog'
          : `sky hidden — you can see only ${formatFeet(ft)} straight up, usually through fog — fills the view with fog`,
      short: ft === null ? 'sky obscured' : `sky obscured, vertical visibility ${formatFeet(ft)}`,
      drives: { kind: 'fog' },
      apply: (x) => {
        x.sky = 'obscured';
        x.verticalVisibilityFt = ft;
      },
    };
  }

  if (/^(SKC|CLR|NSC|NCD)$/.test(text)) {
    const info: Record<string, [string, string, SkyState]> = {
      SKC: ['sky clear — no cloud', 'sky clear', 'clear'],
      CLR: ['no cloud below 12,000 ft detected by the automatic station', 'no cloud below 12,000 ft', 'clear'],
      NSC: ['no significant cloud — nothing below 5,000 ft and no shower clouds', 'no significant cloud', 'nsc'],
      NCD: ['no cloud detected by the automatic station', 'no cloud detected', 'ncd'],
    };
    const [meaning, short, sky] = info[text] ?? ['sky clear', 'sky clear', 'clear'];
    return {
      kind: 'skyClear',
      meaning: `${meaning} — no clouds drawn`,
      short,
      drives: { kind: 'clear' },
      apply: (x) => {
        if (x.sky === 'unreported') x.sky = sky;
      },
    };
  }

  if (text === '/////') {
    return { kind: 'missing', meaning: 'temperature and dew point not reported', short: 'temperature missing', drives: NONE };
  }
  // Temperature / dew point: 12/10, M05/M07, 12/, ///10.
  if ((r = /^(M?\d{2}|\/\/)\/(M?\d{2}|\/\/)?$/.exec(text))) {
    const t = tempValue(r[1] ?? '');
    const d = tempValue(r[2] ?? '');
    const tt = t === null ? 'temperature missing' : `temperature ${t} °C`;
    const dd = d === null ? 'dew point missing' : `dew point ${d} °C`;
    return {
      kind: 'temperature',
      meaning: `${tt}, ${dd} — not drawn`,
      short: `${tt}, ${dd}`,
      drives: NONE,
      apply: (x) => {
        x.temperatureC = t;
        x.dewpointC = d;
      },
    };
  }

  if ((r = /^([QA])(\d{4}|\/{4})$/.exec(text))) {
    const q = r[1] === 'Q';
    const digits = r[2] ?? '';
    if (digits === '////') {
      return { kind: 'missing', meaning: 'pressure not reported', short: 'pressure missing', drives: NONE };
    }
    const val = Number(digits);
    const hPa = q ? val : (val / 100) * HPA_PER_INHG;
    return {
      kind: 'altimeter',
      meaning: q
        ? `air pressure (QNH) ${val} hPa — not drawn`
        : `altimeter setting ${(val / 100).toFixed(2)} inHg (${Math.round(hPa)} hPa) — not drawn`,
      short: q ? `pressure ${val} hPa` : `altimeter ${(val / 100).toFixed(2)} inHg`,
      drives: NONE,
      apply: (x) => (x.altimeterHpa = hPa),
    };
  }

  if (/^W(M?\d{2}|\/\/)\/(S\d|H\d{1,3}|S\/|H\/\/\/)$/.test(text)) {
    return { kind: 'seaState', meaning: 'sea surface temperature and state — not drawn', short: 'sea state', drives: NONE };
  }

  // Trend helpers that appear inside TEMPO/BECMG groups.
  if (ctx.forTrend && /^(FM|TL|AT)\d{4}$/.test(text)) {
    const kw = text.slice(0, 2);
    const hhmm = `${text.slice(2, 4)}:${text.slice(4, 6)} UTC`;
    const w = kw === 'FM' ? 'from' : kw === 'TL' ? 'until' : 'at';
    return { kind: 'trend', meaning: `${w} ${hhmm}`, short: `${w} ${hhmm}`, drives: NONE };
  }

  return null;
}

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

function trendLabel(kw: string): string {
  return kw === 'TEMPO' ? 'temporarily' : kw === 'BECMG' ? 'becoming' : kw;
}

/** Parse a METAR or SPECI string. Never throws. */
/** Real METARs, remarks included, stay well under this. Longer input is refused, not parsed. */
export const MAX_METAR_CHARS = 600;

export function parseMetar(input: unknown): Metar {
  const raw = typeof input === 'string' ? input : '';
  const m = emptyMetar(raw);
  if (raw.length > MAX_METAR_CHARS) {
    m.raw = raw.slice(0, MAX_METAR_CHARS);
    m.error = `That is too long for a METAR (over ${MAX_METAR_CHARS} characters).`;
    return m;
  }
  try {
    parseInto(m, raw);
  } catch {
    // Defensive: the parser is written not to throw, but a report must never crash the page.
    m.ok = false;
    m.error = 'This report could not be read.';
  }
  return m;
}

function parseInto(m: Metar, raw: string): void {
  // Upper-case ASCII letters only, so character positions stay identical to `raw`.
  const toks = tokenize(raw.replace(/[a-z]/g, (c) => c.toUpperCase()));
  if (toks.length === 0) {
    m.error = 'The report is empty.';
    return;
  }
  const displayText = (t: RawTok) => raw.slice(t.start, t.end);

  let seenTime = false;
  let i = 0;
  let bodyIndex = 0;
  const pushToken = (t: MetarToken) => m.tokens.push(t);

  while (i < toks.length) {
    const t = toks[i]!;
    const text = t.text;

    if (text === 'RMK') {
      const last = toks[toks.length - 1]!;
      pushToken({
        text: raw.slice(t.start, last.end),
        start: t.start,
        end: last.end,
        kind: 'remarks',
        meaning: 'remarks — extra local notes for pilots; not decoded and not drawn',
        short: 'remarks',
        drives: NONE,
        section: 'remarks',
      });
      break;
    }

    if (TREND_KEYWORDS.has(text)) {
      if (text === 'NOSIG') {
        pushToken({
          text: displayText(t),
          start: t.start,
          end: t.end,
          kind: 'trend',
          meaning: 'no significant change expected in the next 2 hours — a forecast, not drawn',
          short: 'no significant change',
          drives: NONE,
          section: 'trend',
        });
        i += 1;
        continue;
      }
      // Gather the group until the next trend keyword or RMK.
      let j = i + 1;
      while (j < toks.length && !TREND_KEYWORDS.has(toks[j]!.text) && toks[j]!.text !== 'RMK') j += 1;
      const parts: string[] = [];
      for (let k = i + 1; k < j; k += 1) {
        const sub = toks[k]!;
        const merged = mergeMiles(toks, k);
        const c = classify(merged ? merged.text : sub.text, { m, index: k, seenTime, forTrend: true });
        if (merged) k = merged.next - 1;
        parts.push(c ? c.short : sub.text);
      }
      const end = toks[j - 1]!.end;
      pushToken({
        text: raw.slice(t.start, end),
        start: t.start,
        end,
        kind: 'trend',
        meaning: `forecast, ${trendLabel(text)}${parts.length ? `: ${parts.join(', ')}` : ''} — not drawn; the sky shows the current report`,
        short: `${trendLabel(text)}`,
        drives: NONE,
        section: 'trend',
      });
      i = j;
      continue;
    }

    // Wind shear: "WS R27L", "WS RWY27L", "WS ALL RWY".
    if (text === 'WS') {
      let j = i + 1;
      if (toks[j]?.text === 'ALL' && toks[j + 1]?.text === 'RWY') j += 2;
      else if (toks[j] && /^(R|RWY)\d{2}[LCR]?$/.test(toks[j]!.text)) j += 1;
      const end = toks[j - 1]!.end;
      pushToken({
        text: raw.slice(t.start, end),
        start: t.start,
        end,
        kind: 'windShear',
        meaning: 'wind shear reported near the runway — not drawn',
        short: 'wind shear',
        drives: NONE,
        section: 'body',
      });
      i = j;
      continue;
    }

    const merged = mergeMiles(toks, i);
    const groupText = merged ? merged.text : text;
    const endTok = merged ? toks[merged.next - 1]! : t;

    const c = classify(groupText, { m, index: bodyIndex, seenTime, forTrend: false });
    const token: MetarToken = {
      text: raw.slice(t.start, endTok.end),
      start: t.start,
      end: endTok.end,
      kind: c ? c.kind : 'unknown',
      meaning: c ? c.meaning : 'not decoded — this group is not drawn',
      short: c ? c.short : groupText,
      drives: c ? c.drives : NONE,
      section: 'body',
    };
    if (c?.apply) c.apply(m);
    if (c?.kind === 'cloud' && m.clouds.length > 0) m.clouds[m.clouds.length - 1]!.tokenIndex = m.tokens.length;
    if (c?.kind === 'time') seenTime = true;
    if (!c) m.unparsed.push(groupText);
    pushToken(token);
    bodyIndex += 1;
    i = merged ? merged.next : i + 1;
  }

  // A report with CAVOK or clear-sky codes has no layers; one with nothing at all is "unreported".
  if (m.nil) {
    m.ok = false;
    m.error = `${m.station ?? 'The station'} sent a NIL report — no observation is available.`;
    return;
  }
  const hasWeatherData =
    m.wind !== null || m.visibility !== null || m.clouds.length > 0 || m.sky !== 'unreported' || m.temperatureC !== null;
  if (!m.station || !hasWeatherData) {
    m.ok = false;
    m.error = !m.station
      ? "This doesn't look like a METAR — it should start with a 4-letter station code, like EGLL."
      : 'This report has no weather groups that could be read.';
    return;
  }
  m.ok = true;
}

/** "1 1/2SM" arrives as two groups; join them so the visibility reads as one value. */
function mergeMiles(toks: RawTok[], i: number): { text: string; next: number } | null {
  const a = toks[i];
  const b = toks[i + 1];
  if (a && b && /^\d{1,2}$/.test(a.text) && /^\d\/\d{1,2}SM$/.test(b.text)) {
    return { text: `${a.text} ${b.text}`, next: i + 2 };
  }
  return null;
}
