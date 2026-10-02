// Gameplay for the fifth wave, mixed into Game: bee nests and honey, berry
// bushes, the composter, lectern, crafter, grindstone and smithing table,
// dyes, the new animals' world hooks and treasure-seeking dolphins.
import { B, BLOCKS, SOLID, REPLACEABLE, isLiquid, OPAQUE, TEX } from './blocks.js';
import { ITEMS, I, maxStack, matchRecipe } from './items.js';
import { Mob } from './entities.js';
import { HIVE_IDS, hiveFront, angerBees, catGifts } from './wildlife.js';
import { COMPOST_CHANCE } from './workshop.js';
import { boxFree } from './physics.js';
import { LANDMARKS } from './landmarks.js';

const K = (x, y, z) => `${x},${y},${z}`;
const FACE_DIR = [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
export const LECTERN_PAGES = 10;

// How many pages a lectern's book has (blank books count ten).
export function lecternPages(be) {
  const b = be && be.book;
  return b && b.id === I.written_journal && Array.isArray(b.pages) && b.pages.length ? b.pages.length : LECTERN_PAGES;
}
export function newCrafter() { return { type: 'crafter', slots: new Array(9).fill(null), off: new Array(9).fill(false) }; }

export function installFeatures5(Game) {
  Object.assign(Game.prototype, methods);
}

// A fire beneath a hive (within five blocks) keeps its bees calm.
function calmed(w, x, y, z) {
  for (let d = 1; d <= 5; d++) {
    const id = w.getBlock(x, y - d, z);
    if (id === B.fire || id === B.lava || id === B.furnace_lit) return true;
    if (id && id !== B.fire && OPAQUE[id]) return false;
  }
  return false;
}

const methods = {
  isInteractive5(hit) {
    const id = hit.id;
    if (id === B.grindstone || id === B.smithing_table || id === B.composter || id === B.lectern || id === B.crafter) return true;
    if (id === B.berry_bush) return (this.world.getMeta(hit.x, hit.y, hit.z) & 3) >= 2;
    if (HIVE_IDS().includes(id)) {
      const held = this.player.inventory.held;
      return !!held && (held.id === I.glass_bottle || held.id === I.shears);
    }
    return false;
  },

  // Right-click on the new blocks; true when handled.
  useBlock5(hit, held) {
    const w = this.world, p = this.player;
    const key = K(hit.x, hit.y, hit.z);
    switch (hit.id) {
      case B.grindstone: this.ui.openScreen('grindstone', { x: hit.x, y: hit.y, z: hit.z }); return true;
      case B.smithing_table: this.ui.openScreen('smithing', { x: hit.x, y: hit.y, z: hit.z }); return true;
      case B.crafter:
        if (!w.blockEntities.has(key)) w.blockEntities.set(key, newCrafter());
        this.ui.openScreen('crafter', { key, be: w.blockEntities.get(key), x: hit.x, y: hit.y, z: hit.z });
        return true;
      case B.berry_bush: {
        const m = w.getMeta(hit.x, hit.y, hit.z) & 3;
        if (m < 2) return false;
        this.dropItem(hit.x + 0.5, hit.y + 0.6, hit.z + 0.5, { id: I.sweet_berries, count: 1 + Math.floor(Math.random() * 2) + (m === 3 ? 1 : 0) });
        w.setBlock(hit.x, hit.y, hit.z, B.berry_bush, 1);
        this.audio.play('pick', hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, 0.6);
        return true;
      }
      case B.composter: return this.useComposter(hit, held);
      case B.lectern: return this.useLectern(hit, held);
      case B.bee_nest: case B.beehive: return this.harvestHive(hit, held);
      case B.oak_fence: return this.useFence(hit, held);
      default: return false;
    }
  },

  // Item uses aimed at blocks that come before placement (useItemFirst).
  useItem5(held, hit) {
    const w = this.world, p = this.player;
    // a goat horn sounds its call (then needs a breather)
    if (held.id === I.goat_horn) {
      if ((this.hornReady || 0) > this.tickCount) return true;
      this.hornReady = this.tickCount + 140;
      this.audio.play('goat_horn' + ((held.horn | 0) & 3), p.x, p.y + 1.5, p.z);
      this.startSwing();
      return true;
    }
    // journals are written in, or read
    if (held.id === I.journal || held.id === I.written_journal) {
      this.ui.openBook({ stack: held, slot: p.inventory.selected, edit: held.id === I.journal });
      return true;
    }
    if (!hit) return false;
    const def = ITEMS[held.id];
    // berries are planted on soil
    if (def && def.plantsOn && hit.face === 0) {
      const id = B[def.plantsOn];
      if (!w.getBlock(hit.x, hit.y + 1, hit.z) && this.canSurvive(id, 0, hit.x, hit.y + 1, hit.z)) {
        w.setBlock(hit.x, hit.y + 1, hit.z, id, 0);
        this.audio.blockSound(B.grass, 'place', hit.x + 0.5, hit.y + 1, hit.z + 0.5);
        if (!p.creative) p.inventory.useHeld();
        this.startSwing();
        return true;
      }
    }
    return false;
  },

  // ---------------------------------------------------------------------------
  harvestHive(hit, held) {
    const w = this.world, p = this.player;
    const meta = w.getMeta(hit.x, hit.y, hit.z);
    if ((meta >> 3) < 5 || !held) return false;
    if (held.id === I.glass_bottle) {
      if (!p.creative) {
        if (held.count > 1) { held.count--; if (p.inventory.give({ id: I.honey_bottle, count: 1 })) this.dropItem(p.x, p.y + 1, p.z, { id: I.honey_bottle, count: 1 }); }
        else this.replaceHeld({ id: I.honey_bottle, count: 1 });
      }
      this.audio.play('fill_bottle', hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
    } else if (held.id === I.shears) {
      this.dropItem(hit.x + 0.5, hit.y + 1, hit.z + 0.5, { id: I.honeycomb, count: 3 });
      this.damageTool(1);
      this.audio.play('shear', hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
    } else return false;
    w.setBlock(hit.x, hit.y, hit.z, hit.id, meta & 7);
    this.startSwing();
    this.advance('honey');
    if (!calmed(w, hit.x, hit.y, hit.z)) this.releaseBees(hit.x, hit.y, hit.z, true);
    return true;
  },

  // Let the bees out of a hive (all of them, angry, when it is disturbed).
  releaseBees(x, y, z, angry, all = true) {
    const w = this.world;
    const key = K(x, y, z);
    const be = w.blockEntities.get(key);
    const h = { x, y, z };
    if (be && be.type === 'hive') {
      const f = HIVE_IDS().includes(w.getBlock(x, y, z)) ? hiveFront(w, h) : h;
      const out = all ? be.bees.splice(0) : be.bees.splice(0, 1);
      for (const b of out) {
        const m = Mob.load(b.data);
        m.x = m.px = f.x + 0.5; m.y = m.py = f.y + 0.2; m.z = m.pz = f.z + 0.5;
        m.hive = HIVE_IDS().includes(w.getBlock(x, y, z)) ? h : null;
        m.outAt = 0;
        this.entities.push(m);
      }
    }
    if (angry) angerBees(this, h, this.player);
  },

  // ---------------------------------------------------------------------------
  useComposter(hit, held) {
    const w = this.world, p = this.player;
    const lvl = w.getMeta(hit.x, hit.y, hit.z) & 15;
    if (lvl >= 8) {
      w.setBlock(hit.x, hit.y, hit.z, B.composter, 0);
      this.dropItem(hit.x + 0.5, hit.y + 1.1, hit.z + 0.5, { id: I.bone_meal, count: 1 });
      this.audio.material('gravel', 'break', hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
      return true;
    }
    if (lvl >= 7 || !held) return lvl >= 7;
    const chance = COMPOST_CHANCE().get(held.id);
    if (chance === undefined) return false;
    if (!p.creative) p.inventory.useHeld();
    this.startSwing();
    this.composterAdd(hit.x, hit.y, hit.z, chance);
    return true;
  },

  composterAdd(x, y, z, chance) {
    const w = this.world;
    const lvl = w.getMeta(x, y, z) & 15;
    if (lvl >= 7) return false;
    const up = Math.random() < chance || lvl === 0;
    for (let i = 0; i < 6; i++) this.particles.add({ x: x + 0.2 + Math.random() * 0.6, y: y + 0.3 + lvl * 0.1, z: z + 0.2 + Math.random() * 0.6, vx: 0, vy: 0.5, vz: 0, size: 0.05, layer: this.texWhite, r: 0.4, g: 0.8, b: 0.3, life: 0.4, collide: false });
    this.audio.material('grass', 'place', x + 0.5, y + 0.5, z + 0.5);
    if (!up) return true;
    w.setBlock(x, y, z, B.composter, lvl + 1);
    if (lvl + 1 === 7) (this.compostReady || (this.compostReady = new Map())).set(K(x, y, z), this.tickCount + 20);
    return true;
  },

  // ---------------------------------------------------------------------------
  useLectern(hit, held) {
    const w = this.world, p = this.player;
    const key = K(hit.x, hit.y, hit.z);
    const meta = w.getMeta(hit.x, hit.y, hit.z);
    let be = w.blockEntities.get(key);
    if (!(meta & 4)) {
      if (!held || ![I.book, I.enchanted_book, I.journal, I.written_journal].includes(held.id)) return false;
      be = { type: 'lectern', book: { ...held, count: 1 }, page: 0 };
      w.blockEntities.set(key, be);
      w.setBlock(hit.x, hit.y, hit.z, B.lectern, meta | 4, { keepEntity: true });
      if (!p.creative) p.inventory.useHeld();
      this.audio.play('page', hit.x + 0.5, hit.y + 1, hit.z + 0.5);
      this.circuits.mark(hit.x, hit.y, hit.z);
      return true;
    }
    if (!be) { be = { type: 'lectern', book: { id: I.book, count: 1 }, page: 0 }; w.blockEntities.set(key, be); }
    if (!held) {
      // read it (and take it from the reader)
      this.ui.openBook({ stack: be.book || { id: I.book, count: 1 }, lectern: { key, be, x: hit.x, y: hit.y, z: hit.z }, edit: false });
      return true;
    }
    const pages = lecternPages(be);
    be.page = (be.page + 1) % pages;
    this.audio.play('page', hit.x + 0.5, hit.y + 1, hit.z + 0.5);
    this.ui.message(`Page ${be.page + 1} of ${pages} (use it with an empty hand to read)`, '#e8d8b0');
    this.circuits.mark(hit.x, hit.y, hit.z);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) this.circuits.mark(hit.x + dx, hit.y, hit.z + dz);
    if (this.net) this.net.blockEntityChanged(key);
    return true;
  },

  // ---------------------------------------------------------------------------
  // A crafter powered by a spark crafts its pattern once and pushes the result
  // out of its front.
  crafterCraft(x, y, z, face) {
    const w = this.world;
    const be = w.blockEntities.get(K(x, y, z));
    if (!be || be.type !== 'crafter') return;
    const grid = be.slots.map((s, i) => (s && !be.off[i] ? s.id : 0));
    const res = matchRecipe(grid, 3);
    const [dx, dy, dz] = FACE_DIR[face];
    const ox = x + dx, oy = y + dy, oz = z + dz;
    if (!res) { this.audio.play('click', x + 0.5, y + 0.5, z + 0.5, 0.4); return; }
    for (let i = 0; i < 9; i++) {
      const s = be.slots[i];
      if (!s || be.off[i]) continue;
      s.count--;
      if (s.count <= 0) be.slots[i] = s.id === I.water_bucket || s.id === I.lava_bucket || s.id === I.milk_bucket ? { id: I.bucket, count: 1 } : null;
    }
    const out = { id: res.id, count: res.count };
    // into a container in front, or out onto the ground
    const tbe = w.blockEntities.get(K(ox, oy, oz));
    if (tbe && tbe.slots && w.getBlock(ox, oy, oz) !== B.crafter) {
      for (let i = 0; i < tbe.slots.length && out.count > 0; i++) {
        const t = tbe.slots[i];
        if (!t) { tbe.slots[i] = { ...out }; out.count = 0; }
        else if (t.id === out.id && !t.ench && t.count < maxStack(t.id)) { const n = Math.min(out.count, maxStack(t.id) - t.count); t.count += n; out.count -= n; }
      }
    }
    if (out.count > 0) {
      const it = this.dropItem(x + 0.5 + dx * 0.7, y + 0.4 + dy * 0.7, z + 0.5 + dz * 0.7, out);
      if (it) { it.vx = dx * 0.12; it.vy = dy * 0.12 + 0.05; it.vz = dz * 0.12; }
    }
    this.audio.play('craft', x + 0.5, y + 0.5, z + 0.5, 0.7);
    for (let i = 0; i < 6; i++) this.particles.smoke(x + 0.5 + dx * 0.6, y + 0.5 + dy * 0.6, z + 0.5 + dz * 0.6);
    if (this.net) this.net.blockEntityChanged(K(x, y, z));
  },

  // Comparator readings for the new blocks (-1: not ours).
  measureBlock5(x, y, z, id) {
    const w = this.world;
    if (id === B.composter) return Math.min(8, w.getMeta(x, y, z) & 15);
    if (HIVE_IDS().includes(id)) return w.getMeta(x, y, z) >> 3;
    if (id === B.lectern) {
      const be = w.blockEntities.get(K(x, y, z));
      if (!be || !(w.getMeta(x, y, z) & 4)) return 0;
      const n = lecternPages(be);
      return n <= 1 ? 15 : 1 + Math.floor((Math.min(be.page, n - 1) / (n - 1)) * 14);
    }
    if (id === B.crafter) {
      const be = w.blockEntities.get(K(x, y, z));
      if (!be) return 0;
      let n = 0;
      for (let i = 0; i < 9; i++) if (be.slots[i] || be.off[i]) n++;
      return n;
    }
    return -1;
  },

  onBlockBroken5(x, y, z, id, meta, be) {
    if (HIVE_IDS().includes(id)) {
      const calm = calmed(this.world, x, y, z);
      if (be && be.type === 'hive') this.releaseBees(x, y, z, !calm);
      else if (!calm) angerBees(this, { x, y, z }, this.player);
      for (const e of this.entities) if (e.type === 'bee' && e.hive && e.hive.x === x && e.hive.y === y && e.hive.z === z) e.hive = null;
    }
    if (id === B.lectern && be && be.book) { this.dropItem(x + 0.5, y + 1, z + 0.5, be.book, true); be.book = null; }
    if (id === B.composter && (meta & 15) >= 8) this.dropItem(x + 0.5, y + 0.5, z + 0.5, { id: I.bone_meal, count: 1 }, true);
  },

  // ---------------------------------------------------------------------------
  tickFeatures5() {
    const w = this.world;
    if (this.compostReady && this.compostReady.size) {
      for (const [key, t] of this.compostReady) {
        if (this.tickCount < t) continue;
        this.compostReady.delete(key);
        const [x, y, z] = key.split(',').map(Number);
        if (w.getBlock(x, y, z) === B.composter && (w.getMeta(x, y, z) & 15) === 7) {
          w.setBlock(x, y, z, B.composter, 8);
          this.audio.material('gravel', 'place', x + 0.5, y + 0.5, z + 0.5);
        }
      }
    }
    if (this.tickCount % 20 === 0) this.tickHives();
    this.tickLeashes();
    if (this.tickCount % 200 === 77) this.spawnSeaLife();
  },

  // Bees come out of their hives in fine weather after a rest inside.
  tickHives() {
    const w = this.world;
    const day = this.isDay() && this.rain < 0.5 && this.dim === 'overworld';
    for (const [key, be] of w.blockEntities) {
      if (be.type !== 'hive') continue;
      const [x, y, z] = key.split(',').map(Number);
      if (!w.chunkReady(x >> 4, z >> 4)) continue;
      if (!HIVE_IDS().includes(w.getBlock(x, y, z))) { w.blockEntities.delete(key); continue; }
      if (!day || !be.bees.length) continue;
      if (Math.hypot(x - this.player.x, z - this.player.z) > 96) continue;
      const first = be.bees[0];
      if (this.tickCount - first.at < 600) continue;
      const f = hiveFront(w, { x, y, z });
      if (SOLID[w.getBlock(f.x, f.y, f.z)]) continue;
      this.releaseBees(x, y, z, false, false);
    }
  },

  // Dolphins ride the open sea near the player; squid drift in oceans and rivers.
  spawnSeaLife() {
    if (this.dim !== 'overworld' || (this.net && this.net.isGuest) || this.demo) return;
    const p = this.player, w = this.world;
    let near = 0, squid = 0;
    for (const e of this.entities) {
      if (Math.hypot(e.x - p.x, e.z - p.z) >= 80) continue;
      if (e.type === 'dolphin') near++; else if (e.type === 'squid') squid++;
    }
    if (squid < 6) this.spawnSquid();
    if (near >= 5) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      const a = Math.random() * Math.PI * 2, d = 28 + Math.random() * 30;
      const x = Math.floor(p.x + Math.cos(a) * d), z = Math.floor(p.z + Math.sin(a) * d);
      if (!w.chunkReady(x >> 4, z >> 4)) continue;
      const bio = w.gen.biomeAt(x, z);
      if (bio !== 0 && bio !== 1) continue; // ocean, deep ocean
      let y = 62;
      while (y > 40 && w.getBlock(x, y, z) !== B.water) y--;
      if (w.getBlock(x, y, z) !== B.water || w.getBlock(x, y - 3, z) !== B.water) continue;
      const n = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        const m = new Mob('dolphin', x + 0.5 + (Math.random() - 0.5) * 3, y - 1, z + 0.5 + (Math.random() - 0.5) * 3);
        if (boxFree(w, m.x, m.y, m.z, m.w, m.h)) this.entities.push(m);
      }
      return;
    }
  },

  spawnSquid() {
    const p = this.player, w = this.world;
    for (let attempt = 0; attempt < 3; attempt++) {
      const a = Math.random() * Math.PI * 2, d = 24 + Math.random() * 30;
      const x = Math.floor(p.x + Math.cos(a) * d), z = Math.floor(p.z + Math.sin(a) * d);
      if (!w.chunkReady(x >> 4, z >> 4)) continue;
      const bio = w.gen.biomeAt(x, z);
      if (![0, 1, 2, 16, 17].includes(bio)) continue; // oceans and rivers
      let y = 60;
      while (y > 30 && w.getBlock(x, y, z) !== B.water) y--;
      if (w.getBlock(x, y - 2, z) !== B.water) continue;
      const n = 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        const m = new Mob('squid', x + 0.5 + (Math.random() - 0.5) * 2, y - 2, z + 0.5 + (Math.random() - 0.5) * 2);
        if (boxFree(w, m.x, m.y, m.z, m.w, m.h)) this.entities.push(m);
      }
      return;
    }
  },

  // The nearest sunken treasure for a dolphin to lead the way to.
  locateTreasure(x, z) {
    const lm = this.world.gen && this.world.gen.landmarks;
    if (!lm) return null;
    let best = null, bd = Infinity;
    for (const kind of ['shipwreck', 'tide_citadel']) {
      if (!LANDMARKS[kind]) continue;
      const s = lm.locate(kind, x, z, 2);
      if (s) { const d = Math.hypot(s.x - x, s.z - z); if (d < bd) { bd = d; best = { x: s.x + 0.5, y: s.y ?? 40, z: s.z + 0.5 }; } }
    }
    return best;
  },

  onNightSkipped() { catGifts(this); },
};

