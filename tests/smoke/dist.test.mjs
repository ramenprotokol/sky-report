// End-to-end smoke test: the built dist/ loads in headless Chrome, draws with WebGL2, logs no
// console errors, works from the keyboard and at phone width, and keeps text contrast ≥ 4.5:1
// (measured from real screenshot pixels, not assumed). Requires `npm run build` first.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, parseHeaders, headersFor } from '../../scripts/serve.mjs';
import { launch, findChrome, sleep } from '../../scripts/cdp.mjs';
import { measureCover, COVER_OPACITY, PROBE_SPAN_KM } from '../../scripts/cover-probe.mjs';
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

  test('_headers, merged the way Cloudflare merges rules: strict CSP, long cache only on hashed assets', async () => {
    const rules = parseHeaders(await readFile(join(dist, '_headers'), 'utf8'));
    const js = (await readdir(join(dist, 'assets'))).find((f) => f.endsWith('.js'));
    const asset = headersFor(rules, `/assets/${js}`);
    assert.equal(asset['cache-control'], 'public, max-age=31536000, immutable');
    assert.match(asset['content-security-policy'], /^default-src 'none'; script-src 'self';/);
    for (const page of ['/', '/index.html']) {
      assert.equal(headersFor(rules, page)['cache-control'], 'no-cache', page);
      assert.match(headersFor(rules, page)['content-security-policy'], /default-src 'none'/, page);
    }
    // Unhashed files get no long cache (the platform default applies).
    assert.equal(headersFor(rules, '/favicon.svg')['cache-control'], undefined);
  });

  test('the merge catches the old bug: a catch-all no-cache would be joined onto the asset rule', () => {
    const old = parseHeaders('/*\n  Cache-Control: no-cache\n\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n');
    assert.equal(headersFor(old, '/assets/a.js')['cache-control'], 'no-cache, public, max-age=31536000, immutable');
    const detached = parseHeaders('/*\n  Cache-Control: no-cache\n\n/assets/*\n  ! Cache-Control\n  Cache-Control: public, max-age=60\n');
    assert.equal(headersFor(detached, '/assets/a.js')['cache-control'], 'public, max-age=60');
  });

  test('the local server sends those headers', async () => {
    const js = (await readdir(join(dist, 'assets'))).find((f) => f.endsWith('.js'));
    const a = await fetch(`${base}assets/${js}`);
    assert.equal(a.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    const page = await fetch(`${base}?id=EGLL`);
    assert.equal(page.headers.get('cache-control'), 'no-cache');
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

      // With a keyboard, the bar's hint says Esc closes it.
      assert.equal(await b.evaluate('getComputedStyle(document.querySelector("#bar-hint .kbd-only")).display !== "none"'), true);
      assert.equal(await b.evaluate('getComputedStyle(document.querySelector("#bar-hint .touch-only")).display'), 'none');

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
      // Tab stays inside the note and reaches its link to the third-party notices.
      assert.equal(await b.evaluate('document.activeElement.id'), 'notes-close');
      await b.key('Tab');
      assert.equal(await b.evaluate('document.activeElement.getAttribute("href")'), 'THIRD-PARTY-NOTICES.txt');
      await b.key('Tab');
      assert.equal(await b.evaluate('document.activeElement.id'), 'notes-close');
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

  test('live lookups: the API answer decides LIVE, "no report", or a labelled recorded sample', async () => {
    const b = await launch({ width: 1024, height: 700 });
    // /api/metar is answered in the browser's network layer, so no request leaves the machine.
    // The HTML answer is what a host with no API sends back: a Pages site without the Function
    // (its fallback page) or one past its daily Functions allowance.
    const answers = {
      KSFO: ['application/json; charset=utf-8', JSON.stringify({ id: 'KSFO', raw: 'METAR KSFO 261756Z 29012KT 10SM FEW015 SCT200 18/12 A2992', obsTime: Date.UTC(2026, 8, 26, 17, 56) / 1000, station: { name: 'Test field', lat: 37.62, lon: -122.37, elevM: 3 } })],
      ZZZZ: ['application/json; charset=utf-8', JSON.stringify({ error: 'unknown_station', message: 'No recent report for that code.' })],
      EGLL: ['text/html; charset=utf-8', '<!doctype html><title>sky-report</title>'],
    };
    const asked = [];
    b.on('Fetch.requestPaused', ({ requestId, request }) => {
      const id = new URL(request.url).searchParams.get('id');
      asked.push(id);
      const [type, text] = answers[id] ?? answers.ZZZZ;
      void b.send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: type }], body: Buffer.from(text).toString('base64') });
    });
    const until = async (expr) => {
      for (let i = 0; i < 200; i++) {
        if (await b.evaluate(expr)) return;
        await sleep(100);
      }
      const state = await b.evaluate('JSON.stringify({ bar: document.getElementById("bar").hidden, icao: document.getElementById("icao").value, err: document.getElementById("bar-error").textContent, explain: document.getElementById("explain").textContent, station: document.documentElement.dataset.station, origin: document.documentElement.dataset.origin, active: document.activeElement?.id })');
      assert.fail(`timed out waiting for ${expr}: ${state}; asked ${asked.join(',')}`);
    };
    const lookUp = async (id) => {
      for (const k of id) await b.key(k);
      await b.key('Enter', '\r');
    };
    try {
      await b.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/metar*' }] });
      await b.goto(`${base}?id=KSFO&still=1`);
      await until('document.documentElement.dataset.origin === "live"');
      assert.match(await b.evaluate('document.getElementById("station-obs").textContent'), /LIVE/);
      assert.ok((await b.evaluate('[...document.querySelectorAll("#metar .tok")].map((t) => t.textContent)')).includes('29012KT'));

      // An unknown station says so in the bar and leaves the live sky alone.
      await lookUp('ZZZZ');
      await until('/ZZZZ: No recent report/.test(document.getElementById("bar-error").textContent)');
      assert.equal(await b.evaluate('document.documentElement.dataset.station'), 'KSFO');
      assert.equal(await b.evaluate('document.documentElement.dataset.origin'), 'live');
      await b.key('Escape');
      assert.equal(await b.evaluate('document.getElementById("bar").hidden'), true);
      // Focus leaves the hidden bar at once (it used to stay on the input and take the next keys).
      assert.equal(await b.evaluate('document.getElementById("bar").contains(document.activeElement)'), false);

      // No API behind this host: the recorded sample, labelled as one, and the reason.
      await lookUp('EGLL');
      await until('document.documentElement.dataset.station === "EGLL"');
      assert.equal(await b.evaluate('document.documentElement.dataset.origin'), 'sample');
      assert.match(await b.evaluate('document.getElementById("station-obs").textContent'), /RECORDED SAMPLE/);
      assert.match(await b.evaluate('document.getElementById("explain").textContent'), /not available on this server.*recorded EGLL report/);

      assert.deepEqual(asked, ['KSFO', 'ZZZZ', 'EGLL']);
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
      // The quality label reports frames shown per second on this device (not a render time).
      let label = '';
      for (let i = 0; i < 40 && !/frames\/s here/.test(label); i++) {
        await sleep(250);
        label = await c.evaluate('document.getElementById("quality").textContent');
      }
      assert.match(label, /^Quality \w+ \(auto\) · [\d.]+ frames\/s here$/);
    } finally {
      await c.close();
    }
  });

  test('a slow GPU (SwiftShader, ~1 s a frame) falls back tier by tier, then to still mode', async (t) => {
    const b = await launch({ width: 1280, height: 800, args: ['--use-angle=swiftshader'] });
    try {
      await b.goto(`${base}?sample=YSSY`, { readyTimeout: 120000 });
      const gpu = await b.evaluate(
        "(() => { const g = document.createElement('canvas').getContext('webgl2'); const e = g && g.getExtension('WEBGL_debug_renderer_info'); return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : ''; })()",
      );
      if (!/swiftshader/i.test(gpu)) {
        t.skip(`software renderer not available here (${gpu || 'unknown'})`);
        return;
      }
      const seen = new Set();
      let motion = 'moving';
      const start = Date.now();
      while (motion !== 'still' && Date.now() - start < 60_000) {
        await sleep(500);
        seen.add(/Quality (\w+)/.exec(await b.evaluate('document.getElementById("quality").textContent'))?.[1]);
        motion = await b.evaluate('document.documentElement.dataset.motion');
      }
      assert.equal(motion, 'still', `still animating after 60 s (tiers seen: ${[...seen].join(', ')})`);
      assert.ok(seen.has('minimal'), [...seen].join(', '));
      assert.match(await b.evaluate('document.getElementById("quality").textContent'), /minimal \(auto\) · still: too slow to animate here/);
      assert.deepEqual(relevant(b.problems), []);
    } finally {
      await b.close();
    }
  });

  test('phone width (400 px, device emulation): no horizontal scroll, every METAR group on screen', async () => {
    const b = await launch({ width: 400, height: 860, deviceScaleFactor: 2, mobile: true });
    try {
      // KJFK, KSFO, PHNL and KDEN carry long RMK sections.
      for (const id of ['KJFK', 'KSFO', 'PHNL', 'KDEN', 'YSSY', 'EGLL']) {
        await b.goto(`${base}?sample=${id}&still=1`);
        await b.evaluate('document.fonts.ready.then(() => true)');
        assert.equal(await b.evaluate('window.innerWidth'), 400);
        assert.equal(await b.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, id);
        const overflow = await b.evaluate(
          '[...document.querySelectorAll(".readout, .chart-label")].some((e) => e.getBoundingClientRect().right > window.innerWidth + 0.5)',
        );
        assert.equal(overflow, false, id);
        const clipped = await b.evaluate(
          'JSON.stringify([...document.querySelectorAll("#metar .tok")].filter((t) => { const r = t.getBoundingClientRect(); return r.right > window.innerWidth + 0.5 || r.left < -0.5 || r.bottom > window.innerHeight + 0.5; }).map((t) => t.textContent.slice(0, 24)))',
        );
        assert.equal(clipped, '[]', `${id}: groups off screen: ${clipped}`);
      }
      assert.deepEqual(relevant(b.problems), []);
    } finally {
      await b.close();
    }
  });

  test('touch: the ICAO bar opens from the sky and closes with Close or a tap outside', async () => {
    const b = await launch({ width: 400, height: 860, deviceScaleFactor: 2, mobile: true });
    const tap = async (x, y) => {
      await b.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await b.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(250);
    };
    const open = () => b.evaluate('!document.getElementById("bar").hidden');
    const centre = (sel) => b.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    try {
      await b.goto(`${base}?sample=VHHH&still=1`);
      await tap(200, 520);
      assert.equal(await open(), true, 'a tap on the sky opens the bar');
      // The hint suits a touch screen: "tap outside", not "Esc".
      assert.equal(await b.evaluate('getComputedStyle(document.querySelector("#bar-hint .touch-only")).display !== "none"'), true);
      assert.equal(await b.evaluate('getComputedStyle(document.querySelector("#bar-hint .kbd-only")).display'), 'none');
      const [cx, cy] = await centre('#bar-close');
      await tap(cx, cy);
      assert.equal(await open(), false, 'the visible Close control closes it');
      await tap(200, 520);
      assert.equal(await open(), true);
      await tap(200, 800); // outside the bar, on the sky
      assert.equal(await open(), false, 'a tap outside closes it (and does not reopen it)');
      await tap(200, 520);
      const [ix, iy] = await centre('#icao');
      await tap(ix, iy); // inside the bar: stays open
      assert.equal(await open(), true, 'a tap inside the bar keeps it open');
      assert.deepEqual(relevant(b.problems), []);
    } finally {
      await b.close();
    }
  });

  test('WCAG AA: sky behind every text box stays dark enough for 4.5:1 (measured)', async () => {
    const inkLight = hexLuminance('#dad5cb'); // the dimmer of the two text colours
    const b = await launch({ width: 1280, height: 800 });
    try {
      const vvFog = `metar=${encodeURIComponent('METAR LFPG 261230Z 00000KT 0100 FG VV001 12/12 Q1020')}`;
      for (const id of ['VHHH', 'LSZH', 'WSSS', 'EGLL', 'YSSY', vvFog]) {
        await b.goto(`${base}?${id.includes('=') ? id : `sample=${id}`}&still=1&notext=1&q=medium`);
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

  test('daytime VV fog is bright white-grey, not sky blue (measured saturation)', async () => {
    const b = await launch({ width: 1280, height: 800 });
    try {
      await b.goto(`${base}?metar=${encodeURIComponent('METAR LFPG 261230Z 00000KT 0100 FG VV001 12/12 Q1020')}&still=1&notext=1&q=medium`);
      await sleep(200);
      assert.match(await b.evaluate('document.getElementById("station-sun").textContent'), /^SUN \d/, 'the sun is up');
      const img = decodePng(await b.screenshot());
      // The middle of the frame, away from the text dimming at the edges.
      let sat = 0;
      let val = 0;
      let n = 0;
      for (let y = 250; y < 550; y += 4) {
        for (let x = 400; x < 1200; x += 4) {
          const i = (y * img.width + x) * img.bpp;
          const r = img.data[i] / 255;
          const g = img.data[i + 1] / 255;
          const bl = img.data[i + 2] / 255;
          const max = Math.max(r, g, bl);
          sat += max > 0 ? (max - Math.min(r, g, bl)) / max : 0;
          val += max;
          n++;
        }
      }
      sat /= n;
      val /= n;
      assert.ok(sat < 0.08, `mean HSV saturation ${sat.toFixed(3)} (the sky-blue fog before the fix measured 0.49)`);
      assert.ok(val > 0.75, `mean brightness ${val.toFixed(3)}: daytime fog should be bright`);
    } finally {
      await b.close();
    }
  });

  test(`cloud cover seen straight up from below matches the report within half an okta (opacity > ${COVER_OPACITY}, ${PROBE_SPAN_KM} km square)`, async () => {
    const b = await launch({ width: 400, height: 400 });
    // Every style (heaped, flat deck, mid-level, cirrus, towering) at each amount, at several heights.
    const cases = [
      ['FEW010', 1.5],
      ['FEW030', 1.5],
      ['SCT045', 3.5],
      ['BKN005', 6],
      ['BKN025', 6],
      ['OVC010', 8],
      ['FEW080', 1.5],
      ['SCT080', 3.5],
      ['BKN150', 6],
      ['FEW250', 1.5],
      ['SCT250', 3.5],
      ['BKN300', 6],
      ['OVC300', 8],
      ['FEW020TCU', 1.5],
      ['SCT020TCU', 3.5],
      ['BKN020TCU', 6],
      ['FEW030CB', 1.5],
      ['SCT030CB', 3.5],
    ];
    const results = [];
    try {
      for (const [group, oktas] of cases) {
        const cover = await measureCover(b, base, `METAR VHHH 260630Z 26008KT 9999 ${group} 31/22 Q1009`);
        results.push(`${group} ${(cover * 100).toFixed(1)}% (target ${((oktas / 8) * 100).toFixed(1)}%)`);
        assert.ok(Math.abs(cover - oktas / 8) <= 1 / 16, results.at(-1));
      }
      assert.deepEqual(relevant(b.problems), []);
    } finally {
      await b.close();
    }
    console.log(`# cover from below: ${results.join('; ')}`);
  });
});
