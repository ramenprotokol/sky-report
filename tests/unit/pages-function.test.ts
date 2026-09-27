// The Pages Function (functions/api/[[path]].ts) is how the live Pages site answers /api/*.
// These tests call it the way Cloudflare Pages does ({ request, waitUntil }), with a mocked
// upstream fetch and a stand-in Cache API installed as globals, like the Workers runtime has.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../../functions/api/[[path]].ts';
import worker from '../../worker/index.ts';
import { UPSTREAM, USER_AGENT } from '../../worker/handler.ts';

/** Stand-in for caches.default: it refuses, like the real one, what is not cacheable. */
class FakeCache {
  store = new Map<string, { body: string; status: number; headers: [string, string][] }>();
  async match(key: Request) {
    const e = this.store.get(key.url);
    return e ? new Response(e.body, { status: e.status, headers: e.headers }) : undefined;
  }
  async put(key: Request, res: Response) {
    if (!/max-age=[1-9]/.test(res.headers.get('cache-control') ?? '')) throw new Error('not cacheable');
    this.store.set(key.url, { body: await res.text(), status: res.status, headers: [...res.headers] });
  }
}

/** A synthetic upstream answer in the aviationweather.gov JSON shape. */
function upstreamFor(url: string): Response {
  const id = new URL(url).searchParams.get('ids') ?? '';
  if (id === 'ZZZZ') return new Response(null, { status: 204 });
  const rec = { icaoId: id, obsTime: 1790405400, rawOb: `METAR ${id} 260650Z 27010KT 9999 FEW030 14/08 Q1015`, lat: 10.5, lon: -20.25, elev: 12, name: `Test field ${id}` };
  return new Response(JSON.stringify([rec]), { headers: { 'content-type': 'application/json' } });
}

const g = globalThis as unknown as { fetch: typeof fetch; caches?: { default: FakeCache } };
const realFetch = g.fetch;
let upstream: Array<{ url: string; init?: RequestInit }>;
let waits: Promise<unknown>[];

function ctx(path: string, method = 'GET') {
  return { request: new Request(`https://sky-report.example.pages.dev${path}`, { method }), waitUntil: (p: Promise<unknown>) => void waits.push(p) };
}

async function body(res: Response) {
  return JSON.parse(await res.text()) as Record<string, unknown>;
}

beforeEach(() => {
  upstream = [];
  waits = [];
  g.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    upstream.push({ url, init });
    return upstreamFor(url);
  }) as typeof fetch;
});
afterEach(() => {
  g.fetch = realFetch;
  delete g.caches;
});

describe('Pages Function /api/*', () => {
  test('GET /api/metar runs the shared handler: one upstream call, then the Cache API answers', async () => {
    g.caches = { default: new FakeCache() };
    const first = await onRequest(ctx('/api/metar?id=egll'));
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('x-cache'), 'MISS');
    assert.match(first.headers.get('content-type') ?? '', /^application\/json/);
    const b = await body(first);
    assert.equal(b.id, 'EGLL');
    assert.match(String(b.raw), /^METAR EGLL /);
    assert.equal(upstream.length, 1);
    assert.equal(upstream[0]!.url, `${UPSTREAM}?ids=EGLL&format=json`);
    assert.equal(new Headers(upstream[0]!.init?.headers).get('user-agent'), USER_AGENT);
    // The cache write goes through the Pages context's waitUntil, not the response path.
    assert.equal(waits.length, 1);
    await Promise.all(waits);

    const second = await onRequest(ctx('/api/metar?id=EGLL'));
    assert.equal(second.status, 200);
    assert.equal(second.headers.get('x-cache'), 'HIT');
    assert.equal((await body(second)).id, 'EGLL');
    assert.equal(upstream.length, 1, 'served from the cache');
  });

  test('without the Cache API, the per-isolate memory cache still saves the upstream call', async () => {
    const first = await onRequest(ctx('/api/metar?id=KSFO'));
    assert.equal(first.headers.get('x-cache'), 'MISS');
    const second = await onRequest(ctx('/api/metar?id=ksfo'));
    assert.equal(second.headers.get('x-cache'), 'HIT-MEMORY');
    assert.equal((await body(second)).id, 'KSFO');
    assert.equal(upstream.length, 1);
  });

  test('an unknown station is a 200 with unknown_station, which the page shows as "no report"', async () => {
    const res = await onRequest(ctx('/api/metar?id=ZZZZ'));
    assert.equal(res.status, 200);
    assert.equal((await body(res)).error, 'unknown_station');
    assert.equal(upstream.length, 1);
  });

  test('bad input never reaches upstream; other paths and methods get JSON errors', async () => {
    for (const q of ['', '?id=', '?id=EG', '?id=12AB', '?id=EG%3Cs%3E']) {
      const res = await onRequest(ctx(`/api/metar${q}`));
      assert.equal(res.status, 400, q);
      assert.equal((await body(res)).error, 'invalid_id', q);
    }
    const other = await onRequest(ctx('/api/other'));
    assert.equal(other.status, 404);
    assert.equal((await body(other)).error, 'not_found');
    const post = await onRequest(ctx('/api/metar?id=EGLL', 'POST'));
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET, HEAD');
    assert.equal(upstream.length, 0);
  });

  test('the Worker entry and the Pages Function share one wiring (and one memory cache)', async () => {
    const viaWorker = await worker.fetch(new Request('https://sky.example/api/metar?id=RJTT'), { ASSETS: { fetch: async () => new Response('asset') } }, { waitUntil: () => {} });
    assert.equal(viaWorker.headers.get('x-cache'), 'MISS');
    const viaPages = await onRequest(ctx('/api/metar?id=RJTT'));
    assert.equal(viaPages.headers.get('x-cache'), 'HIT-MEMORY');
    assert.equal((await body(viaPages)).id, 'RJTT');
    assert.equal(upstream.length, 1);
  });
});
