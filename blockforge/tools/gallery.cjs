// Screenshots of the newer content in controlled scenes.
// Usage: node tools/gallery.cjs <url> <outdir>
const { chromium } = require('playwright');
const url = process.argv[2];
const out = process.argv[3] || '.';
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#b-play'));
  await page.click('#b-play'); await page.waitForTimeout(300);
  await page.click('#b-new'); await page.fill('#w-seed', 'gallery'); await page.click('#b-create');
  await page.waitForFunction(() => window.__blockforge.game.state === 'playing', null, { timeout: 180000 });
  const G = (fn, a) => page.evaluate(fn, a);
  const shot = (n) => page.screenshot({ path: `${out}/${n}.png` });
  const settle = async (ms = 1500) => {
    await page.waitForFunction(() => { const g = window.__blockforge.game; return g.state !== 'loading' && g.world.pool.pending === 0; }, null, { timeout: 120000 });
    await page.waitForTimeout(ms);
  };
  await settle();

  // a flat stage: grass platform with a portal, a bed, a door and fences
  const st = await G(() => {
    const g = window.__blockforge.game, p = g.player, w = g.world, { B } = window.__blockforge;
    g.dayTime = 4000; g.rain = g.rainTarget = 0;
    for (const e of g.entities) e.dead = true;
    const x0 = Math.floor(p.x), z0 = Math.floor(p.z), y = w.surfaceY(x0, z0) + 1;
    for (let dz = -12; dz <= 12; dz++) for (let dx = -12; dx <= 12; dx++) {
      w.setBlock(x0 + dx, y - 1, z0 + dz, B.grass, 0);
      for (let dy = 0; dy < 14; dy++) w.setBlock(x0 + dx, y + dy, z0 + dz, 0, 0);
    }
    // portal frame (4 wide, 5 tall) lit
    const px = x0 - 2, pz = z0 - 6;
    for (let i = 0; i < 4; i++) for (let j = 0; j < 5; j++) if (i === 0 || i === 3 || j === 0 || j === 4) w.setBlock(px + i, y + j, pz, B.obsidian, 0);
    for (let i = 1; i < 3; i++) for (let j = 1; j < 4; j++) w.setBlock(px + i, y + j, pz, B.rift, 0);
    // fence pen with a gate, a door frame, a bed and crops
    for (let i = 0; i < 5; i++) { w.setBlock(x0 + 4 + i, y, z0 - 3, B.oak_fence, 0); w.setBlock(x0 + 4 + i, y, z0 + 1, B.oak_fence, 0); }
    for (let k = -2; k <= 0; k++) { w.setBlock(x0 + 4, y, z0 + k, B.oak_fence, 0); w.setBlock(x0 + 8, y, z0 + k, k === -1 ? B.oak_fence_gate : B.oak_fence, k === -1 ? 1 : 0); }
    for (let i = 0; i < 4; i++) { w.setBlock(x0 - 8 + i, y - 1, z0 - 2, B.farmland, 7); w.setBlock(x0 - 8 + i, y, z0 - 2, [B.wheat, B.carrots, B.potatoes, B.wheat][i], 7 - i * 2); }
    w.setBlock(x0 - 9, y - 1, z0 - 2, B.water, 0);
    w.setBlock(x0 - 5, y, z0 + 2, B.bed, 1); w.setBlock(x0 - 4, y, z0 + 2, B.bed, 1 | 4);
    for (let j = 0; j < 3; j++) { w.setBlock(x0 + 1, y + j, z0 - 3, B.stone_bricks, 0); w.setBlock(x0 + 3, y + j, z0 - 3, B.stone_bricks, 0); }
    w.setBlock(x0 + 2, y + 2, z0 - 3, B.stone_bricks, 0);
    w.setBlock(x0 + 2, y, z0 - 3, B.oak_door, 2); w.setBlock(x0 + 2, y + 1, z0 - 3, B.oak_door, 2 | 8);
    w.setBlock(x0 + 1, y, z0 - 5, B.oak_stairs, 2); w.setBlock(x0 + 3, y, z0 - 5, B.oak_slab, 0);
    w.setBlock(x0 - 1, y, z0 + 4, B.enchanting_table, 0); w.setBlock(x0 + 1, y, z0 + 4, B.hay_bale, 0); w.setBlock(x0 + 3, y, z0 + 4, B.spawner, 0);
    p.x = p.px = x0 + 0.5; p.z = p.pz = z0 + 6.5; p.y = p.py = y; p.yaw = 0; p.pitch = -0.2;
    p.mode = 'creative';
    for (const [t, dx, dz, o] of [['settler', 5, -1, { profession: 'farmer' }], ['sheep', 6, -1], ['settler', -2, 0, { profession: 'smith' }], ['settler', -3, 1, { profession: 'scholar' }], ['cow', 7, 0], ['chicken', 5, 0]]) {
      g.runCommand(`/summon ${t} ${o ? o.profession : ''}`);
      const e = g.entities[g.entities.length - 1];
      e.x = x0 + dx + 0.5; e.z = z0 + dz + 0.5; e.y = y; e.wanderTimer = 100000; e.bodyYaw = Math.PI; e.yaw = e.pyaw = Math.PI;
    }
    return { x0, z0, y };
  });
  await settle(2000);
  await shot('60-stage');

  // armor in third person with an enchanted sword
  await G(({ x0, z0, y }) => {
    const g = window.__blockforge.game, p = g.player;
    for (const n of ['diamond_helmet', 'iron_chestplate', 'golden_leggings', 'leather_boots']) g.runCommand(`/give ${n}`);
    g.runCommand('/give diamond_sword');
    p.x = p.px = x0 + 0.5; p.z = p.pz = z0 + 2.5; p.y = p.py = y;
    g.perspective = 2; p.yaw = Math.PI; p.pitch = -0.15;
  }, st);
  await G(() => {
    const g = window.__blockforge.game, p = g.player, inv = p.inventory;
    for (let i = 0; i < 36; i++) {
      const s = inv.get(i);
      if (!s) continue;
      inv.selected = i;
      if (s.id >= 256) g.use();
    }
    const k = inv.slots.findIndex((s, i) => i < 9 && s && s.id === window.__blockforge.I.diamond_sword);
    if (k >= 0) { inv.selected = k; g.runCommand('/enchant sharpness 3'); }
  });
  await page.waitForTimeout(1200);
  await shot('61-armor-third-person');
  await G(() => { window.__blockforge.game.perspective = 0; });

  // portal close-up
  await G(({ x0, z0, y }) => { const g = window.__blockforge.game, p = g.player; p.x = p.px = x0 + 0.5; p.z = p.pz = z0 - 1.5; p.y = p.py = y; p.yaw = 0; p.pitch = 0.05; g.dayTime = 13200; }, st);
  await page.waitForTimeout(1500);
  await shot('62-portal-dusk');

  // creatures of the night on the stage
  await G(({ x0, z0, y }) => {
    const g = window.__blockforge.game, p = g.player;
    g.dayTime = 17000;
    p.x = p.px = x0 + 0.5; p.z = p.pz = z0 + 9.5; p.y = p.py = y; p.yaw = 0; p.pitch = -0.08;
    let i = 0;
    for (const t of ['archer', 'crawler', 'ghoul', 'imp']) {
      g.runCommand(`/summon ${t}`);
      const e = g.entities[g.entities.length - 1];
      e.x = x0 - 3 + i * 2.2; e.z = z0 + 4.5; e.y = y; e.bodyYaw = Math.PI; e.yaw = e.pyaw = Math.PI; e.headYaw = 0; e.wanderTimer = 100000;
      i++;
    }
    // torches so they can be seen
    const { B } = window.__blockforge;
    for (let k = -4; k <= 5; k += 3) g.world.setBlock(x0 + k, y, z0 + 7, B.torch, 0);
  }, st);
  await page.waitForTimeout(1200);
  await shot('63-night-creatures');

  // lightning over the stage
  await G(({ x0, z0, y }) => { const g = window.__blockforge.game; for (const e of g.entities) if (e.hostile) e.dead = true; g.dayTime = 6000; g.rain = g.rainTarget = 1; g.thunder = 1; g.strike(x0 + 6, y, z0 - 8); }, st);
  await page.waitForTimeout(200);
  await shot('64-lightning');

  // the underworld, away from the arrival portal
  await G(() => window.__blockforge.game.runCommand('/dimension underworld'));
  await page.waitForFunction(() => window.__blockforge.game.dim === 'underworld' && window.__blockforge.game.state === 'playing', null, { timeout: 180000 });
  await settle(2000);
  await G(() => {
    const g = window.__blockforge.game, p = g.player;
    g.rain = g.rainTarget = 0;
    p.mode = 'creative'; p.flying = true;
    p.z += 3; p.pz = p.z; p.y += 1; p.py = p.y; p.pitch = -0.1;
  });
  await page.waitForTimeout(1500);
  await shot('65-underworld-arrival');
  await G(() => { const g = window.__blockforge.game, p = g.player; p.yaw += Math.PI; p.y += 8; p.py = p.y; p.pitch = -0.25; });
  await page.waitForTimeout(1500);
  await shot('66-underworld-vista');
  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
  await browser.close();
})();
