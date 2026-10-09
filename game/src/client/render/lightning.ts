/**
 * Visible lightning: a jagged, branching bolt built as camera-facing ribbons
 * somewhere out at sea, shown for the length of the flash.
 */
import * as THREE from 'three';

export class LightningBolt {
  readonly mesh: THREE.Mesh;
  private mat: THREE.MeshBasicMaterial;

  constructor() {
    this.mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 6.5, 9), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = -6;
  }

  /** Build a new bolt out at sea; most strikes land in front of the player so they are seen. */
  strike(camPos: THREE.Vector3, camYaw: number, rnd: () => number) {
    const ahead = Math.atan2(-Math.cos(camYaw), -Math.sin(camYaw));
    const az = rnd() < 0.7 ? ahead + (rnd() - 0.5) * 1.6 : rnd() * Math.PI * 2;
    const dist = 700 + rnd() * 900;
    const base = new THREE.Vector3(camPos.x + Math.cos(az) * dist, 0, camPos.z + Math.sin(az) * dist);
    const top = base.clone().add(new THREE.Vector3((rnd() - 0.5) * 220, 520 + rnd() * 200, (rnd() - 0.5) * 220));
    const pos: number[] = [];
    // camera-facing side vector for the ribbons
    const toCam = new THREE.Vector3().subVectors(camPos, base).setY(0).normalize();
    const side = new THREE.Vector3(-toCam.z, 0, toCam.x);
    const seg = (a: THREE.Vector3, b: THREE.Vector3, w: number) => {
      const s = side.clone().multiplyScalar(w);
      pos.push(a.x - s.x, a.y, a.z - s.z, a.x + s.x, a.y, a.z + s.z, b.x + s.x, b.y, b.z + s.z);
      pos.push(a.x - s.x, a.y, a.z - s.z, b.x + s.x, b.y, b.z + s.z, b.x - s.x, b.y, b.z - s.z);
    };
    const bolt = (from: THREE.Vector3, to: THREE.Vector3, width: number, depth: number) => {
      // midpoint displacement
      let pts = [from, to];
      for (let i = 0; i < 6; i++) {
        const next: THREE.Vector3[] = [pts[0]!];
        for (let k = 1; k < pts.length; k++) {
          const a = pts[k - 1]!, b = pts[k]!;
          const len = a.distanceTo(b);
          const m = a.clone().lerp(b, 0.5).add(new THREE.Vector3((rnd() - 0.5) * len * 0.35, (rnd() - 0.5) * len * 0.08, (rnd() - 0.5) * len * 0.35));
          next.push(m, b);
        }
        pts = next;
      }
      for (let k = 1; k < pts.length; k++) {
        seg(pts[k - 1]!, pts[k]!, width);
        if (depth < 2 && rnd() < 0.05) {
          const start = pts[k]!;
          const end = start.clone().add(new THREE.Vector3((rnd() - 0.5) * 160, -60 - rnd() * 140, (rnd() - 0.5) * 160));
          bolt(start, end, width * 0.55, depth + 1);
        }
      }
    };
    bolt(top, base, 2.2, 0);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.mesh.geometry.dispose();
    this.mesh.geometry = g;
    this.mesh.visible = true;
  }

  /** intensity: the flash envelope, 1 at the strike fading to 0 */
  update(intensity: number) {
    this.mat.opacity = Math.min(1, intensity * 1.4);
    this.mesh.visible = intensity > 0.02;
  }
}
