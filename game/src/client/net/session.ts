/**
 * ClientSession: the client-side view of an authoritative server.
 *  - replicated world state (reliable deltas)
 *  - snapshot interpolation for remote entities
 *  - local player prediction + server reconciliation (shared movement code)
 *  - action requests with ids and async results
 * Has no DOM / rendering dependencies so it runs in Node tests as well.
 */
import { PROTOCOL_VERSION, SIM, NET, PLAYER, SURVIVAL } from '../../shared/config';
import { WorldGen } from '../../shared/world/worldgen';
import { CollisionWorld } from '../../shared/world/collision';
import { waveHeight, shoreDamping } from '../../shared/world/ocean';
import { seaState } from '../../shared/systems/weather';
import { stepMovement, type InputFrame, type MoveState } from '../../shared/systems/movement';
import { totalWeight, carryCapacity } from '../../shared/systems/inventory';
import { ITEMS } from '../../shared/defs/items';
import { STRUCTURES } from '../../shared/defs/structures';
import { seatPosition } from '../../shared/sim/vehicles';
import type {
  Action, ServerMsg, Snapshot, WelcomeMsg, WorldDelta, NetPlayer, NetCreature, NetVehicle, SelfState, FxEvent, PrivatePlayer,
} from '../../shared/net/protocol';
import type { ContainerState, DroppedItem, GameSettings, Progression, StructureState, Waypoint, WorldEvent } from '../../shared/state';
import type { Transport } from './transport';

export interface Identity { name: string; token: string; color?: string }

export interface InputSample {
  mx: number; mz: number; yaw: number; pitch: number; jump: boolean; sprint: boolean; crouch: boolean;
}

interface Hist<T> { t: number; s: T }

export interface SessionEvents {
  welcome?: (w: WelcomeMsg) => void;
  delta?: (d: WorldDelta) => void;
  notify?: (text: string, level: string) => void;
  chat?: (name: string, text: string, from: string) => void;
  fx?: (list: FxEvent[]) => void;
  roster?: (list: { id: string; name: string; color: string; connected: boolean }[]) => void;
  disconnect?: (reason: string) => void;
  reject?: (reason: string) => void;
  saved?: (ok: boolean) => void;
  snapshot?: (s: Snapshot) => void;
}

export class ClientSession {
  // identity / meta
  playerId = '';
  seed = 0;
  worldName = '';
  settings: GameSettings | null = null;
  connected = false;
  gen: WorldGen | null = null;
  col: CollisionWorld | null = null;

  // replicated world
  structures: Record<string, StructureState> = {};
  containers: Record<string, ContainerState> = {};
  nodes: Record<string, { hp?: number; respawnAt?: number }> = {};
  items: Record<string, DroppedItem> = {};
  waypoints: Waypoint[] = [];
  progression: Progression | null = null;
  events: WorldEvent[] = [];
  me: PrivatePlayer | null = null;
  self: SelfState | null = null;
  roster: { id: string; name: string; color: string; connected: boolean }[] = [];
  weather: Snapshot['weather'] = { cloud: 0.1, rain: 0, wind: 0.2, waves: 0.7, fog: 0, windDir: 0, lightningAt: 0, kind: 'clear', next: 'clear', blend: 1 };
  dayOffset = 0;

  // timing
  rtt = 0;
  private serverTimeOffset: number | null = null; // serverTime - localSeconds
  lastSnapshotAt = 0;
  snapshotsReceived = 0;
  bytesIn = 0;

  // interpolation buffers
  private playerHist = new Map<string, Hist<NetPlayer>[]>();
  private creatureHist = new Map<string, Hist<NetCreature>[]>();
  private vehicleHist = new Map<string, Hist<NetVehicle>[]>();
  projectiles: Snapshot['projectiles'] = [];

