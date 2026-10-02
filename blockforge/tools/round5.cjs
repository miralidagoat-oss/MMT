// Feature test for round five: pathfinding, foxes, cats, parrots, bees and
// hives, alpacas, dolphins, dyes, the composter, lectern, crafter,
// grindstone and smithing table, enchanted books, the blossom grove,
// outposts, igloos, shipwrecks, starsteel, raiders and raids.
// Usage: node tools/round5.cjs <url> <outdir>
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
  await page.goto(url, { timeout: 120000 });
  await page.waitForFunction(() => document.querySelector('#b-play'), null, { timeout: 60000 });
  await page.evaluate(() => { const b = window.__blockforge; b.quality.applyPreset(b.settings, 'balanced'); b.settings.renderDistance = 4; b.ui.app.applySettings(); });
  await page.click('#b-play'); await page.waitForTimeout(200);
  await page.click('#b-new'); await page.waitForTimeout(200);
  await page.fill('#w-seed', 'round five');
  await page.click('#b-create');
  await page.waitForFunction(() => window.__blockforge.game.state === 'playing', null, { timeout: 180000 });
  await page.waitForTimeout(1200);
  const shot = (n) => page.screenshot({ path: `${out}/${n}.png` });

  // a flat pad open to the sky
  await page.evaluate(() => {
    const g = window.__blockforge.game, p = g.player, w = g.world, { B } = window.__blockforge;
    g.dayTime = 6000; g.settings.daylightCycle = false; g.rain = 0; g.rainTarget = 0; p.mode = 'survival';
    const x0 = Math.floor(p.x), z0 = Math.floor(p.z), y0 = w.surfaceY(x0, z0);
    for (let x = -14; x <= 14; x++) for (let z = -14; z <= 14; z++) { w.setBlock(x0 + x, y0 - 1, z0 + z, B.grass, 0); for (let y = 0; y < 48; y++) w.setBlock(x0 + x, y0 + y, z0 + z, 0, 0); }
    p.x = p.px = x0 + 0.5; p.z = p.pz = z0 + 0.5; p.y = p.py = y0;
    g.entities = g.entities.filter((e) => !e.isMob);
    window.__pad = { x0, y0, z0 };
  });
  const reset = () => page.evaluate(() => {
    const g = window.__blockforge.game, p = g.player, w = g.world, { B } = window.__blockforge, { x0, y0, z0 } = window.__pad;
    for (let x = -14; x <= 14; x++) for (let z = -14; z <= 14; z++) { w.setBlock(x0 + x, y0 - 1, z0 + z, B.grass, 0); for (let y = 0; y < 8; y++) w.setBlock(x0 + x, y0 + y, z0 + z, 0, 0); }
    p.x = p.px = x0 + 0.5; p.z = p.pz = z0 + 0.5; p.y = p.py = y0; p.vx = p.vy = p.vz = 0; p.health = 20; p.effects = {}; p.sneaking = false;
    if (p.vehicle) g.dismount();
    g.entities = g.entities.filter((e) => !e.isMob); g.items = [];
    g.dayTime = 6000; g.raid = null;
  });
  let r;

  // --- pathfinding: a raider walks around a wall to reach the player
  await reset();
  r = await page.evaluate(() => {
    const bf = window.__blockforge, g = bf.game, p = g.player, w = g.world, { B } = bf, { x0, y0, z0 } = window.__pad;
    // a wall between the raider and the player, open only at one end
    for (let x = -8; x <= 5; x++) for (let y = 0; y < 3; y++) w.setBlock(x0 + x, y0 + y, z0 - 3, B.cobblestone, 0);
    const m = new bf.Mob('marauder', x0 + 0.5, y0, z0 - 7.5); g.entities.push(m);
    m.target = p; // it heard the player before the wall hid them
    let reached = -1, searches = 0;
    const orig = g.world.getBlock;
    for (let i = 0; i < 600; i++) {
      g.tickEntities();
      if (m.nav && m.nav.age === 0) searches++;
      if (Math.hypot(m.x - p.x, m.z - p.z) < 2.2) { reached = i; break; }
      p.health = 20;
    }
    void orig;
    return { reached, x: m.x, z: m.z, searches, pathLen: m.nav && m.nav.path ? m.nav.path.length : 0 };
  });
  assert(r.reached > 0, `a raider finds its way around a wall to the player (${JSON.stringify(r)})`);

  // a settler opens a door on its way home and closes it behind it
  await reset();
  r = await page.evaluate(() => {
    const bf = window.__blockforge, g = bf.game, w = g.world, { B } = bf, { x0, y0, z0 } = window.__pad;
    // a closed hut: walls all round with one door
    for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) for (let y = 0; y < 3; y++) {
      if (Math.abs(x) === 3 || Math.abs(z) === 3) w.setBlock(x0 + 8 + x, y0 + y, z0 + z, B.oak_planks, 0);
    }
    w.setBlock(x0 + 8, y0, z0 + 3, B.oak_door, 2); w.setBlock(x0 + 8, y0 + 1, z0 + 3, B.oak_door, 2 | 8);
    const s = new bf.Mob('settler', x0 + 8.5, y0, z0 + 6.5, { profession: 'farmer', home: { x: x0 + 8.5, y: y0, z: z0 + 0.5 } });
    s.wx = x0 + 8.5; s.wz = z0 + 0.5; s.wy = y0; s.wanderTimer = 1000;
    g.entities.push(s);
    let inside = false, opened = false;
    for (let i = 0; i < 500; i++) {
      g.tickEntities();
      if (w.getMeta(x0 + 8, y0, z0 + 3) & 4) opened = true;
      if (Math.abs(s.x - (x0 + 8.5)) < 2 && Math.abs(s.z - (z0 + 0.5)) < 2) { inside = true; }
      if (inside && opened && !(w.getMeta(x0 + 8, y0, z0 + 3) & 4)) break;
      s.wx = x0 + 8.5; s.wz = z0 + 0.5; s.wy = y0; s.wanderTimer = 1000;
    }
    const closed = !(w.getMeta(x0 + 8, y0, z0 + 3) & 4);
    for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) for (let y = 0; y < 3; y++) w.setBlock(x0 + 8 + x, y0 + y, z0 + z, 0, 0);
    return { inside, opened, closed, x: s.x, z: s.z };
  });
  assert(r.inside && r.opened, `a settler opens the door and goes inside (${JSON.stringify(r)})`);
  assert(r.closed, 'and shuts the door behind it');

  // --- foxes
  await reset();
  r = await page.evaluate(() => {
    const bf = window.__blockforge, g = bf.game, p = g.player, { I } = bf, { x0, y0, z0 } = window.__pad;
    p.x = p.px = x0 + 12.5; p.z = p.pz = z0 + 12.5; // far enough not to scare it
    g.dayTime = 15000; // foxes forage at night
    const f = new bf.Mob('fox', x0 + 0.5, y0, z0 + 0.5, { variant: 'red' }); g.entities.push(f);
    g.dropItem(x0 + 3.5, y0 + 0.2, z0 + 0.5, { id: I.sweet_berries, count: 1 });
    for (const it of g.items) it.pickupDelay = 0;
    for (let i = 0; i < 300 && !f.held; i++) g.tickEntities();
    const held = f.held && f.held.id === I.sweet_berries;
    // by day it dozes
    g.dayTime = 6000;
    for (let i = 0; i < 1500 && !f.sleeping; i++) g.tickEntities();
    // a sneaking player can come close; one who doesn't is fled from
    return { held, sleeping: f.sleeping };
  });
  assert(r.held, 'a fox picks up an item in its mouth');
  assert(r.sleeping, 'foxes doze through the day');

  // --- cats
  await reset();
  r = await page.evaluate(() => {
    const bf = window.__blockforge, g = bf.game, { I } = bf, { x0, y0, z0 } = window.__pad;
    const c = new bf.Mob('cat', x0 + 2.5, y0, z0 + 0.5, { variant: 'tabby' }); g.entities.push(c);
    let tries = 0;
    while (!c.tamed && tries < 60) { tries++; c.interact(g, { id: I.raw_silverfin, count: 64 }); }
    const sitting = c.sitting;
    // crawlers keep away from cats
    const cr = new bf.Mob('crawler', x0 + 4.5, y0, z0 + 0.5); g.entities.push(cr);
    const d0 = Math.hypot(cr.x - c.x, cr.z - c.z);
    for (let i = 0; i < 60; i++) { g.tickEntities(); g.player.health = 20; }
    const d1 = Math.hypot(cr.x - c.x, cr.z - c.z);
    // a cat brings its owner a present in the morning
    c.sitting = false;
    const before = g.items.length;
    let gifted = 0;
    for (let k = 0; k < 10 && !gifted; k++) { g.onNightSkipped(); gifted = g.items.length - before; }
    return { tamed: c.tamed, sitting, fled: d1 > d0 + 1, d0, d1, gifted };
  });
  assert(r.tamed && r.sitting, 'a stray cat is won over with fish');
  assert(r.fled, `crawlers back away from cats (${r.d0.toFixed(1)} -> ${r.d1.toFixed(1)})`);
  assert(r.gifted > 0, 'a tame cat leaves a gift after its owner sleeps');

  // --- parrots
  await reset();
  r = await page.evaluate(() => {
    const bf = window.__blockforge, g = bf.game, p = g.player, { I } = bf, { x0, y0, z0 } = window.__pad;
    const q = new bf.Mob('parrot', x0 + 1.5, y0 + 2, z0 + 0.5, { variant: 'scarlet' }); g.entities.push(q);
    let tries = 0;
    while (!q.tamed && tries < 60) { tries++; q.interact(g, { id: I.wheat_seeds, count: 64 }); }
    q.interact(g, null); // stand up
    q.perchCool = 0;
    let flew = false;
    for (let i = 0; i < 900 && !q.perch; i++) { g.tick(); if (q.flying) flew = true; p.vx = p.vz = 0; }
    for (let i = 0; i < 3; i++) { g.tick(); p.vx = p.vz = 0; } // it settles onto the shoulder
    const onShoulder = q.perch === p && Math.abs(q.y - (p.y + 1.42)) < 0.2;
    // and it hops off when its friend jumps into water
    return { tamed: q.tamed, flew, onShoulder };
  });
  assert(r.tamed, 'a parrot is tamed with seeds');
  assert(r.onShoulder, `a tame parrot perches on its owner's shoulder (${JSON.stringify(r)})`);
  await page.evaluate(() => { const p = window.__blockforge.game.player; p.yaw = Math.PI * 0.85; p.pitch = 0; });
  await page.waitForTimeout(1500);
  await shot('50-parrot-shoulder-third-person');

  // --- bees and hives
  await reset();
  r = await page.evaluate(() => {
    const bf = window.__blockforge, g = bf.game, p = g.player, w = g.world, { B, I } = bf, { x0, y0, z0 } = window.__pad;
    const hx = x0 + 4, hy = y0 + 2, hz = z0 - 4;
    w.setBlock(hx, hy - 2, hz, B.oak_log, 0); w.setBlock(hx, hy - 1, hz, B.oak_log, 0);
    w.setBlock(hx, hy, hz, B.beehive, 4); // front faces +Z
    for (let i = 0; i < 6; i++) w.setBlock(x0 - 4 + i, y0, z0 - 6, B.poppy, 0);
    w.setBlock(x0 + 1, y0, z0 + 3, B.wheat, 2); w.setBlock(x0 + 1, y0 - 1, z0 + 3, B.farmland, 7);
    const bee = new bf.Mob('bee', hx + 0.5, hy, hz + 2.5, { hive: { x: hx, y: hy, z: hz } }); g.entities.push(bee);
    p.x = p.px = x0 - 10; p.z = p.pz = z0 + 10;
    let pollen = false, home = false;
    for (let i = 0; i < 2400 && !home; i++) {
      g.tickEntities();
      if (bee.pollen) pollen = true;
      if (bee.removed) home = true;
    }
    const be = w.blockEntities.get(`${hx},${hy},${hz}`);
    const stored = be && be.bees ? be.bees.length : 0;
    const honey = w.getMeta(hx, hy, hz) >> 3;
    // a full hive gives honey to a bottle; without smoke the bees take it badly
    w.setBlock(hx, hy, hz, B.beehive, 4 | (5 << 3));
    p.x = p.px = hx + 0.5; p.z = p.pz = hz + 2.5; p.y = p.py = y0;
    p.inventory.set(0, { id: I.glass_bottle, count: 1 }); p.inventory.selected = 0;
    g.useBlock({ x: hx, y: hy, z: hz, id: B.beehive, face: 4 }, p.inventory.held);
    const bottle = p.inventory.get(0);
    const angry = g.entities.filter((e) => e.type === 'bee' && e.angry > 0).length;
    // shears give honeycomb
    w.setBlock(hx, hy, hz, B.beehive, 4 | (5 << 3));
    p.inventory.set(0, { id: I.shears, count: 1 });
    const n0 = g.items.length;
    g.useBlock({ x: hx, y: hy, z: hz, id: B.beehive, face: 4 }, p.inventory.held);
    const comb = g.items.slice(n0).some((it) => it.stack.id === I.honeycomb && it.stack.count === 3);
    for (const e of g.entities) if (e.type === 'bee') e.angry = 0;
    return { pollen, home, stored, honey, bottle: bottle && bottle.id === I.honey_bottle, angry, comb };
  });
  assert(r.pollen, 'a bee gathers pollen from flowers');
  assert(r.home && r.stored === 1 && r.honey >= 1, `the bee flies home and the hive fills with honey (${JSON.stringify(r)})`);
  assert(r.bottle, 'a glass bottle collects honey from a full hive');
  assert(r.angry > 0, 'bees turn on whoever takes their honey without smoke');
  assert(r.comb, 'shears cut honeycomb from a full hive');

  // --- alpacas
  await reset();
  r = await page.evaluate(() => {
    const bf = window.__blockforge, g = bf.game, p = g.player, { B, I } = bf, { x0, y0, z0 } = window.__pad;
    const a = new bf.Mob('alpaca', x0 + 2.5, y0, z0 + 0.5, { variant: 'grey' }); g.entities.push(a);
    let tries = 0;
    while (!a.tamed && tries < 60) { tries++; a.interact(g, { id: B.hay_bale, count: 64 }); }
    const chest = a.interact(g, { id: B.chest, count: 1 });
    p.sneaking = true;
    const opened = a.interact(g, null);
    const screen = g.ui.screen && g.ui.screen.name, slots = g.ui.screen && g.ui.screen.data.be.slots.length;
    g.ui.screen && g.ui.screen.data.be && (g.ui.screen.data.be.slots[0] = { id: I.diamond, count: 2 });
    g.ui.closeScreen(true);
    p.sneaking = false;
    // spit at a ghoul that goes for it
    const gh = new bf.Mob('ghoul', x0 + 7.5, y0, z0 + 0.5, { armor: [I.iron_helmet, null, null, null] }); g.entities.push(gh);
    gh.target = a;
    let spits = 0;
    const orig = g.mobThrow; g.mobThrow = function (...args) { if (args[1] === 'spit') spits++; return orig.apply(this, args); };
    for (let i = 0; i < 200; i++) { g.tickEntities(); a.health = a.maxHealth; gh.target = a; }
    g.mobThrow = orig;
    a.hurt(g, 100, undefined, undefined, 'magic');
    for (let i = 0; i < 25; i++) g.tickEntities();
    const spilled = g.items.some((it) => it.stack.id === I.diamond);
    return { tamed: a.tamed, chest, opened, screen, slots, spits, spilled };
  });
  assert(r.tamed && r.chest === 'consume', 'an alpaca is tamed with hay and fitted with a chest');
  assert(r.screen === 'chest' && r.slots === 9, 'its pack opens as a nine-slot chest');
  assert(r.spits > 0, `alpacas spit at hostiles that come for them (${r.spits})`);
  assert(r.spilled, 'the pack spills its contents when the alpaca dies');

  // --- dolphins
  await reset();
  r = await page.evaluate(() => {
    const bf = window.__blockforge, g = bf.game, p = g.player, w = g.world, { B, I } = bf, { x0, y0, z0 } = window.__pad;
    for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) for (let y = -4; y <= 0; y++) w.setBlock(x0 + x, y0 + y - 1, z0 + z, B.water, 0);
    for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) w.setBlock(x0 + x, y0 - 6, z0 + z, B.sand, 0);
    p.y = p.py = y0 - 2;
    const d = new bf.Mob('dolphin', x0 + 2.5, y0 - 3, z0 + 0.5); g.entities.push(d);
    let grace = false;
    for (let i = 0; i < 200 && !grace; i++) { g.tick(); p.y = p.py = y0 - 2; p.vy = 0; if (p.effects.sea_grace) grace = true; }
    // a fish sends it off toward sunken treasure (when one is known)
    const res = d.interact(g, { id: I.raw_silverfin, count: 1 });
    const swims = d.inWater;
    for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) for (let y = -6; y <= 0; y++) w.setBlock(x0 + x, y0 + y - 1, z0 + z, y === 0 ? B.grass : B.dirt, 0);
    return { grace, res, swims };
  });
  assert(r.grace, 'swimming beside a dolphin grants Sea Grace');
  assert(r.res === 'consume', 'dolphins take fish');

  // --- dyes and sheep
  await reset();
  r = await page.evaluate(() => {
    const bf = window.__blockforge, g = bf.game, { B, I } = bf, { x0, y0, z0 } = window.__pad;
    const sh = new bf.Mob('sheep', x0 + 2.5, y0, z0 + 0.5); g.entities.push(sh);
    const dyed = sh.interact(g, { id: I.blue_dye, count: 1 });
    const n0 = g.items.length;
    sh.interact(g, { id: I.shears, count: 1 });
    const wool = g.items.slice(n0).every((it) => it.stack.id === B.blue_wool);
    const { matchRecipe } = bf;
    return { dyed, color: sh.color, wool };
  });
  assert(r.dyed === 'consume' && r.color === 5, 'a dye colours a sheep');
  assert(r.wool, 'a dyed sheep is sheared for coloured wool');

  // --- recipes
  r = await page.evaluate(() => {
    const bf = window.__blockforge, { B, I } = bf, mr = bf.matchRecipe;
    const grid = (rows, keys) => rows.flatMap((row) => row.split('').map((c) => (c === ' ' ? 0 : keys[c])));
    return {
      hive: mr(grid(['PPP', 'HHH', 'PPP'], { P: B.oak_planks, H: I.honeycomb }), 3),
      dye: mr([B.poppy, 0, 0, 0], 2),
      wool: mr([B.white_wool, I.purple_dye, 0, 0], 2),
      orange: mr([I.red_dye, I.yellow_dye, 0, 0], 2),
      crafter: mr(grid(['III', 'ICI', 'DRD'], { I: I.iron_ingot, C: B.crafting_table, D: I.spark_dust, R: B.dropper }), 3),
      ingot: mr([I.starsteel_scrap, I.starsteel_scrap, I.starsteel_scrap, I.starsteel_scrap, I.gold_ingot, I.gold_ingot, I.gold_ingot, I.gold_ingot, 0], 3),
      grind: mr(grid(['SCS', 'P P', '   '], { S: I.stick, C: B.stone_slab, P: B.oak_planks }), 3),
      ids: { beehive: B.beehive, red: I.red_dye, purple_wool: B.purple_wool, orange: I.orange_dye, crafter: B.crafter, ingot: I.starsteel_ingot, grindstone: B.grindstone },
    };
  });
  assert(r.hive && r.hive.id === r.ids.beehive, 'planks and honeycomb make a beehive');
  assert(r.dye && r.dye.id === r.ids.red && r.wool && r.wool.id === r.ids.purple_wool && r.orange && r.orange.id === r.ids.orange, 'flowers make dyes, dyes mix and colour wool');
  assert(r.crafter && r.crafter.id === r.ids.crafter && r.grind && r.grind.id === r.ids.grindstone, 'the crafter and grindstone recipes work');
  assert(r.ingot && r.ingot.id === r.ids.ingot, 'starsteel scrap and gold make a starsteel ingot');

  // --- workstations
  await reset();
  r = await page.evaluate(() => {
    const bf = window.__blockforge, g = bf.game, p = g.player, w = g.world, { B, I } = bf, { x0, y0, z0 } = window.__pad;
    const res = {};
    // composter
    const cx = x0 + 3, cz = z0 - 2;
    w.setBlock(cx, y0, cz, B.composter, 0);
    for (let i = 0; i < 40 && (w.getMeta(cx, y0, cz) & 15) < 7; i++) g.composterAdd(cx, y0, cz, 0.65);
    for (let i = 0; i < 30; i++) { g.tickCount++; g.tickFeatures5(); }
    res.compostReady = w.getMeta(cx, y0, cz) & 15;
    const n0 = g.items.length;
    g.useBlock({ x: cx, y: y0, z: cz, id: B.composter }, null);
    res.boneMeal = g.items.slice(n0).some((it) => it.stack.id === I.bone_meal);
    // lectern
    const lx = x0 - 3, lz = z0 - 2;
    w.setBlock(lx, y0, lz, B.lectern, 2);
    p.inventory.set(0, { id: I.book, count: 1 }); p.inventory.selected = 0;
    g.useBlock({ x: lx, y: y0, z: lz, id: B.lectern }, p.inventory.held);
    res.lecternBook = !!(w.getMeta(lx, y0, lz) & 4) && !p.inventory.get(0);
    p.inventory.set(0, { id: I.stick, count: 1 });
    const m0 = g.measureBlock(lx, y0, lz, B.lectern);
    for (let k = 0; k < 4; k++) g.useBlock({ x: lx, y: y0, z: lz, id: B.lectern }, p.inventory.held);
    res.pages = [m0, g.measureBlock(lx, y0, lz, B.lectern)];
    p.inventory.set(0, null);
    // an empty hand opens the reader; its Take Book button lifts the book off
    g.useBlock({ x: lx, y: y0, z: lz, id: B.lectern }, null);
    const take = document.querySelector('#b-take');
    if (take) take.click();
    res.bookBack = p.inventory.get(0) && p.inventory.get(0).id === I.book;
    // crafter: planks in a 2x2 make a crafting table when powered
    const kx = x0, kz = z0 - 5;
    w.setBlock(kx, y0, kz, B.crafter, 4);
    g.useBlock({ x: kx, y: y0, z: kz, id: B.crafter }, null);
    const be = g.ui.screen.data.be;
    for (const i of [0, 1, 3, 4]) be.slots[i] = { id: B.oak_planks, count: 2 };
    g.ui.refreshSlots();
    res.preview = g.ui.crafterPreview();
    g.ui.closeScreen(true);
    const n1 = g.items.length;
    w.setBlock(kx, y0 + 1, kz, B.lever, 0); g.circuits.toggleLever(kx, y0 + 1, kz);
    for (let i = 0; i < 12; i++) { g.tickCount++; g.circuits.tick(); }
    res.crafted = g.items.slice(n1).filter((it) => it.stack.id === B.crafting_table).length;
    res.left = be.slots[0] && be.slots[0].count;
    return res;
  });
  assert(r.compostReady === 8 && r.boneMeal, `the composter fills, ripens and gives bone meal (${r.compostReady})`);
  assert(r.lecternBook && r.pages[1] > r.pages[0] && r.bookBack, `a lectern holds a book whose page a comparator reads (${JSON.stringify(r.pages)})`);
  assert(r.preview && r.crafted === 1 && r.left === 1, `a powered crafter crafts its pattern once (${JSON.stringify(r)})`);

  r = await page.evaluate(() => {
    const bf = window.__blockforge, g = bf.game, p = g.player, w = g.world, { B, I } = bf, { x0, y0, z0 } = window.__pad;
    const res = {};
    // enchanting a book, then using it at the anvil
    p.xpLevel = 30;
    w.setBlock(x0 + 5, y0, z0, B.enchanting_table, 0);
    g.useBlock({ x: x0 + 5, y: y0, z: z0, id: B.enchanting_table }, null);
    g.enchantSlot.set(0, { id: I.book, count: 1 });
    g.ui.lastEnchantKey = null; g.ui.updateEnchant();
    const opt = document.querySelector('.eopt:not([disabled])');
    if (opt) opt.click();
    const eb = g.enchantSlot.get(0);
    res.book = eb && eb.id === I.enchanted_book && eb.ench && Object.keys(eb.ench).length > 0;
    g.enchantSlot.set(0, null);
    g.ui.closeScreen(true);
    w.setBlock(x0 + 6, y0, z0, B.anvil, 0);
    g.useBlock({ x: x0 + 6, y: y0, z: z0, id: B.anvil }, null);
    g.anvilSlots.set(0, { id: I.iron_sword, count: 1 });
    g.anvilSlots.set(1, { id: I.enchanted_book, count: 1, ench: { sharpness: 3 } });
    const out = g.ui.anvilOut();
    res.anvil = out && out.out.ench && out.out.ench.sharpness === 3;
    g.anvilSlots.set(0, null); g.anvilSlots.set(1, null);
    g.ui.closeScreen(true);
    // grindstone
    w.setBlock(x0 + 7, y0, z0, B.grindstone, 0);
    g.useBlock({ x: x0 + 7, y: y0, z: z0, id: B.grindstone }, null);
    res.gscreen = g.ui.screen && g.ui.screen.name;
    g.grindSlots.set(0, { id: I.iron_sword, count: 1, ench: { sharpness: 2, knockback: 1 } });
    g.ui.refreshSlots();
    const orbs0 = g.orbs.length;
    g.ui.takeGrind();
    res.ground = g.ui.cursor && g.ui.cursor.id === I.iron_sword && !g.ui.cursor.ench;
    res.xp = g.orbs.length > orbs0;
    return res;
  });
  assert(r.book, 'the enchanting table enchants a book');
  assert(r.anvil, 'an enchanted book passes its enchantment on at the anvil');
  assert(r.gscreen === 'grindstone' && r.ground && r.xp, 'the grindstone strips enchantments and pays back experience');
  await shot('51-grindstone');
  r = await page.evaluate(() => {
    const bf = window.__blockforge, g = bf.game, w = g.world, { B, I } = bf, { x0, y0, z0 } = window.__pad;
    g.ui.cursor = null; g.ui.closeScreen(true);
    w.setBlock(x0 + 8, y0, z0, B.smithing_table, 4);
    g.useBlock({ x: x0 + 8, y: y0, z: z0, id: B.smithing_table }, null);
    g.smithSlots.set(0, { id: I.diamond_pickaxe, count: 1, ench: { efficiency: 3 }, dur: 400 });
    g.smithSlots.set(1, { id: I.starsteel_ingot, count: 2 });
    g.ui.refreshSlots();
    g.ui.takeSmith();
    const c = g.ui.cursor;
    const res = { id: c && c.id, want: I.starsteel_pickaxe, ench: c && c.ench && c.ench.efficiency, left: g.smithSlots.get(1) && g.smithSlots.get(1).count };
    g.ui.cursor = null; g.ui.closeScreen(true);
    return res;
  });
  assert(r.id === r.want && r.ench === 3 && r.left === 1, `the smithing table upgrades diamond gear to starsteel, keeping its enchantments (${JSON.stringify(r)})`);

  // --- berry bushes and saplings
  await reset();
  r = await page.evaluate(() => {
    const bf = window.__blockforge, g = bf.game, p = g.player, w = g.world, { B, I } = bf, { x0, y0, z0 } = window.__pad;
    p.inventory.set(0, { id: I.sweet_berries, count: 4 }); p.inventory.selected = 0;
    g.useItemFirst(p.inventory.held, { x: x0 + 2, y: y0 - 1, z: z0, id: B.grass, face: 0 });
    const planted = w.getBlock(x0 + 2, y0, z0) === B.berry_bush;
    for (let i = 0; i < 400 && (w.getMeta(x0 + 2, y0, z0) & 3) < 3; i++) g.randomTick(x0 + 2, y0, z0, B.berry_bush);
    const ripe = w.getMeta(x0 + 2, y0, z0) & 3;
    const n0 = g.items.length;
    g.useBlock({ x: x0 + 2, y: y0, z: z0, id: B.berry_bush }, null);
    const picked = g.items.slice(n0).some((it) => it.stack.id === I.sweet_berries);
    // jungle and blossom saplings grow into trees
    w.setBlock(x0 - 5, y0, z0 - 5, B.blossom_sapling, 0);
    for (let i = 0; i < 200 && w.getBlock(x0 - 5, y0, z0 - 5) === B.blossom_sapling; i++) g.randomTick(x0 - 5, y0, z0 - 5, B.blossom_sapling);
    const blossom = w.getBlock(x0 - 5, y0, z0 - 5) === B.blossom_log;
    w.setBlock(x0 + 6, y0, z0 - 6, B.jungle_sapling, 0);
    for (let i = 0; i < 200 && w.getBlock(x0 + 6, y0, z0 - 6) === B.jungle_sapling; i++) g.randomTick(x0 + 6, y0, z0 - 6, B.jungle_sapling);
    const jungle = w.getBlock(x0 + 6, y0, z0 - 6) === B.jungle_log;
    return { planted, ripe, picked, blossom, jungle };
  });
  assert(r.planted && r.ripe === 3 && r.picked, 'sweet berries are planted, ripen and are picked');
  assert(r.blossom && r.jungle, 'blossom and jungle saplings grow into trees');

  // --- the raid
  await reset();
  r = await page.evaluate(async () => {
    const bf = window.__blockforge, g = bf.game, p = g.player;
    const v = g.world.gen.villages.locate(p.x, p.z, 8);
    if (!v) return { none: true };
    window.__village = v;
    return { x: v.x, z: v.z, h: v.h };
  });
  if (r.none) assert(false, 'a village to defend');
  else {
    await page.evaluate(({ x, z, h }) => { const p = window.__blockforge.game.player; p.x = p.px = x + 0.5; p.z = p.pz = z + 0.5; p.y = p.py = h + 3; p.mode = 'creative'; p.flying = true; }, r);
    await page.waitForFunction(() => { const g = window.__blockforge.game, p = g.player; return g.world.chunkReady(Math.floor(p.x) >> 4, Math.floor(p.z) >> 4); }, null, { timeout: 120000 });
    await page.waitForTimeout(3000);
    r = await page.evaluate(() => {
      const bf = window.__blockforge, g = bf.game, p = g.player;
      p.mode = 'survival'; p.flying = false;
      p.effects.ill_omen = { amp: 0, time: 100000 };
      g.tickCount += 20 - (g.tickCount % 20);
      g.tickRaids();
      const R0 = g.raid;
      if (!R0) return { started: false };
      const res = { started: true, waves: R0.waves, waveCounts: [], cats: g.entities.filter((e) => e.type === 'cat').length };
      for (let guard = 0; guard < 2000 && g.raid && g.raid.state !== 'over'; guard++) {
        g.tickCount += 10;
        g.tickRaids();
        const raiders = g.entities.filter((e) => e.raid && !e.dead);
        if (g.raid && g.raid.state === 'fighting' && raiders.length) {
          res.waveCounts.push(raiders.map((e) => e.type).sort().join(','));
          for (const e of raiders) { e.dead = true; e.removed = true; }
        }
        p.health = 20;
      }
      res.result = g.raid && g.raid.result;
      res.hero = !!p.effects.village_hero;
      res.bar = g.raidBar && g.raidBar();
      return res;
    });
    assert(r.started, `an ill omen brings a raid on the village (${JSON.stringify(r)})`);
    assert(r.result === 'won' && r.hero && r.waveCounts.length === r.waves, `beating every wave wins the raid and the village's thanks (${r.waveCounts.length}/${r.waves})`);
    await page.evaluate(() => { window.__blockforge.game.raid = null; });
  }

  // --- the blossom grove and the new landmarks
  r = await page.evaluate(() => {
    const bf = window.__blockforge, g = bf.game, p = g.player, gen = g.world.gen;
    let grove = null;
    for (let rad = 0; rad < 4000 && !grove; rad += 48) for (let a = 0; a < 32 && !grove; a++) {
      const x = Math.round(p.x + Math.cos(a / 32 * Math.PI * 2) * rad), z = Math.round(p.z + Math.sin(a / 32 * Math.PI * 2) * rad);
      if (gen.biomeAt(x, z) === bf.BIOMES.findIndex((b) => b.name === 'Blossom Grove')) grove = { x, z };
      if (rad === 0) break;
    }
    const loc = (k) => g.runCommand('/locate ' + k);
    return { grove, outpost: loc('outpost'), igloo: loc('igloo'), shipwreck: loc('shipwreck') };
  });
  assert(!!r.grove, `a blossom grove grows somewhere (${JSON.stringify(r.grove)})`);
  assert(/nearest raider outpost/.test(r.outpost), r.outpost);
  assert(/nearest igloo/.test(r.igloo), r.igloo);
  assert(/nearest shipwreck/.test(r.shipwreck), r.shipwreck);
  if (r.grove) {
    await page.evaluate(({ x, z }) => { const p = window.__blockforge.game.player; p.mode = 'spectator'; p.flying = true; p.x = p.px = x + 0.5; p.z = p.pz = z + 0.5; p.y = p.py = window.__blockforge.game.world.gen.heightAt(x, z) + 8; p.pitch = -0.25; }, r.grove);
    await page.waitForFunction(() => { const g = window.__blockforge.game, p = g.player; return g.world.chunkReady(Math.floor(p.x) >> 4, Math.floor(p.z) >> 4); }, null, { timeout: 120000 });
    await page.waitForTimeout(6000);
    r = await page.evaluate(() => {
      const bf = window.__blockforge, g = bf.game, p = g.player, w = g.world, { B } = bf;
      let blossoms = 0, petals = 0;
      for (let x = -24; x <= 24; x++) for (let z = -24; z <= 24; z++) for (let y = -10; y <= 20; y++) {
        const id = w.getBlock(Math.floor(p.x) + x, Math.floor(p.y) + y - 8, Math.floor(p.z) + z);
        if (id === B.blossom_leaves) blossoms++; else if (id === B.petals) petals++;
      }
      return { blossoms, petals };
    });
    assert(r.blossoms > 50 && r.petals > 5, `the grove is full of blossom trees and fallen petals (${JSON.stringify(r)})`);
    await shot('52-blossom-grove');
  }
  // an outpost and its garrison
  r = await page.evaluate(() => {
    const g = window.__blockforge.game, p = g.player;
    const s = g.world.gen.landmarks.locate('outpost', p.x, p.z, 8);
    if (!s) return null;
    p.mode = 'spectator'; p.flying = true;
    p.x = p.px = s.x + 14.5; p.z = p.pz = s.z + 14.5; p.y = p.py = s.y + 14; p.yaw = -Math.PI * 0.25; p.pitch = -0.35;
    return { x: s.x, y: s.y, z: s.z };
  });
  if (r) {
    await page.waitForFunction(() => { const g = window.__blockforge.game, p = g.player; return g.world.chunkReady(Math.floor(p.x - 14) >> 4, Math.floor(p.z - 14) >> 4); }, null, { timeout: 120000 });
    await page.waitForTimeout(6000);
    const o = r;
    r = await page.evaluate(({ x, y, z }) => {
      const bf = window.__blockforge, g = bf.game, w = g.world, { B } = bf;
      let logs = 0;
      for (let dy = 0; dy < 26; dy++) if (w.getBlock(x - 3, y + dy, z - 3) === B.dark_oak_log) logs++;
      const raiders = g.entities.filter((e) => (e.type === 'marauder' || e.type === 'ranger') && Math.hypot(e.x - x, e.z - z) < 30);
      const banner = w.blockEntities.get(`${x},${y + 21},${z}`);
      return { logs, raiders: raiders.length, captain: raiders.some((e) => e.variant === 'captain'), banner: banner && banner.type };
    }, o);
    assert(r.logs >= 20 && r.raiders >= 3 && r.captain, `a raider outpost: a watchtower with its garrison and captain (${JSON.stringify(r)})`);
    await shot('53-outpost');
  } else assert(false, 'an outpost to visit');

  // starsteel in the Underworld (generated directly)
  r = await page.evaluate(() => {
    const bf = window.__blockforge, { B } = bf;
    const g = bf.game;
    const gen = g.underGen || null;
    return { ore: B.starsteel_ore > 0 };
  });
  assert(r.ore, 'starsteel ore exists');

  assert(errors.length === 0, `no page errors (${errors.length})`);
  if (errors.length) console.log(errors.slice(0, 5).join('\n---\n'));
  await browser.close();
})();
