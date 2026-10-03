/**
 * Game: the in-world client controller. Glues the network session, renderer,
 * HUD/panels, audio and input together and implements all player-facing
 * interaction (targeting, tools, building, vehicles, fishing, UI flow).
 * It never mutates authoritative state — every change is an intent to the server.
 */
import * as THREE from 'three';
import { ClientSession, type InputSample, type Identity } from '../net/session';
import type { Transport } from '../net/transport';
import type { WorldRenderer } from '../render/renderer';
import type { AudioEngine } from '../audio/audio';
import type { Input } from '../input/input';
import { keyLabel } from '../input/input';
import type { Settings } from '../settings';
import { Hud } from '../ui/hud';
import { InventoryScreen } from '../ui/inventory';
import { BuildMenu, MapPanel, Journal } from '../ui/panels';
import { h, clear } from '../ui/dom';
import { NODES } from '../../shared/defs/nodes';
import { ITEMS } from '../../shared/defs/items';
import { STRUCTURES } from '../../shared/defs/structures';
import { CREATURES } from '../../shared/defs/creatures';
import { VEHICLES } from '../../shared/defs/vehicles';
import { PLAYER, BUILD } from '../../shared/config';
import { computePlacement } from '../../shared/systems/building';
import { hourOf, dayNumber, daylight } from '../../shared/systems/weather';
import { countItem } from '../../shared/systems/inventory';
import { raySphere } from '../../shared/math/vec';
import type { Action, FxEvent } from '../../shared/net/protocol';
import { FLAG } from '../../shared/net/protocol';
import type { CreatureKind } from '../../shared/defs/types';
import type { Pickable } from '../render/entities';

type Target =
  | { kind: 'node'; id: string; type: string; dist: number; pos: THREE.Vector3 }
  | { kind: 'item'; id: string; dist: number; pos: THREE.Vector3 }
  | { kind: 'container'; id: string; dist: number; pos: THREE.Vector3 }
  | { kind: 'structure'; id: string; dist: number; pos: THREE.Vector3 }
  | { kind: 'creature'; id: string; dist: number; pos: THREE.Vector3 }
  | { kind: 'vehicle'; id: string; dist: number; pos: THREE.Vector3 }
  | { kind: 'player'; id: string; dist: number; pos: THREE.Vector3 }
  | { kind: 'water'; dist: number; pos: THREE.Vector3 };

export interface GameHooks {
  onQuit: (reason?: string) => void;
  onDisconnect: (reason: string) => void;
  onPause: (paused: boolean) => void;
  requestSave: () => Promise<boolean>;
  inviteAddress: string | null;
}

const tmpV = new THREE.Vector3();
const ray = new THREE.Raycaster();

export class Game {
  session: ClientSession;
  hud: Hud;
  inv: InventoryScreen;
  build: BuildMenu;
  map: MapPanel;
  journal: Journal;
  private overlay = h('div', { class: 'overlay hidden' });
  yaw = 0;
  pitch = 0;
  private crouchToggle = false;
  private sprintToggle = false;
  private target: Target | null = null;
  private blueprint: string | null = null;
  private bpRot = 0;
  private placement: { x: number; y: number; z: number; yaw: number; valid: boolean; reason?: string } | null = null;
  private lastSwing = 0;
  private bowDraw = 0;
  private zoom = 1;
  private damageFlash = 0;
  private lastHealth = 100;
  private lastCounts = new Map<string, number>();
  private lastMilestones = 0;
  private stepDist = 0;
  private lastPos = new THREE.Vector3();
  private headBobT = 0;
  private sleepFade = 0;
  private showNet = false;
  private ready = false;
  private loadingProgress = 0;
  private time = 0;
  private uiRoot: HTMLElement;
  private paused = false;
  private lastSwimSound = 0;
  private heartbeatAt = 0;
  private disposed = false;
  private hintShown = new Set<string>();

  constructor(private renderer: WorldRenderer, private audio: AudioEngine, private input: Input, private settings: Settings, ui: HTMLElement, transport: Transport, identity: Identity, private hooks: GameHooks) {
    this.uiRoot = h('div', { class: 'passthru', style: 'position:absolute;inset:0' });
    ui.append(this.uiRoot);
    this.session = new ClientSession(transport, identity, {
      welcome: () => this.onWelcome(),
      delta: () => this.onDelta(),
      notify: (t, l) => { this.hud.notify(t, l); this.audio.play('notify', { gain: 0.5 }, undefined, 'ui'); },
      chat: (n, t) => { this.hud.chatLine(n, t); this.audio.play('ui_click', {}, undefined, 'ui'); },
      fx: (list) => this.onFx(list),
      disconnect: (r) => { if (!this.disposed) this.hooks.onDisconnect(r); },
      reject: (r) => { if (!this.disposed) this.hooks.onDisconnect(r); },
      saved: (ok) => this.hud.notify(ok ? 'Game saved.' : 'Save failed!', ok ? 'good' : 'bad'),
    });
    this.hud = new Hud(this.uiRoot, settings);
    this.hud.onChat = (t) => void this.act({ a: 'chat', text: t });
    const ctx = { session: this.session, act: (a: Action) => this.act(a), sound: (id: string) => this.audio.play(id, {}, undefined, 'ui') };
    this.inv = new InventoryScreen(this.uiRoot, ctx);
    this.build = new BuildMenu(this.uiRoot, () => this.session, (id) => this.selectBlueprint(id), ctx.sound);
    this.map = new MapPanel(this.uiRoot, () => this.session, (x, z) => void this.act({ a: 'waypoint_add', x, z, label: `Mark ${this.session.waypoints.length + 1}` }), (id) => void this.act({ a: 'waypoint_remove', id }));
    this.journal = new Journal(this.uiRoot, () => this.session);
    this.uiRoot.append(this.overlay);
    document.documentElement.style.setProperty('--hud-scale', String(settings.gameplay.hudScale));
  }

  get isReady() { return this.ready; }
  get progress() { return this.loadingProgress; }

  /** Start the handshake for transports that are already open (local worker). */
  hello() { this.session.hello(); }

  dispose() {
    this.disposed = true;
    this.session.close();
    this.renderer.disposeWorld();
    this.renderer.setGhost(null);
    this.renderer.setHighlight(null);
    this.uiRoot.remove();
  }

  act(a: Action) {
    return this.session.act(a).then((r) => {
      if (!r.ok && r.reason && !['Too soon', 'Malformed'].includes(r.reason)) { this.hud.notify(r.reason, 'warn'); this.audio.play('ui_error', { gain: 0.6 }, undefined, 'ui'); }
      return r;
    });
  }

  private onWelcome() {
    this.renderer.initWorld(this.session);
    const sp = this.session.self;
    if (sp) this.lastPos.set(sp.x, sp.y, sp.z);
    this.hud.show(false);
  }

