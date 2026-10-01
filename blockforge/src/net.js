// Shared worlds: one player hosts a world and friends join with a room code.
//
// The host runs the world. Every player generates the same terrain from the
// seed, so only what players changed has to travel: block edits, each
// chunk's differences from freshly generated terrain, snapshots of creatures
// and items, and events (damage, pickups, chat).
//
// Guests move and act locally and pass their requests (edits, hits, drops,
// chunk requests) to the host through their presence object, as a small
// outbox the host acknowledges. That works even where a viewer may only set
// presence. The host answers with broadcast messages.
//
// Transports: the claude.ai room of a shared artifact, other tabs of this
// browser (BroadcastChannel), or a tiny relay server (tools/relay.mjs).
import { BLOCKS, isLiquid } from './blocks.js';
import { ITEMS, I } from './items.js';
import { Mob, ItemEntity, Projectile, PrimedCrate, FallingBlock, Lightning, MOB_TYPES } from './entities.js';
import { Minecart, Boat } from './vehicles.js';
import { Pylon, Wyrm, VoidOrb } from './voidboss.js';
import { CHUNK_VOLUME, chunkKey } from './constants.js';
import { STATE } from './world.js';

export const NET_VERSION = 1;
// event topics the host sends on (declared for the claude.ai room)
export const NET_TOPICS = ['wel', 'd', 'b', 's', 'ev', 'c'];

const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
const randomId = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);

export function makeCode() {
  const a = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

function b64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
  return btoa(s);
}
function unb64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
// Chunk differences: index (u16), block id (u16), meta (u8) per entry.
function packDiff(entries) {
  const u = new Uint8Array(entries.length * 5);
  entries.forEach(([idx, id, meta], k) => {
    const o = k * 5;
    u[o] = idx & 255; u[o + 1] = idx >> 8; u[o + 2] = id & 255; u[o + 3] = id >> 8; u[o + 4] = meta;
  });
  return b64(u);
}
function unpackDiff(str) {
  const u = unb64(str), out = [];
  for (let o = 0; o + 4 < u.length; o += 5) out.push([u[o] | (u[o + 1] << 8), u[o + 2] | (u[o + 3] << 8), u[o + 4]]);
  return out;
}

// ---------------------------------------------------------------------------
// Transports. Each opens rooms with the same small interface:
//   me, emit(topic, data), on(topic, fn(data, fromPeer)), presence(obj),
//   peers() -> [{ peer, isMe, presence }], onPeers(fn), connected(), close()

class ClaudeLink {
  constructor(api) { this.api = api; this.kind = 'claude'; this.label = 'Everyone viewing this page'; this.limited = true; }
  static async create() {
    const c = globalThis.claude;
    if (!c || typeof c.use !== 'function') return null;
    try {
      const room = await Promise.race([c.use('room'), new Promise((res) => setTimeout(() => res(null), 10500))]);
      return room ? new ClaudeLink(room) : null;
    } catch { return null; }
  }
  async open(name) {
    const r = name ? await this.api.join(name) : this.api;
    return new ClaudeRoom(r, !name);
  }
}

class ClaudeRoom {
  constructor(r, lobby) {
    this.r = r; this.lobby = lobby; this.me = null; this.unsubs = []; this.peerFns = [];
    this.unsubs.push(r.onPeers((ch) => {
      const mine = ch.peers.find((p) => p.isMe && p.sameTab);
      if (mine) this.me = mine.peer;
      const list = this.peers();
      for (const f of this.peerFns) f(list);
    }, (e) => { this.error = e; }));
  }
  emit(topic, data) { return this.r.emit(topic, data).catch((e) => { this.error = e; }); }
  on(topic, fn) { this.unsubs.push(this.r.on(topic, (m) => { if (m.sameTab) return; fn(m.data, m.peer); }, (e) => { this.error = e; })); }
  presence(obj) { return this.r.presence(obj).catch((e) => { this.error = e; }); }
  peers() { return this.r.peers().map((p) => ({ peer: p.peer, isMe: p.isMe && p.sameTab, presence: p.presence || {} })); }
  onPeers(fn) { this.peerFns.push(fn); }
  connected() { return this.r.connected(); }
  close() {
    for (const u of this.unsubs) { try { u(); } catch { /* gone */ } }
    if (!this.lobby) this.r.leave().catch(() => {});
    else this.r.presence({ bf: null }).catch(() => {});
  }
}

class ChannelLink {
  constructor() { this.kind = 'tabs'; this.label = 'Other tabs in this browser'; this.me = randomId(); this.limited = false; }
  static create() { return typeof BroadcastChannel === 'function' ? new ChannelLink() : null; }
  async open(name) { return new ChannelRoom('blockforge:' + (name || 'lobby'), this.me); }
}

class ChannelRoom {
  constructor(chName, me) {
    this.me = me; this.handlers = new Map(); this.peerMap = new Map(); this.peerFns = []; this.mine = {};
    this.ch = new BroadcastChannel(chName);
    this.ch.onmessage = (e) => this.receive(e.data);
    this.beat = setInterval(() => { this.post({ k: 'p', p: this.mine }); this.sweep(); }, 1000);
    this.post({ k: 'hello' });
  }
  post(m) { m.from = this.me; try { this.ch.postMessage(m); } catch { /* closed */ } }
  receive(m) {
    if (!m || m.from === this.me) return;
    if (m.k === 'hello') { this.post({ k: 'p', p: this.mine }); return; }
    if (m.k === 'p') { this.peerMap.set(m.from, { presence: m.p || {}, seen: Date.now() }); this.changed(); return; }
    if (m.k === 'bye') { this.peerMap.delete(m.from); this.changed(); return; }
    if (m.k === 'e') { const fns = this.handlers.get(m.t); if (fns) for (const f of fns) f(m.d, m.from); }
  }
  sweep() {
    const now = Date.now();
    let ch = false;
    for (const [k, v] of this.peerMap) if (now - v.seen > 5000) { this.peerMap.delete(k); ch = true; }
    if (ch) this.changed();
  }
  changed() { const list = this.peers(); for (const f of this.peerFns) f(list); }
  emit(topic, data) { this.post({ k: 'e', t: topic, d: data }); return Promise.resolve(); }
  on(topic, fn) { if (!this.handlers.has(topic)) this.handlers.set(topic, []); this.handlers.get(topic).push(fn); }
  presence(obj) { this.mine = obj; this.post({ k: 'p', p: obj }); return Promise.resolve(); }
  peers() { return [{ peer: this.me, isMe: true, presence: this.mine }, ...[...this.peerMap].map(([peer, v]) => ({ peer, isMe: false, presence: v.presence }))]; }
  onPeers(fn) { this.peerFns.push(fn); }
  connected() { return true; }
  close() { this.post({ k: 'bye' }); clearInterval(this.beat); try { this.ch.close(); } catch { /* closed */ } }
}

class SocketLink {
  constructor(url) { this.url = url; this.kind = 'relay'; this.label = 'Relay server'; this.limited = false; }
  async open(name) { const r = new SocketRoom(this.url, name || 'lobby'); await r.ready; return r; }
}

class SocketRoom {
  constructor(url, room) {
    this.handlers = new Map(); this.peerMap = new Map(); this.peerFns = []; this.mine = {}; this.me = null;
    this.ws = new WebSocket(url);
    this.ready = new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('The relay server did not answer.')), 7000);
      this.ws.onopen = () => this.ws.send(JSON.stringify({ k: 'join', room }));
      this.ws.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.k === 'joined') {
          this.me = m.you;
          for (const p of m.peers || []) this.peerMap.set(p.id, p.presence || {});
          clearTimeout(t); res(); this.changed();
          return;
        }
        if (m.k === 'p') { this.peerMap.set(m.from, m.p || {}); this.changed(); } else if (m.k === 'left') { this.peerMap.delete(m.from); this.changed(); } else if (m.k === 'e') { const fns = this.handlers.get(m.t); if (fns) for (const f of fns) f(m.d, m.from); }
      };
      this.ws.onerror = () => { clearTimeout(t); rej(new Error('Could not reach the relay server.')); };
      this.ws.onclose = () => { this.closed = true; this.peerMap.clear(); this.changed(); };
    });
  }
  send(m) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); }
  changed() { const list = this.peers(); for (const f of this.peerFns) f(list); }
  emit(topic, data) { this.send({ k: 'e', t: topic, d: data }); return Promise.resolve(); }
  on(topic, fn) { if (!this.handlers.has(topic)) this.handlers.set(topic, []); this.handlers.get(topic).push(fn); }
  presence(obj) { this.mine = obj; this.send({ k: 'p', p: obj }); return Promise.resolve(); }
  peers() { return [{ peer: this.me, isMe: true, presence: this.mine }, ...[...this.peerMap].map(([peer, p]) => ({ peer, isMe: false, presence: p }))]; }
  onPeers(fn) { this.peerFns.push(fn); }
  connected() { return this.ws.readyState === 1; }
  close() { try { this.ws.close(); } catch { /* closed */ } }
}

