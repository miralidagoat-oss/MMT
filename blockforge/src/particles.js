// CPU particle system. Particles are billboards sampled from the block
// texture array (debris uses a random 4x4 texel patch of the block).
import { TEX, faceTexture, TINT, SOLID } from './blocks.js';
import { BIRCH_TINT, SPRUCE_TINT } from './worldgen.js';

const MAX = 4000;
const STRIDE = 16;

export class Particles {
  constructor(world) {
    this.world = world;
    this.list = [];
    this.data = new Float32Array(MAX * STRIDE);
    this.count = 0;
  }

  setWorld(world) { this.world = world; this.list.length = 0; }

  add(p) {
    if (this.list.length >= MAX) this.list.shift();
    p.age = 0;
    p.gravity ??= 0;
    p.drag ??= 0.98;
    p.a ??= 1;
    p.r ??= 1; p.g ??= 1; p.b ??= 1;
    p.u0 ??= 0; p.v0 ??= 0; p.u1 ??= 1; p.v1 ??= 1;
    p.collide ??= true;
    this.list.push(p);
    return p;
  }

  tintFor(id, x, z) {
    const t = TINT[id];
    if (!t) return [1, 1, 1];
    if (t === 4) return BIRCH_TINT.map((v) => v / 255);
    if (t === 5) return SPRUCE_TINT.map((v) => v / 255);
    const c = this.world.getChunk(x >> 4, z >> 4);
    if (!c || !c.tints) return [0.5, 0.75, 0.35];
    const o = (((z & 15) * 16) + (x & 15)) * 9 + (t - 1) * 3;
    return [c.tints[o] / 255, c.tints[o + 1] / 255, c.tints[o + 2] / 255];
  }

