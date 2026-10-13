// Playing where online play is forbidden, and taking the game and its worlds
// elsewhere. The page is served under a policy like a claude.ai page's (no
// outside connections) inside the stand-in page runtime (mock-claude.js).
// Usage: BF_CSP="<policy>" node tools/relay.mjs <port> & node tools/share.cjs http://localhost:<port>/ <outdir>
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const url = process.argv[2];
const out = process.argv[3] || '.';
const assert = (c, m) => { if (!c) { console.log('FAIL:', m); process.exitCode = 1; } else console.log('ok:', m); };
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ viewport: { width: 960, height: 600 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message + '\n' + e.stack));
  await page.addInitScript({ path: path.join(__dirname, 'mock-claude.js') });
  await page.goto(url, { timeout: 120000 });
  await page.waitForFunction(() => document.querySelector('#b-play'), null, { timeout: 90000 });

  // 1. the game notices it may not go online here
  const chk = await page.evaluate(() => window.__blockforge.ui.app.onlineCheck());
  console.log('check', JSON.stringify(chk));
  assert(chk.signal === 'blocked', 'a page that forbids outside connections is recognised');

  // 2. guests are told what works here, and online codes are refused with a reason
  await page.click('#b-multi');
  await page.waitForSelector('#mp-note .elsewhere', { timeout: 30000 }).catch(() => {});
  const note = await page.evaluate(() => (document.querySelector('#mp-note') || {}).textContent || '');
  assert(/claude\.ai/.test(note) && /standalone/i.test(note), 'the Multiplayer screen explains how to play from here');
  await page.fill('#mp-code', 'abcd-2345');
  await page.click('#b-join');
  await page.waitForTimeout(500);
  const err = await page.evaluate(() => document.querySelector('#mp-err').textContent);
  assert(/not allowed to make online connections/.test(err), `an online code gets a clear answer instead of a long wait (${err.slice(0, 80)}…)`);
  await page.screenshot({ path: `${out}/95-multiplayer-in-claude.png` });

  // 3. the standalone copy of the game
  await page.click('.b-standalone');
  await page.waitForFunction(() => window.__mockSaved, null, { timeout: 20000 }).catch(() => {});
  const saved = await page.evaluate(() => window.__mockSaved && { filename: window.__mockSaved.filename, size: window.__mockSaved.size, head: window.__mockSaved.data.slice(0, 15) });
  console.log('standalone', JSON.stringify(saved));
  assert(saved && saved.filename === 'blockforge.html' && saved.size > 500000 && /^<!doctype html>/i.test(saved.head), 'the game hands out a standalone copy of itself');
  const file = path.join(out, 'standalone-blockforge.html');
  fs.writeFileSync(file, await page.evaluate(() => window.__mockSaved.data));
  await page.click('#b-back');

  // 4. a world goes out as a file and comes back in
  await page.click('#b-play'); await page.waitForTimeout(200);
  await page.click('#b-new'); await page.waitForTimeout(200);
  await page.fill('#w-name', 'Travelling World'); await page.fill('#w-seed', 'travel');
  await page.click('#b-create');
  await page.waitForFunction(() => window.__blockforge.game.state === 'playing', null, { timeout: 180000 });
  const mark = await page.evaluate(async () => {
    const g = window.__blockforge.game, p = g.player, { B } = window.__blockforge;
    const x = Math.floor(p.x) + 2, z = Math.floor(p.z), y = g.world.surfaceY(x, z);
    for (let i = 0; i < 6; i++) g.world.setBlock(x, y + i, z, B.emerald_block, 0);
    await g.save();
    return { x, y, z };
  });
  // the sharing panel only offers what works here
  await page.evaluate(() => window.__blockforge.ui.showPause());
  await page.click('#b-share');
  await page.waitForSelector('#share-links .links', { timeout: 30000 });
  const pick = await page.evaluate(() => [...document.querySelectorAll('#share-links .links .btn')].map((b) => [b.textContent, b.disabled, b.classList.contains('sel')]));
  console.log('picker', JSON.stringify(pick));
  const onlineBtn = pick.find((b) => /^Online/.test(b[0]));
  const claudeBtn = pick.find((b) => /claude\.ai page/.test(b[0]));
  assert(onlineBtn && (onlineBtn[1] || /request/.test(onlineBtn[0])) && !/friends anywhere/.test(onlineBtn[0]), 'Online is not offered as if it worked here');
  assert(claudeBtn && claudeBtn[2], 'the page\'s own room is chosen instead');
  await page.screenshot({ path: `${out}/96-share-in-claude.png` });
  await page.evaluate(() => window.__blockforge.ui.app.quit && window.__blockforge.ui.app.quit());
  await page.waitForFunction(() => window.__blockforge.game.state === 'title', null, { timeout: 60000 }).catch(() => {});
  await page.evaluate(() => window.__blockforge.ui.showWorlds());
  await page.waitForSelector('#wl .world');
  await page.evaluate(() => { for (const b of document.querySelectorAll('#wl .world')) if (/Travelling World/.test(b.textContent)) b.click(); });
  await page.evaluate(() => { window.__mockSaved = null; });
  await page.click('#b-export');
  await page.waitForFunction(() => window.__mockSaved, null, { timeout: 30000 }).catch(() => {});
  const exp = await page.evaluate(() => window.__mockSaved && { filename: window.__mockSaved.filename, size: window.__mockSaved.size });
  console.log('export', JSON.stringify(exp));
  assert(exp && /Travelling World\.blockforge\.json$/.test(exp.filename) && exp.size > 1000, 'a world exports as a file');
  const worldFile = path.join(out, 'world.blockforge.json');
  fs.writeFileSync(worldFile, await page.evaluate(() => window.__mockSaved.data));
  await browser.close();

  // 5. the standalone copy, opened as a file (no policy, no claude.ai): it runs,
  //    online play is allowed, and the world comes back in
  const b2 = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const p2 = await (await b2.newContext({ viewport: { width: 960, height: 600 } })).newPage();
  p2.on('pageerror', (e) => errors.push('standalone: ' + e.message));
  await p2.goto('file://' + path.resolve(file), { timeout: 120000 });
  await p2.waitForFunction(() => document.querySelector('#b-play'), null, { timeout: 90000 });
  const chk2 = await p2.evaluate(() => window.__blockforge.ui.app.onlineCheck());
  assert(chk2.signal === 'ok' && chk2.direct === 'ok', `online play is allowed in the standalone game (${JSON.stringify(chk2)})`);
  await p2.click('#b-play'); await p2.waitForTimeout(300);
  const chooser = p2.waitForEvent('filechooser');
  await p2.click('#b-import');
  await (await chooser).setFiles(worldFile);
  await p2.waitForFunction(() => /Imported/.test((document.querySelector('#wl-msg') || {}).textContent || ''), null, { timeout: 30000 }).catch(() => {});
  const imp = await p2.evaluate(() => (document.querySelector('#wl-msg') || {}).textContent);
  assert(/Imported “Travelling World”/.test(imp), `the world imports (${imp})`);
  await p2.evaluate(() => { for (const b of document.querySelectorAll('#wl .world')) if (/Travelling World/.test(b.textContent)) b.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
  await p2.waitForFunction(() => window.__blockforge.game.state === 'playing', null, { timeout: 180000 });
  await p2.waitForFunction(([x, z]) => window.__blockforge.game.world.loadProgress(x, z, 1) >= 1, [mark.x, mark.z], { timeout: 120000 });
  const back = await p2.evaluate(([x, y, z]) => { const g = window.__blockforge.game, { B } = window.__blockforge; let n = 0; for (let i = 0; i < 6; i++) if (g.world.getBlock(x, y + i, z) === B.emerald_block) n++; return n; }, [mark.x, mark.y, mark.z]);
  assert(back === 6, `the imported world has what was built in it (${back}/6)`);
  await p2.screenshot({ path: `${out}/97-imported.png` });
  await b2.close();
  assert(errors.length === 0, `no page errors (${errors.length})`);
  if (errors.length) console.log(errors.slice(0, 5).join('\n'));
})();
