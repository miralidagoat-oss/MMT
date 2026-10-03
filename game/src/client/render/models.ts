/**
 * Procedural low/mid-poly model library (ASSET REPLACEMENT POINT).
 * Each builder returns merged BufferGeometries with per-vertex colors. Replace a
 * builder with a GLTF loader to swap in authored art without touching game code.
 */
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type Part = THREE.BufferGeometry;

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();

/** Bake color + transform into a geometry part. */
export function part(g: THREE.BufferGeometry, color: THREE.ColorRepresentation, pos: [number, number, number] = [0, 0, 0], rot: [number, number, number] = [0, 0, 0], scale: [number, number, number] = [1, 1, 1], jitter = 0, seed = 1): Part {
  const geo = g.index ? g.toNonIndexed() : g.clone();
  if (!geo.getAttribute('uv')) {
    const n = geo.getAttribute('position').count;
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  tmpE.set(rot[0], rot[1], rot[2]);
  tmpQ.setFromEuler(tmpE);
  tmpM.compose(new THREE.Vector3(...pos), tmpQ, new THREE.Vector3(...scale));
  geo.applyMatrix4(tmpM);
  const c = new THREE.Color(color);
  const n = geo.getAttribute('position').count;
  const cols = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const j = jitter ? 1 + (rand(seed * 977 + Math.floor(i / 3)) - 0.5) * jitter : 1;
    cols[i * 3] = c.r * j; cols[i * 3 + 1] = c.g * j; cols[i * 3 + 2] = c.b * j;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(k)) geo.deleteAttribute(k);
  return geo;
}

export function merge(parts: Part[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false)!;
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

function rand(s: number): number {
  const x = Math.sin(s * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/** Displace a sphere-ish geometry with noise for rocks/coral. */
function vnoise3(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const h = (a: number, b: number, c: number) => { const t = Math.sin(a * 127.1 + b * 311.7 + c * 74.7 + seed * 19.19) * 43758.5453; return t - Math.floor(t); };
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  return l(
    l(l(h(xi, yi, zi), h(xi + 1, yi, zi), u), l(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), u), v),
    l(l(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), u), l(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), u), v), w) * 2 - 1;
}

/**
 * Weathered stone: fractal noise displacement plus a few planar fracture faces
 * (flattened where a random plane cuts through), so boulders read as rock.
 */
function rockShape(g: THREE.BufferGeometry, seed: number, amount = 0.28, cuts = 4): THREE.BufferGeometry {
  const geo = mergeVertices(g.deleteAttribute('normal').deleteAttribute('uv') && g);
  const p = geo.getAttribute('position') as THREE.BufferAttribute;
  const planes: { n: THREE.Vector3; d: number }[] = [];
  for (let i = 0; i < cuts; i++) {
    const n = new THREE.Vector3(rand(seed * 7 + i) - 0.5, (rand(seed * 7 + i + 50) - 0.3) * 0.8, rand(seed * 7 + i + 99) - 0.5).normalize();
    planes.push({ n, d: 0.72 + rand(seed + i * 3) * 0.2 });
  }
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.set(p.getX(i), p.getY(i), p.getZ(i));
    const len = v.length() || 1;
    const dir = v.clone().divideScalar(len);
    let n = 0, amp = 1, f = 1.3;
    for (let o = 0; o < 4; o++) { n += vnoise3(dir.x * f, dir.y * f, dir.z * f, seed + o * 13) * amp; amp *= 0.5; f *= 2.1; }
    let r = len * (1 + n * amount);
    for (const pl of planes) { const k = dir.dot(pl.n); if (k > 0.05) r = Math.min(r, (pl.d * len) / k); }
    v.copy(dir).multiplyScalar(r);
    if (v.y < 0) v.y *= 0.35;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo.toNonIndexed();
}

function lumpy(g: THREE.BufferGeometry, amount: number, seed: number, flatBottom = true): THREE.BufferGeometry {
  const geo = mergeVertices(g.deleteAttribute('normal').deleteAttribute('uv') && g);
  const p = geo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n = Math.sin(x * 3.1 + seed) * Math.cos(z * 2.7 - seed) * 0.5 + Math.sin(y * 4.3 + x * 1.7 + seed * 2) * 0.35 + (rand(i + seed * 31) - 0.5) * 0.3;
    const k = 1 + n * amount;
    p.setXYZ(i, x * k, flatBottom && y < 0 ? y * 0.35 : y * k, z * k);
  }
  geo.computeVertexNormals();
  return geo.toNonIndexed();
}

// ============================================================ vegetation
export interface PlantModel { solid: THREE.BufferGeometry; leaves?: THREE.BufferGeometry; leafTex?: 'palm' | 'broad' | 'grass' }

