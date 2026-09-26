import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  handleRequest,
  normaliseId,
  toPayload,
  readCapped,
  MemoryCache as IsolateCache,
  UPSTREAM,
  USER_AGENT,
  CACHE_SECONDS,
  MAX_UPSTREAM_BYTES,
  MEMORY_CACHE_ENTRIES,
  type CacheLike,
  type Deps,
} from '../../worker/handler.ts';
import worker from '../../worker/index.ts';

/** In-memory stand-in for the Workers Cache API, honouring Cache-Control max-age like the real one. */
class MemoryCache implements CacheLike {
  store = new Map<string, { body: string; status: number; headers: [string, string][]; expires: number }>();
  puts = 0;
  clock: () => number;
  constructor(clock: () => number) {
    this.clock = clock;
  }
  async match(key: Request) {
    const e = this.store.get(key.url);
    if (!e || e.expires <= this.clock()) return undefined;
    return new Response(e.body, { status: e.status, headers: e.headers });
  }
  async put(key: Request, res: Response) {
    const cc = res.headers.get('cache-control') ?? '';
    const age = Number(/max-age=(\d+)/.exec(cc)?.[1] ?? '0');
    if (/no-store/.test(cc) || age <= 0) throw new Error('413: not cacheable');
    this.puts += 1;
    this.store.set(key.url, { body: await res.text(), status: res.status, headers: [...res.headers], expires: this.clock() + age * 1000 });
  }
}

const EGLL_JSON = JSON.stringify([
  {
    icaoId: 'EGLL',
    receiptTime: '2026-09-26T06:54:10.698Z',
    obsTime: 1790405400,
    reportTime: '2026-09-26T07:00:00.000Z',
    temp: 12,
    dewp: 10,
    wdir: 'VRB',
    wspd: 2,
    visib: '6+',
    altim: 1023,
    rawOb: 'METAR EGLL 260650Z AUTO VRB02KT 9999 NCD 12/10 Q1023',
    lat: 51.477,
    lon: -0.461,
    elev: 26,
    name: 'London/Heathrow Intl, EN, GB',
    cover: 'CLR',
    clouds: [],
    fltCat: 'VFR',
  },
]);

interface Harness {
  deps: Deps;
  calls: Array<{ url: string; init?: RequestInit }>;
  cache: MemoryCache;
  advance: (ms: number) => void;
  pending: Promise<unknown>[];
}

function harness(respond: (url: string, init?: RequestInit) => Promise<Response> | Response, opts: { timeoutMs?: number } = {}): Harness {
  let now = Date.UTC(2026, 8, 26, 7, 0, 0);
  const cache = new MemoryCache(() => now);
  const calls: Harness['calls'] = [];
  const pending: Promise<unknown>[] = [];
  const deps: Deps = {
    fetch: async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      calls.push({ url, init });
      return respond(url, init);
    },
    cache,
    waitUntil: (p) => pending.push(p),
    now: () => now,
    timeoutMs: opts.timeoutMs,
  };
  return { deps, calls, cache, advance: (ms) => (now += ms), pending };
}

const req = (q: string, method = 'GET') => new Request(`https://sky.example/api/metar${q}`, { method });

async function body(res: Response) {
  return JSON.parse(await res.text()) as Record<string, unknown>;
}

describe('input validation', () => {
  test('normaliseId accepts 4 alphanumerics starting with a letter, any case, trimmed', () => {
    assert.equal(normaliseId('egll'), 'EGLL');
    assert.equal(normaliseId(' KSFO '), 'KSFO');
    assert.equal(normaliseId('K1B1'), 'K1B1');
    for (const bad of [null, '', 'EGL', 'EGLLX', '1234', 'EG L', 'EG<s', 'ÉGLL', 'x'.repeat(10_000)]) assert.equal(normaliseId(bad), null, String(bad).slice(0, 20));
  });

  for (const q of ['', '?id=', '?id=EG', '?id=EGLL1', '?id=EG%3Cscript%3E', '?id=12AB']) {
    test(`rejects "${q}" with 400 and never calls upstream`, async () => {
      const h = harness(() => new Response(EGLL_JSON));
      const res = await handleRequest(req(q), h.deps);
      assert.equal(res.status, 400);
      const b = await body(res);
      assert.equal(b.error, 'invalid_id');
      assert.match(String(b.message), /4-character ICAO/);
      assert.equal(h.calls.length, 0);
    });
  }

  test('POST is refused with 405; unknown paths are 404', async () => {
    const h = harness(() => new Response(EGLL_JSON));
    assert.equal((await handleRequest(req('?id=EGLL', 'POST'), h.deps)).status, 405);
    assert.equal((await handleRequest(new Request('https://sky.example/api/other'), h.deps)).status, 404);
    assert.equal(h.calls.length, 0);
  });
});

