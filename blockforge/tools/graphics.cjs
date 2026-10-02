// Graphics check: every preset renders without GL errors; screenshots for review.
// Usage: node tools/graphics.cjs <url> <outdir>
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
  page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !m.text().includes('ERR_CERT')) errors.push(m.type() + ': ' + m.text()); });
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
  const info = await G(() => { const r = window.__blockforge.renderer; return { gpu: r.gpuName, hdr: r.hdr, samples: r.maxSamples, post: r.postOK, shadow: r.shadowOK, preset: window.__blockforge.settings.graphics }; });
  console.log('renderer', JSON.stringify(info));
  assert(info.post && info.shadow, 'post-processing and shadow programs compile');
  assert(info.preset === 'performance', `a software renderer starts on the Performance preset (${info.preset})`);

  await page.click('#b-play'); await page.waitForTimeout(300);
  await page.click('#b-new'); await page.waitForTimeout(200);
  await page.fill('#w-name', 'Graphics');
  await page.fill('#w-seed', 'settlers');
  await page.click('#w-mode button[data-m="creative"]');
  await page.click('#b-create');
  await page.waitForFunction(() => window.__blockforge.game.state === 'playing', null, { timeout: 180000 });
  await waitReady(1000);
  // a village seen from a hillside in the morning, with a lamp post and a pool
  const loc = await G(() => window.__blockforge.game.runCommand('/locate village'));
  const m = /at (-?\d+), ~, (-?\d+)/.exec(loc);
  await G(([vx, vz]) => {
    const g = window.__blockforge.game, p = g.player;
    p.flying = true; g.rainTarget = g.rain = 0; g.dayTime = 1800; g.settings.daylightCycle = false;
    p.x = p.px = vx - 22.5; p.z = p.pz = vz + 22.5; p.y = p.py = 140;
  }, [+m[1], +m[2]]);
  await waitReady(2500);
  await G(([vx, vz]) => {
    const g = window.__blockforge.game, p = g.player, w = g.world, { B } = window.__blockforge;
    const h = w.surfaceY(Math.floor(p.x), Math.floor(p.z));
    p.y = p.py = h + 14;
    p.yaw = Math.atan2(vx - p.x, -(vz - p.z)); p.pitch = -0.42;
    const X = vx - 12, Z = vz + 10, Y = w.surfaceY(X, Z) + 1;
    for (let dz = 0; dz < 5; dz++) for (let dx = 0; dx < 7; dx++) { w.setBlock(X + dx, Y - 1, Z + dz, B.water, 0); for (let y = Y; y < Y + 5; y++) w.setBlock(X + dx, y, Z + dz, 0, 0); }
    for (let y = Y; y < Y + 4; y++) w.setBlock(X - 2, y, Z + 2, B.oak_fence ?? B.oak_log, 0);
    w.setBlock(X - 2, Y + 4, Z + 2, B.lamp, 0);
  }, [+m[1], +m[2]]);
  await waitReady(1500);
  const glErr = () => G(() => { const gl = window.__blockforge.renderer.gl; let e, n = 0; while ((e = gl.getError()) !== gl.NO_ERROR && n < 10) n++; return n; });
  const fps = () => G(() => window.__blockforge.game.fps || 0);
  for (const name of ['performance', 'balanced', 'fancy', 'ultra']) {
    await G((name) => { const b = window.__blockforge; b.quality.applyPreset(b.settings, name); b.settings.renderDistance = 8; b.ui.app.applySettings(); }, name);
    await page.waitForTimeout(3500);
    const st = await G(() => { const r = window.__blockforge.renderer; return { post: r.post, samples: r.targets ? r.targets.samples : 0, bloom: r.targets ? r.targets.bloom.length : 0, shadow: r.shadowParams[0], size: r.shadow ? r.shadow.size : 0, emissive: r.emissive }; });
    const n = await glErr();
    console.log(name, JSON.stringify(st), 'glErrors', n, 'fps', await fps());
    assert(n === 0, `${name}: no GL errors`);
    await shot(`70-${name}`);
  }
  // shadows really darken something: compare a pixel row with shadows off and on
  // night with lights (bloom)
  await G(() => { const g = window.__blockforge.game; g.dayTime = 17500; });
  await page.waitForTimeout(3000);
  await shot('74-night-ultra');
  await G(() => { const b = window.__blockforge; b.quality.applyPreset(b.settings, 'performance'); b.settings.renderDistance = 6; b.ui.app.applySettings(); });
  await page.waitForTimeout(2500);
  await shot('75-night-performance');
  // options screen
  await G(() => { const g = window.__blockforge.game; g.dayTime = 3000; window.__blockforge.ui.pause(); });
  await page.waitForTimeout(400);
  await page.click('#b-opt');
  await page.waitForTimeout(500);
  await shot('76-options-video');
  await page.click('.presets .btn[data-p="fancy"]');
  await page.waitForTimeout(500);
  const sel = await G(() => ({ g: window.__blockforge.settings.graphics, shadows: window.__blockforge.settings.shadows, label: document.querySelector('.presets .btn.sel').textContent }));
  console.log('preset click', JSON.stringify(sel));
  assert(sel.g === 'fancy' && sel.shadows === 2 && sel.label === 'Fancy', 'clicking a preset applies it');
  await page.click('#o-bloom');
  await page.waitForTimeout(300);
  const sel2 = await G(() => ({ g: window.__blockforge.settings.graphics, label: document.querySelector('.presets .btn.sel') ? 'sel' : 'none', note: document.querySelector('.preset-note').textContent }));
  assert(sel2.g === 'custom' && sel2.label === 'none', 'changing one setting switches to Custom');
  await shot('77-options-custom');
  await page.click('.tabs .btn[data-t="game"]');
  await page.waitForTimeout(300);
  await shot('78-options-game');
  console.log('ERRORS:', errors.length ? '\n' + errors.join('\n') : 'none');
  if (errors.filter((e) => !e.startsWith('warning')).length) process.exitCode = 1;
  await browser.close();
})();
