/**
 * Procedural geometry for buildable structures (ASSET REPLACEMENT POINT).
 * Returns a list of (geometry, material-key) parts per structure type, cached.
 */
import * as THREE from 'three';
import { part, merge, type Part } from './models';
import { BUILD } from '../../shared/config';

export type MatKey = 'thatch' | 'wood' | 'brick' | 'props' | 'cloth' | 'glow' | 'glass' | 'soil';
export interface StructurePart { geo: THREE.BufferGeometry; mat: MatKey }

const G = BUILD.grid, H = BUILD.wallHeight;

/** Box with UVs scaled to world size (1 texture repeat per 1.5 m). */
function tbox(w: number, h: number, d: number, pos: [number, number, number], rot: [number, number, number] = [0, 0, 0], color = '#ffffff'): Part {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  // faces: +x,-x (d,h), +y,-y (w,d), +z,-z (w,h)
  const dims: [number, number][] = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) for (let v = 0; v < 4; v++) {
    const i = f * 4 + v;
    uv.setXY(i, uv.getX(i) * dims[f]![0] / 1.5, uv.getY(i) * dims[f]![1] / 1.5);
  }
  return part(g, color, pos, rot);
}

function tierOf(id: string): MatKey {
  if (id.startsWith('thatch')) return 'thatch';
  if (id.startsWith('stone')) return 'brick';
  return 'wood';
}

const cache = new Map<string, StructurePart[]>();

export function structureParts(type: string): StructurePart[] {
  const c = cache.get(type);
  if (c) return c;
  const out = build(type);
  cache.set(type, out);
  return out;
}