  // prediction
  pred: MoveState = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, onGround: true, crouching: false, sprinting: false, swimming: false, underwater: false, landingSpeed: 0 };
  /** smoothed visual correction offset (decays to 0) */
  correction = { x: 0, y: 0, z: 0 };
  private pending: InputFrame[] = [];
  private unsent: InputFrame[] = [];
  private seq = 0;
  private stepAcc = 0;
  private sendAcc = 0;
  private predStamina = 100;
  reconciliations = 0;
  maxCorrection = 0;

  // actions
  private nextAct = 1;
  private waiting = new Map<number, { resolve: (r: { ok: boolean; reason?: string }) => void; timer: ReturnType<typeof setTimeout> }>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private transport: Transport, private identity: Identity, public on: SessionEvents = {}) {
    transport.onOpen = () => this.hello();
    transport.onMessage = (m) => this.receive(m);
    transport.onClose = (r) => this.closed(r);
  }

  /** For transports that are already open (worker/loopback). */
  hello(): void {
    this.transport.send({ t: 'hello', protocol: PROTOCOL_VERSION, name: this.identity.name, token: this.identity.token, color: this.identity.color });
    if (!this.pingTimer) this.pingTimer = setInterval(() => this.transport.send({ t: 'ping', c: performance.now() }), NET.heartbeatMs);
  }

  close(): void {
    try { this.transport.send({ t: 'bye' }); } catch { /* ignore */ }
    this.transport.close();
    this.cleanup();
  }

  private cleanup() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const w of this.waiting.values()) { clearTimeout(w.timer); w.resolve({ ok: false, reason: 'Disconnected' }); }
    this.waiting.clear();
  }

  private closed(reason: string) {
    const was = this.connected;
    this.connected = false;
    this.cleanup();
    if (was || reason) this.on.disconnect?.(reason);
  }

  localSeconds(): number { return performance.now() / 1000; }

  /** Estimated current authoritative simulation time. */
  serverTime(): number {
    return this.serverTimeOffset === null ? 0 : this.localSeconds() + this.serverTimeOffset;
  }

  /** Time at which remote entities are rendered (behind for interpolation). */
  renderTime(): number { return this.serverTime() - NET.interpolationDelayMs / 1000; }

  waterLevel = (x: number, z: number): number => {
    if (!this.gen) return 0;
    const depth = -this.gen.heightAt(x, z);
    return waveHeight(x, z, this.serverTime(), seaState(this.weather)) * shoreDamping(depth);
  };

  isNodeDepleted(id: string): boolean {
    const n = this.nodes[id];
    return !!n && n.respawnAt !== undefined && n.respawnAt > this.serverTime();
  }

  // ------------------------------------------------------------------ receive
  private receive(m: ServerMsg): void {
    switch (m.t) {
      case 'welcome': this.onWelcome(m); break;
      case 'snap': this.onSnapshot(m); break;
      case 'delta': this.applyDelta(m); this.on.delta?.(m); break;
      case 'fx': this.on.fx?.(m.list); break;
      case 'result': {
        const w = this.waiting.get(m.id);
        if (w) { clearTimeout(w.timer); this.waiting.delete(m.id); w.resolve({ ok: m.ok, reason: m.reason }); }
        break;
      }
      case 'notify': this.on.notify?.(m.text, m.level); break;
      case 'chat': this.on.chat?.(m.name, m.text, m.from); break;
      case 'roster': this.roster = m.list; this.on.roster?.(m.list); break;
      case 'pong': this.rtt = this.rtt ? this.rtt * 0.8 + (performance.now() - m.c) * 0.2 : performance.now() - m.c; break;
      case 'reject': this.on.reject?.(m.reason); break;
      case 'saved': this.on.saved?.(m.ok); break;
    }
  }

  private onWelcome(w: WelcomeMsg): void {
    this.playerId = w.playerId;
    this.seed = w.seed;
    this.worldName = w.worldName;
    this.settings = w.settings;
    this.roster = w.roster;
    if (!this.gen || this.gen.seed !== w.seed) {
      this.gen = new WorldGen(w.seed);
      this.col = new CollisionWorld(this.gen, (id) => this.isNodeDepleted(id));
    }
    const fp = this.gen.fingerprint();
    if (fp !== w.fingerprint) {
      this.on.reject?.(`World generation mismatch (client ${fp}, server ${w.fingerprint}). Update your game.`);
      this.transport.close();
      return;
    }
    this.structures = {};
    this.applyDelta(w.full);
    this.connected = true;
    this.on.welcome?.(w);
  }

  applyDelta(d: WorldDelta): void {
    if (d.structures) for (const [id, s] of Object.entries(d.structures)) {
      if (s) { this.structures[id] = s; this.col?.addStructure(s, !!(STRUCTURES[s.type]?.door && s.on)); }
      else { delete this.structures[id]; this.col?.removeStructure(id); }
    }
    if (d.containers) for (const [id, c] of Object.entries(d.containers)) { if (c) this.containers[id] = c; else delete this.containers[id]; }
    if (d.nodes) for (const [id, n] of Object.entries(d.nodes)) { if (n) this.nodes[id] = n; else delete this.nodes[id]; }
    if (d.items) for (const [id, it] of Object.entries(d.items)) { if (it) this.items[id] = it; else delete this.items[id]; }
    if (d.waypoints) this.waypoints = d.waypoints;
    if (d.progression) this.progression = d.progression;
    if (d.events) this.events = d.events;
    if (d.me) this.me = d.me;
  }

  private onSnapshot(s: Snapshot): void {
    this.snapshotsReceived++;
    this.lastSnapshotAt = performance.now();
    const local = this.localSeconds();
    // time sync: assume half RTT transit, smooth toward the lowest-latency estimate
    const est = s.time + this.rtt / 2000 - local;
    if (this.serverTimeOffset === null || Math.abs(est - this.serverTimeOffset) > 1) this.serverTimeOffset = est;
    else this.serverTimeOffset += (est - this.serverTimeOffset) * 0.05;
    this.weather = s.weather;
    this.dayOffset = s.dayOffset;
    const t = s.time;
    const seenP = new Set<string>();
    for (const p of s.players) { push(this.playerHist, p.id, t, p); seenP.add(p.id); }
    for (const c of s.creatures) push(this.creatureHist, c.id, t, c);
    for (const v of s.vehicles) push(this.vehicleHist, v.id, t, v);
    // players are sent every snapshot; creatures/vehicles are delta-sent with a 1 s keep-alive
    prune(this.playerHist, seenP);
    pruneStale(this.creatureHist, t - 2.5);
    pruneStale(this.vehicleHist, t - 2.5);
    this.projectiles = s.projectiles;
    if (s.self) this.reconcile(s.self);
    this.on.snapshot?.(s);
  }

  // ------------------------------------------------------------------ prediction
  get predicting(): boolean {
    const s = this.self;
    return !!s && !s.dead && s.downed <= 0 && !s.sleeping && !s.vehicleId;
  }

  private reconcile(st: SelfState): void {
    const firstSelf = !this.self;
    this.self = st;
    this.predStamina = st.stamina;
    if (!this.predicting || firstSelf) {
      this.pred.x = st.x; this.pred.y = st.y; this.pred.z = st.z;
      this.pred.vx = st.vx; this.pred.vy = st.vy; this.pred.vz = st.vz;
      this.pred.onGround = st.og; this.pred.crouching = st.cr; this.pred.swimming = st.sw; this.pred.underwater = st.uw;
      this.pending = this.pending.filter((f) => f.seq > st.seq);
      this.correction = { x: 0, y: 0, z: 0 };
      return;
    }
    const before = { x: this.pred.x, y: this.pred.y, z: this.pred.z };
    // rewind to authoritative state, replay unacknowledged inputs
    this.pending = this.pending.filter((f) => f.seq > st.seq);
    const m = this.pred;
    m.x = st.x; m.y = st.y; m.z = st.z; m.vx = st.vx; m.vy = st.vy; m.vz = st.vz;
    m.onGround = st.og; m.crouching = st.cr; m.swimming = st.sw; m.underwater = st.uw;
    const env = this.moveEnv();
    for (const f of this.pending) stepMovement(m, f, env, SIM.moveStep);
    const ex = before.x - m.x, ey = before.y - m.y, ez = before.z - m.z;
    const err = Math.hypot(ex, ey, ez);
    if (err > 0.01) {
      this.reconciliations++;
      this.maxCorrection = Math.max(this.maxCorrection, err);
      if (err < 3) { this.correction.x += ex; this.correction.y += ey; this.correction.z += ez; }
      else this.correction = { x: 0, y: 0, z: 0 }; // teleport-sized: snap
    }
  }

  private moveEnv() {
    const me = this.me;
    let speedMul = 1, swimMul = 1, overload = 0;
    if (me) {
      const w = totalWeight(me.inventory), cap = carryCapacity(me.inventory);
      overload = Math.max(0, w - cap) / cap;
      speedMul = 1 - Math.min(0.6, overload * 1.2);
      for (const k of ['head', 'body', 'back', 'feet'] as const) { const e = me.inventory.equip[k]; if (e) swimMul *= ITEMS[e.id]?.equip?.swimSpeedMul ?? 1; }
    }
    const eff = this.self?.effects ?? {};
    if (eff.fracture) speedMul *= 0.6;
    if (eff.exhausted) speedMul *= 0.8;
    return {
      col: this.col!, waterLevel: this.waterLevel, speedMul, swimMul,
      canSprint: this.predStamina > 5 && !eff.exhausted && !eff.fracture && overload < 0.5,
      canJump: this.predStamina > SURVIVAL.jumpStaminaCost && !eff.fracture,
    };
  }

  /**
   * Advance local prediction by real dt using the current input sample.
   * Generates fixed-step input frames, applies them locally and queues them for sending.
   */
  update(dt: number, input: InputSample): void {
    if (!this.connected || !this.col) return;
    // decay visual correction (~100 ms)
    const k = Math.exp(-dt * 12);
    this.correction.x *= k; this.correction.y *= k; this.correction.z *= k;

    this.stepAcc += Math.min(dt, 0.25);
    const env = this.moveEnv();
    while (this.stepAcc >= SIM.moveStep) {
      this.stepAcc -= SIM.moveStep;
      const f: InputFrame = { seq: ++this.seq, ...input };
      if (this.predicting) {
        stepMovement(this.pred, f, env, SIM.moveStep);
        this.pending.push(f);
        if (this.pending.length > 240) this.pending.shift();
      } else {
        this.pred.yaw = input.yaw; this.pred.pitch = input.pitch;
      }
      this.unsent.push(f);
    }
    this.sendAcc += dt;
    if (this.sendAcc >= 1 / 30 && this.unsent.length) {
      this.sendAcc = 0;
      // redundancy: resend the last 3 already-sent frames to survive input packet loss
      const redundant = this.pending.filter((f) => f.seq < this.unsent[0]!.seq).slice(-3);
      this.transport.send({ t: 'input', frames: [...redundant, ...this.unsent].slice(-SIM.maxBufferedInputs) });
      this.unsent = [];
    }
  }

  /** Position used for the camera (prediction + smoothing). */
  viewPosition(): { x: number; y: number; z: number } {
    if (!this.predicting && this.self) {
      if (this.self.vehicleId) {
        // seated: follow the interpolated vehicle so the camera is smooth
        const v = this.vehicleAt(this.self.vehicleId);
        if (v) return seatPosition(v.k, v.x, v.y, v.z, v.yaw, this.self.seat);
      }
      return { x: this.self.x, y: this.self.y, z: this.self.z };
    }
    return { x: this.pred.x + this.correction.x, y: this.pred.y + this.correction.y, z: this.pred.z + this.correction.z };
  }

  // ------------------------------------------------------------------ interpolation
  remotePlayers(): NetPlayer[] { return this.sample(this.playerHist, lerpPlayer); }
  creatures(): NetCreature[] { return this.sample(this.creatureHist, lerpCreature); }
  vehicles(): NetVehicle[] { return this.sample(this.vehicleHist, lerpVehicle); }
  vehicleAt(id: string): NetVehicle | undefined { return this.vehicles().find((v) => v.id === id); }

  private sample<T>(hist: Map<string, Hist<T>[]>, lerp: (a: T, b: T, t: number) => T): T[] {
    const rt = this.renderTime();
    const out: T[] = [];
    for (const h of hist.values()) {
      if (!h.length) continue;
      let i = h.length - 1;
      while (i > 0 && h[i]!.t > rt) i--;
      const a = h[i]!, b = h[i + 1];
      if (!b || b.t <= a.t) {
        out.push(a.s); // hold last (no extrapolation for stability)
      } else {
        const t = Math.max(0, Math.min(1, (rt - a.t) / (b.t - a.t)));
        out.push(lerp(a.s, b.s, t));
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ actions
  act(action: Action, timeoutMs = 8000): Promise<{ ok: boolean; reason?: string }> {
    if (!this.connected) return Promise.resolve({ ok: false, reason: 'Not connected' });
    const id = this.nextAct++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.waiting.delete(id); resolve({ ok: false, reason: 'Timed out' }); }, timeoutMs);
      this.waiting.set(id, { resolve, timer });
      this.transport.send({ t: 'act', id, action });
    });
  }

  /** Resend a raw act with a specific id (used by tests to verify duplicate rejection). */
  rawAct(id: number, action: Action): void { this.transport.send({ t: 'act', id, action }); }

  requestSave(): void { this.transport.send({ t: 'save' }); }

  // convenience accessors
  get hotbarItem() { return this.me ? this.me.inventory.slots[this.me.hotbar] ?? null : null; }
  get eyeHeight() { return this.pred.crouching ? PLAYER.crouchHeight - 0.08 : PLAYER.eyeHeight; }
}

