// Two players in one shared world (host + guest) over BroadcastChannel or the relay.
// Usage: node tools/multiplayer.cjs <base-url> <outdir> [tabs|relay]
const { chromium } = require('playwright');
const base = process.argv[2];
const out = process.argv[3] || '.';
const mode = process.argv[4] || 'tabs';
const assert = (c, m) => { if (!c) { console.log('FAIL:', m); process.exitCode = 1; } else console.log('ok:', m); };
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const errors = [];
  const open = async (label) => {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(label + ': ' + e.message + '\n' + e.stack));
    page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('ERR_CERT')) errors.push(label + ': ' + m.text()); });
    await page.goto(base);
    await page.waitForFunction(() => document.querySelector('#b-play'), null, { timeout: 60000 });
    return page;
  };
  const host = await open('host');
  const guest = await open('guest');
  const H = (fn, a) => host.evaluate(fn, a), Gu = (fn, a) => guest.evaluate(fn, a);
  const ready = (page) => page.waitForFunction(() => {
    const g = window.__blockforge.game, p = g.player;
    return g.state === 'playing' && g.world.loadProgress(p.x, p.z, 2) >= 1;
  }, null, { timeout: 180000 });

  // host makes a world and builds a gold pillar
  await host.click('#b-play'); await host.waitForTimeout(200);
  await host.click('#b-new'); await host.waitForTimeout(200);
  await host.fill('#w-name', 'Shared Test');
  await host.fill('#w-seed', 'together');
  await host.click('#w-mode button[data-m="creative"]');
  await host.click('#b-create');
  await ready(host);
  const pillar = await H(() => {
    const g = window.__blockforge.game, p = g.player, w = g.world, { B } = window.__blockforge;
    g.settings.daylightCycle = false; g.dayTime = 3000; g.rainTarget = g.rain = 0;
    const x = Math.floor(p.x) + 3, z = Math.floor(p.z), y = w.surfaceY(x, z);
    for (let i = 0; i < 5; i++) w.setBlock(x, y + i, z, B.gold_block, 0);
    return { x, y, z };
  });
  // a save so the pillar is in a "modified" chunk the guest must receive as a diff
  await H(() => window.__blockforge.game.save());

  const link = mode === 'relay' ? `relay:${base.replace('http', 'ws').replace(/\/[^/]*$/, '')}` : 'tabs';
  const code = await H(async (link) => {
    const b = window.__blockforge;
    const links = await b.ui.app.links();
    const l = link.startsWith('relay:') ? b.ui.app.relayLink(link.slice(6)) : links.find((x) => x.kind === 'tabs');
    return b.ui.app.host(l);
  }, link);
  console.log('room code', code);
  assert(/^[a-z0-9]{5}$/.test(code || ''), 'the host gets a room code');

  // guest joins
  await Gu(async ([link, code]) => {
    const b = window.__blockforge;
    b.settings.playerName = 'Guesty';
    const links = await b.ui.app.links();
    const l = link.startsWith('relay:') ? b.ui.app.relayLink(link.slice(6)) : links.find((x) => x.kind === 'tabs');
    await b.ui.app.join(l, code);
  }, [link, code]);
  await ready(guest);
  await guest.waitForTimeout(4000);
  let r = await Gu(([x, y, z]) => {
    const g = window.__blockforge.game, { B } = window.__blockforge;
    return { net: !!g.net && g.net.isGuest, pillar: [0, 1, 2, 3, 4].map((i) => g.world.getBlock(x, y + i, z) === B.gold_block), seed: g.meta.seed, remotes: g.remotePlayers().map((rp) => rp.name) };
  }, [pillar.x, pillar.y, pillar.z]);
  console.log('guest', JSON.stringify(r));
  assert(r.net, 'the guest is connected');
  assert(r.pillar.every(Boolean), 'the guest sees blocks the host placed before they joined (chunk differences)');
  assert(r.remotes.length === 1, 'the guest sees the host as another player');
  r = await H(() => window.__blockforge.game.remotePlayers().map((rp) => [rp.name, Math.round(rp.x), Math.round(rp.y), Math.round(rp.z)]));
  console.log('host sees', JSON.stringify(r));
  assert(r.length === 1 && r[0][0] === 'Guesty', 'the host sees the guest by name');

  // live edits both ways
  await H(([x, y, z]) => { const g = window.__blockforge.game, { B } = window.__blockforge; g.world.setBlock(x + 1, y, z, B.diamond_block, 0); }, [pillar.x, pillar.y, pillar.z]);
  await guest.waitForTimeout(2500);
  r = await Gu(([x, y, z]) => window.__blockforge.game.world.getBlock(x + 1, y, z) === window.__blockforge.B.diamond_block, [pillar.x, pillar.y, pillar.z]);
  assert(r, 'a block the host places appears for the guest');
  await Gu(([x, y, z]) => {
    const g = window.__blockforge.game, p = g.player, { B } = window.__blockforge;
    p.x = p.px = x - 2.5; p.z = p.pz = z + 0.5; p.y = p.py = y + 1; p.flying = true;
    g.world.setBlock(x - 1, y, z, B.emerald_block ?? B.bricks, 0);
    g.breakBlock(x, y + 4, z, true);
  }, [pillar.x, pillar.y, pillar.z]);
  await host.waitForTimeout(2500);
  r = await H(([x, y, z]) => { const g = window.__blockforge.game, { B } = window.__blockforge; return { placed: g.world.getBlock(x - 1, y, z), top: g.world.getBlock(x, y + 4, z), want: B.emerald_block ?? B.bricks }; }, [pillar.x, pillar.y, pillar.z]);
  console.log('host world', JSON.stringify(r));
  assert(r.placed === r.want && r.top === 0, 'blocks the guest places and breaks change the host world');

  // creatures: a pig summoned by the host shows up for the guest and can be hit
  const pigId = await H(([x, y, z]) => {
    const g = window.__blockforge.game;
    g.runCommand('/summon pig');
    const pig = g.entities[g.entities.length - 1];
    pig.x = pig.px = x - 4; pig.y = pig.py = y; pig.z = pig.pz = z + 2;
    return pig.id;
  }, [pillar.x, pillar.y, pillar.z]);
  await guest.waitForTimeout(2500);
  r = await Gu((id) => { const g = window.__blockforge.game; const m = g.net.mirrors.get(id); return m ? { type: m.type, x: m.x } : null; }, pigId);
  console.log('guest pig', JSON.stringify(r));
  assert(r && r.type === 'pig', 'the guest sees the host\'s creatures');
  await Gu((id) => { const g = window.__blockforge.game; const m = g.net.mirrors.get(id); g.player.mode = 'survival'; g.attack(m); }, pigId);
  await host.waitForTimeout(2500);
  r = await H((id) => { const e = window.__blockforge.game.entities.find((x) => x.id === id); return e ? e.health : null; }, pigId);
  console.log('pig health', r);
  assert(r !== null && r < 10, 'a guest\'s hit hurts the creature in the host world');

  // items: something dropped at the guest's feet ends up in their inventory
  await H(([x, y, z]) => {
    const g = window.__blockforge.game, rp = g.remotePlayers()[0], { I } = window.__blockforge;
    const it = g.dropItem(rp.x, rp.y + 0.5, rp.z, { id: I.diamond, count: 3 });
    it.pickupDelay = 0;
  }, [pillar.x, pillar.y, pillar.z]);
  await guest.waitForTimeout(3000);
  r = await Gu(() => { const g = window.__blockforge.game, { I } = window.__blockforge; let n = 0; for (let i = 0; i < 36; i++) { const s = g.player.inventory.get(i); if (s && s.id === I.diamond) n += s.count; } return n; });
  assert(r === 3, `the guest picks up items in the shared world (${r})`);

  // chat
  await Gu(() => window.__blockforge.game.net.say('hello from the guest'));
  await host.waitForTimeout(2000);
  r = await H(() => window.__blockforge.ui.chatLines.map((l) => l.text).join('\n'));
  assert(/<Guesty> hello from the guest/.test(r), 'chat reaches the host');
  r = await Gu(() => window.__blockforge.ui.chatLines.map((l) => l.text).join('\n'));
  assert(/<Guesty> hello from the guest/.test(r), 'and comes back to everyone');

  // trading: the guest trades from the host's settler and the host counts it
  const settlerId = await H(([x, y, z]) => {
    const g = window.__blockforge.game, rp = g.remotePlayers()[0];
    g.runCommand('/summon settler farmer');
    const m = g.entities[g.entities.length - 1];
    m.x = m.px = rp.x + 2; m.y = m.py = rp.y; m.z = m.pz = rp.z; m.noAI = true;
    const { I } = window.__blockforge;
    m.trades = [{ give: [{ id: I.wheat, count: 2 }], get: { id: I.emerald, count: 1 }, uses: 0, max: 5, xp: 3 }];
    return m.id;
  }, [pillar.x, pillar.y, pillar.z]);
  await guest.waitForTimeout(2500);
  await Gu((id) => {
    const g = window.__blockforge.game, { I } = window.__blockforge;
    g.player.inventory.give({ id: I.wheat, count: 4 });
    const m = g.net.mirrors.get(id);
    g.openTrading(m);
  }, settlerId);
  await guest.waitForTimeout(2000);
  r = await Gu((id) => { const m = window.__blockforge.game.net.mirrors.get(id); return m && m.trades ? m.trades.map((t) => [t.get.id, t.uses]) : null; }, settlerId);
  assert(r && r.length === 1, `the guest sees the host's offers (${JSON.stringify(r)})`);
  await Gu(() => { const ui = window.__blockforge.ui; ui.doTrade(0, true); ui.closeScreen(true); });
  await host.waitForTimeout(2000);
  r = await H((id) => { const m = window.__blockforge.game.entities.find((e) => e.id === id); return m && m.trades[0].uses; }, settlerId);
  const em = await Gu(() => { const g = window.__blockforge.game, { I } = window.__blockforge; let n = 0; for (let i = 0; i < 36; i++) { const s = g.player.inventory.get(i); if (s && s.id === I.emerald) n += s.count; } return n; });
  assert(r === 2 && em === 2, `the host counts the guest's trades (${r} uses, ${em} emeralds)`);

  // an item frame hung by the guest appears for the host, with what it holds
  await Gu(([x, y, z]) => {
    const g = window.__blockforge.game, p = g.player, { I, B } = window.__blockforge;
    p.inventory.set(0, { id: I.item_frame, count: 1 }); p.inventory.selected = 0;
    g.useItemFirst(p.inventory.held, { x, y: y + 2, z, id: B.gold_block, face: 3 });
  }, [pillar.x, pillar.y, pillar.z]);
  await host.waitForTimeout(2500);
  r = await H(() => window.__blockforge.game.entities.filter((e) => e.isFrame).length);
  assert(r === 1, 'a guest\'s item frame is hung in the host world');
  await guest.waitForTimeout(1500);
  await Gu(() => {
    const g = window.__blockforge.game, { I } = window.__blockforge;
    const f = [...g.net.mirrors.values()].find((e) => e.isFrame);
    g.net.useMirror(f, { id: I.diamond_sword, count: 1 });
  });
  await host.waitForTimeout(2000);
  r = await H(() => { const f = window.__blockforge.game.entities.find((e) => e.isFrame); return f && f.stack && f.stack.id; });
  const sword = await H(() => window.__blockforge.I.diamond_sword);
  assert(r === sword, 'and the guest can put an item in it');

  // a void chest keeps the guest's own things, held by the host
  await Gu(([x, y, z]) => {
    const g = window.__blockforge.game, { B, I } = window.__blockforge;
    g.useBlockExtra({ x, y: y + 6, z, id: B.void_chest }, null);
  }, [pillar.x, pillar.y, pillar.z]);
  await guest.waitForTimeout(1500);
  await Gu(() => {
    const g = window.__blockforge.game, ui = window.__blockforge.ui, { I } = window.__blockforge;
    ui.screen.data.be.slots[3] = { id: I.emerald, count: 7 };
    g.net.blockEntityChanged(ui.screen.data.key);
    ui.closeScreen(true);
  });
  await host.waitForTimeout(2000);
  r = await H(() => { const c = window.__blockforge.game.meta.voidChests; return c && c.Guesty && c.Guesty.slots[3]; });
  assert(r && r.count === 7, 'a guest\'s void chest is kept by the host under their name');

  // the host's tab goes to the background: the world keeps ticking for the guest
  const t0 = await H(() => window.__blockforge.game.tickCount);
  await host.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.__realRAF = window.requestAnimationFrame;
    window.requestAnimationFrame = (cb) => { window.__heldFrame = cb; return 0; }; // drawing stops in a hidden tab
  });
  await host.waitForTimeout(3000);
  const t1 = await H(() => window.__blockforge.game.tickCount);
  assert(t1 - t0 > 20, `a hidden host keeps the world running (${t1 - t0} ticks in 3s)`);
  await host.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    window.requestAnimationFrame = window.__realRAF;
    if (window.__heldFrame) window.requestAnimationFrame(window.__heldFrame);
    document.dispatchEvent(new Event('visibilitychange'));
    const ui = window.__blockforge.ui; if (window.__blockforge.game.state === 'paused') ui.resume && ui.resume();
  });
  await host.waitForTimeout(500);

  // pictures of each other
  await H(([x, y, z]) => { const g = window.__blockforge.game, p = g.player; p.x = p.px = x - 2.5; p.z = p.pz = z - 4.5; p.y = p.py = y + 1.2; p.yaw = Math.PI; p.pitch = -0.1; p.flying = true; }, [pillar.x, pillar.y, pillar.z]);
  await Gu(([x, y, z]) => { const g = window.__blockforge.game, p = g.player; p.x = p.px = x - 2.5; p.z = p.pz = z + 1.5; p.y = p.py = y + 1.2; p.yaw = 0; p.pitch = -0.1; p.flying = true; }, [pillar.x, pillar.y, pillar.z]);
  await host.waitForTimeout(3500);
  await host.screenshot({ path: `${out}/80-host-view-${mode}.png` });
  await guest.screenshot({ path: `${out}/81-guest-view-${mode}.png` });

  // the host changes dimension and the guest follows
  await H(() => window.__blockforge.game.runCommand('/dimension underworld'));
  await host.waitForFunction(() => window.__blockforge.game.state === 'playing' && window.__blockforge.game.dim === 'underworld', null, { timeout: 120000 });
  await guest.waitForFunction(() => window.__blockforge.game.dim === 'underworld' && window.__blockforge.game.state === 'playing', null, { timeout: 120000 }).catch(() => {});
  await guest.waitForTimeout(3000);
  r = await Gu(() => { const g = window.__blockforge.game; return { dim: g.dim, state: g.state, sees: g.remotePlayers().length }; });
  const hp = await H(() => { const p = window.__blockforge.game.player; return [p.x, p.y, p.z]; });
  const gp = await Gu(() => { const p = window.__blockforge.game.player; return [p.x, p.y, p.z]; });
  console.log('after travel', JSON.stringify(r), 'host', hp.map(Math.round), 'guest', gp.map(Math.round));
  assert(r.dim === 'underworld' && r.state === 'playing' && r.sees === 1, 'when the host changes dimension the guest follows');
  assert(Math.hypot(hp[0] - gp[0], hp[2] - gp[2]) < 8, 'and arrives next to the host');
  await guest.screenshot({ path: `${out}/82-guest-underworld-${mode}.png` });

  // the guest leaves
  await Gu(() => window.__blockforge.ui.app.leave());
  await host.waitForTimeout(mode === 'tabs' ? 7000 : 3000);
  r = await H(() => window.__blockforge.game.remotePlayers().length);
  assert(r === 0, 'the host sees the guest leave');

  console.log('ERRORS:', errors.length ? '\n' + errors.join('\n') : 'none');
  if (errors.length) process.exitCode = 1;
  await browser.close();
})();