describe('happy path', () => {
  test('returns the report, station position and attribution', async () => {
    const h = harness(() => new Response(EGLL_JSON, { headers: { 'content-type': 'application/json' } }));
    const res = await handleRequest(req('?id=egll'), h.deps);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    assert.equal(res.headers.get('x-cache'), 'MISS');
    const b = await body(res);
    assert.equal(b.id, 'EGLL');
    assert.equal(b.raw, 'METAR EGLL 260650Z AUTO VRB02KT 9999 NCD 12/10 Q1023');
    assert.equal(b.obsTime, 1790405400);
    assert.deepEqual(b.station, { name: 'London/Heathrow Intl, EN, GB', lat: 51.477, lon: -0.461, elevM: 26 });
    assert.match(String(b.attribution), /aviationweather\.gov/);
  });

  test('asks the documented endpoint with a descriptive User-Agent', async () => {
    const h = harness(() => new Response(EGLL_JSON));
    await handleRequest(req('?id=EGLL'), h.deps);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0]!.url, `${UPSTREAM}?ids=EGLL&format=json`);
    const headers = new Headers(h.calls[0]!.init?.headers);
    assert.equal(headers.get('user-agent'), USER_AGENT);
    assert.ok(h.calls[0]!.init?.signal instanceof AbortSignal);
  });

  test('missing station coordinates come back as null (the page falls back to neutral daylight)', async () => {
    const rec = JSON.parse(EGLL_JSON)[0];
    delete rec.lat;
    rec.lon = 999;
    const h = harness(() => new Response(JSON.stringify([rec])));
    const b = await body(await handleRequest(req('?id=EGLL'), h.deps));
    assert.deepEqual([(b.station as Record<string, unknown>).lat, (b.station as Record<string, unknown>).lon], [null, null]);
  });
});

describe('caching (5 minutes, one upstream request serves many views)', () => {
  test('second request within 5 minutes is a HIT with no upstream call', async () => {
    const h = harness(() => new Response(EGLL_JSON));
    const a = await handleRequest(req('?id=EGLL'), h.deps);
    await Promise.all(h.pending);
    h.advance(60_000);
    const b = await handleRequest(req('?id=egll&x=1'), h.deps);
    assert.equal(a.headers.get('x-cache'), 'MISS');
    assert.equal(b.headers.get('x-cache'), 'HIT');
    assert.equal(h.calls.length, 1);
    assert.deepEqual(await body(b), await body(a));
    assert.equal(b.headers.get('cache-control'), 'public, max-age=60');
  });

  test('100 views in 5 minutes cost one upstream request', async () => {
    const h = harness(() => new Response(EGLL_JSON));
    for (let i = 0; i < 100; i++) {
      await handleRequest(req('?id=EGLL'), h.deps);
      await Promise.all(h.pending);
      h.advance(2_900);
    }
    assert.equal(h.calls.length, 1);
  });

  test('after 5 minutes the entry expires and upstream is asked again', async () => {
    const h = harness(() => new Response(EGLL_JSON));
    await handleRequest(req('?id=EGLL'), h.deps);
    await Promise.all(h.pending);
    h.advance(CACHE_SECONDS * 1000 + 1);
    const res = await handleRequest(req('?id=EGLL'), h.deps);
    assert.equal(res.headers.get('x-cache'), 'MISS');
    assert.equal(h.calls.length, 2);
  });

  test('stations are cached separately', async () => {
    const h = harness((url) => new Response(url.includes('KSFO') ? EGLL_JSON.replaceAll('EGLL', 'KSFO') : EGLL_JSON));
    await handleRequest(req('?id=EGLL'), h.deps);
    await handleRequest(req('?id=KSFO'), h.deps);
    await Promise.all(h.pending);
    assert.equal(h.cache.store.size, 2);
  });

  test('works without a cache (e.g. a preview environment)', async () => {
    const h = harness(() => new Response(EGLL_JSON));
    h.deps.cache = null;
    assert.equal((await handleRequest(req('?id=EGLL'), h.deps)).status, 200);
  });
});