  // Debris when a block breaks.
  blockBreak(x, y, z, id, meta) {
    const layer = faceTexture(id, 2, meta);
    const tint = this.tintFor(id, x, z);
    const n = 4;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) {
      if (Math.random() < 0.45) continue;
      const px = x + (i + 0.5) / n, py = y + (j + 0.5) / n, pz = z + (k + 0.5) / n;
      this.debris(px, py, pz, (px - x - 0.5) * 0.18 + (Math.random() - 0.5) * 0.08, (py - y - 0.5) * 0.18 + Math.random() * 0.12, (pz - z - 0.5) * 0.18 + (Math.random() - 0.5) * 0.08, layer, tint);
    }
  }

  // A single chip flying off the face being mined.
  blockHit(x, y, z, id, meta, face) {
    const layer = faceTexture(id, face, meta);
    const tint = this.tintFor(id, x, z);
    const o = 0.1;
    let px = x + o + Math.random() * (1 - 2 * o), py = y + o + Math.random() * (1 - 2 * o), pz = z + o + Math.random() * (1 - 2 * o);
    if (face === 0) py = y + 1 + 0.05; else if (face === 1) py = y - 0.05;
    else if (face === 2) px = x + 1 + 0.05; else if (face === 3) px = x - 0.05;
    else if (face === 4) pz = z + 1 + 0.05; else pz = z - 0.05;
    this.debris(px, py, pz, (Math.random() - 0.5) * 0.04, Math.random() * 0.06, (Math.random() - 0.5) * 0.04, layer, tint, 0.6);
  }

  debris(x, y, z, vx, vy, vz, layer, tint, sizeMul = 1) {
    const u = Math.floor(Math.random() * 12) / 16, v = Math.floor(Math.random() * 12) / 16;
    return this.add({
      x, y, z, vx: vx * 20, vy: vy * 20, vz: vz * 20, size: (0.08 + Math.random() * 0.08) * sizeMul,
      layer, u0: u, v0: v, u1: u + 0.25, v1: v + 0.25, r: tint[0], g: tint[1], b: tint[2],
      life: 0.4 + Math.random() * 0.8, gravity: 16, drag: 0.98, lit: true,
    });
  }

  flame(x, y, z) {
    this.add({ x, y, z, vx: 0, vy: 0.05, vz: 0, size: 0.09, layer: TEX.p_flame, life: 0.5 + Math.random() * 0.4, shrink: true, fullbright: true, collide: false });
  }

  smoke(x, y, z, big = false) {
    const p = this.add({
      x, y, z, vx: (Math.random() - 0.5) * 0.2, vy: 0.4 + Math.random() * 0.3, vz: (Math.random() - 0.5) * 0.2,
      size: big ? 0.5 + Math.random() * 0.5 : 0.12 + Math.random() * 0.06, layer: TEX.p_smoke0, life: 0.8 + Math.random() * 0.8,
      smoke: true, r: 0.6, g: 0.6, b: 0.6, collide: false, lit: true, drag: 0.96,
    });
    if (big) { p.r = p.g = p.b = 0.8; p.vx *= 5; p.vz *= 5; p.vy *= 1.5; }
    return p;
  }

  bubble(x, y, z) {
    this.add({ x, y, z, vx: (Math.random() - 0.5) * 0.3, vy: 1.2, vz: (Math.random() - 0.5) * 0.3, size: 0.06 + Math.random() * 0.04, layer: TEX.p_bubble, life: 1.5, bubble: true, collide: false, lit: true });
  }

  splash(x, y, z, n = 12) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = Math.random() * 1.5;
      this.add({ x: x + Math.cos(a) * 0.3, y, z: z + Math.sin(a) * 0.3, vx: Math.cos(a) * s, vy: 2 + Math.random() * 3, vz: Math.sin(a) * s, size: 0.06, layer: TEX.p_splash, life: 0.6, gravity: 18, lit: true });
    }
  }

  rain(x, y, z, snow) {
    if (snow) {
      this.add({ x, y, z, vx: (Math.random() - 0.5) * 0.5, vy: -2 - Math.random(), vz: (Math.random() - 0.5) * 0.5, size: 0.07, layer: TEX.p_snow, life: 6, collide: true, lit: true, snow: true, drag: 1 });
    } else {
      this.add({ x, y, z, vx: 0, vy: -18, vz: 0, size: 0.06, vertical: 5, layer: TEX.p_rain, life: 2, collide: true, lit: true, rainDrop: true, drag: 1, a: 0.7 });
    }
  }

  heart(x, y, z) {
    this.add({ x, y, z, vx: (Math.random() - 0.5) * 0.3, vy: 0.6, vz: (Math.random() - 0.5) * 0.3, size: 0.12, layer: TEX.p_heart, life: 1, collide: false, fullbright: true, drag: 0.95 });
  }

  crit(x, y, z) {
    this.add({ x, y, z, vx: (Math.random() - 0.5) * 3, vy: Math.random() * 3, vz: (Math.random() - 0.5) * 3, size: 0.09, layer: TEX.p_crit, life: 0.5, gravity: 6, fullbright: true, r: 1, g: 0.95, b: 0.7 });
  }

  portal(x, y, z) {
    this.add({ x, y, z, vx: (Math.random() - 0.5) * 1.2, vy: (Math.random() - 0.3) * 1.2, vz: (Math.random() - 0.5) * 1.2, size: 0.06, layer: TEX.p_portal, life: 1 + Math.random(), collide: false, fullbright: true, drag: 0.9 });
  }

  glyph(x, y, z, tx, ty, tz) {
    this.add({ x, y, z, vx: (tx - x) * 1.2, vy: (ty - y) * 1.2 + 0.4, vz: (tz - z) * 1.2, size: 0.07, layer: TEX.p_glyph, life: 1, collide: false, fullbright: true, drag: 0.97 });
  }

  // Swirls in a status effect's colour (0-255 rgb).
  effect(x, y, z, c, vx = 0, vy = 0.6, vz = 0) {
    this.add({ x, y, z, vx: vx + (Math.random() - 0.5) * 0.2, vy, vz: vz + (Math.random() - 0.5) * 0.2, size: 0.07, layer: TEX.p_effect, life: 0.9 + Math.random() * 0.5, collide: false, fullbright: true, drag: 0.92, r: c[0] / 255, g: c[1] / 255, b: c[2] / 255 });
  }

  sparkDust(x, y, z) {
    this.add({ x: x + (Math.random() - 0.5) * 0.6, y, z: z + (Math.random() - 0.5) * 0.6, vx: 0, vy: 0.2, vz: 0, size: 0.05, layer: TEX.p_spark_dust, life: 0.6, collide: false, fullbright: true });
  }

  // Note blocks: the colour walks round the hue circle with pitch.
  note(x, y, z, pitch) {
    const h = (pitch / 24) * 6;
    const f = (n) => { const k = (n + h) % 6; return Math.max(0, Math.min(1, Math.min(k, 4 - k))); };
    this.add({ x, y, z, vx: 0, vy: 0.9, vz: 0, size: 0.13, layer: TEX.p_note, life: 0.9, collide: false, fullbright: true, drag: 0.85, r: f(5), g: f(3), b: f(1) });
  }

  voidSpark(x, y, z) {
    this.add({ x, y, z, vx: (Math.random() - 0.5) * 1.5, vy: (Math.random() - 0.5) * 1.5, vz: (Math.random() - 0.5) * 1.5, size: 0.08, layer: TEX.p_void, life: 0.8 + Math.random() * 0.6, collide: false, fullbright: true, drag: 0.92 });
  }

  bubbleUp(x, y, z) {
    for (let i = 0; i < 3; i++) this.add({ x: x + (Math.random() - 0.5) * 0.3, y, z: z + (Math.random() - 0.5) * 0.3, vx: 0, vy: 0.5, vz: 0, size: 0.05, layer: TEX.p_bubble, life: 0.7, collide: false, lit: true });
  }

  explosion(x, y, z) {
    for (let i = 0; i < 30; i++) {
      const p = this.add({
        x: x + (Math.random() - 0.5) * 3, y: y + (Math.random() - 0.5) * 3, z: z + (Math.random() - 0.5) * 3,
        vx: (Math.random() - 0.5) * 2, vy: Math.random() * 1.5, vz: (Math.random() - 0.5) * 2,
        size: 0.8 + Math.random() * 1.2, layer: TEX.p_explosion, life: 0.4 + Math.random() * 0.5, collide: false, fullbright: true, drag: 0.9,
      });
      p.r = p.g = p.b = 0.85 + Math.random() * 0.15;
    }
    for (let i = 0; i < 16; i++) this.smoke(x + (Math.random() - 0.5) * 3, y + Math.random() * 2, z + (Math.random() - 0.5) * 3, true);
  }

  poof(x, y, z, w, h) {
    for (let i = 0; i < 16; i++) {
      const p = this.smoke(x + (Math.random() - 0.5) * w * 2, y + Math.random() * h, z + (Math.random() - 0.5) * w * 2);
      p.size = 0.15 + Math.random() * 0.1; p.r = p.g = p.b = 0.9;
    }
  }

  update(dt) {
    const w = this.world;
    const list = this.list;
    let j = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      p.age += dt;
      if (p.age >= p.life) continue;
      p.vy -= p.gravity * dt;
      const d = Math.pow(p.drag, dt * 20);
      p.vx *= d; p.vy *= d; p.vz *= d;
      if (p.bubble) {
        const id = w.getBlock(Math.floor(p.x), Math.floor(p.y + 0.1), Math.floor(p.z));
        if (id !== 12) continue;
      }
      let nx = p.x + p.vx * dt, ny = p.y + p.vy * dt, nz = p.z + p.vz * dt;
      if (p.collide) {
        const bx = Math.floor(nx), by = Math.floor(ny), bz = Math.floor(nz);
        const id = w.getBlock(bx, by, bz);
        if (id && (SOLID[id] || ((p.rainDrop || p.snow) && (id === 12 || id === 13)))) {
          if (p.rainDrop) {
            if (Math.random() < 0.3) this.add({ x: p.x, y: by + 1.02, z: p.z, vx: (Math.random() - 0.5), vy: 1.5, vz: (Math.random() - 0.5), size: 0.04, layer: TEX.p_splash, life: 0.25, gravity: 12, lit: true });
            continue;
          }
          if (p.snow) { p.life = Math.min(p.life, p.age + 0.3); p.vx = p.vy = p.vz = 0; list[j++] = p; continue; }
          // stop on the axis that hit
          if (w.getBlock(Math.floor(p.x), by, Math.floor(p.z)) && SOLID[w.getBlock(Math.floor(p.x), by, Math.floor(p.z))]) { ny = p.y; p.vy = 0; p.vx *= 0.7; p.vz *= 0.7; }
          if (SOLID[w.getBlock(bx, Math.floor(p.y), Math.floor(p.z))]) { nx = p.x; p.vx = 0; }
          if (SOLID[w.getBlock(Math.floor(p.x), Math.floor(p.y), bz)]) { nz = p.z; p.vz = 0; }
        }
      }
      p.x = nx; p.y = ny; p.z = nz;
      list[j++] = p;
    }
    list.length = j;
  }

  // Fill the render buffer. Light is sampled per particle; experience orbs
  // are drawn here too.
  build(dayScale, orbs = [], alpha = 1) {
    const d = this.data, w = this.world;
    let n = 0;
    const now = performance.now() / 1000;
    for (const o of orbs) {
      if (n >= MAX) break;
      const [x, y, z] = o.lerpPos(alpha);
      const k = n * STRIDE;
      const pulse = 0.5 + 0.5 * Math.sin(now * 6 + o.id);
      const sz = 0.18 + Math.min(0.2, o.value * 0.012);
      d[k] = x; d[k + 1] = y + 0.12; d[k + 2] = z; d[k + 3] = sz;
      d[k + 4] = 0; d[k + 5] = 0; d[k + 6] = 1; d[k + 7] = 1; d[k + 8] = TEX.p_xp;
      d[k + 9] = 0.7 + pulse * 0.3; d[k + 10] = 1; d[k + 11] = 0.3 + pulse * 0.2; d[k + 12] = 1; d[k + 13] = 0;
      n++;
    }
    for (const p of this.list) {
      if (n >= MAX) break;
      const o = n * STRIDE;
      const t = p.age / p.life;
      let size = p.size;
      let layer = p.layer;
      if (p.shrink) size *= 1 - t * 0.6;
      if (p.smoke) layer = TEX.p_smoke0 + Math.min(3, Math.floor(t * 4));
      let br = 1;
      if (p.lit && !p.fullbright) {
        const l = w.getLight(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
        const sky = (l >> 4) / 15, bl = (l & 15) / 15;
        br = Math.max(sky * sky * dayScale, bl * bl * 0.95, 0.05);
        br = Math.min(1, br * 1.1);
      }
      d[o] = p.x; d[o + 1] = p.y; d[o + 2] = p.z; d[o + 3] = size * 2;
      d[o + 4] = p.u0; d[o + 5] = p.v0; d[o + 6] = p.u1; d[o + 7] = p.v1; d[o + 8] = layer;
      d[o + 9] = p.r * br; d[o + 10] = p.g * br; d[o + 11] = p.b * br;
      d[o + 12] = p.a * (p.smoke ? 1 - t * 0.5 : 1);
      d[o + 13] = p.vertical || 0;
      n++;
    }
    this.count = n;
    return this;
  }
}
