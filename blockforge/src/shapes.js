// Box geometry for non-cube blocks (stairs, slabs, doors, fences, gates,
// beds, farmland, paths, tables). Shared by the mesher (rendering) and
// physics (collision and targeting). Units are 1/16 of a block.
//
// get(dx, dy, dz) returns the block id next to the one being shaped.

// Horizontal directions indexed by facing: 0 north (-Z), 1 east (+X), 2 south (+Z), 3 west (-X).
export const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
// Face index (0 +Y, 1 -Y, 2 +X, 3 -X, 4 +Z, 5 -Z) for each facing.
export const DIR_FACE = [5, 2, 4, 3];

export const SHAPE = {
  NONE: 0, SLAB: 1, STAIRS: 2, FENCE: 3, GATE: 4, DOOR: 5, BED: 6, FLAT15: 7, TABLE12: 8, SINK14: 9,
  BUTTON: 10, PLATE: 11, REPEATER: 12, TRAPDOOR: 13, PISTON: 14, PISTON_HEAD: 15, LEVER: 16, BREWING: 17,
  SENSOR: 18, STAR_FRAME: 19, PANE: 20, STALK: 21, CAKE: 22, LANTERN: 23, SIGN: 24, HOPPER: 25, ROD: 26, EGG: 27,
  COMPARATOR: 28, ANVIL: 29, BEACON: 30, BANNER: 31, CAULDRON: 32,
};

