// Scripted play-through for regression checks and screenshots.
// Usage: node tools/play.cjs <url> <outdir>
const { chromium } = require('playwright');
const url = process.argv[2] || 'http://127.0.0.1:8123/index.html';
const out = process.argv[3] || '.';
const W = 1280, H = 720;
(async () => {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message + '\n' + e.stack));
  await page.goto(url, { timeout: 120000 });
  await page.waitForFunction(() => document.querySelector('#b-play'), null, { timeout: 60000 });
  await page.click('#b-play'); await page.waitForTimeout(300);
  await page.click('#b-new'); await page.waitForTimeout(300);
  await page.fill('#w-seed', process.env.SEED || 'smoke-test');
  await page.click('#b-create');
  await page.waitForFunction(() => window.__blockforge.game.state === 'playing', null, { timeout: 180000 });
  const G = (fn, arg) => page.evaluate(fn, arg);
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: `${out}/${name}.png` }); console.log('shot', name); };
  const cmd = (c) => G((c) => window.__blockforge.game.runCommand(c), c);
  const state = () => G(() => { const g = window.__blockforge.game, p = g.player; return { st: g.state, x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), onGround: p.onGround, hp: p.health, inv: p.inventory.slots.filter(Boolean).map((s) => s.id + 'x' + s.count), target: g.target && [g.target.x, g.target.y, g.target.z, g.target.id] }; });
  await page.waitForTimeout(3000);
  console.log('start', JSON.stringify(await state()));
  await shot('10-spawn');

  // walk forward
  await page.keyboard.down('KeyW'); await page.waitForTimeout(1500); await page.keyboard.up('KeyW');
  console.log('walked', JSON.stringify(await state()));

  // look down and mine by hand
  await G(() => { const p = window.__blockforge.game.player; p.pitch = -1.3; });
  await page.waitForTimeout(300);
  const before = await state();
  await G(() => { const i = window.__blockforge.game.input; i.mouse.left = true; i.clicks.left++; });
  await page.waitForTimeout(3500);
  await G(() => { window.__blockforge.game.input.mouse.left = false; });
  await page.waitForTimeout(1500);
  const after = await state();
  console.log('mined: before target', JSON.stringify(before.target), 'after inv', JSON.stringify(after.inv));

  // place the collected block back
  await G(() => { const i = window.__blockforge.game.input; i.clicks.right++; });
  await page.waitForTimeout(500);
  console.log('placed', JSON.stringify(await state()));

  // inventory screen
  console.log(await cmd('/give oak_log 16'));
  console.log(await cmd('/give cobblestone 20'));
  console.log(await cmd('/give stick 8'));
  await page.keyboard.press('KeyE');
  await page.waitForTimeout(600);
  await shot('11-inventory');
  await page.keyboard.press('KeyE');
  await page.waitForTimeout(300);

  // crafting table
  await G(() => { window.__blockforge.ui.openScreen('crafting'); });
  await G(() => { const g = window.__blockforge.game; g.craft3.set(0, { id: 4, count: 1 }); g.craft3.set(1, { id: 4, count: 1 }); g.craft3.set(2, { id: 4, count: 1 }); const st = g.player.inventory.slots.findIndex((s) => s && s.id === 256); g.craft3.set(4, { id: 256, count: 1 }); g.craft3.set(7, { id: 256, count: 1 }); });
  await page.waitForTimeout(500);
  await shot('12-crafting');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // blast crate on land near spawn
  const spot = await G(() => {
    const g = window.__blockforge.game, p = g.player, w = g.world;
    const x = Math.floor(p.x) + 7, z = Math.floor(p.z);
    const y = w.surfaceY(x, z);
    w.setBlock(x, y, z, 72, 0);
    p.x = p.px = x - 9; p.z = p.pz = z + 0.5; p.y = p.py = Math.max(p.y, y + 3); p.flying = true;
    p.yaw = Math.PI / 2; p.pitch = -0.3;
    return [x, y, z, w.getBlock(x, y - 1, z)];
  });
  console.log('crate at', JSON.stringify(spot));
  await G(() => { const g = window.__blockforge.game; g.target = null; });
  await G((s) => { const g = window.__blockforge.game; g.world.setBlock(s[0], s[1], s[2], 0, 0); g.explode(s[0] + 0.5, s[1] + 0.5, s[2] + 0.5, 4); }, spot);
  await page.waitForTimeout(250);
  await shot('19-explosion');
  await page.waitForTimeout(3000);
  const holes = await G((s) => { const w = window.__blockforge.game.world; let n = 0; for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let dy = -3; dy <= 1; dy++) if (!w.getBlock(s[0] + dx, s[1] + dy, s[2] + dz)) n++; return n; }, spot);
  console.log('air cells around crater', holes);
  await shot('20-crater');

  // F3 debug + night sky
  await page.keyboard.press('F3');
  await cmd('/time set 18000');
  await G(() => { const p = window.__blockforge.game.player; p.pitch = 0.5; });
  await page.waitForTimeout(1500);
  await shot('13-night-debug');
  await page.keyboard.press('F3');
  await cmd('/time set 12300');
  await G(() => { const p = window.__blockforge.game.player; p.pitch = 0.05; p.yaw = -Math.PI / 2; });
  await page.waitForTimeout(1500);
  await shot('14-sunset');
  await cmd('/time set 6000');

  // creatures
  await cmd('/gamemode creative');
  await G(() => { const p = window.__blockforge.game.player; p.pitch = -0.25; p.yaw = 0; });
  for (const m of ['pig', 'cow', 'sheep', 'chicken', 'ghoul']) {
    await G((m) => { const g = window.__blockforge.game; const p = g.player; g.runCommand('/summon ' + m); const e = g.entities[g.entities.length - 1]; const i = ['pig', 'cow', 'sheep', 'chicken', 'ghoul'].indexOf(m); e.x = p.x - 3 + i * 1.5; e.z = p.z - 4.5; e.y = p.y + 1; e.bodyYaw = e.yaw = Math.PI; }, m);
  }
  await page.waitForTimeout(2500);
  await shot('15-creatures');

  // third person
  await page.keyboard.press('F5');
  await G(() => { const g = window.__blockforge.game; g.player.inventory.set(g.player.inventory.selected, { id: 272 + 0, count: 1 }); });
  await page.waitForTimeout(800);
  await shot('16-third-person');
  await page.keyboard.press('F5'); await page.keyboard.press('F5');

  // fly high for a vista
  await G(() => { const g = window.__blockforge.game; g.player.flying = true; g.player.y += 40; g.player.py = g.player.y; g.player.pitch = -0.35; });
  await page.waitForTimeout(6000);
  await shot('17-vista');

  // underwater: find the sea level column nearby
  const water = await G(() => {
    const g = window.__blockforge.game, w = g.world, p = g.player;
    for (let r = 0; r < 120; r += 2) for (let a = 0; a < 16; a++) {
      const x = Math.floor(p.x + Math.cos(a / 16 * 6.283) * r), z = Math.floor(p.z + Math.sin(a / 16 * 6.283) * r);
      if (w.getBlock(x, 62, z) === 12 && w.getBlock(x, 58, z) === 12) return [x + 0.5, 59, z + 0.5];
    }
    return null;
  });
  if (water) {
    await cmd(`/tp ${water[0]} ${water[1]} ${water[2]}`);
    await G(() => { const g = window.__blockforge.game; g.player.flying = false; g.player.pitch = 0.1; });
    await page.waitForTimeout(3000);
    await shot('18-underwater');
  }

  const perf = await G(() => {
    const g = window.__blockforge.game;
    return { fps: g.fps, frameMs: g.frameMs, chunks: g.world.chunks.size, quads: g.renderer.stats.quads, entities: g.entities.length, items: g.items.length };
  });
  console.log('perf', JSON.stringify(perf));
  console.log('ERRORS (' + errors.length + '):\n' + errors.slice(0, 30).join('\n'));
  await browser.close();
})().catch((e) => { console.error('TEST FAILED', e); process.exit(1); });
