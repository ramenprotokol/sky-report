// Finds, for each cloud style, the coverage value the shader must threshold its noise at so that
// the layer seen from below covers the reported amount (FEW 1.5/8, SCT 3.5/8, BKN 6/8). Prints
// the DRAWN_COVERAGE table for src/scene/mapping.ts. Needs a built dist/ and Chrome.
// Usage: npm run build && npm run calibrate
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';
import { launch } from './cdp.mjs';
import { measureCover } from './cover-probe.mjs';

// One report per style; the probe overrides the first layer's drawn coverage (?rawcover).
const STYLES = [
  [0, 'cumulus', 'FEW030'],
  [1, 'stratiform', 'BKN010'],
  [2, 'mid-level', 'SCT080'],
  [3, 'cirrus', 'SCT250'],
  [4, 'towering', 'SCT020TCU'],
];
const TARGETS = { FEW: 1.5 / 8, SCT: 3.5 / 8, BKN: 6 / 8 };

const dist = fileURLToPath(new URL('../dist', import.meta.url));
const server = await startServer(dist, 0);
const base = `http://127.0.0.1:${server.address().port}/`;
const b = await launch({ width: 400, height: 400 });
const table = {};
try {
  for (const [kind, name, group] of STYLES) {
    const metar = `METAR VHHH 260630Z 26008KT 9999 ${group} 31/22 Q1009`;
    table[kind] = {};
    for (const [cls, target] of Object.entries(TARGETS)) {
      let lo = 0.02;
      let hi = 0.98;
      for (let i = 0; i < 9; i++) {
        const mid = (lo + hi) / 2;
        if ((await measureCover(b, base, metar, { rawcover: mid.toFixed(4) })) < target) lo = mid;
        else hi = mid;
      }
      const c = Math.round(((lo + hi) / 2) * 1000) / 1000;
      table[kind][cls] = c;
      const check = await measureCover(b, base, metar, { rawcover: c });
      console.log(`${name.padEnd(10)} ${cls}: drawn ${c.toFixed(3)} → measured ${(check * 100).toFixed(1)}% (target ${(target * 100).toFixed(2)}%)`);
    }
  }
} finally {
  await b.close();
  server.close();
}
console.log('\nexport const DRAWN_COVERAGE = {');
for (const [kind, name] of STYLES) console.log(`  ${kind}: { FEW: ${table[kind].FEW}, SCT: ${table[kind].SCT}, BKN: ${table[kind].BKN} }, // ${name}`);
console.log('};');
