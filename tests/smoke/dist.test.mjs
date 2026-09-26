// End-to-end smoke test: the built dist/ loads in headless Chrome, draws with WebGL2, logs no
// console errors, works from the keyboard and at phone width, and keeps text contrast ≥ 4.5:1
// (measured from real screenshot pixels, not assumed). Requires `npm run build` first.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../scripts/serve.mjs';
import { launch, findChrome, sleep } from '../../scripts/cdp.mjs';
import { decodePng, luminanceAt, contrast, hexLuminance } from './png.mjs';

const dist = fileURLToPath(new URL('../../dist', import.meta.url));
const chrome = findChrome();
// Google Fonts may be unreachable offline; that is not an app error.
const relevant = (problems) => problems.filter((p) => !/fonts\.(googleapis|gstatic)\.com/.test(p));

let server;
let base;
before(async () => {
  assert.ok(existsSync(join(dist, 'index.html')), 'run npm run build first');
  server = await startServer(dist, 0);
  base = `http://127.0.0.1:${server.address().port}/`;
});
after(() => server?.close());

describe('dist/ contents', () => {
  test('index.html references hashed assets that exist', async () => {
    const html = await readFile(join(dist, 'index.html'), 'utf8');
    const refs = [...html.matchAll(/(?:src|href)="(assets\/[^"]+)"/g)].map((m) => m[1]);
    assert.equal(refs.length, 2, refs.join(', '));
    for (const r of refs) {
      assert.match(r, /-[A-Z0-9]{8}\.(js|css)$/, 'content-hashed name');
      assert.ok(existsSync(join(dist, r)), r);
    }
  });

  test('_headers: strict CSP, long cache only on hashed assets', async () => {
    const h = await readFile(join(dist, '_headers'), 'utf8');
    assert.match(h, /Content-Security-Policy: default-src 'none'; script-src 'self';/);
    assert.match(h, /\/assets\/\*\n\s+Cache-Control: public, max-age=31536000, immutable/);
    assert.match(h, /^\/\*[\s\S]*Cache-Control: no-cache/m);
  });

  test('no source maps and no local paths in the build', async () => {
    const files = await readdir(join(dist, 'assets'));
    assert.ok(!files.some((f) => f.endsWith('.map')));
    for (const f of files) {
      const text = await readFile(join(dist, 'assets', f), 'utf8');
      assert.ok(!/\/Users\/|\/home\/|C:\\\\Users/.test(text), `local path in ${f}`);
    }
  });
});

