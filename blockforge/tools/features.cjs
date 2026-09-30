// Feature test for villages, trading, armor, enchanting, beds, farming, bows,
// rift portals and the underworld.
// Usage: node tools/features.cjs <url> <outdir>
const { chromium } = require('playwright');
const url = process.argv[2];
const out = process.argv[3] || '.';
const assert = (c, m) => { if (!c) { console.log('FAIL:', m); process.exitCode = 1; } else console.log('ok:', m); };
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message + '\n' + e.stack));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('ERR_CERT')) errors.push(m.text()); });
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#b-play'), null, { timeout: 60000 });
  const G = (fn, a) => page.evaluate(fn, a);
  const shot = (n) => page.screenshot({ path: `${out}/${n}.png` });
  const waitReady = async (ms = 1500) => {
    await page.waitForFunction(() => {
      const g = window.__blockforge.game, p = g.player;
      return g.state !== 'loading' && g.world.loadProgress(p.x, p.z, 3) >= 1 && g.world.pool.pending === 0;
    }, null, { timeout: 180000 });
    await page.waitForTimeout(ms);
  };

  await page.click('#b-play'); await page.waitForTimeout(300);
  await page.click('#b-new'); await page.waitForTimeout(200);
  await page.fill('#w-name', 'Feature Test');
  await page.fill('#w-seed', 'settlers');
  await page.click('#b-create');
  await page.waitForFunction(() => window.__blockforge.game.state === 'playing', null, { timeout: 180000 });
  await page.waitForTimeout(1000);

  // ---- village -------------------------------------------------------------
  const loc = await G(() => window.__blockforge.game.runCommand('/locate village'));
  console.log(loc);
  const m = /at (-?\d+), ~, (-?\d+)/.exec(loc);
  assert(!!m, 'a village can be located');
  if (m) {
    const vx = +m[1], vz = +m[2];
    await G(([x, z]) => { const g = window.__blockforge.game, p = g.player; p.x = p.px = x + 0.5; p.z = p.pz = z - 30.5; p.y = p.py = 140; p.vy = 0; p.mode = 'creative'; p.flying = true; g.dayTime = 3000; g.rainTarget = g.rain = 0; }, [vx, vz]);
    await waitReady(3000);
    const info = await G(([x, z]) => {
      const g = window.__blockforge.game, p = g.player, w = g.world;
      const h = w.surfaceY(x, z);
      p.y = p.py = h + 22; p.yaw = 0; p.pitch = -0.55;
      // yaw 0 looks toward -Z; face the village centre (which lies at +Z)
      p.yaw = Math.PI;
      const settlers = g.entities.filter((e) => e.type === 'settler');
      let chests = 0, doors = 0, beds = 0, farmland = 0, paths = 0;
      for (let dz = -60; dz <= 60; dz++) for (let dx = -60; dx <= 60; dx++) {
        for (let y = h - 8; y < h + 16; y++) {
          const id = w.getBlock(x + dx, y, z + dz);
          if (id === window.__blockforge.B.chest) chests++;
          else if (id === window.__blockforge.B.oak_door) doors++;
          else if (id === window.__blockforge.B.bed) beds++;
          else if (id === window.__blockforge.B.farmland) farmland++;
          else if (id === window.__blockforge.B.dirt_path) paths++;
        }
      }
      return { settlers: settlers.length, profs: settlers.map((s) => s.profession), chests, doors, beds, farmland, paths };
    }, [vx, vz]);
    console.log('village', JSON.stringify(info));
    assert(info.settlers >= 3, `settlers live in the village (${info.settlers})`);
    assert(info.doors >= 4 && info.beds >= 2 && info.farmland > 20 && info.paths > 30, 'village has doors, beds, farms and paths');
    await page.waitForTimeout(1500);
    await shot('40-village');
    // ground-level view
    await G(([x, z]) => { const g = window.__blockforge.game, p = g.player, w = g.world; p.z = p.pz = z - 18.5; p.y = p.py = w.surfaceY(x, z - 18) + 2.5; p.pitch = -0.12; }, [vx, vz]);
    await page.waitForTimeout(1500);
    await shot('41-village-street');

    // ---- trading -------------------------------------------------------------
    const tr = await G(() => {
      const g = window.__blockforge.game, p = g.player, { I } = window.__blockforge;
      p.mode = 'survival'; p.flying = false;
      const s = g.entities.find((e) => e.type === 'settler');
      if (!s) return null;
      p.x = p.px = s.x + 1.5; p.z = p.pz = s.z; p.y = p.py = s.y;
      for (let i = 0; i < 36; i++) p.inventory.set(i, null);
      g.runCommand('/give emerald 20'); g.runCommand('/give wheat 64'); g.runCommand('/give carrot 64'); g.runCommand('/give potato 64');
      g.runCommand('/give coal 64'); g.runCommand('/give iron_ingot 30'); g.runCommand('/give white_wool 40'); g.runCommand('/give paper 64'); g.runCommand('/give book 8');
      g.openTrading(s);
      return { prof: s.profession, trades: s.trades.length, emeralds: p.inventory.count(I.emerald) };
    });
    assert(tr && tr.trades >= 4, `settler offers trades (${tr && tr.prof}, ${tr && tr.trades})`);
    await page.waitForTimeout(600);
    await shot('42-trading');
    const enabled = await page.$$eval('.offer', (els) => els.map((e) => !e.disabled));
    const k = enabled.indexOf(true);
    assert(k >= 0, 'at least one offer is affordable');
    const before = await G(() => JSON.stringify(window.__blockforge.game.player.inventory.slots.slice(0, 36)));
    if (k >= 0) await page.click(`.offer:nth-of-type(${k + 1})`, { force: true }).catch(() => page.$$('.offer').then((els) => els[k].click()));
    await page.waitForTimeout(300);
    const after = await G(() => ({ inv: JSON.stringify(window.__blockforge.game.player.inventory.slots.slice(0, 36)), orbs: window.__blockforge.game.orbs.length }));
    assert(before !== after.inv, 'trading changed the inventory');
    assert(after.orbs > 0, 'trading gives experience orbs');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }

  // ---- armor ---------------------------------------------------------------
  await G(() => {
    const g = window.__blockforge.game, p = g.player;
    for (let i = 0; i < 40; i++) p.inventory.set(i, null);
    for (const n of ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'diamond_sword', 'bow', 'wheat_seeds', 'iron_hoe']) g.runCommand(`/give ${n}`);
    g.runCommand('/give arrow 32'); g.runCommand('/give bookshelf 16'); g.runCommand('/give enchanting_table'); g.runCommand('/give bed');
    g.ui.openScreen('inventory');
  });
  await page.waitForTimeout(300);
  // shift-click the four armor pieces from the hotbar into their slots
  for (let i = 0; i < 4; i++) await page.click(`.hotbar-row .slot[data-i="${i}"]`, { modifiers: ['Shift'] });
  await page.waitForTimeout(200);
  const arm = await G(() => { const p = window.__blockforge.game.player; return { a: p.armorStats(), slots: [36, 37, 38, 39].map((i) => p.inventory.get(i) && p.inventory.get(i).id) }; });
  assert(arm.a.points === 15, `full iron armor gives 15 points (${arm.a.points})`);
  // armor slots refuse the wrong piece
  await page.click('.hotbar-row .slot[data-i="4"]'); // pick up the sword
  await page.click('.armor-slot[data-i="36"]');
  const refused = await G(() => { const g = window.__blockforge.game; return { cursor: g.ui.cursor && g.ui.cursor.id, head: g.player.inventory.get(36).id }; });
  assert(refused.cursor !== undefined && refused.cursor !== null, 'a sword cannot go in the helmet slot');
  await page.click('.hotbar-row .slot[data-i="4"]');
  await page.hover('.armor-slot[data-i="37"]');
  await page.waitForTimeout(300);
  await shot('43-inventory-armor');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // ---- enchanting ------------------------------------------------------------
  const tbl = await G(() => {
    const g = window.__blockforge.game, p = g.player, w = g.world, { B } = window.__blockforge;
    const x = Math.floor(p.x) + 3, z = Math.floor(p.z), y = w.surfaceY(x, z) + 1;
    for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) { w.setBlock(x + dx, y - 1, z + dz, B.stone, 0); for (let dy = 0; dy < 4; dy++) w.setBlock(x + dx, y + dy, z + dz, 0, 0); }
    w.setBlock(x, y, z, B.enchanting_table, 0);
    let n = 0;
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) if (Math.max(Math.abs(dx), Math.abs(dz)) === 2 && dx !== -2) { w.setBlock(x + dx, y, z + dz, B.bookshelf, 0); n++; }
    p.x = p.px = x - 1.5; p.z = p.pz = z + 0.5; p.y = p.py = y; p.yaw = Math.PI / 2; p.pitch = -0.4;
    p.xpLevel = 30;
    g.useBlock({ x, y, z, id: B.enchanting_table }, null);
    return { x, y, z, shelves: g.ui.screen && g.ui.screen.data.shelves };
  });
  assert(tbl.shelves >= 10, `bookshelves counted around the table (${tbl.shelves})`);
  await page.waitForTimeout(200);
  await page.click('.hotbar-row .slot[data-i="4"]', { modifiers: ['Shift'] });
  await page.waitForTimeout(300);
  await shot('44-enchanting');
  const opts = await page.$$eval('.eopt', (els) => els.map((e) => ({ dis: e.disabled, t: e.textContent.trim() })));
  console.log('enchant options', JSON.stringify(opts));
  assert(opts.length === 3 && opts.every((o) => !o.dis), 'three enchantment options available at level 30');
  await page.click('.eopt:nth-child(3)');
  await page.waitForTimeout(200);
  const ench = await G(() => { const g = window.__blockforge.game; return { item: g.enchantSlot.get(0), lvl: g.player.xpLevel }; });
  assert(ench.item && ench.item.ench && Object.keys(ench.item.ench).length > 0, 'sword enchanted: ' + JSON.stringify(ench.item && ench.item.ench));
  assert(ench.lvl === 27, `enchanting cost 3 levels (${ench.lvl})`);
  await page.hover('.enchant .slot');
  await page.waitForTimeout(300);
  await shot('45-enchanted-tooltip');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const back = await G(() => { const p = window.__blockforge.game.player; return p.inventory.slots.slice(0, 36).some((s) => s && s.ench); });
  assert(back, 'enchanted sword returned to the inventory on close');

  // ---- farming -------------------------------------------------------------
  const plot = await G(() => {
    const g = window.__blockforge.game, p = g.player, w = g.world, { B } = window.__blockforge;
    const x = Math.floor(p.x) - 4, z = Math.floor(p.z) + 3, y = Math.floor(p.y) - 1;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) { w.setBlock(x + dx, y, z + dz, B.dirt, 0); for (let dy = 1; dy < 40; dy++) w.setBlock(x + dx, y + dy, z + dz, 0, 0); }
    w.setBlock(x, y, z, B.water, 0);
    w.setBlock(x + 1, y, z, B.farmland, 7);
    w.setBlock(x + 1, y + 1, z, B.wheat, 0);
    return { x, y, z };
  });
  await page.waitForTimeout(2000); // let the chunk relight
  const farm = await G(({ x, y, z }) => {
    const g = window.__blockforge.game, w = g.world, { B } = window.__blockforge;
    for (let i = 0; i < 400; i++) g.randomTick(x + 1, y + 1, z, B.wheat);
    return { age: w.getMeta(x + 1, y + 1, z), id: w.getBlock(x + 1, y + 1, z), soil: w.getBlock(x + 1, y, z), light: w.getLight(x + 1, y + 1, z) >> 4 };
  }, plot);
  assert(farm.id !== 0 && farm.age === 7 && farm.soil !== 0, `wheat grows to maturity on watered farmland (age ${farm.age}, sky light ${farm.light})`);

  // ---- bow -----------------------------------------------------------------
  const bow = await G(() => {
    const g = window.__blockforge.game, p = g.player;
    const i = p.inventory.slots.findIndex((s) => s && s.id === window.__blockforge.I.bow);
    p.inventory.selected = i;
    g.runCommand('/summon pig');
    const pig = g.entities[g.entities.length - 1];
    // a clear shooting range toward -X
    const { B } = window.__blockforge, w = g.world;
    const bx = Math.floor(p.x) - 12, by = Math.floor(p.y), bz = Math.floor(p.z) - 8;
    for (let dx = -3; dx <= 3; dx++) for (let dz = -2; dz <= 2; dz++) { w.setBlock(bx + dx, by - 1, bz + dz, B.stone, 0); for (let dy = 0; dy < 4; dy++) w.setBlock(bx + dx, by + dy, bz + dz, 0, 0); }
    for (let dx = -10; dx <= 3; dx++) for (let dz = -1; dz <= 1; dz++) { w.setBlock(bx + dx, by - 1, bz + dz, B.stone, 0); for (let dy = 0; dy < 4; dy++) w.setBlock(bx + dx, by + dy, bz + dz, 0, 0); }
    p.x = p.px = bx + 2.5; p.z = p.pz = bz + 0.5; p.y = p.py = by; p.yaw = -Math.PI / 2;
    p.pitch = 0;
    const [dx, , dz] = g.lookDir();
    pig.x = p.x + dx * 5; pig.z = p.z + dz * 5; pig.y = p.y; pig.vx = pig.vz = 0;
    // aim at the middle of the pig
    p.pitch = -Math.atan2(p.y + p.eye - (pig.y + pig.h / 2), 5);
    g.bowDraw = 20;
    const arrows = p.inventory.count(window.__blockforge.I.arrow);
    g.releaseBow(); g.bowDraw = 0;
    return { arrows, pigId: pig.id, health: pig.health };
  });
  await page.waitForTimeout(1200);
  const bowAfter = await G((id) => { const g = window.__blockforge.game; const pig = g.entities.find((e) => e.id === id); return { health: pig ? pig.health : -1, dead: !pig || pig.dead, arrows: g.player.inventory.count(window.__blockforge.I.arrow) }; }, bow.pigId);
  assert(bowAfter.arrows === bow.arrows - 1, 'shooting uses an arrow');
  assert(bowAfter.dead || bowAfter.health < bow.health, `arrow hurts the pig (${bow.health} -> ${bowAfter.health})`);

  // ---- bed -----------------------------------------------------------------
  const bed = await G(() => {
    const g = window.__blockforge.game, p = g.player, w = g.world, { B } = window.__blockforge;
    for (const e of g.entities) if (e.hostile) e.dead = true;
    const x = Math.floor(p.x) - 6, z = Math.floor(p.z) - 6, y = Math.floor(p.y);
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 3; dx++) { w.setBlock(x + dx, y - 1, z + dz, B.stone, 0); for (let dy = 0; dy < 3; dy++) w.setBlock(x + dx, y + dy, z + dz, 0, 0); }
    p.x = p.px = x - 0.5; p.z = p.pz = z + 0.5;
    p.yaw = Math.PI / 2; // facing +X
    const ok = g.placeDouble(B.bed, x, y, z);
    g.dayTime = 14000;
    g.useBlock({ x, y, z, id: B.bed }, null);
    return { ok, sleeping: g.player.sleeping, screen: g.ui.screen && g.ui.screen.name };
  });
  assert(bed.ok && bed.sleeping > 0 && bed.screen === 'sleep', 'player lies down in the bed at night');
  await page.waitForTimeout(2500);
  await shot('46-sleeping');
  await page.waitForTimeout(3500);
  const woke = await G(() => { const g = window.__blockforge.game; return { t: g.dayTime, sleeping: g.player.sleeping, state: g.state, adv: [...g.advancements] }; });
  assert(woke.t < 2000 && !woke.sleeping, `sleeping skips the night (time ${woke.t})`);
  assert(woke.adv.includes('sleep'), 'sleep milestone awarded');
  await shot('47-toast');

  // ---- portal --------------------------------------------------------------
  const portal = await G(() => {
    const g = window.__blockforge.game, p = g.player, w = g.world, { B } = window.__blockforge;
    const x = Math.floor(p.x) + 3, z = Math.floor(p.z) + 5, y = Math.floor(p.y);
    for (let dx = -1; dx <= 4; dx++) for (let dz = -2; dz <= 2; dz++) { w.setBlock(x + dx, y - 1, z + dz, B.stone, 0); for (let dy = 0; dy < 6; dy++) w.setBlock(x + dx, y + dy, z + dz, 0, 0); }
    for (let i = 0; i < 4; i++) for (let j = 0; j < 5; j++) if (i === 0 || i === 3 || j === 0 || j === 4) w.setBlock(x + i, y + j, z, B.obsidian, 0);
    return { x, y, z };
  });
  // use flint and steel on the top face of the frame's bottom edge
  const litOk = await G(({ x, y, z }) => {
    const g = window.__blockforge.game, w = g.world, p = g.player, { B, I } = window.__blockforge;
    g.runCommand('/give flint_and_steel');
    p.inventory.selected = p.inventory.slots.findIndex((s) => s && s.id === I.flint_and_steel);
    p.x = p.px = x + 1.5; p.z = p.pz = z - 2.5; p.y = p.py = y; p.yaw = Math.PI; p.pitch = -0.35;
    g.targetEntity = null;
    g.target = { x: x + 1, y, z, id: B.obsidian, nx: 0, ny: 1, nz: 0 };
    g.use();
    let n = 0;
    for (let i = 1; i < 3; i++) for (let j = 1; j < 4; j++) if (w.getBlock(x + i, y + j, z) === B.rift) n++;
    return n;
  }, portal);
  assert(litOk === 6, `flint and steel fills the frame with rift blocks (${litOk})`);
  await G(({ x, y, z }) => { const g = window.__blockforge.game, p = g.player; g.dayTime = 13500; p.x = p.px = x + 2; p.z = p.pz = z - 4.5; p.y = p.py = y; p.yaw = Math.PI; p.pitch = -0.1; }, portal);
  await page.waitForTimeout(1200);
  await shot('48-portal');
  // step in and wait for the crossing
  await G(({ x, y, z }) => { const p = window.__blockforge.game.player; p.x = p.px = x + 2; p.z = p.pz = z + 0.5; p.y = p.py = y + 1; p.vx = p.vz = 0; }, portal);
  await page.waitForTimeout(2500);
  await shot('49-portal-inside');
  await page.waitForFunction(() => window.__blockforge.game.dim === 'underworld', null, { timeout: 30000 }).catch(() => {});
  const dim = await G(() => window.__blockforge.game.dim);
  assert(dim === 'underworld', 'standing in the rift carries the player to the underworld');
  if (dim === 'underworld') {
    await page.waitForFunction(() => window.__blockforge.game.state === 'playing', null, { timeout: 180000 });
    await waitReady(3000);
    const uw = await G(() => {
      const g = window.__blockforge.game, p = g.player, w = g.world, { B } = window.__blockforge;
      let rift = 0;
      for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) for (let dy = -2; dy <= 4; dy++) if (w.getBlock(Math.floor(p.x) + dx, Math.floor(p.y) + dy, Math.floor(p.z) + dz) === B.rift) rift++;
      return { x: p.x, y: p.y, z: p.z, rift, biome: w.gen.biomeName(Math.floor(p.x), Math.floor(p.z)), adv: [...g.advancements] };
    });
    console.log('underworld', JSON.stringify(uw));
    assert(uw.rift >= 6, 'a return portal stands where the player arrives');
    assert(uw.adv.includes('underworld'), 'underworld milestone awarded');
    await G(() => { const p = window.__blockforge.game.player; p.yaw += Math.PI; p.pitch = -0.05; p.mode = 'creative'; p.flying = true; });
    await page.waitForTimeout(1500);
    await shot('50-underworld');
    await G(() => { const g = window.__blockforge.game, p = g.player; p.y += 12; p.py = p.y; p.pitch = -0.3; g.runCommand('/summon imp'); });
    await page.waitForTimeout(1500);
    await shot('51-underworld-high');
    // back to the overworld through the portal
    await G(() => {
      const g = window.__blockforge.game, p = g.player, w = g.world, { B } = window.__blockforge;
      p.mode = 'survival'; p.flying = false; p.fireTicks = 0;
      for (const e of g.entities) if (e.hostile) e.dead = true;
      for (let dz = -6; dz <= 6; dz++) for (let dx = -6; dx <= 6; dx++) for (let dy = -16; dy <= 6; dy++) {
        const x = Math.floor(p.x) + dx, y = Math.floor(p.y) + dy, z = Math.floor(p.z) + dz;
        if (w.getBlock(x, y, z) === B.rift && w.getBlock(x, y - 1, z) !== B.rift) { p.x = p.px = x + 0.5; p.y = p.py = y; p.z = p.pz = z + 0.5; p.portalCooldown = 0; return; }
      }
    });
    await page.waitForFunction(() => window.__blockforge.game.dim === 'overworld' && window.__blockforge.game.state === 'playing', null, { timeout: 60000 }).catch(() => {});
    const home = await G(() => window.__blockforge.game.dim);
    assert(home === 'overworld', 'the rift leads back to the overworld');
  }

  // ---- creatures and weather ---------------------------------------------
  await waitReady(1000);
  await G(() => {
    const g = window.__blockforge.game, p = g.player;
    p.mode = 'creative';
    g.dayTime = 18000;
    const [dx, , dz] = g.lookDir();
    for (const [t, side] of [['archer', -2], ['crawler', 0], ['settler', 2], ['imp', 4]]) {
      g.runCommand(`/summon ${t}`);
      const e = g.entities[g.entities.length - 1];
      e.x = p.x + dx * 5 - dz * side; e.z = p.z + dz * 5 + dx * side; e.y = p.y + 1;
      e.target = null;
    }
    p.pitch = -0.1;
  });
  await page.waitForTimeout(800);
  await shot('52-creatures-night');
  await G(() => { const g = window.__blockforge.game, p = g.player; g.dayTime = 6000; g.runCommand('/weather thunder'); g.rain = 1; const [dx, , dz] = g.lookDir(); g.strike(p.x + dx * 14, p.y, p.z + dz * 14); });
  await page.waitForTimeout(250);
  await shot('53-lightning');

  // ---- persistence of the new state ---------------------------------------
  const saved = await G(async () => {
    const g = window.__blockforge.game;
    await g.save();
    return { level: g.player.xpLevel, adv: g.meta.advancements.length, dims: Object.keys(g.meta.dims || {}) };
  });
  console.log('saved', JSON.stringify(saved));
  assert(saved.dims.includes('overworld') && saved.dims.includes('underworld'), 'both dimensions saved');

  const perf = await G(() => ({ fps: window.__blockforge.game.fps }));
  console.log('fps (software GL):', perf.fps);
  assert(errors.length === 0, 'no page errors' + (errors.length ? ':\n' + errors.slice(0, 5).join('\n') : ''));
  await browser.close();
})();