  private onDelta() {
    const me = this.session.me;
    if (!me) return;
    // pickup notifications from inventory count changes
    const counts = new Map<string, number>();
    for (const s of [...me.inventory.slots, ...Object.values(me.inventory.equip)]) if (s) counts.set(s.id, (counts.get(s.id) ?? 0) + s.qty);
    if (this.lastCounts.size || this.ready) {
      for (const [id, n] of counts) {
        const d = n - (this.lastCounts.get(id) ?? 0);
        if (d > 0 && this.ready) this.hud.pickup(id, d);
      }
    }
    this.lastCounts = counts;
    if (me.milestones.length > this.lastMilestones && this.ready) this.audio.play('milestone', { gain: 0.6 }, undefined, 'ui');
    this.lastMilestones = me.milestones.length;
    this.inv.update();
    if (this.build.visible) this.build.open();
    this.renderer.vegetation?.markDirty();
  }

  // ------------------------------------------------------------------ fx
  private onFx(list: FxEvent[]) {
    const me = this.session.playerId;
    const part = this.renderer.particles;
    for (const f of list) {
      const pos = { x: f.x, y: f.y, z: f.z };
      const mine = f.p === me;
      switch (f.k) {
        case 'swing': if (!mine) this.audio.play('swing', { gain: 0.5 }, pos); break;
        case 'node_hit': case 'node_break': {
          const def = f.a ? NODES[f.a] : undefined;
          const wood = def?.action === 'chop', rock = def?.action === 'mine' || def?.action === 'dig';
          const col = wood ? '#a57a4a' : rock ? (f.a === 'coral' ? '#f0806a' : f.a === 'clay_bank' ? '#a35f3e' : '#8d8a82') : '#6f9e45';
          part.chips(pos, col, f.k === 'node_break' ? 22 : 8);
          if (f.k === 'node_break') this.audio.play(wood ? 'fell' : rock ? 'break_rock' : 'gather', {}, pos);
          else this.audio.play(wood ? 'chop' : rock ? 'mine' : 'gather', { pitch: 0.9 + Math.random() * 0.2 }, pos);
          if (f.y < this.session.waterLevel(f.x, f.z)) part.bubbles(pos, 8);
          break;
        }
        case 'pickup': if (mine) this.audio.play('pickup', { gain: 0.6 }, undefined, 'ui'); break;
        case 'hurt':
          if (mine) { this.damageFlash = Math.min(1, this.damageFlash + 0.35 + (f.b ?? 0) / 40); this.audio.play('hurt', {}, undefined); }
          else { this.audio.play('hit', {}, pos); part.blood(pos, f.y < this.session.waterLevel(f.x, f.z)); }
          break;
        case 'creature_hit': this.audio.play('hit', {}, pos); part.blood(pos, f.y < this.session.waterLevel(f.x, f.z)); break;
        case 'creature_attack': this.audio.play(`creature_${f.a}`, { gain: 0.9 }, pos); break;
        case 'creature_die': this.audio.play('creature_die', {}, pos); part.blood(pos, f.y < 0); break;
        case 'butcher': this.audio.play('chop', { pitch: 1.3 }, pos); part.blood(pos, f.y < 0); break;
        case 'craft_start': if (mine) this.audio.play('craft', { gain: 0.6 }, undefined, 'ui'); break;
        case 'craft_done': if (mine) this.audio.play('pickup', {}, undefined, 'ui'); break;
        case 'build': case 'upgrade': case 'repair': this.audio.play('build', {}, pos); part.dust(pos); break;
        case 'structure_hit': this.audio.play('chop', { pitch: 0.7 }, pos); part.chips(pos, '#8a6440', 8); break;
        case 'demolish': case 'collapse': this.audio.play('demolish', {}, pos); part.dust(pos); part.chips(pos, '#8a6440', 16); break;
        case 'ignite': this.audio.play('ignite', {}, pos); part.sparkle(pos, '#ffb347'); break;
        case 'spark': part.sparkle(pos, '#ffcf6b'); this.audio.play('gather', { gain: 0.4 }, pos); break;
        case 'fire_out': this.audio.play('fire_out', {}, pos); part.emit(pos, { count: 12, spread: 0.3, speed: 0.2, up: 0.8, life: [1.5, 3], size: [0.4, 0.8], grow: 1, color: '#777', alpha: 0.4 }); break;
        case 'cooked': case 'dried': this.audio.play('pickup', { gain: 0.4, pitch: 0.8 }, pos); break;
        case 'burnt': part.emit(pos, { count: 10, spread: 0.2, speed: 0.2, up: 0.9, life: [1.5, 3], size: [0.4, 0.8], grow: 1, color: '#333', alpha: 0.5 }); break;
        case 'eat': if (mine) { this.audio.play('eat', {}); this.renderer.viewmodel.triggerEat(); } break;
        case 'drink': if (mine) { this.audio.play('drink', {}); this.renderer.viewmodel.triggerEat(); } break;
        case 'heal': part.sparkle(pos, '#8dff9a'); break;
        case 'fill': case 'water': part.splash(pos, 0.3); this.audio.play('splash', { gain: 0.3 }, pos); break;
        case 'door': this.audio.play('door', {}, pos); break;
        case 'cast': part.splash(pos, 0.3); this.audio.play('cast', {}, pos); break;
        case 'bite': part.splash(pos, 0.5); if (mine) this.audio.play('bite', { gain: 1.2 }); break;
        case 'catch': part.splash(pos, 0.8); this.audio.play('catch', {}, pos); break;
        case 'bow_shot': this.audio.play('bow', {}, pos); break;
        case 'arrow_hit': this.audio.play('hit', { gain: 0.4, pitch: 1.5 }, pos); break;
        case 'lightning': setTimeout(() => this.audio.play('thunder', { gain: 1 }), 400 + Math.random() * 2500); break;
        case 'death': this.audio.play('death', {}, mine ? undefined : pos); break;
        case 'downed': this.audio.play('hurt', { pitch: 0.7 }, pos); break;
        case 'revive': case 'respawn': this.audio.play('milestone', { gain: 0.5 }, pos); part.sparkle(pos, '#ffffff'); break;
        case 'land_hard': this.audio.play('hit', { pitch: 0.6 }, pos); part.dust(pos); break;
        case 'open': this.audio.play('ui_open', { gain: 0.5 }, pos); break;
        case 'vehicle_hit': case 'shark_bump': this.audio.play('vehicle_hit', {}, pos); part.splash(pos, 1); break;
        case 'vehicle_sink': this.audio.play('demolish', {}, pos); part.splash(pos, 2); break;
        case 'anchor': case 'sail': this.audio.play('door', { pitch: 1.3 }, pos); break;
        case 'rescue': this.audio.play('milestone', { gain: 1 }); this.hud.setCenter('A ship answers your signal! You are rescued!'); setTimeout(() => this.hud.setCenter(''), 9000); break;
        case 'plant': case 'harvest_crop': this.audio.play('gather', {}, pos); part.dust(pos); break;
        case 'equip': if (mine) this.audio.play('pickup', { pitch: 0.8 }, undefined, 'ui'); break;
      }
    }
  }

