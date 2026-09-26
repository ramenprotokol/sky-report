// Writes dist/THIRD-PARTY-NOTICES.txt: the third-party material that ships in dist/.
//
// - Code: every bundle input that esbuild took from node_modules, with the package's own
//   version, licence and licence text. Today there is none (the bundle is built only from
//   src/), and the file says so; if a library is ever added, it is listed automatically.
// - Data: the recorded METAR samples bundled from src/app/samples.ts.
// - Fonts: none are self-hosted (the build fails if a font file lands in dist/). B612 and
//   B612 Mono are loaded from Google Fonts and are only mentioned.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const RULE = '-'.repeat(78);

/** Wraps `text` to 78 columns, indenting continuation lines by `indent` spaces. */
function wrap(text, indent) {
  const out = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && indent + line.length + 1 + word.length > 78) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  out.push(line);
  return out.join('\n' + ' '.repeat(indent));
}

/** Package roots (e.g. node_modules/@scope/name) of every bundle input from node_modules. */
export function bundledPackages(metafile) {
  const roots = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const m = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input.split('\\').join('/'));
    if (m) roots.add(m[1]);
  }
  return [...roots].sort();
}

async function packageEntry(root, dir) {
  const pkg = JSON.parse(await readFile(join(root, dir, 'package.json'), 'utf8'));
  const files = (await readdir(join(root, dir))).filter((f) => /^(licen[cs]e|copying|notice)/i.test(f)).sort();
  if (!files.length) throw new Error(`third-party notices: ${pkg.name} ${pkg.version} ships in the bundle but has no licence file`);
  const texts = [];
  for (const f of files) texts.push([f, (await readFile(join(root, dir, f), 'utf8')).replace(/\r\n/g, '\n').trim()]);
  const copyright = [...new Set(texts.flatMap(([, t]) => t.split('\n').filter((l) => /^\s*copyright\b.*(\(c\)|©|\d{4})/i.test(l)).map((l) => l.trim())))];
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  return {
    heading: `${pkg.name} ${pkg.version}`,
    fields: [
      ['Ships', 'bundled into assets/main-*.js'],
      ['Copyright', copyright.join('; ') || String(pkg.author?.name ?? pkg.author ?? `the ${pkg.name} authors`)],
      ['Licence', pkg.license ?? 'see below'],
      ['Source', `https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}${repo ? `, ${repo}` : ''}`],
    ],
    texts,
  };
}

async function listFiles(dir, prefix = '') {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix + e.name;
    if (e.isDirectory()) out.push(...(await listFiles(join(dir, e.name), rel + '/')));
    else out.push(rel);
  }
  return out;
}

export async function writeNotices({ root, dist, metafile }) {
  const fonts = (await listFiles(dist)).filter((f) => /\.(woff2?|ttf|otf|eot)$/i.test(f));
  if (fonts.length) throw new Error(`third-party notices: self-hosted fonts need an entry: ${fonts.join(', ')}`);

  const packages = await Promise.all(bundledPackages(metafile).map((dir) => packageEntry(root, dir)));

  const samplesFile = 'src/app/samples.ts';
  if (!Object.keys(metafile.inputs).some((p) => p.split('\\').join('/').endsWith(samplesFile))) {
    throw new Error(`third-party notices: ${samplesFile} is no longer bundled; update scripts/notices.mjs`);
  }
  const { SAMPLES, SAMPLES_RECORDED } = await import(pathToFileURL(join(root, samplesFile)).href);
  const ids = SAMPLES.map((s) => s.id);

  const entries = [
    ...packages,
    {
      heading: `Recorded METAR samples (${ids.length} reports, recorded ${SAMPLES_RECORDED})`,
      fields: [
        ['Ships', 'bundled into assets/main-*.js, so the page works offline and without the Worker'],
        ['Stations', ids.join(' ')],
        ['What', 'the raw METAR text, observation time, station name, position and elevation, as returned by the API'],
        ['Copyright', 'none: US-government information from the Aviation Weather Center (NOAA / National Weather Service)'],
        ['Licence', 'public domain, per the NWS disclaimer (https://www.weather.gov/disclaimer): "The information on National Weather Service (NWS) Web pages are in the public domain, unless specifically noted otherwise, and may be used without charge for any lawful purpose" provided it is not claimed as your own, not used to imply NOAA/NWS endorsement or affiliation, and not modified and then presented as official government material. sky-report is not affiliated with or endorsed by NOAA/NWS.'],
        ['Source', 'Aviation Weather Center Data API, https://aviationweather.gov/data/api/ (/api/data/metar?ids=XXXX&format=json)'],
        ['Note', 'reports for airports outside the US are made by those countries\' weather services and exchanged worldwide; these copies were retrieved through the Aviation Weather Center.'],
      ],
      texts: [],
    },
  ];

  const code = packages.length
    ? `Third-party code: ${packages.map((p) => p.heading).join(', ')}, listed below.`
    : "Third-party code: none. The JavaScript bundle is built only from this project's own src/ (checked from esbuild's metafile at build time). esbuild, TypeScript and @types/node are build tools and ship nothing.";
  const lines = [
    'THIRD-PARTY NOTICES for sky-report',
    '',
    wrap('sky-report itself is MIT licensed (Copyright (c) 2026 ramenprotokol). This file lists the third-party material that ships in this site. `npm run build` writes it from what the bundler actually included.', 0),
    '',
    wrap(code, 0),
    '',
    'Third-party data: the recorded METAR samples, below.',
    '',
    wrap('Fonts: none are shipped. B612 and B612 Mono (designed by Nicolas Chauveau, Thomas Paillot, Jonathan Favre-Lamarine and Jean-Luc Vinot) are loaded from Google Fonts (fonts.googleapis.com) when the page opens. Both are licensed under the SIL Open Font License 1.1.', 0),
    '',
    wrap('Live reports are fetched at run time, through the Worker, from the same API. They are not part of dist/.', 0),
    '',
  ];
  for (const e of entries) {
    lines.push(RULE, e.heading);
    const w = Math.max(...e.fields.map(([k]) => k.length)) + 1;
    for (const [k, v] of e.fields) lines.push(`  ${(k + ':').padEnd(w + 1)}${wrap(v, w + 3)}`);
    lines.push('');
    for (const [label, text] of e.texts) lines.push(`  --- ${label} ---`, '', text, '');
  }
  lines.push(RULE, '');
  const text = lines.join('\n');
  if (/\/Users\/|\/home\//.test(text)) throw new Error('third-party notices: a local path leaked into the notices');
  await writeFile(join(dist, 'THIRD-PARTY-NOTICES.txt'), text);
  return text;
}