// The connections this page can make, best first.
export async function availableLinks(relayUrl) {
  const out = [];
  const c = await ClaudeLink.create();
  if (c) out.push(c);
  const t = ChannelLink.create();
  if (t) out.push(t);
  if (relayUrl) out.push(new SocketLink(relayUrl));
  return out;
}
export function relayLink(url) { return new SocketLink(url); }

// ---------------------------------------------------------------------------
// Another player as seen locally (drawn, targeted, hurt through the network).
export class RemotePlayer {
  constructor(peer) {
    this.peer = peer;
    this.isRemote = true; this.isPlayer = true;
    this.name = 'Player';
    this.x = 0; this.y = -100; this.z = 0; this.px = 0; this.py = -100; this.pz = 0;
    this.tx = 0; this.ty = -100; this.tz = 0; this.placed = false;
    this.yaw = 0; this.pyaw = 0; this.pitch = 0; this.ppitch = 0; this.tyaw = 0; this.tpitch = 0;
    this.w = 0.3; this.h = 1.8; this.eye = 1.62;
    this.bob = 0; this.pbob = 0; this.walkDist = 0; this.pWalkDist = 0;
    this.held = 0; this.armor = [0, 0, 0, 0];
    this.swing = 0; this.swingT = 0; this.swingCount = 0;
    this.sneaking = false; this.gliding = false; this.blocking = false; this.riding = false; this.sleeping = false; this.flying = false;
    this.dead = false; this.creative = false; this.spectator = false; this.effects = {};
    this.hurtTime = 0; this.health = 20; this.dim = 'overworld';
    this.inventory = { held: null };
    this.fireTicks = 0;
    this.vehicleId = 0;
  }
  get targetable() { return !this.dead; }
  hitBoxes() { return [[this.x - 0.3, this.y, this.z - 0.3, this.x + 0.3, this.y + 1.8, this.z + 0.3]]; }
  interact() { return false; }
  lerpPos(t) { return [this.px + (this.x - this.px) * t, this.py + (this.y - this.py) * t, this.pz + (this.z - this.pz) * t]; }

  apply(pr) {
    if (typeof pr.n === 'string') this.name = pr.n.slice(0, 16) || 'Player';
    if (typeof pr.x === 'number') {
      this.tx = pr.x; this.ty = pr.y; this.tz = pr.z;
      if (!this.placed) { this.x = this.px = pr.x; this.y = this.py = pr.y; this.z = this.pz = pr.z; this.placed = true; }
    }
    if (typeof pr.yw === 'number') this.tyaw = pr.yw;
    if (typeof pr.pt === 'number') this.tpitch = pr.pt;
    this.held = pr.h | 0;
    this.inventory.held = this.held ? { id: this.held, count: 1 } : null;
    if (Array.isArray(pr.a)) this.armor = pr.a.slice(0, 4).map((v) => v | 0);
    const f = pr.f | 0;
    this.sneaking = !!(f & 1); this.sleeping = !!(f & 2); this.flying = !!(f & 4); this.gliding = !!(f & 8);
    this.blocking = !!(f & 16); this.dead = !!(f & 32); this.creative = !!(f & 64); this.spectator = !!(f & 256);
    this.riding = !!(f & 512);
    this.effects = f & 128 ? { invisibility: { amp: 0, time: 20 } } : {};
    if ((pr.sc | 0) !== this.swingCount) { this.swingCount = pr.sc | 0; this.swingT = 6; }
    if (typeof pr.hp === 'number') { if (pr.hp < this.health) this.hurtTime = 10; this.health = pr.hp; }
    this.dim = pr.dm || 'overworld';
    this.vehicleId = pr.v | 0;
  }

  tick() {
    this.px = this.x; this.py = this.y; this.pz = this.z; this.pyaw = this.yaw; this.ppitch = this.pitch;
    this.pbob = this.bob; this.pWalkDist = this.walkDist;
    const k = 0.45;
    this.x += (this.tx - this.x) * k; this.y += (this.ty - this.y) * k; this.z += (this.tz - this.z) * k;
    let d = this.tyaw - this.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.yaw += d * 0.5;
    this.pitch += (this.tpitch - this.pitch) * 0.5;
    const moved = Math.hypot(this.x - this.px, this.z - this.pz);
    this.walkDist += moved * 0.6;
    this.bob += (Math.min(0.1, moved) - this.bob) * 0.4;
    if (this.swingT > 0) { this.swingT--; this.swing = 1 - this.swingT / 6; } else this.swing = 0;
    if (this.hurtTime > 0) this.hurtTime--;
  }

  damage(game, amount, source, fromX, fromZ) {
    if (game.net) game.net.hurtRemote(this, amount, source, fromX, fromZ);
    return true;
  }
  applyPotion(game, fx, scale = 1) { if (game.net) game.net.event(this.peer, { t: 'pot', fx, sc: scale }); }
}

// ---------------------------------------------------------------------------
// Entity snapshots (host -> guests).
function entityEntry(e, ctrl) {
  if (e instanceof Mob) {
    let f = 0;
    if (e.dead) f |= 1;
    if (e.baby) f |= 2;
    if (e.sheared) f |= 4;
    if (e.angry > 0) f |= 8;
    if (e.fire > 0) f |= 16;
    if (e.swing > 0) f |= 32;
    if (e.love > 0) f |= 64;
    if (e.hurtTime > 0) f |= 128;
    if (e.aim > 0) f |= 256;
    if (e.effects && e.effects.invisibility) f |= 512;
    const out = ['m', e.id, e.type, r2(e.x), r2(e.y), r2(e.z), r3(e.bodyYaw), r3(e.headYaw), r3(e.headPitch), f];
    if (e.profession || e.armor) out.push(e.profession || 0, e.armor || 0);
    return out;
  }
  if (e instanceof ItemEntity) return ['i', e.id, r2(e.x), r2(e.y), r2(e.z), e.stack.id, e.stack.count, e.stack.ench ? 1 : 0];
  if (e instanceof Projectile) return ['p', e.id, e.kind, r2(e.x), r2(e.y), r2(e.z), r2(e.vx), r2(e.vy), r2(e.vz), e.stuck ? 1 : 0, r3(e.yaw), r3(e.pitch), e.item || 0];
  if (e.isCart) return ['c', e.id, r2(e.x), r2(e.y), r2(e.z), r3(e.yaw), r3(e.pitch || 0), ctrl || 0];
  if (e.isBoat) return ['o', e.id, r2(e.x), r2(e.y), r2(e.z), r3(e.yaw), r2(e.paddle || 0), ctrl || 0];
  if (e instanceof PrimedCrate) return ['t', e.id, r2(e.x), r2(e.y), r2(e.z), e.fuse];
  if (e instanceof FallingBlock) return ['f', e.id, r2(e.x), r2(e.y), r2(e.z), e.block, e.meta];
  if (e.isPylon) return ['y', e.id, r2(e.x), r2(e.y), r2(e.z)];
  if (e.isWyrm) {
    const segs = [];
    for (const s of e.segs) segs.push(r2(s.x), r2(s.y), r2(s.z), r3(s.yaw), r3(s.pitch));
    return ['w', e.id, r2(e.x), r2(e.y), r2(e.z), r3(e.yaw), r3(e.pitch), Math.round(e.health), e.hurtTime > 0 ? 1 : 0, e.dying | 0, e.healing ? e.healing.id : 0, segs];
  }
  if (e.isOrb) return ['v', e.id, r2(e.x), r2(e.y), r2(e.z)];
  if (e instanceof Lightning) return ['l', e.id, r2(e.x), r2(e.y), r2(e.z), e.seed];
  return null;
}

