/**
 * Visual QA: renders scripted scenes in headless Chromium and saves screenshots.
 *   npx tsx tools/shot.ts [scene ...]   (scenes: day dusk night storm underwater base fire beach)
 * Requires `npm run build` first. Uses host cheat commands on a fresh world.
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const PORT = 7793;
const OUT = path.resolve('screenshots');
const SAVES = path.resolve('.shot-saves');
mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Step = { cmd?: string; yaw?: number; pitch?: number; wait?: number; eval?: string; hold?: string; holdMs?: number };
const PEAK = `(async()=>{ const gen=g.session.gen; let best={x:0,z:0,h:-1}; for (let x=-200;x<=200;x+=6) for (let z=-200;z<=200;z+=6) { const h=gen.heightAt(x,z); if (h>best.h) best={x,z,h}; } await g.act({a:'chat',text:'/tp '+best.x+' '+best.z}); })()`;
const SCENES: Record<string, Step[]> = {
  vista: [{ cmd: '/time 9.5' }, { eval: PEAK }, { wait: 2500 }, { yaw: 2.3, pitch: -0.12, wait: 3500 }],
  golden: [{ cmd: '/time 17.2' }, { eval: PEAK }, { wait: 2500 }, { yaw: -1.6, pitch: -0.08, wait: 3500 }],
  animals: [{ cmd: '/time 10' }, { eval: 'g.yaw=0; g.pitch=-0.14' }, { wait: 600 }, { cmd: '/spawn boar 1' }, { cmd: '/spawn crab 2' }, { wait: 700 }, { eval: 'console.log("UW", JSON.stringify(g.session.viewPosition()), g.yaw, JSON.stringify(g.session.creatures().map(c=>[c.k,c.x|0,c.z|0,c.m])))' }],
  day: [{ cmd: '/time 10' }, { yaw: 0.6, pitch: 0.02, wait: 2500 }],
  beach: [{ cmd: '/time 15' }, { yaw: 2.6, pitch: -0.08, wait: 2500 }],
  dusk: [{ cmd: '/time 18.3' }, { yaw: -1.4, pitch: 0.05, wait: 3000 }],
  night: [{ cmd: '/time 23' }, { cmd: '/give torch' }, { eval: 'g.session.me && g.act({a:"hotbar", index: g.session.me.inventory.slots.findIndex(s=>s&&s.id==="torch")})' }, { yaw: 0.5, pitch: -0.05, wait: 3000 }],
  storm: [{ cmd: '/time 14' }, { cmd: '/weather storm' }, { yaw: 2.6, pitch: 0.0, wait: 4000 }],
  underwater: [{ cmd: '/time 12' }, { eval: `(async()=>{ const gen=g.session.gen; for (let r=60;r<400;r+=5) for (let a=0;a<6.28;a+=0.1) { const x=Math.cos(a)*r, z=Math.sin(a)*r, h=gen.heightAt(x,z); if (h<-5&&h>-8&&gen.heightAt(x,z+12)>-6) { await g.act({a:'chat',text:'/tp '+x.toFixed(1)+' '+z.toFixed(1)}); return; } } })()` }, { wait: 1500 }, { eval: 'g.yaw=0; g.pitch=-0.25' }, { hold: 'KeyC', holdMs: 14000 }, { eval: 'console.log("UW", g.session.pred.y.toFixed(2), g.session.pred.underwater)' }, { wait: 800 }],
  fire: [{ cmd: '/time 20' }, { cmd: '/give stick 10' }, { cmd: '/give stone 10' }, { cmd: '/give log 4' }, { cmd: '/give torch' },
    { eval: `(async()=>{ const s=g.session; const p=s.viewPosition(); const fx=p.x-Math.sin(g.yaw)*2.5, fz=p.z-Math.cos(g.yaw)*2.5; await g.act({a:'build',structure:'campfire',x:fx,y:s.gen.heightAt(fx,fz),z:fz,yaw:0}); const st=Object.values(s.structures)[0]; if(!st) return; await g.act({a:'interact',kind:'structure',id:st.id,verb:'open'}); const li=s.me.inventory.slots.findIndex(x=>x&&x.id==='log'); await g.act({a:'move',from:{c:'inv',i:li},to:{c:'box',id:st.containerId,i:0}}); await g.act({a:'close_container'}); await g.act({a:'ignite',id:st.id}); })()` },
    { pitch: -0.25, wait: 4000 }],
  base: [{ cmd: '/time 16' }, { eval: `(async()=>{ const gen=g.session.gen; for (let r=30;r<220;r+=4) for (let a=0;a<6.28;a+=0.15) { const x=Math.cos(a)*r, z=Math.sin(a)*r, h=gen.heightAt(x,z); if (h<3||h>10) continue; let ok=true; for (const [dx,dz] of [[-6,-6],[6,-6],[-6,6],[6,6],[0,-9],[0,9]]) if (Math.abs(gen.heightAt(x+dx,z+dz)-h)>0.9) ok=false; if (ok && !g.session.col.solidNodeNear(x,z-5,6)) { await g.act({a:'chat',text:'/tp '+x+' '+(z+3)}); return; } } })()` }, { wait: 1500 }, { yaw: 0, pitch: -0.05 }, { cmd: '/give plank 80' }, { cmd: '/give rope 60' }, { cmd: '/give build_hammer' },
    { eval: `(async()=>{ const s=g.session; await g.act({a:'hotbar',index:s.me.inventory.slots.findIndex(x=>x&&x.id==='build_hammer')}); const p=s.viewPosition(); const ctx={structures:s.structures,col:s.col,gen:s.gen,waterLevel:s.waterLevel}; const {computePlacement}=window.__tw; let f=computePlacement(ctx,'wood_foundation',{x:p.x-Math.sin(g.yaw)*5,y:p.y,z:p.z-Math.cos(g.yaw)*5},0); await g.act({a:'build',structure:'wood_foundation',x:f.x,y:f.y,z:f.z,yaw:f.yaw}); const fd=Object.values(s.structures).find(x=>x.type==='wood_foundation'); if(!fd) return; for (const [lx,lz] of [[0,1.4],[1.4,0],[-1.4,0]]) { const w=computePlacement(ctx,'wood_wall',{x:fd.x+lx,y:fd.y+1,z:fd.z+lz},0); await g.act({a:'build',structure:'wood_wall',x:w.x,y:w.y,z:w.z,yaw:w.yaw}); } const d=computePlacement(ctx,'wood_doorway',{x:fd.x,y:fd.y+1,z:fd.z-1.4},0); await g.act({a:'build',structure:'wood_doorway',x:d.x,y:d.y,z:d.z,yaw:d.yaw}); const r=computePlacement(ctx,'wood_roof',{x:fd.x,y:fd.y+3.4,z:fd.z},0); await g.act({a:'build',structure:'wood_roof',x:r.x,y:r.y,z:r.z,yaw:r.yaw}); })()` },
    { pitch: -0.1, wait: 3500 }],
};

async function main() {
  const scenes = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const list = scenes.length ? scenes : ['day', 'vista', 'golden', 'dusk', 'night', 'storm', 'underwater', 'fire', 'base'];
  rmSync(SAVES, { recursive: true, force: true });
  const server = spawn(path.resolve('node_modules/.bin/tsx'), ['src/server/main.ts', '--serve-client', '--port', String(PORT), '--save-dir', SAVES, '--exit-with-parent'], { stdio: ['pipe', 'ignore', 'ignore'], detached: true });
  const kill = () => { try { process.kill(-server.pid!, 'SIGKILL'); } catch { /* gone */ } };
  process.on('exit', kill);
  await sleep(4000);
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const errors: string[] = [];
  try {
    for (const name of list) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      page.on('pageerror', (e) => errors.push(`[${name}] ${e.message}`));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${name}] ${m.text()}`); if (m.text().startsWith('UW')) console.log(m.text()); });
      await page.goto(`http://localhost:${PORT}/?autostart=1&cheats=1&seed=4242`);
      await page.waitForFunction(() => (window as any).tidewake?.game?.isReady === true, null, { timeout: 120000 });
      for (const st of SCENES[name] ?? []) {
        if (st.cmd) await page.evaluate((c) => (window as any).tidewake.game.act({ a: 'chat', text: c }), st.cmd);
        if (st.hold) { await page.keyboard.down(st.hold); await sleep(st.holdMs ?? 1000); await page.keyboard.up(st.hold); }
        if (st.eval) await page.evaluate(`(async () => { const g = window.tidewake.game; return ${st.eval}; })()`);
        if (st.yaw !== undefined || st.pitch !== undefined) await page.evaluate(([y, p]) => { const g = (window as any).tidewake.game; if (y !== null) g.yaw = y; if (p !== null) g.pitch = p; }, [st.yaw ?? null, st.pitch ?? null]);
        await sleep(st.wait ?? 400);
      }
      await page.screenshot({ path: path.join(OUT, `scene-${name}.png`) });
      console.log('shot', name);
      await Promise.race([page.goto('about:blank'), sleep(10000)]);
    }
  } finally {
    await browser.close().catch(() => {});
    kill();
  }
  if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