export function palmTree(seed: number): PlantModel {
  const parts: Part[] = [];
  const segs = 7;
  const height = 8 + rand(seed) * 2;
  const lean = 0.35 + rand(seed + 1) * 0.5;
  let prev = new THREE.Vector3(0, 0, 0);
  const tip = new THREE.Vector3();
  for (let i = 0; i < segs; i++) {
    const t0 = i / segs, t1 = (i + 1) / segs;
    const p1 = new THREE.Vector3(Math.sin(t1 * 1.4) * lean * height * 0.18, t1 * height, 0);
    const len = p1.distanceTo(prev);
    const r0 = 0.28 - t0 * 0.12, r1 = 0.28 - t1 * 0.12;
    const cyl = new THREE.CylinderGeometry(r1, r0 * 1.06, len * 1.02, 9, 1, true);
    const dir = p1.clone().sub(prev).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    const e = new THREE.Euler().setFromQuaternion(q);
    const mid = prev.clone().add(p1).multiplyScalar(0.5);
    parts.push(part(cyl, i % 2 ? '#7d6446' : '#8b7152', [mid.x, mid.y, mid.z], [e.x, e.y, e.z], [1, 1, 1], 0.12, seed + i));
    // ring scar
    parts.push(part(new THREE.TorusGeometry(r1 * 1.02, 0.03, 4, 9), '#5c4632', [p1.x, p1.y, p1.z], [Math.PI / 2 + e.x, e.y, e.z]));
    prev = p1;
  }
  tip.copy(prev);
  // coconuts
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + seed;
    parts.push(part(new THREE.SphereGeometry(0.16, 7, 5), '#5a4123', [tip.x + Math.cos(a) * 0.22, tip.y - 0.25, tip.z + Math.sin(a) * 0.22], [0, 0, 0], [1, 1.1, 1], 0.2, seed + 50 + i));
  }
  // fronds: bent quad strips with palm leaf texture
  const leaves: Part[] = [];
  const fronds = 9;
  for (let i = 0; i < fronds; i++) {
    const a = (i / fronds) * Math.PI * 2 + rand(seed + i) * 0.4;
    const len = 3.6 + rand(seed + 10 + i) * 1.2;
    const droop = 0.5 + rand(seed + 20 + i) * 0.5;
    const segN = 6;
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    for (let s = 0; s <= segN; s++) {
      const t = s / segN;
      const along = t * len;
      const y = Math.sin(t * 1.2) * 0.9 - t * t * droop * 2.6;
      const w = 1.0;
      const cx = Math.cos(a) * along, cz = Math.sin(a) * along;
      const px = -Math.sin(a) * w * 0.5, pz = Math.cos(a) * w * 0.5;
      const sag = -t * 0.25;
      pos.push(tip.x + cx - px, tip.y + y + sag, tip.z + cz - pz, tip.x + cx + px, tip.y + y + sag, tip.z + cz + pz);
      uv.push(0, t, 1, t);
      if (s < segN) { const b = s * 2; idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    leaves.push(part(g, '#ffffff', [0, 0, 0], [0, 0, 0], [1, 1, 1], 0.15, seed + 30 + i));
  }
  return { solid: merge(parts), leaves: merge(leaves), leafTex: 'palm' };
}

export function hardwoodTree(seed: number): PlantModel {
  const parts: Part[] = [];
  const h = 7 + rand(seed) * 3;
  parts.push(part(new THREE.CylinderGeometry(0.32, 0.55, h, 10, 4), '#5d4836', [0, h / 2, 0], [0, 0, 0], [1, 1, 1], 0.15, seed));
  // buttress roots
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + seed;
    parts.push(part(new THREE.BoxGeometry(0.16, 1.1, 1.0), '#54402f', [Math.cos(a) * 0.45, 0.45, Math.sin(a) * 0.45], [0, -a, 0.25]));
  }
  // branches
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + seed * 0.7;
    parts.push(part(new THREE.CylinderGeometry(0.08, 0.16, 2.6, 6), '#5d4836', [Math.cos(a) * 0.9, h * 0.8, Math.sin(a) * 0.9], [Math.sin(a) * 0.9, 0, -Math.cos(a) * 0.9]));
  }
  const leaves: Part[] = [];
  const clusters = 14;
  for (let i = 0; i < clusters; i++) {
    const a = rand(seed + i) * Math.PI * 2, r = 0.5 + rand(seed + i + 40) * 2.6;
    const y = h * 0.75 + rand(seed + i + 80) * 3;
    const sz = 2.2 + rand(seed + i + 120) * 1.4;
    for (let k = 0; k < 3; k++) {
      leaves.push(part(new THREE.PlaneGeometry(sz, sz), '#ffffff', [Math.cos(a) * r, y, Math.sin(a) * r], [rand(i + k) * 1.2 - 0.6, (k / 3) * Math.PI + a, rand(i * 3 + k) * 0.6], [1, 1, 1], 0.2, seed + i * 7 + k));
    }
  }
  return { solid: merge(parts), leaves: merge(leaves), leafTex: 'broad' };
}

function cardBush(seed: number, radius: number, height: number, cards: number, tint: string): THREE.BufferGeometry {
  const leaves: Part[] = [];
  for (let i = 0; i < cards; i++) {
    const a = (i / cards) * Math.PI + rand(seed + i) * 0.5;
    const s = radius * (1.4 + rand(seed + i + 9) * 0.6);
    leaves.push(part(new THREE.PlaneGeometry(s, height), tint, [(rand(seed + i * 3) - 0.5) * radius * 0.6, height / 2, (rand(seed + i * 5) - 0.5) * radius * 0.6], [0, a, 0], [1, 1, 1], 0.2, seed + i));
  }
  return merge(leaves);
}

