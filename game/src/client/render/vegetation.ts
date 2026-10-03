/**
 * Instanced rendering of resource nodes (trees, plants, rocks, reef life) and
 * ground grass. Instances are rebuilt when the camera moves far enough or when
 * node depletion state changes. Plants sway in the wind in the vertex shader.
 */
import * as THREE from 'three';
import type { WorldGen, NodeSpawn } from '../../shared/world/worldgen';
import { NODES } from '../../shared/defs/nodes';
import { plantModel } from './models';
import { textures } from './textures';

const VARIANTS = 3;
const WOODY = new Set(['palm', 'hardwood', 'driftwood', 'loose_stick']);
const ROCKY = new Set(['rock', 'iron_vein', 'loose_stone', 'clay_bank', 'scrap_pile']);
const BIG = new Set(['palm', 'hardwood', 'rock', 'iron_vein', 'obsidian_rock', 'coral', 'scrap_pile']);

interface Batch { type: string; variant: number; solid: THREE.InstancedMesh; leaves: THREE.InstancedMesh | null; count: number }

export interface WindUniforms { time: { value: number }; wind: { value: number }; windDir: { value: THREE.Vector2 }; sunDirW: { value: THREE.Vector3 }; sunTint: { value: THREE.Color } }

function windify(mat: THREE.Material, u: WindUniforms, strength: number, key: string, underwaterSway = false, translucent = false) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    if (translucent) {
      // back-lit leaves transmit warm sunlight (cheap foliage translucency)
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vLeafW;')
        .replace('#include <project_vertex>', `#include <project_vertex>
          #ifdef USE_INSTANCING
            vLeafW = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
          #else
            vLeafW = (modelMatrix * vec4(transformed, 1.0)).xyz;
          #endif`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vLeafW; uniform vec3 sunDirW; uniform vec3 sunTint;')
        .replace('#include <opaque_fragment>', `
          vec3 toCam = normalize(cameraPosition - vLeafW);
          float back = pow(max(dot(-toCam, sunDirW), 0.0), 3.0);
          outgoingLight += diffuseColor.rgb * sunTint * (back * 1.6 + 0.12);
          #include <opaque_fragment>`);
    }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float time; uniform float wind; uniform vec2 windDir;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 ip = instanceMatrix[3].xyz;
        #else
          vec3 ip = vec3(0.0);
        #endif
        float hgt = max(position.y, 0.0);
        float bend = hgt * hgt * ${strength.toFixed(4)};
        float ph = time * ${underwaterSway ? '0.9' : '1.7'} + ip.x * 0.13 + ip.z * 0.11;
        float gust = sin(ph) * 0.6 + sin(ph * 2.3 + 1.7) * 0.25 + sin(ph * 5.1 + position.x) * 0.15 * step(0.5, hgt);
        float w = ${underwaterSway ? '0.6' : '(0.15 + wind * 0.85)'};
        transformed.x += windDir.x * bend * w * (0.6 + gust);
        transformed.z += windDir.y * bend * w * (0.6 + gust);
      `);
  };
  mat.customProgramCacheKey = () => `wind-${key}`;
}

export class VegetationSystem {
  group = new THREE.Group();
  wind: WindUniforms = { time: { value: 0 }, wind: { value: 0.3 }, windDir: { value: new THREE.Vector2(1, 0) }, sunDirW: { value: new THREE.Vector3(0, 1, 0) }, sunTint: { value: new THREE.Color(0, 0, 0) } };
  private batches = new Map<string, Batch>();
  private lastCenter = new THREE.Vector3(1e9, 0, 1e9);
  private dirty = true;
  bigRadius = 500;
  smallRadius = 110;
  density = 1;
  private solidMat: THREE.MeshStandardMaterial;
  private barkMat: THREE.MeshStandardMaterial;
  private rockMat: THREE.MeshStandardMaterial;
  private reefMat: THREE.MeshStandardMaterial;
  private leafMats: Record<string, THREE.MeshStandardMaterial>;
  instanceCount = 0;
  // grass
  private grass: THREE.InstancedMesh;
  private grassCenter = new THREE.Vector3(1e9, 0, 1e9);
  grassDensity = 1;

  constructor(private gen: WorldGen, private isDepleted: (id: string) => boolean) {
    const t = textures();
    this.solidMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, map: null });
    windify(this.solidMat, this.wind, 0.0016, 'solid');
    this.barkMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, map: t.bark, color: new THREE.Color(3.2, 3.2, 3.2) });
    windify(this.barkMat, this.wind, 0.0016, 'bark');
    this.rockMat = triplanarRock(t.rock);
    this.reefMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, side: THREE.DoubleSide });
    windify(this.reefMat, this.wind, 0.05, 'reef', true);
    const leaf = (tex: THREE.Texture, k: string, strength: number) => {
      const m = new THREE.MeshStandardMaterial({ map: tex, vertexColors: true, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.75 });
      windify(m, this.wind, strength, k, false, true);
      return m;
    };
    this.leafMats = { palm: leaf(t.palmLeaf, 'palm', 0.0026), broad: leaf(t.broadLeaf, 'broad', 0.0022), grass: leaf(t.grassBlade, 'bush', 0.08) };

    // build per-type variant geometry
    for (const type of Object.keys(NODES)) {
      for (let v = 0; v < VARIANTS; v++) {
        const model = plantModel(type, 11 + v * 37);
        const def = NODES[type]!;
        const mat = type === 'kelp' ? this.reefMat : WOODY.has(type) ? this.barkMat : ROCKY.has(type) ? this.rockMat : this.solidMat;
        const solid = new THREE.InstancedMesh(model.solid, mat, 64);
        solid.count = 0;
        solid.castShadow = BIG.has(type) && !def.underwater;
        solid.receiveShadow = true;
        solid.frustumCulled = false;
        this.group.add(solid);
        let leaves: THREE.InstancedMesh | null = null;
        if (model.leaves) {
          leaves = new THREE.InstancedMesh(model.leaves, this.leafMats[model.leafTex ?? 'broad']!, 64);
          leaves.count = 0;
          leaves.castShadow = BIG.has(type);
          leaves.receiveShadow = true;
          leaves.frustumCulled = false;
          this.group.add(leaves);
        }
        this.batches.set(`${type}:${v}`, { type, variant: v, solid, leaves, count: 0 });
      }
    }

    // grass: clumps of real tapered, curved blades (no alpha cut-outs: no shimmer, soft gradients)
    const gm = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.82 });
    windify(gm, this.wind, 1.1, 'grass-blades', false, true);
    this.grass = new THREE.InstancedMesh(grassClump(), gm, 16000);
    this.grass.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(16000 * 3), 3);
    this.grass.count = 0;
    this.grass.frustumCulled = false;
    this.grass.receiveShadow = true;
    this.group.add(this.grass);
  }

  setQuality(viewDistance: number, density: number, grassDensity: number) {
    this.bigRadius = Math.min(900, viewDistance * 0.45);
    this.smallRadius = 70 + 60 * density;
    this.density = density;
    this.grassDensity = grassDensity;
    this.dirty = true;
    this.grassCenter.set(1e9, 0, 1e9);
  }

  markDirty() { this.dirty = true; }

  /** Sun direction/colour for leaf translucency (scaled by how much sun actually reaches the ground). */
  setSun(dir: THREE.Vector3, color: THREE.Color, strength: number) {
    this.wind.sunDirW.value.copy(dir);
    this.wind.sunTint.value.copy(color).multiplyScalar(strength);
  }

  update(cam: THREE.Vector3, time: number, wind: number, windDir: number) {
    this.wind.time.value = time;
    this.wind.wind.value = wind;
    this.wind.windDir.value.set(Math.cos(windDir), Math.sin(windDir));
    if (this.dirty || cam.distanceTo(this.lastCenter) > 30) this.rebuild(cam);
    if (this.grassDensity > 0 && Math.hypot(cam.x - this.grassCenter.x, cam.z - this.grassCenter.z) > 8) this.rebuildGrass(cam);
    else if (this.grassDensity <= 0) this.grass.count = 0;
  }

  private rebuild(cam: THREE.Vector3) {
    this.dirty = false;
    this.lastCenter.copy(cam);
    const lists = new Map<string, NodeSpawn[]>();
    const nodes = this.gen.nodesInRadius(cam.x, cam.z, this.bigRadius);
    const small2 = this.smallRadius ** 2;
    for (const n of nodes) {
      if (this.isDepleted(n.id)) continue;
      const big = BIG.has(n.type);
      const d2 = (n.x - cam.x) ** 2 + (n.z - cam.z) ** 2;
      if (!big && d2 > small2) continue;
      // density thinning for decorative/non-interactive distance (never thin within 40 m)
      if (this.density < 1 && d2 > 1600 && hashF(n.id) > this.density) continue;
      const v = Math.floor(hashF(n.id + 'v') * VARIANTS);
      const key = `${n.type}:${v}`;
      let arr = lists.get(key);
      if (!arr) { arr = []; lists.set(key, arr); }
      arr.push(n);
    }
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    let total = 0;
    for (const [key, b] of this.batches) {
      const arr = lists.get(key) ?? [];
      this.ensure(b, arr.length);
      for (let i = 0; i < arr.length; i++) {
        const n = arr[i]!;
        q.setFromAxisAngle(up, n.rot);
        s.setScalar(n.scale);
        // kelp stays under the surface: in shallow water its fronds are shorter
        if (n.type === 'kelp') s.y = Math.max(0.15, Math.min(n.scale, (-n.y - 0.7) / 4.6));
        p.set(n.x, n.y - 0.05, n.z);
        m.compose(p, q, s);
        b.solid.setMatrixAt(i, m);
        b.leaves?.setMatrixAt(i, m);
      }
      b.solid.count = arr.length;
      b.solid.instanceMatrix.needsUpdate = true;
      if (b.leaves) { b.leaves.count = arr.length; b.leaves.instanceMatrix.needsUpdate = true; }
      total += arr.length;
    }
    this.instanceCount = total;
  }

  private ensure(b: Batch, n: number) {
    if (n <= b.solid.instanceMatrix.count) return;
    const cap = Math.ceil(n * 1.5);
    const grow = (old: THREE.InstancedMesh) => {
      const nm = new THREE.InstancedMesh(old.geometry, old.material, cap);
      nm.castShadow = old.castShadow; nm.receiveShadow = old.receiveShadow; nm.frustumCulled = false;
      this.group.remove(old);
      old.dispose();
      this.group.add(nm);
      return nm;
    };
    b.solid = grow(b.solid);
    if (b.leaves) b.leaves = grow(b.leaves);
  }

  private rebuildGrass(cam: THREE.Vector3) {
    this.grassCenter.copy(cam);
    const R = 30 + 16 * this.grassDensity;
    const step = 0.82 / Math.sqrt(Math.max(0.25, this.grassDensity));
    const n = Math.ceil((R * 2) / step);
    const x0 = Math.floor((cam.x - R) / step) * step, z0 = Math.floor((cam.z - R) / step) * step;
    // coarse height grid for slope
    const cs = 2;
    const gn = Math.ceil((R * 2) / cs) + 2;
    const gx0 = Math.floor((cam.x - R) / cs) * cs, gz0 = Math.floor((cam.z - R) / cs) * cs;
    const hg = new Float32Array(gn * gn);
    for (let j = 0; j < gn; j++) for (let i = 0; i < gn; i++) hg[j * gn + i] = this.gen.heightAt(gx0 + i * cs, gz0 + j * cs);
    const H = (x: number, z: number) => {
      const fx = (x - gx0) / cs, fz = (z - gz0) / cs;
      const i = Math.max(0, Math.min(gn - 2, Math.floor(fx))), j = Math.max(0, Math.min(gn - 2, Math.floor(fz)));
      const tx = fx - i, tz = fz - j;
      const a = hg[j * gn + i]!, b = hg[j * gn + i + 1]!, c = hg[(j + 1) * gn + i]!, d = hg[(j + 1) * gn + i + 1]!;
      return { h: a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz, slope: Math.hypot(b - a, c - a) / cs };
    };
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const tint = new THREE.Color();
    let count = 0;
    const max = this.grass.instanceMatrix.count;
    for (let j = 0; j < n && count < max; j++) for (let i = 0; i < n && count < max; i++) {
      const gx = x0 + i * step, gz = z0 + j * step;
      const r1 = hashN(gx * 13.1 + gz * 7.7), r2 = hashN(gx * 3.3 - gz * 11.9);
      const x = gx + r1 * step, z = gz + r2 * step;
      const dx = x - cam.x, dz = z - cam.z;
      if (dx * dx + dz * dz > R * R) continue;
      const { h, slope } = H(x, z);
      if (h < 2.0 + r1 * 0.8 || slope > 0.5) continue;
      // patchiness
      const patch = hashN(Math.floor(x / 7) * 31.7 + Math.floor(z / 7) * 17.3);
      if (patch < 0.14) continue;
      // thinner near beaches, lusher inland
      const lush = Math.min(1, (h - 2) / 4);
      if (r2 > 0.35 + lush * 0.65) continue;
      q.setFromAxisAngle(up, r1 * 6.28);
      // shrink towards the edge of the grass radius so it grows in instead of popping
      const d = Math.sqrt(dx * dx + dz * dz) / R;
      const fade = d > 0.75 ? Math.max(0, 1 - (d - 0.75) / 0.25) : 1;
      const sc = (0.75 + r2 * 0.6) * (0.55 + lush * 0.45) * fade;
      if (sc < 0.05) continue;
      s.set(sc * (0.9 + r1 * 0.3), sc * (0.75 + r1 * 0.6), sc * (0.9 + r2 * 0.3));
      p.set(x, h - 0.03, z);
      m.compose(p, q, s);
      // per-clump tint: greener in lush patches, sun-dried near the shore and in dry patches
      const dry = Math.max(0, 1 - lush) * 0.6 + (patch > 0.85 ? 0.45 : 0) + r1 * 0.15;
      tint.setRGB(1 - dry * 0.1 + (r2 - 0.5) * 0.12, 1 - dry * 0.18 + (r1 - 0.5) * 0.08, 1 - dry * 0.5);
      this.grass.setColorAt(count, tint);
      this.grass.setMatrixAt(count++, m);
    }
    this.grass.count = count;
    this.grass.instanceMatrix.needsUpdate = true;
    if (this.grass.instanceColor) this.grass.instanceColor.needsUpdate = true;
  }
}

/**
 * One grass clump: ~11 tapered blades, each a curved 4-segment strip that leans
 * outward. Vertex colours run from a dark, cool base to a sunlit yellow-green tip;
 * normals are bent towards up so clumps light softly like a lawn, not like cards.
 */
function grassClump(): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], col: number[] = [];
  const base = new THREE.Color().setRGB(0.10, 0.19, 0.05, THREE.SRGBColorSpace);
  const mid = new THREE.Color().setRGB(0.27, 0.42, 0.12, THREE.SRGBColorSpace);
  const tip = new THREE.Color().setRGB(0.62, 0.70, 0.30, THREE.SRGBColorSpace);
  const c = new THREE.Color();
  const SEG = 4;
  const blades = 11;
  for (let b = 0; b < blades; b++) {
    const rnd = (k: number) => hashN(b * 17.13 + k * 3.71);
    const ang = rnd(1) * Math.PI * 2;
    const r0 = Math.sqrt(rnd(2)) * 0.16;
    const ox = Math.cos(ang) * r0, oz = Math.sin(ang) * r0;
    const height = 0.32 + rnd(3) * 0.38;
    const width = 0.022 + rnd(4) * 0.018;
    const lean = 0.12 + rnd(5) * 0.28; // how far the tip travels outward
    const leanDir = ang + (rnd(6) - 0.5) * 1.2;
    const lx = Math.cos(leanDir), lz = Math.sin(leanDir);
    // blade faces sideways to its lean direction
    const fx = -lz, fz = lx;
    const pts: [number, number, number, number][] = [];
    for (let i = 0; i <= SEG; i++) {
      const t = i / SEG;
      const out = lean * t * t * height;
      const w = width * (1 - t * 0.92) * (i === SEG ? 0 : 1);
      pts.push([ox + lx * out, height * (t - 0.08 * t * t), oz + lz * out, w]);
    }
    const shade = 0.85 + rnd(7) * 0.3;
    for (let i = 0; i < SEG; i++) {
      const [x0, y0, z0, w0] = pts[i]!, [x1, y1, z1, w1] = pts[i + 1]!;
      const t0 = i / SEG, t1 = (i + 1) / SEG;
      const quad = [
        [x0 - fx * w0, y0, z0 - fz * w0, t0], [x0 + fx * w0, y0, z0 + fz * w0, t0], [x1 + fx * w1, y1, z1 + fz * w1, t1],
        [x0 - fx * w0, y0, z0 - fz * w0, t0], [x1 + fx * w1, y1, z1 + fz * w1, t1], [x1 - fx * w1, y1, z1 - fz * w1, t1],
      ];
      // the last segment ends in a point: its second triangle would be degenerate
      for (const [x, y, z, t] of i === SEG - 1 ? quad.slice(0, 3) : quad) {
        pos.push(x!, y!, z!);
        // normal: blade face normal blended mostly towards up (soft, lawn-like shading)
        const nx = lx * 0.35, nz = lz * 0.35, ny = 0.94;
        nor.push(nx, ny, nz);
        if (t! < 0.5) c.copy(base).lerp(mid, t! * 2); else c.copy(mid).lerp(tip, (t! - 0.5) * 2);
        c.multiplyScalar(shade);
        col.push(c.r, c.g, c.b);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}

/** Object-space triplanar rock texturing (procedural rock meshes have no UVs). */
function triplanarRock(tex: THREE.Texture): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92 });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.tRock = { value: tex };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObjPos; varying vec3 vObjN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObjPos = position; vObjN = normal;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D tRock; varying vec3 vObjPos; varying vec3 vObjN;')
      .replace('#include <map_fragment>', `
        vec3 bw = pow(abs(normalize(vObjN)), vec3(4.0)); bw /= (bw.x + bw.y + bw.z);
        vec3 tx = texture2D(tRock, vObjPos.zy * 0.7).rgb * bw.x + texture2D(tRock, vObjPos.xz * 0.7).rgb * bw.y + texture2D(tRock, vObjPos.xy * 0.7).rgb * bw.z;
        diffuseColor.rgb *= mix(vec3(1.0), tx * 3.6, 0.7);
        // moss/lichen on upward faces, damp darkening at the base
        vec3 on = normalize(vObjN);
        float moss = smoothstep(0.55, 0.92, on.y) * smoothstep(0.35, 0.65, texture2D(tRock, vObjPos.xz * 0.23).g * 2.0);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.2, 0.27, 0.11), moss * 0.55);
        diffuseColor.rgb *= mix(0.62, 1.0, smoothstep(-0.1, 0.45, vObjPos.y));`);
  };
  m.customProgramCacheKey = () => 'rock-triplanar';
  return m;
}

function hashF(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

function hashN(v: number): number {
  const x = Math.sin(v * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}
