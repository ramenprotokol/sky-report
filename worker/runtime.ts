/**
 * The Cloudflare side of /api/*, shared by both ways of running it: the standalone Worker
 * (index.ts) and the Pages Function (functions/api/[[path]].ts), which is what the live
 * pages.dev site uses. Both hand the same handler the platform's fetch, the Cache API and one
 * memory cache per isolate, so the two deployments cannot drift apart.
 */
import { handleRequest, MemoryCache, type CacheLike } from './handler.ts';

declare const caches: { default: CacheLike } | undefined;

/** Lives as long as this isolate: a fallback where the Cache API has nothing (e.g. workers.dev). */
const memory = new MemoryCache();

export function serveApi(req: Request, waitUntil: (p: Promise<unknown>) => void): Promise<Response> {
  return handleRequest(req, {
    fetch: (input, init) => fetch(input, init),
    // Always defined on Cloudflare; the check only matters for runtimes without the Cache API.
    cache: typeof caches === 'undefined' ? null : caches.default,
    memory,
    waitUntil,
  });
}
