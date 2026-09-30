// Headless smoke test: loads the game, creates a world, plays a little and
// captures screenshots plus any console errors.
// Usage: node tools/smoke.cjs <url> <outdir>
const { chromium } = require('playwright');
const url = process.argv[2] || 'http://127.0.0.1:8123/index.html';
const out = process.argv[3] || '.';
(async () => {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message + '\n' + e.stack));
  await page.goto(url);
  await page.waitForTimeout(8000);
  await page.screenshot({ path: `${out}/01-title.png` });
  const fatal = await page.$('#fatal');
  if (fatal) { console.log('FATAL:', await fatal.innerText()); }
  // Play -> Create world
  await page.click('#b-play');
  await page.waitForTimeout(500);
  await page.click('#b-new');
  await page.waitForTimeout(300);
  await page.fill('#w-seed', 'smoke-test');
  await page.click('#b-create');
  const t0 = Date.now();
  for (let i = 0; i < 120; i++) {
    await page.waitForTimeout(1000);
    const st = await page.evaluate(() => window.__blockforge && window.__blockforge.game.state);
    if (st === 'playing') break;
  }
  console.log('load seconds', (Date.now() - t0) / 1000);
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${out}/02-world.png` });
  const info = await page.evaluate(() => {
    const g = window.__blockforge.game;
    return { state: g.state, fps: g.fps, pos: [g.player.x, g.player.y, g.player.z], chunks: g.world.chunks.size, drawn: g.renderer.stats.drawn, quads: g.renderer.stats.quads, fallback: g.world.pool.fallback, workers: g.world.pool.workers.length, entities: g.entities.length };
  });
  console.log(JSON.stringify(info));
  console.log('ERRORS:\n' + errors.slice(0, 40).join('\n'));
  await browser.close();
})();
