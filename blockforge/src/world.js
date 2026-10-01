// Main-thread world state: chunk streaming around the player, block access,
// remesh scheduling and saving.
import { CHUNK, HEIGHT, CHUNK_VOLUME, blockIndex, chunkKey } from './constants.js';
import { OPACITY, EMIT, B, SOLID, isLiquid, RENDER_TYPE, RENDER } from './blocks.js';
import { WorkerPool } from './workerpool.js';
import { rleEncode, rleDecode } from './storage.js';
import { makeGenerator, noSky as dimNoSky } from './dims.js';

export const STATE = { NEW: 0, GENERATING: 1, READY: 2 };
const MAX_R = 34;

export class Chunk {
  constructor(cx, cz) {
    this.cx = cx; this.cz = cz; this.key = chunkKey(cx, cz);
    this.blocks = null; this.meta = null; this.tints = null;
    this.maxY = 0;
    this.light = null; this.lightRY = 0;
    this.state = STATE.NEW;
    this.version = 0; this.meshedVersion = -1; this.meshing = false;
    this.gpu = null;
    this.modified = false;
    this.lastSeen = 0;
  }
}

// Offsets sorted by distance, shared by all worlds.
const ORDER = [];
for (let dz = -MAX_R; dz <= MAX_R; dz++) for (let dx = -MAX_R; dx <= MAX_R; dx++) {
  const d = Math.hypot(dx, dz);
  if (d <= MAX_R) ORDER.push([dx, dz, d]);
}
ORDER.sort((a, b) => a[2] - b[2]);

export class World {
  constructor({ seed, worldId, storage, renderer, hooks = {}, dim = 'overworld' }) {
    this.seed = seed;
    this.dim = dim;
    this.noSky = dimNoSky(dim);
    // chunk saves for other dimensions live under their own key prefix
    this.worldId = worldId && dim !== 'overworld' ? `${worldId}@${dim}` : worldId;
    this.storage = storage;
    this.renderer = renderer;
    this.hooks = hooks; // onBlockChanged(x,y,z,old,new), onChunkGenerated(chunk, spawns)
    this.chunks = new Map();
    this.gen = makeGenerator(dim, seed);
    this.results = [];
    this.urgent = new Set();
    this.pool = new WorkerPool((msg) => this.results.push(msg));
    this.populated = new Set();
    this.blockEntities = new Map();
    this.frame = 0;
    this.saveQueue = [];
    this.stats = { gen: 0, mesh: 0 };
    this.disposed = false;
    // other players' positions [x, z, radius]: chunks stay loaded (not meshed) around them
    this.extraCenters = [];
  }

  async start() { await this.pool.init(this.seed, this.dim); }

  dispose() {
    this.disposed = true;
    for (const c of this.chunks.values()) this.renderer.freeChunk(c);
    this.chunks.clear();
    this.pool.terminate();
  }

  getChunk(cx, cz) { return this.chunks.get(chunkKey(cx, cz)); }

  chunkReady(cx, cz) {
    const c = this.chunks.get(chunkKey(cx, cz));
    return !!c && c.state === STATE.READY;
  }

  getBlock(x, y, z) {
    if (y < 0 || y >= HEIGHT) return 0;
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (!c || c.state !== STATE.READY) return 0;
    return c.blocks[blockIndex(x & 15, y, z & 15)];
  }

  // Unloaded chunks and the world floor act as solid for collisions.
  getBlockSolidCheck(x, y, z) {
    if (y < 0) return B.bedrock;
    if (y >= HEIGHT) return 0;
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (!c || c.state !== STATE.READY) return B.bedrock;
    return c.blocks[blockIndex(x & 15, y, z & 15)];
  }

  getMeta(x, y, z) {
    if (y < 0 || y >= HEIGHT) return 0;
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (!c || c.state !== STATE.READY) return 0;
    return c.meta[blockIndex(x & 15, y, z & 15)];
  }

  // Returns packed light (sky << 4 | block).
  getLight(x, y, z) {
    const open = this.noSky ? 0 : 0xf0;
    if (y >= HEIGHT) return open;
    if (y < 0) return 0;
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (!c || !c.light) return open;
    if (y >= c.lightRY) return open;
    return c.light[(y << 8) | ((z & 15) << 4) | (x & 15)];
  }

  // Highest block that stops rain (solid or liquid), or -1.
  rainHeight(x, z) {
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (!c || c.state !== STATE.READY) return -1;
    const lx = x & 15, lz = z & 15;
    for (let y = Math.min(HEIGHT - 1, c.maxY); y >= 0; y--) {
      const id = c.blocks[(y << 8) | (lz << 4) | lx];
      if (id && (SOLID[id] || isLiquid(id) || OPACITY[id] > 0)) return y;
    }
    return -1;
  }