  // ------------------------------------------------------------------ main update
  update(dt: number) {
    const s = this.session;
    this.time += dt;
    if (!s.connected || !s.self || !this.renderer.terrain) {
      this.loadingProgress = s.connected ? 0.5 : 0.2;
      return;
    }
    if (!this.ready) {
      // wait for nearby terrain before revealing the world
      const p = s.viewPosition();
      tmpV.set(p.x, p.y, p.z);
      this.renderer.terrain.update(tmpV, 30);
      this.renderer.terrain.finishHeightTex(tmpV);
      const backlog = this.renderer.terrain.backlog;
      this.loadingProgress = 0.6 + 0.4 * (1 - Math.min(1, backlog / 60));
      if (backlog > 0) return;
      this.ready = true;
      this.hud.show(true);
      this.lastHealth = s.self.health;
      this.input.requestLock();
      if (this.settings.gameplay.showTutorial) this.hud.notify(`Welcome to ${s.worldName}. Press ${keyLabel(this.settings.controls.binds.journal?.[0] ?? 'KeyJ')} for your journal, ${keyLabel(this.settings.controls.binds.crafting?.[0] ?? 'KeyQ')} to craft.`, 'info');
    }
    const input = this.input;
    input.pollGamepad();
    const ui = this.uiOpen;
    input.uiCapture = ui || this.hud.chatOpen;

    this.handleMenus();
    if (this.disposed) return;

    // ---------------- look
    const sens = this.settings.controls.sensitivity * 0.0022 / this.zoom;
    if (!ui && !this.hud.chatOpen && (input.locked || input.usingGamepad)) {
      this.yaw -= input.mouseDX * sens;
      this.pitch -= input.mouseDY * sens * (this.settings.controls.invertY ? -1 : 1);
      const gs = this.settings.controls.gamepadSensitivity * 2.6 * dt / this.zoom;
      this.yaw -= input.padLook.x * gs;
      this.pitch -= input.padLook.y * gs * (this.settings.controls.invertY ? -1 : 1);
      this.pitch = Math.max(-1.52, Math.min(1.52, this.pitch));
    }

    // ---------------- movement intent
    const self = s.self;
    const active = !ui && !this.hud.chatOpen && !self.dead && self.downed <= 0 && !self.sleeping;
    let mx = 0, mz = 0;
    if (active) {
      if (input.held('forward')) mz += 1;
      if (input.held('back')) mz -= 1;
      if (input.held('right')) mx += 1;
      if (input.held('left')) mx -= 1;
      mx += input.padMove.x; mz -= input.padMove.y;
      if (this.settings.controls.toggleCrouch && input.pressed('crouch')) this.crouchToggle = !this.crouchToggle;
      if (this.settings.controls.toggleSprint && input.pressed('sprint')) this.sprintToggle = !this.sprintToggle;
    }
    const crouch = active && (this.settings.controls.toggleCrouch ? this.crouchToggle : input.held('crouch'));
    const sprint = active && (this.settings.controls.toggleSprint ? this.sprintToggle && mz > 0 : input.held('sprint'));
    const sample: InputSample = { mx, mz, yaw: this.yaw, pitch: this.pitch, jump: active && input.held('jump'), sprint, crouch };
    s.update(dt, sample);
    if (!active || mz <= 0) this.sprintToggle = this.sprintToggle && mz > 0;

    // ---------------- camera
    const vp = s.viewPosition();
    const eye = self.vehicleId ? 1.15 : self.downed > 0 || self.sleeping ? 0.35 : s.pred.crouching ? PLAYER.crouchHeight - 0.08 : PLAYER.eyeHeight;
    const moveSpeed = Math.hypot(vp.x - this.lastPos.x, vp.z - this.lastPos.z) / Math.max(dt, 1e-3);
    if (this.settings.gameplay.headBob && s.pred.onGround && !s.pred.swimming && moveSpeed > 0.5) this.headBobT += dt * moveSpeed * 1.7;
    const bob = this.settings.gameplay.headBob ? Math.sin(this.headBobT) * 0.035 * Math.min(1, moveSpeed / 4) : 0;
    const camPos = tmpV.set(vp.x, vp.y + eye + bob, vp.z).clone();
    if (self.vehicleId) {
      const v = s.vehicleAt(self.vehicleId);
      if (v) camPos.y += Math.sin(v.r) * 0.3;
    }
    const water = s.waterLevel(camPos.x, camPos.z);
    const underwater = camPos.y < water - 0.02;

    // ---------------- targeting & actions
    this.updateTarget(camPos);
    if (active) this.handleActions(dt, camPos);
    else { this.renderer.setGhost(null); }
    this.setPrompt(); // after placement so prompt and ghost always agree

    // ---------------- audio
    this.updateAudio(dt, vp, camPos, underwater, moveSpeed);

    // ---------------- visual state
    this.damageFlash = Math.max(0, this.damageFlash - dt * 1.6);
    if (self.health < this.lastHealth - 0.5 && !self.dead) this.damageFlash = Math.min(1, this.damageFlash + 0.25);
    this.lastHealth = self.health;
    const lowHealth = self.health < 25 && !self.dead ? 1 - self.health / 25 : 0;
    if (lowHealth > 0 && this.time > this.heartbeatAt) { this.heartbeatAt = this.time + 1.1 - lowHealth * 0.4; this.audio.play('heartbeat', { gain: 0.6 * lowHealth }); }
    this.sleepFade += ((self.sleeping ? 0.85 : 0) - this.sleepFade) * Math.min(1, dt * 2);
    const held = s.hotbarItem;
    const heldDef = held ? ITEMS[held.id] : undefined;
    this.renderer.viewmodel.setItem(held?.id ?? null);
    this.renderer.viewmodel.setHidden(!!self.vehicleId && self.seat === 0 || self.dead || self.downed > 0 || self.sleeping);
    this.renderer.viewmodel.update(dt, moveSpeed, input.mouseDX, input.mouseDY, s.pred.swimming, this.settings.gameplay.headBob);
    this.renderer.viewmodel.setDraw(this.bowDraw);
    const time = s.serverTime();
    const hour = hourOf({ time, dayOffset: s.dayOffset });
    this.renderer.render(s, {
      dt, time, camPos, yaw: this.yaw, pitch: this.pitch, underwater,
      damageFlash: this.damageFlash, lowHealth, cold: Math.max(0, Math.min(1, (36.4 - self.bodyTemp) / 1.5)), sleep: this.sleepFade,
      fov: this.settings.graphics.fov, zoom: this.zoom,
      torch: !!heldDef?.lightRadius && !(held?.id === 'torch' && underwater),
    });
    this.lastPos.set(vp.x, vp.y, vp.z);

    // ---------------- HUD
    if (input.keyPressed('F3')) this.showNet = !this.showNet;
    const hasCompass = !!s.me && (countItem(s.me.inventory.slots, 'compass') > 0 || countItem(s.me.inventory.slots, 'chart') > 0);
    const r = this.renderer.stats;
    this.hud.update(s, {
      yaw: this.yaw, hour, day: dayNumber({ time, dayOffset: s.dayOffset }), temp: self.envTemp, fps: r.fps,
      showNet: this.showNet,
      netText: `FPS ${r.fps}  frame ${r.frameMs.toFixed(1)} ms  ${r.renderW}x${r.renderH}\nRTT ${s.rtt.toFixed(0)} ms  snaps ${s.snapshotsReceived}  corrections ${s.reconciliations} (max ${s.maxCorrection.toFixed(2)} m)\ndraws ${r.drawCalls}  tris ${(r.triangles / 1000).toFixed(0)}k  veg ${this.renderer.vegetation?.instanceCount ?? 0}\npos ${vp.x.toFixed(1)} ${vp.y.toFixed(1)} ${vp.z.toFixed(1)}  weather ${s.weather.kind}`,
      coords: { x: vp.x, z: vp.z }, hasCompass, weather: s.weather.blend > 0.5 ? s.weather.next : s.weather.kind,
    });
    this.updateMarkers(camPos);
    this.updateOverlay();
    if (s.gen) this.map.bake(s.gen, this.map.visible ? 6 : 1.5);
    if (this.map.visible) this.map.draw();
    this.inv.update();
    this.contextHints();
  }

