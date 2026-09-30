// Scheduled fluid updates. meta: 0 = source, 1..7 = flow distance,
// 8 = falling. Water spreads 7 blocks every 5 ticks; lava 3 blocks every 30.
import { B, SOLID, isLiquid, REPLACEABLE, BLOCKS } from './blocks.js';

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export class Fluids {
  constructor(game) {
    this.game = game;
    this.pending = new Map();
  }

  clear() { this.pending.clear(); }

  schedule(x, y, z, tick) {
    const w = this.game.world;
    const id = w.getBlock(x, y, z);
    if (!isLiquid(id)) return;
    const k = `${x},${y},${z}`;
    if (this.pending.has(k)) return;
    const delay = id === B.water ? 5 : 30;
    this.pending.set(k, { x, y, z, due: tick + delay });
  }

  tick(tick) {
    if (!this.pending.size) return;
    let budget = 600;
    const due = [];
    for (const [k, e] of this.pending) {
      if (e.due <= tick) { due.push(e); this.pending.delete(k); if (--budget <= 0) break; }
    }
    for (const e of due) this.update(e.x, e.y, e.z, tick);
  }

  // Can a fluid flow into this block (air, or a passable non-liquid block)?
  static open(id) { return id === 0 || (!SOLID[id] && !isLiquid(id) && id !== B.ladder) || (REPLACEABLE[id] && !isLiquid(id)); }

  flowInto(x, y, z, fluid, meta) {
    const g = this.game, w = g.world;
    const cur = w.getBlock(x, y, z);
    if (cur && !isLiquid(cur)) g.breakNaturally(x, y, z, true);
    w.setBlock(x, y, z, fluid, meta, { urgent: false });
  }

  update(x, y, z, tick) {
    const g = this.game, w = g.world;
    const id = w.getBlock(x, y, z);
    if (!isLiquid(id)) return;
    const water = id === B.water;
    const other = water ? B.lava : B.water;
    const drop = water ? 1 : 2;
    let m = w.getMeta(x, y, z);
    let source = (m & 15) === 0;

    // Lava touching water hardens.
    if (!water) {
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
        if (w.getBlock(x + dx, y + dy, z + dz) === B.water) {
          w.setBlock(x, y, z, source ? B.obsidian : B.cobblestone, 0);
          g.audio.play('fizz', x + 0.5, y + 0.5, z + 0.5);
          for (let i = 0; i < 6; i++) g.particles.smoke(x + Math.random(), y + 1, z + Math.random());
          return;
        }
      }
    }

    if (!source) {
      let newMeta;
      const above = w.getBlock(x, y + 1, z);
      if (above === id) newMeta = 8;
      else {
        let minLevel = 99, sources = 0;
        for (const [dx, dz] of DIRS) {
          if (w.getBlock(x + dx, y, z + dz) !== id) continue;
          const nm = w.getMeta(x + dx, y, z + dz);
          let eff;
          if ((nm & 15) === 0) { sources++; eff = 0; } else if (nm & 8) eff = 0; else eff = nm & 7;
          if (eff < minLevel) minLevel = eff;
        }
        const below = w.getBlock(x, y - 1, z);
        if (water && sources >= 2 && (SOLID[below] || (below === id && (w.getMeta(x, y - 1, z) & 15) === 0))) newMeta = 0;
        else if (minLevel + drop <= 7) newMeta = minLevel + drop;
        else newMeta = -1;
      }
      if (newMeta === -1) { w.setBlock(x, y, z, 0, 0, { urgent: false }); return; }
      if (newMeta !== m) {
        w.setBlock(x, y, z, id, newMeta, { urgent: false });
        m = newMeta; source = newMeta === 0;
      }
    }

    // Flow down first.
    const bid = w.getBlock(x, y - 1, z);
    if (y > 0 && bid === other) {
      // falling onto the other fluid
      if (water) w.setBlock(x, y - 1, z, (w.getMeta(x, y - 1, z) & 15) === 0 ? B.obsidian : B.cobblestone, 0);
      else w.setBlock(x, y - 1, z, B.stone, 0);
      g.audio.play('fizz', x + 0.5, y, z + 0.5);
      return;
    }
    if (y > 0 && (Fluids.open(bid) || (bid === id && (w.getMeta(x, y - 1, z) & 15) !== 0 && !(w.getMeta(x, y - 1, z) & 8)))) {
      this.flowInto(x, y - 1, z, id, 8);
      if (!source) return;
    }
    if (bid === id && !source) return;
    // Then spread sideways on solid ground (or from a source).
    const eff = source || (m & 8) ? 0 : m & 7;
    const nl = eff + drop;
    if (nl > 7) return;
    for (const [dx, dz] of DIRS) {
      const nx = x + dx, nz = z + dz;
      const nid = w.getBlock(nx, y, nz);
      if (nid === other) {
        if (water) {
          w.setBlock(nx, y, nz, (w.getMeta(nx, y, nz) & 15) === 0 ? B.obsidian : B.cobblestone, 0);
          g.audio.play('fizz', nx + 0.5, y + 0.5, nz + 0.5);
        }
        continue;
      }
      if (Fluids.open(nid)) {
        if (!w.chunkReady(nx >> 4, nz >> 4)) continue;
        this.flowInto(nx, y, nz, id, nl);
      } else if (nid === id) {
        const nm = w.getMeta(nx, y, nz);
        if ((nm & 15) !== 0 && !(nm & 8) && (nm & 7) > nl) w.setBlock(nx, y, nz, id, nl, { urgent: false });
      }
    }
  }
}

export const isFlowBlocking = (id) => SOLID[id] || (BLOCKS[id] && isLiquid(id));