// Make a local stand-in for a host entity.
function makeMirror(en) {
  const [k, , a, b, c] = en;
  let e = null;
  switch (k) {
    case 'm': {
      const [, , type, x, y, z, , , , f, prof, armor] = en;
      if (!MOB_TYPES[type]) return null;
      e = new Mob(type, x, y, z, { profession: prof || null, armor: armor || null, baby: !!(f & 2) });
      e.bodyYaw = e.yaw = e.pyaw = en[6];
      break;
    }
    case 'i': e = new ItemEntity(a, b, c, { id: en[5], count: en[6], ench: en[7] ? {} : undefined }); e.pickupDelay = 1e9; break;
    case 'p': e = new Projectile(en[2], en[3], en[4], en[5], en[6], en[7], en[8], null, 0); e.item = en[12] || undefined; break;
    case 'c': e = new Minecart(a, b, c); break;
    case 'o': e = new Boat(a, b, c, en[5]); break;
    case 't': e = new PrimedCrate(a - 0.5, b, c - 0.5, en[5]); e.x = a; e.z = c; break;
    case 'f': e = new FallingBlock(a - 0.5, b, c - 0.5, en[5], en[6]); e.x = a; e.z = c; break;
    case 'y': e = new Pylon(a, b, c); break;
    case 'w': e = new Wyrm(a, b, c, en[7]); break;
    case 'v': e = new VoidOrb(a, b, c, 0, 0, 0); break;
    case 'l': e = new Lightning(a, b, c); e.seed = en[5]; break;
    default: return null;
  }
  e.mirror = true;
  e.netKind = k;
  return e;
}

// Bring a stand-in up to date with a fresh entry.
function updateMirror(e, en) {
  e.netEntry = en;
  e.lastSeen = 0;
  switch (en[0]) {
    case 'm': {
      e.tx = en[3]; e.ty = en[4]; e.tz = en[5];
      e.tBodyYaw = en[6]; e.tHeadYaw = en[7]; e.tHeadPitch = en[8];
      const f = en[9];
      if (f & 1 && !e.dead) { e.dead = true; e.deathTime = 0; }
      e.sheared = !!(f & 4); e.angry = f & 8 ? 20 : 0; e.fire = f & 16 ? 20 : 0;
      if (f & 32 && !e.swing) e.swing = 10;
      e.love = f & 64 ? 20 : 0;
      if (f & 128 && !e.hurtTime) e.hurtTime = 10;
      e.aim = f & 256 ? 10 : 0;
      e.effects = f & 512 ? { invisibility: { amp: 0, time: 20 } } : null;
      break;
    }
    case 'i': e.tx = en[2]; e.ty = en[3]; e.tz = en[4]; e.stack.id = en[5]; e.stack.count = en[6]; break;
    case 'p':
      e.tx = en[3]; e.ty = en[4]; e.tz = en[5]; e.vx = en[6]; e.vy = en[7]; e.vz = en[8];
      e.stuck = !!en[9]; e.yaw = en[10]; e.pitch = en[11];
      break;
    case 'c': if (!e.claimed) { e.tx = en[2]; e.ty = en[3]; e.tz = en[4]; e.tyaw = en[5]; e.pitch = en[6]; } e.ctrl = en[7]; break;
    case 'o': if (!e.claimed) { e.tx = en[2]; e.ty = en[3]; e.tz = en[4]; e.tyaw = en[5]; e.paddle = en[6]; } e.ctrl = en[7]; break;
    case 't': e.tx = en[2]; e.ty = en[3]; e.tz = en[4]; e.fuse = en[5]; break;
    case 'f': e.tx = en[2]; e.ty = en[3]; e.tz = en[4]; break;
    case 'y': e.tx = en[2]; e.ty = en[3]; e.tz = en[4]; break;
    case 'w': {
      e.tx = en[2]; e.ty = en[3]; e.tz = en[4]; e.tyaw = en[5]; e.pitch = en[6];
      e.health = en[7]; if (en[8] && !e.hurtTime) e.hurtTime = 10;
      e.dying = en[9]; e.healingId = en[10];
      const s = en[11];
      for (let i = 0; i < e.segs.length && i * 5 + 4 < s.length; i++) {
        const g = e.segs[i];
        g.tx = s[i * 5]; g.ty = s[i * 5 + 1]; g.tz = s[i * 5 + 2]; g.yaw = s[i * 5 + 3]; g.pitch = s[i * 5 + 4];
      }
      break;
    }
    case 'v': case 'l': e.tx = en[2]; e.ty = en[3]; e.tz = en[4]; break;
    default: break;
  }
}

// Move a stand-in toward its latest known state (guests run this every tick).
function tickMirror(e, game) {
  e.savePrev();
  e.age++;
  const k = e.netKind === 'p' && !e.stuck ? 1 : 0.35;
  if (e.netKind === 'p' && !e.stuck) {
    // keep arrows flying between snapshots
    e.x += e.vx; e.y += e.vy; e.z += e.vz; e.vy -= 0.03;
    if (e.tx !== undefined) { e.x += (e.tx - e.x) * 0.2; e.y += (e.ty - e.y) * 0.2; e.z += (e.tz - e.z) * 0.2; }
  } else if (e.tx !== undefined) {
    e.x += (e.tx - e.x) * k; e.y += (e.ty - e.y) * k; e.z += (e.tz - e.z) * k;
  }
  if (e.tyaw !== undefined) { let d = e.tyaw - e.yaw; d = Math.atan2(Math.sin(d), Math.cos(d)); e.yaw += d * 0.4; }
  if (e instanceof Mob) {
    e.pLimbAmount = e.limbAmount;
    if (e.tBodyYaw !== undefined) {
      let d = e.tBodyYaw - e.bodyYaw; d = Math.atan2(Math.sin(d), Math.cos(d));
      e.bodyYaw += d * 0.4; e.yaw = e.bodyYaw;
      e.headYaw += (e.tHeadYaw - e.headYaw) * 0.4; e.headPitch += (e.tHeadPitch - e.headPitch) * 0.4;
    }
    const moved = Math.hypot(e.x - e.px, e.z - e.pz);
    e.limbAmount += (Math.min(1, moved * 4) - e.limbAmount) * 0.4;
    e.limbSwing += moved * 2.4;
    if (e.hurtTime > 0) e.hurtTime--;
    if (e.swing > 0) e.swing--;
    if (e.dead) { e.deathTime++; if (e.deathTime >= 20) { e.removed = true; game.particles.poof(e.x, e.y, e.z, e.w, e.h); } }
    if (e.type === 'chicken') e.wingFlap = Math.abs(e.y - e.py) > 0.01 ? e.wingFlap + 0.6 : e.wingFlap * 0.7;
    if (e.fire > 0 && Math.random() < 0.4) game.particles.flame(e.x + (Math.random() - 0.5) * e.w * 2, e.y + Math.random() * e.h, e.z + (Math.random() - 0.5) * e.w * 2);
    if (e.love > 0 && e.age % 10 === 0) game.particles.heart(e.x, e.y + e.h + 0.2, e.z);
  } else if (e.isWyrm) {
    for (const s of e.segs) {
      s.px = s.x; s.py = s.y; s.pz = s.z;
      if (s.tx !== undefined) { s.x += (s.tx - s.x) * 0.4; s.y += (s.ty - s.y) * 0.4; s.z += (s.tz - s.z) * 0.4; }
    }
    if (e.hurtTime > 0) e.hurtTime--;
    e.healing = e.healingId ? game.entities.find((p) => p.netId === e.healingId) || null : null;
  } else if (e instanceof PrimedCrate) {
    if (Math.random() < 0.5) game.particles.smoke(e.x, e.y + 1.05, e.z);
  } else if (e instanceof Lightning) {
    if (--e.life <= 0) e.removed = true;
  }
}

// ---------------------------------------------------------------------------
export class NetSession {
  // role: 'host' | 'guest'; room: an open transport room
  constructor(game, room, { role, name, code, link }) {
    this.game = game; this.room = room; this.role = role; this.name = name || 'Player'; this.code = code; this.link = link;
    this.isHost = role === 'host'; this.isGuest = role === 'guest';
    this.remote = new Map(); // peer -> RemotePlayer
    this.queue = []; // outgoing emits [priority, topic, data]
    this.tokens = 20;
    this.rate = link && link.limited ? 22 : 400;
    this.lastRefill = performance.now();
    this.presenceDirty = true;
    this.closed = false;
    this.applying = false;
    this.ticks = 0;
    this.big = new Map(); // reassembly of large messages
    this.log = [];
    // host state
    this.edits = [];
    this.guestSeq = new Map(); // peer -> last processed outbox seq
    this.diffCache = new Map(); // chunk key -> Map(idx -> [id, meta])
    this.baselineWaiting = new Map(); // chunk key -> [cx, cz]
    this.diffQueue = []; // { peer, cx, cz, t }
    this.sentEntries = new Map(); // entity id -> json
    this.snapSeq = 0;
    this.controlled = new Map(); // entity id -> peer driving it
    this.welcomed = new Set();
    // guest state
    this.outbox = []; // [seq, kind, data]
    this.backlog = [];
    this.seq = 0;
    this.acked = 0;
    this.localEdits = [];
    this.mirrors = new Map(); // host entity id -> local stand-in
    this.diffPending = new Map(); // chunk key -> time requested
    this.hostPeer = null;
    this.welcome = null;
    this.helloTimer = 0;

    room.onPeers((list) => this.onPeers(list));
    if (this.isGuest) {
      room.on('wel', (d, from) => this.onBig('wel', d, from, (obj) => this.onWelcome(obj, from)));
      room.on('d', (d) => this.onDiff(d));
      room.on('b', (d) => this.onEdits(d));
      room.on('s', (d) => this.onSnapshot(d));
    }
    room.on('ev', (d, from) => this.onEvent(d, from));
    room.on('c', (d, from) => this.onChat(d, from));
  }

