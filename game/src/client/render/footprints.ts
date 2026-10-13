/**
 * Footprints: walkers on sand leave alternating left/right prints that fade
 * over a minute (faster near the waterline, where the surf smooths them).
 * One instanced mesh of flat quads with a procedural print shape.
 */
import * as THREE from 'three';

export interface Walker { id: string; x: number; z: number; yaw: number; onGround: boolean }

const MAX = 600;
const LIFE = 70;
const STRIDE = 0.72;

interface Track { x: number; z: number; dist: number; left: boolean }

export class Footprints {
  readonly mesh: THREE.InstancedMesh;
  private fade: THREE.InstancedBufferAttribute;
  private born = new Float32Array(MAX);
  private life = new Float32Array(MAX);
  private next = 0;
  private tracks = new Map<string, Track>();
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private up = new THREE.Vector3(0, 1, 0);

  constructor(private heightAt: (x: number, z: number) => number) {
    const geo = new THREE.PlaneGeometry(0.13, 0.3).rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
      vertexShader: `attribute float aFade; varying vec2 vUv; varying float vF;
        void main(){ vUv = uv; vF = aFade; gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0); }`,
      fragmentShader: `varying vec2 vUv; varying float vF;
        void main(){
          // a sole (heel + ball + arch) and a row of toe dimples, laid out in metres
          vec2 m = (vUv - 0.5) * vec2(0.13, 0.3);
          float heel = 1.0 - smoothstep(0.8, 1.0, length((m - vec2(0.0, -0.085)) / vec2(0.036, 0.048)));
          float ball = 1.0 - smoothstep(0.8, 1.0, length((m - vec2(0.006, 0.04)) / vec2(0.046, 0.05)));
          float arch = 1.0 - smoothstep(0.75, 1.0, length((m - vec2(0.018, -0.02)) / vec2(0.022, 0.06)));
          float toes = 0.0;
          for (int i = 0; i < 5; i++) {
            float fi = float(i);
            vec2 c = vec2(-0.03 + fi * 0.016, 0.104 - abs(fi - 1.0) * 0.006);
            float r = fi < 0.5 ? 0.014 : 0.0105 - fi * 0.0008;
            toes = max(toes, 1.0 - smoothstep(0.75, 1.0, length(m - c) / r));
          }
          float a = max(max(heel, ball), max(arch * 0.7, toes * 0.9)) * vF * 0.9;
          if (a < 0.01) discard;
          // linear HDR colour (tone-mapped later): a shaded hollow in the sand
          gl_FragColor = vec4(0.07, 0.055, 0.035, a);
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -8,
    });
    this.fade = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1);
    geo.setAttribute('aFade', this.fade);
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.born.fill(-1e9);
  }

  private add(x: number, z: number, yaw: number, now: number, left: boolean) {
    const h = this.heightAt(x, z);
    const i = this.next;
    this.next = (this.next + 1) % MAX;
    this.q.setFromAxisAngle(this.up, yaw);
    // left prints are mirrored (big toe on the inside)
    this.m.compose(new THREE.Vector3(x, h + 0.06, z), this.q, new THREE.Vector3(left ? -1 : 1, 1, 1));
    this.mesh.setMatrixAt(i, this.m);
    this.born[i] = now;
    // wet sand near the water keeps prints only briefly
    this.life[i] = h < 0.7 ? 14 : LIFE;
    this.mesh.count = Math.max(this.mesh.count, i + 1);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  update(now: number, walkers: Walker[]) {
    for (const w of walkers) {
      const h = this.heightAt(w.x, w.z);
      const onSand = w.onGround && h > 0.05 && h < 2.4;
      let t = this.tracks.get(w.id);
      if (!t) { t = { x: w.x, z: w.z, dist: 0, left: false }; this.tracks.set(w.id, t); }
      const step = Math.hypot(w.x - t.x, w.z - t.z);
      t.x = w.x; t.z = w.z;
      if (!onSand || step > 4) { t.dist = 0; continue; } // teleports, boats and grass leave no prints
      t.dist += step;
      while (t.dist >= STRIDE) {
        t.dist -= STRIDE;
        t.left = !t.left;
        // the player's yaw faces -z; offset each print sideways from the walking line
        const side = t.left ? -0.11 : 0.11;
        const sx = Math.cos(w.yaw) * side, sz = -Math.sin(w.yaw) * side;
        this.add(w.x + sx, w.z + sz, w.yaw, now, t.left);
      }
    }
    // fade
    let any = false;
    for (let i = 0; i < this.mesh.count; i++) {
      const age = now - this.born[i]!;
      const f = age < 0 ? 0 : Math.max(0, 1 - age / this.life[i]!);
      this.fade.setX(i, f);
      if (f > 0) any = true;
    }
    this.fade.needsUpdate = true;
    this.mesh.visible = any;
  }

  clear() { this.tracks.clear(); this.mesh.count = 0; this.next = 0; this.born.fill(-1e9); }
}
