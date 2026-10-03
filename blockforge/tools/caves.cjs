// Caves: caverns, tunnels and ravines, underground lakes, dripstone and lush
// caves, and the drip spike's placement rules.
// Usage: node tools/caves.cjs <url> <outdir>
const { chromium } = require('playwright');
const url = process.argv[2];
const out = process.argv[3] || '.';
const assert = (c, m) => { if (!c) { console.log('FAIL:', m); process.exitCode = 1; } else console.log('ok:', m); };
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message + '\n' + e.stack));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('ERR_CERT')) errors.push(m.text()); });
  await page.goto(url, { timeout: 120000 });
  await page.waitForFunction(() => document.querySelector('#b-play'), null, { timeout: 90000 });
  await page.evaluate(() => { const b = window.__blockforge; b.quality.applyPreset(b.settings, 'balanced'); b.settings.renderDistance = 4; b.ui.app.applySettings(); });
  await page.click('#b-play'); await page.waitForTimeout(200); await page.click('#b-new'); await page.waitForTimeout(200);
  await page.fill('#w-seed', 'caves'); await page.click('#w-mode button[data-m="creative"]'); await page.click('#b-create');
  await page.waitForFunction(() => window.__blockforge.game.state === 'playing', null, { timeout: 180000 });
  await page.waitForFunction(() => { const g = window.__blockforge.game, p = g.player; return g.world.loadProgress(p.x, p.z, 3) >= 1; }, null, { timeout: 180000 });

  const r = await page.evaluate(() => {
    const bf = window.__blockforge, g = bf.game, p = g.player, w = g.world, { B } = bf;
    g.dayTime = 6000; g.settings.daylightCycle = false;
    const x0 = Math.floor(p.x), z0 = Math.floor(p.z);
    const c = { air: 0, all: 0 }, want = ['dripstone', 'drip_spike', 'hanging_drip_spike', 'moss_block', 'glowroot', 'lava', 'water'];
    for (const k of want) c[k] = 0;
    let best = null;
    for (let dx = -44; dx <= 44; dx++) for (let dz = -44; dz <= 44; dz++) {
      const x = x0 + dx, z = z0 + dz, top = w.surfaceY(x, z);
      let run = 0;
      for (let y = 5; y < Math.min(50, top - 8); y++) {
        const id = w.getBlock(x, y, z);
        c.all++; if (id === 0) { c.air++; run++; } else run = 0;
        for (const k of want) if (id === B[k]) c[k]++;
        if (run >= 10 && (!best || run > best.run)) best = { x, y: y - run + 1, z, run };
      }
    }
    return { ...c, frac: c.air / c.all, best };
  });
  console.log(JSON.stringify(r));
  assert(r.frac > 0.08, `there is real space underground (${(r.frac * 100).toFixed(1)}% open between y 5 and 50)`);
  assert(r.best && r.best.run >= 10, `caverns ten or more blocks tall (${r.best && r.best.run})`);
  assert(r.dripstone > 50 && r.drip_spike > 5 && r.hanging_drip_spike > 5, 'dripstone caves with spikes up and down');
  assert(r.moss_block > 20 && r.glowroot > 3, 'lush caves of moss and glowroot');
  assert(r.lava > 0, 'lava lies at the bottom');

  // drip spikes: one set against a ceiling hangs; it falls when its support goes
  const s = await page.evaluate(() => {
    const bf = window.__blockforge, g = bf.game, p = g.player, w = g.world, { B } = bf;
    const x = Math.floor(p.x) + 3, z = Math.floor(p.z), y = w.surfaceY(x, z) + 6;
    for (let k = 0; k < 6; k++) w.setBlock(x, y + k - 2, z, 0, 0);
    w.setBlock(x, y + 1, z, B.stone, 0);
    p.mode = 'survival';
    p.inventory.set(0, { id: B.drip_spike, count: 2 }); p.inventory.selected = 0;
    // aim at the underside of the stone and use the item
    g.targetEntity = null; g.target = { x, y: y + 1, z, id: B.stone, face: 1, nx: 0, ny: -1, nz: 0 };
    g.use();
    const hung = w.getBlock(x, y, z) === B.hanging_drip_spike;
    const n0 = g.items.length;
    g.breakBlock(x, y + 1, z, true);
    const fell = w.getBlock(x, y, z) === 0 && g.items.slice(n0).some((it) => it.stack.id === B.drip_spike);
    return { hung, fell };
  });
  assert(s.hung, 'a drip spike placed under a ceiling hangs from it');
  assert(s.fell, 'and drops when the ceiling is broken');

  if (r.best) {
    await page.evaluate((b) => { const p = window.__blockforge.game.player; p.mode = 'creative'; p.flying = true; p.x = p.px = b.x + 0.5; p.z = p.pz = b.z + 0.5; p.y = p.py = b.y + 1; p.pitch = -0.1; p.effects = { night_vision: { amp: 0, time: 4000 } }; }, r.best);
    await page.waitForTimeout(4000);
    await page.screenshot({ path: `${out}/90-cavern.png` });
  }
  assert(errors.length === 0, `no page errors (${errors.length})`);
  if (errors.length) console.log(errors.slice(0, 5).join('\n'));
  await browser.close();
})();
