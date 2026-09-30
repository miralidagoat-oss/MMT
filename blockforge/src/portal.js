// Rift portals between the overworld and the underworld. A rectangular
// obsidian frame (interior 2x3 up to 21x21) lit with flint and steel fills
// with rift blocks; standing in them carries you across, 8:1 horizontally.
import { B, REPLACEABLE, isLiquid, OPAQUE, SOLID } from './blocks.js';
import { HEIGHT } from './constants.js';

const OBS = B.obsidian, RIFT = B.rift;
const interior = (id) => id === 0 || id === RIFT || (REPLACEABLE[id] && !isLiquid(id)) || id === B.torch;

export function tryLightPortal(world, x, y, z) {
  for (const axis of [0, 1]) {
    const dx = axis === 0 ? 1 : 0, dz = axis === 0 ? 0 : 1;
    if (!interior(world.getBlock(x, y, z))) return false;
    let by = y, guard = 0;
    while (interior(world.getBlock(x, by - 1, z)) && guard++ < 21) by--;
    if (world.getBlock(x, by - 1, z) !== OBS) continue;
    let lx = x, lz = z;
    guard = 0;
    while (interior(world.getBlock(lx - dx, by, lz - dz)) && guard++ < 21) { lx -= dx; lz -= dz; }
    if (world.getBlock(lx - dx, by, lz - dz) !== OBS) continue;
    let w = 0;
    while (w < 22 && interior(world.getBlock(lx + dx * w, by, lz + dz * w))) w++;
    if (w < 2 || w > 21 || world.getBlock(lx + dx * w, by, lz + dz * w) !== OBS) continue;
    let h = 0;
    while (h < 22 && interior(world.getBlock(lx, by + h, lz))) h++;
    if (h < 3 || h > 21) continue;
    let ok = true;
    for (let i = 0; i < w && ok; i++) {
      if (world.getBlock(lx + dx * i, by - 1, lz + dz * i) !== OBS || world.getBlock(lx + dx * i, by + h, lz + dz * i) !== OBS) ok = false;
      for (let j = 0; j < h && ok; j++) if (!interior(world.getBlock(lx + dx * i, by + j, lz + dz * i))) ok = false;
    }
    for (let j = 0; j < h && ok; j++) {
      if (world.getBlock(lx - dx, by + j, lz - dz) !== OBS || world.getBlock(lx + dx * w, by + j, lz + dz * w) !== OBS) ok = false;
    }
    if (!ok) continue;
    for (let i = 0; i < w; i++) for (let j = 0; j < h; j++) world.setBlock(lx + dx * i, by + j, lz + dz * i, RIFT, axis, { notify: false });
    return true;
  }
  return false;
}

// A rift block needs rift or obsidian on all four in-plane sides.
export function riftValid(world, x, y, z) {
  const axis = world.getMeta(x, y, z) & 1;
  const dx = axis === 0 ? 1 : 0, dz = axis === 0 ? 0 : 1;
  for (const [ox, oy, oz] of [[0, 1, 0], [0, -1, 0], [dx, 0, dz], [-dx, 0, -dz]]) {
    const id = world.getBlock(x + ox, y + oy, z + oz);
    if (id !== RIFT && id !== OBS) return false;
  }
  return true;
}

// Nearest existing rift block around a point (bottom cell of its column).
export function findRift(world, x, z, radius, maxY) {
  let best = null, bd = Infinity;
  const x0 = Math.floor(x), z0 = Math.floor(z);
  for (let dz = -radius; dz <= radius; dz++) for (let dx = -radius; dx <= radius; dx++) {
    const d = dx * dx + dz * dz;
    if (d >= bd) continue;
    for (let y = 1; y < maxY; y++) {
      if (world.getBlock(x0 + dx, y, z0 + dz) === RIFT && world.getBlock(x0 + dx, y - 1, z0 + dz) !== RIFT) {
        best = [x0 + dx, y, z0 + dz]; bd = d; break;
      }
    }
  }
  return best;
}

// Build a 4x5 portal near (x, y, z), preferring solid ground with headroom.
export function buildPortal(world, x, y, z, minY, maxY) {
  const x0 = Math.floor(x), z0 = Math.floor(z);
  let spot = null;
  const fits = (px, py, pz) => {
    for (let i = -1; i <= 2; i++) {
      if (!OPAQUE[world.getBlock(px + i, py - 1, pz)]) return false;
      for (let j = 0; j < 4; j++) {
        const id = world.getBlock(px + i, py + j, pz);
        if (SOLID[id] || isLiquid(id)) return false;
      }
    }
    // room to step out on one side, and no lava pouring in from either side
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) if (SOLID[world.getBlock(px + i, py + j, pz + 1)]) return false;
    for (let i = -1; i <= 2; i++) for (let j = -1; j <= 4; j++) for (const dz of [-1, 1]) if (isLiquid(world.getBlock(px + i, py + j, pz + dz))) return false;
    if (!SOLID[world.getBlock(px, py - 1, pz + 1)] || !SOLID[world.getBlock(px + 1, py - 1, pz + 1)]) return false;
    return true;
  };
  const yc = Math.max(minY, Math.min(maxY, Math.floor(y)));
  outer: for (let r = 0; r <= 16; r++) {
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      for (let k = 0; k < maxY - minY; k++) {
        const py = k % 2 === 0 ? yc + (k >> 1) : yc - ((k + 1) >> 1);
        if (py < minY || py > maxY) continue;
        if (fits(x0 + dx, py, z0 + dz)) { spot = [x0 + dx, py, z0 + dz]; break outer; }
      }
    }
  }
  const forced = !spot;
  if (!spot) spot = [x0, yc, z0];
  const [px, py, pz] = spot;
  if (forced) {
    // carve a small room with an obsidian platform
    for (let i = -2; i <= 3; i++) for (let k = -1; k <= 1; k++) {
      world.setBlock(px + i, py - 1, pz + k, OBS, 0, { notify: false });
      for (let j = 0; j < 4; j++) world.setBlock(px + i, py + j, pz + k, 0, 0, { notify: false });
    }
  }
  for (let i = -1; i <= 2; i++) for (let j = -1; j <= 3; j++) {
    const edge = i === -1 || i === 2 || j === -1 || j === 3;
    world.setBlock(px + i, py + j, pz, edge ? OBS : RIFT, edge ? 0 : 0, { notify: false });
  }
  return [px + 1, py, pz + 0.5];
}

export const portalLimits = (dim) => (dim === 'underworld' ? [32, 110] : [2, HEIGHT - 10]);