export function plantModel(type: string, seed: number): PlantModel {
  switch (type) {
    case 'palm': return palmTree(seed);
    case 'hardwood': return hardwoodTree(seed);
    case 'fiber_bush': return { solid: merge([part(new THREE.ConeGeometry(0.08, 0.4, 4), '#3d5a22', [0, 0.2, 0])]), leaves: cardBush(seed, 0.6, 1.1, 4, '#cfe0a0'), leafTex: 'grass' };
    case 'berry_bush': {
      const berries: Part[] = [];
      for (let i = 0; i < 14; i++) berries.push(part(new THREE.SphereGeometry(0.05, 5, 4), '#c2324a', [(rand(seed + i) - 0.5) * 1, 0.35 + rand(seed + i + 3) * 0.6, (rand(seed + i + 7) - 0.5) * 1]));
      return { solid: merge(berries), leaves: cardBush(seed, 0.7, 1.1, 4, '#ffffff'), leafTex: 'broad' };
    }
    case 'wild_taro': {
      const p: Part[] = [];
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        p.push(part(new THREE.CylinderGeometry(0.02, 0.03, 0.8, 4), '#5c7a3a', [Math.cos(a) * 0.15, 0.4, Math.sin(a) * 0.15], [Math.sin(a) * 0.3, 0, -Math.cos(a) * 0.3]));
        p.push(part(new THREE.CircleGeometry(0.35, 8), '#3f7a2a', [Math.cos(a) * 0.35, 0.8, Math.sin(a) * 0.35], [-1.1, a, 0], [1, 1.4, 1], 0.2, seed + i));
      }
      return { solid: merge(p) };
    }
    case 'wild_aloe': {
      const p: Part[] = [];
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2;
        p.push(part(new THREE.ConeGeometry(0.06, 0.65, 4), '#6fae7e', [Math.cos(a) * 0.12, 0.3, Math.sin(a) * 0.12], [Math.sin(a) * 0.6, 0, -Math.cos(a) * 0.6], [1, 1, 0.5], 0.15, seed + i));
      }
      return { solid: merge(p) };
    }
    case 'wild_flax': return { solid: merge([part(new THREE.CylinderGeometry(0.02, 0.02, 0.1, 3), '#555', [0, 0.05, 0])]), leaves: cardBush(seed, 0.4, 0.9, 3, '#e6f0b0'), leafTex: 'grass' };
    case 'rock': {
      // a main boulder with a smaller one leaning against it
      const p: Part[] = [part(rockShape(new THREE.IcosahedronGeometry(1.1, 4), seed), '#8f8b82', [0, 0.45, 0], [0, rand(seed + 1) * 6.28, 0], [1.15, 0.78, 1], 0.08, seed)];
      if (rand(seed + 9) > 0.35) p.push(part(rockShape(new THREE.IcosahedronGeometry(0.45, 3), seed + 5, 0.3, 3), '#85827a', [0.95, 0.15, 0.35], [0, rand(seed + 2) * 6.28, 0], [1, 0.8, 1], 0.08, seed + 5));
      return { solid: merge(p) };
    }
    case 'iron_vein': {
      const p = [part(rockShape(new THREE.IcosahedronGeometry(1.2, 4), seed, 0.32), '#6e5a50', [0, 0.55, 0], [0, rand(seed) * 3, 0], [1, 0.8, 1], 0.1, seed)];
      for (let i = 0; i < 6; i++) p.push(part(new THREE.IcosahedronGeometry(0.22, 0), '#a8502c', [(rand(seed + i) - 0.5) * 1.6, 0.6 + rand(seed + i + 2) * 0.6, (rand(seed + i + 4) - 0.5) * 1.6]));
      return { solid: merge(p) };
    }
    case 'obsidian_rock': {
      const p: Part[] = [];
      for (let i = 0; i < 5; i++) p.push(part(new THREE.ConeGeometry(0.35, 2 + rand(seed + i), 5), '#1d1730', [(rand(seed + i) - 0.5) * 1.2, 0.9, (rand(seed + i + 3) - 0.5) * 1.2], [(rand(seed + i + 5) - 0.5) * 0.6, rand(i) * 3, (rand(seed + i + 6) - 0.5) * 0.6]));
      return { solid: merge(p) };
    }
    case 'clay_bank': return { solid: merge([part(lumpy(new THREE.SphereGeometry(1.1, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), 0.15, seed, false), '#a35f3e', [0, -0.2, 0], [0, 0, 0], [1.3, 0.45, 1.1], 0.12, seed)]) };
    case 'loose_stone': return { solid: merge([part(rockShape(new THREE.IcosahedronGeometry(0.18, 2), seed, 0.25, 3), '#85827a', [0, 0.07, 0], [0, 0, 0], [1.2, 0.7, 1])]) };
    case 'loose_stick': return { solid: merge([part(new THREE.CylinderGeometry(0.03, 0.04, 1.1, 5), '#7a5a38', [0, 0.04, 0], [0, 0, Math.PI / 2]), part(new THREE.CylinderGeometry(0.02, 0.02, 0.4, 4), '#7a5a38', [0.2, 0.06, 0.1], [0.6, 0, Math.PI / 2])]) };
    case 'driftwood': return { solid: merge([part(new THREE.CylinderGeometry(0.12, 0.18, 2.2, 7), '#b8a88e', [0, 0.12, 0], [0, 0, Math.PI / 2], [1, 1, 1], 0.1, seed), part(new THREE.CylinderGeometry(0.05, 0.08, 0.9, 5), '#b0a086', [0.4, 0.2, 0.3], [0.8, 0.4, Math.PI / 2])]) };
    case 'beach_shell': return { solid: merge([part(new THREE.ConeGeometry(0.1, 0.18, 7), '#f1e1c8', [0, 0.05, 0], [Math.PI / 2, 0, 0], [1, 1, 0.5])]) };
    case 'fallen_coconut': return { solid: merge([part(new THREE.SphereGeometry(0.17, 8, 6), '#5a4123', [0, 0.15, 0], [0, 0, 0], [1, 1.15, 1])]) };
    case 'coral': {
      const p: Part[] = [];
      const cols = ['#f0806a', '#e2a13c', '#c45bb0', '#ef6f8f', '#7fc8b5'];
      for (let i = 0; i < 6; i++) p.push(part(lumpy(new THREE.IcosahedronGeometry(0.35 + rand(seed + i) * 0.3, 1), 0.4, seed + i), cols[(seed + i) % cols.length]!, [(rand(seed + i) - 0.5) * 1.2, 0.3 + rand(seed + i + 1) * 0.4, (rand(seed + i + 2) - 0.5) * 1.2], [0, 0, 0], [1, 1.3, 1], 0.2, seed + i));
      for (let i = 0; i < 5; i++) p.push(part(new THREE.CylinderGeometry(0.04, 0.07, 0.9, 5), '#f4b183', [(rand(seed + i + 9) - 0.5) * 1.4, 0.45, (rand(seed + i + 11) - 0.5) * 1.4], [(rand(i) - 0.5), 0, (rand(i + 1) - 0.5)]));
      return { solid: merge(p) };
    }
    case 'kelp': {
      const p: Part[] = [];
      for (let i = 0; i < 4; i++) p.push(part(new THREE.PlaneGeometry(0.25, 3 + rand(seed + i) * 1.5, 1, 6), '#2f6b3d', [(rand(seed + i) - 0.5) * 0.6, 1.6, (rand(seed + i + 2) - 0.5) * 0.6], [0, rand(seed + i + 3) * 3, 0], [1, 1, 1], 0.2, seed + i));
      return { solid: merge(p) };
    }
    case 'oyster': {
      const p: Part[] = [];
      for (let i = 0; i < 5; i++) p.push(part(new THREE.SphereGeometry(0.15, 6, 3, 0, Math.PI * 2, 0, Math.PI / 2), '#6c7268', [(rand(seed + i) - 0.5) * 0.8, 0, (rand(seed + i + 1) - 0.5) * 0.8], [0, 0, 0], [1.3, 0.5, 1]));
      return { solid: merge(p) };
    }
    case 'scrap_pile': {
      const p: Part[] = [];
      for (let i = 0; i < 6; i++) p.push(part(new THREE.BoxGeometry(0.4 + rand(seed + i) * 0.8, 0.08, 0.3 + rand(seed + i + 1) * 0.6), i % 2 ? '#7c8a91' : '#8a5a3a', [(rand(seed + i + 2) - 0.5) * 1.4, 0.15 + i * 0.07, (rand(seed + i + 3) - 0.5) * 1.4], [rand(i) - 0.5, rand(i + 1) * 3, rand(i + 2) - 0.5]));
      p.push(part(new THREE.CylinderGeometry(0.25, 0.25, 0.7, 8), '#4d5a60', [0.3, 0.3, -0.2], [0, 0, 1.4]));
      return { solid: merge(p) };
    }
  }
  return { solid: merge([part(new THREE.BoxGeometry(0.5, 0.5, 0.5), '#ff00ff', [0, 0.25, 0])]) };
}

