/**
 * Server performance profile: 4 players moving around the start island with
 * structures and creatures active. Reports tick cost, bandwidth and memory.
 *   npx tsx tools/profile-sim.ts [ticks]
 */
import { Simulation } from '../src/shared/sim/simulation';
import { GameHost } from '../src/shared/net/host';
import { encode } from '../src/shared/net/codec';
import { SIM } from '../src/shared/config';
import type { ServerMsg } from '../src/shared/net/protocol';

const TICKS = Number(process.argv[2] ?? 2400);
const sim = new Simulation({ seed: 'profile', name: 'Profile' });
const host = new GameHost(sim, { log: () => {} });
const bytes = new Map<number, { snap: number; other: number; msgs: number }>();
const peers = [0, 1, 2, 3].map((i) => {
  const stat = { snap: 0, other: 0, msgs: 0 };
  const peer = host.connect((m: ServerMsg) => {
    const n = encode(m).byteLength;
    stat.msgs++;
    if (m.t === 'snap') stat.snap += n; else stat.other += n;
  }, () => {});
  bytes.set(peer.id, stat);
  host.handle(peer, { t: 'hello', protocol: 3, name: `Bot${i}`, token: `profile-bot-${i}-xx` });
  return peer;
});
const players = Object.values(sim.world.players);
// spread players around the island and give them a base each
players.forEach((p, i) => {
  const a = (i / 4) * Math.PI * 2;
  for (let r = 60; r < 260; r += 4) {
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (sim.gen.heightAt(x, z) > 0.5 && sim.gen.heightAt(x, z) < 3) { p.pos = { x, y: sim.gen.heightAt(x, z), z }; break; }
  }
});
for (const b of bytes.values()) { b.snap = 0; b.other = 0; b.msgs = 0; }

const times: number[] = [];
let seq = 1;
const t0 = performance.now();
for (let t = 0; t < TICKS; t++) {
  players.forEach((p, i) => {
    const yaw = Math.sin(t * 0.01 + i) * 3;
    const frames = [0, 1, 2].map(() => ({ seq: seq++, mx: 0, mz: 1, yaw, pitch: 0, jump: t % 90 === 0, sprint: i % 2 === 0, crouch: false }));
    host.handle(peers[i]!, { t: 'input', frames });
    if (t % 40 === i) host.handle(peers[i]!, { t: 'act', id: t * 10 + i, action: { a: 'use', yaw, pitch: 0 } });
    p.hunger = 80; p.thirst = 80; p.health = 100;
  });
  const s = performance.now();
  host.step();
  times.push(performance.now() - s);
}
const total = performance.now() - t0;
times.sort((a, b) => a - b);
const avg = times.reduce((a, b) => a + b, 0) / times.length;
const p99 = times[Math.floor(times.length * 0.99)]!;
const secs = TICKS / SIM.tickRate;
const mem = process.memoryUsage();
const active = Object.values(sim.world.creatures).filter((c) => players.some((p) => Math.hypot(p.pos.x - c.x, p.pos.z - c.z) < SIM.creatureActiveRadius)).length;
console.log(`ticks ${TICKS} (${secs.toFixed(0)} s simulated) in ${(total / 1000).toFixed(2)} s wall`);
console.log(`tick avg ${avg.toFixed(3)} ms · p99 ${p99.toFixed(3)} ms · max ${times[times.length - 1]!.toFixed(2)} ms · budget ${(1000 / SIM.tickRate).toFixed(0)} ms`);
console.log(`creatures ${Object.keys(sim.world.creatures).length} (active near players ${active}) · structures ${Object.keys(sim.world.structures).length}`);
for (const [id, b] of bytes) console.log(`peer ${id}: snapshots ${(b.snap / secs / 1024).toFixed(2)} KiB/s · reliable ${(b.other / secs / 1024).toFixed(2)} KiB/s · ${(b.msgs / secs).toFixed(1)} msg/s`);
console.log(`heap ${(mem.heapUsed / 1048576).toFixed(1)} MiB · rss ${(mem.rss / 1048576).toFixed(1)} MiB`);
