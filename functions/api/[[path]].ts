/**
 * Cloudflare Pages Function for every /api/* path on the Pages site, so the page's same-origin
 * fetch('/api/metar?id=…') is answered by the same handler as the standalone Worker.
 *
 * Wrangler bundles this file (and worker/, which it imports) when `wrangler pages deploy dist`
 * or `wrangler pages dev dist` runs from the repo root, and writes a _routes.json that sends
 * only /api/* here. Every other request is a static file and never invokes a Function.
 */
import { serveApi } from '../../worker/runtime.ts';

interface PagesContext {
  request: Request;
  waitUntil(p: Promise<unknown>): void;
}

export const onRequest = (ctx: PagesContext): Promise<Response> => serveApi(ctx.request, (p) => ctx.waitUntil(p));