describe('in headless Chrome', { skip: chrome ? false : 'Chrome not found (set CHROME_PATH)' }, () => {
  test('desktop: draws, explains tokens, keyboard flow, no console errors', async () => {
    const b = await launch({ width: 1280, height: 800 });
    try {
      const status = await b.goto(`${base}?sample=RJTT&still=1`);
      assert.equal(status, 'ready', 'WebGL2 path should run (ready-no-gl means the shader did not)');
      assert.equal(await b.evaluate('document.documentElement.dataset.station'), 'RJTT');
      assert.equal(await b.evaluate('document.documentElement.dataset.origin'), 'sample');
      assert.match(await b.evaluate('document.getElementById("station-obs").textContent'), /RECORDED SAMPLE/);
      const tokens = await b.evaluate('[...document.querySelectorAll("#metar .tok")].map((t) => t.textContent)');
      assert.deepEqual(tokens, ['METAR', 'RJTT', '260630Z', '02011KT', '9999', '-SHRA', 'FEW008', 'BKN010', '20/18', 'Q1012', 'NOSIG']);

      // Hover a cloud group: the one-line meaning appears. (Wait for web fonts so the layout is final.)
      await b.evaluate('document.fonts.ready.then(() => true)');
      await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
      await b.hover('#metar .tok[data-i="7"]');
      await sleep(250);
      assert.match(await b.evaluate('document.getElementById("explain").textContent'), /BKN010broken cloud at 1,000 ft above the airport.*drawn as cloud layer 2/);

      await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 640, y: 300 });

      // Keyboard: focus reaches the tokens with Tab and shows the same explanation.
      await b.evaluate('document.querySelector("#metar .tok[data-i=\\"3\\"]").focus()');
      assert.match(await b.evaluate('document.getElementById("explain").textContent'), /wind from 20° \(north-northeast\) at 11 knots/);

      // Typing a letter opens the bar with that letter; Enter on a bad code explains why.
      await b.evaluate('document.body.focus()');
      await b.key('1');
      assert.equal(await b.evaluate('document.getElementById("bar").hidden'), false);
      await b.key('2');
      await b.key('Enter', '\r');
      await sleep(100);
      assert.match(await b.evaluate('document.getElementById("bar-error").textContent'), /4-character ICAO code/);

      // A valid code with no Worker behind the static server falls back to its recorded sample.
      await b.evaluate('document.getElementById("icao").value = ""');
      for (const k of ['K', 'S', 'F', 'O']) await b.key(k);
      await b.key('Enter', '\r');
      await sleep(600);
      assert.equal(await b.evaluate('document.documentElement.dataset.station'), 'KSFO');
      assert.equal(await b.evaluate('document.documentElement.dataset.origin'), 'sample');
      assert.match(await b.evaluate('document.getElementById("explain").textContent'), /need the sky-report Worker.*recorded KSFO report/);
      assert.equal(await b.evaluate('document.getElementById("bar").hidden'), true);

      // Escape closes the notes dialog.
      await b.evaluate('document.getElementById("how").click()');
      assert.equal(await b.evaluate('document.getElementById("notes").hidden'), false);
      assert.ok((await b.evaluate('document.getElementById("trace").children.length')) >= 3);
      await b.key('Escape');
      assert.equal(await b.evaluate('document.getElementById("notes").hidden'), true);

      assert.deepEqual(relevant(b.problems), []);
    } finally {
      await b.close();
    }
  });

  test('a pasted METAR is drawn and labelled as pasted; bad paste is refused', async () => {
    const b = await launch({ width: 1024, height: 700 });
    try {
      const metar = 'METAR KSFO 260556Z 00000KT 1/4SM FG VV002 12/12 A2996';
      await b.goto(`${base}?metar=${encodeURIComponent(metar)}&still=1`);
      assert.equal(await b.evaluate('document.documentElement.dataset.origin'), 'pasted');
      assert.match(await b.evaluate('document.getElementById("station-obs").textContent'), /PASTED REPORT/);
      await b.goto(`${base}?metar=${encodeURIComponent('not a metar at all')}&still=1`);
      assert.match(await b.evaluate('document.getElementById("explain").textContent'), /could not be read/);
      assert.deepEqual(relevant(b.problems), []);
    } finally {
      await b.close();
    }
  });

  test('prefers-reduced-motion freezes the drift', async () => {
    const b = await launch({ width: 1024, height: 700, reducedMotion: true });
    try {
      await b.goto(`${base}?sample=YSSY`);
      assert.equal(await b.evaluate('document.documentElement.dataset.motion'), 'still');
    } finally {
      await b.close();
    }
    const c = await launch({ width: 1024, height: 700 });
    try {
      await c.goto(`${base}?sample=YSSY`);
      assert.equal(await c.evaluate('document.documentElement.dataset.motion'), 'moving');
    } finally {
      await c.close();
    }
  });

  test('phone width (400 px, device emulation): no horizontal scroll, text fits', async () => {
    const b = await launch({ width: 400, height: 860, deviceScaleFactor: 2, mobile: true });
    try {
      for (const id of ['KJFK', 'CYVR', 'EGLL']) {
        await b.goto(`${base}?sample=${id}&still=1`);
        assert.equal(await b.evaluate('window.innerWidth'), 400);
        assert.equal(await b.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, id);
        const overflow = await b.evaluate(
          '[...document.querySelectorAll(".readout, .chart-label")].some((e) => e.getBoundingClientRect().right > window.innerWidth + 0.5)',
        );
        assert.equal(overflow, false, id);
      }
      assert.deepEqual(relevant(b.problems), []);
    } finally {
      await b.close();
    }
  });

  test('WCAG AA: sky behind every text box stays dark enough for 4.5:1 (measured)', async () => {
    const inkLight = hexLuminance('#dad5cb'); // the dimmer of the two text colours
    const b = await launch({ width: 1280, height: 800 });
    try {
      for (const id of ['VHHH', 'LSZH', 'WSSS', 'EGLL', 'YSSY']) {
        await b.goto(`${base}?sample=${id}&still=1&notext=1&q=medium`);
        await sleep(300);
        const rects = await b.evaluate('window.skyReportTextRects().map((r) => [r.left, r.top, r.right, r.bottom])');
        assert.ok(rects.length >= 8, `${id}: expected text boxes, got ${rects.length}`);
        const img = decodePng(await b.screenshot());
        let worst = 0;
        for (const [l, t, r, btm] of rects) {
          for (let y = Math.ceil(t) + 2; y < Math.floor(btm) - 2; y++) {
            for (let x = Math.ceil(l) + 2; x < Math.floor(r) - 2; x++) {
              if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
              worst = Math.max(worst, luminanceAt(img, x, y));
            }
          }
        }
        const ratio = contrast(inkLight, worst);
        assert.ok(ratio >= 4.5, `${id}: brightest background ${worst.toFixed(3)} gives ${ratio.toFixed(2)}:1`);
      }
    } finally {
      await b.close();
    }
  });
});