// ============================================================ creatures
export function creatureModel(kind: string): THREE.BufferGeometry {
  const p: Part[] = [];
  switch (kind) {
    case 'crab':
      p.push(part(new THREE.SphereGeometry(0.25, 8, 5), '#d0452c', [0, 0.18, 0], [0, 0, 0], [1.3, 0.55, 1]));
      for (const s of [-1, 1]) {
        p.push(part(new THREE.SphereGeometry(0.1, 6, 4), '#e05a3a', [s * 0.32, 0.18, 0.22], [0, 0, 0], [1.2, 0.7, 1]));
        for (let i = 0; i < 3; i++) p.push(part(new THREE.CylinderGeometry(0.02, 0.02, 0.32), '#b03a22', [s * 0.28, 0.1, -0.1 + i * 0.1], [0, 0, s * 1.0]));
        p.push(part(new THREE.SphereGeometry(0.03, 5, 4), '#111', [s * 0.07, 0.3, 0.18]));
      }
      break;
    case 'boar':
      p.push(part(new THREE.SphereGeometry(0.5, 10, 8), '#4a3a30', [0, 0.65, 0], [0, 0, 0], [0.8, 0.75, 1.35], 0.1, 3));
      p.push(part(new THREE.SphereGeometry(0.3, 8, 6), '#3e3028', [0, 0.65, 0.65], [0, 0, 0], [0.9, 0.9, 1.2]));
      p.push(part(new THREE.CylinderGeometry(0.1, 0.12, 0.15, 8), '#7a5a50', [0, 0.6, 0.98], [Math.PI / 2, 0, 0]));
      for (const s of [-1, 1]) {
        p.push(part(new THREE.ConeGeometry(0.03, 0.18, 4), '#eee8d0', [s * 0.12, 0.56, 0.9], [-0.6, 0, s * 0.4]));
        p.push(part(new THREE.ConeGeometry(0.07, 0.15, 4), '#3e3028', [s * 0.15, 0.88, 0.55], [0.3, 0, 0]));
        p.push(part(new THREE.SphereGeometry(0.03, 5, 4), '#111', [s * 0.13, 0.74, 0.86]));
        for (const z of [-0.35, 0.35]) p.push(part(new THREE.CylinderGeometry(0.06, 0.05, 0.4, 6), '#2e241e', [s * 0.2, 0.2, z]));
      }
      p.push(part(new THREE.BoxGeometry(0.06, 0.25, 0.9), '#2a201a', [0, 1.0, -0.05])); // mane
      break;
    case 'snake': {
      // a smooth S-curved body (overlapping segments), banded, tapering to the tail
      const n = 30;
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const band = Math.floor(t * 14) % 3 === 0;
        p.push(part(new THREE.SphereGeometry(0.062 * (1 - t * 0.75), 8, 6), band ? '#d9b93a' : '#2f4220', [Math.sin(t * Math.PI * 2.2) * 0.22, 0.055, 0.45 - t * 1.25], [0, 0, 0], [1, 0.75, 1.5]));
      }
      p.push(part(new THREE.SphereGeometry(0.08, 10, 8), '#2f4220', [0, 0.07, 0.52], [0, 0, 0], [1, 0.62, 1.45]));
      for (const sx of [-1, 1]) p.push(part(new THREE.SphereGeometry(0.014, 6, 4), '#e8c84a', [sx * 0.045, 0.1, 0.6]));
      break;
    }
    case 'fish':
      p.push(part(new THREE.SphereGeometry(0.15, 8, 6), '#4fa6d8', [0, 0, 0], [0, 0, 0], [0.5, 0.9, 1.6], 0.15, 5));
      p.push(part(new THREE.ConeGeometry(0.12, 0.18, 4), '#ffd23f', [0, 0, -0.3], [-Math.PI / 2, 0, 0], [0.4, 1, 1.2]));
      p.push(part(new THREE.ConeGeometry(0.05, 0.12, 3), '#ffd23f', [0, 0.14, 0], [0, 0, 0], [0.3, 1, 1]));
      break;
    case 'ray':
      p.push(part(new THREE.CircleGeometry(0.8, 12), '#5e6a6e', [0, 0.05, 0], [-Math.PI / 2, 0, 0], [1.3, 1, 1], 0.1, 7));
      p.push(part(new THREE.CircleGeometry(0.8, 12), '#d8d2c8', [0, 0.04, 0], [Math.PI / 2, 0, 0], [1.3, 1, 1]));
      p.push(part(new THREE.CylinderGeometry(0.015, 0.03, 1.4, 4), '#3e4648', [0, 0.05, -1.3], [Math.PI / 2, 0, 0]));
      for (let i = 0; i < 6; i++) p.push(part(new THREE.CircleGeometry(0.06, 6), '#f4f0e6', [(rand(i) - 0.5) * 1.2, 0.06, (rand(i + 9) - 0.5) * 0.8], [-Math.PI / 2, 0, 0]));
      break;
    case 'shark':
      p.push(part(new THREE.SphereGeometry(0.6, 12, 8), '#6b7d8a', [0, 0, 0], [0, 0, 0], [0.75, 0.85, 3.2], 0.06, 9));
      p.push(part(new THREE.SphereGeometry(0.55, 12, 8), '#e4e6e2', [0, -0.18, 0.1], [0, 0, 0], [0.7, 0.55, 2.9]));
      p.push(part(new THREE.ConeGeometry(0.35, 0.9, 4), '#5c6d79', [0, 0.75, 0.1], [-0.3, 0, 0], [0.2, 1, 1]));
      p.push(part(new THREE.ConeGeometry(0.45, 1.1, 4), '#5c6d79', [0, 0.35, -2.2], [-0.9, 0, 0], [0.15, 1, 1]));
      p.push(part(new THREE.ConeGeometry(0.3, 0.7, 4), '#5c6d79', [0, -0.3, -2.1], [-2.2, 0, 0], [0.15, 1, 1]));
      for (const s of [-1, 1]) {
        p.push(part(new THREE.ConeGeometry(0.25, 0.9, 4), '#5c6d79', [s * 0.55, -0.25, 0.5], [0.4, 0, s * 1.9], [0.15, 1, 1]));
        p.push(part(new THREE.SphereGeometry(0.05, 5, 4), '#050505', [s * 0.3, 0.08, 1.45]));
      }
      p.push(part(new THREE.BoxGeometry(0.5, 0.04, 0.2), '#2a1d1d', [0, -0.25, 1.55]));
      break;
    case 'gull':
      p.push(part(new THREE.SphereGeometry(0.15, 7, 5), '#f4f4f0', [0, 0, 0], [0, 0, 0], [0.8, 0.8, 1.8]));
      p.push(part(new THREE.SphereGeometry(0.09, 6, 4), '#f4f4f0', [0, 0.08, 0.25]));
      p.push(part(new THREE.ConeGeometry(0.03, 0.12, 4), '#f0b030', [0, 0.06, 0.38], [Math.PI / 2, 0, 0]));
      for (const s of [-1, 1]) p.push(part(new THREE.BoxGeometry(0.7, 0.02, 0.22), '#d8dadc', [s * 0.4, 0.04, 0], [0, 0, s * 0.2]));
      p.push(part(new THREE.BoxGeometry(0.16, 0.02, 0.18), '#555', [0, 0.02, -0.3]));
      break;
  }
  return merge(p);
}