  get me() { return this.room.me; }
  get connected() { return this.room.connected(); }
  playerCount() { return 1 + this.remote.size; }

  // ---- outgoing ------------------------------------------------------------
  send(topic, data, priority = 1) {
    if (this.closed) return;
    this.queue.push([priority, topic, data]);
  }
  sendBig(topic, obj, to, priority = 0) {
    const s = JSON.stringify(obj);
    const id = randomId();
    // pieces small enough for a 4 KB message even after escaping
    const n = Math.max(1, Math.ceil(s.length / 2400));
    for (let i = 0; i < n; i++) this.send(topic, { to, id, i, n, s: s.slice(i * 2400, (i + 1) * 2400) }, priority);
  }
  onBig(topic, d, from, done) {
    if (!d || (d.to && d.to !== this.me)) return;
    let e = this.big.get(d.id);
    if (!e) { e = { parts: new Array(d.n), got: 0, t: Date.now() }; this.big.set(d.id, e); }
    if (e.parts[d.i] === undefined) { e.parts[d.i] = d.s; e.got++; }
    if (e.got === d.n) {
      this.big.delete(d.id);
      try { done(JSON.parse(e.parts.join(''))); } catch (err) { console.warn('bad message', err); }
    }
  }
  event(peer, data) { this.send('ev', { ...data, to: peer }, 0); }
  flush() {
    const now = performance.now();
    this.tokens = Math.min(this.rate, this.tokens + ((now - this.lastRefill) / 1000) * this.rate);
    this.lastRefill = now;
    if (!this.queue.length) return;
    this.queue.sort((a, b) => a[0] - b[0]);
    while (this.queue.length && this.tokens >= 1) {
      const [, topic, data] = this.queue.shift();
      this.tokens -= 1;
      this.room.emit(topic, data);
    }
  }

  // ---- presence --------------------------------------------------------------
  myPresence() {
    const g = this.game, p = g.player;
    // still joining: just a name and the request outbox
    if (this.isGuest && (!this.welcome || !this.inWorld)) return { bfv: NET_VERSION, r: 'g', n: this.name, o: this.outbox, x: null, f: 0 };
    let f = 0;
    if (p.sneaking) f |= 1;
    if (p.sleeping) f |= 2;
    if (p.flying) f |= 4;
    if (p.gliding) f |= 8;
    if (p.blocking) f |= 16;
    if (p.dead) f |= 32;
    if (p.creative) f |= 64;
    if (p.effects && p.effects.invisibility) f |= 128;
    if (p.spectator) f |= 256;
    if (p.vehicle) f |= 512;
    const held = p.inventory.held;
    const pr = {
      bfv: NET_VERSION, r: this.isHost ? 'h' : 'g', n: this.name,
      x: r2(p.x), y: r2(p.y), z: r2(p.z), yw: r3(p.yaw), pt: r3(p.pitch),
      h: held ? held.id : 0, a: [36, 37, 38, 39].map((i) => { const s = p.inventory.get(i); return s ? s.id : 0; }),
      sc: g.swingCount || 0, f, hp: Math.round(p.health), dm: g.dim, v: 0, vp: 0,
    };
    if (p.vehicle && p.vehicle.netId) {
      const v = p.vehicle;
      pr.v = v.netId;
      pr.vp = [r2(v.x), r2(v.y), r2(v.z), r3(v.yaw), r2(v.vx || 0), r2(v.vz || 0)];
    } else if (p.vehicle && this.isHost) pr.v = p.vehicle.id;
    if (this.isHost) {
      pr.w = { t: Math.round(g.dayTime), dy: g.day, rn: r2(g.rainTarget), th: g.thunder ? 1 : 0, wn: g.meta && g.meta.name ? String(g.meta.name).slice(0, 40) : 'World', np: this.playerCount(), code: this.code };
      const ak = [];
      for (const [peer, s] of this.guestSeq) if (this.remote.has(peer)) ak.push([peer, s]);
      pr.ak = ak;
    } else {
      pr.o = this.outbox;
    }
    return pr;
  }

  pushPresence() { this.room.presence(this.myPresence()); }

  onPeers(list) {
    const seen = new Set();
    for (const pe of list) {
      if (pe.isMe) continue;
      const pr = pe.presence || {};
      if (!pr.r) continue; // in the room but not playing yet
      seen.add(pe.peer);
      let rp = this.remote.get(pe.peer);
      if (!rp) {
        rp = new RemotePlayer(pe.peer);
        this.remote.set(pe.peer, rp);
        rp.apply(pr);
        if (this.isHost && pr.r === 'g') this.game.ui.message(`${rp.name} joined the game`, '#f2e27a');
        else if (this.isGuest && pr.r === 'g' && this.welcome) this.game.ui.message(`${rp.name} joined the game`, '#f2e27a');
      } else rp.apply(pr);
      rp.role = pr.r;
      if (pr.r === 'h') this.hostPeer = pe.peer;
      if (this.isHost && pr.r === 'g') this.readOutbox(pe.peer, rp, pr);
      if (this.isGuest && pr.r === 'h') this.readHost(pr);
    }
    for (const [peer, rp] of this.remote) {
      if (seen.has(peer)) continue;
      this.remote.delete(peer);
      this.game.ui.message(`${rp.name} left the game`, '#f2e27a');
      if (this.isHost) this.guestLeft(peer, rp);
      else if (peer === this.hostPeer) this.hostGone();
    }
  }

  remotePlayers() {
    const out = [];
    for (const rp of this.remote.values()) if (rp.placed && rp.dim === this.game.dim) out.push(rp);
    return out;
  }

  // ---- every game tick ---------------------------------------------------------
  tick() {
    if (this.closed) return;
    this.ticks++;
    for (const rp of this.remote.values()) rp.tick();
    if (this.isHost) this.hostTick();
    else this.guestTick();
    if (this.ticks % 2 === 0 || this.presenceDirty) { this.pushPresence(); this.presenceDirty = false; }
    this.flush();
    if (this.room.error && !this.reportedError) {
      this.reportedError = true;
      const code = this.room.error.code || String(this.room.error);
      if (code === 'not_permitted' && this.isHost) this.game.ui.message('Hosting needs edit or contributor access to this page.', '#ff9a8a');
      else if (code !== 'upstream_error') this.game.ui.message(`Connection problem: ${code}`, '#ff9a8a');
    }
  }

  // ==========================================================================
  // HOST
  hostTick() {
    const g = this.game;
    // keep chunks loaded around guests
    const centers = [];
    for (const rp of this.remotePlayers()) centers.push([rp.x, rp.z, 6]);
    if (g.world) g.world.extraCenters = centers;
    // vehicles guests are driving
    for (const rp of this.remote.values()) {
      if (!rp.vehicleId) continue;
      const v = g.entities.find((e) => e.id === rp.vehicleId);
      const pr = rp.lastPresence;
      if (v && pr && Array.isArray(pr.vp)) {
        v.savePrev && v.savePrev();
        v.x = pr.vp[0]; v.y = pr.vp[1]; v.z = pr.vp[2]; v.yaw = pr.vp[3]; v.vx = pr.vp[4]; v.vz = pr.vp[5];
        this.controlled.set(v.id, rp.peer);
      }
    }
    if (this.lobby && this.ticks % 100 === 1) this.advertise();
    if (this.lastDim !== g.dim && g.state === 'playing') { if (this.lastDim) this.onHostArrived(); this.lastDim = g.dim; }
    this.flushEdits();
    this.serveDiffs();
    if (this.ticks % 4 === 0) this.snapshot(this.ticks % 60 === 0);
  }