  get uiOpen(): boolean { return this.inv.visible || this.build.visible || this.map.visible || this.journal.visible || this.paused; }

  private closePanels() {
    this.inv.close(); this.build.close(); this.map.close(); this.journal.close();
  }

  private handleMenus() {
    const i = this.input;
    if (this.hud.chatOpen) return;
    if (i.pressed('pause')) {
      if (this.blueprint) { this.cancelBlueprint(); return; }
      if (this.inv.visible || this.build.visible || this.map.visible || this.journal.visible) { this.closePanels(); this.input.requestLock(); return; }
      this.setPaused(!this.paused);
      return;
    }
    if (this.paused) return;
    const toggle = (panel: { visible: boolean; close(): void }, open: () => void) => {
      if (panel.visible) { panel.close(); this.input.requestLock(); }
      else { this.closePanels(); open(); this.input.releaseLock(); }
    };
    // each toggle is independent so several keys in one frame are all honoured
    if (i.pressed('inventory')) toggle(this.inv, () => this.inv.open());
    if (i.pressed('crafting')) toggle(this.inv, () => this.inv.open({ craftOnly: true }));
    if (i.pressed('map')) toggle(this.map, () => this.map.open());
    if (i.pressed('journal')) toggle(this.journal, () => this.journal.open());
    if (i.pressed('build')) {
      if (!this.holdingHammer()) this.hud.notify('Hold a Builder\'s Mallet to build.', 'warn');
      else toggle(this.build, () => this.build.open());
    }
    if (i.pressed('chat') && !this.uiOpen) { this.hud.openChat(); this.input.releaseLock(); }
    if (i.keyPressed('KeyP') || i.padButtonPressed(8)) this.hud.togglePlayers(true, this.session);
    if (i.released('players')) this.hud.togglePlayers(false, this.session);
    // re-lock pointer when clicking back into the world
    if (!this.uiOpen && !this.input.locked && i.keyPressed('Mouse0') && !this.session.self?.dead) this.input.requestLock();
  }

  setPaused(p: boolean) {
    this.paused = p;
    if (p) { this.closePanels(); this.input.releaseLock(); } else this.input.requestLock();
    this.hooks.onPause(p);
  }

  // ------------------------------------------------------------------ targeting
  private holdingHammer() { const h = this.session.hotbarItem; return !!h && !!ITEMS[h.id]?.tool?.actions.includes('build'); }

  private updateTarget(cam: THREE.Vector3) {
    const s = this.session;
    const dir = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
    const reach = 4.2;
    let best: Target | null = null;
    // replicated entities via three.js raycast
    ray.set(cam, dir);
    ray.far = 8;
    const ents = this.renderer.entities;
    if (ents) {
      const hits = ray.intersectObjects(ents.pickables, false);
      for (const hit of hits) {
        const pk = hit.object.userData.pick as Pickable | undefined;
        if (!pk) continue;
        if (pk.kind === 'player' && pk.id === s.playerId) continue;
        const maxD = pk.kind === 'vehicle' ? 6 : pk.kind === 'structure' ? (this.holdingHammer() ? 8 : reach + 1) : reach;
        if (hit.distance > maxD) continue;
        best = { kind: pk.kind, id: pk.id, dist: hit.distance, pos: hit.point.clone() } as Target;
        break;
      }
    }
    // resource nodes (analytic)
    if (s.gen) {
      for (const n of s.gen.nodesInRadius(cam.x, cam.z, 7)) {
        if (s.isNodeDepleted(n.id)) continue;
        const def = NODES[n.type]!;
        const tall = def.height * n.scale > 2.5;
        let t = -1;
        if (tall) {
          // trunk: test several spheres along the trunk axis
          for (let yy = 0.6; yy < Math.min(def.height * n.scale, 4); yy += 0.7) {
            const tt = raySphere(cam.x, cam.y, cam.z, dir.x, dir.y, dir.z, n.x, n.y + yy, n.z, def.radius * n.scale + 0.25);
            if (tt >= 0 && (t < 0 || tt < t)) t = tt;
          }
        } else {
          const r = Math.max(0.45, Math.max(def.radius, def.height * 0.5) * n.scale);
          t = raySphere(cam.x, cam.y, cam.z, dir.x, dir.y, dir.z, n.x, n.y + Math.min(def.height * n.scale * 0.5, 1), n.z, r);
        }
        if (t >= 0 && t < reach && (!best || t < best.dist - 0.05)) best = { kind: 'node', id: n.id, type: n.type, dist: t, pos: new THREE.Vector3(n.x, n.y + 0.5, n.z) };
      }
    }
    // water surface (fishing / filling)
    if (!best && dir.y < -0.02) {
      const tw = (0 - cam.y) / dir.y;
      if (tw > 0 && tw < 22) {
        const p = cam.clone().addScaledVector(dir, tw);
        if (s.gen && s.gen.heightAt(p.x, p.z) < -0.2 && this.terrainHit(cam, dir, tw) === null) best = { kind: 'water', dist: tw, pos: p };
      }
    }
    this.target = best;
    const obj = best && best.kind === 'structure' ? ents?.structureObject(best.id) ?? null : null;
    this.renderer.setHighlight(this.holdingHammer() && !this.blueprint ? obj : null);
  }