function push<T>(map: Map<string, Hist<T>[]>, id: string, t: number, s: T) {
  let h = map.get(id);
  if (!h) { h = []; map.set(id, h); }
  const last = h[h.length - 1];
  if (last && last.t >= t) return;
  // delta snapshots: after a long silence the entity was stationary until just now,
  // so hold the previous state instead of smearing interpolation across the gap
  if (last && t - last.t > 0.3) h.push({ t: t - 0.05, s: last.s });
  h.push({ t, s });
  if (h.length > 30) h.splice(0, h.length - 30);
}

function prune<T>(map: Map<string, Hist<T>[]>, seen: Set<string>) {
  for (const id of map.keys()) if (!seen.has(id)) map.delete(id);
}

function pruneStale<T>(map: Map<string, Hist<T>[]>, before: number) {
  for (const [id, h] of map) if (!h.length || h[h.length - 1]!.t < before) map.delete(id);
}

const lerpN = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpAng = (a: number, b: number, t: number) => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};

function lerpPlayer(a: NetPlayer, b: NetPlayer, t: number): NetPlayer {
  return { ...b, x: lerpN(a.x, b.x, t), y: lerpN(a.y, b.y, t), z: lerpN(a.z, b.z, t), yaw: lerpAng(a.yaw, b.yaw, t), pitch: lerpN(a.pitch, b.pitch, t) };
}
function lerpCreature(a: NetCreature, b: NetCreature, t: number): NetCreature {
  return { ...b, x: lerpN(a.x, b.x, t), y: lerpN(a.y, b.y, t), z: lerpN(a.z, b.z, t), yaw: lerpAng(a.yaw, b.yaw, t) };
}
function lerpVehicle(a: NetVehicle, b: NetVehicle, t: number): NetVehicle {
  return { ...b, x: lerpN(a.x, b.x, t), y: lerpN(a.y, b.y, t), z: lerpN(a.z, b.z, t), yaw: lerpAng(a.yaw, b.yaw, t), p: lerpN(a.p, b.p, t), r: lerpN(a.r, b.r, t) };
}