// Lever/button meta: bits 0-2 attach (0 floor, 1 wall at -X, 2 wall at +X, 3 wall at -Z, 4 wall at +Z,
// 5 ceiling), bit 3 on/pressed, bit 4 floor/ceiling lever swings along X.
export const ATTACH_DIR = [[0, -1, 0], [-1, 0, 0], [1, 0, 0], [0, 0, -1], [0, 0, 1], [0, 1, 0]];
// Piston, dispenser, rod and hopper facing: the face index (0 +Y, 1 -Y, 2 +X, 3 -X, 4 +Z, 5 -Z).
export const FACE_DIR = [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
export const PISTON_EXTENDED = 8;

// Floor-space point -> block space for an attach code (rotations about the block centre).
export function attachPoint(p, a) {
  const [x, y, z] = p;
  switch (a) {
    case 1: return [y, 16 - x, z];
    case 2: return [16 - y, x, z];
    case 3: return [x, 16 - z, y];
    case 4: return [x, z, 16 - y];
    case 5: return [x, 16 - y, 16 - z];
    default: return [x, y, z];
  }
}
// The same rotations indexed by facing face: up-space model (pointing +Y) -> facing f.
const F6_ATTACH = [0, 5, 1, 2, 3, 4];
export const facingPoint = (p, f) => attachPoint(p, F6_ATTACH[f]);

function xformBox(b, fn) {
  const a = fn([b[0], b[1], b[2]]), c = fn([b[3], b[4], b[5]]);
  return [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.min(a[2], c[2]), Math.max(a[0], c[0]), Math.max(a[1], c[1]), Math.max(a[2], c[2])];
}

// Texture coordinates of a point on a face (same convention as the mesher).
export function faceUV(f, x, y, z) {
  switch (f) {
    case 0: return [x, z];
    case 1: return [x, 16 - z];
    case 2: return [16 - z, 16 - y];
    case 3: return [z, 16 - y];
    case 4: return [x, 16 - y];
    default: return [16 - x, 16 - y];
  }
}
const NORMALS = [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
const faceOfNormal = (n) => NORMALS.findIndex((m) => m[0] === n[0] && m[1] === n[1] && m[2] === n[2]);
const rotUV = (u, v, k) => { for (let i = 0; i < k; i++) { const t = u; u = 16 - v; v = t; } return [u, v]; };

// Re-orient a model-space box with per-face textures. Returns {b, t, r}: the
// block-space box, its six face textures and the UV turns that keep each
// texture upright relative to the model.
const orientCache = new Map();
function orientFaces(fn, key) {
  let o = orientCache.get(key);
  if (o) return o;
  o = { from: [], turns: [] };
  const c = [8, 8, 8];
  for (let F = 0; F < 6; F++) {
    // which model face lands on block face F
    let src = 0;
    for (let m = 0; m < 6; m++) {
      const p = fn([c[0] + NORMALS[m][0], c[1] + NORMALS[m][1], c[2] + NORMALS[m][2]]);
      const n = [p[0] - 8, p[1] - 8, p[2] - 8];
      if (faceOfNormal(n) === F) src = m;
    }
    // find the UV turn count that maps texels consistently (two sample points)
    const s1 = [3, 5, 7], s2 = [11, 2, 13];
    const onFace = (pt, m) => { const q = pt.slice(); const n = NORMALS[m]; for (let a = 0; a < 3; a++) if (n[a]) q[a] = n[a] > 0 ? 16 : 0; return q; };
    let turn = 0;
    for (let k = 0; k < 4; k++) {
      let ok = true;
      for (const sp of [s1, s2]) {
        const mp = onFace(sp, src);
        const want = faceUV(src, mp[0], mp[1], mp[2]);
        const bp = fn(mp);
        const got = rotUV(...faceUV(F, bp[0], bp[1], bp[2]), k);
        if (Math.abs(got[0] - want[0]) > 0.01 || Math.abs(got[1] - want[1]) > 0.01) ok = false;
      }
      if (ok) { turn = k; break; }
    }
    o.from[F] = src; o.turns[F] = turn;
  }
  orientCache.set(key, o);
  return o;
}

function orientBox(b, t6, fn, key) {
  const o = orientFaces(fn, key);
  const t = t6 ? o.from.map((m) => t6[m]) : null;
  return { b: xformBox(b, fn), t, r: o.turns };
}

const all6 = (l) => [l, l, l, l, l, l];

// Door meta: bits 0-1 facing, bit 2 open, bit 3 upper half, bit 4 hinge on the right.
export const DOOR_OPEN = 4, DOOR_UPPER = 8, DOOR_RIGHT = 16;
// Gate meta: bits 0-1 facing, bit 2 open.  Stairs: bits 0-1 facing, bit 2 upside down.
// Slab: bit 0 top half.  Bed: bits 0-1 facing (foot -> head), bit 2 head part.
export const BED_HEAD = 4;

const box = (x0, y0, z0, x1, y1, z1, t = null, r = null) => ({ b: [x0, y0, z0, x1, y1, z1], t, r });
const rotY = (p, f) => { let [x, y, z] = p; for (let i = 0; i < f; i++) { const nx = 16 - z, nz = x; x = nx; z = nz; } return [x, y, z]; };

// Rotate a north-facing box (in the XZ plane) to another facing.
function rot(b, facing) {
  let [x0, y0, z0, x1, y1, z1] = b;
  for (let i = 0; i < facing; i++) {
    // 90° clockwise seen from above: (x, z) -> (16 - z, x)
    const nx0 = 16 - z1, nx1 = 16 - z0, nz0 = x0, nz1 = x1;
    x0 = nx0; x1 = nx1; z0 = nz0; z1 = nz1;
  }
  return [x0, y0, z0, x1, y1, z1];
}

export function connectsFence(id, fenceIds, opaque) {
  return fenceIds.has(id) || opaque[id] === 1;
}

// Returns an array of {b, t, r} boxes, or null for blocks that are not shaped.
// ctx: { shape: Uint8Array(id -> SHAPE), fences: Set, opaque: Uint8Array, bedTex, doorTex }
export function shapeBoxes(ctx, id, meta, get) {
  const kind = ctx.shape[id];
  switch (kind) {
    case SHAPE.SLAB:
      return meta & 1 ? [box(0, 8, 0, 16, 16, 16)] : [box(0, 0, 0, 16, 8, 16)];
    case SHAPE.STAIRS: {
      const f = meta & 3, up = meta & 4;
      const base = up ? box(0, 8, 0, 16, 16, 16) : box(0, 0, 0, 16, 8, 16);
      // the tall step sits on the side the stairs face
      const step = rot([0, up ? 0 : 8, 0, 16, up ? 8 : 16, 8], f);
      return [base, { b: step, t: null, r: null }];
    }
    case SHAPE.FENCE: {
      const out = [box(6, 0, 6, 10, 16, 10)];
      const arms = [
        [[0, 0, -1], [7, 0, 0, 9, 0, 6]], [[1, 0, 0], [10, 0, 7, 16, 0, 9]],
        [[0, 0, 1], [7, 0, 10, 9, 0, 16]], [[-1, 0, 0], [0, 0, 7, 6, 0, 9]],
      ];
      for (const [[dx, dy, dz], a] of arms) {
        if (!connectsFence(get(dx, dy, dz), ctx.fences, ctx.opaque)) continue;
        out.push(box(a[0], 6, a[2], a[3], 9, a[5]), box(a[0], 12, a[2], a[3], 15, a[5]));
      }
      return out;
    }
    case SHAPE.GATE: {
      const f = meta & 3, open = meta & 4;
      const out = [];
      // posts at both ends of the gate line (north-facing gate runs along X)
      const posts = [[0, 5, 7, 2, 16, 9], [14, 5, 7, 16, 16, 9]];
      for (const p of posts) out.push({ b: rot(p, f), t: null, r: null });
      if (!open) {
        for (const r of [[2, 6, 7, 14, 9, 9], [2, 12, 7, 14, 15, 9], [7, 9, 7, 9, 12, 9]]) out.push({ b: rot(r, f), t: null, r: null });
      } else {
        for (const r of [[0, 6, 9, 2, 9, 15], [0, 12, 9, 2, 15, 15], [14, 6, 9, 16, 9, 15], [14, 12, 9, 16, 15, 15]]) out.push({ b: rot(r, f), t: null, r: null });
      }
      return out;
    }
    case SHAPE.DOOR: {
      const f = meta & 3, open = meta & DOOR_OPEN, right = meta & DOOR_RIGHT;
      const tex = ctx.doorTex(id, meta);
      if (!open) return [box(...rot([0, 0, 0, 16, 16, 3], f), tex)];
      // swings 90° around the hinge edge
      const side = right ? (f + 3) % 4 : (f + 1) % 4;
      return [box(...rot([0, 0, 0, 16, 16, 3], side), tex)];
    }
    case SHAPE.BED: {
      const f = meta & 3, head = meta & BED_HEAD;
      const t = ctx.bedTex(head, f);
      return [box(0, 0, 0, 16, 9, 16, t.faces, t.rot)];
    }
    case SHAPE.FLAT15: return [box(0, 0, 0, 16, 15, 16)];
    case SHAPE.TABLE12: return [box(0, 0, 0, 16, 12, 16)];
    case SHAPE.SINK14: return [box(0, 0, 0, 16, 16, 16)];
    case SHAPE.BUTTON: {
      const a = meta & 7, pressed = meta & 8;
      const fn = (p) => attachPoint(p, a);
      return [{ b: xformBox([5, 0, 6, 11, pressed ? 1 : 2, 10], fn), t: null, r: null }];
    }
    case SHAPE.PLATE: return [box(1, 0, 1, 15, meta & 1 ? 1 : 2, 15)];
    case SHAPE.REPEATER: {
      const f = meta & 3, delay = (meta >> 2) & 3, on = meta & 16;
      const fn = (p) => rotY(p, f);
      const top = on ? ctx.tex('repeater_on') : ctx.tex('repeater');
      const st = ctx.tex('stone');
      const base = orientBox([0, 0, 0, 16, 2, 16], [top, st, st, st, st, st], fn, 'ry' + f);
      const side = ctx.tex(on ? 'spark_torch' : 'spark_torch_off'), tt = ctx.tex(on ? 'spark_torch_top' : 'spark_torch_top_off');
      const tex = [tt, side, side, side, side, side];
      const zb = 6 + delay * 2;
      return [base, orientBox([7, 2, 2, 9, 7, 4], tex, fn, 'ry' + f), orientBox([7, 2, zb, 9, 7, zb + 2], tex, fn, 'ry' + f)];
    }
    case SHAPE.TRAPDOOR: {
      const f = meta & 3, open = meta & 4, top = meta & 8;
      if (open) return [{ b: rot([0, 0, 13, 16, 16, 16], f), t: null, r: null }];
      return [top ? box(0, 13, 0, 16, 16, 16) : box(0, 0, 0, 16, 3, 16)];
    }
    case SHAPE.PISTON: {
      const f = meta & 7, ext = meta & PISTON_EXTENDED;
      const fn = (p) => facingPoint(p, f);
      const front = id === ctx.id('sticky_piston') ? ctx.tex('piston_top_sticky') : ctx.tex('piston_top');
      const side = ctx.tex('piston_side'), back = ctx.tex('piston_bottom');
      if (!ext) return [orientBox([0, 0, 0, 16, 16, 16], [front, back, side, side, side, side], fn, 'f6' + f)];
      const inner = ctx.tex('piston_inner');
      return [
        orientBox([0, 0, 0, 16, 12, 16], [inner, back, side, side, side, side], fn, 'f6' + f),
        orientBox([6, 12, 6, 10, 16, 10], all6(side), fn, 'f6' + f),
      ];
    }
    case SHAPE.PISTON_HEAD: {
      const f = meta & 7;
      const fn = (p) => facingPoint(p, f);
      const front = meta & 8 ? ctx.tex('piston_top_sticky') : ctx.tex('piston_top');
      const side = ctx.tex('piston_side'), plate = ctx.tex('piston_top');
      return [
        orientBox([0, 12, 0, 16, 16, 16], [front, plate, side, side, side, side], fn, 'f6' + f),
        orientBox([6, 0, 6, 10, 12, 10], all6(side), fn, 'f6' + f),
      ];
    }
    case SHAPE.LEVER: {
      const a = meta & 7, on = meta & 8, alongX = meta & 16;
      const fn = (p) => attachPoint(p, a);
      const base = alongX && (a === 0 || a === 5) ? [4, 0, 5, 12, 3, 11] : [5, 0, 4, 11, 3, 12];
      const cobble = ctx.tex('cobblestone');
      const out = [{ b: xformBox(base, fn), t: all6(cobble), r: null }];
      // the handle leans one way when off and the other way when on; on wall levers "on" is down
      let sv;
      if (a === 0 || a === 5) sv = alongX ? [on ? 4 : -4, 0, 0] : [0, 0, on ? 4 : -4];
      else {
        const want = on ? -4 : 4;
        sv = [[4, 0, 0], [-4, 0, 0], [0, 0, 4], [0, 0, -4]].find((v) => {
          const q = fn([8 + v[0], 8, 8 + v[2]]), c = fn([8, 8, 8]);
          return Math.round(q[1] - c[1]) === want;
        }) || [0, 0, 4];
      }
      const h = [7, 3, 7, 9, 11, 9];
      const pts = [];
      for (let k = 0; k < 8; k++) {
        const x = k & 1 ? h[3] : h[0], y = k & 2 ? h[4] : h[1], z = k & 4 ? h[5] : h[2];
        const top = y === h[4];
        pts.push(fn([x + (top ? sv[0] : 0), y, z + (top ? sv[2] : 0)]));
      }
      out.push({ pts, uvb: h, t: all6(ctx.tex('lever')) });
      return out;
    }
    case SHAPE.BREWING: return [box(1, 0, 1, 15, 2, 15), box(7, 2, 7, 9, 14, 9, all6(ctx.tex('brewing_rod')))];
    case SHAPE.SENSOR: return [box(0, 0, 0, 16, 6, 16)];
    case SHAPE.STAR_FRAME: {
      const out = [box(0, 0, 0, 16, 13, 16)];
      if (meta & 4) out.push(box(4, 13, 4, 12, 16, 12, all6(ctx.tex('star_frame_eye'))));
      return out;
    }
    case SHAPE.PANE: {
      const out = [box(7, 0, 7, 9, 16, 9)];
      const joins = (n) => ctx.shape[n] === SHAPE.PANE || ctx.opaque[n] === 1;
      if (joins(get(0, 0, -1))) out.push(box(7, 0, 0, 9, 16, 7));
      if (joins(get(1, 0, 0))) out.push(box(9, 0, 7, 16, 16, 9));
      if (joins(get(0, 0, 1))) out.push(box(7, 0, 9, 9, 16, 16));
      if (joins(get(-1, 0, 0))) out.push(box(0, 0, 7, 7, 16, 9));
      return out;
    }
    case SHAPE.STALK: {
      const out = [box(4, 4, 4, 12, 12, 12)];
      const joins = (n) => ctx.stalk.has(n);
      if (joins(get(0, 1, 0))) out.push(box(4, 12, 4, 12, 16, 12));
      if (joins(get(0, -1, 0)) || get(0, -1, 0) === ctx.id('duskstone')) out.push(box(4, 0, 4, 12, 4, 12));
      if (joins(get(0, 0, -1))) out.push(box(4, 4, 0, 12, 12, 4));
      if (joins(get(1, 0, 0))) out.push(box(12, 4, 4, 16, 12, 12));
      if (joins(get(0, 0, 1))) out.push(box(4, 4, 12, 12, 12, 16));
      if (joins(get(-1, 0, 0))) out.push(box(0, 4, 4, 4, 12, 12));
      return out;
    }
    case SHAPE.CAKE: {
      const bites = Math.min(6, meta & 7);
      const t = [ctx.tex('cake_top'), ctx.tex('cake_bottom'), ctx.tex('cake_side'), bites ? ctx.tex('cake_inner') : ctx.tex('cake_side'), ctx.tex('cake_side'), ctx.tex('cake_side')];
      return [box(1 + bites * 2, 0, 1, 15, 8, 15, t)];
    }
    case SHAPE.LANTERN: {
      const hang = meta & 1, o = hang ? 1 : 0;
      const lt = ctx.tex('lantern');
      const uo = [[-5, -5], [-5, -5], [0, 0], [0, 0], [0, 0], [0, 0]];
      const out = [
        { b: [5, o, 5, 11, 7 + o, 11], t: all6(lt), r: null, uo },
        { b: [6, 7 + o, 6, 10, 9 + o, 10], t: all6(lt), r: null, uo: [[-6, -6], [-6, -6], [0, 0], [0, 0], [0, 0], [0, 0]] },
      ];
      if (hang) out.push(box(7, 10, 7, 9, 16, 9, all6(ctx.tex('chain'))));
      return out;
    }
    case SHAPE.SIGN: {
      if (id === ctx.id('oak_wall_sign')) return [{ b: rot([0, 4, 14, 16, 12, 16], meta & 3), t: null, r: null }];
      return [box(4, 0, 4, 12, 16, 12)];
    }
    case SHAPE.HOPPER: {
      const f = meta & 7;
      const out = [box(0, 10, 0, 16, 16, 16), box(4, 4, 4, 12, 10, 12)];
      const spout = { 1: [6, 0, 6, 10, 4, 10], 2: [12, 4, 6, 16, 8, 10], 3: [0, 4, 6, 4, 8, 10], 4: [6, 4, 12, 10, 8, 16], 5: [6, 4, 0, 10, 8, 4] }[f] || [6, 0, 6, 10, 4, 10];
      out.push(box(...spout));
      return out;
    }
    case SHAPE.ROD: {
      const f = meta & 7;
      const fn = (p) => facingPoint(p, f);
      const t = all6(ctx.tex('glow_rod'));
      return [orientBox([7, 1, 7, 9, 16, 9], t, fn, 'f6' + f), orientBox([6, 0, 6, 10, 1, 10], t, fn, 'f6' + f)];
    }
    case SHAPE.COMPARATOR: {
      const f = meta & 3, sub = meta & 4, on = meta & 8;
      const fn = (p) => rotY(p, f);
      const top = on ? ctx.tex('comparator_on') : ctx.tex('comparator');
      const st = ctx.tex('stone');
      const torch = (lit) => {
        const sd = ctx.tex(lit ? 'spark_torch' : 'spark_torch_off'), tt = ctx.tex(lit ? 'spark_torch_top' : 'spark_torch_top_off');
        return [tt, sd, sd, sd, sd, sd];
      };
      // two input torches at the back, the mode torch at the front (lit in subtract mode)
      return [
        orientBox([0, 0, 0, 16, 2, 16], [top, st, st, st, st, st], fn, 'ry' + f),
        orientBox([3, 2, 11, 5, 7, 13], torch(on), fn, 'ry' + f),
        orientBox([11, 2, 11, 13, 7, 13], torch(on), fn, 'ry' + f),
        orientBox([7, 2, 2, 9, sub ? 6 : 5, 4], torch(sub), fn, 'ry' + f),
      ];
    }
    case SHAPE.ANVIL: {
      const f = meta & 3;
      const fn = (p) => rotY(p, f);
      const top = ctx.tex('anvil_top'), side = ctx.tex('anvil_side');
      const t = [top, side, side, side, side, side], s6 = all6(side);
      return [
        orientBox([2, 0, 2, 14, 4, 14], s6, fn, 'ry' + f),
        orientBox([4, 4, 3, 12, 5, 13], s6, fn, 'ry' + f),
        orientBox([6, 5, 4, 10, 10, 12], s6, fn, 'ry' + f),
        orientBox([3, 10, 0, 13, 16, 16], t, fn, 'ry' + f),
      ];
    }
    case SHAPE.BEACON: {
      const glass = all6(ctx.tex('glass')), obs = all6(ctx.tex('obsidian')), core = all6(ctx.tex('beacon_core'));
      return [box(0, 0, 0, 16, 16, 16, glass), box(2, 1, 2, 14, 3, 14, obs), box(3, 3, 3, 13, 13, 13, core)];
    }
    case SHAPE.BANNER: {
      // the cloth is drawn separately (scene.js) from the banner's block entity
      const pole = all6(ctx.tex('banner_pole'));
      if (id === ctx.id('wall_banner')) return [{ b: rot([0, 14, 13, 16, 16, 15], meta & 3), t: pole, r: null }];
      return [box(7, 0, 7, 9, 16, 9, pole)]; // the upper pole and crossbar are drawn with the cloth
    }
    case SHAPE.CAULDRON: {
      const side = ctx.tex('cauldron_side'), top = ctx.tex('cauldron_top'), inner = ctx.tex('cauldron_inner'), bot = ctx.tex('cauldron_bottom');
      const wall = [top, bot, side, inner, side, side];
      const out = [
        box(0, 3, 0, 16, 16, 2, [top, bot, side, side, side, inner]), box(0, 3, 14, 16, 16, 16, [top, bot, side, side, inner, side]),
        box(0, 3, 2, 2, 16, 14, [top, bot, inner, side, side, side]), box(14, 3, 2, 16, 16, 14, [top, bot, side, inner, side, side]),
        box(2, 3, 2, 14, 4, 14, [inner, bot, inner, inner, inner, inner]),
        box(0, 0, 0, 4, 3, 2, all6(side)), box(12, 0, 0, 16, 3, 2, all6(side)), box(0, 0, 14, 4, 3, 16, all6(side)), box(12, 0, 14, 16, 3, 16, all6(side)),
        box(0, 0, 2, 2, 3, 4, all6(side)), box(14, 0, 2, 16, 3, 4, all6(side)), box(0, 0, 12, 2, 3, 14, all6(side)), box(14, 0, 12, 16, 3, 14, all6(side)),
      ];
      void wall;
      const lvl = meta & 3;
      if (lvl) out.push(box(2, 4, 2, 14, [0, 8, 11, 15][lvl], 14, all6(ctx.tex('cauldron_water'))));
      return out;
    }
    case SHAPE.EGG:
      return [[6, 15, 6, 10, 16, 10], [5, 14, 5, 11, 15, 11], [4, 13, 4, 12, 14, 12], [3, 11, 3, 13, 13, 13], [2, 8, 2, 14, 11, 14], [1, 3, 1, 15, 8, 15], [2, 1, 2, 14, 3, 14], [3, 0, 3, 13, 1, 13]].map((b) => box(...b));
    default: return null;
  }
}

// Collision boxes in block units (fences and gates are 1.5 blocks tall).
export function collisionBoxes(ctx, id, meta, get) {
  const kind = ctx.shape[id];
  if (kind === SHAPE.FENCE) {
    const out = [[6 / 16, 0, 6 / 16, 10 / 16, 1.5, 10 / 16]];
    const arms = [[[0, 0, -1], [6, 0, 10]], [[1, 0, 0], [10, 6, 16]], [[0, 0, 1], [6, 10, 16]], [[-1, 0, 0], [0, 6, 10]]];
    for (const [[dx, dy, dz], a] of arms) {
      if (!connectsFence(get(dx, dy, dz), ctx.fences, ctx.opaque)) continue;
      if (dz) out.push([6 / 16, 0, (dz < 0 ? 0 : 10) / 16, 10 / 16, 1.5, (dz < 0 ? 6 : 16) / 16]);
      else out.push([(dx < 0 ? 0 : 10) / 16, 0, 6 / 16, (dx < 0 ? 6 : 16) / 16, 1.5, 10 / 16]);
      void a;
    }
    return out;
  }
  if (kind === SHAPE.GATE) {
    if (meta & 4) return [];
    const r = rot([0, 0, 6, 16, 24, 10], meta & 3);
    return [r.map((v) => v / 16)];
  }
  if (kind === SHAPE.SINK14) return [[0, 0, 0, 1, 14 / 16, 1]];
  if (kind === SHAPE.PANE) {
    // thin full-height bars along each connection
    return shapeBoxes(ctx, id, meta, get).map((b) => b.b.map((v) => v / 16));
  }
  const boxes = shapeBoxes(ctx, id, meta, get);
  if (!boxes) return null;
  return boxes.filter((b) => b.b).map((b) => b.b.map((v) => v / 16));
}

// Bounding box of all parts, for the selection outline (block units).
export function unionBox(boxes) {
  const u = [1, 1, 1, 0, 0, 0];
  for (const bb of boxes) {
    if (bb.pts) continue;
    const b = bb.b || bb;
    const s = bb.b ? 1 / 16 : 1;
    u[0] = Math.min(u[0], b[0] * s); u[1] = Math.min(u[1], b[1] * s); u[2] = Math.min(u[2], b[2] * s);
    u[3] = Math.max(u[3], b[3] * s); u[4] = Math.max(u[4], b[4] * s); u[5] = Math.max(u[5], b[5] * s);
  }
  return u;
}