// ============================================================ humanoid (players)
export interface Humanoid {
  root: THREE.Group;
  body: THREE.Mesh; head: THREE.Mesh;
  armL: THREE.Group; armR: THREE.Group; legL: THREE.Group; legR: THREE.Group;
  hand: THREE.Group;
}

const SKIN_TONES = ['#f1c7a5', '#e0ac85', '#c99a76', '#a8754f', '#8d5a3b', '#5e3b26'];
const HAIR_TONES = ['#1f1611', '#3a2416', '#5a3a1e', '#8a5a2b', '#c49a5a', '#2b2b2b', '#6b2f1a'];

/** A castaway: shirt, shorts, bare forearms and shins, sandals, a face. Varies by `seed`. */
export function humanoid(shirt: string, seed = 0): Humanoid {
  const rnd = (k: number) => { const x = Math.sin((seed + 1) * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x); };
  const skinCol = SKIN_TONES[Math.floor(rnd(1) * SKIN_TONES.length)]!;
  const hairCol = HAIR_TONES[Math.floor(rnd(2) * HAIR_TONES.length)]!;
  const pantsCol = ['#3b4a5a', '#5b5240', '#2f4038', '#6a5a48', '#40384a'][Math.floor(rnd(3) * 5)]!;
  const skin = new THREE.MeshStandardMaterial({ color: skinCol, roughness: 0.7 });
  const cloth = new THREE.MeshStandardMaterial({ color: shirt, roughness: 0.92 });
  const pants = new THREE.MeshStandardMaterial({ color: pantsCol, roughness: 0.95 });
  const dark = new THREE.MeshStandardMaterial({ color: '#2a1d14', roughness: 0.9 });
  const hairMat = new THREE.MeshStandardMaterial({ color: hairCol, roughness: 0.85 });
  const eyeMat = new THREE.MeshStandardMaterial({ color: '#16110d', roughness: 0.3 });
  const shadow = (m: THREE.Mesh) => { m.castShadow = true; return m; };
  const root = new THREE.Group();

  // torso: tapered shirt with rounded shoulders, belt and shorts
  const body = shadow(new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.165, 0.5, 14), cloth));
  body.position.y = 1.2;
  const shoulders = shadow(new THREE.Mesh(new THREE.CapsuleGeometry(0.1, 0.24, 4, 10), cloth));
  shoulders.rotation.z = Math.PI / 2;
  shoulders.position.y = 0.2;
  body.add(shoulders);
  const collar = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.018, 6, 14), cloth);
  collar.rotation.x = Math.PI / 2;
  collar.position.y = 0.27;
  body.add(collar);
  const belt = new THREE.Mesh(new THREE.CylinderGeometry(0.168, 0.168, 0.05, 14), dark);
  belt.position.y = -0.26;
  body.add(belt);
  const hips = shadow(new THREE.Mesh(new THREE.CylinderGeometry(0.168, 0.16, 0.2, 14), pants));
  hips.position.y = -0.37;
  body.add(hips);

  // head: slightly oval with neck, ears, eyes, nose and one of three hair styles
  const head = shadow(new THREE.Mesh(new THREE.SphereGeometry(0.125, 16, 12), skin));
  head.scale.set(1, 1.12, 1.02);
  head.position.y = 1.67;
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.1, 10), skin);
  neck.position.y = -0.13;
  head.add(neck);
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.016, 8, 6), eyeMat);
    eye.position.set(sx * 0.042, 0.015, 0.112);
    head.add(eye);
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.01, 0.01), hairMat);
    brow.position.set(sx * 0.043, 0.045, 0.116);
    head.add(brow);
    const ear = new THREE.Mesh(new THREE.SphereGeometry(0.026, 8, 6), skin);
    ear.scale.set(0.5, 1, 0.8);
    ear.position.set(sx * 0.125, 0, -0.005);
    head.add(ear);
  }
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.018, 0.045, 6), skin);
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, -0.012, 0.13);
  head.add(nose);
  const style = Math.floor(rnd(4) * 3);
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.132, 16, 10, 0, Math.PI * 2, 0, style === 1 ? Math.PI * 0.42 : Math.PI * 0.55), hairMat);
  cap.position.set(0, 0.012, -0.008);
  cap.rotation.x = -0.18;
  head.add(cap);
  if (style === 2) {
    // longer hair down the back
    const back = new THREE.Mesh(new THREE.CapsuleGeometry(0.1, 0.12, 4, 10), hairMat);
    back.position.set(0, -0.06, -0.06);
    back.scale.set(1.15, 1, 0.6);
    head.add(back);
  }
  if (rnd(5) > 0.6) {
    // stubble beard
    const beard = new THREE.Mesh(new THREE.SphereGeometry(0.118, 14, 8, 0, Math.PI * 2, Math.PI * 0.55, Math.PI * 0.35), hairMat);
    beard.position.set(0, -0.005, 0.012);
    head.add(beard);
  }

  // limbs: pivot groups at shoulder / hip; sleeve or shorts above, skin below
  const limb = (upper: THREE.Material, lower: THREE.Material, len: number, r: number, end: THREE.Mesh) => {
    const g = new THREE.Group();
    const half = len / 2;
    const top = shadow(new THREE.Mesh(new THREE.CapsuleGeometry(r * 1.12, half * 0.75, 4, 10), upper));
    top.position.y = -half * 0.45;
    const bot = shadow(new THREE.Mesh(new THREE.CapsuleGeometry(r * 0.88, half * 0.85, 4, 10), lower));
    bot.position.y = -half * 1.35;
    end.position.y = -len - r * 0.2;
    g.add(top, bot, end);
    return g;
  };
  const handMesh = () => { const m = new THREE.Mesh(new THREE.SphereGeometry(0.048, 10, 8), skin); m.scale.set(0.85, 1.1, 0.7); return m; };
  const footMesh = () => { const m = shadow(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.06, 0.24), dark)); m.position.z = 0.05; return m; };
  const armL = limb(cloth, skin, 0.58, 0.058, handMesh()), armR = limb(cloth, skin, 0.58, 0.058, handMesh());
  armL.position.set(-0.27, 1.44, 0); armR.position.set(0.27, 1.44, 0);
  const legL = limb(pants, skin, 0.74, 0.075, footMesh()), legR = limb(pants, skin, 0.74, 0.075, footMesh());
  legL.position.set(-0.1, 0.79, 0); legR.position.set(0.1, 0.79, 0);
  const hand = new THREE.Group();
  hand.position.set(0, -0.6, 0.06);
  armR.add(hand);
  root.add(body, head, armL, armR, legL, legR);
  return { root, body, head, armL, armR, legL, legR, hand };
}

