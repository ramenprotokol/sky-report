// Third-party notices: the build writes dist/THIRD-PARTY-NOTICES.txt, the page's sources
// list links to it, and it covers what ships: the recorded METAR samples (and any library
// the bundle would pull from node_modules). Requires `npm run build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAMPLES, SAMPLES_RECORDED } from '../../src/app/samples.ts';
import { bundledPackages } from '../../scripts/notices.mjs';

const dist = fileURLToPath(new URL('../../dist', import.meta.url));
const file = join(dist, 'THIRD-PARTY-NOTICES.txt');

test('dist/ ships THIRD-PARTY-NOTICES.txt', () => {
  assert.ok(existsSync(file), 'dist/THIRD-PARTY-NOTICES.txt is missing (run npm run build)');
});

test('the page links to the notices from its sources list', () => {
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  assert.match(html, /<h3>Sources<\/h3>\s*<ul>[\s\S]*<a href="THIRD-PARTY-NOTICES\.txt">[\s\S]*?<\/ul>/);
});

test('the notices cover the bundled samples, the self-hosted fonts and the (absent) third-party code', () => {
  const text = readFileSync(file, 'utf8');
  assert.match(text, new RegExp(`Recorded METAR samples \\(${SAMPLES.length} reports, recorded ${SAMPLES_RECORDED}\\)`));
  for (const s of SAMPLES) assert.match(text, new RegExp(`\\b${s.id}\\b`), `${s.id} missing`);
  assert.match(text, /aviationweather\.gov/);
  assert.match(text, /public domain, per the NWS disclaimer/);
  // The five self-hosted font files, each with the OFL's copyright line and the licence text itself.
  for (const f of ['b612-400', 'b612-700', 'b612-italic-400', 'b612-mono-400', 'b612-mono-700']) {
    assert.match(text, new RegExp(`assets/${f}-[A-Z0-9]{8}\\.woff2`), `${f} missing`);
  }
  assert.match(text, /Copyright 2012 The B612 Project Authors/);
  assert.match(text, /SIL Open Font License, Version 1\.1/);
  assert.match(text, /PERMISSION & CONDITIONS/);
  assert.doesNotMatch(text, /googleapis|loaded from Google Fonts/);
  assert.match(text, /Third-party code: none\./);
  assert.doesNotMatch(text, /\/Users\/|\/home\//, 'no local paths');
});

test('bundledPackages finds node_modules inputs, scoped or not', () => {
  const metafile = {
    inputs: {
      'src/app/main.ts': {},
      'node_modules/three/build/three.module.js': {},
      'node_modules/@scope/lib/dist/index.js': {},
      'node_modules/@scope/lib/dist/util.js': {},
    },
  };
  assert.deepEqual(bundledPackages(metafile), ['node_modules/@scope/lib', 'node_modules/three']);
});
