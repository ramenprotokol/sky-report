/** Client for the Worker's /api/metar endpoint. */
import type { ReportSource } from './report.ts';

export type LiveErrorKind = 'invalid' | 'unknown' | 'upstream' | 'unavailable';

export class LiveError extends Error {
  kind: LiveErrorKind;
  constructor(kind: LiveErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Validate the Worker's JSON before it reaches the page. */
export function toSource(body: unknown): ReportSource | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.id !== 'string' || typeof b.raw !== 'string') return null;
  const st = (b.station && typeof b.station === 'object' ? b.station : {}) as Record<string, unknown>;
  return {
    id: b.id.slice(0, 4),
    raw: b.raw.slice(0, 600),
    obsTime: num(b.obsTime),
    station: {
      name: typeof st.name === 'string' ? st.name.slice(0, 120) : null,
      lat: num(st.lat),
      lon: num(st.lon),
      elevM: num(st.elevM),
    },
  };
}

export async function fetchLive(id: string, timeoutMs = 9000): Promise<ReportSource> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`/api/metar?id=${encodeURIComponent(id)}`, { signal: ctrl.signal, headers: { accept: 'application/json' } });
  } catch {
    throw new LiveError('unavailable', 'Live reports are unavailable right now (no connection to the report service).');
  } finally {
    clearTimeout(timer);
  }
  if (!(res.headers.get('content-type') ?? '').includes('application/json')) {
    throw new LiveError('unavailable', 'Live reports need the sky-report Worker, which is not running on this server.');
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new LiveError('upstream', 'The report service sent something unreadable.');
  }
  if (res.ok && !(body && typeof body === 'object' && 'error' in body)) {
    const src = toSource(body);
    if (!src) throw new LiveError('upstream', 'The report service sent something unreadable.');
    return src;
  }
  const b = (body ?? {}) as { error?: string; message?: string };
  const msg = typeof b.message === 'string' ? b.message : 'The report service returned an error.';
  if (b.error === 'no_worker') throw new LiveError('unavailable', msg);
  if (b.error === 'invalid_id') throw new LiveError('invalid', msg);
  if (b.error === 'unknown_station') throw new LiveError('unknown', `${id}: ${msg}`);
  throw new LiveError('upstream', msg);
}
