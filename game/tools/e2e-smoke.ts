/**
 * End-to-end smoke test in real Chromium (software WebGL):
 *  1. starts the dedicated server serving the built client
 *  2. loads the main menu, starts a single-player world (?autostart)
 *  3. joins the server as a multiplayer client (?join)
 *  4. fails on any page error / console error, saves screenshots to ./screenshots
 * Usage: npm run build && npx tsx tools/e2e-smoke.ts [--keep]
 */
import { chromium, type Page } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const PORT = 7791;
const OUT = path.resolve('screenshots');
const SAVES = path.resolve('.e2e-saves');
mkdirSync(OUT, { recursive: true });
rmSync(SAVES, { recursive: true, force: true });

const errors: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const step = (m: string) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);

async function main() {
  const server = spawn('npx', ['tsx', 'src/server/main.ts', '--serve-client', '--port', String(PORT), '--save-dir', SAVES, '--world', 'e2e', '--seed', '777'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  for (let i = 0; i < 60 && !serverLog.includes('listening'); i++) await sleep(250);
  if (!serverLog.includes('listening')) throw new Error(`server did not start:\n${serverLog}`);

  const browser = await chromium.launch({
    executablePath: process.env.CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--autoplay-policy=no-user-gesture-required'],
  });
  const watch = (page: Page, tag: string) => {
    page.on('pageerror', (e) => errors.push(`[${tag}] pageerror: ${e.message}\n${e.stack ?? ''}`));
    page.on('console', (m) => {
      const t = m.text();
      if (m.type() === 'error' && !/favicon|GPU stall|WebGL: CONTEXT_LOST|Autoplay/i.test(t)) errors.push(`[${tag}] console.error: ${t}`);
      if (process.env.VERBOSE) console.log(`[${tag}] ${m.type()}: ${t}`);
    });
  };
  try {
    // ---------------- main menu
    const menu = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    step('browser up');
    watch(menu, 'menu');
    await menu.goto(`http://localhost:${PORT}/`);
    await menu.waitForSelector('.title', { timeout: 20000 });
    await sleep(2500);
    await menu.screenshot({ path: path.join(OUT, '01-main-menu.png') });
    console.log('main menu ok');
    await menu.close();

    // ---------------- single player
    const sp = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    watch(sp, 'single');
    await sp.goto(`http://localhost:${PORT}/?autostart=1&seed=4242`);
    await sp.waitForFunction(() => (window as any).tidewake?.game?.isReady === true, null, { timeout: 120000 });
    await sleep(3000);
    await sp.screenshot({ path: path.join(OUT, '02-single-player-spawn.png') });
    const info = await sp.evaluate(() => {
      const g = (window as any).tidewake.game;
      const s = g.session;
      return { pos: s.viewPosition(), health: s.self.health, inv: s.me.inventory.slots.filter(Boolean).length, structures: Object.keys(s.structures).length, fps: g.renderer?.stats?.fps };
    });
    console.log('single player ok', JSON.stringify(info));
    // look around: toward the island centre and the sea
    for (const [i, yaw, pitch] of [[3, 0, -0.05], [4, Math.PI / 2, 0.15], [5, Math.PI, -0.2], [6, -Math.PI / 2, 0.05]] as const) {
      await sp.evaluate(([y, p]) => { const g = (window as any).tidewake.game; g.yaw = y; g.pitch = p; }, [yaw, pitch]);
      await sleep(1500);
      await sp.screenshot({ path: path.join(OUT, `0${i}-view.png`) });
      step(`view ${i}`);
    }
    // open inventory & crafting UI
    await sp.keyboard.press('Tab');
    step('tab');
    await sleep(600);
    await sp.screenshot({ path: path.join(OUT, '07-inventory.png') });
    await sp.keyboard.press('Tab');
    await sp.keyboard.press('KeyM');
    await sleep(1500);
    await sp.screenshot({ path: path.join(OUT, '08-map.png') });
    await sp.keyboard.press('KeyM');
    step('map');
    // free the shared (software) GPU process for the multiplayer phase
    await Promise.race([sp.goto('about:blank'), sleep(15000)]);
    if (process.argv.includes('--sp-only')) return;

    // ---------------- multiplayer join (2 clients)
    const mp1 = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    watch(mp1, 'mp1');
    await mp1.goto(`http://localhost:${PORT}/?join=localhost:${PORT}`);
    await mp1.waitForFunction(() => (window as any).tidewake?.game?.isReady === true, null, { timeout: 120000 });
    const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const mp2 = await ctx2.newPage();
    watch(mp2, 'mp2');
    await mp2.goto(`http://localhost:${PORT}/?join=localhost:${PORT}`);
    await mp2.waitForFunction(() => (window as any).tidewake?.game?.isReady === true, null, { timeout: 120000 });
    await sleep(2500);
    const seen = await mp1.evaluate(() => (window as any).tidewake.game.session.remotePlayers().length);
    console.log('multiplayer: client 1 sees', seen, 'other player(s)');
    if (seen < 1) errors.push('multiplayer: remote player not visible');
    // face the other player
    await mp2.evaluate(() => {
      const g = (window as any).tidewake.game;
      const me = g.session.viewPosition();
      const o = g.session.remotePlayers()[0];
      if (o) { g.yaw = Math.atan2(-(o.x - me.x), -(o.z - me.z)); g.pitch = -0.1; }
    });
    await sleep(1200);
    await mp2.screenshot({ path: path.join(OUT, '09-multiplayer.png') });
    console.log('multiplayer ok');
  } finally {
    await browser.close();
    server.kill('SIGINT');
    await sleep(800);
    if (!process.argv.includes('--keep')) rmSync(SAVES, { recursive: true, force: true });
  }
  if (errors.length) {
    console.error(`\n${errors.length} browser error(s):\n${errors.slice(0, 30).join('\n')}`);
    process.exit(1);
  }
  console.log('\nE2E SMOKE PASSED — screenshots in', OUT);
}

main().catch((e) => { console.error(e); process.exit(1); });