  // Changes to the host world (all of them, including quiet ones).
  onWorldChange(x, y, z, id, meta) {
    if (this.closed) return;
    const key = chunkKey(x >> 4, z >> 4);
    const cache = this.diffCache.get(key);
    if (this.isHost) {
      if (cache) cache.set((x & 15) | ((z & 15) << 4) | (y << 8), [id, meta]);
      if (this.remote.size) this.edits.push(x, y, z, id, meta);
    } else if (!this.applying) {
      this.localEdits.push(x, y, z, id, meta);
    }
  }

  flushEdits() {
    if (!this.edits.length) return;
    const e = this.edits;
    this.edits = [];
    // only edits near someone who can see them
    const near = [];
    const rps = this.remotePlayers();
    for (let i = 0; i < e.length; i += 5) {
      const x = e[i], z = e[i + 2];
      if (rps.some((rp) => Math.abs(rp.x - x) < 200 && Math.abs(rp.z - z) < 200)) near.push(e[i], e[i + 1], e[i + 2], e[i + 3], e[i + 4]);
    }
    for (let i = 0; i < near.length; i += 300) this.send('b', { dm: this.game.dim, e: near.slice(i, i + 300) }, 1);
  }

  readOutbox(peer, rp, pr) {
    rp.lastPresence = pr;
    const box = Array.isArray(pr.o) ? pr.o : [];
    let last = this.guestSeq.get(peer) || 0;
    for (const item of box) {
      if (!Array.isArray(item)) continue;
      const [seq, kind, data] = item;
      if (typeof seq !== 'number' || seq <= last) continue;
      last = seq;
      try { this.hostHandle(peer, rp, kind, data); } catch (err) { console.warn('guest request failed', kind, err); }
    }
    if (last !== (this.guestSeq.get(peer) || 0)) { this.guestSeq.set(peer, last); this.presenceDirty = true; }
  }

  hostHandle(peer, rp, kind, d) {
    const g = this.game, w = g.world;
    switch (kind) {
      case 'hi': this.sendWelcome(peer, rp, d); break;
      case 'q': // chunk diff requests
        if (Array.isArray(d)) for (let i = 0; i + 1 < d.length; i += 2) this.diffQueue.push({ peer, cx: d[i] | 0, cz: d[i + 1] | 0, t: performance.now() });
        break;
      case 'g': { // the guest changed blocks
        if (!Array.isArray(d)) break;
        for (let i = 0; i + 4 < d.length; i += 5) {
          const [x, y, z, id, meta] = [d[i] | 0, d[i + 1] | 0, d[i + 2] | 0, d[i + 3] | 0, d[i + 4] | 0];
          if (!BLOCKS[id] || y < 0 || y > 255) continue;
          if (Math.abs(x - rp.x) > 12 || Math.abs(z - rp.z) > 12) continue; // out of reach: ignore
          const key = `${x},${y},${z}`;
          const be = w.blockEntities.get(key);
          if (be && be.slots && w.getBlock(x, y, z) !== id) {
            for (const s of be.slots) if (s) g.dropItem(x + 0.5, y + 0.5, z + 0.5, s, true);
            w.blockEntities.delete(key);
            g.ui.onBlockEntityRemoved && g.ui.onBlockEntityRemoved(key);
          }
          w.setBlock(x, y, z, id, meta);
        }
        break;
      }
      case 'sp': if (Array.isArray(d)) for (const s of d) this.spawnFor(rp, s); break;
      case 'hit': this.guestHit(peer, rp, d); break;
      case 'use': this.guestUse(peer, rp, d); break;
      case 'hurt': { // one guest hit another player
        if (!d) break;
        if (d.to === this.me || !d.to) g.player.damage(g, +d.dmg || 0, 'player:' + rp.name, rp.x, rp.z);
        else this.event(d.to, { t: 'hurt', dmg: +d.dmg || 0, src: 'player:' + rp.name, fx: rp.x, fz: rp.z });
        break;
      }
      case 'open': { // container contents
        const be = w.blockEntities.get(String(d));
        if (be) this.event(peer, { t: 'be', key: String(d), be });
        break;
      }
      case 'be': { // container or sign edited by the guest
        if (!d || typeof d.key !== 'string' || !d.be) break;
        const cur = w.blockEntities.get(d.key);
        if (cur && cur.type === d.be.type) {
          if (Array.isArray(d.be.slots) && cur.slots) cur.slots = d.be.slots.map((s) => (s && ITEMS[s.id] ? s : null)).slice(0, cur.slots.length);
          if (Array.isArray(d.be.lines)) cur.lines = d.be.lines.map((l) => String(l).slice(0, 15)).slice(0, 4);
        } else if (!cur && d.be.type === 'sign') w.blockEntities.set(d.key, { type: 'sign', lines: (d.be.lines || []).map((l) => String(l).slice(0, 15)).slice(0, 4) });
        else if (!cur && d.be.slots) w.blockEntities.set(d.key, d.be);
        if (g.ui.screen && g.ui.screen.data && g.ui.screen.data.key === d.key) g.ui.refreshSlots && g.ui.refreshSlots();
        // let others see sign text
        if (d.be.type === 'sign') this.send('ev', { t: 'be', key: d.key, be: w.blockEntities.get(d.key) }, 1);
        break;
      }
      case 'claim': { const v = g.entities.find((e) => e.id === d); if (v && (v.isCart || v.isBoat)) this.controlled.set(v.id, peer); break; }
      case 'rel': {
        if (!d) break;
        const v = g.entities.find((e) => e.id === d.id);
        if (v) { v.x = +d.x; v.y = +d.y; v.z = +d.z; v.vx = +d.vx || 0; v.vz = +d.vz || 0; v.yaw = +d.yaw || 0; }
        this.controlled.delete(d.id);
        break;
      }
      case 'st': // the guest's own state, kept with the world for next time
        if (d && typeof d === 'object' && g.meta) { g.meta.players = g.meta.players || {}; g.meta.players[rp.name] = d; }
        break;
      case 'say': if (typeof d === 'string') { const text = d.slice(0, 200); this.send('c', { n: rp.name, t: text }, 0); g.ui.chatLine && g.ui.chatLine(`<${rp.name}> ${text}`); } break;
      default: break;
    }
  }

  sendWelcome(peer, rp, d) {
    const g = this.game, p = g.player;
    if (d && typeof d.n === 'string') rp.name = d.n.slice(0, 16);
    const saved = g.meta && g.meta.players ? g.meta.players[rp.name] : null;
    const spawn = p.worldSpawn || p.spawn || { x: p.x, y: p.y, z: p.z };
    this.sendBig('wel', {
      v: NET_VERSION, seed: g.meta.seed, seedText: g.meta.seedText, name: g.meta.name, mode: g.meta.mode || p.mode, dim: g.dim,
      dayTime: g.dayTime, day: g.day, rain: g.rainTarget, thunder: g.thunder,
      spawn: { x: spawn.x, y: spawn.y, z: spawn.z }, at: { x: p.x, y: p.y, z: p.z },
      voidBoss: g.meta.voidBoss || null, player: saved && saved.dim === g.dim ? saved : (saved ? { ...saved, x: undefined } : null),
    }, peer, 0);
    this.welcomed.add(peer);
    // everything they see starts fresh
    this.sentEntries.clear();
  }

  // Let people browsing for games see this one.
  advertise() {
    const g = this.game;
    this.lobby.presence({ bf: { code: this.code, wn: g.meta && g.meta.name ? String(g.meta.name).slice(0, 40) : 'World', hn: this.name, np: this.playerCount(), v: NET_VERSION } });
  }

  guestLeft(peer, rp) {
    this.guestSeq.delete(peer);
    this.welcomed.delete(peer);
    for (const [id, pe] of this.controlled) if (pe === peer) this.controlled.delete(id);
    this.diffQueue = this.diffQueue.filter((q) => q.peer !== peer);
    void rp;
  }

  // Answer chunk requests: unchanged chunks are "clean", others get their differences.
  serveDiffs() {
    const g = this.game, w = g.world;
    if (!this.diffQueue.length || !w) return;
    const clean = new Map(); // peer -> [cx, cz, ...]
    const keep = [];
    let budget = 24;
    for (const q of this.diffQueue) {
      if (budget <= 0) { keep.push(q); continue; }
      const key = chunkKey(q.cx, q.cz);
      const c = w.chunks.get(key);
      if (!c || c.state !== STATE.READY) {
        if (performance.now() - q.t < 30000) keep.push(q);
        continue;
      }
      const cache = this.diffCache.get(key);
      if (!cache && !c.modified) {
        if (!clean.has(q.peer)) clean.set(q.peer, []);
        clean.get(q.peer).push(q.cx, q.cz);
        continue;
      }
      if (!cache) {
        if (!this.baselineWaiting.has(key)) { this.baselineWaiting.set(key, [q.cx, q.cz]); w.requestBaseline(q.cx, q.cz); }
        keep.push(q);
        continue;
      }
      budget--;
      this.sendDiff(q.peer, q.cx, q.cz, cache);
    }
    this.diffQueue = keep;
    for (const [peer, list] of clean) {
      for (let i = 0; i < list.length; i += 400) this.send('d', { to: peer, dm: g.dim, cl: list.slice(i, i + 400) }, 2);
    }
  }

