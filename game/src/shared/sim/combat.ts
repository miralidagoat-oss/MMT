/** Projectiles (arrows) and melee hit resolution helpers. */
import { ITEMS } from '../defs/items';
import { CREATURES } from '../defs/creatures';
import type { Simulation } from './simulation';
import { damageCreature } from './wildlife';
import { applyDamage } from './survival';

const GRAVITY = 9.8;

export function fireProjectile(sim: Simulation, ownerId: string, x: number, y: number, z: number, yaw: number, pitch: number, speed: number, damage: number, item: string): void {
  const cp = Math.cos(pitch);
  const id = sim.newId('pr');
  sim.projectiles.set(id, {
    id, owner: ownerId, x, y, z,
    vx: -Math.sin(yaw) * cp * speed, vy: Math.sin(pitch) * speed, vz: -Math.cos(yaw) * cp * speed,
    damage, dieAt: sim.now + 4, item,
  });
}

export function tickProjectiles(sim: Simulation, dt: number): void {
  for (const pr of sim.projectiles.values()) {
    const steps = 3;
    let hit = false;
    for (let s = 0; s < steps && !hit; s++) {
      const h = dt / steps;
      pr.vy -= GRAVITY * h;
      const inWater = pr.y < sim.waterLevel(pr.x, pr.z);
      const drag = inWater ? Math.exp(-6 * h) : 1;
      pr.vx *= drag; pr.vy *= drag; pr.vz *= drag;
      pr.x += pr.vx * h; pr.y += pr.vy * h; pr.z += pr.vz * h;
      // creatures
      for (const c of Object.values(sim.world.creatures)) {
        if (c.mode === 'dead') continue;
        const r = CREATURES[c.kind].radius + 0.25;
        if (Math.abs(c.x - pr.x) > 3 || Math.abs(c.z - pr.z) > 3) continue;
        if (Math.hypot(c.x - pr.x, c.y + r * 0.6 - pr.y, c.z - pr.z) < r + 0.2) {
          damageCreature(sim, c, pr.damage, pr.owner, 0.4);
          hit = true;
          break;
        }
      }
      if (!hit && sim.world.settings.friendlyFire) {
        for (const p of Object.values(sim.world.players)) {
          if (p.id === pr.owner || !p.connected || p.dead) continue;
          if (Math.hypot(p.pos.x - pr.x, p.pos.y + 1 - pr.y, p.pos.z - pr.z) < 0.6) { applyDamage(sim, p, pr.damage, 'arrow', pr.owner); hit = true; break; }
        }
      }
      const ground = sim.gen.heightAt(pr.x, pr.z);
      if (!hit && (pr.y <= ground || sim.col.raycastStructures(pr.x, pr.y, pr.z, 0, -1, 0, 0.05))) {
        hit = true;
        // arrows can be recovered sometimes
        if (sim.rng.chance(0.55)) sim.spawnItem({ id: pr.item, qty: 1 }, pr.x, Math.max(ground, pr.y), pr.z);
      }
    }
    if (hit || sim.now > pr.dieAt) {
      sim.projectiles.delete(pr.id);
      sim.fx('arrow_hit', pr.x, pr.y, pr.z);
    }
  }
}

export function isWeapon(id: string | undefined): boolean {
  if (!id) return false;
  const t = ITEMS[id]?.tool;
  return !!t && (t.damage ?? 0) > 0;
}
