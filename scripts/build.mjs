// Builds dist/: bundles the TypeScript shell (shaders inlined as text) with content-hashed
// names, then copies the static files. Usage: npm run build
import { build } from 'esbuild';
import { rm, mkdir, readFile, writeFile, readdir, copyFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const pub = join(root, 'public');

await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, 'assets'), { recursive: true });

const result = await build({
  entryPoints: [join(root, 'src/app/main.ts')],
  bundle: true,
  format: 'esm',
  target: ['es2022', 'chrome100', 'safari16', 'firefox110'],
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  loader: { '.frag': 'text', '.vert': 'text' },
  outdir: join(dist, 'assets'),
  entryNames: '[name]-[hash]',
  metafile: true,
  logLevel: 'warning',
});

const outputs = Object.keys(result.metafile.outputs).map((p) => relative(dist, join(root, p)).split('\\').join('/'));
const js = outputs.find((p) => p.endsWith('.js'));
const css = outputs.find((p) => p.endsWith('.css'));
if (!js || !css) throw new Error(`build: expected one .js and one .css output, got ${outputs.join(', ')}`);

const html = (await readFile(join(pub, 'index.html'), 'utf8')).replace('%JS%', js).replace('%CSS%', css);
if (html.includes('%JS%') || html.includes('%CSS%')) throw new Error('build: placeholders left in index.html');
await writeFile(join(dist, 'index.html'), html);

for (const name of await readdir(pub)) {
  if (name === 'index.html') continue;
  await copyFile(join(pub, name), join(dist, name));
}

const sizes = [];
for (const p of [js, css, 'index.html']) sizes.push(`${p} ${((await stat(join(dist, p))).size / 1024).toFixed(1)} KiB`);
console.log(`dist/ ready:\n  ${sizes.join('\n  ')}`);