  /** March the view ray against terrain/structures; returns hit distance or null. */
  private terrainHit(cam: THREE.Vector3, dir: THREE.Vector3, max: number): number | null {
    const col = this.session.col;
    if (!col) return null;
    for (let t = 0.3; t < max; t += 0.2) {
      const x = cam.x + dir.x * t, y = cam.y + dir.y * t, z = cam.z + dir.z * t;
      if (col.ground(x, z, y + 0.05).h >= y) return t;
    }
    return null;
  }

  private setPrompt() {
    const t = this.target;
    const s = this.session;
    const key = (a: string) => keyLabel(this.settings.controls.binds[a]?.[0] ?? '?');
    if (this.blueprint) {
      const def = STRUCTURES[this.blueprint]!;
      const p = this.placement;
      this.hud.setPrompt([{ key: keyLabel(this.settings.controls.binds.primary?.[0] ?? 'Mouse0'), text: `Place ${def.name}`, sub: p && !p.valid ? p.reason ?? 'Invalid placement' : `${key('rotate')} rotate · RMB cancel` }]);
      return;
    }
    if (!t) { this.hud.setPrompt(null); return; }
    const held = s.hotbarItem;
    const heldTool = held ? ITEMS[held.id]?.tool : undefined;
    switch (t.kind) {
      case 'node': {
        const def = NODES[t.type]!;
        const hp = s.nodes[t.id]?.hp;
        if (def.action === 'gather') this.hud.setPrompt([{ key: key('interact'), text: `Gather ${def.name}` }]);
        else {
          const tool = heldTool && (heldTool.actions.includes(def.action as never) || (def.action === 'dig' && heldTool.actions.includes('mine')));
          const need = def.action === 'chop' ? 'an axe' : def.action === 'mine' ? 'a pick' : 'a pick';
          this.hud.setPrompt([{ key: tool ? 'LMB' : undefined, text: def.name, sub: tool ? (heldTool!.tier < def.minTier ? 'tool too weak' : 'strike') : `needs ${need}`, hp: hp !== undefined ? hp / def.hp : undefined }]);
        }
        break;
      }
      case 'item': {
        const it = s.items[t.id];
        if (it) this.hud.setPrompt([{ key: key('interact'), text: `Pick up ${ITEMS[it.stack.id]?.name ?? it.stack.id}${it.stack.qty > 1 ? ` ×${it.stack.qty}` : ''}` }]);
        break;
      }
      case 'container': {
        const c = s.containers[t.id];
        this.hud.setPrompt([{ key: key('interact'), text: `Open ${c?.label ?? 'container'}` }]);
        break;
      }
      case 'structure': {
        const st = s.structures[t.id];
        if (!st) { this.hud.setPrompt(null); break; }
        const def = STRUCTURES[st.type]!;
        const lines: { key?: string; text: string; sub?: string; hp?: number }[] = [];
        if (def.door) lines.push({ key: key('interact'), text: st.on ? 'Close door' : 'Open door' });
        else if (def.fire) lines.push({ key: key('interact'), text: `${def.name}`, sub: st.on ? `burning · ${Math.ceil(st.fuel ?? 0)}s fuel` : 'unlit' });
        else if (def.bed) lines.push({ key: key('interact'), text: 'Rest / set respawn' });
        else if (def.container || def.rainCatcher || def.still || def.planter || def.beacon || def.dryingRack || def.light?.fuelSeconds) lines.push({ key: key('interact'), text: `Use ${def.name}`, sub: def.rainCatcher || def.still ? `${(st.water ?? 0).toFixed(1)} water` : undefined });
        else lines.push({ text: def.name });
        if (this.holdingHammer()) {
          lines.push({ key: key('waypoint'), text: 'Dismantle', hp: st.hp / def.maxHp });
          if (def.upgradesTo) lines.push({ key: key('use'), text: `Upgrade → ${STRUCTURES[def.upgradesTo]!.name}` });
          else if (st.hp < def.maxHp) lines.push({ key: key('use'), text: 'Repair' });
        }
        this.hud.setPrompt(lines);
        break;
      }
      case 'creature': {
        const c = s.creatures().find((x) => x.id === t.id);
        if (!c) { this.hud.setPrompt(null); break; }
        const def = CREATURES[c.k as CreatureKind];
        if (c.m === 'dead') this.hud.setPrompt([{ key: heldTool?.actions.includes('cut') ? key('interact') : undefined, text: `${def.name} carcass`, sub: heldTool?.actions.includes('cut') ? 'butcher' : 'needs a cutting tool' }]);
        else this.hud.setPrompt([{ text: def.name, hp: c.h / def.maxHp }]);
        break;
      }
      case 'vehicle': {
        const v = s.vehicleAt(t.id);
        if (!v) { this.hud.setPrompt(null); break; }
        const def = VEHICLES[v.k]!;
        const lines: { key?: string; text: string; sub?: string; hp?: number }[] = [{ key: key('interact'), text: `Board ${def.name}`, sub: `${v.seats.filter(Boolean).length}/${v.seats.length} aboard`, hp: v.h / def.maxHp }];
        if (this.holdingHammer() && v.h < def.maxHp) lines.push({ key: key('use'), text: 'Repair' });
        this.hud.setPrompt(lines);
        break;
      }
      case 'player': {
        const p = s.remotePlayers().find((x) => x.id === t.id);
        if (p && p.f & FLAG.downed) this.hud.setPrompt([{ key: key('interact'), text: `Revive ${p.n}` }]);
        else if (p) this.hud.setPrompt([{ text: p.n, hp: p.h / 100 }]);
        break;
      }
      case 'water': {
        const water = held && ITEMS[held.id]?.water;
        if (held?.id === 'fishing_rod') this.hud.setPrompt([{ key: 'LMB', text: s.self?.fishing ? 'Reel in' : 'Cast line' }]);
        else if (water) this.hud.setPrompt([{ key: key('interact'), text: `Fill ${ITEMS[held!.id]!.name} with sea water`, sub: 'salty — needs distilling' }]);
        else this.hud.setPrompt(null);
        break;
      }
    }
  }

