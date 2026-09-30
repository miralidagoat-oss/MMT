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
};

// Door meta: bits 0-1 facing, bit 2 open, bit 3 upper half, bit 4 hinge on the right.
export const DOOR_OPEN = 4, DOOR_UPPER = 8, DOOR_RIGHT = 16;
// Gate meta: bits 0-1 facing, bit 2 open.  Stairs: bits 0-1 facing, bit 2 upside down.
// Slab: bit 0 top half.  Bed: bits 0-1 facing (foot -> head), bit 2 head part.
export const BED_HEAD = 4;

const box = (x0, y0, z0, x1, y1, z1, t = null, r = null) => ({ b: [x0, y0, z0, x1, y1, z1], t, r });

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
  const boxes = shapeBoxes(ctx, id, meta, get);
  if (!boxes) return null;
  return boxes.map((b) => b.b.map((v) => v / 16));
}

// Bounding box of all parts, for the selection outline (block units).
export function unionBox(boxes) {
  const u = [1, 1, 1, 0, 0, 0];
  for (const bb of boxes) {
    const b = bb.b || bb;
    const s = bb.b ? 1 / 16 : 1;
    u[0] = Math.min(u[0], b[0] * s); u[1] = Math.min(u[1], b[1] * s); u[2] = Math.min(u[2], b[2] * s);
    u[3] = Math.max(u[3], b[3] * s); u[4] = Math.max(u[4], b[4] * s); u[5] = Math.max(u[5], b[5] * s);
  }
  return u;
}
