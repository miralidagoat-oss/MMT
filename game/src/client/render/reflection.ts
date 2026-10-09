/**
 * Planar water reflection: the scene rendered from the main camera mirrored in
 * the sea plane (y = 0), with an oblique near plane so nothing below the water
 * leaks in. The ocean shader projects each surface point with `textureMatrix`
 * and distorts the lookup by the wave normals, which hides the difference
 * between the flat mirror and the moving waves.
 *
 * Cost is one extra scene pass (no water, grass, particles or first-person
 * view model), at half or full render resolution depending on the setting.
 */
import * as THREE from 'three';

const NORMAL = new THREE.Vector3(0, 1, 0);
const CLIP_BIAS = 0.05;

export class WaterReflection {
  readonly rt: THREE.WebGLRenderTarget;
  readonly textureMatrix = new THREE.Matrix4();
  /** 0 off, 1 half resolution, 2 full resolution */
  level = 0;
  /** true when the last frame produced a usable reflection */
  valid = false;
  private cam = new THREE.PerspectiveCamera();
  private plane = new THREE.Plane();
  private clip = new THREE.Vector4();
  private q = new THREE.Vector4();
  private v = {
    planePos: new THREE.Vector3(0, 0, 0), camPos: new THREE.Vector3(), rot: new THREE.Matrix4(),
    view: new THREE.Vector3(), look: new THREE.Vector3(), target: new THREE.Vector3(),
  };
  private w = 1;
  private h = 1;

  constructor() {
    this.rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true });
    this.rt.texture.generateMipmaps = false;
  }

  setQuality(level: number, w: number, h: number) {
    this.level = level;
    const s = level >= 2 ? 1 : 0.5;
    const rw = Math.max(64, Math.round(w * s)), rh = Math.max(64, Math.round(h * s));
    if (rw !== this.w || rh !== this.h) { this.w = rw; this.h = rh; this.rt.setSize(rw, rh); }
  }

  /**
   * Render the mirrored view. `hide` lists objects that must not appear in the
   * reflection (the water itself, grass, particles, the view model...).
   */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, hide: (THREE.Object3D | null | undefined)[]): void {
    this.valid = false;
    if (this.level <= 0) return;
    const { planePos, camPos, rot, view, look, target } = this.v;
    camera.updateMatrixWorld();
    camPos.setFromMatrixPosition(camera.matrixWorld);
    view.subVectors(planePos, camPos);
    // camera under the plane: nothing to reflect from above
    if (view.dot(NORMAL) > 0) return;
    rot.extractRotation(camera.matrixWorld);

    view.reflect(NORMAL).negate().add(planePos);
    look.set(0, 0, -1).applyMatrix4(rot).add(camPos);
    target.subVectors(planePos, look).reflect(NORMAL).negate().add(planePos);

    const cam = this.cam;
    cam.position.copy(view);
    cam.up.set(0, 1, 0).applyMatrix4(rot).reflect(NORMAL);
    cam.lookAt(target);
    cam.near = camera.near;
    cam.far = camera.far;
    cam.updateMatrixWorld();
    cam.projectionMatrix.copy(camera.projectionMatrix);

    this.textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.textureMatrix.multiply(cam.projectionMatrix).multiply(cam.matrixWorldInverse);

    // oblique near plane = the water plane (Lengyel), so underwater geometry is clipped
    this.plane.setFromNormalAndCoplanarPoint(NORMAL, planePos).applyMatrix4(cam.matrixWorldInverse);
    this.clip.set(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z, this.plane.constant);
    const pm = cam.projectionMatrix.elements;
    this.q.set((Math.sign(this.clip.x) + pm[8]!) / pm[0]!, (Math.sign(this.clip.y) + pm[9]!) / pm[5]!, -1, (1 + pm[10]!) / pm[14]!);
    this.clip.multiplyScalar(2 / this.clip.dot(this.q));
    pm[2] = this.clip.x; pm[6] = this.clip.y; pm[10] = this.clip.z + 1 - CLIP_BIAS; pm[14] = this.clip.w;
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();

    const was = hide.map((o) => o?.visible ?? false);
    for (const o of hide) if (o) o.visible = false;
    const shadowAuto = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false; // reuse this frame's shadow maps
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.rt);
    renderer.clear();
    renderer.render(scene, cam);
    renderer.setRenderTarget(prevTarget);
    renderer.shadowMap.autoUpdate = shadowAuto;
    hide.forEach((o, i) => { if (o) o.visible = was[i]!; });
    this.valid = true;
  }
}