  // ------------------------------------------------------------------ actions
  private handleActions(dt: number, cam: THREE.Vector3) {
    const i = this.input;
    const s = this.session;
    const self = s.self!;
    // hotbar selection
    for (let k = 0; k < 8; k++) if (i.keyPressed(`Digit${k + 1}`)) this.selectHotbar(k);
    if (i.wheel !== 0 && s.me && !this.blueprint) this.selectHotbar((s.me.hotbar + (i.wheel > 0 ? 1 : 7)) % 8);
    if (i.padButtonPressed(15) && s.me) this.selectHotbar((s.me.hotbar + 1) % 8);
    if (i.padButtonPressed(14) && s.me) this.selectHotbar((s.me.hotbar + 7) % 8);

    const held = s.hotbarItem;
    const def = held ? ITEMS[held.id] : undefined;

    // ---- vehicle controls
    if (self.vehicleId) {
      if (i.pressed('use')) void this.act({ a: 'anchor', id: self.vehicleId });
      if (i.pressed('rotate')) void this.act({ a: 'sail', id: self.vehicleId });
      if (i.pressed('interact')) {
        const v = s.vehicleAt(self.vehicleId);
        if (v) { void this.act({ a: 'interact', kind: 'vehicle', id: v.id, verb: 'cargo' }).then((r) => { if (r.ok) { this.inv.open(); this.input.releaseLock(); } }); }
      }
      if (self.seat === 0 && (i.held('forward') || i.held('back')) && this.time - this.lastSwimSound > 0.9) { this.lastSwimSound = this.time; this.audio.play('paddle', { gain: 0.6 }); }
      return;
    }

    // ---- build mode
    if (this.blueprint) {
      if (!this.holdingHammer() && STRUCTURES[this.blueprint]?.needsHammer !== false) { this.cancelBlueprint(); return; }
      if (i.pressed('rotate')) this.bpRot += STRUCTURES[this.blueprint]!.snap === 'free' || STRUCTURES[this.blueprint]!.snap === 'water' ? Math.PI / 8 : Math.PI / 2;
      this.updatePlacement(cam);
      if (i.pressed('secondary')) { this.cancelBlueprint(); return; }
      if (i.pressed('primary') && this.placement) {
        if (!this.placement.valid) { this.hud.notify(this.placement.reason ?? 'Cannot build here', 'warn'); this.audio.play('ui_error', {}, undefined, 'ui'); return; }
        const p = this.placement;
        const type = this.blueprint;
        void this.act({ a: 'build', structure: type, x: p.x, y: p.y, z: p.z, yaw: p.yaw }).then((r) => {
          if (r.ok) {
            this.renderer.viewmodel.triggerSwing();
            const me = s.me;
            const d = STRUCTURES[type]!;
            if (!me || !d.cost.every((c) => countItem(me.inventory.slots, c.item) >= c.qty * 2)) { if (d.category !== 'wall' && d.category !== 'foundation' && d.category !== 'floor' && d.category !== 'roof') this.cancelBlueprint(); }
          }
        });
      }
      return;
    }
    this.renderer.setGhost(null);

    const t = this.target;
    // ---- hammer actions on structures
    if (this.holdingHammer() && t && (t.kind === 'structure' || t.kind === 'vehicle')) {
      if (i.pressed('waypoint') && t.kind === 'structure') { void this.act({ a: 'demolish', id: t.id }); return; }
      if (i.pressed('use')) {
        if (t.kind === 'structure') {
          const st = s.structures[t.id];
          if (st && STRUCTURES[st.type]?.upgradesTo) void this.act({ a: 'upgrade', id: t.id });
          else void this.act({ a: 'repair', id: t.id });
        } else void this.act({ a: 'repair', id: t.id });
        this.renderer.viewmodel.triggerSwing();
        return;
      }
    }

    // ---- interact
    if (i.pressed('interact')) this.interact();

    // ---- use held item (eat/drink/heal) with F; LMB for consumables too
    const consumable = !!def && (!!def.food || !!def.medical || (!!def.water && def.id !== 'watering_can' && def.id !== 'clay_pot'));
    if (i.pressed('use') && held && consumable) void this.act({ a: 'consume', from: { c: 'inv', i: s.me!.hotbar } });

    // ---- drop
    if (i.pressed('drop') && held) void this.act({ a: 'drop', from: { c: 'inv', i: s.me!.hotbar }, qty: 1 });

    // ---- waypoint at aim point
    if (i.pressed('waypoint') && !this.holdingHammer()) {
      const p = t?.pos ?? cam;
      void this.act({ a: 'waypoint_add', x: p.x, z: p.z, label: `Mark ${s.waypoints.length + 1}` }).then((r) => { if (r.ok) this.hud.notify('Waypoint placed. Manage waypoints on the map.', 'info'); });
    }

    // ---- spyglass zoom
    const zoomWanted = held?.id === 'spyglass' && i.held('secondary') ? 4 : 1;
    this.zoom += (zoomWanted - this.zoom) * Math.min(1, dt * 10);

    // ---- primary
    if (held?.id === 'fishing_rod') {
      if (i.pressed('primary')) {
        if (self.fishing) void this.act({ a: 'fish_reel' });
        else if (t?.kind === 'water') { this.renderer.viewmodel.triggerSwing(0.5); void this.act({ a: 'fish_cast', x: t.pos.x, z: t.pos.z }); }
        else this.hud.notify('Aim at open water to cast.', 'info');
      }
      return;
    }
    if (def?.tool?.projectile) {
      if (i.held('primary')) this.bowDraw = Math.min(1, this.bowDraw + dt / 0.8);
      if (i.held('secondary')) { this.bowDraw = 0; }
      if (i.released('primary') && this.bowDraw > 0.1) {
        void this.act({ a: 'shoot', yaw: this.yaw, pitch: this.pitch, charge: this.bowDraw });
        this.bowDraw = 0;
      }
      this.zoom += ((this.bowDraw > 0.2 ? 1.25 : 1) - this.zoom) * Math.min(1, dt * 8);
      return;
    }
    this.bowDraw = 0;
    if (consumable && i.pressed('primary')) { void this.act({ a: 'consume', from: { c: 'inv', i: s.me!.hotbar } }); return; }
    if (def?.id === 'watering_can' && i.pressed('primary') && t?.kind === 'structure') { void this.act({ a: 'water_crop', id: t.id, from: { c: 'inv', i: s.me!.hotbar } }); return; }
    if (i.held('primary') && !this.holdingHammer()) {
      const cd = def?.tool?.cooldown ?? 0.6;
      if (this.time - this.lastSwing >= cd) {
        this.lastSwing = this.time;
        this.renderer.viewmodel.triggerSwing(Math.min(0.45, cd * 0.8));
        this.audio.play('swing', { gain: 0.5 });
        let target: { kind: 'node' | 'creature'; id: string } | undefined;
        if (t && (t.kind === 'node' || t.kind === 'creature')) target = { kind: t.kind, id: t.id };
        void this.session.act({ a: 'use', target, yaw: this.yaw, pitch: this.pitch }).then((r) => {
          if (!r.ok && r.reason && !['Too soon', 'Gone', 'Already harvested'].includes(r.reason)) this.hud.notify(r.reason, 'warn');
        });
      }
    }
  }

