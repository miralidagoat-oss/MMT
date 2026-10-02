// Feature test for round seven: copper that weathers (waxing, scraping),
// lightning rods, the Deep Dark (sculk sensors, shriekers, catalysts,
// darkness, the Listener, ancient cities) and camels.
// Usage: node tools/round7.cjs <url> <outdir>
const { chromium } = require('playwright');
const url = process.argv[2];
const out = process.argv[3] || '.';
const assert = (c, m) => { if (!c) { console.log('FAIL:', m); process.exitCode = 1; } else console.log('ok:', m); };
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await (await browser.newContext({ viewport: { width: 960, height: 540 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message + '\n' + e.stack));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('ERR_CERT')) errors.push(m.text()); else if (m.text().startsWith('no hit')) console.log(m.text()); });
  await page.goto(url, { timeout: 120000 });
  await page.waitForFunction(() => document.querySelector('#b-play'), null, { timeout: 60000 });
  await page.evaluate(() => { const b = window.__blockforge; b.quality.applyPreset(b.settings, 'balanced'); b.settings.renderDistance = 4; b.ui.app.applySettings(); });
  await page.click('#b-play'); await page.waitForTimeout(200);
  await page.click('#b-new'); await page.waitForTimeout(200);
  await page.fill('#w-seed', 'round seven');
  await page.click('#b-create');
  await page.waitForFunction(() => window.__blockforge.game.state === 'playing', null, { timeout: 180000 });
  await page.waitForTimeout(4000);
  const shot = (n) => page.screenshot({ path: `${out}/${n}.png` });

  await page.evaluate(() => {
    const g = window.__blockforge.game, p = g.player, w = g.world;
    g.dayTime = 6000; g.settings.daylightCycle = false; g.rain = 0; g.rainTarget = 0; p.mode = 'survival';
    const x0 = Math.floor(p.x), z0 = Math.floor(p.z), y0 = w.surfaceY(x0, z0);
    window.__pad = { x0, y0, z0 };
  });
  const reset = () => page.evaluate(() => {
    const g = window.__blockforge.game, p = g.player, w = g.world, { B } = window.__blockforge, { x0, y0, z0 } = window.__pad;
    for (let x = -16; x <= 16; x++) for (let z = -16; z <= 16; z++) { w.setBlock(x0 + x, y0 - 1, z0 + z, B.grass, 0); for (let y = 0; y < 40; y++) w.setBlock(x0 + x, y0 + y, z0 + z, 0, 0); }
    for (const k of [...w.blockEntities.keys()]) { const [x, , z] = k.split(',').map(Number); if (Math.abs(x - x0) <= 16 && Math.abs(z - z0) <= 16) w.blockEntities.delete(k); }
    g.sculks = null;
    p.x = p.px = x0 + 0.5; p.z = p.pz = z0 + 0.5; p.y = p.py = y0; p.vx = p.vy = p.vz = 0; p.health = 20; p.effects = {}; p.sneaking = false; p.warning = 0;
    if (p.vehicle) g.dismount();
    g.entities = g.entities.filter((e) => !e.isMob); g.items = [];
    if (g.ui.screen) g.ui.closeScreen(true);
  });
  let r;

  // --- copper weathers, honeycomb waxes it, an axe scrapes it
  await reset();
  r = await page.evaluate(() => {
    const bf = window.__blockforge, g = bf.game, p = g.player, w = g.world, { B, I } = bf, { x0, y0, z0 } = window.__pad;
    w.setBlock(x0 + 2, y0, z0, B.copper_block, 0); w.setBlock(x0 + 3, y0, z0, B.copper_block, 0);
    p.inventory.set(0, { id: I.honeycomb, count: 2 }); p.inventory.selected = 0;
    const waxed = g.useItem7(p.inventory.held, { x: x0 + 3, y: y0, z: z0, id: B.copper_block });
    for (let i = 0; i < 400; i++) { g.randomTick(x0 + 2, y0, z0, w.getBlock(x0 + 2, y0, z0)); g.randomTick(x0 + 3, y0, z0, w.getBlock(x0 + 3, y0, z0)); }
    const aged = w.getBlock(x0 + 2, y0, z0), kept = w.getBlock(x0 + 3, y0, z0);
    p.inventory.set(0, { id: I.iron_axe, count: 1 });
    g.useItem7(p.inventory.held, { x: x0 + 2, y: y0, z: z0, id: aged });
    const scraped = w.getBlock(x0 + 2, y0, z0);
    return { waxed, aged: aged === B.oxidized_copper, kept: kept === B.copper_block, scraped: scraped === B.weathered_copper, honey: p.inventory.get(0) && p.inventory.get(0).id };
  });
  assert(r.aged, 'copper weathers stage by stage to oxidized');
  assert(r.waxed && r.kept, 'honeycomb wax stops it ageing');
  assert(r.scraped, 'an axe scrapes a stage of patina off');

  // --- lightning rods
  await reset();
  r = await page.evaluate(() => {
    const bf = window.__blockforge, g = bf.game, w = g.world, { B } = bf, { x0, y0, z0 } = window.__pad;
    w.setBlock(x0 + 6, y0, z0, B.oxidized_copper, 0);
    w.setBlock(x0 + 6, y0 + 1, z0, B.lightning_rod, 0);
    g.strike(x0 + 12.5, y0, z0 + 9.5);
    const bolt = g.entities.find((e) => !e.isMob && e.seed !== undefined && e.life !== undefined);
    const pulse = w.getMeta(x0 + 6, y0 + 1, z0) >> 4;
    let fire = 0;
    for (let x = -16; x <= 16; x++) for (let z = -16; z <= 16; z++) for (let y = 0; y < 4; y++) if (w.getBlock(x0 + x, y0 + y, z0 + z) === B.fire) fire++;
    return { at: bolt ? [Math.floor(bolt.x), Math.floor(bolt.z)] : null, want: [x0 + 6, z0], pulse, fire, cleaned: w.getBlock(x0 + 6, y0, z0) === B.copper_block };
  });
  assert(r.at && r.at[0] === r.want[0] && r.at[1] === r.want[1], `lightning nearby strikes the rod instead (${JSON.stringify(r)})`);
  assert(r.pulse > 0 && r.fire === 0, 'the rod sends a spark pulse and nothing catches fire');
  assert(r.cleaned, 'the strike scours the patina off the copper beneath');

  // --- sculk sensors hear footsteps, not sneaking
  await reset();
  r = await page.evaluate(() => {
    const bf = window.__blockforge, g = bf.game, p = g.player, w = g.world, { B } = bf, { x0, y0, z0 } = window.__pad;
    w.setBlock(x0 + 4, y0, z0, B.sculk_sensor, 0);
    w.setBlock(x0 + 5, y0, z0, B.spark_lamp, 0);
    // clearing the arena queued a mountain of circuit updates: let them run first
    for (let i = 0; i < 400 && g.circuits.queue.length; i++) g.circuits.tick();
    g.tickCount += 100;
    p.sneaking = true; g.vibrate(p.x, p.y, p.z, p, 'step');
    const quiet = w.getMeta(x0 + 4, y0, z0) >> 4;
    p.sneaking = false; g.vibrate(p.x, p.y, p.z, p, 'step');
    const heard = w.getMeta(x0 + 4, y0, z0) >> 4;
    for (let i = 0; i < 4; i++) { g.tickCount++; g.circuits.tick(); }
    const lamp = w.getBlock(x0 + 5, y0, z0) === B.spark_lamp_on;
    for (let i = 0; i < 40; i++) { g.tickCount++; g.circuits.tick(); }
    const after = w.getMeta(x0 + 4, y0, z0) >> 4;
    return { quiet, heard, lamp, after };
  });
  assert(r.quiet === 0, 'a sneaking player makes no vibration');
  assert(r.heard >= 10, `a footstep nearby sets the sensor off (${r.heard})`);
  assert(r.lamp, 'its spark pulse lights a lamp beside it');
  assert(r.after === 0, 'and the pulse dies away');

  // --- the shrieker, darkness and the Listener
  await reset();
  r = await page.evaluate(() => {
    const bf = window.__blockforge, g = bf.game, p = g.player, w = g.world, { B } = bf, { x0, y0, z0 } = window.__pad;
    w.setBlock(x0 + 3, y0, z0 + 3, B.sculk_shrieker, 0);
    for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) w.setBlock(x0 + x, y0 - 1, z0 + z, B.sculk, 0);
    const marks = [];
    for (let k = 0; k < 4; k++) { g.tickCount += 400; g.vibrate(p.x, p.y, p.z, p, 'step'); marks.push(p.warning || 0); }
    const listener = g.entities.find((e) => e.type === 'listener');
    const dark = !!(p.effects && p.effects.darkness);
    return { marks, listener: !!listener, dark, emerging: listener && listener.emerging };
  });
  assert(r.dark, 'a shriek brings darkness');
  assert(r.listener, `the fourth warning summons the Listener (${JSON.stringify(r.marks)})`);
  // let it rise, then make noise: it comes for the sound
  r = await page.evaluate(async () => {
    const bf = window.__blockforge, g = bf.game, p = g.player, { x0, y0, z0 } = window.__pad;
    const L = g.entities.find((e) => e.type === 'listener');
    L.emerging = 1;
    for (let i = 0; i < 4; i++) g.tickEntities();
    L.anger = new Map(); L.heard = null;
    g.listenerHears(x0 - 6.5, y0, z0 - 6.5, null);
    const start = [L.x, L.z];
    for (let i = 0; i < 80; i++) g.tickEntities();
    const moved = Math.hypot(L.x - (x0 - 6.5), L.z - (z0 - 6.5)) < Math.hypot(start[0] - (x0 - 6.5), start[1] - (z0 - 6.5)) - 1;
    // anger: repeated noise from the player turns it on them
    L.anger.set(p, 60);
    p.x = p.px = L.x + 1.6; p.z = p.pz = L.z; p.y = p.py = L.y;
    p.health = 20; p.invuln = 0; L.attackCooldown = 0;
    const h0 = p.health, why = { dead: p.dead, mode: p.mode, d: Math.hypot(p.x - L.x, p.y - L.y, p.z - L.z) };
    for (let i = 0; i < 80 && p.health === h0; i++) { L.anger.set(p, Math.max(60, L.anger.get(p) || 0)); g.tickEntities(); }
    const hit = h0 - p.health;
    if (!hit) console.log('no hit', JSON.stringify({ ...why, after: Math.hypot(p.x - L.x, p.y - L.y, p.z - L.z), em: L.emerging, dig: L.digging, cd: L.attackCooldown }));
    // send it back underground before it finishes the job
    g.entities = g.entities.filter((e) => e !== L);
    p.health = 20;
    return { moved, hit, health: L.health };
  });
  assert(r.moved, 'the Listener walks towards a vibration it hears');
  assert(r.hit >= 6, `up close it hits very hard (${r.hit})`);
  await shot('70-listener');
  r = await page.evaluate(() => {
    const g = window.__blockforge.game, p = g.player, env = g.env;
    p.effects = {}; p.health = 20;
    const before = env.fogEnd;
    p.effects.darkness = { amp: 0, time: 200 };
    for (let i = 0; i < 60; i++) g.darknessLevel(p);
    return { level: g.darknessLevel(p) };
  });
  assert(r.level > 0.4, `darkness thickens the fog (${r.level.toFixed(2)})`);
  await page.waitForTimeout(800);
  await shot('71-darkness');

  // --- catalysts spread sculk where things die
  await reset();
  r = await page.evaluate(() => {
    const bf = window.__blockforge, g = bf.game, w = g.world, { B } = bf, { x0, y0, z0 } = window.__pad;
    for (let x = -8; x <= 8; x++) for (let z = -8; z <= 8; z++) w.setBlock(x0 + x, y0 - 1, z0 + z, B.stone, 0);
    w.setBlock(x0, y0 - 1, z0 - 6, B.sculk_catalyst, 0);
    const zom = new bf.Mob('ghoul', x0 + 2.5, y0, z0 + 0.5); g.entities.push(zom);
    zom.hurt(g, 999, x0, z0, 'test');
    for (let i = 0; i < 30; i++) g.tickEntities();
    let sculk = 0;
    for (let x = -8; x <= 8; x++) for (let z = -8; z <= 8; z++) if (w.getBlock(x0 + x, y0 - 1, z0 + z) === B.sculk) sculk++;
    return { sculk };
  });
  assert(r.sculk >= 4, `a catalyst spreads sculk around a death (${r.sculk})`);

  // --- recipes and drops
  r = await page.evaluate(() => {
    const bf = window.__blockforge, { B, I, matchRecipe } = bf;
    const g3 = (rows) => rows.flat().map((n) => n || 0);
    const rod = matchRecipe(g3([[null, I.copper_ingot, null], [null, I.copper_ingot, null], [null, I.copper_ingot, null]]), 3);
    const bricks = matchRecipe(g3([[B.deep_stone, B.deep_stone, null], [B.deep_stone, B.deep_stone, null], [null, null, null]]), 3);
    return { rod: rod && rod.id === B.lightning_rod, bricks: bricks && bricks.id === B.deep_bricks };
  });
  assert(r.rod, 'three copper ingots make a lightning rod');
  assert(r.bricks, 'gloomstone makes gloomstone bricks');

  // --- ancient cities
  r = await page.evaluate(() => window.__blockforge.game.runCommand('/locate ancient_city'));
  console.log(r);
  assert(/ancient city is at/i.test(r), 'an ancient city can be located');
  const city = await page.evaluate(() => { const m = /at (-?\d+), (-?\d+), (-?\d+)/.exec(window.__blockforge.game.runCommand('/locate ancient_city')); return m ? [+m[1], +m[2], +m[3]] : null; });
  if (city) {
    await page.evaluate(([x, y, z]) => { const g = window.__blockforge.game, p = g.player; p.mode = 'creative'; p.flying = true; p.x = p.px = x + 0.5; p.y = p.py = y + 3; p.z = p.pz = z + 0.5; }, city);
    await page.waitForFunction(() => { const g = window.__blockforge.game, p = g.player; return g.world.loadProgress(p.x, p.z, 2) >= 1; }, null, { timeout: 180000 });
    await page.waitForTimeout(3000);
    r = await page.evaluate(([x, y, z]) => {
      const bf = window.__blockforge, g = bf.game, w = g.world, { B } = bf;
      const count = {};
      for (let dx = -30; dx <= 30; dx++) for (let dz = -30; dz <= 30; dz++) for (let dy = -6; dy <= 14; dy++) {
        const id = w.getBlock(x + dx, y + dy, z + dz);
        if ([B.sculk, B.sculk_sensor, B.sculk_shrieker, B.sculk_catalyst, B.deep_bricks, B.wisp_lantern, B.chest].includes(id)) count[id] = (count[id] || 0) + 1;
      }
      let chests = 0, sensorsHeard = 0;
      for (const [k, be] of w.blockEntities) { const [bx, , bz] = k.split(',').map(Number); if (Math.abs(bx - x) < 40 && Math.abs(bz - z) < 40) { if (be.type === 'chest') chests++; if (be.type === 'sculk') sensorsHeard++; } }
      return { sculk: count[B.sculk] || 0, sensors: count[B.sculk_sensor] || 0, shriekers: count[B.sculk_shrieker] || 0, bricks: count[B.deep_bricks] || 0, lanterns: count[B.wisp_lantern] || 0, chests, sculkEntities: sensorsHeard };
    }, city);
    console.log('city', JSON.stringify(r));
    assert(r.bricks > 100 && r.lanterns > 2, 'the city is built of gloomstone bricks lit by wisp lanterns');
    assert(r.sculk > 50 && r.sensors > 1 && r.shriekers > 0, 'sculk, sensors and shriekers cover it');
    assert(r.chests > 0 && r.sculkEntities > 1, 'it has loot chests, and its sensors are listening');
    await page.evaluate(([x, y, z]) => { const p = window.__blockforge.game.player; p.y = p.py = y + 2; p.pitch = -0.2; }, city);
    await page.waitForTimeout(2500);
    await shot('72-ancient-city');
  }

  // --- camels
  await reset();
  r = await page.evaluate(() => {
    const bf = window.__blockforge, g = bf.game, p = g.player, { I } = bf, { x0, y0, z0 } = window.__pad;
    p.mode = 'survival'; p.flying = false;
    const c = new bf.Mob('camel', x0 + 2.5, y0, z0 + 0.5); g.entities.push(c);
    // cactus wins a camel over; then it takes a saddle
    c.health = 20;
    c.interact(g, { id: bf.B.cactus, count: 1 });
    const healed = c.health > 20;
    c.tamed = true; // broken in by riding, as with steeds
    p.inventory.set(0, { id: I.saddle, count: 1 }); p.inventory.selected = 0;
    c.interact(g, p.inventory.held);
    p.inventory.set(0, null);
    c.interact(g, null);
    return { saddled: !!c.saddled, riding: p.vehicle === c, healed };
  });
  assert(r.healed, 'cactus heals a camel');
  assert(r.saddled && r.riding, `a saddled camel can be ridden (${JSON.stringify(r)})`);

  await shot('73-camel');

  console.log('errors', errors.length);
  assert(errors.length === 0, `no page errors (${errors.length})`);
  if (errors.length) console.log(errors.slice(0, 5).join('\n'));
  await browser.close();
})();
