/**
 * Cloudflare Worker entry. Static files in dist/ are served by the assets binding;
 * only /api/* reaches this code (see run_worker_first in wrangler.toml).
 */
import { serveApi } from './runtime.ts';

interface Env {
  ASSETS: { fetch: (req: Request) => Promise<Response> };
}

interface Ctx {
  waitUntil(p: Promise<unknown>): void;
}

export default {
  async fetch(req: Request, env: Env, ctx: Ctx): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) return serveApi(req, (p) => ctx.waitUntil(p));
    return env.ASSETS.fetch(req);
  },
};