  private interact() {
    const s = this.session;
    const t = this.target;
    const held = s.hotbarItem;
    if (!t) {
      // sea water drinking when standing in water
      if (s.self?.sw) void this.act({ a: 'drink_source', source: 'sea' });
      return;
    }
    switch (t.kind) {
      case 'node': {
        const def = NODES[t.type]!;
        if (def.action === 'gather') void this.act({ a: 'gather', nodeId: t.id });
        else this.hud.notify(def.action === 'chop' ? 'Use an axe on this (left click).' : 'Use a pick on this (left click).', 'info');
        break;
      }
      case 'item': void this.act({ a: 'pickup', itemId: t.id }); break;
      case 'container': void this.act({ a: 'interact', kind: 'container', id: t.id }).then((r) => { if (r.ok) { this.inv.open(); this.input.releaseLock(); } }); break;
      case 'structure': {
        const st = s.structures[t.id];
        if (!st) return;
        const def = STRUCTURES[st.type]!;
        if (def.door || def.bed) { void this.act({ a: 'interact', kind: 'structure', id: t.id, verb: 'use' }); return; }
        if (def.container || def.fire || def.dryingRack) {
          void this.act({ a: 'interact', kind: 'structure', id: t.id, verb: 'open' }).then((r) => { if (r.ok) { this.inv.open({ station: t.id }); this.input.releaseLock(); } });
          return;
        }
        if (def.rainCatcher || def.still || def.planter || def.beacon || def.light?.fuelSeconds) { this.inv.open({ station: t.id }); this.input.releaseLock(); return; }
        break;
      }
      case 'vehicle': void this.act({ a: 'board', id: t.id }); break;
      case 'player': void this.act({ a: 'revive', id: t.id }); break;
      case 'creature': void this.act({ a: 'interact', kind: 'creature', id: t.id }); break;
      case 'water': {
        const def = held ? ITEMS[held.id] : undefined;
        if (def?.water) void this.act({ a: 'fill', from: { c: 'inv', i: s.me!.hotbar }, source: 'sea' });
        else void this.act({ a: 'drink_source', source: 'sea' });
        break;
      }
    }
  }

  private selectHotbar(k: number) {
    const s = this.session;
    if (!s.me || s.me.hotbar === k) return;
    s.me.hotbar = k; // optimistic (server confirms through delta)
    void this.act({ a: 'hotbar', index: k });
    this.audio.play('ui_click', { gain: 0.4 }, undefined, 'ui');
    if (this.blueprint && !this.holdingHammer()) this.cancelBlueprint();
  }

  private selectBlueprint(id: string) {
    this.blueprint = id;
    this.bpRot = this.yaw + Math.PI;
    this.build.close();
    this.input.requestLock();
  }

  private cancelBlueprint() {
    this.blueprint = null;
    this.placement = null;
    this.renderer.setGhost(null);
  }

  private updatePlacement(cam: THREE.Vector3) {
    const s = this.session;
    if (!s.gen || !s.col || !this.blueprint) return;
    const dir = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
    const max = BUILD.placeRange;
    let aim: THREE.Vector3;
    // structure surface hit
    ray.set(cam, dir); ray.far = max;
    const hits = this.renderer.entities ? ray.intersectObjects(this.renderer.entities.pickables, false) : [];
    const sh = hits.find((h0) => (h0.object.userData.pick as Pickable | undefined)?.kind === 'structure');
    const def = STRUCTURES[this.blueprint]!;
    const th = def.snap === 'water' ? null : this.terrainHit(cam, dir, max);
    if (def.snap === 'water') {
      const tw = dir.y < -0.01 ? Math.min(max * 1.5, -cam.y / dir.y) : max;
      aim = cam.clone().addScaledVector(dir, Math.max(2, tw));
    } else if (sh && (th === null || sh.distance < th)) aim = sh.point.clone();
    else if (th !== null) aim = cam.clone().addScaledVector(dir, th);
    else aim = cam.clone().addScaledVector(dir, max * 0.7);
    const ctx = { structures: s.structures, col: s.col, gen: s.gen, waterLevel: s.waterLevel };
    const p = computePlacement(ctx, this.blueprint, { x: aim.x, y: aim.y, z: aim.z }, this.bpRot);
    const me = s.me;
    if (p.valid && me && !def.cost.every((c) => countItem(me.inventory.slots, c.item) >= c.qty)) { p.valid = false; p.reason = 'Missing materials'; }
    if (p.valid && Math.hypot(p.x - cam.x, p.z - cam.z) > BUILD.placeRange + 1.5) { p.valid = false; p.reason = 'Too far away'; }
    this.placement = p;
    this.renderer.setGhost(this.blueprint, new THREE.Vector3(p.x, p.y, p.z), p.yaw, p.valid);
  }

