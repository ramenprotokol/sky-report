// Screenshots of dist/ in headless Chrome, for visual checks. Output goes wherever --out
// points (keep it outside the repo). Phone shots use DevTools device emulation, so a true
// 400 px wide viewport is rendered (plain --window-size cannot go below 500 px).
// Usage: npm run shots -- --out /some/dir [--samples EGLL,KSFO] [--query "&q=high"] [--focus 3]
import { join, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';
import { launch, sleep } from './cdp.mjs';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const out = arg('out');
if (!out) {
  console.error('usage: npm run shots -- --out <dir> [--samples EGLL,KSFO] [--query "&q=high"] [--focus N] [--phone-only|--desktop-only]');
  process.exit(2);
}
await mkdir(resolve(out), { recursive: true });
const samples = (arg('samples', 'EGLL,VHHH,WSSS,RJTT,LFPG,YSSY,NZAA,KDEN,KSFO,PHNL,KJFK,LSZH') ?? '').split(',').filter(Boolean);
const query = arg('query', '');
const focus = arg('focus');
const settle = Number(arg('settle', '600'));
const devices = [];
if (!process.argv.includes('--phone-only')) devices.push({ name: 'desktop', width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
if (!process.argv.includes('--desktop-only')) devices.push({ name: 'phone', width: 400, height: 860, deviceScaleFactor: 2, mobile: true });

const dist = fileURLToPath(new URL('../dist', import.meta.url));
const server = await startServer(dist, 0);
const base = `http://127.0.0.1:${server.address().port}/`;
let problems = 0;
try {
  for (const d of devices) {
    const b = await launch(d);
    try {
      for (const id of samples) {
        const url = `${base}?sample=${id}&still=1${focus !== null ? `&focus=${focus}` : ''}${query}`;
        const t0 = Date.now();
        const status = await b.goto(url);
        await sleep(settle);
        const png = await b.screenshot();
        const file = join(resolve(out), `${id}-${d.name}.png`);
        await writeFile(file, png);
        const scroll = await b.evaluate('document.documentElement.scrollWidth > window.innerWidth');
        console.log(`${d.name} ${id}: ${status} in ${Date.now() - t0} ms${scroll ? ' HORIZONTAL SCROLL' : ''} → ${file}`);
      }
      for (const p of b.problems) console.log(`  problem: ${p}`);
      problems += b.problems.length;
    } finally {
      await b.close();
    }
  }
} finally {
  server.close();
}
process.exit(problems ? 1 : 0);
