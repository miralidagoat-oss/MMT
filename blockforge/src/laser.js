// Laser bolts (Projectile kind 'laser'): their trail, impacts and what they
// do to blocks. Kept free of entity imports so entities.js can use it.
import { B } from './blocks.js';

export const LASER_COLOR = [0.35, 0.95, 1.0];
let shatterSet = null;

// Called from Projectile.tick, hitEntity and hitBlock.
export function laserTrail(p, game) {
  if (p.age % 2 === 0) game.particles.laser(p.x - p.vx * 0.5, p.y - p.vy * 0.5, p.z - p.vz * 0.5, 0.2);
  if (p.inWater) {
    p.removed = true;
    game.particles.bubble(p.x, p.y, p.z); game.particles.bubble(p.x, p.y, p.z);
    game.audio.play('fizz', p.x, p.y, p.z, 0.4);
  }
}

export function laserImpact(game, x, y, z, nx = 0, ny = 0, nz = 0) {
  for (let i = 0; i < 9; i++) game.particles.laser(x, y, z, 1, nx, ny, nz);
  game.audio.play('laser_hit', x, y, z, 0.6);
  if (game.net) game.net.effect('lz', x, y, z);
}

export function laserHitBlock(p, game, hit) {
  const w = game.world;
  shatterSet = shatterSet || new Set([B.glass, B.glass_pane, B.ice, B.lamp]);
  const n = hit.face !== undefined ? [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]][hit.face] || [0, 0, 0] : [0, 0, 0];
  laserImpact(game, p.x, p.y, p.z, n[0], n[1], n[2]);
  if (hit.id === B.tnt && !(game.net && game.net.isGuest)) {
    game.primeCrate(hit.x, hit.y, hit.z);
  } else if (shatterSet.has(hit.id) && !(game.net && game.net.isGuest)) {
    game.audio.play('glass_break', hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
    game.particles.blockBreak(hit.x, hit.y, hit.z, hit.id, w.getMeta(hit.x, hit.y, hit.z));
    w.setBlock(hit.x, hit.y, hit.z, hit.id === B.ice ? B.water : 0, 0);
  } else if (Math.random() < 0.35) {
    game.particles.smoke(p.x, p.y, p.z);
  }
}