// ============================================================ items (held / dropped)
export function itemModel(id: string, iconColor: string): THREE.BufferGeometry {
  const wood = '#8a6440', stone = '#8d8d86', metal = '#c3c9cf';
  const handle = (len = 0.6) => part(new THREE.CylinderGeometry(0.02, 0.025, len, 6), wood, [0, len / 2, 0]);
  switch (id) {
    case 'stone_axe': case 'metal_axe':
      return merge([handle(0.65), part(new THREE.BoxGeometry(0.06, 0.14, 0.2), id === 'metal_axe' ? metal : stone, [0, 0.58, 0.07]), part(new THREE.TorusGeometry(0.035, 0.012, 4, 8), '#d1b277', [0, 0.55, 0], [Math.PI / 2, 0, 0])]);
    case 'stone_pick': case 'metal_pick':
      return merge([handle(0.65), part(new THREE.ConeGeometry(0.035, 0.28, 5), id === 'metal_pick' ? metal : stone, [0, 0.6, 0.13], [Math.PI / 2, 0, 0]), part(new THREE.ConeGeometry(0.035, 0.22, 5), id === 'metal_pick' ? metal : stone, [0, 0.6, -0.1], [-Math.PI / 2, 0, 0])]);
    case 'build_hammer':
      return merge([handle(0.5), part(new THREE.BoxGeometry(0.1, 0.1, 0.22), stone, [0, 0.5, 0])]);
    case 'crude_spear': case 'harpoon':
      return merge([part(new THREE.CylinderGeometry(0.018, 0.022, 1.7, 6), wood, [0, 0.85, 0]), part(new THREE.ConeGeometry(0.035, 0.22, 5), id === 'harpoon' ? metal : stone, [0, 1.8, 0])]);
    case 'machete':
      return merge([part(new THREE.CylinderGeometry(0.02, 0.022, 0.15, 6), '#6b4527', [0, 0.07, 0]), part(new THREE.BoxGeometry(0.01, 0.45, 0.07), metal, [0, 0.36, 0.01])]);
    case 'bone_knife': case 'sharp_stone':
      return merge([part(new THREE.CylinderGeometry(0.018, 0.02, 0.1, 6), '#d1b277', [0, 0.05, 0]), part(new THREE.ConeGeometry(0.03, 0.2, 3), id === 'sharp_stone' ? stone : '#e8e1cf', [0, 0.2, 0], [0, 0, 0], [1, 1, 0.3])]);
    case 'torch':
      // a stick with a fibre-wrapped, resin-soaked head (charred at the top)
      return merge([
        part(new THREE.CylinderGeometry(0.019, 0.024, 0.52, 7), wood, [0, 0.26, 0]),
        part(new THREE.CylinderGeometry(0.042, 0.032, 0.13, 8), '#6e5434', [0, 0.53, 0]),
        part(new THREE.TorusGeometry(0.037, 0.008, 4, 10), '#a88a55', [0, 0.49, 0], [Math.PI / 2, 0, 0]),
        part(new THREE.TorusGeometry(0.041, 0.008, 4, 10), '#a88a55', [0, 0.55, 0], [Math.PI / 2, 0, 0]),
        part(new THREE.CylinderGeometry(0.03, 0.043, 0.04, 8), '#1d140c', [0, 0.61, 0]),
      ]);
    case 'lantern':
      return merge([part(new THREE.CylinderGeometry(0.06, 0.07, 0.16, 8), '#ffe9a8', [0, 0.1, 0]), part(new THREE.ConeGeometry(0.07, 0.06, 8), metal, [0, 0.21, 0]), part(new THREE.TorusGeometry(0.04, 0.006, 4, 8), metal, [0, 0.27, 0])]);
    case 'fishing_rod':
      return merge([part(new THREE.CylinderGeometry(0.006, 0.018, 1.6, 5), wood, [0, 0.8, 0]), part(new THREE.TorusGeometry(0.035, 0.012, 4, 10), '#666', [0.03, 0.25, 0], [0, Math.PI / 2, 0])]);
    case 'bow':
      return merge([part(new THREE.TorusGeometry(0.5, 0.015, 4, 16, Math.PI * 0.9), '#a77a45', [0, 0.5, 0], [0, 0, Math.PI * 0.55]), part(new THREE.CylinderGeometry(0.002, 0.002, 0.98), '#eee', [0.1, 0.5, 0])]);
    case 'compass':
      return merge([part(new THREE.CylinderGeometry(0.06, 0.06, 0.02, 14), '#efe2c9', [0, 0.01, 0]), part(new THREE.BoxGeometry(0.008, 0.005, 0.09), '#d64545', [0, 0.025, 0])]);
    case 'chart':
      return merge([part(new THREE.BoxGeometry(0.3, 0.005, 0.22), '#d8c9a0', [0, 0.003, 0])]);
    case 'spyglass':
      return merge([part(new THREE.CylinderGeometry(0.025, 0.035, 0.4, 8), '#c9a646', [0, 0.2, 0])]);
    case 'coconut': case 'coconut_flask':
      return merge([part(new THREE.SphereGeometry(0.11, 10, 8), '#5a4123', [0, 0.11, 0], [0, 0, 0], [1, 1.12, 1])]);
    case 'waterskin':
      return merge([part(new THREE.SphereGeometry(0.1, 8, 6), '#6b4527', [0, 0.1, 0], [0, 0, 0], [0.8, 1.2, 0.5]), part(new THREE.CylinderGeometry(0.02, 0.02, 0.06), '#3b2a1a', [0, 0.23, 0])]);
    case 'log':
      return merge([part(new THREE.CylinderGeometry(0.14, 0.15, 1.0, 8), '#7a4f2a', [0, 0.14, 0], [0, 0, Math.PI / 2])]);
    case 'stick': case 'arrow':
      return merge([part(new THREE.CylinderGeometry(0.015, 0.02, 0.7, 5), '#9a6b3c', [0, 0.35, 0])]);
    case 'plank':
      return merge([part(new THREE.BoxGeometry(0.8, 0.04, 0.16), '#c08a52', [0, 0.02, 0])]);
    case 'bandage': case 'cloth':
      return merge([part(new THREE.CylinderGeometry(0.05, 0.05, 0.08, 10), '#efe9dc', [0, 0.04, 0], [0, 0, Math.PI / 2])]);
  }
  return merge([part(new THREE.IcosahedronGeometry(0.1, 0), iconColor, [0, 0.1, 0], [0, 0, 0], [1, 0.8, 1])]);
}