function build(type: string): StructurePart[] {
  const tier = tierOf(type);
  const base = type.replace(/^(thatch|wood|stone)_/, '');
  const T = (parts: Part[], mat: MatKey = tier): StructurePart => ({ geo: merge(parts), mat });
  const frame = tier === 'brick' ? '#d8d0c4' : '#ffffff';
  switch (base) {
    case 'foundation': {
      const posts: Part[] = [];
      for (const x of [-1.35, 1.35]) for (const z of [-1.35, 1.35]) posts.push(part(new THREE.CylinderGeometry(0.14, 0.18, 3.2, 7), tier === 'brick' ? '#8d8a82' : '#6c4a2e', [x, -1.5, z]));
      return [T([tbox(G, 0.4, G, [0, 0.2, 0])]), { geo: merge(posts), mat: 'props' }];
    }
    case 'wall': return [T([tbox(G, H, 0.24, [0, H / 2, 0], [0, 0, 0], frame)])];
    case 'doorway': return [T([tbox(0.9, H, 0.24, [-1.05, H / 2, 0]), tbox(0.9, H, 0.24, [1.05, H / 2, 0]), tbox(1.2, 0.8, 0.24, [0, H - 0.4, 0])])];
    case 'window': return [
      T([tbox(G, 1.0, 0.24, [0, 0.5, 0]), tbox(G, 0.8, 0.24, [0, H - 0.4, 0]), tbox(0.85, 1.2, 0.24, [-1.075, 1.6, 0]), tbox(0.85, 1.2, 0.24, [1.075, 1.6, 0])]),
      { geo: merge([part(new THREE.BoxGeometry(0.06, 1.2, 0.06), '#5a4030', [0, 1.6, 0]), part(new THREE.BoxGeometry(1.3, 0.06, 0.06), '#5a4030', [0, 1.6, 0])]), mat: 'props' },
    ];
    case 'floor': return [T([tbox(G, 0.15, G, [0, 0.075, 0])])];
    case 'roof': {
      const g = new THREE.ConeGeometry(G * 0.78, 1.25, 4, 1, true);
      g.rotateY(Math.PI / 4);
      const uv = g.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 3, uv.getY(i) * 1.6);
      const under = new THREE.ConeGeometry(G * 0.78, 1.25, 4, 1, true);
      under.rotateY(Math.PI / 4);
      under.scale(0.98, 0.98, 0.98);
      // flip winding for the underside
      const idx = under.index!;
      for (let i = 0; i < idx.count; i += 3) { const a = idx.getX(i); idx.setX(i, idx.getX(i + 2)); idx.setX(i + 2, a); }
      return [T([part(g, '#ffffff', [0, 0.62, 0]), part(under, '#bbbbbb', [0, 0.6, 0])])];
    }
    case 'stairs': {
      const steps: Part[] = [];
      const n = 10;
      for (let i = 0; i < n; i++) steps.push(tbox(G * 0.66, 0.12, G / n + 0.02, [0, (i + 1) * (H / n) - 0.06, G / 2 - (i + 0.5) * (G / n)]));
      for (const x of [-G * 0.33, G * 0.33]) steps.push(tbox(0.1, 0.3, Math.hypot(G, H), [x, H / 2, 0], [Math.atan2(H, G), 0, 0]));
      return [T(steps)];
    }
  }
  const P = (parts: Part[]): StructurePart => ({ geo: merge(parts), mat: 'props' });
  switch (type) {
    case 'wood_door': return [{ geo: merge([tbox(1.18, 2.38, 0.08, [0.59, 1.19, 0]), part(new THREE.SphereGeometry(0.04, 6, 4), '#b9c4cc', [1.0, 1.15, 0.06])]), mat: 'wood' }];
    case 'stilt_platform': {
      const posts: Part[] = [];
      for (const x of [-1.35, 1.35]) for (const z of [-1.35, 1.35]) posts.push(part(new THREE.CylinderGeometry(0.15, 0.18, 7, 7), '#5c3f26', [x, -3.4, z], [0, 0, 0], [1, 1, 1], 0.1, x + z));
      return [{ geo: merge([tbox(G, 0.3, G, [0, 0.15, 0])]), mat: 'wood' }, P(posts)];
    }
    case 'fence': {
      const p: Part[] = [];
      for (const x of [-1.45, -0.5, 0.5, 1.45]) p.push(part(new THREE.CylinderGeometry(0.05, 0.06, 1.3, 5), '#7a5434', [x, 0.65, 0]));
      for (const y of [0.4, 0.95]) p.push(part(new THREE.BoxGeometry(G, 0.06, 0.05), '#8a6440', [0, y, 0]));
      return [P(p)];
    }
    case 'spike_barricade': {
      const p: Part[] = [];
      for (let i = 0; i < 5; i++) {
        const x = -1.1 + i * 0.55;
        p.push(part(new THREE.ConeGeometry(0.07, 1.6, 5), '#8a6440', [x, 0.6, 0.15], [0.6, 0, 0]));
        p.push(part(new THREE.ConeGeometry(0.07, 1.6, 5), '#7a5434', [x + 0.25, 0.6, -0.15], [-0.6, 0, 0]));
      }
      p.push(part(new THREE.BoxGeometry(2.8, 0.1, 0.1), '#6c4a2e', [0, 0.35, 0]));
      return [P(p)];
    }
    case 'campfire': {
      const p: Part[] = [];
      for (let i = 0; i < 9; i++) { const a = (i / 9) * Math.PI * 2; p.push(part(new THREE.IcosahedronGeometry(0.16, 0), '#77756e', [Math.cos(a) * 0.55, 0.1, Math.sin(a) * 0.55], [i, i * 2, 0], [1, 0.7, 1], 0.2, i)); }
      for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2; p.push(part(new THREE.CylinderGeometry(0.05, 0.06, 0.8, 5), '#4a3020', [Math.cos(a) * 0.12, 0.22, Math.sin(a) * 0.12], [Math.sin(a) * 0.9, 0, -Math.cos(a) * 0.9])); }
      p.push(part(new THREE.CircleGeometry(0.45, 10), '#1c1612', [0, 0.02, 0], [-Math.PI / 2, 0, 0]));
      return [P(p)];
    }
    case 'workbench': {
      const p = [tbox(2.0, 0.12, 1.1, [0, 0.85, 0], [0, 0, 0], '#c79a64')];
      for (const x of [-0.85, 0.85]) for (const z of [-0.45, 0.45]) p.push(part(new THREE.BoxGeometry(0.1, 0.85, 0.1), '#6c4a2e', [x, 0.42, z]));
      p.push(part(new THREE.BoxGeometry(1.8, 0.06, 0.9), '#7a5434', [0, 0.25, 0]));
      p.push(part(new THREE.BoxGeometry(0.06, 0.06, 0.3), '#8d8d86', [0.4, 0.95, 0.1], [0, 0.4, 0]), part(new THREE.CylinderGeometry(0.02, 0.02, 0.35), '#8a6440', [0.4, 0.93, 0.25], [Math.PI / 2, 0.4, 0]));
      return [P(p)];
    }
    case 'kiln': {
      const dome = new THREE.SphereGeometry(0.85, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2);
      return [P([part(dome, '#a35f3e', [0, 0.25, 0], [0, 0, 0], [1, 1.3, 1], 0.06, 2), part(new THREE.CylinderGeometry(0.85, 0.9, 0.3, 14), '#8c4f33', [0, 0.15, 0]),
        part(new THREE.CylinderGeometry(0.16, 0.2, 0.7, 8), '#8c4f33', [0, 1.45, 0]), part(new THREE.BoxGeometry(0.5, 0.45, 0.2), '#1a1210', [0, 0.45, 0.76])])];
    }
    case 'forge': {
      return [{ geo: merge([tbox(1.6, 1.0, 1.0, [-0.4, 0.5, 0])]), mat: 'brick' },
        P([part(new THREE.BoxGeometry(0.5, 0.25, 0.3), '#2a2c30', [0.75, 0.75, 0]), part(new THREE.ConeGeometry(0.12, 0.3, 4), '#2a2c30', [1.05, 0.78, 0], [0, 0, -Math.PI / 2]), part(new THREE.CylinderGeometry(0.15, 0.22, 0.6, 6), '#3a2c22', [0.75, 0.3, 0]),
          part(new THREE.BoxGeometry(0.9, 0.08, 0.6), '#ff7a1a', [-0.4, 1.02, 0])])];
    }
    case 'storage_crate': return [{ geo: merge([tbox(1.1, 0.7, 0.8, [0, 0.35, 0])]), mat: 'wood' }, P([part(new THREE.BoxGeometry(1.14, 0.06, 0.84), '#3b3b3b', [0, 0.55, 0])])];
    case 'large_chest': return [{ geo: merge([tbox(1.5, 0.75, 0.9, [0, 0.375, 0])]), mat: 'wood' }, P([part(new THREE.BoxGeometry(1.54, 0.08, 0.94), '#7c8a91', [0, 0.6, 0]), part(new THREE.BoxGeometry(0.12, 0.16, 0.05), '#c9a646', [0, 0.55, 0.47])])];
    case 'rain_catcher': {
      const p: Part[] = [];
      for (let i = 0; i < 3; i++) { const a = (i / 3) * Math.PI * 2; p.push(part(new THREE.CylinderGeometry(0.04, 0.05, 1.5, 5), '#7a5434', [Math.cos(a) * 0.45, 0.7, Math.sin(a) * 0.45], [Math.sin(a) * 0.25, 0, -Math.cos(a) * 0.25])); }
      p.push(part(new THREE.ConeGeometry(0.9, 0.5, 10, 1, true), '#5f9e3a', [0, 1.3, 0], [Math.PI, 0, 0], [1, 1, 1], 0.2, 3));
      p.push(part(new THREE.CylinderGeometry(0.35, 0.3, 0.35, 10), '#8a6440', [0, 0.2, 0]));
      return [P(p)];
    }
    case 'water_still': {
      return [{ geo: merge([tbox(1.6, 0.5, 1.6, [0, 0.25, 0])]), mat: 'brick' },
        P([part(new THREE.CylinderGeometry(0.3, 0.25, 0.4, 10), '#a1452e', [0, 0.7, 0]), part(new THREE.BoxGeometry(0.06, 0.06, 0.6), '#7c8a91', [0.3, 0.8, 0.3])]),
        { geo: merge([part(new THREE.PlaneGeometry(1.6, 1.4), '#cfefff', [0, 0.95, 0], [-0.9, 0, 0])]), mat: 'glass' }];
    }
    case 'garden_plot': {
      const p: Part[] = [];
      for (const [x, z, w, d] of [[0, 1.35, 2.8, 0.1], [0, -1.35, 2.8, 0.1], [1.35, 0, 0.1, 2.8], [-1.35, 0, 0.1, 2.8]] as const) p.push(tbox(w, 0.4, d, [x, 0.2, z]));
      return [{ geo: merge(p), mat: 'wood' }, { geo: merge([part(new THREE.BoxGeometry(2.6, 0.32, 2.6), '#3a2a1c', [0, 0.16, 0], [0, 0, 0], [1, 1, 1], 0.2, 5)]), mat: 'soil' }];
    }
    case 'drying_rack': {
      const p: Part[] = [];
      for (const x of [-0.85, 0.85]) for (const s of [-1, 1]) p.push(part(new THREE.CylinderGeometry(0.035, 0.04, 1.75, 5), '#7a5434', [x, 0.8, s * 0.22], [s * 0.28, 0, 0]));
      p.push(part(new THREE.CylinderGeometry(0.03, 0.03, 1.9, 5), '#8a6440', [0, 1.6, 0], [0, 0, Math.PI / 2]));
      for (let i = 0; i < 4; i++) p.push(part(new THREE.CylinderGeometry(0.003, 0.003, 0.4), '#d1b277', [-0.6 + i * 0.4, 1.4, 0]));
      return [P(p)];
    }
    case 'torch_stand': return [P([part(new THREE.CylinderGeometry(0.04, 0.06, 1.6, 6), '#6c4a2e', [0, 0.8, 0]), part(new THREE.CylinderGeometry(0.12, 0.07, 0.15, 7), '#3a2a1a', [0, 1.62, 0])])];
    case 'lantern_post': return [P([part(new THREE.CylinderGeometry(0.06, 0.08, 2.2, 6), '#5c3f26', [0, 1.1, 0]), part(new THREE.BoxGeometry(0.6, 0.06, 0.06), '#5c3f26', [0.25, 2.1, 0]), part(new THREE.BoxGeometry(0.16, 0.22, 0.16), '#2a2c30', [0.5, 1.9, 0])]), { geo: merge([part(new THREE.BoxGeometry(0.12, 0.16, 0.12), '#ffe7a0', [0.5, 1.9, 0])]), mat: 'glow' }];
    case 'lean_to': {
      const roof = tbox(2.6, 0.12, 2.3, [0, 1.15, 0], [-0.55, 0, 0]);
      const posts = [part(new THREE.CylinderGeometry(0.06, 0.07, 1.9, 5), '#6c4a2e', [-1.15, 0.95, -0.85]), part(new THREE.CylinderGeometry(0.06, 0.07, 1.9, 5), '#6c4a2e', [1.15, 0.95, -0.85])];
      return [{ geo: merge([roof]), mat: 'thatch' }, P([...posts, part(new THREE.BoxGeometry(1.8, 0.1, 0.9), '#5f9e3a', [0, 0.05, 0.1], [0, 0, 0], [1, 1, 1], 0.2, 2)])];
    }
    case 'bed': {
      const p = [part(new THREE.CylinderGeometry(0.06, 0.07, 1.2, 6), '#6c4a2e', [-1.1, 0.6, 0]), part(new THREE.CylinderGeometry(0.06, 0.07, 1.2, 6), '#6c4a2e', [1.1, 0.6, 0])];
      const sag = new THREE.CylinderGeometry(1.0, 1.0, 0.9, 12, 1, true, Math.PI * 0.7, Math.PI * 0.6);
      return [P(p), { geo: merge([part(sag, '#ffffff', [0, 1.35, 0], [0, 0, Math.PI / 2], [1, 1, 0.55])]), mat: 'cloth' }];
    }
    case 'signal_beacon': {
      const p: Part[] = [];
      const hgt = 4.5;
      for (const x of [-0.6, 0.6]) for (const z of [-0.6, 0.6]) p.push(part(new THREE.CylinderGeometry(0.05, 0.07, hgt, 5), '#b9c4cc', [x * 0.7, hgt / 2, z * 0.7], [z * 0.08, 0, -x * 0.08]));
      for (let y = 0.6; y < hgt; y += 1.0) for (const r of [0, Math.PI / 2]) p.push(part(new THREE.BoxGeometry(0.9, 0.04, 0.04), '#9aa6ad', [0, y, 0], [0, r, 0.6]));
      p.push(part(new THREE.CylinderGeometry(0.02, 0.02, 2.2), '#c3c9cf', [0, hgt + 1.1, 0]));
      p.push(part(new THREE.SphereGeometry(0.4, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2.4), '#d0d6da', [0.3, hgt - 0.4, 0], [0, 0, -1.2]));
      p.push(part(new THREE.BoxGeometry(0.5, 0.5, 0.4), '#3a4a52', [0, 0.6, 0]));
      return [P(p), { geo: merge([part(new THREE.SphereGeometry(0.14, 8, 6), '#ff3b2f', [0, hgt + 2.25, 0])]), mat: 'glow' }];
    }
  }
  return [P([part(new THREE.BoxGeometry(1, 1, 1), '#ff00ff', [0, 0.5, 0])])];
}

export function structureMaterials(tex: { thatch: THREE.Texture; wood: THREE.Texture; brick: THREE.Texture; cloth: THREE.Texture; dirt: THREE.Texture }): Record<MatKey, THREE.Material> {
  return {
    thatch: new THREE.MeshStandardMaterial({ map: tex.thatch, vertexColors: true, roughness: 0.95, side: THREE.DoubleSide }),
    wood: new THREE.MeshStandardMaterial({ map: tex.wood, vertexColors: true, roughness: 0.82 }),
    brick: new THREE.MeshStandardMaterial({ map: tex.brick, vertexColors: true, roughness: 0.9 }),
    props: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }),
    cloth: new THREE.MeshStandardMaterial({ map: tex.cloth, vertexColors: true, roughness: 0.95, side: THREE.DoubleSide }),
    glow: new THREE.MeshStandardMaterial({ vertexColors: true, emissive: new THREE.Color('#ffb347'), emissiveIntensity: 2.5, roughness: 0.5 }),
    glass: new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, opacity: 0.35, roughness: 0.05, metalness: 0.1, side: THREE.DoubleSide }),
    soil: new THREE.MeshStandardMaterial({ map: tex.dirt, vertexColors: true, roughness: 1 }),
  };
}
