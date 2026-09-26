/**
 * GET /api/metar?id=XXXX — the latest METAR for one station, proxied from the
 * aviationweather.gov Data API (NOAA / NWS Aviation Weather Center, public US-government data).
 *
 * Kept free of Cloudflare-only types so it runs under Node's test runner with a mocked
 * fetch and cache. The Worker entry (index.ts) passes in the real ones.
 */

export const UPSTREAM = 'https://aviationweather.gov/api/data/metar';
export const CACHE_SECONDS = 300;
/** Unknown stations are cached too, so repeated typos cost one upstream request. */
export const NEGATIVE_CACHE_SECONDS = 300;
export const TIMEOUT_MS = 6000;
/** One station's latest report is ~1 KB of JSON; anything far bigger is not what we asked for. */
export const MAX_UPSTREAM_BYTES = 64 * 1024;
export const USER_AGENT = 'sky-report/0.1 (+https://github.com/ramenprotokol)';
export const ATTRIBUTION = 'METAR data: NOAA / NWS Aviation Weather Center, aviationweather.gov (public US-government data)';

export interface CacheLike {
  match(key: Request): Promise<Response | undefined>;
  put(key: Request, res: Response): Promise<void>;
}

/** Most stations kept by one isolate's in-memory cache. ~1 KB each, so well under 1 MB. */
export const MEMORY_CACHE_ENTRIES = 256;

interface MemoryEntry {
  expires: number;
  status: number;
  body: string;
}

/**
 * A small per-isolate cache in memory, in front of the Cache API. The Cache API only works for
 * a Worker on a custom domain or route (not on *.workers.dev), and is per data centre; this one
 * needs no setup, but lives only as long as one Worker isolate and is not shared between them.
 * Bounded: when full, the oldest entry goes. Entries expire after CACHE_SECONDS.
 */
export class MemoryCache {
  private map = new Map<string, MemoryEntry>();
  private readonly maxEntries: number;
  constructor(maxEntries = MEMORY_CACHE_ENTRIES) {
    this.maxEntries = maxEntries;
  }

  get(key: string, now: number): MemoryEntry | null {
    const e = this.map.get(key);
    if (!e) return null;
    if (e.expires <= now) {
      this.map.delete(key);
      return null;
    }
    return e;
  }

  set(key: string, entry: MemoryEntry): void {
    this.map.delete(key);
    this.map.set(key, entry);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }
}

export interface Deps {
  fetch: (input: Request | string, init?: RequestInit) => Promise<Response>;
  cache: CacheLike | null;
  /** Per-isolate fallback cache (index.ts keeps one per isolate). */
  memory?: MemoryCache | null;
  waitUntil?: (p: Promise<unknown>) => void;
  now?: () => number;
  timeoutMs?: number;
}

export interface MetarPayload {
  id: string;
  raw: string;
  obsTime: number | null;
  station: { name: string | null; lat: number | null; lon: number | null; elevM: number | null };
  fetchedAt: string;
  attribution: string;
}

type ErrorCode = 'invalid_id' | 'unknown_station' | 'upstream_error' | 'upstream_timeout' | 'method_not_allowed' | 'not_found';

const MESSAGES: Record<ErrorCode, string> = {
  invalid_id: 'Use a 4-character ICAO airport code, like EGLL or KSFO.',
  unknown_station: 'No recent report for that code. It may not exist, or the station may not be reporting.',
  upstream_error: 'The aviation weather service returned an error. Try again in a minute.',
  upstream_timeout: 'The aviation weather service took too long to answer. Try again in a minute.',
  method_not_allowed: 'Only GET is supported.',
  not_found: 'Not found.',
};

/**
 * An unknown station is an ordinary answer ("no report for that code"), not a failure, so it is
 * 200 with an error body, much as the upstream answers 204 for "no data". That also keeps a typo
 * from showing up as a failed request in the browser console. Bad input and upstream trouble
 * keep real error statuses.
 */
const STATUS: Record<ErrorCode, number> = {
  invalid_id: 400,
  unknown_station: 200,
  upstream_error: 502,
  upstream_timeout: 504,
  method_not_allowed: 405,
  not_found: 404,
};

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
      ...extra,
    },
  });
}

function error(code: ErrorCode, extra: Record<string, string> = {}): Response {
  return json({ error: code, message: MESSAGES[code] }, STATUS[code], { 'cache-control': 'no-store', ...extra });
}

