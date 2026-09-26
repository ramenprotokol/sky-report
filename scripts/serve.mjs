// A tiny static server for dist/ that applies public/_headers, so local runs get the
// production CSP. It serves files only: live reports need the Worker (npm run dev).
// Usage: npm run serve [-- --port 8080]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

/**
 * Parse a Cloudflare `_headers` file: a path pattern on its own line, then indented
 * `Name: value` lines, or `! Name` to detach a header set by an earlier matching rule.
 */
export function parseHeaders(text) {
  const rules = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      cur = { pattern: line.trim(), set: [], detach: [] };
      rules.push(cur);
    } else if (cur) {
      const t = line.trim();
      if (t.startsWith('!')) {
        cur.detach.push(t.slice(1).trim().toLowerCase());
        continue;
      }
      const i = t.indexOf(':');
      cur.set.push([t.slice(0, i).trim().toLowerCase(), t.slice(i + 1).trim()]);
    }
  }
  return rules;
}

function matches(pattern, path) {
  if (pattern.endsWith('*')) return path.startsWith(pattern.slice(0, -1));
  return path === pattern;
}

/**
 * The headers Cloudflare would send for a path: every matching rule applies, in file order.
 * A header set by more than one rule is joined with ", " (as Cloudflare documents), and
 * `! Name` removes what earlier rules set. So a catch-all `Cache-Control: no-cache` plus a
 * long cache on /assets/* really does give "no-cache, public, max-age=…" — tests catch that.
 */
export function headersFor(rules, path) {
  const out = {};
  for (const r of rules) {
    if (!matches(r.pattern, path)) continue;
    for (const name of r.detach) delete out[name];
    for (const [name, value] of r.set) out[name] = name in out ? `${out[name]}, ${value}` : value;
  }
  return out;
}

export async function startServer(dir, port = 0) {
  const rules = parseHeaders(await readFile(join(dir, '_headers'), 'utf8').catch(() => ''));
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        // No Worker here. Answer in the API's JSON shape so the page falls back to its
        // recorded samples quietly (a 404 would show up as a console error).
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ error: 'no_worker', message: 'Live reports need the sky-report Worker (npm run dev); this is the static server.' }));
        return;
      }
      let path = decodeURIComponent(url.pathname);
      if (path.endsWith('/')) path += 'index.html';
      const file = normalize(join(dir, path));
      if (!file.startsWith(normalize(dir))) {
        res.writeHead(403).end();
        return;
      }
      const s = await stat(file).catch(() => null);
      if (!s || !s.isFile() || path.split('/').pop() === '_headers') {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
        return;
      }
      const headers = { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' };
      Object.assign(headers, headersFor(rules, url.pathname));
      res.writeHead(200, headers).end(await readFile(file));
    } catch {
      res.writeHead(500).end();
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const i = process.argv.indexOf('--port');
  const port = i > 0 ? Number(process.argv[i + 1]) : 8080;
  const dir = fileURLToPath(new URL('../dist', import.meta.url));
  const server = await startServer(dir, port);
  console.log(`serving dist/ on http://127.0.0.1:${server.address().port} (static only; live reports need npm run dev)`);
}
