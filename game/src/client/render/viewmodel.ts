/**
 * First-person arms + held item. Lives as a scaled-down child of the camera
 * (so it never visibly clips into walls) with procedural sway/bob/swing.
 */
import * as THREE from 'three';
import { itemModel } from './models';
import { ITEMS } from '../../shared/defs/items';

const SCALE = 0.22;

export class ViewModel {
  root = new THREE.Group();
  private pivot = new THREE.Group();
  private item: THREE.Mesh | null = null;
  private itemId = '';
  private arm: THREE.Mesh;
  private mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75 });
  private swing = 0;
  private swingDur = 0.35;
  private bobT = 0;
  private sway = new THREE.Vector2();
  private draw = 0;
  private eat = 0;
  private hidden = false;
  readonly tip = new THREE.Vector3();

  constructor(camera: THREE.Camera) {
    this.root.scale.setScalar(SCALE);
    this.root.position.set(0.075, -0.07, -0.11);
    camera.add(this.root);
    this.root.add(this.pivot);
    const skin = new THREE.MeshStandardMaterial({ color: '#c99a76', roughness: 0.75 });
    this.arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.5, 4, 8), skin);
    this.arm.rotation.x = Math.PI / 2.3;
    this.arm.position.set(0.05, -0.12, 0.28);
    this.pivot.add(this.arm);
    this.root.traverse((o) => { o.frustumCulled = false; });
  }

  setItem(id: string | null) {
    const want = id ?? '';
    if (want === this.itemId) return;
    this.itemId = want;
    if (this.item) { this.pivot.remove(this.item); this.item = null; }
    if (!id) return;
    const g = itemModel(id, ITEMS[id]?.icon.color ?? '#fff');
    this.item = new THREE.Mesh(g, this.mat);
    this.item.frustumCulled = false;
    // hold upright-ish, angled away
    const long = id === 'crude_spear' || id === 'harpoon' || id === 'fishing_rod';
    this.item.rotation.set(long ? -1.2 : -0.35, 0.2, long ? 0 : -0.15);
    this.item.position.set(0, long ? -0.5 : -0.12, long ? 0.3 : 0);
    if (id === 'bow') { this.item.rotation.set(0, Math.PI / 2, 0.15); this.item.position.set(-0.05, -0.4, -0.1); }
    if (id === 'chart') { this.item.rotation.set(-1.0, 0, 0); this.item.position.set(-0.15, 0.05, -0.05); }
    this.pivot.add(this.item);
  }

  triggerSwing(duration = 0.35) { this.swing = duration; this.swingDur = duration; }
  triggerEat() { this.eat = 0.6; }
  setDraw(v: number) { this.draw = v; }
  setHidden(h: boolean) { this.hidden = h; this.root.visible = !h; }

  update(dt: number, speed: number, lookDX: number, lookDY: number, swimming: boolean, headBob: boolean) {
    if (this.hidden) return;
    this.bobT += dt * (speed > 0.5 ? 2 + speed * 1.4 : 1);
    const bobAmp = headBob ? Math.min(1, speed / 4) : 0;
    this.sway.x += (-lookDX * 0.002 - this.sway.x) * Math.min(1, dt * 10);
    this.sway.y += (lookDY * 0.002 - this.sway.y) * Math.min(1, dt * 10);
    const p = this.pivot;
    p.position.set(Math.sin(this.bobT) * 0.03 * bobAmp + this.sway.x, Math.abs(Math.cos(this.bobT)) * -0.03 * bobAmp + this.sway.y + Math.sin(this.bobT * 0.5) * 0.008, 0);
    p.rotation.set(0, 0, 0);
    if (swimming) { p.position.y -= 0.25; p.rotation.x = 0.3; }
    if (this.swing > 0) {
      this.swing = Math.max(0, this.swing - dt);
      const t = 1 - this.swing / this.swingDur;
      const s = t < 0.35 ? -t / 0.35 * 0.6 : Math.sin(((t - 0.35) / 0.65) * Math.PI) * 1.4 - (1 - t) * 0.2;
      p.rotation.x = -s;
      p.rotation.z = s * 0.3;
      p.position.z = -s * 0.15;
    }
    if (this.draw > 0) { p.position.z += this.draw * 0.15; p.rotation.z = -this.draw * 0.1; }
    if (this.eat > 0) {
      this.eat = Math.max(0, this.eat - dt);
      p.position.set(-0.25, 0.1, 0.1);
      p.rotation.x = -0.5;
    }
    if (this.item) {
      this.item.updateMatrixWorld();
      const tipLocal = new THREE.Vector3(0, this.itemId === 'fishing_rod' ? 1.6 : 0.6, 0);
      this.tip.copy(tipLocal).applyMatrix4(this.item.matrixWorld);
    }
  }
}