  setBlock(x, y, z, id, meta = 0, opts = {}) {
    if (y < 0 || y >= HEIGHT) return false;
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (!c || c.state !== STATE.READY) return false;
    const lx = x & 15, lz = z & 15;
    const i = blockIndex(lx, y, lz);
    const old = c.blocks[i], oldMeta = c.meta[i];
    if (old === id && oldMeta === meta) return false;
    c.blocks[i] = id; c.meta[i] = meta;
    if (id && y > c.maxY) c.maxY = y;
    c.modified = true;
    const lightChanged = OPACITY[old] !== OPACITY[id] || EMIT[old] !== EMIT[id];
    this.markDirty(c, lx, y, lz, lightChanged, opts.urgent !== false);
    if (old !== id && this.blockEntities.has(`${x},${y},${z}`) && !opts.keepEntity) this.blockEntities.delete(`${x},${y},${z}`);
    if (this.hooks.onAnyChange) this.hooks.onAnyChange(x, y, z, id, meta, old);
    if (opts.notify !== false && this.hooks.onBlockChanged) this.hooks.onBlockChanged(x, y, z, old, id, oldMeta, meta);
    return true;
  }

  markDirty(c, lx, y, lz, lightChanged, urgent = true) {
    c.version++;
    if (urgent) this.urgent.add(c);
    const touch = (dx, dz) => {
      const n = this.chunks.get(chunkKey(c.cx + dx, c.cz + dz));
      if (n && n.state === STATE.READY) { n.version++; if (urgent && !lightChanged) this.urgent.add(n); }
    };
    if (lightChanged) {
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (dx || dz) touch(dx, dz);
      return;
    }
    const w = lx === 0, e = lx === 15, n = lz === 0, s = lz === 15;
    if (w) touch(-1, 0);
    if (e) touch(1, 0);
    if (n) touch(0, -1);
    if (s) touch(0, 1);
    if (w && n) touch(-1, -1);
    if (w && s) touch(-1, 1);
    if (e && n) touch(1, -1);
    if (e && s) touch(1, 1);
  }

  neighboursReady(c) {
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const n = this.chunks.get(chunkKey(c.cx + dx, c.cz + dz));
      if (!n || n.state !== STATE.READY) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  update(camX, camZ, renderDist, budgetMs = 6) {
    if (this.disposed) return;
    this.frame++;
    const t0 = performance.now();
    this.pool.pump(Math.max(2, budgetMs));
    this.processResults(t0 + budgetMs);

    const pcx = Math.floor(camX / CHUNK), pcz = Math.floor(camZ / CHUNK);
    const genR = renderDist + 1.5, meshR = renderDist + 0.5;
    let free = this.pool.freeSlots();

    // urgent remeshes (player edits) first
    if (free > 0 && this.urgent.size) {
      for (const c of this.urgent) {
        if (free <= 0) break;
        if (!this.chunks.has(c.key) || c.state !== STATE.READY) { this.urgent.delete(c); continue; }
        if (c.meshing) continue;
        if (c.meshedVersion >= c.version) { this.urgent.delete(c); continue; }
        if (!this.neighboursReady(c)) { this.urgent.delete(c); continue; }
        this.submitMesh(c);
        this.urgent.delete(c);
        free--;
      }
    }

    // generation and meshing, nearest first
    for (let i = 0; i < ORDER.length && free > 0; i++) {
      const [dx, dz, d] = ORDER[i];
      if (d > genR) break;
      const cx = pcx + dx, cz = pcz + dz;
      const key = chunkKey(cx, cz);
      let c = this.chunks.get(key);
      if (!c) {
        c = new Chunk(cx, cz);
        this.chunks.set(key, c);
        this.requestGen(c);
        free--;
        continue;
      }
      c.lastSeen = this.frame;
      if (d <= meshR && c.state === STATE.READY && !c.meshing && c.meshedVersion < c.version && this.neighboursReady(c)) {
        this.submitMesh(c);
        free--;
      }
    }

    // generation around other players (shared worlds)
    for (const [ex, ez, er] of this.extraCenters) {
      if (free <= 0) break;
      const ecx = Math.floor(ex / CHUNK), ecz = Math.floor(ez / CHUNK);
      for (let i = 0; i < ORDER.length && free > 0; i++) {
        const [dx, dz, d] = ORDER[i];
        if (d > er + 1.5) break;
        const key = chunkKey(ecx + dx, ecz + dz);
        let c = this.chunks.get(key);
        if (!c) {
          c = new Chunk(ecx + dx, ecz + dz);
          this.chunks.set(key, c);
          this.requestGen(c);
          free--;
        } else c.lastSeen = this.frame;
      }
    }

    // unload far chunks
    if (this.frame % 30 === 0) {
      const lim = renderDist + 3;
      const nearExtra = (c) => this.extraCenters.some(([ex, ez, er]) => {
        const dx = c.cx - Math.floor(ex / CHUNK), dz = c.cz - Math.floor(ez / CHUNK);
        return dx * dx + dz * dz <= (er + 3) * (er + 3);
      });
      for (const c of this.chunks.values()) {
        const dx = c.cx - pcx, dz = c.cz - pcz;
        if (dx * dx + dz * dz > lim * lim && !c.meshing && c.state !== STATE.GENERATING && !nearExtra(c)) {
          if (c.modified) this.saveQueue.push(this.serializeChunk(c));
          this.renderer.freeChunk(c);
          this.chunks.delete(c.key);
          this.urgent.delete(c);
        }
      }
    }
  }

  // Freshly generated terrain for a chunk, untouched by players (for diffs).
  requestBaseline(cx, cz) { this.pool.submit({ type: 'base', cx, cz }); }

  requestGen(c) {
    c.state = STATE.GENERATING;
    c.savedPromise = this.storage && this.worldId ? this.storage.loadChunk(this.worldId, c.cx, c.cz) : Promise.resolve(null);
    this.pool.submit({ type: 'gen', cx: c.cx, cz: c.cz });
  }

  submitMesh(c) {
    let top = 0;
    const list = [];
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const n = this.chunks.get(chunkKey(c.cx + dx, c.cz + dz));
      list.push(n);
      if (n.maxY > top) top = n.maxY;
    }
    const ry = Math.min(HEIGHT, top + 2);
    const len = ry << 8;
    const chunks = [], transfer = [];
    for (const n of list) {
      const b = n.blocks.slice(0, len), m = n.meta.slice(0, len);
      chunks.push({ blocks: b, meta: m, maxY: n.maxY });
      transfer.push(b.buffer, m.buffer);
    }
    c.meshing = true;
    this.pool.submit({ type: 'mesh', cx: c.cx, cz: c.cz, version: c.version, chunks, tints: c.tints }, transfer);
    this.stats.mesh++;
  }

