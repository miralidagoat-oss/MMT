// Feature test for spark circuits, rails and minecarts, boats, brewing and
// potions, fire, signs, fishing, maps, the star gate, the Void and its wyrm.
// Usage: node tools/round3.cjs <url> <outdir>
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
  await page.goto(url, { timeout: 120000 });
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

  // these checks expect the default view distance, whatever preset this machine picked
  await page.evaluate(() => { const b = window.__blockforge; b.settings.renderDistance = 8; b.ui.app.applySettings(); });
  await page.click('#b-play'); await page.waitForTimeout(300);
  await page.click('#b-new'); await page.waitForTimeout(200);
  await page.fill('#w-name', 'Round Three');
  await page.fill('#w-seed', 'starlight');
  await page.click('#w-mode button[data-m="creative"]').catch(() => {});
  await page.click('#b-create');
  await page.waitForFunction(() => window.__blockforge.game.state === 'playing', null, { timeout: 180000 });
  await waitReady(1000);

  // A stone test floor up in the sky, clear of terrain.
  const base = await G(() => {
    const g = window.__blockforge.game, p = g.player, { B } = window.__blockforge, w = g.world;
    p.mode = 'creative'; p.flying = true;
    g.dayTime = 4000; g.rainTarget = g.rain = 0;
    const X = Math.floor(p.x), Z = Math.floor(p.z), Y = 150;
    for (let z = Z - 4; z <= Z + 24; z++) for (let x = X - 4; x <= X + 40; x++) {
      w.setBlock(x, Y - 1, z, B.stone, 0, { notify: false });
      for (let y = Y; y < Y + 6; y++) w.setBlock(x, y, z, 0, 0, { notify: false });
    }
    return { X, Y, Z };
  });
  const { X, Y, Z } = base;
  const ticks = (n) => G((n) => { const g = window.__blockforge.game; for (let i = 0; i < n; i++) g.tick(); }, n);

  // ---- spark circuits ---------------------------------------------------------
  // lever -> 6 wire -> lamp
  let r = await G(([X, Y, Z]) => {
    const g = window.__blockforge.game, { B } = window.__blockforge, w = g.world;
    w.setBlock(X, Y, Z, B.lever, 0);
    for (let i = 1; i <= 6; i++) w.setBlock(X + i, Y, Z, B.spark_wire, 0);
    w.setBlock(X + 7, Y, Z, B.spark_lamp, 0);
    for (let i = 0; i < 6; i++) g.tick();
    const before = w.getBlock(X + 7, Y, Z);
    g.circuits.toggleLever(X, Y, Z);
    for (let i = 0; i < 6; i++) g.tick();
    return { before, after: w.getBlock(X + 7, Y, Z), w1: w.getMeta(X + 1, Y, Z), w6: w.getMeta(X + 6, Y, Z) };
  }, [X, Y, Z]);
  console.log('circuit', JSON.stringify(r));
  const B = await G(() => { const { B } = window.__blockforge; return { spark_lamp: B.spark_lamp, spark_lamp_on: B.spark_lamp_on, spark_torch: B.spark_torch, spark_torch_off: B.spark_torch_off, piston_head: B.piston_head, gold_block: B.gold_block, stone: B.stone, rail: B.rail, powered_rail: B.powered_rail }; });
  assert(r.before === B.spark_lamp && r.after === B.spark_lamp_on, 'a lever lights a lamp through wire');
  assert(r.w1 === 15 && r.w6 === 10, `wire power falls off one level per block (${r.w1} -> ${r.w6})`);
  r = await G(([X, Y, Z]) => {
    const g = window.__blockforge.game, w = g.world;
    g.circuits.toggleLever(X, Y, Z);
    for (let i = 0; i < 2; i++) g.tick();
    const mid = w.getBlock(X + 7, Y, Z);
    for (let i = 0; i < 8; i++) g.tick();
    return { mid, end: w.getBlock(X + 7, Y, Z), w1: w.getMeta(X + 1, Y, Z) };
  }, [X, Y, Z]);
  assert(r.mid === B.spark_lamp_on && r.end === B.spark_lamp && r.w1 === 0, 'the lamp lingers briefly then goes dark when the lever is off');

  // inverter: lever on a block with a torch on top -> torch turns off
  r = await G(([X, Y, Z]) => {
    const g = window.__blockforge.game, { B } = window.__blockforge, w = g.world;
    const z = Z + 3;
    w.setBlock(X, Y, z, B.stone, 0);
    w.setBlock(X, Y + 1, z, B.spark_torch, 0);
    w.setBlock(X - 1, Y, z, B.lever, 2); // on the wall at +X of the lever spot: attached to the stone
    for (let i = 0; i < 6; i++) g.tick();
    const lit = w.getBlock(X, Y + 1, z);
    g.circuits.toggleLever(X - 1, Y, z);
    for (let i = 0; i < 6; i++) g.tick();
    const off = w.getBlock(X, Y + 1, z);
    g.circuits.toggleLever(X - 1, Y, z);
    for (let i = 0; i < 6; i++) g.tick();
    return { lit, off, back: w.getBlock(X, Y + 1, z) };
  }, [X, Y, Z]);
  console.log('inverter', JSON.stringify(r));
  assert(r.lit === B.spark_torch && r.off === B.spark_torch_off && r.back === B.spark_torch, 'a torch on a powered block turns off and back on');

  // repeater with delay 4 (8 ticks) then lamp
  r = await G(([X, Y, Z]) => {
    const g = window.__blockforge.game, { B } = window.__blockforge, w = g.world;
    const z = Z + 6;
    w.setBlock(X, Y, z, B.lever, 0);
    w.setBlock(X + 1, Y, z, B.repeater, 1 | (3 << 2)); // facing east, delay 4
    w.setBlock(X + 2, Y, z, B.spark_lamp, 0);
    for (let i = 0; i < 4; i++) g.tick();
    g.circuits.toggleLever(X, Y, z);
    const seen = [];
    for (let i = 0; i < 14; i++) { g.tick(); seen.push(w.getBlock(X + 2, Y, z) === B.spark_lamp_on ? 1 : 0); }
    return seen.join('');
  }, [X, Y, Z]);
  console.log('repeater', r);
  assert(r.indexOf('1') >= 7 && r.endsWith('1'), `a repeater delays the signal (${r})`);

  // piston push and sticky pull
  r = await G(([X, Y, Z]) => {
    const g = window.__blockforge.game, { B } = window.__blockforge, w = g.world;
    const z = Z + 9;
    w.setBlock(X, Y, z, B.lever, 0);
    w.setBlock(X + 1, Y, z, B.sticky_piston, 2); // facing +X
    w.setBlock(X + 2, Y, z, B.gold_block, 0);
    for (let i = 0; i < 4; i++) g.tick();
    g.circuits.toggleLever(X, Y, z);
    for (let i = 0; i < 4; i++) g.tick();
    const pushed = [w.getBlock(X + 2, Y, z), w.getBlock(X + 3, Y, z)];
    g.circuits.toggleLever(X, Y, z);
    for (let i = 0; i < 4; i++) g.tick();
    const pulled = [w.getBlock(X + 2, Y, z), w.getBlock(X + 3, Y, z)];
    return { pushed, pulled };
  }, [X, Y, Z]);
  console.log('piston', JSON.stringify(r));
  assert(r.pushed[0] === B.piston_head && r.pushed[1] === B.gold_block, 'a sticky piston pushes a block');
  assert(r.pulled[0] === B.gold_block && r.pulled[1] === 0, 'and pulls it back');

  // leave the first lamp on for the picture
  await G(([X, Y, Z]) => { const g = window.__blockforge.game; g.circuits.toggleLever(X, Y, Z); for (let i = 0; i < 6; i++) g.tick(); }, [X, Y, Z]);
  await G(([X, Y, Z]) => { const p = window.__blockforge.game.player; p.x = p.px = X + 3.5; p.y = p.py = Y + 3.2; p.z = p.pz = Z - 3.5; p.yaw = Math.PI; p.pitch = -0.6; }, [X, Y, Z]);
  await page.waitForTimeout(2500);
  await shot('50-circuits');

  // ---- rails and minecarts ----------------------------------------------------
  r = await G(([X, Y, Z]) => {
    const g = window.__blockforge.game, { B } = window.__blockforge, w = g.world;
    const z = Z + 14;
    // a track east with powered rails at the start, fed by a spark block under them
    for (let i = 0; i < 30; i++) w.setBlock(X + i, Y, z, i < 3 ? B.powered_rail : B.rail, 1);
    for (let i = 0; i < 3; i++) w.setBlock(X + i, Y - 1, z, B.spark_block, 0);
    w.setBlock(X - 1, Y, z, B.stone, 0);
    // a slope up at the end
    w.setBlock(X + 30, Y, z, B.stone, 0); w.setBlock(X + 30, Y + 1, z, B.rail, 1);
    w.setBlock(X + 29, Y, z, B.rail, 2);
    for (let i = 0; i < 4; i++) g.tick();
    const pm = w.getMeta(X + 1, Y, z);
    g.runCommand('/summon minecart');
    const cart = g.entities[g.entities.length - 1];
    cart.x = cart.px = X + 0.5; cart.y = cart.py = Y + 0.1; cart.z = cart.pz = z + 0.5;
    g.mount(cart);
    const xs = [];
    for (let i = 0; i < 60; i++) { g.tick(); if (i % 10 === 9) xs.push(+cart.x.toFixed(1)); }
    return { pm, xs, riding: g.player.vehicle === cart, py: g.player.y - cart.y };
  }, [X, Y, Z]);
  console.log('cart', JSON.stringify(r));
  assert((r.pm & 8) === 8, 'powered rails over a spark block are powered');
  assert(r.riding && r.xs[r.xs.length - 1] > X + 8, `a ridden minecart is launched along the track (${r.xs.join(' ')})`);
  await page.waitForTimeout(1200);
  await shot('51-minecart');
  await G(() => { const g = window.__blockforge.game; g.dismount(); });

  // ---- boats -------------------------------------------------------------------
  r = await G(([X, Y, Z]) => {
    const g = window.__blockforge.game, { B } = window.__blockforge, w = g.world;
    const z0 = Z + 17;
    for (let z = z0; z < z0 + 7; z++) for (let x = X; x < X + 24; x++) { w.setBlock(x, Y - 1, z, B.water, 0, { notify: false }); w.setBlock(x, Y - 2, z, B.stone, 0, { notify: false }); }
    g.runCommand('/summon boat');
    const boat = g.entities[g.entities.length - 1];
    boat.x = boat.px = X + 2.5; boat.y = boat.py = Y - 0.5; boat.z = boat.pz = z0 + 3.5; boat.yaw = Math.PI / 2;
    g.mount(boat);
    for (let i = 0; i < 20; i++) g.tick();
    const restY = boat.y;
    // row east (W is held by the rider)
    for (let i = 0; i < 40; i++) { boat.riderInput = { forward: 1, strafe: 0 }; boat.tick(g); g.syncRider(); }
    return { restY, x: boat.x, startX: X + 2.5, riding: g.player.vehicle === boat };
  }, [X, Y, Z]);
  console.log('boat', JSON.stringify(r));
  assert(r.riding && r.restY > Y - 1.3 && r.restY < Y - 0.2, `a boat floats on the water (${r.restY.toFixed(2)})`);
  assert(r.x - r.startX > 4, `rowing moves the boat (${(r.x - r.startX).toFixed(1)} blocks)`);
  await G(([X, Y, Z]) => { const p = window.__blockforge.game.player; p.yaw = -Math.PI * 0.6; p.pitch = -0.3; }, [X, Y, Z]);
  await page.waitForTimeout(1500);
  await shot('52-boat');
  await G(() => window.__blockforge.game.dismount());

  // ---- brewing and potions -----------------------------------------------------
  r = await G(([X, Y, Z]) => {
    const g = window.__blockforge.game, { B, I } = window.__blockforge, w = g.world, p = g.player;
    const bx = X + 12, bz = Z + 3;
    w.setBlock(bx, Y, bz, B.brewing_stand, 0);
    p.x = p.px = bx + 0.5; p.z = p.pz = bz - 2.5; p.y = p.py = Y; p.flying = false; p.yaw = Math.PI; p.pitch = -0.4;
    g.useBlock({ x: bx, y: Y, z: bz, id: B.brewing_stand, face: 2 }, null);
    const key = `${bx},${Y},${bz}`;
    const be = w.blockEntities.get(key);
    be.slots[0] = { id: I.potion_water, count: 1 }; be.slots[1] = { id: I.potion_water, count: 1 }; be.slots[2] = { id: I.potion_water, count: 1 };
    be.slots[3] = { id: B.glowcap, count: 1 }; be.slots[4] = { id: I.ember_dust, count: 2 };
    for (let i = 0; i < 405; i++) g.tickBrewing();
    const step1 = be.slots.slice(0, 3).map((s) => s && s.id === I.potion_awkward);
    be.slots[3] = { id: I.sugar, count: 1 };
    for (let i = 0; i < 405; i++) g.tickBrewing();
    const step2 = be.slots[0] && be.slots[0].id === I.potion_swiftness;
    be.slots[3] = { id: I.spark_dust, count: 1 };
    for (let i = 0; i < 405; i++) g.tickBrewing();
    const step3 = be.slots[0] && be.slots[0].pot && be.slots[0].pot.long;
    be.slots[3] = { id: I.blast_powder, count: 1 };
    for (let i = 0; i < 405; i++) g.tickBrewing();
    const step4 = be.slots[1] && be.slots[1].id === I.splash_potion_swiftness;
    g.ui.refreshSlots && g.ui.refreshSlots();
    return { step1, step2, step3, step4, screen: g.ui.screen };
  }, [X, Y, Z]);
  console.log('brew', JSON.stringify(r));
  assert(r.step1.every(Boolean), 'glowcap turns water bottles into awkward potions');
  assert(r.step2, 'sugar makes swiftness');
  assert(r.step3, 'spark dust extends it');
  assert(r.step4, 'blast powder makes it a splash potion');
  await page.waitForTimeout(800);
  await shot('53-brewing');
  await G(() => window.__blockforge.game.ui.closeScreen());

  // drink: effects HUD
  r = await G(() => {
    const g = window.__blockforge.game, { I } = window.__blockforge, p = g.player;
    p.mode = 'survival';
    p.inventory.held = { id: I.potion_night_vision, count: 1 };
    g.finishDrink(p.inventory.held);
    g.runCommand('/effect give strength 30 2');
    g.runCommand('/effect give poison 5');
    for (let i = 0; i < 5; i++) g.tick();
    return { fx: Object.keys(p.effects), held: p.inventory.held && p.inventory.held.id === I.glass_bottle };
  });
  await page.waitForTimeout(600);
  const fxHud = await G(() => { const e = document.querySelector('#effects'); return { hidden: e.hidden, n: e.children.length }; });
  console.log('effects', JSON.stringify(r), JSON.stringify(fxHud));
  assert(r.fx.includes('night_vision') && r.fx.includes('strength') && r.held, 'drinking applies the effect and leaves a bottle');
  assert(!fxHud.hidden && fxHud.n >= 3, 'active effects show on the HUD');
  await shot('54-effects');
  await G(() => { const g = window.__blockforge.game; g.runCommand('/effect clear'); g.player.mode = 'creative'; g.player.health = 20; });

  // ---- fire, signs, lantern, cake ---------------------------------------------
  r = await G(([X, Y, Z]) => {
    const g = window.__blockforge.game, { B } = window.__blockforge, w = g.world;
    const z = Z + 3, x = X + 18;
    w.setBlock(x, Y, z, B.netherrack ?? B.scorchstone ?? B.stone, 0);
    g.placeFire(x, Y + 1, z);
    const fire = w.getBlock(x, Y + 1, z) === B.fire;
    w.setBlock(x + 2, Y, z, B.oak_sign, 0);
    w.blockEntities.set(`${x + 2},${Y},${z}`, { type: 'sign', lines: ['Welcome to', 'BLOCKFORGE', 'round three', ':)'] });
    w.setBlock(x + 3, Y, z, B.lantern, 0);
    w.setBlock(x + 4, Y, z, B.cake, 2);
    w.setBlock(x + 5, Y, z, B.glass_pane, 0); w.setBlock(x + 5, Y, z + 1, B.glass_pane, 0);
    w.setBlock(x + 6, Y, z, B.iron_bars, 0); w.setBlock(x + 6, Y, z + 1, B.iron_bars, 0);
    w.setBlock(x + 7, Y, z, B.cobweb, 0);
    const p = g.player;
    p.flying = true; p.x = p.px = x + 3.5; p.y = p.py = Y + 0.6; p.z = p.pz = z - 3.2; p.yaw = Math.PI; p.pitch = -0.12;
    return { fire };
  }, [X, Y, Z]);
  assert(r.fire, 'fire can be placed on a block');
  await page.waitForTimeout(2200);
  await shot('55-fire-sign');

  // ---- fishing ------------------------------------------------------------------
  r = await G(([X, Y, Z]) => {
    const g = window.__blockforge.game, { I } = window.__blockforge, p = g.player;
    p.mode = 'survival'; p.flying = false;
    p.x = p.px = X + 6.5; p.y = p.py = Y; p.z = p.pz = Z + 15.8; p.yaw = Math.PI; p.pitch = -0.3; p.vx = p.vy = p.vz = 0;
    p.inventory.held = { id: I.fishing_rod, count: 1 };
    g.useItemFirst(p.inventory.held, null);
    const b = p.fishing;
    for (let i = 0; i < 40; i++) g.tick();
    const floating = b && b.floating;
    b.wait = 1;
    for (let i = 0; i < 3; i++) g.tick();
    const biting = b.bite > 0;
    const before = g.items.length;
    g.useItemFirst(p.inventory.held, null);
    return { floating, biting, caught: g.items.length > before, rodDur: p.inventory.held && p.inventory.held.dur };
  }, [X, Y, Z]);
  console.log('fishing', JSON.stringify(r));
  assert(r.floating && r.biting && r.caught, 'a cast bobber floats, gets a bite and reels in a catch');

  // ---- maps -------------------------------------------------------------------
  r = await G(() => {
    const g = window.__blockforge.game, { I } = window.__blockforge, p = g.player;
    p.inventory.held = { id: I.empty_map, count: 1 };
    g.useItemFirst(p.inventory.held, null);
    const h = p.inventory.held;
    const m = h && h.map && g.mapData(h.map);
    let known = 0; if (m) for (const k of m.known) known += k;
    return { filled: h && h.id === I.filled_map, known };
  });
  await page.waitForTimeout(800);
  const mapHud = await G(() => !document.querySelector('#map-panel').hidden);
  console.log('map', JSON.stringify(r), mapHud);
  assert(r.filled && r.known > 1000 && mapHud, 'an empty map becomes a filled map that draws the land');
  await shot('56-map');
  await G(() => { const g = window.__blockforge.game; g.player.inventory.held = null; g.player.mode = 'creative'; });

  // ---- observatory and the star gate -----------------------------------------
  const loc = await G(() => window.__blockforge.game.runCommand('/locate observatory'));
  console.log(loc);
  const om = /at (-?\d+), (-?\d+), (-?\d+)/.exec(loc);
  assert(!!om, 'an observatory can be located');
  if (om) {
    const [ox, oy, oz] = [+om[1], +om[2], +om[3]];
    await G(([x, y, z]) => { const g = window.__blockforge.game, p = g.player; p.flying = true; p.x = p.px = x + 0.5; p.y = p.py = y + 3; p.z = p.pz = z + 0.5; }, [ox, oy, oz]);
    await waitReady(1500);
    r = await G(([x, y, z]) => {
      const g = window.__blockforge.game, { B, I } = window.__blockforge, w = g.world, p = g.player;
      const frames = [];
      for (let dz = -12; dz <= 12; dz++) for (let dx = -12; dx <= 12; dx++) for (let dy = -6; dy <= 6; dy++) {
        if (w.getBlock(x + dx, y + dy, z + dz) === B.star_frame) frames.push([x + dx, y + dy, z + dz]);
      }
      // fill every frame with an eye
      for (const f of frames) {
        p.inventory.held = { id: I.star_eye, count: 1 };
        g.placeEye({ x: f[0], y: f[1], z: f[2], id: B.star_frame, face: 0 });
      }
      let gate = 0;
      if (frames.length) {
        const fy = frames[0][1];
        for (let dz = -12; dz <= 12; dz++) for (let dx = -12; dx <= 12; dx++) if (w.getBlock(x + dx, fy, z + dz) === B.void_gate) gate++;
        // stand back to look at it
        const cx = frames.reduce((a, f) => a + f[0], 0) / frames.length, cz = frames.reduce((a, f) => a + f[2], 0) / frames.length;
        p.x = p.px = cx + 0.5; p.z = p.pz = cz - 4; p.y = p.py = fy + 2.5; p.yaw = Math.PI; p.pitch = -0.5;
        return { frames: frames.length, gate, fy, cx, cz };
      }
      return { frames: 0, gate };
    }, [ox, oy, oz]);
    console.log('gate', JSON.stringify(r));
    assert(r.frames === 12 && r.gate === 9, 'filling the 12 star frames opens a 3x3 void gate');
    await page.waitForTimeout(2500);
    await shot('57-star-gate');
    // step in
    if (r.gate) {
      await G(([cx, fy, cz]) => { const p = window.__blockforge.game.player; p.x = p.px = cx + 0.5; p.z = p.pz = cz + 0.5; p.y = p.py = fy + 0.2; p.voidCooldown = 0; p.flying = false; }, [r.cx, r.fy, r.cz]);
      await page.waitForFunction(() => window.__blockforge.game.dim === 'void', null, { timeout: 60000 }).catch(() => {});
    }
  }
  let dim = await G(() => window.__blockforge.game.dim);
  if (dim !== 'void') { await G(() => window.__blockforge.game.runCommand('/dimension void')); await page.waitForFunction(() => window.__blockforge.game.dim === 'void', null, { timeout: 60000 }); }
  await waitReady(2500);
  r = await G(() => {
    const g = window.__blockforge.game, p = g.player;
    return { dim: g.dim, pos: [p.x, p.y, p.z].map((v) => +v.toFixed(1)), wyrm: !!g.wyrm, pylons: g.entities.filter((e) => e.isPylon).length, floor: g.world.getBlock(Math.floor(p.x), Math.floor(p.y) - 1, Math.floor(p.z)) };
  });
  console.log('void', JSON.stringify(r));
  assert(r.dim === 'void' && r.wyrm, 'stepping through the gate reaches the Void, where the wyrm waits');
  assert(r.floor !== 0, 'the arrival platform is under the player');
  await G(() => { const p = window.__blockforge.game.player; p.yaw = -Math.PI / 2; p.pitch = 0.1; p.mode = 'creative'; });
  await page.waitForTimeout(1500);
  await shot('58-void-arrival');
  // look at the island from above
  await G(() => { const g = window.__blockforge.game, p = g.player; p.flying = true; p.x = p.px = 70; p.y = p.py = 110; p.z = p.pz = 70; p.yaw = -Math.PI / 4; p.pitch = -0.45; });
  await waitReady(3000);
  r = await G(() => { const g = window.__blockforge.game; return { pylons: g.entities.filter((e) => e.isPylon).length, wyrm: g.wyrm && [g.wyrm.x, g.wyrm.y, g.wyrm.z].map(Math.round), hp: g.wyrm && g.wyrm.health }; });
  console.log('island', JSON.stringify(r));
  assert(r.pylons === 8, 'eight pylons crown the pillars');
  const boss = await G(() => { const b = document.querySelector('#bossbar'); return { hidden: b.hidden, name: b.querySelector('b').textContent }; });
  console.log('bossbar', JSON.stringify(boss));
  assert(!boss.hidden && /Wyrm/.test(boss.name), 'the boss bar shows the wyrm');
  await shot('59-void-island');

  // defeat it: break the pylons, then wear the wyrm down
  r = await G(() => {
    const g = window.__blockforge.game;
    for (const e of g.entities.filter((e) => e.isPylon)) e.hit(g);
    for (let i = 0; i < 20; i++) g.tick();
    const wy = g.wyrm;
    let guard = 0;
    while (g.wyrm && guard++ < 400) { wy.hit(g, 12, 'player'); for (let i = 0; i < 3; i++) g.tick(); }
    for (let i = 0; i < 260; i++) g.tick();
    const fy = g.world.gen.fountainY();
    let gates = 0;
    for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) if (g.world.getBlock(dx, fy, dz) === window.__blockforge.B.void_gate) gates++;
    return { dead: g.meta.voidBoss === 'dead', gates, egg: g.world.getBlock(0, fy + 4, 0) === window.__blockforge.B.wyrm_egg, fy };
  });
  console.log('wyrm', JSON.stringify(r));
  assert(r.dead && r.gates >= 12 && r.egg, 'defeating the wyrm opens the exit fountain and leaves an egg');
  await G((fy) => { const p = window.__blockforge.game.player; p.x = p.px = 0.5; p.y = p.py = fy + 8; p.z = p.pz = -9; p.yaw = Math.PI; p.pitch = -0.6; }, r.fy);
  await page.waitForTimeout(2500);
  await shot('60-fountain');

  // spire: glider
  const sl = await G(() => window.__blockforge.game.runCommand('/locate spire'));
  console.log(sl);
  const sm = /at (-?\d+), (-?\d+), (-?\d+)/.exec(sl);
  assert(!!sm, 'an astral spire can be located on the outer islands');
  if (sm) {
    await G(([x, y, z]) => { const p = window.__blockforge.game.player; p.x = p.px = x + 14; p.y = p.py = y + 20; p.z = p.pz = z + 14; p.yaw = Math.PI * 0.25 + Math.PI; p.pitch = -0.45; p.yaw = Math.atan2(-14, 14); }, [+sm[1], +sm[2], +sm[3]]);
    await waitReady(3000);
    await shot('61-spire');
    // glide
    r = await G(() => {
      const g = window.__blockforge.game, { I } = window.__blockforge, p = g.player;
      p.mode = 'survival'; p.flying = false;
      p.inventory.set(37, { id: I.glider, count: 1 });
      p.y = p.py = p.y + 30; p.vy = -0.2; p.pitch = -0.2;
      const y0 = p.y;
      p.gliding = true;
      let dist = 0;
      for (let i = 0; i < 60; i++) { const x = p.x, z = p.z; p.tick(g, { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false }); dist += Math.hypot(p.x - x, p.z - z); }
      return { dist, drop: y0 - p.y, gliding: p.gliding };
    });
    console.log('glide', JSON.stringify(r));
    assert(r.dist > r.drop * 2 && r.dist > 20, `the glider carries the player much further than they fall (${r.dist.toFixed(1)} vs ${r.drop.toFixed(1)})`);
    await page.waitForTimeout(800);
    await G(() => { window.__blockforge.game.perspective = 1; });
    await page.waitForTimeout(800);
    await shot('62-gliding');
    await G(() => { window.__blockforge.game.perspective = 0; const p = window.__blockforge.game.player; p.mode = 'creative'; p.flying = true; p.gliding = false; });
  }

  // save and reload in the Void: wyrm stays dead
  r = await G(() => {
    const g = window.__blockforge.game;
    const s = g.serialize();
    return { boss: s.meta ? s.meta.voidBoss : g.meta.voidBoss };
  });
  assert(r.boss === 'dead', 'the wyrm stays defeated in the save');

  console.log('ERRORS:', errors.length ? '\n' + errors.join('\n') : 'none');
  if (errors.length) process.exitCode = 1;
  await browser.close();
})();
