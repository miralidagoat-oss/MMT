/**
 * Renders replicated world entities: structures, dropped items, containers,
 * wrecks/caves, remote players, creatures, vehicles, projectiles; manages a
 * small pool of dynamic point lights for fires and torches.
 */
import * as THREE from 'three';
import type { ClientSession } from '../net/session';
import type { WorldGen } from '../../shared/world/worldgen';
import { STRUCTURES } from '../../shared/defs/structures';
import { ITEMS } from '../../shared/defs/items';
import { CROPS } from '../../shared/defs/crops';
import { FLAG, type NetPlayer } from '../../shared/net/protocol';
import { structureParts, structureMaterials, type MatKey } from './structure-models';
import { creatureModel, humanoid, itemModel, vehicleModel, wreckModel, crateModel, part, merge, type Humanoid } from './models';
import { textures } from './textures';
import type { Particles } from './particles';

export interface Pickable { kind: 'structure' | 'item' | 'container' | 'creature' | 'vehicle' | 'player'; id: string }

const vtx = new THREE.Vector3();

interface PlayerView { h: Humanoid; tag: THREE.Sprite; held: THREE.Mesh | null; heldId: string; last: THREE.Vector3; speed: number; phase: number; light: boolean }

export class EntityRenderer {
  group = new THREE.Group();
  pickables: THREE.Object3D[] = [];
  private mats: Record<MatKey, THREE.Material>;
  private propMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
  private structures = new Map<string, { obj: THREE.Group; sig: string }>();
  private items = new Map<string, THREE.Mesh>();
  private containers = new Map<string, THREE.Mesh>();
  private players = new Map<string, PlayerView>();
  private creatures = new Map<string, { mesh: THREE.Mesh; phase: number }>();
  private vehicles = new Map<string, { group: THREE.Group; sail?: THREE.Mesh }>();
  private projectiles = new Map<string, THREE.Mesh>();
  private creatureGeo = new Map<string, THREE.BufferGeometry>();
  private itemGeo = new Map<string, THREE.BufferGeometry>();
  private lights: THREE.PointLight[] = [];
  private fireSpots: { pos: THREE.Vector3; strength: number; color: number; kind: 'fire' | 'torch' | 'lamp' | 'beacon' }[] = [];
  private time = 0;
  lightBudget = 6;

  constructor(private scene: THREE.Scene, private gen: WorldGen, private particles: Particles) {
    const t = textures();
    this.mats = structureMaterials(t);
    scene.add(this.group);
    for (let i = 0; i < 8; i++) {
      const l = new THREE.PointLight(0xff9a40, 0, 14, 1.6);
      l.castShadow = false;
      this.lights.push(l);
      this.group.add(l);
    }
    this.buildStatic();
  }