// ============================================================ vehicles
export function vehicleModel(type: string): { hull: THREE.BufferGeometry; sail?: THREE.BufferGeometry } {
  const p: Part[] = [];
  if (type === 'log_raft') {
    for (let i = 0; i < 7; i++) p.push(part(new THREE.CylinderGeometry(0.2, 0.22, 4.4, 8), i % 2 ? '#7a5434' : '#6c4a2e', [-1.3 + i * 0.43, 0.1, 0], [Math.PI / 2, 0, 0], [1, 1, 1], 0.08, i));
    for (const z of [-1.6, 0, 1.6]) p.push(part(new THREE.BoxGeometry(3.2, 0.08, 0.12), '#d1b277', [0, 0.3, z]));
    p.push(part(new THREE.BoxGeometry(1.0, 0.5, 0.7), '#8a6440', [0.6, 0.55, -1.1])); // cargo box
    p.push(part(new THREE.CylinderGeometry(0.03, 0.03, 1.6), '#9a6b3c', [-1.2, 0.4, 1.5], [0.3, 0, 1.2])); // paddle
    p.push(part(new THREE.BoxGeometry(0.18, 0.02, 0.4), '#9a6b3c', [-1.9, 0.1, 1.75], [0.3, 0, 1.2]));
    return { hull: merge(p) };
  }
  // outrigger sailboat
  const hullShape = new THREE.CylinderGeometry(0.75, 0.55, 7, 12, 1);
  p.push(part(hullShape, '#8a5a34', [0, 0.15, 0], [Math.PI / 2, 0, 0], [1, 1, 0.55], 0.05, 3));
  p.push(part(new THREE.ConeGeometry(0.62, 1.3, 12), '#8a5a34', [0, 0.15, -4.1], [-Math.PI / 2, 0, 0], [1, 1, 0.55]));
  p.push(part(new THREE.BoxGeometry(1.25, 0.08, 6.6), '#c08a52', [0, 0.45, 0]));
  p.push(part(new THREE.CylinderGeometry(0.2, 0.2, 5.2, 8), '#6c4a2e', [2.4, 0.05, 0], [Math.PI / 2, 0, 0]));
  for (const z of [-1.4, 1.4]) p.push(part(new THREE.BoxGeometry(2.6, 0.1, 0.14), '#9a6b3c', [1.2, 0.45, z]));
  p.push(part(new THREE.CylinderGeometry(0.07, 0.09, 6, 8), '#9a6b3c', [0, 3.4, -0.6]));
  p.push(part(new THREE.CylinderGeometry(0.04, 0.04, 3.4, 6), '#9a6b3c', [0, 1.3, 0.8], [Math.PI / 2, 0, 0]));
  p.push(part(new THREE.BoxGeometry(1.0, 0.4, 0.8), '#7a5233', [0, 0.65, 1.8]));
  const sail = new THREE.BufferGeometry();
  sail.setAttribute('position', new THREE.Float32BufferAttribute([0, 6.2, -0.6, 0, 1.2, -0.6, 0, 1.3, 2.4], 3));
  sail.setAttribute('uv', new THREE.Float32BufferAttribute([0.5, 1, 0, 0, 1, 0], 2));
  sail.computeVertexNormals();
  return { hull: merge(p), sail: part(sail, '#efe8d8') };
}

