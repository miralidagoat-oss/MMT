// Feature test for round four: the photon blaster and sky rockets, the new
// creatures, comparators/observers/droppers, anvils, looms, banners, frames,
// paintings, beacons, void chests, cauldrons, the new biomes and structures,
// and HD textures.
// Usage: node tools/round4.cjs <url> <outdir>
const { chromium } = require('playwright');
const url = process.argv[2];
const out = process.argv[3] || '.';
const assert = (c, m) => { if (!c) { console.log('FAIL:', m); process.exitCode = 1; } else console.log('ok:', m); };
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await (await browser.newContext({ viewport: { width: 960, height: 540 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message + '\n' + e.stack));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('ERR_CERT')) errors.push(m.text()); });
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#b-play'), null, { timeout: 60000 });
  await page.evaluate(() => { const b = window.__blockforge; b.quality.applyPreset(b.settings, 'balanced'); b.settings.renderDistance = 4; b.ui.app.applySettings(); });

  // HD textures are the default on balanced, and switch live
  let r = await page.evaluate(() => ({ detail: window.__blockforge.renderer.texDetail, relief: !!window.__blockforge.renderer.normalTex }));
  assert(r.detail === 4 && r.relief, `HD textures (64px) with relief maps on the balanced preset (${JSON.stringify(r)})`);

  await page.click('#b-play'); await page.waitForTimeout(200);
  await page.click('#b-new'); await page.waitForTimeout(200);
  await page.fill('#w-seed', 'round four');
  await page.click('#b-create');
  await page.waitForFunction(() => window.__blockforge.game.state === 'playing', null, { timeout: 180000 });
  await page.waitForTimeout(1200);

  // a flat test pad
  await page.evaluate(() => {
    const g = window.__blockforge.game, p = g.player, w = g.world, { B } = window.__blockforge;
    g.dayTime = 6000; g.settings.daylightCycle = false; g.rain = 0; p.mode = 'survival';
    const x0 = Math.floor(p.x), z0 = Math.floor(p.z), y0 = w.surfaceY(x0, z0);
    for (let x = -12; x <= 12; x++) for (let z = -12; z <= 12; z++) { w.setBlock(x0 + x, y0 - 1, z0 + z, B.grass, 0); for (let y = 0; y < 10; y++) w.setBlock(x0 + x, y0 + y, z0 + z, 0, 0); }
    p.x = p.px = x0 + 0.5; p.z = p.pz = z0 + 0.5; p.y = p.py = y0;
    g.entities = g.entities.filter((e) => !e.isMob);
    window.__pad = { x0, y0, z0 };
  });
  const reset = () => page.evaluate(() => { const g = window.__blockforge.game, p = g.player, { x0, y0, z0 } = window.__pad; p.x = p.px = x0 + 0.5; p.z = p.pz = z0 + 0.5; p.y = p.py = y0; p.vx = p.vy = p.vz = 0; p.health = 20; p.effects = {}; if (p.vehicle) g.dismount(); });

  // --- the photon blaster
  r = await page.evaluate(() => {
    const g = window.__blockforge.game, p = g.player, { I } = window.__blockforge;
    p.inventory.set(0, { id: I.photon_blaster, count: 1 }); p.inventory.set(1, { id: I.energy_cell, count: 2 }); p.inventory.selected = 0;
    g.runCommand('/summon pig');
    const pig = g.entities[g.entities.length - 1];
    const dx = Math.sin(p.yaw), dz = -Math.cos(p.yaw);
    pig.x = pig.px = p.x + dx * 6; pig.z = pig.pz = p.z + dz * 6; pig.y = pig.py = p.y; pig.noAI = true;
    p.pitch = Math.atan2(pig.y + 0.45 - (p.y + p.eye), 6);
    g.updateTarget(1);
    const hp = pig.health;
    for (let i = 0; i < 30; i++) { g.tickBlaster(p.inventory.held, true, i === 0, false); g.tickEntities(); }
    const charge = p.inventory.held.charge;
    p.inventory.held.charge = 1; g.tickBlaster(p.inventory.held, true, true, false);
    for (let i = 0; i < 40; i++) g.tickBlaster(p.inventory.held, false, false, false);
    return { hp, after: pig.health, dead: pig.dead, charge, reloaded: p.inventory.held.charge, cells: p.inventory.count(I.energy_cell) };
  });
  assert(r.after < r.hp || r.dead, `laser bolts hurt what they hit (${r.hp} -> ${r.after})`);
  assert(r.charge < 48, 'firing uses charge');
  assert(r.reloaded === 48 && r.cells === 1, 'an empty blaster reloads from an energy cell');

  // --- creatures
  await reset();
  r = await page.evaluate(() => {
    const g = window.__blockforge.game, { I } = window.__blockforge, { x0, y0, z0 } = window.__pad;
    g.entities = g.entities.filter((e) => !e.isMob);
    g.runCommand('/summon hound');
    const h = g.entities[g.entities.length - 1];
    h.x = h.px = x0 + 2.5; h.z = h.pz = z0 + 0.5; h.y = h.py = y0;
    let tries = 0;
    while (!h.tamed && tries < 60) { tries++; h.interact(g, { id: I.bone, count: 64 }); }
    h.interact(g, null);
    g.runCommand('/summon ghoul');
    const gh = g.entities[g.entities.length - 1];
    gh.x = gh.px = x0 + 5.5; gh.z = gh.pz = z0 + 4.5; gh.y = gh.py = y0;
    g.lastAttackTarget = gh;
    for (let i = 0; i < 160 && !gh.dead; i++) g.tickEntities();
    return { tamed: h.tamed, ghoulDead: gh.dead || gh.health <= 0 };
  });
  assert(r.tamed, 'a hound is tamed with bones');
  assert(r.ghoulDead, 'a tamed hound fights for its owner');
  await reset();
  r = await page.evaluate(() => {
    const g = window.__blockforge.game, p = g.player, { I } = window.__blockforge, { x0, y0, z0 } = window.__pad;
    g.runCommand('/summon steed');
    const s = g.entities[g.entities.length - 1];
    s.x = s.px = x0 - 3.5; s.z = s.pz = z0 + 0.5; s.y = s.py = y0;
    s.interact(g, null);
    for (let t = 0; t < 3000 && !s.tamed; t++) { g.tick(); if (p.vehicle !== s) s.interact(g, null); }
    if (p.vehicle === s) g.dismount();
    s.interact(g, { id: I.saddle, count: 1 });
    s.interact(g, null);
    const x1 = s.x, z1 = s.z;
    for (let i = 0; i < 40; i++) { p.vehicle && (p.vehicle.riderInput = { forward: 1, strafe: 0, jump: false, sneak: false, sprint: false }); g.tickEntities(); g.syncRider(); }
    const moved = Math.hypot(s.x - x1, s.z - z1);
    g.dismount();
    return { tamed: s.tamed, saddled: s.saddled, moved };
  });
  assert(r.tamed && r.saddled, 'a steed is broken in and saddled');
  assert(r.moved > 5, `a saddled steed can be ridden (${r.moved.toFixed(1)} blocks)`);
  await reset();
  r = await page.evaluate(() => {
    const g = window.__blockforge.game, w = g.world, { B } = window.__blockforge, { x0, y0, z0 } = window.__pad;
    g.entities = g.entities.filter((e) => !e.isMob);
    const ix = x0 + 6, iz = z0 - 6;
    w.setBlock(ix, y0, iz, B.iron_block, 0); w.setBlock(ix, y0 + 1, iz, B.iron_block, 0);
    w.setBlock(ix - 1, y0 + 1, iz, B.iron_block, 0); w.setBlock(ix + 1, y0 + 1, iz, B.iron_block, 0);
    w.setBlock(ix, y0 + 2, iz, B.carved_pumpkin, 2);
    const built = g.tryBuildGolem(ix, y0 + 2, iz);
    g.runCommand('/summon ghoul');
    const gh = g.entities[g.entities.length - 1];
    gh.x = gh.px = x0 + 0.5; gh.z = gh.pz = z0 - 8.5; gh.y = gh.py = y0;
    for (let i = 0; i < 300 && !gh.dead; i++) g.tickEntities();
    return { built, sentinel: g.entities.some((e) => e.type === 'sentinel'), ghoulDead: gh.dead || gh.health <= 0 };
  });
  assert(r.built && r.sentinel, 'iron blocks and a carved pumpkin build a sentinel');
  assert(r.ghoulDead, 'the sentinel defends against hostile creatures');
  await reset();
  r = await page.evaluate(() => {
    const g = window.__blockforge.game, p = g.player, { x0, y0, z0 } = window.__pad;
    g.entities = g.entities.filter((e) => !e.isMob);
    g.runCommand('/summon hexer');
    const h = g.entities[g.entities.length - 1];
    h.x = h.px = x0 + 7.5; h.z = h.pz = z0 + 0.5; h.y = h.py = y0;
    let potions = 0;
    const orig = g.mobThrow; g.mobThrow = function (...a) { if (a[1] === 'potion') potions++; return orig.apply(this, a); };
    const fx = new Set();
    for (let i = 0; i < 300; i++) { g.tick(); for (const k of Object.keys(p.effects || {})) fx.add(k); if (p.health < 8) p.health = 20; }
    g.mobThrow = orig;
    return { potions, effects: [...fx] };
  });
  assert(r.potions > 0 && r.effects.length > 0, `hexers throw potions that land (${JSON.stringify(r)})`);

  // --- circuit parts and workstations
  await reset();
  r = await page.evaluate(() => {
    const g = window.__blockforge.game, p = g.player, w = g.world, { B, I } = window.__blockforge, { x0, y0, z0 } = window.__pad;
    g.entities = g.entities.filter((e) => !e.isMob);
    const cy = y0, run = (n) => { for (let i = 0; i < n; i++) g.tick(); };
    const res = {};
    w.setBlock(x0 + 2, cy, z0 - 4, B.chest, 0);
    const ch = g.containerAt(x0 + 2, cy, z0 - 4);
    for (let i = 0; i < 27; i++) ch.slots[i] = { id: B.cobblestone, count: 64 };
    w.setBlock(x0 + 3, cy, z0 - 4, B.comparator, 1);
    for (let k = 4; k <= 6; k++) w.setBlock(x0 + k, cy, z0 - 4, B.spark_wire, 0);
    run(30);
    res.comparator = w.getMeta(x0 + 3, cy, z0 - 4) >> 4;
    res.wire = w.getMeta(x0 + 4, cy, z0 - 4) & 15;
    const oz = z0 - 7;
    w.setBlock(x0 + 3, cy, oz, B.observer, 2); w.setBlock(x0 + 4, cy, oz, B.dirt, 0); w.setBlock(x0 + 2, cy, oz, B.spark_lamp, 0);
    run(10);
    w.setBlock(x0 + 4, cy, oz, B.cobblestone, 0);
    let lit = false;
    for (let i = 0; i < 12; i++) { g.tick(); if (w.getBlock(x0 + 2, cy, oz) === B.spark_lamp_on) lit = true; }
    res.observer = lit;
    const dz = z0 - 9;
    w.setBlock(x0 + 3, cy, dz, B.dropper, 2);
    g.useBlockExtra({ x: x0 + 3, y: cy, z: dz, id: B.dropper }, null); g.ui.closeScreen(true);
    w.blockEntities.get(`${x0 + 3},${cy},${dz}`).slots[0] = { id: I.apple, count: 5 };
    w.setBlock(x0 + 4, cy, dz, B.chest, 0);
    w.setBlock(x0 + 3, cy + 1, dz, B.lever, 0);
    g.circuits.toggleLever(x0 + 3, cy + 1, dz);
    run(20);
    res.dropper = g.containerAt(x0 + 4, cy, dz).slots.reduce((n, s) => n + (s ? s.count : 0), 0);
    // anvil: repair with ingots and rename
    w.setBlock(x0 - 3, cy, z0, B.anvil, 0);
    g.ui.openScreen('anvil', { x: x0 - 3, y: cy, z: z0 });
    g.anvilSlots.set(0, { id: I.iron_pickaxe, count: 1, dur: 120 });
    g.anvilSlots.set(1, { id: I.iron_ingot, count: 5 });
    g.ui.refreshSlots();
    g.ui.anvilName = 'Old Faithful';
    p.xpLevel = 20;
    g.ui.takeAnvil();
    res.anvil = g.ui.cursor ? { label: g.ui.cursor.label, dur: g.ui.cursor.dur || 0 } : null;
    g.ui.cursor = null; g.ui.closeScreen(true);
    // loom
    w.setBlock(x0 - 3, cy, z0 + 2, B.loom, 0);
    g.ui.openScreen('loom', { x: x0 - 3, y: cy, z: z0 + 2 });
    g.loomSlots.set(0, { id: I.blue_banner, count: 1 }); g.loomSlots.set(1, { id: B.yellow_wool, count: 1 });
    g.ui.loomPattern = 11; g.ui.refreshSlots(); g.ui.takeLoom();
    res.loom = g.ui.cursor && g.ui.cursor.bn;
    const banner = g.ui.cursor; g.ui.cursor = null; g.ui.closeScreen(true);
    // decor on a wall
    for (let x = -4; x <= 4; x++) for (let y = 0; y < 4; y++) w.setBlock(x0 + x, cy + y, z0 + 5, B.oak_planks, 0);
    p.inventory.set(0, banner); p.inventory.selected = 0;
    g.useItemFirst(p.inventory.held, { x: x0 + 3, y: cy + 2, z: z0 + 5, id: B.oak_planks, face: 5 });
    p.inventory.set(0, { id: I.item_frame, count: 1 });
    g.useItemFirst(p.inventory.held, { x: x0 + 1, y: cy + 1, z: z0 + 5, id: B.oak_planks, face: 5 });
    const frame = g.entities.find((e) => e.isFrame);
    if (frame) frame.interact(g, { id: I.diamond_sword, count: 1 });
    p.inventory.set(0, { id: I.painting, count: 1 });
    g.useItemFirst(p.inventory.held, { x: x0 - 2, y: cy + 1, z: z0 + 5, id: B.oak_planks, face: 5 });
    res.banner = w.getBlock(x0 + 3, cy + 2, z0 + 4) === B.wall_banner && (w.blockEntities.get(`${x0 + 3},${cy + 2},${z0 + 4}`) || {}).bn;
    res.frame = frame && frame.stack && frame.stack.id === I.diamond_sword;
    res.painting = g.entities.some((e) => e.isPainting);
    // beacon on a 3x3 iron base
    const bx = x0 + 7, bz = z0;
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) w.setBlock(bx + x, cy, bz + z, B.iron_block, 0);
    w.setBlock(bx, cy + 1, bz, B.beacon, 0);
    g.useBlockExtra({ x: bx, y: cy + 1, z: bz, id: B.beacon }, null);
    g.beaconSlot.set(0, { id: I.iron_ingot, count: 1 });
    g.ui.beaconPick = 'speed'; g.ui.confirmBeacon(); g.ui.closeScreen(true);
    p.effects = {};
    run(90);
    res.beacon = !!(p.effects && p.effects.speed);
    // void chests share one inventory
    w.setBlock(x0 - 6, cy, z0, B.void_chest, 0); w.setBlock(x0 - 6, cy, z0 + 3, B.void_chest, 0);
    g.useBlockExtra({ x: x0 - 6, y: cy, z: z0, id: B.void_chest }, null);
    g.ui.screen.data.be.slots[4] = { id: I.diamond, count: 3 }; g.ui.closeScreen(true);
    g.useBlockExtra({ x: x0 - 6, y: cy, z: z0 + 3, id: B.void_chest }, null);
    res.voidChest = g.ui.screen.data.be.slots[4] && g.ui.screen.data.be.slots[4].count; g.ui.closeScreen(true);
    // cauldron
    w.setBlock(x0 - 6, cy, z0 - 3, B.cauldron, 0);
    p.inventory.set(0, { id: I.water_bucket, count: 1 });
    g.useCauldron({ x: x0 - 6, y: cy, z: z0 - 3 }, p.inventory.held);
    res.cauldron = w.getMeta(x0 - 6, cy, z0 - 3) & 3;
    return res;
  });
  assert(r.comparator >= 14 && r.wire > 0, `a comparator reads a full chest (${r.comparator}) and drives wire`);
  assert(r.observer, 'an observer pulses when the block it watches changes');
  assert(r.dropper === 1, 'a powered dropper passes an item into the chest in front');
  assert(r.anvil && r.anvil.label === 'Old Faithful' && r.anvil.dur < 120, `the anvil repairs and renames (${JSON.stringify(r.anvil)})`);
  assert(r.loom && r.loom.length === 1 && r.loom[0][0] === 'star', 'the loom adds a pattern to a banner');
  assert(r.banner && r.banner.length === 1, 'a patterned banner hangs on a wall');
  assert(r.frame, 'an item frame holds an item');
  assert(r.painting, 'a painting fits on the wall');
  assert(r.beacon, 'a beacon on an iron pyramid grants its power');
  assert(r.voidChest === 3, 'every void chest opens the same storage');
  assert(r.cauldron === 3, 'a water bucket fills a cauldron');
  await page.evaluate(() => { const g = window.__blockforge.game, p = g.player, { x0, y0, z0 } = window.__pad; p.flying = true; p.x = p.px = x0 + 0.5; p.z = p.pz = z0 - 0.5; p.y = p.py = y0 + 0.4; p.yaw = Math.PI; p.pitch = 0.12; g.perspective = 0; });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/r4-decor.png` });

  // --- biomes and structures
  r = await page.evaluate(() => {
    const g = window.__blockforge.game, gen = g.world.gen, names = window.__blockforge.BIOMES.map((b) => b.name);
    const seen = new Set();
    for (let z = -4000; z < 4000; z += 40) for (let x = -4000; x < 4000; x += 40) seen.add(names[gen.biomeAt(x, z)]);
    const lm = {};
    for (const k of ['mineshaft', 'temple', 'shrine', 'hut', 'citadel', 'manor']) lm[k] = /The nearest/.test(g.runCommand('/locate ' + k));
    return { biomes: ['Jungle', 'Badlands', 'Dark Forest', 'Mushroom Fields', 'Ice Spikes'].filter((n) => seen.has(n)), lm };
  });
  assert(r.biomes.length === 5, `the new biomes generate (${r.biomes.join(', ')})`);
  for (const [k, v] of Object.entries(r.lm)) assert(v, `/locate finds a ${k}`);

  // texture detail switches live without errors
  r = await page.evaluate(() => {
    const b = window.__blockforge;
    b.settings.textures = 1; b.ui.app.applySettings();
    const classic = b.renderer.texDetail;
    b.settings.textures = 4; b.ui.app.applySettings();
    return { classic, hd: b.renderer.texDetail };
  });
  assert(r.classic === 1 && r.hd === 4, 'texture detail switches between classic and HD live');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/r4-hd.png` });

  console.log('ERRORS:', errors.length ? '\n' + errors.join('\n') : 'none');
  if (errors.length) process.exitCode = 1;
  await browser.close();
})();
