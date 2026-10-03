/**
 * WorldRenderer: owns the WebGL renderer, scene graph and every visual system.
 * Resolution, quality and frame-rate settings are applied here.
 */
import * as THREE from 'three';
import type { ClientSession } from '../net/session';
import type { GraphicsSettings } from '../settings';
import { SkySystem } from './sky';
import { TerrainSystem } from './terrain';
import { OceanSystem } from './ocean';
import { VegetationSystem } from './vegetation';
import { EntityRenderer } from './entities';
import { Particles } from './particles';
import { PostFX } from './post';
import { ViewModel } from './viewmodel';
import { structureParts } from './structure-models';
import { setAnisotropy } from './textures';
import { hourOf } from '../../shared/systems/weather';

export interface FrameView {
  dt: number;
  time: number; // authoritative world time
  camPos: THREE.Vector3;
  yaw: number;
  pitch: number;
  underwater: boolean;
  damageFlash: number;
  lowHealth: number;
  cold: number;
  sleep: number;
  fov: number;
  zoom: number;
  torch: boolean;
}

export class WorldRenderer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  sky: SkySystem;
  terrain: TerrainSystem | null = null;
  ocean: OceanSystem | null = null;
  vegetation: VegetationSystem | null = null;
  entities: EntityRenderer | null = null;
  particles = new Particles();
  post: PostFX;
  viewmodel: ViewModel;
  private ghost: THREE.Group | null = null;
  private ghostType = '';
  private ghostMat = new THREE.MeshStandardMaterial({ color: 0x66ff88, transparent: true, opacity: 0.45, depthWrite: false, emissive: 0x114422 });
  private highlight: THREE.BoxHelper | null = null;
  private fishingLine: THREE.Line;
  private bobber: THREE.Mesh;
  settings: GraphicsSettings;
  private lastSize = '';
  private lightning = 0;
  private lastLightningAt = 0;
  stats = { fps: 0, frameMs: 0, drawCalls: 0, triangles: 0, renderW: 0, renderH: 0 };
  private fpsAcc = 0;
  private fpsFrames = 0;
  dynScale = 1;
  private menuOcean: OceanSystem | null = null;
  private menuT = 0;

  constructor(public canvas: HTMLCanvasElement, settings: GraphicsSettings) {
    this.settings = settings;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false, depth: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.9;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.info.autoReset = false;
    this.camera = new THREE.PerspectiveCamera(settings.fov, 16 / 9, 0.05, 12000);
    this.scene.add(this.camera);
    this.sky = new SkySystem(this.scene, this.renderer);
    this.scene.add(this.particles.group);
    this.post = new PostFX(this.renderer, this.scene, this.camera);
    this.viewmodel = new ViewModel(this.camera);
    const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    this.fishingLine = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 }));
    this.fishingLine.frustumCulled = false;
    this.fishingLine.visible = false;
    this.bobber = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), new THREE.MeshStandardMaterial({ color: 0xff3b2f, emissive: 0x220000 }));
    this.bobber.visible = false;
    this.scene.add(this.fishingLine, this.bobber);
    this.applySettings(settings);
  }

  /** Called once a world (seed) is known. */
  initWorld(session: ClientSession) {
    const gen = session.gen!;
    this.terrain = new TerrainSystem(gen);
    this.scene.add(this.terrain.group);
    this.ocean = new OceanSystem(this.terrain.heightTex, this.settings.waterQuality);
    this.scene.add(this.ocean.mesh);
    this.vegetation = new VegetationSystem(gen, (id) => session.isNodeDepleted(id));
    this.scene.add(this.vegetation.group);
    this.entities = new EntityRenderer(this.scene, gen, this.particles);
    if (this.menuOcean) this.menuOcean.mesh.visible = false;
    this.applySettings(this.settings);
  }

  disposeWorld() {
    for (const o of [this.terrain?.group, this.ocean?.mesh, this.vegetation?.group, this.entities?.group]) if (o) this.scene.remove(o);
    this.terrain = null; this.ocean = null; this.vegetation = null; this.entities = null;
    this.renderer.renderLists.dispose();
  }

  applySettings(g: GraphicsSettings) {
    this.settings = g;
    this.camera.fov = g.fov;
    this.sky.setShadowQuality(g.shadows);
    this.renderer.shadowMap.enabled = g.shadows > 0;
    this.terrain?.setQuality(g.viewDistance, g.terrainDetail);
    this.vegetation?.setQuality(g.viewDistance, g.vegetationDensity, g.grassDensity);
    this.camera.far = Math.max(4000, g.viewDistance * 4);
    this.camera.updateProjectionMatrix();
    setAnisotropy(Math.min(g.anisotropy, this.renderer.capabilities.getMaxAnisotropy()));
    if (this.entities) this.entities.lightBudget = g.shadows >= 3 ? 6 : 4;
    this.lastSize = '';
    this.resize();
  }

  /** Compute internal render resolution from settings (resolution preset x render scale). */
  resize() {
    const cw = Math.max(1, this.canvas.clientWidth), ch = Math.max(1, this.canvas.clientHeight);
    let w: number, h: number;
    if (this.settings.resolution === 'native') {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = cw * dpr; h = ch * dpr;
    } else {
      const [rw, rh] = this.settings.resolution.split('x').map(Number) as [number, number];
      // keep the window's aspect ratio, fit the preset's pixel count
      const aspect = cw / ch;
      h = rh; w = Math.round(h * aspect);
      if (w > rw * 1.4) { w = rw; h = Math.round(w / aspect); }
    }
    const scale = this.settings.renderScale * this.dynScale;
    w = Math.max(320, Math.round(w * scale));
    h = Math.max(180, Math.round(h * scale));
    const key = `${w}x${h}|${this.settings.antiAliasing}|${this.settings.bloom}|${this.settings.ambientOcclusion}|${this.settings.postProcessing}`;
    if (key === this.lastSize) return;
    const sizeOnly = this.lastSize && this.lastSize.split('|').slice(1).join('|') === key.split('|').slice(1).join('|');
    this.lastSize = key;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = cw / ch;
    this.camera.updateProjectionMatrix();
    if (sizeOnly) this.post.setSize(w, h);
    else this.post.configure(this.settings, w, h);
    this.particles.setPixelScale(h);
    this.stats.renderW = w; this.stats.renderH = h;
  }

  setGhost(type: string | null, pos?: THREE.Vector3, yaw = 0, valid = true) {
    if (!type) { if (this.ghost) this.ghost.visible = false; return; }
    if (this.ghostType !== type) {
      if (this.ghost) this.scene.remove(this.ghost);
      this.ghost = new THREE.Group();
      for (const p of structureParts(type)) this.ghost.add(new THREE.Mesh(p.geo, this.ghostMat));
      this.ghostType = type;
      this.scene.add(this.ghost);
    }
    this.ghost!.visible = true;
    this.ghost!.position.copy(pos!);
    this.ghost!.rotation.y = yaw;
    this.ghostMat.color.set(valid ? 0x66ff88 : 0xff5544);
    this.ghostMat.emissive.set(valid ? 0x114422 : 0x441111);
  }

  setHighlight(obj: THREE.Object3D | null) {
    if (!obj) { if (this.highlight) this.highlight.visible = false; return; }
    if (!this.highlight) {
      this.highlight = new THREE.BoxHelper(obj, 0xffffff);
      (this.highlight.material as THREE.LineBasicMaterial).transparent = true;
      (this.highlight.material as THREE.LineBasicMaterial).opacity = 0.5;
      this.scene.add(this.highlight);
    }
    this.highlight.setFromObject(obj);
    this.highlight.visible = true;
  }

  private updateOcean(ocean: OceanSystem, time: number, camPos: THREE.Vector3, w: { waves: number; windDir: number; cloud: number; rain: number }, heightCenter: THREE.Vector2) {
    const u = ocean.material.uniforms;
    u.time!.value = time;
    u.amp!.value = w.waves;
    u.windDir!.value = w.windDir;
    u.camPos!.value.copy(camPos);
    u.heightCenter!.value.copy(heightCenter);
    u.sunDir!.value.copy(this.sky.lightDir);
    u.sunColor!.value.copy(this.sky.sunColor);
    u.sunIntensity!.value = this.sky.daylight * (1 - w.cloud * 0.7) + 0.05;
    u.skyColor!.value.copy(this.sky.zenithColor);
    u.horizonColor!.value.copy(this.sky.horizonColor);
    u.daylight!.value = 0.08 + this.sky.daylight * 0.92;
    u.rain!.value = w.rain;
    if (this.sky.envMap && u.envMap!.value !== this.sky.envMap) ocean.setEnv(this.sky.envMap);
  }

  /** Main-menu backdrop: open ocean at golden hour with a slowly drifting camera. */
  renderMenu(dt: number) {
    this.resize();
    if (!this.menuOcean) {
      const tex = new THREE.DataTexture(new Uint16Array([THREE.DataUtils.toHalfFloat(-40)]), 1, 1, THREE.RedFormat, THREE.HalfFloatType);
      tex.needsUpdate = true;
      this.menuOcean = new OceanSystem(tex, this.settings.waterQuality);
      this.scene.add(this.menuOcean.mesh);
    }
    this.menuOcean.mesh.visible = !this.terrain;
    this.menuT += dt;
    const t = this.menuT;
    const cam = this.camera;
    cam.position.set(Math.sin(t * 0.02) * 30, 3.2 + Math.sin(t * 0.4) * 0.15, Math.cos(t * 0.02) * 30);
    cam.rotation.set(0.02 + Math.sin(t * 0.3) * 0.01, -2.2 + t * 0.012, Math.sin(t * 0.5) * 0.01, 'YXZ');
    if (Math.abs(cam.fov - this.settings.fov) > 0.01) { cam.fov = this.settings.fov; cam.updateProjectionMatrix(); }
    const w = { cloud: 0.38, rain: 0, fog: 0.05, wind: 0.45, windDir: 0.6, waves: 1.0 };
    this.sky.update({ hour: 17.7, cloud: w.cloud, rain: w.rain, fog: w.fog, wind: w.wind, windDir: w.windDir, underwater: false, lightning: 0, time: t }, cam);
    this.sky.updateProbe(t);
    this.updateOcean(this.menuOcean, t, cam.position, w, new THREE.Vector2(1e6, 1e6));
    const g = this.post.grade.uniforms;
    g.underwater!.value = 0; g.damage!.value = 0; g.lowHealth!.value = 0; g.flash!.value = 0; g.cold!.value = 0; g.sleep!.value = 0;
    const sunW = this.sky.sunDir.clone().multiplyScalar(5000).add(cam.position).project(cam);
    g.sunScreen!.value.set(sunW.x * 0.5 + 0.5, sunW.y * 0.5 + 0.5);
    g.sunVisible!.value = sunW.z < 1 && Math.abs(sunW.x) < 1.6 ? 0.6 : 0;
    g.sunColor!.value.copy(this.sky.sunColor);
    this.particles.update(dt, cam.position, 0, w.wind, w.windDir, false);
    this.renderer.info.reset();
    this.post.render(dt);
  }

  render(session: ClientSession, v: FrameView) {
    this.resize();
    const cam = this.camera;
    cam.position.copy(v.camPos);
    cam.rotation.set(v.pitch, v.yaw, 0, 'YXZ');
    const fov = v.fov / v.zoom;
    if (Math.abs(cam.fov - fov) > 0.01) { cam.fov = fov; cam.updateProjectionMatrix(); }
    const w = session.weather;
    const hour = hourOf({ time: v.time, dayOffset: session.dayOffset });
    // lightning flash envelope
    if (w.lightningAt !== this.lastLightningAt && w.lightningAt > 0) { this.lastLightningAt = w.lightningAt; this.lightning = 1; }
    this.lightning = Math.max(0, this.lightning - v.dt * 3.5);
    const flash = this.lightning > 0 ? this.lightning * (0.6 + Math.random() * 0.4) : 0;
    this.sky.update({ hour, cloud: w.cloud, rain: w.rain, fog: w.fog, wind: w.wind, windDir: w.windDir, underwater: v.underwater, lightning: flash, time: v.time }, cam);
    this.sky.updateProbe(v.time);

    if (this.terrain) {
      this.terrain.update(v.camPos);
      const tu = this.terrain.uniforms;
      tu.time.value = v.time;
      tu.sunDir.value.copy(this.sky.lightDir);
      tu.sunIntensity.value = this.sky.daylight * (1 - w.cloud * 0.6);
    }
    if (this.ocean) this.updateOcean(this.ocean, v.time, v.camPos, w, this.terrain!.heightCenter);
    this.vegetation?.update(v.camPos, v.time, w.wind, w.windDir);
    if (this.entities) {
      this.entities.syncStructures(session);
      this.entities.syncItems(session);
      this.entities.syncContainers(session);
      const torchPos = v.camPos.clone().add(new THREE.Vector3(0.3, -0.2, -0.5).applyEuler(cam.rotation));
      this.entities.update(v.dt, session, cam, { on: v.torch, pos: torchPos, radius: 11 });
    }
    this.particles.update(v.dt, v.camPos, w.rain, w.wind, w.windDir, v.underwater);
    // fishing line
    const f = session.self?.fishing;
    if (f && this.viewmodel) {
      const by = session.waterLevel(f.x, f.z);
      const bob = f.phase === 'bite' ? Math.sin(v.time * 30) * 0.08 - 0.08 : Math.sin(v.time * 2) * 0.03;
      this.bobber.position.set(f.x, by + bob, f.z);
      this.bobber.visible = true;
      const pos = this.fishingLine.geometry.getAttribute('position') as THREE.BufferAttribute;
      pos.setXYZ(0, this.viewmodel.tip.x, this.viewmodel.tip.y, this.viewmodel.tip.z);
      pos.setXYZ(1, f.x, by + bob, f.z);
      pos.needsUpdate = true;
      this.fishingLine.visible = true;
    } else { this.bobber.visible = false; this.fishingLine.visible = false; }

    // post uniforms
    const g = this.post.grade.uniforms;
    g.underwater!.value = v.underwater ? 1 : 0;
    g.damage!.value = v.damageFlash;
    g.lowHealth!.value = v.lowHealth;
    g.flash!.value = flash * 0.35;
    g.cold!.value = v.cold;
    g.sleep!.value = v.sleep;
    const sunW = this.sky.sunDir.clone().multiplyScalar(5000).add(v.camPos).project(cam);
    g.sunScreen!.value.set(sunW.x * 0.5 + 0.5, sunW.y * 0.5 + 0.5);
    const facing = sunW.z < 1 && Math.abs(sunW.x) < 1.6 && Math.abs(sunW.y) < 1.6;
    g.sunVisible!.value = facing ? Math.max(0, this.sky.sunDir.y + 0.05) * (1 - w.cloud * 0.85) * Math.min(1, this.sky.daylight * 2) : 0;
    g.sunColor!.value.copy(this.sky.sunColor);

    const t0 = performance.now();
    this.renderer.info.reset();
    this.post.render(v.dt);
    const info = this.renderer.info.render;
    this.stats.drawCalls = info.calls;
    this.stats.triangles = info.triangles;
    this.stats.frameMs = performance.now() - t0;
    this.fpsAcc += v.dt; this.fpsFrames++;
    if (this.fpsAcc >= 0.5) { this.stats.fps = Math.round(this.fpsFrames / this.fpsAcc); this.fpsAcc = 0; this.fpsFrames = 0; }
  }
}
