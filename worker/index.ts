/**
 * Cloudflare Worker entry. Static files in dist/ are served by the assets binding;
 * only /api/* reaches this code (see run_worker_first in wrangler.toml).
 */
import { handleRequest, type CacheLike } from './handler.ts';

interface Env {
  ASSETS: { fetch: (req: Request) => Promise<Response> };
}

interface Ctx {
  waitUntil(p: Promise<unknown>): void;
}

declare const caches: { default: CacheLike };

export default {
  async fetch(req: Request, env: Env, ctx: Ctx): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      return handleRequest(req, {
        fetch: (input, init) => fetch(input, init),
        cache: caches.default,
        waitUntil: (p) => ctx.waitUntil(p),
      });
    }
    return env.ASSETS.fetch(req);
  },
};