void REPLACEABLE; void isLiquid; void BLOCKS;

// ---------------------------------------------------------------------------
// Living scenery: petals drifting from blossom trees, fireflies over swamps
// and meadows on warm nights, honey dripping from full hives.
methods.tickAmbientLife = function tickAmbientLife() {
  const p = this.player, w = this.world;
  if (this.dim !== 'overworld' || !w.gen || !w.gen.biomeAt) return;
  const px = Math.floor(p.x), py = Math.floor(p.y), pz = Math.floor(p.z);
  // sample a few blocks around the player each tick
  for (let k = 0; k < 6; k++) {
    const x = px + Math.floor((Math.random() - 0.5) * 28), y = py + Math.floor((Math.random() - 0.3) * 16), z = pz + Math.floor((Math.random() - 0.5) * 28);
    const id = w.getBlock(x, y, z);
    if (id === B.blossom_leaves && !w.getBlock(x, y - 1, z) && Math.random() < 0.5) {
      this.particles.add({ x: x + Math.random(), y: y - 0.05, z: z + Math.random(), vx: 0.2 + Math.random() * 0.2, vy: -0.25, vz: (Math.random() - 0.5) * 0.2, size: 0.09, layer: TEX.p_petal, life: 6 + Math.random() * 3, gravity: 0.05, drag: 0.94, lit: true, flutter: 2 + Math.random() * 2, phase: Math.random() * 6 });
    } else if ((id === B.bee_nest || id === B.beehive) && (w.getMeta(x, y, z) >> 3) >= 5 && !w.getBlock(x, y - 1, z)) {
      this.particles.add({ x: x + 0.2 + Math.random() * 0.6, y: y - 0.02, z: z + 0.2 + Math.random() * 0.6, vx: 0, vy: -0.1, vz: 0, size: 0.05, layer: TEX.p_honey, life: 2, gravity: 6, lit: true });
    }
  }
  // fireflies: warm, still nights over grass in swamps, meadows, plains and forests
  if (!this.isDay() && this.rain < 0.3 && Math.random() < 0.5) {
    const x = px + Math.floor((Math.random() - 0.5) * 24), z = pz + Math.floor((Math.random() - 0.5) * 24);
    const bio = w.gen.biomeAt(x, z);
    if (bio === 13 || bio === 18 || bio === 5 || bio === 6 || bio === 24) {
      const top = w.surfaceY ? w.surfaceY(x, z) : py;
      if (Math.abs(top - py) < 12) {
        this.particles.add({ x: x + Math.random(), y: top + 0.5 + Math.random() * 2.5, z: z + Math.random(), vx: 0, vy: 0, vz: 0, size: 0.05, layer: TEX.p_spark, life: 4 + Math.random() * 4, gravity: 0, drag: 0.99, fullbright: true, collide: true, r: 0.75, g: 1, b: 0.35, firefly: true, phase: Math.random() * 6 });
      }
    }
  }
};

