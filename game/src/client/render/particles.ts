/**
 * Pooled CPU particle system (fixed capacity, zero per-frame allocation) and rain.
 */
import * as THREE from 'three';
import { textures } from './textures';

interface Pool {
  points: THREE.Points;
  pos: Float32Array; col: Float32Array; size: Float32Array;
  vel: Float32Array; life: Float32Array; maxLife: Float32Array; grow: Float32Array; drag: Float32Array; grav: Float32Array; baseSize: Float32Array; fade: Float32Array;
  next: number;
  cap: number;
}

function makePool(cap: number, additive: boolean): Pool {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(cap * 3), col = new Float32Array(cap * 4), size = new Float32Array(cap);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('color', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('size', new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
  const mat = new THREE.ShaderMaterial({
    uniforms: { tex: { value: textures().particle }, scale: { value: 600 } },
    vertexShader: `attribute float size; attribute vec4 color; varying vec4 vCol; uniform float scale;
      void main(){ vCol = color; vec4 mv = modelViewMatrix*vec4(position,1.0); gl_Position = projectionMatrix*mv; gl_PointSize = size*scale/max(-mv.z,0.1); }`,
    fragmentShader: `uniform sampler2D tex; varying vec4 vCol; void main(){ vec4 t = texture2D(tex, gl_PointCoord); gl_FragColor = vec4(vCol.rgb, vCol.a*t.a); if(gl_FragColor.a<0.01) discard; }`,
    transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  const points = new THREE.Points(g, mat);
  points.frustumCulled = false;
  points.renderOrder = 5;
  return {
    points, pos, col, size, vel: new Float32Array(cap * 3), life: new Float32Array(cap), maxLife: new Float32Array(cap), grow: new Float32Array(cap),
    drag: new Float32Array(cap), grav: new Float32Array(cap), baseSize: new Float32Array(cap), fade: new Float32Array(cap * 4), next: 0, cap,
  };
}

export interface EmitOpts {
  count: number; spread: number; speed: number; up?: number; life: [number, number]; size: [number, number]; grow?: number;
  color: THREE.ColorRepresentation; color2?: THREE.ColorRepresentation; alpha?: number; gravity?: number; drag?: number; additive?: boolean;
}

const c1 = new THREE.Color(), c2 = new THREE.Color();

export class Particles {
  group = new THREE.Group();
  private add: Pool;
  private norm: Pool;
  rain: THREE.LineSegments;
  private rainPos: Float32Array;
  private rainCount = 6000;
  rainIntensity = 0;

  constructor() {
    this.add = makePool(3000, true);
    this.norm = makePool(3000, false);
    this.group.add(this.add.points, this.norm.points);
    // rain streaks in a box around the camera
    const n = this.rainCount;
    this.rainPos = new Float32Array(n * 6);
    for (let i = 0; i < n; i++) {
      const x = (Math.random() - 0.5) * 60, y = Math.random() * 40, z = (Math.random() - 0.5) * 60;
      this.rainPos.set([x, y, z, x, y - 0.6, z], i * 6);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.rainPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.rain = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xaabbcc, transparent: true, opacity: 0.35, depthWrite: false }));
    this.rain.frustumCulled = false;
    this.group.add(this.rain);
  }

  emit(at: THREE.Vector3 | { x: number; y: number; z: number }, o: EmitOpts): void {
    const pool = o.additive ? this.add : this.norm;
    c1.set(o.color);
    c2.set(o.color2 ?? o.color);
    for (let k = 0; k < o.count; k++) {
      const i = pool.next;
      pool.next = (pool.next + 1) % pool.cap;
      const a = Math.random() * Math.PI * 2, r = Math.random() * o.spread;
      pool.pos[i * 3] = at.x + Math.cos(a) * r;
      pool.pos[i * 3 + 1] = at.y + (Math.random() - 0.5) * o.spread * 0.5;
      pool.pos[i * 3 + 2] = at.z + Math.sin(a) * r;
      const dx = Math.random() - 0.5, dy = Math.random() - 0.5, dz = Math.random() - 0.5;
      pool.vel[i * 3] = dx * o.speed * 2;
      pool.vel[i * 3 + 1] = dy * o.speed + (o.up ?? 0);
      pool.vel[i * 3 + 2] = dz * o.speed * 2;
      const life = o.life[0] + Math.random() * (o.life[1] - o.life[0]);
      pool.life[i] = life; pool.maxLife[i] = life;
      pool.baseSize[i] = o.size[0] + Math.random() * (o.size[1] - o.size[0]);
      pool.grow[i] = o.grow ?? 0;
      pool.grav[i] = o.gravity ?? 0;
      pool.drag[i] = o.drag ?? 0;
      const t = Math.random();
      pool.fade[i * 4] = c1.r + (c2.r - c1.r) * t;
      pool.fade[i * 4 + 1] = c1.g + (c2.g - c1.g) * t;
      pool.fade[i * 4 + 2] = c1.b + (c2.b - c1.b) * t;
      pool.fade[i * 4 + 3] = o.alpha ?? 1;
    }
  }

  // ------------------------------------------------------------- presets
  fire(at: THREE.Vector3, strength = 1) {
    this.emit(at, { count: Math.ceil(2 * strength), spread: 0.18, speed: 0.15, up: 1.4, life: [0.4, 0.9], size: [0.35, 0.6], grow: -0.4, color: '#ffb347', color2: '#ff4d1a', additive: true, alpha: 0.9 });
    if (Math.random() < 0.35 * strength) this.emit(at.clone().setY(at.y + 0.6), { count: 1, spread: 0.2, speed: 0.15, up: 0.9, life: [1.8, 3.2], size: [0.5, 0.8], grow: 1.2, color: '#555555', color2: '#888888', alpha: 0.35 });
    if (Math.random() < 0.15 * strength) this.emit(at, { count: 1, spread: 0.1, speed: 0.6, up: 2.2, life: [0.6, 1.2], size: [0.04, 0.07], color: '#ffd27a', additive: true, gravity: -0.5 });
  }
  splash(at: THREE.Vector3 | { x: number; y: number; z: number }, big = 1) {
    this.emit(at, { count: Math.ceil(14 * big), spread: 0.3 * big, speed: 1.5 * big, up: 3 * big, life: [0.5, 1.0], size: [0.12, 0.3], color: '#e8f4ff', alpha: 0.8, gravity: 9 });
  }
  chips(at: THREE.Vector3 | { x: number; y: number; z: number }, color: string, n = 10) {
    this.emit(at, { count: n, spread: 0.2, speed: 2.5, up: 2, life: [0.4, 0.9], size: [0.06, 0.12], color, gravity: 9.8 });
  }
  blood(at: THREE.Vector3 | { x: number; y: number; z: number }, underwater: boolean) {
    if (underwater) this.emit(at, { count: 12, spread: 0.3, speed: 0.4, up: 0.2, life: [2, 4], size: [0.6, 1.2], grow: 1, color: '#7a1010', alpha: 0.45 });
    else this.emit(at, { count: 10, spread: 0.1, speed: 2, up: 1.5, life: [0.4, 0.8], size: [0.06, 0.1], color: '#9a1515', gravity: 9.8 });
  }
  bubbles(at: THREE.Vector3 | { x: number; y: number; z: number }, n = 3) {
    this.emit(at, { count: n, spread: 0.15, speed: 0.2, up: 1.0, life: [1.5, 3], size: [0.04, 0.1], color: '#cfefff', alpha: 0.7, gravity: -0.6 });
  }
  sparkle(at: THREE.Vector3 | { x: number; y: number; z: number }, color = '#fff2a8') {
    this.emit(at, { count: 14, spread: 0.4, speed: 0.6, up: 0.8, life: [0.5, 1.1], size: [0.08, 0.16], color, additive: true });
  }
  dust(at: THREE.Vector3 | { x: number; y: number; z: number }) {
    this.emit(at, { count: 8, spread: 0.4, speed: 0.6, up: 0.4, life: [0.8, 1.6], size: [0.3, 0.6], grow: 0.8, color: '#c8b896', alpha: 0.4 });
  }

  update(dt: number, cam: THREE.Vector3, rain: number, wind: number, windDir: number, underwater: boolean) {
    for (const p of [this.add, this.norm]) {
      for (let i = 0; i < p.cap; i++) {
        if (p.life[i]! <= 0) { if (p.size[i] !== 0) { p.size[i] = 0; } continue; }
        p.life[i]! -= dt;
        const t = 1 - p.life[i]! / p.maxLife[i]!;
        const k = i * 3;
        const drag = Math.exp(-p.drag[i]! * dt);
        p.vel[k + 1]! -= p.grav[i]! * dt;
        p.vel[k]! *= drag; p.vel[k + 1]! *= drag; p.vel[k + 2]! *= drag;
        p.pos[k]! += p.vel[k]! * dt; p.pos[k + 1]! += p.vel[k + 1]! * dt; p.pos[k + 2]! += p.vel[k + 2]! * dt;
        p.size[i] = Math.max(0, p.baseSize[i]! * (1 + p.grow[i]! * t));
        const a = p.fade[i * 4 + 3]! * (t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85);
        p.col[i * 4] = p.fade[i * 4]!; p.col[i * 4 + 1] = p.fade[i * 4 + 1]!; p.col[i * 4 + 2] = p.fade[i * 4 + 2]!; p.col[i * 4 + 3] = a;
      }
      const g = p.points.geometry;
      (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      (g.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
      (g.getAttribute('size') as THREE.BufferAttribute).needsUpdate = true;
    }
    // rain
    this.rainIntensity = rain;
    this.rain.visible = rain > 0.02 && !underwater;
    if (this.rain.visible) {
      const n = Math.floor(this.rainCount * Math.min(1, rain * 1.2));
      const fall = 22 * dt;
      const wx = Math.cos(windDir) * wind * 6 * dt, wz = Math.sin(windDir) * wind * 6 * dt;
      const len = 0.5 + rain * 0.6;
      for (let i = 0; i < this.rainCount; i++) {
        const k = i * 6;
        if (i >= n) { this.rainPos[k + 1] = -9999; this.rainPos[k + 4] = -9999; continue; }
        let x = this.rainPos[k]! + wx, y = this.rainPos[k + 1]! - fall, z = this.rainPos[k + 2]! + wz;
        if (y < -5 || y < -100) { y = 35 + Math.random() * 5; x = (Math.random() - 0.5) * 60; z = (Math.random() - 0.5) * 60; }
        if (x > 30) x -= 60; if (x < -30) x += 60; if (z > 30) z -= 60; if (z < -30) z += 60;
        this.rainPos[k] = x; this.rainPos[k + 1] = y; this.rainPos[k + 2] = z;
        this.rainPos[k + 3] = x - wx * 3; this.rainPos[k + 4] = y + len; this.rainPos[k + 5] = z - wz * 3;
      }
      this.rain.position.set(cam.x, cam.y - 10, cam.z);
      (this.rain.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      (this.rain.material as THREE.LineBasicMaterial).opacity = 0.15 + rain * 0.3;
    }
  }

  setPixelScale(h: number) {
    for (const p of [this.add, this.norm]) (p.points.material as THREE.ShaderMaterial).uniforms.scale!.value = h * 0.6;
  }
}