  // Worker result: terrain as generated; compare with the live chunk.
  onBaseline(msg) {
    const g = this.game, w = g.world;
    const key = chunkKey(msg.cx, msg.cz);
    this.baselineWaiting.delete(key);
    const c = w && w.chunks.get(key);
    if (!c || c.state !== STATE.READY) return;
    const map = new Map();
    const A = c.blocks, M = c.meta, BA = msg.blocks, BM = msg.meta;
    for (let i = 0; i < CHUNK_VOLUME; i++) if (A[i] !== BA[i] || M[i] !== BM[i]) map.set(i, [A[i], M[i]]);
    this.diffCache.set(key, map);
  }

  sendDiff(peer, cx, cz, cache) {
    const g = this.game, w = g.world;
    const entries = [...cache].map(([i, [id, meta]]) => [i, id, meta]);
    const bes = [];
    for (const [k, be] of w.blockEntities) {
      if (be.type !== 'sign') continue;
      const [x, , z] = k.split(',').map(Number);
      if (x >> 4 === cx && z >> 4 === cz) bes.push([k, be]);
    }
    const per = 450; // 2250 bytes, about 3 KB as base64
    const parts = Math.max(1, Math.ceil(entries.length / per));
    const inline = bes.length && JSON.stringify(bes).length < 600;
    for (let i = 0; i < parts; i++) {
      this.send('d', { to: peer, dm: g.dim, k: [cx, cz], p: [i, parts], e: packDiff(entries.slice(i * per, (i + 1) * per)), be: i === 0 && inline ? bes : undefined }, 2);
    }
    if (bes.length && !inline) for (const [key, be] of bes) this.event(peer, { t: 'be', key, be });
  }

  // Creatures, items and vehicles near guests. Only what changed is sent,
  // with a full refresh now and then.
  snapshot(full) {
    const g = this.game;
    const rps = this.remotePlayers();
    if (!rps.length) return;
    if (this.queue.some((q) => q[1] === 's')) return; // still sending the last one
    const near = (e) => rps.some((rp) => Math.abs(rp.x - e.x) < 96 && Math.abs(rp.z - e.z) < 96);
    const entries = [], alive = new Set();
    const consider = (e) => {
      if (e.removed || !near(e)) return;
      const en = entityEntry(e, this.controlled.get(e.id));
      if (!en) return;
      alive.add(e.id);
      const js = JSON.stringify(en);
      if (!full && this.sentEntries.get(e.id) === js) return;
      this.sentEntries.set(e.id, js);
      entries.push(en);
    };
    for (const e of g.entities) consider(e);
    for (const it of g.items) consider(it);
    const gone = [];
    for (const id of this.sentEntries.keys()) if (!alive.has(id)) { gone.push(id); this.sentEntries.delete(id); }
    if (!entries.length && !gone.length && !full) return;
    this.snapSeq++;
    // split by size (~3.3 KB each)
    const parts = [];
    let cur = [], size = 0;
    for (const en of entries) {
      const s = JSON.stringify(en).length + 1;
      if (size + s > 3300 && cur.length) { parts.push(cur); cur = []; size = 0; }
      cur.push(en); size += s;
    }
    parts.push(cur);
    parts.forEach((list, i) => this.send('s', { q: this.snapSeq, i, n: parts.length, dm: g.dim, full: full ? 1 : 0, e: list, x: i === 0 ? gone : undefined }, 3));
  }

  // A guest's attack on a creature, vehicle, pylon or the wyrm.
  guestHit(peer, rp, d) {
    const g = this.game;
    if (!d) return;
    const e = g.entities.find((x) => x.id === d.id);
    if (!e || Math.hypot(e.x - rp.x, e.z - rp.z) > 8) return;
    const dmg = Math.max(0, Math.min(40, +d.dmg || 0));
    if (e instanceof Mob) {
      if (e.hurt(g, dmg, rp.x, rp.z, 'remote:' + peer)) {
        if (d.kb) { e.vx += Math.sin(rp.yaw) * 0.5 * d.kb; e.vz -= Math.cos(rp.yaw) * 0.5 * d.kb; }
        if (d.crit) for (let i = 0; i < 6; i++) g.particles.crit(e.x, e.y + e.h * Math.random(), e.z);
        if (e.hostile) e.target = rp;
      }
    } else if (e.hit) e.hit(g, dmg, 'player');
  }

  // A guest right-clicked a creature: run it here, as if they were the player.
  guestUse(peer, rp, d) {
    const g = this.game;
    if (!d) return;
    const e = g.entities.find((x) => x.id === d.id);
    if (!e || !(e instanceof Mob) || Math.hypot(e.x - rp.x, e.z - rp.z) > 8) return;
    const stand = Object.create(g);
    stand.player = rp;
    stand.replaceHeld = (stack) => this.event(peer, { t: 'held', op: 'set', stack });
    const res = e.interact(stand, d.held ? { id: d.held, count: 1 } : null);
    if (res === 'consume') this.event(peer, { t: 'held', op: 'consume' });
    else if (res === 'damage_tool') this.event(peer, { t: 'held', op: 'damage' });
  }

  // Something a guest made (dropped items, arrows, boats...).
  spawnFor(rp, s) {
    const g = this.game;
    if (!s || typeof s !== 'object') return;
    const num = (v) => (Number.isFinite(+v) ? +v : 0);
    const x = num(s.x), y = num(s.y), z = num(s.z);
    if (Math.abs(x - rp.x) > 16 || Math.abs(z - rp.z) > 16) return;
    switch (s.k) {
      case 'i': {
        if (!s.s || !ITEMS[s.s.id]) return;
        const it = new ItemEntity(x, y, z, { ...s.s, count: Math.max(1, Math.min(64, s.s.count | 0)) });
        it.vx = num(s.vx); it.vy = num(s.vy); it.vz = num(s.vz); it.pickupDelay = s.pd | 0;
        it.droppedBy = rp.peer;
        g.items.push(it);
        break;
      }
      case 'p': {
        const kinds = ['arrow', 'egg', 'snowball', 'potion'];
        if (!kinds.includes(s.kind)) return;
        const pr = new Projectile(s.kind, x, y, z, num(s.vx), num(s.vy), num(s.vz), rp, Math.min(10, num(s.dmg) || 2));
        pr.crit = !!s.crit; pr.fire = !!s.fire; pr.item = s.item; pr.pot = s.pot;
        g.entities.push(pr);
        break;
      }
      case 'm': if (MOB_TYPES[s.type] && !MOB_TYPES[s.type].boss) g.entities.push(new Mob(s.type, x, y, z, { baby: !!s.baby })); break;
      case 'c': g.entities.push(new Minecart(x, y, z)); break;
      case 'o': g.entities.push(new Boat(x, y, z, num(s.yaw))); break;
      case 't': g.entities.push(new PrimedCrate(Math.floor(x), y, Math.floor(z), s.fuse | 0 || 80)); break;
      default: break;
    }
  }

  // Host-side: items near guests go into their pockets.
  hostPickups() {
    const g = this.game;
    for (const rp of this.remotePlayers()) {
      if (rp.dead || rp.spectator) continue;
      for (const it of g.items) {
        if (it.removed || it.pickedBy || it.pickupDelay > 0) continue;
        if (it.droppedBy === rp.peer && it.age < 40) continue;
        if (Math.abs(it.x - rp.x) < 1.3 && it.y > rp.y - 0.8 && it.y < rp.y + 2.3 && Math.abs(it.z - rp.z) < 1.3) {
          it.pickedBy = rp; it.pickupTick = 0;
          this.event(rp.peer, { t: 'give', stack: it.stack });
          g.audio.play('pop', it.x, it.y, it.z, 0.3);
        }
      }
    }
  }

