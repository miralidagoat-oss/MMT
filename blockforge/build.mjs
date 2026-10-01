// Bundles the game into single self-contained HTML files:
//   dist/blockforge.html  – a complete page; open it directly or host it anywhere
//   dist/artifact.html    – the same game as a body fragment for page hosts that
//                           supply their own <html>/<head>/<body> skeleton
// The worker is bundled separately and embedded as a string, then started from
// a blob: URL at runtime.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const common = {
  bundle: true, minify: true, format: 'iife', target: ['es2020'], write: false, legalComments: 'none',
  define: { 'import.meta.url': '"about:blank"' }, logLevel: 'warning',
};

const worker = await build({ ...common, entryPoints: ['src/worker.js'] });
const main = await build({ ...common, entryPoints: ['src/main.js'] });
const workerSrc = worker.outputFiles[0].text;
const mainSrc = main.outputFiles[0].text;

// Keep "</script" sequences from ending the inline script early.
const safe = (js) => js.replace(/<\/script/gi, '<\\/script');
const css = readFileSync('src/style.css', 'utf8');
const html = readFileSync('index.html', 'utf8');
const app = html.slice(html.indexOf('<!--APP-->') + 10, html.indexOf('<!--/APP-->')).trim();
const fonts = '<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800&family=Pixelify+Sans:wght@400;600;700&family=Silkscreen:wght@400;700&family=VT323&display=swap">';
const scripts = `<script>globalThis.__BF_WORKER_SRC__=${safe(JSON.stringify(workerSrc))};</script>\n<script>${safe(mainSrc)}</script>`;

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
<title>Blockforge</title>
<meta name="description" content="Blockforge: an open-world voxel sandbox in the browser.">
<link rel="icon" href="data:,">
${fonts}
<style>${css}</style>
</head>
<body>
${app}
${scripts}
</body>
</html>
`;

const fragment = `<title>Blockforge</title>
${fonts}
<style>${css}</style>
${app}
${scripts}
`;

mkdirSync('dist', { recursive: true });
writeFileSync('dist/blockforge.html', page);
writeFileSync('dist/artifact.html', fragment);
const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(0) + ' KB';
console.log(`dist/blockforge.html ${kb(page)} (main ${kb(mainSrc)}, worker ${kb(workerSrc)})`);
console.log(`dist/artifact.html ${kb(fragment)}`);
