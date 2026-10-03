/**
 * End-to-end test of the hosted web page in real Chromium, against the local
 * platform stand-in (tools/mock): single-player saves (browser + cloud + file
 * export), and 4-player online co-op through the room relay — host a world,
 * friends find it in the open-games list or by code, play together, a friend
 * leaves and rejoins, the 5th is refused, the host closes the world.
 * Usage: npx tsx tools/build-web.ts && npx tsx tools/e2e-coop.ts
 */
import { chromium, type Page, type Browser } from 'playwright-core';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { startMockPlatform } from './mock/server';

const PORT = 7795;
const OUT = path.resolve('screenshots');
mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const step = (m: string) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
const errors: string[] = [];
const LOW = { preset: 'low', shadows: 1, viewDistance: 400, terrainDetail: 1, vegetationDensity: 0.3, grassDensity: 0, waterQuality: 1, ambientOcclusion: false, bloom: false, antiAliasing: 'fxaa', anisotropy: 1, postProcessing: false, godRays: false, renderScale: 0.5, dynamicResolution: false };
const mockClient = readFileSync(path.resolve('tools/mock/client.js'), 'utf8');

function assert(c: unknown, msg: string): asserts c { if (!c) throw new Error(`ASSERT: ${msg}`); }

async function player(name: string, user: string): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.on('pageerror', (e) => errors.push(`[${name}] pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|GPU stall|CONTEXT_LOST|Autoplay/i.test(m.text())) errors.push(`[${name}] console.error: ${m.text()}`); if (process.env.VERBOSE) console.log(`[${name}] ${m.text()}`); });
  await page.addInitScript(([settings, nm]) => {
    try { localStorage.setItem('tidewake.settings.v1', JSON.stringify({ graphics: settings, gameplay: { name: nm, showTutorial: false } })); } catch { /* */ }
  }, [LOW, name] as const);
  await page.addInitScript(mockClient);
  await page.goto(`http://localhost:${PORT}/?mockuser=${user}`);
  await page.waitForSelector('.title', { timeout: 30000 });
  return { browser, page };
}

const click = async (page: Page, text: string | RegExp) => {
  const loc = page.locator('#ui button', { hasText: text }).first();
  await loc.waitFor({ state: 'visible', timeout: 20000 });
  await loc.click();
};
const ready = (page: Page, ms = 180000) => page.waitForFunction(() => (window as any).tidewake?.game?.isReady === true, null, { timeout: ms, polling: 500 });
const state = (page: Page) => page.evaluate(() => {
  const g = (window as any).tidewake?.game;
  const s = g?.session;
  return s ? { connected: s.connected, id: s.playerId, roster: s.roster.filter((r: any) => r.connected).map((r: any) => r.name), remotes: s.remotePlayers().length, pos: s.viewPosition(), snaps: s.snapshotsReceived, kind: s.transport?.kind } : null;
});

async function main() {
  const platform = await startMockPlatform(PORT, { latencyMs: 40 });
  step('platform up');
  const all: Browser[] = [];
  try {
    // ------------------------------------------------ host: new world, invite
    const A = await player('Ana', 'u-ana');
    all.push(A.browser);
    await A.page.screenshot({ path: path.join(OUT, 'web-01-menu.png') });
    await click(A.page, 'Play with Friends');
    await A.page.waitForSelector('text=No open games right now', { timeout: 20000 });
    await A.page.screenshot({ path: path.join(OUT, 'web-02-friends.png') });
    await click(A.page, 'Host a New World');
    await A.page.locator('#ui input[type=text]').first().fill('Coop Atoll');
    await A.page.locator('#ui input[type=text]').nth(1).fill('5150');
    await click(A.page, 'Start & Invite');
    await ready(A.page);
    step('host world ready');
    const code = await A.page.waitForFunction(() => (window as any).tidewake?.coop?.code ?? null, null, { timeout: 20000 }).then((h) => h.jsonValue() as Promise<string>);
    assert(/^[a-z0-9]{6}$/.test(code), `game code ${code}`);
    step(`hosting with code ${code}`);

    // ------------------------------------------------ friend B joins from the open-games list
    const B = await player('Ben', 'u-ben');
    all.push(B.browser);
    await click(B.page, 'Play with Friends');
    await B.page.waitForSelector(`text=Ana's game`, { timeout: 20000 });
    await B.page.screenshot({ path: path.join(OUT, 'web-03-open-games.png') });
    await click(B.page, /^Join$/);
    await ready(B.page);
    step('Ben joined');
    // ------------------------------------------------ friend C joins by code
    const C = await player('Cy', 'u-cy');
    all.push(C.browser);
    await click(C.page, 'Play with Friends');
    await C.page.locator('#ui input[placeholder^="e.g."]').fill(code);
    await click(C.page, /^Join$/);
    await ready(C.page);
    step('Cy joined by code');
    // ------------------------------------------------ friend D (4th player)
    const D = await player('Dee', 'u-dee');
    all.push(D.browser);
    await click(D.page, 'Play with Friends');
    await D.page.locator('#ui input[placeholder^="e.g."]').fill(code);
    await click(D.page, /^Join$/);
    await ready(D.page);
    step('Dee joined: 4 players');

    await sleep(3000);
    const sa = await state(A.page);
    assert(sa && sa.roster.length === 4, `host roster ${JSON.stringify(sa?.roster)}`);
    for (const [n, p] of [['B', B.page], ['C', C.page], ['D', D.page]] as const) {
      const s = await state(p);
      assert(s && s.kind === 'relay' && s.roster.length === 4, `${n} roster ${JSON.stringify(s)}`);
      assert(s.remotes === 3, `${n} sees ${s.remotes} remote players`);
    }

    // ------------------------------------------------ Ben walks; the host sees him move
    const before = await A.page.evaluate((id) => { const p = (window as any).tidewake.game.session.remotePlayers().find((r: any) => r.id === id); return p ? { x: p.x, z: p.z } : null; }, (await state(B.page))!.id);
    assert(before, 'host sees Ben');
    await B.page.evaluate(() => { const g = (window as any).tidewake.game; g.yaw = 0.3; });
    // software rendering with 4 browsers runs at a few fps, so walk until Ben has really moved
    const start = (await state(B.page))!.pos;
    await B.page.keyboard.down('KeyW');
    for (let i = 0; i < 40; i++) {
      await sleep(1000);
      const p = (await state(B.page))!.pos;
      if (Math.hypot(p.x - start.x, p.z - start.z) > 4) break;
    }
    await B.page.keyboard.up('KeyW');
    await sleep(3000);
    const benServer = await A.page.evaluate((id) => { const p = (window as any).tidewake.game.session.remotePlayers().find((r: any) => r.id === id); return p ? { x: p.x, z: p.z } : null; }, (await state(B.page))!.id);
    const benLocal = (await state(B.page))!.pos;
    const moved = Math.hypot(benServer!.x - before.x, benServer!.z - before.z);
    const err = Math.hypot(benServer!.x - benLocal.x, benServer!.z - benLocal.z);
    step(`Ben moved ${moved.toFixed(1)} m; host view vs Ben's own view: ${err.toFixed(2)} m`);
    assert(moved > 2, 'Ben moved');
    assert(err < 1.5, 'views agree');

    // ------------------------------------------------ chat + action round trip
    const chat = await C.page.evaluate(() => (window as any).tidewake.game.act({ a: 'chat', text: 'ahoy from Cy' }));
    assert(chat?.ok, 'chat ok');
    await A.page.screenshot({ path: path.join(OUT, 'web-04-host-4p.png') });
    await B.page.screenshot({ path: path.join(OUT, 'web-05-friend-view.png') });

    // ------------------------------------------------ 5th player is refused
    const E = await player('Eve', 'u-eve');
    all.push(E.browser);
    await click(E.page, 'Play with Friends');
    await E.page.waitForSelector('text=Full', { timeout: 20000 });
    await E.page.locator('#ui input[placeholder^="e.g."]').fill(code);
    await click(E.page, /^Join$/);
    await E.page.waitForSelector('text=full', { timeout: 60000 });
    step('5th player refused (full)');
    await E.browser.close();
    all.pop();

    // ------------------------------------------------ Dee leaves, then rejoins as the same survivor
    const deeId = (await state(D.page))!.id;
    await D.page.keyboard.press('Escape');
    await click(D.page, 'Save & Quit to Menu');
    await D.page.waitForSelector('.title', { timeout: 30000 });
    await A.page.waitForFunction(() => (window as any).tidewake.game.session.roster.filter((r: any) => r.connected).length === 3, null, { timeout: 30000 });
    step('Dee left; host shows 3 players');
    await click(D.page, 'Play with Friends');
    await D.page.locator('#ui input[placeholder^="e.g."]').fill(code);
    await click(D.page, /^Join$/);
    await ready(D.page);
    assert((await state(D.page))!.id === deeId, 'Dee rejoined as the same survivor');
    step('Dee rejoined as the same survivor');

    // ------------------------------------------------ host saves: browser + cloud copy + file export
    await A.page.keyboard.press('Escape');
    await A.page.waitForSelector('text=Menu (game keeps running)', { timeout: 10000 });
    await A.page.screenshot({ path: path.join(OUT, 'web-06-host-menu.png') });
    // the world keeps running for friends while the host is in the menu
    const t1 = await B.page.evaluate(() => (window as any).tidewake.game.session.serverTime());
    await sleep(1500);
    const t2 = await B.page.evaluate(() => (window as any).tidewake.game.session.serverTime());
    assert(t2 - t1 > 1, 'world keeps running while the host is in the menu');
    await click(A.page, 'Save Game');
    await sleep(2500);
    const cloudKeys = [...platform.db.keys()].filter((k) => k.startsWith('data/users/u-ana/saves/worlds/'));
    assert(cloudKeys.length === 1, `cloud save written (${cloudKeys.join(',')})`);
    step('host saved; cloud copy present');

    // ------------------------------------------------ host quits: friends are told
    await click(A.page, 'Save & Quit to Menu');
    await B.page.waitForSelector('text=closed the world', { timeout: 30000 });
    step('friends told the host closed the world');
    await A.page.waitForSelector('.title', { timeout: 30000 });

    // load screen lists the world; export works
    await click(A.page, 'Load Game');
    await A.page.waitForSelector('text=Coop Atoll', { timeout: 20000 });
    await click(A.page, 'Export');
    await A.page.waitForSelector('text=Save file ready', { timeout: 20000 });
    const dl = await A.page.evaluate(() => (window as any).__mockDownloads.map((d: any) => ({ f: d.filename, n: d.size })));
    assert(dl.length === 1 && dl[0].n > 1000, `export ${JSON.stringify(dl)}`);
    await A.page.screenshot({ path: path.join(OUT, 'web-07-load.png') });
    step(`exported ${dl[0].f} (${(dl[0].n / 1024).toFixed(0)} KiB)`);

    // the cloud copy restores the world on a fresh browser (another device)
    const A2 = await player('Ana', 'u-ana');
    all.push(A2.browser);
    await click(A2.page, 'Load Game');
    await A2.page.waitForSelector('text=Coop Atoll', { timeout: 20000 });
    await A2.page.waitForSelector('text=In your cloud saves', { timeout: 5000 });
    await click(A2.page, /^Play$/);
    await ready(A2.page);
    const roster2 = (await state(A2.page))!;
    assert(roster2.connected, 'cloud world loads on another device');
    step('cloud save loaded on a fresh browser');
    console.log(`presence max ${platform.stats.maxPresence} bytes, rejected ${platform.stats.presenceRejected}`);
    assert(platform.stats.presenceRejected === 0, 'no presence update over the 4 KiB limit');
  } finally {
    for (const b of all) await b.close().catch(() => {});
    platform.close();
  }
  if (errors.length) { console.error('PAGE ERRORS:\n' + errors.join('\n')); process.exit(1); }
  console.log('E2E CO-OP PASSED');
  process.exit(0);
}

main().catch((e) => { console.error(e); console.error(errors.join('\n')); process.exit(1); });