// ---------------------------------------------------------------------------
// Leads: a creature on a lead follows whoever holds it, or stays tied to a
// fence post. Pulled too far, the lead snaps.
const FENCES = () => new Set([B.oak_fence]);
methods.leashHolder = function leashHolder(m) {
  const L = m.leash;
  if (!L) return null;
  if (L.kind === 'knot') return { x: L.x + 0.5, y: L.y + 0.62, z: L.z + 0.5, knot: true };
  const o = this.ownerOf(L.name);
  return o && !o.dead ? o : null;
};
methods.tickLeashes = function tickLeashes() {
  const w = this.world;
  for (const m of this.entities) {
    if (!m.isMob || !m.leash || m.mirror) continue;
    const L = m.leash;
    const snap = () => { this.dropItem(m.x, m.y + 0.5, m.z, { id: I.lead, count: 1 }); m.leash = null; };
    if (m.dead) { snap(); continue; }
    if (L.kind === 'knot' && w.chunkReady(L.x >> 4, L.z >> 4) && !FENCES().has(w.getBlock(L.x, L.y, L.z))) { snap(); continue; }
    const H = this.leashHolder(m);
    if (!H) continue; // its holder is away; it waits
    const hy = H.knot ? H.y : H.y + 1.1;
    const dx = H.x - m.x, dy = hy - (m.y + m.h * 0.7), dz = H.z - m.z, d = Math.hypot(dx, dy, dz);
    if (d > 12) { snap(); this.audio.play('lead_snap', m.x, m.y + 0.5, m.z); continue; }
    if (d > 4.5) {
      const k = Math.min(0.14, (d - 4.5) * 0.035);
      m.vx += (dx / d) * k; m.vz += (dz / d) * k;
      if (m.def.flier || m.inWater) m.vy += (dy / d) * k;
      else if (dy > 1.2 && m.onGround) m.vy = Math.max(m.vy, 0.42);
      m.fallDistance = 0;
    }
    if (d > 3) { m.wx = H.x; m.wz = H.z; m.wy = Math.floor(H.y); m.wanderTimer = 20; }
  }
};
// Tie the creatures you lead to a fence post, or take them back.
methods.useFence = function useFence(hit, held) {
  const me = this.localName();
  const mine = this.entities.filter((m) => m.leash && m.leash.kind === 'player' && m.leash.name === me && Math.hypot(m.x - hit.x, m.z - hit.z) < 12);
  if (mine.length) {
    for (const m of mine) m.leash = { kind: 'knot', x: hit.x, y: hit.y, z: hit.z };
    this.audio.play('lead', hit.x + 0.5, hit.y + 0.6, hit.z + 0.5);
    return true;
  }
  if (held) return false;
  const tied = this.entities.filter((m) => m.leash && m.leash.kind === 'knot' && m.leash.x === hit.x && m.leash.y === hit.y && m.leash.z === hit.z);
  if (!tied.length) return false;
  for (const m of tied) m.leash = { kind: 'player', name: me };
  this.audio.play('lead', hit.x + 0.5, hit.y + 0.6, hit.z + 0.5);
  return true;
};

// Take the book from a lectern into the inventory.
methods.takeLecternBook = function takeLecternBook(lec) {
  const w = this.world, p = this.player;
  const be = w.blockEntities.get(lec.key);
  if (!be) return;
  const book = be.book || { id: I.book, count: 1 };
  const left = p.inventory.give({ ...book });
  if (left) this.dropItem(lec.x + 0.5, lec.y + 1.1, lec.z + 0.5, { ...book, count: left });
  w.blockEntities.delete(lec.key);
  w.setBlock(lec.x, lec.y, lec.z, B.lectern, w.getMeta(lec.x, lec.y, lec.z) & 3);
  this.audio.play('page', lec.x + 0.5, lec.y + 1, lec.z + 0.5);
  this.circuits.mark(lec.x, lec.y, lec.z);
};
// A reader turned a lectern's page: comparators nearby notice.
methods.lecternPage = function lecternPage(lec, page) {
  const be = this.world.blockEntities.get(lec.key);
  if (!be) return;
  be.page = page;
  this.circuits.mark(lec.x, lec.y, lec.z);
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) this.circuits.mark(lec.x + dx, lec.y, lec.z + dz);
  if (this.net) this.net.blockEntityChanged(lec.key);
};