/** Normalise and validate an ICAO code: exactly 4 letters or digits, first a letter. */
export function normaliseId(raw: string | null): string | null {
  if (raw === null || raw.length > 16) return null;
  const id = raw.trim().toUpperCase();
  return /^[A-Z][A-Z0-9]{3}$/.test(id) ? id : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Pick the fields the page needs from AWC's JSON; reject anything that is not a METAR for this station. */
export function toPayload(id: string, data: unknown, now: number): MetarPayload | null {
  if (!Array.isArray(data) || data.length === 0) return null;
  const rec = data.find((r) => r && typeof r === 'object' && String((r as Record<string, unknown>).icaoId ?? '').toUpperCase() === id) as
    | Record<string, unknown>
    | undefined;
  if (!rec) return null;
  const raw = typeof rec.rawOb === 'string' ? rec.rawOb.slice(0, 600) : null;
  if (!raw) return null;
  const lat = num(rec.lat);
  const lon = num(rec.lon);
  return {
    id,
    raw,
    obsTime: num(rec.obsTime),
    station: {
      name: typeof rec.name === 'string' ? rec.name.slice(0, 120) : null,
      lat: lat !== null && Math.abs(lat) <= 90 ? lat : null,
      lon: lon !== null && Math.abs(lon) <= 180 ? lon : null,
      elevM: num(rec.elev),
    },
    fetchedAt: new Date(now).toISOString(),
    attribution: ATTRIBUTION,
  };
}

/**
 * Read at most MAX_UPSTREAM_BYTES of the body, streaming: an oversized answer is abandoned as soon
 * as it passes the cap, without ever holding more than the cap (plus one chunk) in memory.
 */
export async function readCapped(res: Response, maxBytes = MAX_UPSTREAM_BYTES): Promise<string | null> {
  const len = Number(res.headers.get('content-length') ?? '0');
  if (len > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

export async function handleRequest(req: Request, deps: Deps): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname !== '/api/metar') return error('not_found');
  if (req.method !== 'GET' && req.method !== 'HEAD') return error('method_not_allowed', { allow: 'GET, HEAD' });

  const id = normaliseId(url.searchParams.get('id'));
  if (!id) return error('invalid_id');

  const now = deps.now ? deps.now() : Date.now();
  // One cache entry per station, whatever the query string looked like.
  const cacheKey = new Request(`${url.origin}/api/metar?id=${id}`, { method: 'GET' });
  if (deps.cache) {
    const hit = await deps.cache.match(cacheKey);
    if (hit) {
      const res = new Response(hit.body, hit);
      res.headers.set('cache-control', 'public, max-age=60');
      res.headers.set('x-cache', 'HIT');
      return res;
    }
  }
  const mem = deps.memory?.get(id, now);
  if (mem) {
    return new Response(mem.body, {
      status: mem.status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-content-type-options': 'nosniff',
        'cache-control': 'public, max-age=60',
        'x-cache': 'HIT-MEMORY',
      },
    });
  }

  const upstreamUrl = `${UPSTREAM}?ids=${id}&format=json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await deps.fetch(upstreamUrl, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const aborted = controller.signal.aborted || (e instanceof Error && e.name === 'AbortError');
    return error(aborted ? 'upstream_timeout' : 'upstream_error', { 'x-cache': 'MISS' });
  }

  let payload: MetarPayload | null = null;
  let unknown = false;
  try {
    if (upstream.status === 204) {
      unknown = true;
    } else if (upstream.ok) {
      const text = await readCapped(upstream);
      if (text === null) return error('upstream_error', { 'x-cache': 'MISS' });
      const trimmed = text.trim();
      if (trimmed === '' || trimmed === '[]') unknown = true;
      else {
        payload = toPayload(id, JSON.parse(trimmed), now);
        if (!payload) unknown = true;
      }
    } else if (upstream.status === 400) {
      unknown = true;
    } else {
      return error('upstream_error', { 'x-cache': 'MISS' });
    }
  } catch (e) {
    const aborted = controller.signal.aborted || (e instanceof Error && e.name === 'AbortError');
    return error(aborted ? 'upstream_timeout' : 'upstream_error', { 'x-cache': 'MISS' });
  } finally {
    clearTimeout(timer);
  }

  let bodyText: string;
  let ttl: number;
  if (payload) {
    bodyText = JSON.stringify(payload);
    ttl = CACHE_SECONDS;
  } else if (unknown) {
    bodyText = JSON.stringify({ error: 'unknown_station', message: MESSAGES.unknown_station });
    ttl = NEGATIVE_CACHE_SECONDS;
  } else {
    return error('upstream_error', { 'x-cache': 'MISS' });
  }
  const status = payload ? 200 : STATUS.unknown_station;
  const res = new Response(bodyText, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff', 'cache-control': `public, max-age=${ttl}` },
  });
  deps.memory?.set(id, { expires: now + ttl * 1000, status, body: bodyText });

  if (deps.cache) {
    const put = deps.cache.put(cacheKey, res.clone());
    if (deps.waitUntil) deps.waitUntil(put.catch(() => undefined));
    else await put.catch(() => undefined);
  }
  // Browsers may keep it for a minute; the edge cache holds it for five.
  const out = new Response(res.body, res);
  out.headers.set('cache-control', 'public, max-age=60');
  out.headers.set('x-cache', 'MISS');
  return out;
}