// ============================================================ wrecks & landmarks
export function wreckModel(kind: 'shallow' | 'deep', seed: number): THREE.BufferGeometry {
  const p: Part[] = [];
  const len = kind === 'deep' ? 26 : 16;
  const w = kind === 'deep' ? 6 : 4;
  const hullCol = kind === 'deep' ? '#5a4a3e' : '#6b5a48';
  // broken keel and ribs
  p.push(part(new THREE.BoxGeometry(0.5, 0.5, len), '#3e3228', [0, 0.25, 0], [0.08, 0, 0.1]));
  for (let i = 0; i < len / 1.6; i++) {
    const z = -len / 2 + i * 1.6;
    if (rand(seed + i) < 0.2) continue;
    const h = 2 + rand(seed + i + 3) * 2.5;
    for (const s of [-1, 1]) p.push(part(new THREE.TorusGeometry(w / 2, 0.15, 4, 10, Math.PI / 2), hullCol, [0, h * 0.5, z], [0, Math.PI / 2, s > 0 ? Math.PI : -Math.PI / 2 + Math.PI / 2], [1, h / (w / 2) * 0.5, 1]));
  }
  // hull planking on one side
  for (let i = 0; i < 6; i++) p.push(part(new THREE.BoxGeometry(0.12, 0.6, len * (0.5 + rand(seed + i) * 0.4)), hullCol, [-w / 2 + 0.2, 0.5 + i * 0.55, (rand(seed + i + 9) - 0.5) * 3], [0, 0, 0.25 + i * 0.07], [1, 1, 1], 0.1, seed + i));
  // mast
  p.push(part(new THREE.CylinderGeometry(0.22, 0.3, kind === 'deep' ? 14 : 9, 8), '#4a3a2c', [0.5, 2, 2], [0.9, 0, 0.4]));
  // deck boxes
  for (let i = 0; i < 4; i++) p.push(part(new THREE.BoxGeometry(1, 0.8, 1), '#7c8a91', [(rand(seed + i) - 0.5) * w, 0.4, (rand(seed + i + 4) - 0.5) * len * 0.6], [0, rand(i) * 3, 0.2]));
  return merge(p);
}

export function crateModel(kind: string): THREE.BufferGeometry {
  if (kind === 'grave') {
    const p: Part[] = [];
    for (let i = 0; i < 6; i++) p.push(part(new THREE.IcosahedronGeometry(0.22, 0), '#7d7b74', [(rand(i) - 0.5) * 0.7, 0.12 + (i > 3 ? 0.2 : 0), (rand(i + 5) - 0.5) * 0.7]));
    p.push(part(new THREE.BoxGeometry(0.06, 0.8, 0.06), '#8a6440', [0, 0.6, 0]), part(new THREE.BoxGeometry(0.4, 0.06, 0.06), '#8a6440', [0, 0.75, 0]));
    return merge(p);
  }
  const col = kind === 'supply' ? '#c9783a' : kind === 'crate' ? '#6b5a44' : '#8a6440';
  const p = [part(new THREE.BoxGeometry(0.9, 0.6, 0.6), col, [0, 0.3, 0], [0, 0, 0], [1, 1, 1], 0.05, 3)];
  for (const x of [-0.42, 0.42]) p.push(part(new THREE.BoxGeometry(0.06, 0.62, 0.62), '#3b3b3b', [x, 0.3, 0]));
  if (kind === 'supply') {
    p.push(part(new THREE.CylinderGeometry(0.015, 0.015, 1.4), '#ddd', [0.3, 1.0, 0.2]));
    p.push(part(new THREE.PlaneGeometry(0.4, 0.25), '#ff3b2f', [0.5, 1.55, 0.2]));
  }
  return merge(p);
}
