// Systems test: persistence, smelting, fluids, creative inventory, death, menus.
// Usage: node tools/systems.cjs <url> <outdir>
const { chromium } = require('playwright');
const url = process.argv[2];
const out = process.argv[3] || '.';
const assert = (c, m) => { if (!c) { console.log('FAIL:', m); process.exitCode = 1; } else console.log('ok:', m); };
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message + '\n' + e.stack));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('ERR_CERT')) errors.push(m.text()); });
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#b-play'), null, { timeout: 60000 });
  const G = (fn, a) => page.evaluate(fn, a);
  const shot = (n) => page.screenshot({ path: `${out}/${n}.png` });

  await page.click('#b-options'); await page.waitForTimeout(400); await shot('30-options');
  await page.click('#b-done'); await page.waitForTimeout(200);
  await page.click('#b-play'); await page.waitForTimeout(300);
  await page.click('#b-new'); await page.waitForTimeout(200);
  await page.fill('#w-name', 'Persistence Test');
  await page.fill('#w-seed', 'persist');
  await page.click('#b-create');
  await page.waitForFunction(() => window.__blockforge.game.state === 'playing', null, { timeout: 180000 });
  await page.waitForTimeout(1500);

  // Mark a block, move the player, save and quit, reload the world.
  const mark = await G(() => {
    const g = window.__blockforge.game, p = g.player, w = g.world;
    const x = Math.floor(p.x) + 2, z = Math.floor(p.z) + 2, y = w.surfaceY(x, z);
    w.setBlock(x, y, z, 59, 0); // diamond block
    p.inventory.set(4, { id: 57, count: 7 });
    p.x += 1.25; p.px = p.x;
    g.dayTime = 9000;
    return { x, y, z, px: p.x };
  });
  await G(() => window.__blockforge.ui.pause());
  await page.waitForTimeout(300);
  await shot('31-pause');
  await page.click('#b-quit');
  await page.waitForFunction(() => document.querySelector('#b-play'), null, { timeout: 60000 });
  await page.click('#b-play'); await page.waitForTimeout(600);
  const worlds = await page.$$eval('.world b', (els) => els.map((e) => e.textContent));
  assert(worlds.includes('Persistence Test'), 'world listed after quit: ' + worlds.join(', '));
  await shot('32-worlds');
  await page.click('.world'); await page.click('#b-playw');
  await page.waitForFunction(() => window.__blockforge.game.state === 'playing', null, { timeout: 180000 });
  await page.waitForTimeout(1000);
  const back = await G((m) => { const g = window.__blockforge.game, p = g.player; return { block: g.world.getBlock(m.x, m.y, m.z), slot: p.inventory.get(4), px: p.x, time: g.dayTime }; }, mark);
  assert(back.block === 59, 'placed block persisted');
  assert(back.slot && back.slot.id === 57 && back.slot.count === 7, 'inventory persisted');
  assert(Math.abs(back.px - mark.px) < 0.01, 'player position persisted');
  assert(back.time >= 9000 && back.time < 9400, 'time persisted: ' + back.time);

  // Furnace smelting: cobblestone -> stone with coal
  const fur = await G(() => {
    const g = window.__blockforge.game, w = g.world, p = g.player;
    const x = Math.floor(p.x) - 2, z = Math.floor(p.z) - 2, y = w.surfaceY(x, z);
    w.setBlock(x, y, z, 45, 4);
    const key = `${x},${y},${z}`;
    w.blockEntities.set(key, { type: 'furnace', slots: [{ id: 4, count: 3 }, { id: 257, count: 1 }, null], burn: 0, burnMax: 0, cook: 0 });
    return key;
  });
  await page.waitForTimeout(500);
  const lit = await G((k) => { const [x, y, z] = k.split(',').map(Number); return window.__blockforge.game.world.getBlock(x, y, z); }, fur);
  assert(lit === 46, 'furnace lights up while burning');
  await G((k) => { const g = window.__blockforge.game; for (let i = 0; i < 700; i++) g.tickFurnaces(); }, fur);
  const smelt = await G((k) => window.__blockforge.game.world.blockEntities.get(k).slots, fur);
  assert(smelt[2] && smelt[2].id === 1 && smelt[2].count === 3, 'smelted 3 stone: ' + JSON.stringify(smelt));
  await G((k) => { const g = window.__blockforge.game; g.ui.openScreen('furnace', { key: k, be: g.world.blockEntities.get(k) }); g.world.blockEntities.get(k).slots[0] = { id: 15, count: 2 }; g.world.blockEntities.get(k).cook = 120; g.world.blockEntities.get(k).burn = 900; g.world.blockEntities.get(k).burnMax = 1600; }, fur);
  await page.waitForTimeout(500);
  await shot('33-furnace');
  await page.keyboard.press('Escape');

  // Water flow on flat ground
  const flow = await G(() => {
    const g = window.__blockforge.game, w = g.world, p = g.player;
    const x0 = Math.floor(p.x) + 5, z0 = Math.floor(p.z) - 6, y = 120;
    for (let dx = -8; dx <= 8; dx++) for (let dz = -8; dz <= 8; dz++) { w.setBlock(x0 + dx, y - 1, z0 + dz, 1, 0); for (let h = 0; h < 4; h++) w.setBlock(x0 + dx, y + h, z0 + dz, 0, 0); }
    w.setBlock(x0, y, z0, 12, 0);
    g.fluids.schedule(x0, y, z0, g.tickCount);
    return [x0, y, z0];
  });
  await G(() => { const g = window.__blockforge.game; for (let i = 0; i < 200; i++) { g.tickCount++; g.fluids.tick(g.tickCount); } });
  const spread = await G((f) => { const w = window.__blockforge.game.world; let n = 0, far = 0; for (let dx = -8; dx <= 8; dx++) for (let dz = -8; dz <= 8; dz++) if (w.getBlock(f[0] + dx, f[1], f[2] + dz) === 12) { n++; far = Math.max(far, Math.abs(dx) + Math.abs(dz)); } return { n, far }; }, flow);
  assert(spread.n > 60 && spread.far === 7, 'water spread 7 blocks: ' + JSON.stringify(spread));
  await G((f) => { const g = window.__blockforge.game, p = g.player; g.world.setBlock(f[0], f[1], f[2], 0, 0); g.fluids.schedule(f[0], f[1], f[2], g.tickCount); for (let d = 1; d < 3; d++) g.fluids.schedule(f[0] + d, f[1], f[2], g.tickCount); p.x = f[0] + 0.5; p.z = f[2] + 9; p.y = f[1] + 4; p.px = p.x; p.py = p.y; p.pz = p.z; p.flying = true; p.mode = 'creative'; p.yaw = 0; p.pitch = -0.6; }, flow);
  await page.waitForTimeout(800);
  await shot('34-water-receding');
  await G(() => { const g = window.__blockforge.game; for (let i = 0; i < 300; i++) { g.tickCount++; g.fluids.tick(g.tickCount); } });
  const left = await G((f) => { const w = window.__blockforge.game.world; let n = 0; for (let dx = -8; dx <= 8; dx++) for (let dz = -8; dz <= 8; dz++) if (w.getBlock(f[0] + dx, f[1], f[2] + dz) === 12) n++; return n; }, flow);
  assert(left === 0, 'water dried up after removing source (' + left + ' left)');

  // Creative inventory
  await G(() => window.__blockforge.ui.openScreen('creative'));
  await page.waitForTimeout(600);
  await shot('35-creative');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // Death screen
  await G(() => { const g = window.__blockforge.game; g.player.mode = 'survival'; g.player.flying = false; g.player.invuln = 0; g.player.damage(g, 50, 'fall'); });
  await page.waitForTimeout(1500);
  await shot('36-death');
  assert(await page.$('#b-respawn') !== null, 'death screen shown');
  await page.click('#b-respawn');
  await page.waitForTimeout(800);
  assert(await G(() => window.__blockforge.game.player.health === 20 && !window.__blockforge.game.player.dead), 'respawned with full health');

  // Mobile layout of the title screen
  const m = await browser.newPage({ viewport: { width: 400, height: 820 }, isMobile: true, hasTouch: true });
  m.on('pageerror', (e) => errors.push('[mobile] ' + e.message));
  await m.goto(url);
  await m.waitForFunction(() => document.querySelector('#b-play'), null, { timeout: 60000 });
  await m.waitForTimeout(3000);
  await m.screenshot({ path: `${out}/37-mobile.png` });
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert(!overflow, 'no horizontal overflow on phone width');

  console.log('ERRORS (' + errors.length + '):\n' + errors.join('\n'));
  await browser.close();
})().catch((e) => { console.error('TEST CRASHED', e); process.exit(1); });