  hurtRemote(rp, amount, source, fromX, fromZ) {
    if (this.isHost) this.event(rp.peer, { t: 'hurt', dmg: amount, src: source, fx: fromX, fz: fromZ });
    else this.request('hurt', { to: rp.peer, dmg: amount });
  }
  // PvP from game.attack()
  hitRemote(rp, dmg, source, fromX, fromZ) { this.hurtRemote(rp, dmg, source, fromX, fromZ); }
  giveXp(peer, n) { this.event(peer, { t: 'xp', n }); }

  hostTravel(to) {
    this.diffCache.clear(); this.baselineWaiting.clear(); this.diffQueue = []; this.sentEntries.clear(); this.controlled.clear();
    const p = this.game.player;
    this.send('ev', { t: 'travel', dim: to }, 0);
    void p;
  }
  onHostArrived() {
    const p = this.game.player;
    this.send('ev', { t: 'arrive', dim: this.game.dim, x: p.x, y: p.y, z: p.z }, 0);
  }

  // Fire-and-forget effects for everyone nearby.
  effect(kind, x, y, z, extra = {}) {
    if (!this.isHost || !this.remote.size) return;
    this.send('ev', { t: 'fx', k: kind, x: r2(x), y: r2(y), z: r2(z), ...extra }, 1);
  }

  // ==========================================================================
  // GUEST
  request(kind, data) {
    this.backlog.push([kind, data]);
  }

  guestTick() {
    const g = this.game;
    if (!this.welcome) {
      if (this.helloTimer-- <= 0 && this.hostPeer) { this.request('hi', { n: this.name, v: NET_VERSION }); this.helloTimer = 60; }
    }
    // our block edits
    if (this.localEdits.length) {
      for (let i = 0; i < this.localEdits.length; i += 300) this.request('g', this.localEdits.slice(i, i + 300));
      this.localEdits = [];
    }
    if (this.welcome && g.world) {
      this.forwardLocalEntities();
      this.retryDiffs();
    }
    // move requests into the outbox while it has room (presence is limited to 4 KB)
    this.outbox = this.outbox.filter((o) => o[0] > this.acked);
    let size = JSON.stringify(this.outbox).length;
    while (this.backlog.length) {
      const [kind, data] = this.backlog[0];
      const item = [this.seq + 1, kind, data];
      const s = JSON.stringify(item).length;
      if (size + s > 2600 && this.outbox.length) break;
      this.backlog.shift();
      this.seq++;
      this.outbox.push(item);
      size += s;
      this.presenceDirty = true;
    }
    if (this.ticks % 600 === 0 && this.welcome) this.saveState();
  }

  // Before the world loads: keep asking the host to let us in.
  connectTick() {
    if (this.closed) return;
    this.ticks++;
    if (!this.welcome && this.hostPeer && this.helloTimer-- <= 0) { this.request('hi', { n: this.name, v: NET_VERSION }); this.helloTimer = 20; }
    this.outbox = this.outbox.filter((o) => o[0] > this.acked);
    while (this.backlog.length && this.outbox.length < 4) { const [kind, data] = this.backlog.shift(); this.seq++; this.outbox.push([this.seq, kind, data]); }
    this.pushPresence();
    this.flush();
  }

  readHost(pr) {
    const g = this.game;
    if (Array.isArray(pr.ak)) for (const a of pr.ak) if (Array.isArray(a) && a[0] === this.me && a[1] > this.acked) this.acked = a[1];
    const w = pr.w;
    if (w && this.welcome && g.world) {
      if (Math.abs(w.t - g.dayTime) > 40) g.dayTime = w.t;
      g.day = w.dy; g.rainTarget = w.rn; g.thunder = w.th;
    }
  }

  onWelcome(obj, from) {
    if (this.welcome) return;
    this.welcome = obj;
    this.hostPeer = from;
    if (this.onWelcomed) this.onWelcomed(obj);
  }

  // A chunk finished generating here: ask the host what players changed in it.
  onChunkReady(c) {
    if (!this.welcome) return;
    this.diffPending.set(c.key, { cx: c.cx, cz: c.cz, t: performance.now(), sent: false });
    this.wantDiffs = true;
  }

  retryDiffs() {
    const now = performance.now();
    const ask = [];
    for (const [key, q] of this.diffPending) {
      if (!this.game.world.chunks.has(key)) { this.diffPending.delete(key); continue; }
      if (!q.sent || now - q.t > 8000) { ask.push(q.cx, q.cz); q.sent = true; q.t = now; }
      if (ask.length >= 160) break;
    }
    if (ask.length) this.request('q', ask);
  }

  onDiff(d) {
    const g = this.game;
    if (!d || d.to !== this.me || d.dm !== g.dim || !g.world) return;
    const w = g.world;
    if (Array.isArray(d.cl)) {
      for (let i = 0; i + 1 < d.cl.length; i += 2) this.diffPending.delete(chunkKey(d.cl[i], d.cl[i + 1]));
      return;
    }
    if (!Array.isArray(d.k)) return;
    const key = chunkKey(d.k[0], d.k[1]);
    const c = w.chunks.get(key);
    if (Array.isArray(d.p) && d.p[0] === d.p[1] - 1) this.diffPending.delete(key);
    if (!c || c.state !== STATE.READY) return;
    let maxY = c.maxY;
    for (const [idx, id, meta] of unpackDiff(d.e || '')) {
      if (idx >= CHUNK_VOLUME) continue;
      c.blocks[idx] = id; c.meta[idx] = meta;
      if (id && (idx >> 8) > maxY) maxY = idx >> 8;
    }
    c.maxY = maxY;
    if (Array.isArray(d.be)) for (const [k, be] of d.be) if (typeof k === 'string' && be && be.type === 'sign') w.blockEntities.set(k, be);
    w.markDirty(c, 0, 0, 0, true, true);
  }

  onEdits(d) {
    const g = this.game;
    if (!d || d.dm !== g.dim || !g.world || !Array.isArray(d.e)) return;
    const w = g.world, p = g.player;
    this.applying = true;
    try {
      for (let i = 0; i + 4 < d.e.length; i += 5) {
        const x = d.e[i], y = d.e[i + 1], z = d.e[i + 2], id = d.e[i + 3], meta = d.e[i + 4];
        const old = w.getBlock(x, y, z);
        if (!w.setBlock(x, y, z, id, meta, { notify: false })) continue;
        // sounds for what other players did nearby
        if (Math.abs(x - p.x) < 24 && Math.abs(y - p.y) < 24 && Math.abs(z - p.z) < 24) {
          if (old && !id && !isLiquid(old)) { g.audio.blockSound(old, 'break', x + 0.5, y + 0.5, z + 0.5); g.particles.blockBreak(x, y, z, old, 0); } else if (!old && id && !isLiquid(id)) g.audio.blockSound(id, 'place', x + 0.5, y + 0.5, z + 0.5);
        }
      }
    } finally { this.applying = false; }
  }

  onSnapshot(d) {
    const g = this.game;
    if (!d || d.dm !== g.dim || !this.welcome) return;
    if (Array.isArray(d.x)) for (const id of d.x) { const m = this.mirrors.get(id); if (m) { this.dropMirror(m); } }
    if (d.full && d.i === 0) this.fullSeq = d.q;
    for (const en of d.e || []) {
      if (!Array.isArray(en)) continue;
      const id = en[1];
      let m = this.mirrors.get(id);
      if (m && m.netKind !== en[0]) { this.dropMirror(m); m = null; }
      if (!m) {
        m = makeMirror(en);
        if (!m) continue;
        m.netId = id;
        this.mirrors.set(id, m);
        if (m instanceof ItemEntity) g.items.push(m); else g.entities.push(m);
      }
      if (d.full) m.fullSeq = d.q;
      updateMirror(m, en);
    }
    // after the last part of a full refresh, anything not mentioned is gone
    if (d.full && d.i === d.n - 1 && this.fullSeq === d.q) {
      for (const m of [...this.mirrors.values()]) if (m.fullSeq !== d.q) this.dropMirror(m);
    }
  }

  dropMirror(m) {
    if (m.claimed) return; // we are riding it; keep it
    if (m instanceof Mob && m.dead) return; // finishes its death animation, then goes
    m.removed = true;
    this.mirrors.delete(m.netId);
  }

  tickMirrors() {
    for (const m of this.mirrors.values()) {
      if (m.claimed) continue;
      tickMirror(m, this.game);
      if (m.removed) this.mirrors.delete(m.netId);
    }
  }