  /** Wrecks and caves are part of the pristine world (from the seed). */
  private buildStatic() {
    const hullMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, map: textures().wood });
    for (const w of this.gen.wrecks) {
      const m = new THREE.Mesh(wreckModel(w.kind, w.x | 0), hullMat);
      m.position.set(w.x, w.y - 0.3, w.z);
      m.rotation.set(0.15, w.yaw, w.kind === 'deep' ? 0.35 : 0.25);
      m.castShadow = true;
      m.receiveShadow = true;
      this.group.add(m);
    }
    const rockMat = new THREE.MeshStandardMaterial({ map: textures().rock, roughness: 0.95, color: 0x9a948a });
    for (const c of this.gen.caves) {
      const geos = c.rocks.map((r, i) => part(new THREE.IcosahedronGeometry(r.r, 1), '#ffffff', [r.x - c.x, r.y - c.y, r.z - c.z], [i * 0.7, i * 1.3, 0], [1, 0.9, 1]));
      const m = new THREE.Mesh(merge(geos), rockMat);
      // world-scale UVs from position for the rock texture
      const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute;
      const uv = m.geometry.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) + pos.getZ(i)) * 0.15, pos.getY(i) * 0.15);
      m.position.set(c.x, c.y, c.z);
      m.castShadow = true;
      m.receiveShadow = true;
      this.group.add(m);
    }
  }

  // ------------------------------------------------------------------ structures
  private structSig(s: { type: string; x: number; y: number; z: number; yaw: number; on?: boolean; crops?: unknown[] | undefined }) {
    const crops = (s.crops ?? []).map((c) => {
      const cc = c as { crop: string; growth: number; withered: boolean } | null;
      return cc ? `${cc.crop}${Math.floor(cc.growth * 4)}${cc.withered ? 'w' : ''}` : '-';
    }).join('');
    return `${s.type}|${s.x}|${s.y}|${s.z}|${s.yaw}|${s.on ? 1 : 0}|${crops}`;
  }

  syncStructures(session: ClientSession): void {
    const seen = new Set<string>();
    for (const s of Object.values(session.structures)) {
      seen.add(s.id);
      const sig = this.structSig(s);
      const cur = this.structures.get(s.id);
      if (cur && cur.sig === sig) continue;
      if (cur) this.removeObj(cur.obj);
      const g = new THREE.Group();
      for (const p of structureParts(s.type)) {
        const m = new THREE.Mesh(p.geo, this.mats[p.mat]);
        m.castShadow = p.mat !== 'glass' && p.mat !== 'glow';
        m.receiveShadow = true;
        m.userData.pick = { kind: 'structure', id: s.id } satisfies Pickable;
        g.add(m);
      }
      const def = STRUCTURES[s.type];
      if (def?.door && s.on) g.children.forEach((c) => { c.rotation.y = -Math.PI / 2; c.position.set(-0.59 + 0.04, 0, 0.59); });
      if (s.crops) this.addCrops(g, s.crops as ({ crop: string; growth: number; withered: boolean } | null)[], s.id);
      g.position.set(s.x, s.y, s.z);
      g.rotation.y = s.yaw;
      g.userData.pick = { kind: 'structure', id: s.id };
      this.group.add(g);
      for (const c of g.children) this.pickables.push(c);
      this.structures.set(s.id, { obj: g, sig });
    }
    for (const [id, v] of this.structures) if (!seen.has(id)) { this.removeObj(v.obj); this.structures.delete(id); }
  }

  private addCrops(g: THREE.Group, crops: ({ crop: string; growth: number; withered: boolean } | null)[], id: string) {
    crops.forEach((c, i) => {
      if (!c) return;
      const def = CROPS[c.crop];
      const stage = Math.min(4, Math.floor(c.growth * 4) + 1);
      const h = 0.15 + stage * 0.18;
      const col = c.withered ? '#6b5a3a' : c.growth >= 1 ? (c.crop === 'berry' ? '#c2324a' : '#5f9e3a') : '#6faf45';
      const x = (i % 2 ? 0.6 : -0.6), z = (i < 2 ? -0.6 : 0.6);
      const parts = [part(new THREE.ConeGeometry(0.12 + stage * 0.05, h, 5), col, [x, 0.32 + h / 2, z])];
      if (c.growth >= 1 && def) parts.push(part(new THREE.SphereGeometry(0.08, 6, 4), c.crop === 'taro' ? '#8d6aa8' : c.crop === 'flax' ? '#d9d07a' : '#c2324a', [x + 0.1, 0.4 + h * 0.6, z]));
      const m = new THREE.Mesh(merge(parts), this.propMat);
      m.userData.pick = { kind: 'structure', id };
      g.add(m);
    });
  }

  private removeObj(o: THREE.Object3D) {
    this.group.remove(o);
    o.traverse((c) => { const i = this.pickables.indexOf(c); if (i >= 0) this.pickables.splice(i, 1); });
  }

  // ------------------------------------------------------------------ items & containers
  private geoForItem(id: string): THREE.BufferGeometry {
    let g = this.itemGeo.get(id);
    if (!g) { g = itemModel(id, ITEMS[id]?.icon.color ?? '#ffffff'); this.itemGeo.set(id, g); }
    return g;
  }

  syncItems(session: ClientSession): void {
    const seen = new Set<string>();
    for (const it of Object.values(session.items)) {
      seen.add(it.id);
      let m = this.items.get(it.id);
      if (!m) {
        m = new THREE.Mesh(this.geoForItem(it.stack.id), this.propMat);
        m.castShadow = true;
        m.userData.pick = { kind: 'item', id: it.id } satisfies Pickable;
        this.items.set(it.id, m);
        this.group.add(m);
        this.pickables.push(m);
        m.rotation.y = (it.id.charCodeAt(1) % 10) * 0.6;
        if (it.stack.id === 'stick' || it.stack.id === 'arrow' || it.stack.id === 'log') m.rotation.z = Math.PI / 2;
      }
      m.userData.target = new THREE.Vector3(it.x, it.y, it.z);
      m.userData.floating = it.floating;
    }
    for (const [id, m] of this.items) if (!seen.has(id)) { this.removeObj(m); this.items.delete(id); }
  }

  syncContainers(session: ClientSession): void {
    const seen = new Set<string>();
    const owned = new Set<string>();
    for (const s of Object.values(session.structures)) if (s.containerId) owned.add(s.containerId);
    for (const v of session.vehicles()) owned.add(v.cid);
    for (const c of Object.values(session.containers)) {
      if (owned.has(c.id)) continue;
      seen.add(c.id);
      let m = this.containers.get(c.id);
      if (!m) {
        m = new THREE.Mesh(crateModel(c.kind), this.propMat);
        m.castShadow = true;
        m.userData.pick = { kind: 'container', id: c.id } satisfies Pickable;
        m.rotation.y = (c.id.length * 1.7) % 6.28;
        this.containers.set(c.id, m);
        this.group.add(m);
        this.pickables.push(m);
      }
      m.position.set(c.x, c.y - (c.kind === 'crate' ? 0.6 : 0), c.z);
    }
    for (const [id, m] of this.containers) if (!seen.has(id)) { this.removeObj(m); this.containers.delete(id); }
  }

  // ------------------------------------------------------------------ dynamic entities
  private playerView(p: NetPlayer): PlayerView {
    let v = this.players.get(p.id);
    if (v) return v;
    const h = humanoid(p.c);
    const tag = makeTag(p.n, p.c);
    tag.position.y = 2.1;
    h.root.add(tag);
    h.root.traverse((c) => { c.userData.pick = { kind: 'player', id: p.id } satisfies Pickable; });
    this.group.add(h.root);
    this.pickables.push(h.body);
    v = { h, tag, held: null, heldId: '', last: new THREE.Vector3(p.x, p.y, p.z), speed: 0, phase: 0, light: false };
    this.players.set(p.id, v);
    return v;
  }

  update(dt: number, session: ClientSession, cam: THREE.Camera, localTorch: { on: boolean; pos: THREE.Vector3; radius: number }) {
    this.time += dt;
    this.fireSpots.length = 0;
    // structures with fire/light
    for (const s of Object.values(session.structures)) {
      const def = STRUCTURES[s.type];
      if (!def || !s.on) continue;
      if (def.fire) {
        vtx.set(s.x, s.y + (s.type === 'campfire' ? 0.25 : s.type === 'kiln' ? 0.5 : 1.05), s.z);
        if (s.type === 'campfire') this.particles.fire(vtx.clone(), 1.2);
        else if (Math.random() < 0.3) this.particles.fire(vtx.clone(), 0.4);
        this.fireSpots.push({ pos: vtx.clone().setY(vtx.y + 0.4), strength: 1, color: 0xff8a3a, kind: 'fire' });
      } else if (def.light) {
        const lantern = s.type === 'lantern_post';
        const h = lantern ? new THREE.Vector3(0.5, 1.9, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), s.yaw).add(new THREE.Vector3(s.x, s.y, s.z)) : new THREE.Vector3(s.x, s.y + 1.75, s.z);
        if (!lantern) this.particles.fire(h.clone(), 0.5);
        this.fireSpots.push({ pos: h, strength: lantern ? 1.1 : 0.8, color: lantern ? 0xffd28a : 0xff9a40, kind: lantern ? 'lamp' : 'torch' });
      } else if (def.beacon) {
        const blink = Math.sin(this.time * 4) > 0.2 ? 1 : 0;
        if (blink) this.fireSpots.push({ pos: new THREE.Vector3(s.x, s.y + 6.8, s.z), strength: 1.4, color: 0xff3b2f, kind: 'beacon' });
      }
    }
    // remote players
    const seen = new Set<string>();
    for (const p of session.remotePlayers()) {
      seen.add(p.id);
      const v = this.playerView(p);
      const r = v.h.root;
      r.visible = !(p.f & FLAG.dead);
      r.position.set(p.x, p.y, p.z);
      r.rotation.y = p.yaw;
      const moved = vtx.set(p.x, p.y, p.z).distanceTo(v.last);
      v.last.set(p.x, p.y, p.z);
      v.speed = v.speed * 0.85 + (dt > 0 ? moved / dt : 0) * 0.15;
      this.animatePlayer(v, p, dt);
      // held item
      if (v.heldId !== p.it) {
        if (v.held) v.h.hand.remove(v.held);
        v.held = null;
        v.heldId = p.it;
        if (p.it) { v.held = new THREE.Mesh(this.geoForItem(p.it), this.propMat); v.held.rotation.x = Math.PI / 2; v.h.hand.add(v.held); }
      }
      const torch = p.it === 'torch' || p.it === 'lantern';
      if (torch && r.visible) {
        v.h.hand.getWorldPosition(vtx);
        vtx.y += 0.5;
        if (p.it === 'torch' && !(p.f & FLAG.underwater)) this.particles.fire(vtx.clone(), 0.4);
        this.fireSpots.push({ pos: vtx.clone(), strength: 0.9, color: p.it === 'torch' ? 0xff9a40 : 0xffd28a, kind: 'torch' });
      }
      if ((p.f & FLAG.underwater) && Math.random() < dt * 2) this.particles.bubbles(v.h.head.getWorldPosition(vtx), 2);
    }
    for (const [id, v] of this.players) if (!seen.has(id)) { this.removeObj(v.h.root); this.players.delete(id); }

    // creatures
    const cs = new Set<string>();
    for (const c of session.creatures()) {
      cs.add(c.id);
      let e = this.creatures.get(c.id);
      if (!e) {
        let g = this.creatureGeo.get(c.k);
        if (!g) { g = creatureModel(c.k); this.creatureGeo.set(c.k, g); }
        const mesh = new THREE.Mesh(g, this.propMat);
        mesh.castShadow = true;
        mesh.userData.pick = { kind: 'creature', id: c.id } satisfies Pickable;
        e = { mesh, phase: Math.random() * 10 };
        this.creatures.set(c.id, e);
        this.group.add(mesh);
        this.pickables.push(mesh);
      }
      const m = e.mesh;
      e.phase += dt * (2 + c.sp * 3);
      m.position.set(c.x, c.y, c.z);
      m.rotation.set(0, c.yaw, 0);
      if (c.m === 'dead') {
        m.rotation.z = Math.PI / 2 * (c.k === 'fish' || c.k === 'shark' || c.k === 'ray' ? 1 : 0.9);
        if (c.k !== 'ray') m.position.y += 0.2;
        continue;
      }
      switch (c.k) {
        case 'crab': m.position.y += Math.abs(Math.sin(e.phase * 3)) * 0.03 * Math.min(1, c.sp); m.rotation.y += Math.PI / 2; break;
        case 'boar': m.position.y += Math.abs(Math.sin(e.phase * 2)) * 0.06 * Math.min(1, c.sp / 2); m.rotation.x = Math.sin(e.phase * 2) * 0.04; break;
        case 'snake': m.rotation.y += Math.sin(e.phase) * 0.25; break;
        case 'fish': m.rotation.y += Math.sin(e.phase * 4) * 0.25; break;
        case 'shark': m.rotation.y += Math.sin(e.phase * 1.2) * 0.12; m.rotation.z = Math.sin(e.phase * 0.6) * 0.08; break;
        case 'ray': m.rotation.z = Math.sin(e.phase * 1.5) * 0.15; break;
        case 'gull': m.position.y += Math.sin(e.phase) * 0.3; m.rotation.z = Math.sin(e.phase * 0.5) * 0.3; break;
      }
    }
    for (const [id, e] of this.creatures) if (!cs.has(id)) { this.removeObj(e.mesh); this.creatures.delete(id); }

    // vehicles
    const vs = new Set<string>();
    for (const v of session.vehicles()) {
      vs.add(v.id);
      let e = this.vehicles.get(v.id);
      if (!e) {
        const model = vehicleModel(v.k);
        const g = new THREE.Group();
        const hull = new THREE.Mesh(model.hull, this.mats.wood);
        hull.castShadow = true; hull.receiveShadow = true;
        hull.userData.pick = { kind: 'vehicle', id: v.id } satisfies Pickable;
        g.add(hull);
        this.pickables.push(hull);
        let sail: THREE.Mesh | undefined;
        if (model.sail) {
          sail = new THREE.Mesh(model.sail, this.mats.cloth);
          sail.castShadow = true;
          sail.userData.pick = { kind: 'vehicle', id: v.id };
          g.add(sail);
          this.pickables.push(sail);
        }
        this.group.add(g);
        e = { group: g, sail };
        this.vehicles.set(v.id, e);
      }
      e.group.position.set(v.x, v.y, v.z);
      e.group.rotation.set(v.p, v.yaw, v.r, 'YXZ');
      if (e.sail) {
        e.sail.visible = v.sl;
        e.sail.scale.x = 1 + Math.sin(this.time * 2) * 0.03;
      }
      if (Math.hypot(v.vx, v.vz) > 1.2 && Math.random() < dt * 8) {
        const back = new THREE.Vector3(0, 0, 2.5).applyAxisAngle(new THREE.Vector3(0, 1, 0), v.yaw).add(new THREE.Vector3(v.x, v.y, v.z));
        this.particles.splash(back, 0.4);
      }
    }
    for (const [id, e] of this.vehicles) if (!vs.has(id)) { this.removeObj(e.group); this.vehicles.delete(id); }

    // projectiles
    const ps = new Set<string>();
    for (const pr of session.projectiles) {
      ps.add(pr.id);
      let m = this.projectiles.get(pr.id);
      if (!m) {
        m = new THREE.Mesh(this.geoForItem('arrow'), this.propMat);
        this.projectiles.set(pr.id, m);
        this.group.add(m);
      }
      m.position.set(pr.x, pr.y, pr.z);
      vtx.set(pr.x + pr.vx, pr.y + pr.vy, pr.z + pr.vz);
      m.lookAt(vtx);
      m.rotateX(Math.PI / 2);
    }
    for (const [id, m] of this.projectiles) if (!ps.has(id)) { this.group.remove(m); this.projectiles.delete(id); }

    // items bob / settle
    for (const m of this.items.values()) {
      const t = m.userData.target as THREE.Vector3;
      m.position.lerp(t, Math.min(1, dt * 8));
      if (m.userData.floating) { m.position.y = t.y + Math.sin(this.time * 1.5 + m.id) * 0.06; m.rotation.y += dt * 0.2; }
    }

    // assign point lights to nearest light sources
    if (localTorch.on) this.fireSpots.push({ pos: localTorch.pos, strength: 1, color: 0xffa050, kind: 'torch' });
    const camPos = (cam as THREE.PerspectiveCamera).position;
    this.fireSpots.sort((a, b) => a.pos.distanceToSquared(camPos) - b.pos.distanceToSquared(camPos));
    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i]!;
      const f = i < this.lightBudget ? this.fireSpots[i] : undefined;
      if (!f) { l.intensity = 0; l.visible = false; continue; }
      l.visible = true;
      l.position.copy(f.pos);
      l.color.setHex(f.color);
      const flicker = f.kind === 'fire' || f.kind === 'torch' ? 0.85 + Math.sin(this.time * 17 + i) * 0.08 + Math.sin(this.time * 7.3 + i * 2) * 0.07 : 1;
      l.intensity = (f.kind === 'beacon' ? 30 : f.kind === 'lamp' ? 22 : 18) * f.strength * flicker;
      l.distance = f.kind === 'fire' ? 16 : f.kind === 'beacon' ? 30 : 13;
    }
  }

  private animatePlayer(v: PlayerView, p: NetPlayer, dt: number) {
    const h = v.h;
    const swim = !!(p.f & FLAG.swim), crouch = !!(p.f & FLAG.crouch), downed = !!(p.f & FLAG.downed), sleeping = !!(p.f & FLAG.sleeping), seated = !!p.v;
    const sp = Math.min(v.speed, 7);
    v.phase += dt * (2 + sp * 1.6);
    const s = Math.sin(v.phase), c = Math.cos(v.phase);
    h.root.rotation.x = 0; h.root.rotation.z = 0;
    h.body.position.y = 1.15; h.head.position.y = 1.62;
    if (downed || sleeping) {
      h.root.rotation.z = Math.PI / 2;
      h.root.position.y += 0.25;
      h.armL.rotation.x = h.armR.rotation.x = h.legL.rotation.x = h.legR.rotation.x = 0;
      return;
    }
    if (swim) {
      h.root.rotation.x = Math.PI / 2.6;
      h.root.position.y += 0.6;
      h.armL.rotation.x = -Math.PI / 2 + s * 0.9; h.armR.rotation.x = -Math.PI / 2 - s * 0.9;
      h.legL.rotation.x = c * 0.4; h.legR.rotation.x = -c * 0.4;
      return;
    }
    if (seated) {
      h.legL.rotation.x = h.legR.rotation.x = -Math.PI / 2;
      h.root.position.y -= 0.45;
      h.armL.rotation.x = h.armR.rotation.x = -0.6 + s * 0.4;
      return;
    }
    const amp = Math.min(1, sp / 3) * 0.8;
    h.legL.rotation.x = s * amp; h.legR.rotation.x = -s * amp;
    h.armL.rotation.x = -s * amp * 0.8;
    h.armR.rotation.x = p.f & FLAG.using ? -1.6 + Math.sin(this.time * 18) * 0.6 : s * amp * 0.8 - (p.it ? 0.5 : 0);
    if (crouch) { h.root.position.y -= 0.35; h.legL.rotation.x -= 0.6; h.legR.rotation.x -= 0.6; }
    h.head.rotation.x = -p.pitch * 0.6;
  }

  /** Root object of a structure (for build-mode highlighting). */
  structureObject(id: string): THREE.Object3D | undefined { return this.structures.get(id)?.obj; }
}

function makeTag(name: string, color: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.font = '600 30px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  const w = Math.min(250, ctx.measureText(name).width + 28);
  ctx.beginPath();
  ctx.roundRect(128 - w / 2, 10, w, 44, 12);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.fillRect(128 - w / 2 + 8, 26, 8, 12);
  ctx.fillStyle = '#fff';
  ctx.fillText(name, 136, 43);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true, transparent: true }));
  s.scale.set(1.6, 0.4, 1);
  return s;
}
