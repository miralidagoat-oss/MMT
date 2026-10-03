/**
 * Builds the hosted web page: a production client build whose index page is
 * rewritten into the hosted page format (page content only — the host wraps it
 * in the document skeleton — with the stylesheet inlined). Output: dist/web.
 *   npx tsx tools/build-web.ts
 */
import { build } from 'vite';
import { readFileSync, writeFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('dist/web');

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  await build({ configFile: path.resolve('vite.config.ts'), logLevel: 'warn', build: { outDir: OUT, emptyOutDir: true } });
  const html = readFileSync(path.join(OUT, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g)].map((m) => m[1]!);
  const preloads = [...html.matchAll(/<link rel="modulepreload"[^>]*href="([^"]+)"[^>]*>/g)].map((m) => m[1]!);
  const css = [...html.matchAll(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)].map((m) => readFileSync(path.join(OUT, m[1]!), 'utf8')).join('\n');
  if (!scripts.length) throw new Error('no entry script found in the built page');
  const page = [
    '<title>Tidewake</title>',
    '<meta name="description" content="A co-op ocean island survival game for 1 to 4 players.">',
    `<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><circle cx='32' cy='32' r='30' fill='%23164a5c'/><path d='M8 40c8-6 16 6 24 0s16 6 24 0v16H8z' fill='%234fd1c5'/><path d='M30 14c-6 4-8 12-6 22h4c-1-8 1-14 6-18z' fill='%23ffb35c'/></svg>">`,
    `<style>${css}</style>`,
    '<canvas id="game"></canvas>',
    '<div id="ui"></div>',
    '<noscript>Tidewake needs JavaScript and WebGL2.</noscript>',
    ...preloads.map((p) => `<link rel="modulepreload" href="${p}">`),
    ...scripts.map((s) => `<script type="module" src="${s}"></script>`),
  ].join('\n');
  writeFileSync(path.join(OUT, 'index.html'), page + '\n');
  const files = readdirSync(path.join(OUT, 'assets')).filter((f) => !f.endsWith('.css'));
  for (const f of readdirSync(path.join(OUT, 'assets'))) if (f.endsWith('.css')) rmSync(path.join(OUT, 'assets', f));
  const manifest: Record<string, string> = {};
  let total = statSync(path.join(OUT, 'index.html')).size;
  for (const f of files) { manifest[`assets/${f}`] = path.join(OUT, 'assets', f); total += statSync(path.join(OUT, 'assets', f)).size; }
  writeFileSync(path.join(OUT, 'files.json'), JSON.stringify(manifest, null, 2));
  console.log(`web build ready in ${path.relative(process.cwd(), OUT)}: index.html + ${files.length} assets, ${(total / 1024).toFixed(0)} KiB`);
}

main().catch((e) => { console.error(e); process.exit(1); });
