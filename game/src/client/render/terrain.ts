/**
 * Terrain rendering:
 *  - one low-detail mesh per island (always visible: islands are navigation landmarks)
 *  - streamed high-detail 64 m chunks around the camera with distance LOD + skirts
 *  - a camera-centred terrain height texture used by the ocean shader for depth tint/foam
 * Geometry is generated incrementally under a per-frame time budget.
 */
import * as THREE from 'three';
import type { WorldGen } from '../../shared/world/worldgen';
import { textures } from './textures';

const CHUNK = 64;

export interface TerrainUniforms {
  time: { value: number };
  sunDir: { value: THREE.Vector3 };
  sunIntensity: { value: number };
  nearRadius: { value: number };
  camPos: { value: THREE.Vector3 };
  waterTint: { value: THREE.Color };
  /** 0 dry .. 1 soaked: rises while it rains, dries slowly afterwards */
  rainWet: { value: number };
}

export function makeTerrainMaterial(u: TerrainUniforms, far: boolean): THREE.MeshStandardMaterial {
  const t = textures();
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u, {
      tSand: { value: t.sand }, tGrass: { value: t.grass }, tRock: { value: t.rock }, tDirt: { value: t.dirt }, tNoise: { value: t.noise }, tNorm: { value: t.terrainNormal },
    });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos; varying vec3 vWNormal;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix*vec4(transformed,1.0)).xyz; vWNormal = normalize(mat3(modelMatrix)*objectNormal);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWPos; varying vec3 vWNormal;
        uniform sampler2D tSand, tGrass, tRock, tDirt, tNoise, tNorm;
        uniform float time, sunIntensity, nearRadius, rainWet; uniform vec3 sunDir, camPos, waterTint;
        float caustic(vec2 p, float t){
          vec2 q = p*0.35;
          float c = 0.0;
          for(int i=0;i<3;i++){
            vec2 o = vec2(sin(t*0.4+float(i)*2.1), cos(t*0.33+float(i)*1.3))*1.7;
            float n = texture2D(tNoise, q*0.12 + o*0.02).r;
            c += pow(abs(sin((q.x+n*4.0+o.x)*2.3)*sin((q.y-n*3.0+o.y)*2.1)), 6.0);
            q = q*1.27 + 3.1;
          }
          return c;
        }`)
      .replace('#include <map_fragment>', `
        ${far ? 'if (distance(vWPos.xz, camPos.xz) < nearRadius - 24.0) discard;' : ''}
        vec3 N = normalize(vWNormal);
        float h = vWPos.y;
        float slope = 1.0 - N.y;
        vec2 uv = vWPos.xz * 0.22;
        vec4 nz = texture2D(tNoise, vWPos.xz * 0.004);
        vec4 nz2 = texture2D(tNoise, vWPos.xz * 0.03);
        // macro variation breaks tiling
        vec3 sand = texture2D(tSand, uv).rgb * (0.62 + nz.g*0.2);
        vec3 grass = texture2D(tGrass, uv*0.8).rgb * (0.8 + nz.r*0.4);
        grass = mix(grass, grass*vec3(1.15,1.05,0.7), smoothstep(0.55,0.75,nz.b));
        vec3 dirt = texture2D(tDirt, uv).rgb;
        vec3 bl = abs(N); bl = pow(bl, vec3(4.0)); bl /= (bl.x+bl.y+bl.z);
        vec3 rock = texture2D(tRock, vWPos.zy*0.12).rgb*bl.x + texture2D(tRock, vWPos.xz*0.12).rgb*bl.y + texture2D(tRock, vWPos.xy*0.12).rgb*bl.z;
        float sandW = 1.0 - smoothstep(1.6, 2.6 + nz.r*1.2, h);
        float rockW = smoothstep(0.30, 0.45, slope + (nz2.r-0.5)*0.15);
        float dirtW = smoothstep(0.62, 0.72, nz.b) * (1.0-sandW);
        vec3 col = mix(grass, dirt, dirtW);
        col = mix(col, sand, sandW);
        col = mix(col, rock, rockW);
        // wet sand band & darker submerged sand
        float wet = smoothstep(1.0, 0.1, h) ;
        col *= mix(1.0, 0.62, wet);
        // underwater: absorption tint and animated caustics
        float depth = max(0.0, -h);
        if (h < 0.15) {
          float c = caustic(vWPos.xz, time) * sunIntensity * exp(-depth*0.12) * smoothstep(0.15, -0.6, h);
          col += vec3(0.55,0.75,0.7) * c * 0.35;
          col = mix(col, waterTint, 1.0 - exp(-depth*0.09));
        }
        diffuseColor.rgb = col;
        float wetRough = mix(0.92, 0.35, wet * step(-0.2, h));
        // rain soaks everything above the tide line: darker, glossier, rock least of all
        float soak = rainWet * step(-0.2, h) * (1.0 - rockW * 0.45);
        diffuseColor.rgb *= mix(1.0, 0.66 + 0.12 * (1.0 - sandW), soak);
        wetRough = mix(wetRough, 0.32 + 0.2 * (1.0 - sandW), soak);
      `)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = wetRough;');
  };
  mat.customProgramCacheKey = () => (far ? 'terrain-far' : 'terrain-near');
  return mat;
}

function buildGrid(gen: WorldGen, x0: number, z0: number, size: number, segs: number, skirt: boolean): THREE.BufferGeometry {
  const n = segs + 1;
  const extra = skirt ? 4 * n : 0;
  const pos = new Float32Array((n * n + extra) * 3);
  const nor = new Float32Array((n * n + extra) * 3);
  const step = size / segs;
  const hts = new Float32Array((n + 2) * (n + 2));
  // heights with a 1-cell border for normals
  for (let j = -1; j <= n; j++) for (let i = -1; i <= n; i++) hts[(j + 1) * (n + 2) + (i + 1)] = gen.heightAt(x0 + i * step, z0 + j * step);
  const H = (i: number, j: number) => hts[(j + 1) * (n + 2) + (i + 1)]!;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = (j * n + i) * 3;
    pos[k] = x0 + i * step; pos[k + 1] = H(i, j); pos[k + 2] = z0 + j * step;
    const nx = H(i - 1, j) - H(i + 1, j), nz = H(i, j - 1) - H(i, j + 1), ny = 2 * step;
    const l = Math.hypot(nx, ny, nz);
    nor[k] = nx / l; nor[k + 1] = ny / l; nor[k + 2] = nz / l;
  }
  const idx: number[] = [];
  for (let j = 0; j < segs; j++) for (let i = 0; i < segs; i++) {
    const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  if (skirt) {
    // skirt vertices hang 3 m below each edge vertex to hide LOD cracks
    let s = n * n;
    const edges: number[][] = [[], [], [], []];
    for (let i = 0; i < n; i++) { edges[0]!.push(i); edges[1]!.push((n - 1) * n + i); edges[2]!.push(i * n); edges[3]!.push(i * n + n - 1); }
    for (let e = 0; e < 4; e++) {
      const start = s;
      for (const v of edges[e]!) {
        pos[s * 3] = pos[v * 3]!; pos[s * 3 + 1] = pos[v * 3 + 1]! - 3; pos[s * 3 + 2] = pos[v * 3 + 2]!;
        nor[s * 3] = nor[v * 3]!; nor[s * 3 + 1] = nor[v * 3 + 1]!; nor[s * 3 + 2] = nor[v * 3 + 2]!;
        s++;
      }
      const ev = edges[e]!;
      for (let i = 0; i < ev.length - 1; i++) {
        const a = ev[i]!, b = ev[i + 1]!, c = start + i, d = start + i + 1;
        idx.push(a, b, c, b, d, c, a, c, b, b, c, d); // both windings: cheap, invisible
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

interface Chunk { key: string; cx: number; cz: number; lod: number; mesh: THREE.Mesh | null; wantLod: number }

export class TerrainSystem {
  group = new THREE.Group();
  uniforms: TerrainUniforms = {
    time: { value: 0 }, sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunIntensity: { value: 1 }, nearRadius: { value: 300 },
    camPos: { value: new THREE.Vector3() }, waterTint: { value: new THREE.Color(0.05, 0.3, 0.33) }, rainWet: { value: 0 },
  };
  private nearMat = makeTerrainMaterial(this.uniforms, false);
  private farMat = makeTerrainMaterial(this.uniforms, true);
  private chunks = new Map<string, Chunk>();
  private relevant = new Set<string>();
  private queue: Chunk[] = [];
  private abyss: THREE.Mesh;
  nearRadius = 320;
  detail = 2;
  generated = 0;
  // depth texture for the ocean
  heightTex: THREE.DataTexture;
  heightCenter = new THREE.Vector2(1e9, 1e9);
  readonly heightRes = 384;
  readonly heightSpan = 1536;
  private heightData: Uint16Array;
  private heightJob: { row: number; cx: number; cz: number } | null = null;
  private pendingCenter = new THREE.Vector2();
  onHeightTexReady: (() => void) | null = null;

  constructor(private gen: WorldGen) {
    // far island meshes
    for (const isl of gen.islands) {
      const span = isl.radius * 4.4;
      const g = buildGrid(gen, isl.x - span / 2, isl.z - span / 2, span, Math.min(128, Math.max(48, Math.round(span / 10))), false);
      const m = new THREE.Mesh(g, this.farMat);
      m.receiveShadow = true;
      m.name = `island-far-${isl.id}`;
      this.group.add(m);
    }
    // chunks that intersect island influence
    for (const isl of gen.islands) {
      const r = isl.radius * 2.0;
      for (let cx = Math.floor((isl.x - r) / CHUNK); cx <= Math.floor((isl.x + r) / CHUNK); cx++)
        for (let cz = Math.floor((isl.z - r) / CHUNK); cz <= Math.floor((isl.z + r) / CHUNK); cz++) this.relevant.add(`${cx},${cz}`);
    }
    this.abyss = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x0a2a30, roughness: 1 }));
    this.abyss.position.y = -52;
    this.group.add(this.abyss);
    this.heightData = new Uint16Array(this.heightRes * this.heightRes);
    this.heightTex = new THREE.DataTexture(this.heightData, this.heightRes, this.heightRes, THREE.RedFormat, THREE.HalfFloatType);
    this.heightTex.magFilter = THREE.LinearFilter;
    this.heightTex.minFilter = THREE.LinearFilter;
    this.heightTex.wrapS = this.heightTex.wrapT = THREE.ClampToEdgeWrapping;
  }

  setQuality(viewDistance: number, detail: number): void {
    this.detail = detail;
    this.nearRadius = Math.min(viewDistance * 0.4, 180 + detail * 90);
    for (const c of this.chunks.values()) c.wantLod = -1; // force re-evaluation
  }

  private lodFor(dist: number): number {
    const d = this.detail;
    if (dist < 70 + d * 25) return d >= 3 ? 64 : 32;
    if (dist < 150 + d * 40) return d >= 2 ? 32 : 16;
    return d >= 3 ? 16 : 8;
  }

  update(cam: THREE.Vector3, budgetMs = 3): void {
    this.uniforms.camPos.value.copy(cam);
    this.uniforms.nearRadius.value = this.nearRadius;
    this.abyss.position.x = cam.x;
    this.abyss.position.z = cam.z;
    const R = this.nearRadius;
    const ccx = Math.floor(cam.x / CHUNK), ccz = Math.floor(cam.z / CHUNK);
    const rc = Math.ceil(R / CHUNK) + 1;
    const want = new Set<string>();
    for (let dx = -rc; dx <= rc; dx++) for (let dz = -rc; dz <= rc; dz++) {
      const cx = ccx + dx, cz = ccz + dz;
      const key = `${cx},${cz}`;
      if (!this.relevant.has(key)) continue;
      const mx = (cx + 0.5) * CHUNK, mz = (cz + 0.5) * CHUNK;
      const dist = Math.max(0, Math.hypot(mx - cam.x, mz - cam.z) - CHUNK * 0.71);
      if (dist > R) continue;
      want.add(key);
      let c = this.chunks.get(key);
      if (!c) { c = { key, cx, cz, lod: 0, mesh: null, wantLod: 0 }; this.chunks.set(key, c); }
      const lod = this.lodFor(dist);
      if (c.lod !== lod && c.wantLod !== lod) { c.wantLod = lod; this.queue.push(c); }
    }
    for (const [key, c] of this.chunks) {
      if (want.has(key)) continue;
      if (c.mesh) { this.group.remove(c.mesh); c.mesh.geometry.dispose(); }
      this.chunks.delete(key);
    }
    // generate nearest first
    this.queue = this.queue.filter((c) => this.chunks.get(c.key) === c && c.wantLod !== c.lod);
    this.queue.sort((a, b) => Math.hypot((a.cx + 0.5) * CHUNK - cam.x, (a.cz + 0.5) * CHUNK - cam.z) - Math.hypot((b.cx + 0.5) * CHUNK - cam.x, (b.cz + 0.5) * CHUNK - cam.z));
    const t0 = performance.now();
    while (this.queue.length && performance.now() - t0 < budgetMs) {
      const c = this.queue.shift()!;
      const g = buildGrid(this.gen, c.cx * CHUNK, c.cz * CHUNK, CHUNK, c.wantLod, true);
      if (c.mesh) { c.mesh.geometry.dispose(); c.mesh.geometry = g; }
      else {
        c.mesh = new THREE.Mesh(g, this.nearMat);
        c.mesh.receiveShadow = true;
        c.mesh.castShadow = false;
        this.group.add(c.mesh);
      }
      c.lod = c.wantLod;
      this.generated++;
    }
    this.updateHeightTex(cam, 2);
  }

  /** pending chunk builds (for loading screens) */
  get backlog(): number { return this.queue.length; }

  private updateHeightTex(cam: THREE.Vector3, budgetMs: number) {
    const snap = 128;
    const cx = Math.round(cam.x / snap) * snap, cz = Math.round(cam.z / snap) * snap;
    if (!this.heightJob && (Math.abs(cx - this.heightCenter.x) > 256 || Math.abs(cz - this.heightCenter.y) > 256)) {
      this.heightJob = { row: 0, cx, cz };
    }
    const job = this.heightJob;
    if (!job) return;
    const t0 = performance.now();
    const res = this.heightRes, span = this.heightSpan, step = span / res;
    while (job.row < res && performance.now() - t0 < budgetMs) {
      const z = job.cz - span / 2 + (job.row + 0.5) * step;
      for (let i = 0; i < res; i++) {
        const x = job.cx - span / 2 + (i + 0.5) * step;
        this.heightData[job.row * res + i] = THREE.DataUtils.toHalfFloat(this.gen.heightAt(x, z));
      }
      job.row++;
    }
    if (job.row >= res) {
      this.heightCenter.set(job.cx, job.cz);
      this.pendingCenter.set(job.cx, job.cz);
      this.heightTex.needsUpdate = true;
      this.heightJob = null;
      this.onHeightTexReady?.();
    }
  }

  /** Synchronously finish the height texture (used during loading). */
  finishHeightTex(cam: THREE.Vector3): void { while (this.heightJob || this.heightCenter.x > 1e8) this.updateHeightTex(cam, 1000); }
}