describe('per-isolate memory cache (fallback where the Cache API does not work, e.g. workers.dev)', () => {
  test('with no Cache API, 100 views in 5 minutes on one isolate still cost one upstream request', async () => {
    const h = harness(() => new Response(EGLL_JSON));
    h.deps.cache = null;
    h.deps.memory = new IsolateCache();
    const first = await handleRequest(req('?id=EGLL'), h.deps);
    assert.equal(first.headers.get('x-cache'), 'MISS');
    let last: Response = first;
    for (let i = 0; i < 99; i++) {
      h.advance(2_900);
      last = await handleRequest(req('?id=egll'), h.deps);
    }
    assert.equal(h.calls.length, 1);
    assert.equal(last.headers.get('x-cache'), 'HIT-MEMORY');
    assert.equal(last.headers.get('cache-control'), 'public, max-age=60');
    assert.deepEqual(await body(last), await body(first));
  });

  test('entries expire after 5 minutes', async () => {
    const h = harness(() => new Response(EGLL_JSON));
    h.deps.cache = null;
    h.deps.memory = new IsolateCache();
    await handleRequest(req('?id=EGLL'), h.deps);
    h.advance(CACHE_SECONDS * 1000 + 1);
    assert.equal((await handleRequest(req('?id=EGLL'), h.deps)).headers.get('x-cache'), 'MISS');
    assert.equal(h.calls.length, 2);
  });

  test('unknown stations are remembered too; errors are not', async () => {
    let status = 204;
    const h = harness(() => new Response(null, { status }));
    h.deps.cache = null;
    h.deps.memory = new IsolateCache();
    await handleRequest(req('?id=ZZZZ'), h.deps);
    assert.equal((await body(await handleRequest(req('?id=ZZZZ'), h.deps))).error, 'unknown_station');
    assert.equal(h.calls.length, 1);
    status = 500;
    await handleRequest(req('?id=EGLL'), h.deps);
    await handleRequest(req('?id=EGLL'), h.deps);
    assert.equal(h.calls.length, 3);
  });

  test('bounded: the oldest station is dropped when full', () => {
    const m = new IsolateCache(3);
    for (const id of ['AAAA', 'BBBB', 'CCCC', 'DDDD']) m.set(id, { expires: 10, status: 200, body: id });
    assert.equal(m.size, 3);
    assert.equal(m.get('AAAA', 0), null);
    assert.equal(m.get('DDDD', 0)?.body, 'DDDD');
    assert.ok(MEMORY_CACHE_ENTRIES <= 1000);
  });

  test('the Cache API still answers first when it has the entry', async () => {
    const h = harness(() => new Response(EGLL_JSON));
    h.deps.memory = new IsolateCache();
    await handleRequest(req('?id=EGLL'), h.deps);
    await Promise.all(h.pending);
    assert.equal((await handleRequest(req('?id=EGLL'), h.deps)).headers.get('x-cache'), 'HIT');
  });
});