  // ------------------------------------------------------------------ audio / overlay / markers
  private updateAudio(dt: number, vp: { x: number; y: number; z: number }, cam: THREE.Vector3, underwater: boolean, speed: number) {
    const s = this.session;
    const a = this.audio;
    a.setListener(cam.x, cam.y, cam.z, -Math.sin(this.yaw), -Math.cos(this.yaw));
    const gen = s.gen!;
    const nearest = gen.nearestIsland(vp.x, vp.z);
    const groundH = gen.heightAt(vp.x, vp.z);
    let shoreDist = Math.abs(groundH) * 6;
    if (groundH > 0) shoreDist = Math.max(0, groundH - 0.5) * 12;
    let nearFire = 0;
    for (const st of Object.values(s.structures)) {
      if (!st.on || !STRUCTURES[st.type]?.fire) continue;
      const d = Math.hypot(st.x - vp.x, st.z - vp.z);
      if (d < 14) nearFire = Math.max(nearFire, 1 - d / 14);
    }
    const hour = hourOf({ time: s.serverTime(), dayOffset: s.dayOffset });
    a.updateAmbience({
      shoreDist, altitude: vp.y, wind: s.weather.wind, rain: s.weather.rain, underwater, daylight: daylight(hour), nearFire,
      inJungle: gen.biomeAt(vp.x, vp.z, groundH) === 'jungle' && nearest.dist < 0, time: this.time,
    });
    // footsteps / swim strokes
    this.stepDist += speed * dt;
    if (s.pred.swimming) {
      if (this.stepDist > 2.2 && speed > 0.4) {
        this.stepDist = 0;
        a.play('swim', { gain: underwater ? 0.4 : 0.7 });
        if (underwater) this.renderer.particles.bubbles(cam.clone().add(new THREE.Vector3(0, -0.35, -0.9).applyEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'))), 2);
      }
    } else if (s.pred.onGround && speed > 0.6 && !s.self?.vehicleId) {
      const stride = s.pred.sprinting ? 2.4 : s.pred.crouching ? 1.2 : 1.8;
      if (this.stepDist > stride) {
        this.stepDist = 0;
        const g = s.col!.ground(vp.x, vp.z, vp.y + 0.3);
        const water = s.waterLevel(vp.x, vp.z) - vp.y;
        const surface = water > 0.1 ? 'water' : g.onStructure ? 'wood' : groundH < 2 ? 'sand' : gen.normalAt(vp.x, vp.z)[1] < 0.75 ? 'rock' : 'grass';
        a.footstep(surface, { x: vp.x, y: vp.y, z: vp.z });
        if (surface === 'water') this.renderer.particles.splash({ x: vp.x, y: vp.y + 0.1, z: vp.z }, 0.25);
      }
    }
    // water entry splash
    if (s.pred.swimming && !this.wasSwimming && this.ready) { a.play('splash', { gain: 0.8 }); this.renderer.particles.splash({ x: vp.x, y: s.waterLevel(vp.x, vp.z), z: vp.z }, 1); }
    if (!underwater && this.wasUnder && s.self && s.self.oxygen < 60) a.play('gasp', {});
    this.wasSwimming = s.pred.swimming;
    this.wasUnder = underwater;
  }
  private wasSwimming = false;
  private wasUnder = false;

  private updateMarkers(cam: THREE.Vector3) {
    const s = this.session;
    const camObj = this.renderer.camera;
    const items: { x: number; y: number; label: string; color: string; dist: number }[] = [];
    const W = window.innerWidth, H = window.innerHeight;
    const project = (x: number, y: number, z: number) => {
      const v = new THREE.Vector3(x, y, z).project(camObj);
      if (v.z > 1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05) return null;
      return { x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H };
    };
    for (const p of s.remotePlayers()) {
      const d = Math.hypot(p.x - cam.x, p.z - cam.z);
      if (d < 25 && !(p.f & FLAG.downed)) continue; // name tags handle close range
      const sp = project(p.x, p.y + 2.3, p.z);
      if (sp) items.push({ ...sp, label: p.f & FLAG.downed ? `${p.n} (DOWN)` : p.n, color: p.c, dist: d });
    }
    for (const w of s.waypoints) {
      const d = Math.hypot(w.x - cam.x, w.z - cam.z);
      if (d < 8) continue;
      const sp = project(w.x, Math.max(2, s.gen?.heightAt(w.x, w.z) ?? 0) + 3, w.z);
      if (sp) items.push({ ...sp, label: w.label, color: w.color, dist: d });
    }
    if (s.self?.dead === false) {
      for (const c of Object.values(s.containers)) {
        if (c.kind !== 'grave' || !c.label?.startsWith(s.roster.find((r) => r.id === s.playerId)?.name ?? '#')) continue;
        const d = Math.hypot(c.x - cam.x, c.z - cam.z);
        const sp = project(c.x, c.y + 1.5, c.z);
        if (sp && d > 3) items.push({ ...sp, label: 'Your belongings', color: '#ff6b6b', dist: d });
      }
    }
    this.hud.updateMarkers(items);
  }

  private overlaySig = '';
  private updateOverlay() {
    const self = this.session.self!;
    const sig = self.dead ? 'dead' : self.downed > 0 ? `down${Math.ceil(self.downed)}` : self.sleeping ? 'sleep' : '';
    if (sig === this.overlaySig) return;
    this.overlaySig = sig;
    clear(this.overlay);
    this.overlay.className = 'overlay hidden';
    if (self.dead) {
      this.input.releaseLock();
      this.closePanels();
      this.cancelBlueprint();
      const hasBed = !!this.session.me?.respawn;
      this.overlay.className = 'overlay death';
      this.overlay.append(h('h1', { text: 'You perished' }),
        h('p', { style: 'color:var(--muted)', text: this.session.settings?.keepInventoryOnDeath ? 'You keep your belongings.' : 'Your belongings lie where you fell. Find them before they wash away.' }),
        h('div', { style: 'display:flex;gap:10px' },
          h('button', { class: 'btn primary', text: hasBed ? 'Wake at your bed' : 'No bed set', disabled: !hasBed, on: { click: () => void this.act({ a: 'respawn', at: 'bed' }).then(() => this.input.requestLock()) } }),
          h('button', { class: 'btn', text: 'Wash ashore on the beach', on: { click: () => void this.act({ a: 'respawn', at: 'beach' }).then(() => this.input.requestLock()) } })));
    } else if (self.downed > 0) {
      this.overlay.className = 'overlay passthru';
      this.overlay.style.background = 'radial-gradient(ellipse at center, transparent 30%, rgba(90,0,0,0.6))';
      this.overlay.append(h('div', { class: 'center-msg', style: 'top:40%', html: `<b style="font-size:28px">You are down</b><br>A teammate can revive you · ${Math.ceil(self.downed)}s` }));
    } else if (self.sleeping) {
      this.overlay.className = 'overlay';
      this.overlay.style.background = 'transparent';
      this.overlay.append(h('div', { style: 'display:flex;flex-direction:column;align-items:center;gap:12px' },
        h('div', { style: 'font-size:22px', text: 'Resting… the night passes when every survivor rests.' }),
        h('button', { class: 'btn', text: 'Get up', on: { click: () => void this.act({ a: 'wake' }) } })));
    } else {
      this.overlay.style.background = '';
    }
  }

  private contextHints() {
    if (!this.settings.gameplay.showTutorial) return;
    const s = this.session;
    const once = (k: string, text: string) => { if (!this.hintShown.has(k)) { this.hintShown.add(k); this.hud.notify(text, 'info'); } };
    const self = s.self!;
    if (self.thirst < 35) once('thirst', 'You are getting thirsty. Coconuts, rain catchers and distilled water are safe — sea water is not.');
    if (self.hunger < 35) once('hunger', 'You are hungry. Crabs on the beach, fish in the shallows, berries in the bushes.');
    if (self.bodyTemp < 36.2) once('cold', 'You are cold. Get dry, get out of the wind, get near a fire.');
    if (self.oxygen < 40) once('oxy', 'Low on air — surface!');
    if (s.pred.swimming && -(s.gen?.heightAt(s.pred.x, s.pred.z) ?? 0) > 15) once('deep', 'Deep water. Sharks hunt out here — a raft is safer.');
  }
}
