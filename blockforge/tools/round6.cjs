// Feature test for round six: leads, journals and lecterns, rabbits, goats,
// turtles, squid, frogs and the ambient life (petals, fireflies).
// Usage: node tools/round6.cjs <url> <outdir>
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
  await page.fill('#w-seed', 'round six');
  await page.click('#b-create');
  await page.waitForFunction(() => window.__blockforge.game.state === 'playing', null, { timeout: 180000 });
  await page.waitForTimeout(4000);
  const shot = (n) => page.screenshot({ path: `${out}/${n}.png` });

  await page.evaluate(() => {
    const g = window.__blockforge.game, p = g.player, w = g.world, { B } = window.__blockforge;
    g.dayTime = 6000; g.settings.daylightCycle = false; g.rain = 0; g.rainTarget = 0; p.mode = 'survival';
    const x0 = Math.floor(p.x), z0 = Math.floor(p.z), y0 = w.surfaceY(x0, z0);
    window.__pad = { x0, y0, z0 };
  });
  const reset = () => page.evaluate(() => {
    const g = window.__blockforge.game, p = g.player, w = g.world, { B } = window.__blockforge, { x0, y0, z0 } = window.__pad;
    for (let x = -16; x <= 16; x++) for (let z = -16; z <= 16; z++) { w.setBlock(x0 + x, y0 - 1, z0 + z, B.grass, 0); for (let y = 0; y < 40; y++) w.setBlock(x0 + x, y0 + y, z0 + z, 0, 0); }
    p.x = p.px = x0 + 0.5; p.z = p.pz = z0 + 0.5; p.y = p.py = y0; p.vx = p.vy = p.vz = 0; p.health = 20; p.effects = {}; p.sneaking = false;
    if (p.vehicle) g.dismount();
    g.entities = g.entities.filter((e) => !e.isMob); g.items = [];
    g.dayTime = 6000;
    if (g.ui.screen) g.ui.closeScreen(true);
  });
  let r;

  // --- leads
  await reset();
  r = await page.evaluate(() => {
    const bf = window.__blockforge, g = bf.game, p = g.player, w = g.world, { B, I } = bf, { x0, y0, z0 } = window.__pad;
    const pig = new bf.Mob('pig', x0 + 2.5, y0, z0 + 0.5); g.entities.push(pig);
    const put = pig.interact(g, { id: I.lead, count: 1 });
    // walk away: the pig is pulled along
    for (let i = 0; i < 160; i++) { p.x = p.px = x0 + 0.5 + Math.min(10, i * 0.08); g.tickEntities(); g.tickLeashes(); }
    const followed = Math.hypot(pig.x - p.x, pig.z - p.z);
    // tie it to a fence and walk off: it stays
    w.setBlock(x0 + 10, y0, z0 + 3, B.oak_fence, 0);
    const tied = g.useBlock({ x: x0 + 10, y: y0, z: z0 + 3, id: B.oak_fence }, null);
    p.x = p.px = x0 - 6.5;
    for (let i = 0; i < 100; i++) { g.tickEntities(); g.tickLeashes(); }
    const fromFence = Math.hypot(pig.x - (x0 + 10.5), pig.z - (z0 + 3.5));
    // take it back off the post, then drag it too far: the lead snaps
    p.x = p.px = x0 + 9.5;
    const untied = g.useBlock({ x: x0 + 10, y: y0, z: z0 + 3, id: B.oak_fence }, null);
    const back = pig.leash && pig.leash.kind === 'player';
    p.x = p.px = x0 + 9.5 + 20;
    g.tickLeashes();
    const snapped = !pig.leash && g.items.some((it) => it.stack.id === I.lead);
    return { put, followed, tied, fromFence, untied, back, snapped, leash: pig.leash };
  });
  assert(r.put === 'consume', 'a lead goes on a pig');
  assert(r.followed < 6, `a creature on a lead follows (${r.followed.toFixed(1)} blocks behind)`);
  assert(r.tied && r.fromFence < 5, `tied to a fence post it stays put (${r.fromFence.toFixed(1)})`);
  assert(r.untied && r.back, 'and can be taken off the post again');
  assert(r.snapped, 'pulled too far, the lead snaps');
  await reset();
  await page.evaluate(() => {
    const bf = window.__blockforge, g = bf.game, p = g.player, w = g.world, { B } = bf, { x0, y0, z0 } = window.__pad;
    w.setBlock(x0 + 3, y0, z0 - 3, B.oak_fence, 0);
    const s = new bf.Mob('sheep', x0 + 1.5, y0, z0 - 4.5); s.leash = { kind: 'knot', x: x0 + 3, y: y0, z: z0 - 3 }; g.entities.push(s);
    const c = new bf.Mob('cow', x0 - 2.5, y0, z0 - 3.5); c.leash = { kind: 'player', name: g.localName() }; g.entities.push(c);
    p.yaw = 0.3; p.pitch = -0.15;
  });
  await page.waitForTimeout(2500);
  await shot('60-leads');

  // --- journals and lecterns
  await reset();
  r = await page.evaluate(() => {
    const bf = window.__blockforge, g = bf.game, p = g.player, w = g.world, { B, I } = bf, { x0, y0, z0 } = window.__pad;
    const res = {};
    const craft = bf.matchRecipe([I.book, I.feather, I.ink_sac, 0], 2);
    res.recipe = craft && craft.id === I.journal;
    p.inventory.set(0, { id: I.journal, count: 1 }); p.inventory.selected = 0;
    g.useItemFirst(p.inventory.held, null);
    res.screen = g.ui.screen && g.ui.screen.name;
    const ta = document.querySelector('.bookmenu textarea');
    ta.value = 'Day one: built a house by the river.';
    document.querySelector('#b-add').click();
    document.querySelector('.bookmenu textarea').value = 'Day two: the raiders came.';
    document.querySelector('#b-sign').click();
    document.querySelector('#b-title').value = 'Field Notes';
    document.querySelector('#b-signok').click();
    const wj = p.inventory.get(0);
    res.signed = wj && wj.id === I.written_journal && wj.title === 'Field Notes' && wj.pages.length === 2 && /raiders/.test(wj.pages[1]);
    res.author = wj && wj.author;
    // on a lectern its pages turn a comparator's reading
    w.setBlock(x0 + 3, y0, z0 - 2, B.lectern, 2);
    g.useBlock({ x: x0 + 3, y: y0, z: z0 - 2, id: B.lectern }, p.inventory.held);
    res.placed = !!(w.getMeta(x0 + 3, y0, z0 - 2) & 4);
    const m0 = g.measureBlock(x0 + 3, y0, z0 - 2, B.lectern);
    g.useBlock({ x: x0 + 3, y: y0, z: z0 - 2, id: B.lectern }, null);
    res.reader = g.ui.screen && g.ui.screen.name === 'book' && /built a house/.test(document.querySelector('.btext').textContent);
    document.querySelector('#b-next').click();
    const m1 = g.measureBlock(x0 + 3, y0, z0 - 2, B.lectern);
    res.pages = [m0, m1];
    return res;
  });
  assert(r.recipe, 'a book, a feather and an ink sac make a journal');
  assert(r.screen === 'book' && r.signed, `a journal is written in and signed (${JSON.stringify(r)})`);
  assert(r.placed && r.reader, 'a signed journal is read from a lectern');
  assert(r.pages[1] > r.pages[0], `turning its page changes what a comparator reads (${JSON.stringify(r.pages)})`);
  await shot('61-journal');
  r = await page.evaluate(() => {
    const bf = window.__blockforge, g = bf.game, p = g.player, w = g.world, { B, I } = bf, { x0, y0, z0 } = window.__pad;
    document.querySelector('#b-take').click();
    return { back: p.inventory.count(I.written_journal), empty: !(w.getMeta(x0 + 3, y0, z0 - 2) & 4), screen: g.ui.screen && g.ui.screen.name };
  });
  assert(r.back === 1 && r.empty && !r.screen, 'the reader takes the journal back');

  // --- rabbits
  await reset();
  r = await page.evaluate(() => {
    const bf = window.__blockforge, g = bf.game, p = g.player, w = g.world, { B, I } = bf, { x0, y0, z0 } = window.__pad;
    p.x = p.px = x0 + 15.5; p.z = p.pz = z0 + 15.5;
    for (let i = 0; i < 3; i++) { w.setBlock(x0 + i, y0 - 1, z0 - 4, B.farmland, 7); w.setBlock(x0 + i, y0, z0 - 4, B.carrots, 7); }
    const rb = new bf.Mob('rabbit', x0 + 1.5, y0, z0 + 1.5, { variant: 'brown' }); g.entities.push(rb);
    let hopped = false;
    const before = [0, 1, 2].reduce((n, i) => n + (w.getMeta(x0 + i, y0, z0 - 4) & 7), 0);
    for (let i = 0; i < 1200; i++) {
      g.tickEntities();
      if (rb.vy > 0.3) hopped = true;
      const now = [0, 1, 2].reduce((n, k) => n + (w.getBlock(x0 + k, y0, z0 - 4) === B.carrots ? w.getMeta(x0 + k, y0, z0 - 4) & 7 : 0), 0);
      if (now < before) return { hopped, nibbled: true };
    }
    return { hopped, nibbled: false };
  });
  assert(r.hopped, 'rabbits hop');
  assert(r.nibbled, 'rabbits nibble ripe carrots');

  // --- goats
  await reset();
  r = await page.evaluate(() => {
    const bf = window.__blockforge, g = bf.game, p = g.player, w = g.world, { B, I } = bf, { x0, y0, z0 } = window.__pad;
    p.x = p.px = x0 - 14.5; p.z = p.pz = z0 - 14.5;
    const goat = new bf.Mob('goat', x0 + 0.5, y0, z0 + 0.5); g.entities.push(goat);
    const pig = new bf.Mob('pig', x0 + 6.5, y0, z0 + 0.5); pig.noAI = true; g.entities.push(pig);
    goat.ramCool = 0;
    let hit = false;
    for (let i = 0; i < 400 && !hit; i++) { g.tickEntities(); if (pig.health < pig.maxHealth) hit = true; }
    // a charge into stone knocks off a horn
    pig.removed = true;
    for (let y = 0; y < 3; y++) for (let z = -2; z <= 2; z++) w.setBlock(x0 - 4, y0 + y, z0 + z, B.stone, 0);
    goat.x = goat.px = x0 + 0.5; goat.z = goat.pz = z0 + 0.5; goat.vx = goat.vz = 0;
    goat.ram = { yaw: Math.atan2(-1, 0), t: 20 };
    const n0 = g.items.length;
    for (let i = 0; i < 80 && goat.ram; i++) g.tickEntities();
    const horn = g.items.slice(n0).find((it) => it.stack.id === I.goat_horn);
    // the horn sounds, then rests
    let ready = null;
    if (horn) {
      p.inventory.set(0, { ...horn.stack }); p.inventory.selected = 0;
      g.useItemFirst(p.inventory.held, null);
      ready = g.hornReady - g.tickCount;
    }
    const milk = goat.interact(g, { id: I.bucket, count: 1 });
    return { hit, horn: !!horn, ready, milk };
  });
  assert(r.hit, 'a goat lowers its head and rams what stands nearby');
  assert(r.horn, 'charging into stone knocks off a horn');
  assert(r.ready > 100, 'a goat horn sounds its call and then needs a breather');
  assert(r.milk === 'milked', 'goats can be milked');

  // --- turtles, squid and frogs
  await reset();
  r = await page.evaluate(() => {
    const bf = window.__blockforge, g = bf.game, p = g.player, w = g.world, { B, I } = bf, { x0, y0, z0 } = window.__pad;
    const res = {};
    const t = new bf.Mob('turtle', x0 + 2.5, y0, z0 + 0.5, { baby: true }); g.entities.push(t);
    t.growth = -2;
    const n0 = g.items.length;
    for (let i = 0; i < 4; i++) g.tickEntities();
    res.scute = g.items.slice(n0).some((it) => it.stack.id === I.scute);
    res.shell = bf.matchRecipe([I.scute, I.scute, I.scute, I.scute, 0, I.scute, 0, 0, 0], 3);
    res.shellId = I.turtle_shell;
    // a turtle shell helmet lends breath
    p.inventory.set(36, { id: I.turtle_shell, count: 1 });
    p.survival(g);
    res.breath = !!(p.effects.water_breathing);
    p.inventory.set(36, null); p.effects = {};
    // a squid in a pool squirts ink when hit and drops ink sacs
    for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) for (let y = -4; y <= -1; y++) w.setBlock(x0 + x - 8, y0 + y, z0 + z, B.water, 0);
    const sq = new bf.Mob('squid', x0 - 7.5, y0 - 3, z0 + 0.5); g.entities.push(sq);
    for (let i = 0; i < 40; i++) g.tickEntities();
    const parts0 = g.particles.list.length;
    sq.hurt(g, 1, undefined, undefined, 'player');
    for (let i = 0; i < 3; i++) g.tickEntities();
    res.ink = g.particles.list.length - parts0;
    res.swims = sq.inWater;
    for (let i = 0; i < 12; i++) g.tickEntities(); // past its moment of invulnerability
    sq.hurt(g, 100, undefined, undefined, 'player');
    const n1 = g.items.length;
    for (let i = 0; i < 25; i++) g.tickEntities();
    res.sac = g.items.slice(n1).some((it) => it.stack.id === I.ink_sac);
    // frogs hop along
    const f = new bf.Mob('frog', x0 + 4.5, y0, z0 + 4.5, { variant: 'cold' }); g.entities.push(f);
    let hop = false;
    for (let i = 0; i < 600 && !hop; i++) { g.tickEntities(); if (f.vy > 0.3) hop = true; }
    res.frogHop = hop;
    return res;
  });
  assert(r.scute, 'a young turtle sheds a scute as it grows up');
  assert(r.shell && r.shell.id === r.shellId, 'five scutes make a turtle shell');
  assert(r.breath, 'a turtle shell lends breath underwater');
  assert(r.swims && r.ink > 5, `a squid squirts ink when hit (${r.ink} particles)`);
  assert(r.sac, 'squid drop ink sacs');
  assert(r.frogHop, 'frogs hop');

  // --- ambient life
  await reset();
  r = await page.evaluate(() => {
    const bf = window.__blockforge, g = bf.game, p = g.player, w = g.world, { B } = bf, { x0, y0, z0 } = window.__pad;
    for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) w.setBlock(x0 + x, y0 + 5, z0 + z, B.blossom_leaves, 1);
    g.particles.list.length = 0;
    for (let i = 0; i < 600; i++) g.tickAmbientLife();
    const petals = g.particles.list.filter((q) => q.flutter).length;
    for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) w.setBlock(x0 + x, y0 + 5, z0 + z, 0, 0);
    // fireflies come out on warm nights in the right country
    g.dayTime = 18000;
    const bio = w.gen.biomeAt(Math.floor(p.x), Math.floor(p.z));
    g.particles.list.length = 0;
    for (let i = 0; i < 400; i++) g.tickAmbientLife();
    const flies = g.particles.list.filter((q) => q.firefly).length;
    g.dayTime = 6000;
    return { petals, flies, bio };
  });
  assert(r.petals > 5, `petals drift down from blossom trees (${r.petals})`);
  if ([5, 6, 13, 18, 24].includes(r.bio)) assert(r.flies > 3, `fireflies glow on a warm night (${r.flies})`);
  else console.log('skip: fireflies (not in their country here, biome ' + r.bio + ')');
  await page.evaluate(() => {
    const bf = window.__blockforge, g = bf.game, p = g.player, w = g.world, { B } = bf, { x0, y0, z0 } = window.__pad;
    for (let x = -4; x <= 4; x++) for (let z = -8; z <= -2; z++) w.setBlock(x0 + x, y0 + 4, z0 + z, B.blossom_leaves, 1);
    for (let x = -1; x <= 1; x++) for (let z = -6; z <= -4; z++) w.setBlock(x0 + x, y0, z0 + z, x === 0 && z === -5 ? B.blossom_log : 0, 0);
    for (let y = 0; y < 4; y++) w.setBlock(x0, y0 + y, z0 - 5, B.blossom_log, 0);
    p.yaw = 0; p.pitch = 0.15;
    for (let i = 0; i < 300; i++) g.tickAmbientLife();
  });
  await page.waitForTimeout(1500);
  await shot('62-petals');

  assert(errors.length === 0, `no page errors (${errors.length})`);
  if (errors.length) console.log(errors.slice(0, 5).join('\n---\n'));
  await browser.close();
})();