describe('errors', () => {
  test('unknown station: upstream 204 → 200 with error unknown_station, and the answer is cached', async () => {
    const h = harness(() => new Response(null, { status: 204 }));
    const res = await handleRequest(req('?id=ZZZZ'), h.deps);
    assert.equal(res.status, 200);
    const b = await body(res);
    assert.equal(b.error, 'unknown_station');
    assert.match(String(b.message), /No recent report/);
    await Promise.all(h.pending);
    const again = await handleRequest(req('?id=ZZZZ'), h.deps);
    assert.equal((await body(again)).error, 'unknown_station');
    assert.equal(again.headers.get('x-cache'), 'HIT');
    assert.equal(h.calls.length, 1);
  });

  test('unknown station: an empty array, upstream 400, or a record for another station', async () => {
    for (const [payload, status] of [['[]', 200], ['', 200], ['bad ids', 400], [JSON.stringify([{ icaoId: 'KSFO', rawOb: 'METAR KSFO ...' }]), 200]] as const) {
      const h = harness(() => new Response(payload, { status }));
      assert.equal((await body(await handleRequest(req('?id=ZZZZ'), h.deps))).error, 'unknown_station', payload);
    }
  });

  test('upstream 500 → 502 upstream_error, not cached', async () => {
    const h = harness(() => new Response('oops', { status: 500 }));
    const res = await handleRequest(req('?id=EGLL'), h.deps);
    assert.equal(res.status, 502);
    assert.equal((await body(res)).error, 'upstream_error');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    await handleRequest(req('?id=EGLL'), h.deps);
    assert.equal(h.calls.length, 2);
    assert.equal(h.cache.puts, 0);
  });

  test('upstream 429 (rate limited) → 502', async () => {
    const h = harness(() => new Response('slow down', { status: 429 }));
    assert.equal((await handleRequest(req('?id=EGLL'), h.deps)).status, 502);
  });

  test('network failure → 502', async () => {
    const h = harness(() => {
      throw new TypeError('fetch failed');
    });
    assert.equal((await handleRequest(req('?id=EGLL'), h.deps)).status, 502);
  });

  test('malformed JSON → 502', async () => {
    const h = harness(() => new Response('{not json'));
    assert.equal((await handleRequest(req('?id=EGLL'), h.deps)).status, 502);
  });

  test('oversized upstream body → 502, never parsed', async () => {
    const h = harness(() => new Response('[' + ' '.repeat(MAX_UPSTREAM_BYTES + 10) + ']'));
    assert.equal((await handleRequest(req('?id=EGLL'), h.deps)).status, 502);
  });

  test('an endless upstream body is cut off at the cap while streaming, not buffered whole', async () => {
    const CHUNK = 8 * 1024;
    let pulled = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        pulled += CHUNK;
        ctrl.enqueue(new Uint8Array(CHUNK).fill(32));
      },
      cancel() {
        cancelled = true;
      },
    });
    const h = harness(() => new Response(endless, { status: 200 }));
    const res = await handleRequest(req('?id=EGLL'), h.deps);
    assert.equal(res.status, 502);
    assert.equal(cancelled, true);
    // At most the cap plus a chunk or two of read-ahead was ever pulled.
    assert.ok(pulled <= MAX_UPSTREAM_BYTES + 3 * CHUNK, `pulled ${pulled} bytes`);
  });

  test('readCapped: a lying content-length is refused up front; a small body is read exactly', async () => {
    const big = new Response('x', { headers: { 'content-length': String(MAX_UPSTREAM_BYTES + 1) } });
    assert.equal(await readCapped(big), null);
    assert.equal(await readCapped(new Response('é[]')), 'é[]');
    assert.equal(await readCapped(new Response('abcdef'), 5), null);
    assert.equal(await readCapped(new Response('abcde'), 5), 'abcde');
  });

  test('slow upstream is cut off at the timeout → 504 upstream_timeout', async () => {
    const h = harness(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
      { timeoutMs: 30 },
    );
    const started = Date.now();
    const res = await handleRequest(req('?id=EGLL'), h.deps);
    assert.equal(res.status, 504);
    assert.equal((await body(res)).error, 'upstream_timeout');
    assert.ok(Date.now() - started < 1000);
  });
});

describe('toPayload', () => {
  test('caps long strings and rejects non-arrays', () => {
    assert.equal(toPayload('EGLL', { rawOb: 'x' }, 0), null);
    const p = toPayload('EGLL', [{ icaoId: 'EGLL', rawOb: 'M'.repeat(5000), name: 'N'.repeat(500) }], 0);
    assert.equal(p?.raw.length, 600);
    assert.equal(p?.station.name?.length, 120);
  });
});

describe('Worker entry', () => {
  test('non-API paths go to the static assets binding', async () => {
    let assetCalls = 0;
    const env = { ASSETS: { fetch: async () => (assetCalls++, new Response('<!doctype html>', { status: 200 })) } };
    const res = await worker.fetch(new Request('https://sky.example/'), env, { waitUntil: () => {} });
    assert.equal(res.status, 200);
    assert.equal(assetCalls, 1);
  });
});
