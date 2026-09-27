// The Cloudflare Pages build, checked with Wrangler itself (local only, nothing is deployed):
// the Pages Function compiles with Pages' own bundler, only /api/* invokes it (so static files
// stay free), and `wrangler pages dev dist` answers /api/* with the handler's JSON while the
// page keeps its _headers. No request here reaches aviationweather.gov: every API call is one
// the handler answers before going upstream. Skipped when Wrangler is not installed
// (set WRANGLER to its path if it is not on PATH). Requires `npm run build` first.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep } from '../../scripts/cdp.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const WRANGLER = process.env.WRANGLER ?? 'wrangler';
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
const hasWrangler = spawnSync(WRANGLER, ['--version'], { encoding: 'utf8', env }).status === 0;

/** A port that was free a moment ago (other builds share this machine). */
async function freePort() {
  const srv = createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

let tmp;
before(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'sky-report-pages-'));
});
after(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe('Cloudflare Pages', { skip: hasWrangler ? false : 'Wrangler not found (set WRANGLER)' }, () => {
  test('the Function compiles, and only /api/* invokes it', async () => {
    const r = spawnSync(
      WRANGLER,
      ['pages', 'functions', 'build', '--outdir', join(tmp, 'fn'), '--output-routes-path', join(tmp, '_routes.json'), '--compatibility-date', '2025-09-01'],
      { cwd: root, encoding: 'utf8', env, timeout: 120_000 },
    );
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const routes = JSON.parse(await readFile(join(tmp, '_routes.json'), 'utf8'));
    assert.deepEqual(routes.include, ['/api/*']);
    assert.deepEqual(routes.exclude, []);
  });

  describe('wrangler pages dev dist', () => {
    let proc;
    let base;
    let log = '';
    before(async () => {
      const [port, inspector] = [await freePort(), await freePort()];
      const args = ['pages', 'dev', 'dist', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(inspector)];
      args.push('--persist-to', join(tmp, 'state'), '--compatibility-date', '2025-09-01', '--show-interactive-dev-session=false');
      // Its own process group, so wrangler and the workerd it starts can be stopped together.
      proc = spawn(WRANGLER, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      proc.stdout.on('data', (d) => (log += d));
      proc.stderr.on('data', (d) => (log += d));
      base = `http://127.0.0.1:${port}`;
      for (let i = 0; i < 240; i++) {
        if (proc.exitCode !== null) break;
        if (await fetch(`${base}/`).then((r) => r.ok, () => false)) return;
        await sleep(250);
      }
      throw new Error(`wrangler pages dev did not start:\n${log}`);
    });
    after(async () => {
      if (!proc || proc.exitCode !== null) return;
      const exited = new Promise((resolve) => proc.once('exit', resolve));
      try {
        process.kill(-proc.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
      await Promise.race([exited, sleep(5000)]);
      if (proc.exitCode === null) {
        try {
          process.kill(-proc.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    });

    test('the page is served with its _headers (CSP allows the same-origin API call)', async () => {
      const res = await fetch(`${base}/`);
      assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
      assert.equal(res.headers.get('cache-control'), 'no-cache');
      assert.match(res.headers.get('content-security-policy') ?? '', /connect-src 'self'/);
    });

    test('/api/metar is the Function: bad ids get the handler\'s 400 JSON', async () => {
      for (const q of ['?id=EG', '?id=12AB', '']) {
        const res = await fetch(`${base}/api/metar${q}`);
        assert.equal(res.status, 400, q);
        assert.match(res.headers.get('content-type') ?? '', /^application\/json/);
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
        assert.equal((await res.json()).error, 'invalid_id');
      }
    });

    test('the rest of /api/* is the Function too: 404 and 405 as JSON, never the page', async () => {
      const other = await fetch(`${base}/api/nope`);
      assert.equal(other.status, 404);
      assert.equal((await other.json()).error, 'not_found');
      const post = await fetch(`${base}/api/metar?id=EGLL`, { method: 'POST' });
      assert.equal(post.status, 405);
      assert.equal(post.headers.get('allow'), 'GET, HEAD');
    });
  });
});