  // Entities this guest created this tick go to the host.
  forwardLocalEntities() {
    const g = this.game;
    const out = [];
    const keep = (e) => e.mirror || e.isBobber || e.isStarEye || e.isOrb || (e instanceof Projectile && e.kind === 'pearl');
    const take = (list) => list.filter((e) => {
      if (keep(e) || e.removed) return true;
      const s = this.spawnRecord(e);
      if (s) out.push(s);
      return false;
    });
    g.entities = take(g.entities);
    g.items = take(g.items);
    if (out.length) for (let i = 0; i < out.length; i += 12) this.request('sp', out.slice(i, i + 12));
  }

  spawnRecord(e) {
    const base = { x: r2(e.x), y: r2(e.y), z: r2(e.z) };
    if (e instanceof ItemEntity) return { k: 'i', ...base, vx: r2(e.vx), vy: r2(e.vy), vz: r2(e.vz), s: e.stack, pd: e.pickupDelay };
    if (e instanceof Projectile) return { k: 'p', ...base, kind: e.kind, vx: r3(e.vx), vy: r3(e.vy), vz: r3(e.vz), dmg: e.damage, crit: e.crit ? 1 : 0, fire: e.fire ? 1 : 0, item: e.item, pot: e.pot };
    if (e instanceof Mob) return { k: 'm', ...base, type: e.type, baby: e.baby ? 1 : 0 };
    if (e.isCart) return { k: 'c', ...base };
    if (e.isBoat) return { k: 'o', ...base, yaw: r3(e.yaw) };
    if (e instanceof PrimedCrate) return { k: 't', ...base, fuse: e.fuse };
    return null;
  }

  // Guest attacks a stand-in: the host applies it.
  hitMirror(e, dmg, kb, crit) { this.request('hit', { id: e.netId, dmg, kb, crit: crit ? 1 : 0 }); }
  useMirror(e, held) {
    if (!(e instanceof Mob)) return false;
    if (e.def.villager) return false; // trading happens here
    if (e.type === 'cow' && held && held.id === I.bucket) return false;
    this.request('use', { id: e.netId, held: held ? held.id : 0 });
    return true;
  }
  claimVehicle(v) { if (v.mirror) { v.claimed = true; this.request('claim', v.netId); } }
  releaseVehicle(v) {
    if (!v || !v.mirror || !v.claimed) return;
    v.claimed = false;
    this.request('rel', { id: v.netId, x: r2(v.x), y: r2(v.y), z: r2(v.z), vx: r3(v.vx || 0), vz: r3(v.vz || 0), yaw: r3(v.yaw) });
  }

  blockEntityChanged(key) {
    if (!this.game.world) return;
    const be = this.game.world.blockEntities.get(key);
    if (!be) return;
    if (this.isGuest) {
      // coalesce rapid slot edits into one update
      this.backlog = this.backlog.filter((b) => !(b[0] === 'be' && b[1].key === key));
      this.request('be', { key, be: JSON.parse(JSON.stringify(be)) });
    } else this.send('ev', { t: 'be', key, be }, 1);
  }
  openedContainer(key) { if (this.isGuest) this.request('open', key); }

  saveState() {
    if (!this.isGuest) return;
    const st = this.game.player.toJSON();
    st.dim = this.game.dim;
    // keep it small enough for the outbox
    const s = JSON.stringify(st);
    if (s.length < 2400) this.request('st', st);
  }

  hostGone() {
    if (this.closed) return;
    this.game.ui.message('The host closed the world.', '#ff9a8a');
    if (this.onHostGone) this.onHostGone();
  }

  // ---- events and chat ---------------------------------------------------------
  onEvent(d, from) {
    const g = this.game;
    if (!d || (d.to && d.to !== this.me)) return;
    if (this.isGuest && from !== this.hostPeer && this.hostPeer) return;
    const p = g.player;
    switch (d.t) {
      case 'give': {
        if (!d.stack || !ITEMS[d.stack.id]) break;
        const left = p.inventory.give({ ...d.stack });
        g.audio.play('pop', p.x, p.y + 1, p.z, 0.4);
        g.onPickup && g.onPickup(d.stack.id);
        if (left) g.dropItem(p.x, p.y + 1, p.z, { ...d.stack, count: left });
        break;
      }
      case 'xp': p.addXp(g, d.n | 0); break;
      case 'hurt': p.damage(g, +d.dmg || 0, d.src || 'mob', d.fx, d.fz); break;
      case 'pot': if (d.fx) p.applyPotion(g, d.fx, +d.sc || 1); break;
      case 'held': {
        const h = p.inventory.held;
        if (d.op === 'set' && d.stack && ITEMS[d.stack.id]) g.replaceHeld({ ...d.stack });
        else if (d.op === 'consume' && h && !p.creative) p.inventory.useHeld();
        else if (d.op === 'damage' && h) g.damageTool(1);
        break;
      }
      case 'be': {
        if (typeof d.key !== 'string' || !d.be || !g.world) break;
        const cur = g.world.blockEntities.get(d.key);
        if (cur) Object.assign(cur, d.be); else g.world.blockEntities.set(d.key, d.be);
        if (g.ui.screen && g.ui.screen.data && g.ui.screen.data.key === d.key) {
          if (g.ui.screen.data.be && g.ui.screen.data.be !== cur) Object.assign(g.ui.screen.data.be, d.be);
          g.ui.refreshSlots && g.ui.refreshSlots();
        }
        break;
      }
      case 'fx':
        if (d.k === 'boom') { g.particles.explosion(d.x, d.y, d.z); g.audio.play('explode', d.x, d.y, d.z); g.shake = Math.max(g.shake || 0, Math.max(0, 1 - Math.hypot(d.x - p.x, d.z - p.z) / 24)); }
        else if (d.k === 'note' && g.playNote) g.particles.note(d.x, d.y + 1.2, d.z, d.pitch | 0);
        break;
      case 'travel': if (this.isGuest) { this.travelling = d.dim; g.ui.message('The host is travelling…', '#c8b8f0'); } break;
      case 'arrive': if (this.isGuest && this.onHostTravel) this.onHostTravel(d); break;
      case 'tp': p.x = p.px = +d.x; p.y = p.py = +d.y; p.z = p.pz = +d.z; break;
      case 'msg': g.ui.message(String(d.text || '').slice(0, 200), d.color || '#f2e27a'); break;
      case 'bye': this.hostGone(); break;
      default: break;
    }
  }

  say(text) {
    const t = String(text).slice(0, 200);
    if (this.isHost) { this.send('c', { n: this.name, t }, 0); this.game.ui.chatLine && this.game.ui.chatLine(`<${this.name}> ${t}`); } else this.request('say', t);
  }
  onChat(d, from) {
    if (!d || typeof d.t !== 'string') return;
    if (this.isGuest && from !== this.hostPeer) return;
    this.game.ui.chatLine && this.game.ui.chatLine(`<${String(d.n || 'Player').slice(0, 16)}> ${d.t.slice(0, 200)}`);
  }

  close() {
    if (this.closed) return;
    if (this.lobby) { try { this.lobby.close(); } catch { /* closed */ } this.lobby = null; }
    if (this.isHost) { this.room.emit('ev', { t: 'bye' }); }
    else this.saveState();
    try { this.pushPresence(); } catch { /* closing */ }
    this.closed = true;
    setTimeout(() => this.room.close(), 300);
    if (this.game.world) this.game.world.extraCenters = [];
  }
}

// Players (local first) and helpers the game uses for targeting and spawning.
export function installNet(Game) {
  Game.prototype.remotePlayers = function remotePlayers() { return this.net ? this.net.remotePlayers() : []; };
  Game.prototype.players = function players() {
    const out = [this.player];
    if (this.net && this.net.isHost) for (const rp of this.net.remotePlayers()) out.push(rp);
    return out;
  };
  // The player a creature at e should pay attention to: the nearest living one.
  Game.prototype.focusPlayer = function focusPlayer(e) {
    if (!this.net || !this.net.isHost) return this.player;
    let best = this.player, bd = this.player.dead ? Infinity : (this.player.x - e.x) ** 2 + (this.player.z - e.z) ** 2;
    for (const rp of this.net.remotePlayers()) {
      if (rp.dead || rp.spectator) continue;
      const d = (rp.x - e.x) ** 2 + (rp.z - e.z) ** 2;
      if (d < bd) { bd = d; best = rp; }
    }
    return best;
  };
  Game.prototype.nearestPlayerDist = function nearestPlayerDist(x, z) {
    let bd = Math.hypot(this.player.x - x, this.player.z - z);
    if (this.net && this.net.isHost) for (const rp of this.net.remotePlayers()) bd = Math.min(bd, Math.hypot(rp.x - x, rp.z - z));
    return bd;
  };
}
