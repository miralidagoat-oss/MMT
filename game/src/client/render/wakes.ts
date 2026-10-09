/**
 * Foam wakes: each moving boat or swimmer leaves a ribbon of foam on the water
 * that widens and fades over a few seconds. Points ride the analytic wave
 * surface so the trail bobs with the sea.
 */
import * as THREE from 'three';
import { textures } from './textures';

export interface WakeSource { id: string; x: number; z: number; speed: number; width: number }

interface Pt { x: number; z: number; t: number; w: number; s: number }
interface Trail { pts: Pt[]; lastSeen: number }

const LIFE = 7;
const MAX_PTS = 48;

export class Wakes {
  readonly mesh: THREE.Mesh;
  private trails = new Map<string, Trail>();
  private geo = new THREE.BufferGeometry();
  private pos = new Float32Array(0);
  private uvs = new Float32Array(0);
  private alpha = new Float32Array(0);
  private mat: THREE.ShaderMaterial;

  constructor() {
    this.mat = new THREE.ShaderMaterial({
      uniforms: { tFoam: { value: textures().foam }, light: { value: 1 }, time: { value: 0 } },
      vertexShader: `attribute float aAlpha; varying vec2 vUv; varying float vA; varying vec2 vW;
        void main(){ vUv = uv; vA = aAlpha; vW = position.xz; gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform sampler2D tFoam; uniform float light, time; varying vec2 vUv; varying float vA; varying vec2 vW;
        void main(){
          float u = vUv.x, age = vUv.y;
          // bright churned water behind the stern, two foam lines spreading at the edges
          float e = abs(u - 0.5);
          float edges = smoothstep(0.36, 0.47, e) * (1.0 - smoothstep(0.47, 0.5, e));
          float centre = (1.0 - smoothstep(0.0, 0.38, e)) * (1.0 - smoothstep(0.0, 0.5, age));
          float foam = texture2D(tFoam, vW * 0.28 + vec2(time * 0.02, 0.0)).r;
          float f = (edges * 1.0 + centre * 0.95) * smoothstep(0.12, 0.6, foam + centre * 0.4);
          float a = f * vA;
          if (a < 0.01) discard;
          gl_FragColor = vec4(vec3(0.93, 0.97, 0.98) * light, a);
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  /**
   * sources: everything leaving a wake this frame; waterY samples the wave surface.
   * now: client seconds; light: 0..1 daylight-ish brightness.
   */
  update(now: number, time: number, sources: WakeSource[], waterY: (x: number, z: number) => number, light: number) {
    this.mat.uniforms.time!.value = time;
    this.mat.uniforms.light!.value = 0.25 + light * 0.75;
    for (const s of sources) {
      let tr = this.trails.get(s.id);
      if (!tr) { tr = { pts: [], lastSeen: now }; this.trails.set(s.id, tr); }
      tr.lastSeen = now;
      const last = tr.pts[tr.pts.length - 1];
      const moved = last ? Math.hypot(s.x - last.x, s.z - last.z) : Infinity;
      if (s.speed > 0.6 && (moved > 0.9 || now - (last?.t ?? 0) > 0.35)) {
        const strength = Math.min(1, s.speed / 4);
        // fill the gap since the last point so trails stay smooth at low frame rates
        const steps = last && moved !== Infinity && now - last.t < 6 ? Math.min(10, Math.max(1, Math.floor(moved / 0.9))) : 1;
        for (let k = 1; k <= steps; k++) {
          const f = k / steps;
          const x = last && steps > 1 ? last.x + (s.x - last.x) * f : s.x;
          const z = last && steps > 1 ? last.z + (s.z - last.z) * f : s.z;
          const t = last && steps > 1 ? last.t + (now - last.t) * f : now;
          tr.pts.push({ x, z, t, w: s.width, s: strength });
        }
        while (tr.pts.length > MAX_PTS) tr.pts.shift();
      }
    }
    // build the ribbons
    let quads = 0;
    for (const [id, tr] of this.trails) {
      while (tr.pts.length && now - tr.pts[0]!.t > LIFE) tr.pts.shift();
      if (!tr.pts.length && now - tr.lastSeen > 1) { this.trails.delete(id); continue; }
      quads += Math.max(0, tr.pts.length - 1);
    }
    const need = quads * 6;
    if (this.pos.length < need * 3) {
      this.pos = new Float32Array(need * 3 + 600);
      this.uvs = new Float32Array(need * 2 + 400);
      this.alpha = new Float32Array(need + 200);
      this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
      this.geo.setAttribute('uv', new THREE.BufferAttribute(this.uvs, 2));
      this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    }
    let v = 0;
    const put = (x: number, z: number, u: number, age: number, a: number) => {
      this.pos[v * 3] = x; this.pos[v * 3 + 1] = waterY(x, z) + 0.05; this.pos[v * 3 + 2] = z;
      this.uvs[v * 2] = u; this.uvs[v * 2 + 1] = age;
      this.alpha[v] = a;
      v++;
    };
    for (const tr of this.trails.values()) {
      const p = tr.pts;
      for (let i = 1; i < p.length; i++) {
        const a = p[i - 1]!, b = p[i]!;
        let dx = b.x - a.x, dz = b.z - a.z;
        const len = Math.hypot(dx, dz) || 1;
        dx /= len; dz /= len;
        const ageA = (now - a.t) / LIFE, ageB = (now - b.t) / LIFE;
        // the wake spreads as it ages
        const wa = a.w * (0.6 + ageA * 2.2), wb = b.w * (0.6 + ageB * 2.2);
        const fa = Math.sqrt(1 - ageA) * a.s, fb = Math.sqrt(1 - ageB) * b.s;
        const ax0 = a.x - dz * wa, az0 = a.z + dx * wa, ax1 = a.x + dz * wa, az1 = a.z - dx * wa;
        const bx0 = b.x - dz * wb, bz0 = b.z + dx * wb, bx1 = b.x + dz * wb, bz1 = b.z - dx * wb;
        put(ax0, az0, 0, ageA, fa); put(ax1, az1, 1, ageA, fa); put(bx1, bz1, 1, ageB, fb);
        put(ax0, az0, 0, ageA, fa); put(bx1, bz1, 1, ageB, fb); put(bx0, bz0, 0, ageB, fb);
      }
    }
    this.geo.setDrawRange(0, v);
    for (const name of ['position', 'uv', 'aAlpha']) { const at = this.geo.getAttribute(name); if (at) at.needsUpdate = true; }
    this.mesh.visible = v > 0;
  }

  clear() { this.trails.clear(); this.geo.setDrawRange(0, 0); this.mesh.visible = false; }
}