  processResults(deadline) {
    while (this.results.length) {
      if (performance.now() > deadline && this.results.length < 64) break;
      const msg = this.results.shift();
      if (msg.type === 'base') { if (this.hooks.onBaseline) this.hooks.onBaseline(msg); continue; }
      const c = this.chunks.get(chunkKey(msg.cx, msg.cz));
      if (msg.failed) {
        if (c) {
          if (msg.job === 'gen') { this.chunks.delete(c.key); }
          else c.meshing = false;
        }
        continue;
      }
      if (!c) continue;
      if (msg.type === 'gen') this.applyGen(c, msg);
      else if (msg.type === 'mesh') {
        c.meshing = false;
        if (c.state !== STATE.READY) continue;
        this.renderer.uploadChunk(c, msg);
        c.light = msg.light; c.lightRY = msg.ry;
        c.meshedVersion = Math.max(c.meshedVersion, msg.version);
      }
    }
  }

  applyGen(c, msg) {
    const finish = (saved) => {
      if (!this.chunks.has(c.key) || this.disposed) return;
      c.blocks = msg.blocks; c.meta = msg.meta; c.tints = msg.tints; c.maxY = msg.maxY;
      if (saved) {
        try {
          c.blocks = rleDecode(saved.blocks, CHUNK_VOLUME);
          c.meta = rleDecode(saved.meta, CHUNK_VOLUME);
          c.maxY = saved.maxY ?? 255;
          c.modified = true;
        } catch (err) { console.warn('corrupt chunk save, regenerating', err); }
      }
      c.state = STATE.READY;
      c.version++;
      this.stats.gen++;
      if (this.hooks.onChunkReady) this.hooks.onChunkReady(c);
      if (!this.populated.has(c.key)) {
        this.populated.add(c.key);
        if (this.hooks.onChunkGenerated) this.hooks.onChunkGenerated(c, saved ? [] : msg.spawns, msg.chests || [], msg.spawners || []);
      }
    };
    c.savedPromise.then(finish, () => finish(null));
  }

  serializeChunk(c) {
    return { cx: c.cx, cz: c.cz, blocks: rleEncode(c.blocks), meta: rleEncode(c.meta), maxY: c.maxY };
  }

  // Modified chunks (loaded or queued) for saving.
  collectSaves() {
    const out = this.saveQueue.splice(0);
    for (const c of this.chunks.values()) {
      if (c.modified && c.state === STATE.READY && c.dirtySince !== c.version) {
        out.push(this.serializeChunk(c));
        c.dirtySince = c.version;
      }
    }
    return out;
  }

  // Are the chunks around a point meshed (used by the loading screen)?
  loadProgress(x, z, radius) {
    const pcx = Math.floor(x / CHUNK), pcz = Math.floor(z / CHUNK);
    let total = 0, done = 0;
    for (let dz = -radius; dz <= radius; dz++) for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dz * dz > radius * radius + 0.5) continue;
      total++;
      const c = this.chunks.get(chunkKey(pcx + dx, pcz + dz));
      if (c && c.state === STATE.READY && c.meshedVersion >= 0) done++;
    }
    return total ? done / total : 1;
  }

  isPassable(x, y, z) {
    const id = this.getBlockSolidCheck(x, y, z);
    return !SOLID[id];
  }

  // Surface height used for spawning: top solid block + 1
  surfaceY(x, z) {
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (!c || c.state !== STATE.READY) return -1;
    const lx = x & 15, lz = z & 15;
    for (let y = Math.min(HEIGHT - 1, c.maxY); y >= 0; y--) {
      const id = c.blocks[(y << 8) | (lz << 4) | lx];
      if (SOLID[id] || isLiquid(id)) return y + 1;
    }
    return 0;
  }

  static isTorchLike(id) { return RENDER_TYPE[id] === RENDER.TORCH; }
}
