// Online play between friends anywhere: each guest opens a WebRTC data
// channel straight to the host, and the host's page passes messages between
// everyone (the same protocol tools/relay.mjs speaks), so NetSession sees an
// ordinary room.
//
// The two browsers still have to find each other once. With a room code they
// meet through public MQTT brokers: the code derives both the meeting topic
// and an AES key, so the brokers (and anyone listening there) see only
// ciphertext on a topic that does not reveal the code. Where no broker can be
// reached, friends swap a "join request" and a "reply" by copy and paste
// instead; that needs no server at all.

const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];
const DEFAULT_BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081/mqtt'];
let brokers = DEFAULT_BROKERS;
// tests point this at a local broker
export function setBrokers(list) { brokers = list && list.length ? list.slice() : DEFAULT_BROKERS; }

const te = new TextEncoder(), td = new TextDecoder();
// set globalThis.__bfNetDebug = true to watch connections in the console
const debug = (...a) => { if (globalThis.__bfNetDebug) console.log('online:', ...a); };
function watch(pc, who) {
  pc.addEventListener('connectionstatechange', () => debug(who, 'connection', pc.connectionState));
  pc.addEventListener('iceconnectionstatechange', () => debug(who, 'ice', pc.iceConnectionState));
}
const rid = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
const CODE_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
export const ONLINE_CODE_LENGTH = 8;

export class OnlineError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

function withTimeout(p, ms, err) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(err), ms); })]).finally(() => clearTimeout(t));
}

// ---------------------------------------------------------------------------
// A minimal MQTT 3.1.1 client over WebSocket: connect, subscribe and publish
// at QoS 0, which is all a handshake needs.

function mqttString(s) { const b = te.encode(s); const o = new Uint8Array(b.length + 2); o[0] = b.length >> 8; o[1] = b.length & 255; o.set(b, 2); return o; }
function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const o = new Uint8Array(n);
  let k = 0;
  for (const p of parts) { o.set(p, k); k += p.length; }
  return o;
}
function mqttPacket(type, parts) {
  const body = concat(parts);
  const head = [type];
  let x = body.length;
  do { let d = x % 128; x = Math.floor(x / 128); if (x > 0) d |= 128; head.push(d); } while (x > 0);
  return concat([Uint8Array.from(head), body]);
}

class Mqtt {
  constructor(url) {
    this.url = url; this.ready = false; this.closed = false; this.buf = new Uint8Array(0);
    this.onMessage = null; this.onClose = null; this.pid = 1; this.acks = new Map();
  }
  connect(ms = 7000) {
    return new Promise((res) => {
      let done = false;
      const finish = (ok) => { if (done) return; done = true; clearTimeout(t); if (!ok) this.close(); res(ok); };
      const t = setTimeout(() => finish(false), ms);
      try { this.ws = new WebSocket(this.url, ['mqtt']); } catch { finish(false); return; }
      this.ws.binaryType = 'arraybuffer';
      this.ws.onopen = () => {
        const id = 'bf' + rid().slice(0, 18);
        this.raw(mqttPacket(0x10, [mqttString('MQTT'), Uint8Array.from([4, 0x02, 0, 60]), mqttString(id)]));
      };
      this.ws.onmessage = (e) => this.feed(new Uint8Array(e.data), finish);
      this.ws.onerror = () => finish(false);
      this.ws.onclose = () => {
        const was = this.ready;
        this.ready = false; this.closed = true; clearInterval(this.ping);
        finish(false);
        if (was && this.onClose) this.onClose();
      };
    });
  }
  raw(bytes) { if (this.ws && this.ws.readyState === 1) this.ws.send(bytes); }
  feed(chunk, finish) {
    this.buf = this.buf.length ? concat([this.buf, chunk]) : chunk;
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      let len = 0, mul = 1, i = 1;
      for (;;) {
        if (i >= b.length) return;
        const d = b[i++];
        len += (d & 127) * mul; mul *= 128;
        if (!(d & 128)) break;
        if (i > 4) { this.close(); return; }
      }
      if (b.length < i + len) return;
      const type = b[0] >> 4, flags = b[0] & 15, body = b.subarray(i, i + len);
      this.buf = b.subarray(i + len);
      if (type === 2) { // CONNACK
        if (body[1] === 0) {
          this.ready = true;
          this.ping = setInterval(() => this.raw(Uint8Array.from([0xc0, 0])), 25000);
          finish(true);
        } else finish(false);
      } else if (type === 3) { // PUBLISH
        const tl = (body[0] << 8) | body[1];
        const topic = td.decode(body.subarray(2, 2 + tl));
        const qos = (flags >> 1) & 3;
        const payload = body.subarray(2 + tl + (qos ? 2 : 0));
        if (this.onMessage) this.onMessage(topic, payload.slice());
      } else if (type === 9) { // SUBACK
        const id = (body[0] << 8) | body[1];
        const f = this.acks.get(id);
        if (f) { this.acks.delete(id); f(body[2] !== 0x80); }
      }
    }
  }
  subscribe(topic) {
    return new Promise((res) => {
      const id = this.pid++ & 0xffff || 1;
      this.acks.set(id, res);
      setTimeout(() => { if (this.acks.delete(id)) res(false); }, 5000);
      this.raw(mqttPacket(0x82, [Uint8Array.from([id >> 8, id & 255]), mqttString(topic), Uint8Array.from([0])]));
    });
  }
  publish(topic, payload) { this.raw(mqttPacket(0x30, [mqttString(topic), payload])); }
  close() {
    if (this.closed && !this.ws) return;
    this.closed = true; this.ready = false; clearInterval(this.ping);
    try { if (this.ws && this.ws.readyState === 1) this.ws.send(Uint8Array.from([0xe0, 0])); } catch { /* gone */ }
    try { if (this.ws) this.ws.close(); } catch { /* gone */ }
  }
}

// Every reachable broker at once: what one drops, another carries.
class Signal {
  // retry: keep trying brokers that drop or never answer (a host stays open for hours)
  constructor(list, retry = false) { this.list = list; this.retry = retry; this.clients = []; this.subs = new Map(); this.seen = new Set(); this.closed = false; }
  // resolves true as soon as one broker is connected, false if none answer
  start(ms = 7000) {
    return new Promise((res) => {
      let left = this.list.length, done = false;
      if (!left) { res(false); return; }
      for (const url of this.list) this.add(url, ms).then((ok) => {
        left--;
        if (ok && !done) { done = true; res(true); } else if (!left && !done) { done = true; res(false); }
      });
    });
  }
  async add(url, ms) {
    const c = new Mqtt(url);
    c.onMessage = (topic, payload) => {
      const fn = this.subs.get(topic);
      if (fn) fn(payload);
    };
    const again = (wait) => { if (this.retry && !this.closed) setTimeout(() => { if (!this.closed) this.add(url, ms); }, wait); };
    const ok = await c.connect(ms);
    if (!ok || this.closed) { c.close(); again(60000); return false; }
    this.clients.push(c);
    c.onClose = () => {
      this.clients = this.clients.filter((x) => x !== c);
      again(5000);
    };
    for (const topic of this.subs.keys()) c.subscribe(topic);
    return true;
  }
  get online() { return this.clients.length > 0; }
  // resolves once at least one broker confirms the subscription
  async subscribe(topic, fn) {
    this.subs.set(topic, (payload) => {
      // the same message arrives once per broker
      const k = payload.length + ':' + payload.slice(0, 28).join(',');
      if (this.seen.has(k)) return;
      this.seen.add(k);
      if (this.seen.size > 300) this.seen.clear();
      fn(payload);
    });
    const r = await Promise.all(this.clients.map((c) => c.subscribe(topic)));
    return r.some(Boolean);
  }
  publish(topic, payload) { for (const c of this.clients) c.publish(topic, payload); }
  close() { this.closed = true; for (const c of this.clients) c.close(); this.clients = []; }
}

// ---------------------------------------------------------------------------
// The room code becomes a meeting topic and an encryption key. PBKDF2 makes
// guessing codes from the topic far too slow to be worth it.

async function codeSecrets(code) {
  const subtle = globalThis.crypto && crypto.subtle;
  if (!subtle) {
    // no WebCrypto (an insecure page): meet in the clear
    let h = 2166136261;
    for (const ch of 'bf:' + code) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
    return { topic: 'blockforge/v1/plain/' + h.toString(16) + code.length, key: null };
  }
  const base = await subtle.importKey('raw', te.encode('blockforge:' + code), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', salt: te.encode('blockforge-signal-v1'), iterations: 60000, hash: 'SHA-256' }, base, 384));
  const key = await subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const topic = 'blockforge/v1/' + [...bits.slice(32, 48)].map((v) => v.toString(16).padStart(2, '0')).join('');
  return { topic, key };
}
async function seal(key, obj) {
  const plain = te.encode(JSON.stringify(obj));
  if (!key) return plain;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  return concat([iv, ct]);
}
async function unseal(key, bytes) {
  try {
    const plain = key ? new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, key, bytes.subarray(12))) : bytes;
    return JSON.parse(td.decode(plain));
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Copy-and-paste codes for the serverless handshake.

function b64url(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const o = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i);
  return o;
}
async function pipeBytes(bytes, stream) {
  const s = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function packText(prefix, obj) {
  const bytes = te.encode(JSON.stringify(obj));
  if (typeof CompressionStream === 'function') return `${prefix}z${b64url(await pipeBytes(bytes, new CompressionStream('deflate-raw')))}`;
  return `${prefix}j${b64url(bytes)}`;
}
async function unpackText(prefix, text) {
  const s = String(text || '').replace(/\s+/g, '');
  const at = s.indexOf(prefix);
  if (at < 0) return null;
  const body = s.slice(at + prefix.length);
  try {
    let bytes = unb64url(body.slice(1));
    if (body[0] === 'z') bytes = await pipeBytes(bytes, new DecompressionStream('deflate-raw'));
    return JSON.parse(td.decode(bytes));
  } catch { return null; }
}
const REQUEST = 'BFJOIN1.', REPLY = 'BFREPLY1.';

// ---------------------------------------------------------------------------
// WebRTC helpers. Candidates are gathered up front so a whole description
// travels in one message (or one pasted code).

function gathered(pc, ms = 4000) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((res) => {
    const t = setTimeout(res, ms);
    pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
  });
}
// Once descriptions are swapped: wait for the host's welcome while the
// connection is still trying, and give up when it fails.
function arrived(room, pc) {
  return new Promise((res, rej) => {
    const fail = () => { clearTimeout(t); try { pc.close(); } catch { /* closed */ } rej(new OnlineError('no_route', NO_ROUTE)); };
    const t = setTimeout(fail, 40000);
    room.ready.then(() => { clearTimeout(t); res(room); });
    pc.addEventListener('connectionstatechange', () => { if (pc.connectionState === 'failed') fail(); });
  });
}
async function makeOffer() {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  watch(pc, 'guest');
  const ch = pc.createDataChannel('blockforge', { ordered: true });
  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc);
  return { pc, ch, sdp: pc.localDescription.sdp };
}

// ---------------------------------------------------------------------------
// Rooms. The guest's side speaks to the host like a relay client.

class PipeRoom {
  constructor() {
    this.handlers = new Map(); this.peerMap = new Map(); this.peerFns = []; this.mine = {}; this.me = null; this.closed = false;
    this.ready = new Promise((res) => { this.readyNow = res; });
  }
  receive(text) {
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (!m) return;
    if (m.k === 'joined') {
      this.me = m.you;
      for (const p of m.peers || []) this.peerMap.set(p.id, p.presence || {});
      this.readyNow(); this.changed();
      return;
    }
    if (m.k === 'p') { this.peerMap.set(m.from, m.p || {}); this.changed(); } else if (m.k === 'left') { this.peerMap.delete(m.from); this.changed(); } else if (m.k === 'e') { const fns = this.handlers.get(m.t); if (fns) for (const f of fns) f(m.d, m.from); }
  }
  lost() { if (this.closed) return; this.closed = true; this.peerMap.clear(); this.changed(); }
  changed() { const list = this.peers(); for (const f of this.peerFns) f(list); }
  emit(topic, data) { this.send({ k: 'e', t: topic, d: data }); return Promise.resolve(); }
  on(topic, fn) { if (!this.handlers.has(topic)) this.handlers.set(topic, []); this.handlers.get(topic).push(fn); }
  presence(obj) { this.mine = obj; this.send({ k: 'p', p: obj }); return Promise.resolve(); }
  peers() { return [{ peer: this.me, isMe: true, presence: this.mine }, ...[...this.peerMap].map(([peer, p]) => ({ peer, isMe: false, presence: p }))]; }
  onPeers(fn) { this.peerFns.push(fn); }
}

class ChannelClientRoom extends PipeRoom {
  constructor(pc, ch) {
    super();
    this.pc = pc; this.ch = ch;
    ch.onmessage = (e) => this.receive(e.data);
    ch.onclose = () => this.lost();
    pc.addEventListener('connectionstatechange', () => { if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.lost(); });
  }
  send(m) { if (this.ch.readyState === 'open') this.ch.send(JSON.stringify(m)); }
  connected() { return !this.closed && this.ch.readyState === 'open'; }
  close() { this.closed = true; try { this.ch.close(); } catch { /* closed */ } try { this.pc.close(); } catch { /* closed */ } }
}

// The host: a relay living in its own page.
class HubRoom {
  constructor(code) {
    this.code = code; this.me = 'h' + rid(); this.handlers = new Map(); this.guests = new Map(); this.pending = new Map();
    this.peerFns = []; this.mine = {}; this.closed = false; this.dropped = 0;
    this.signalState = 'connecting'; this.signal = null; this.onSignal = null;
  }
  // a guest's offer (from a broker or a pasted request) -> our answer
  async answer(gid, sdp) {
    if (this.closed) throw new OnlineError('closed', 'This world is no longer open.');
    if (typeof gid !== 'string' || !/^[a-z0-9]{6,24}$/.test(gid) || typeof sdp !== 'string' || sdp.length > 20000) throw new OnlineError('bad', 'That join request is damaged.');
    if (this.pending.has(gid)) return this.pending.get(gid);
    if (this.guests.has(gid)) throw new OnlineError('dup', 'That friend is already here.');
    const job = (async () => {
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      watch(pc, 'host<-' + gid);
      debug('offer from', gid, (sdp.match(/a=candidate.*/g) || []).length, 'candidates');
      pc.ondatachannel = (e) => this.attach(gid, pc, e.channel);
      // give up on friends that never arrive
      setTimeout(() => { if (!this.guests.has(gid)) { this.pending.delete(gid); try { pc.close(); } catch { /* closed */ } } }, 10 * 60000);
      await pc.setRemoteDescription({ type: 'offer', sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      await gathered(pc);
      return pc.localDescription.sdp;
    })();
    this.pending.set(gid, job);
    job.catch(() => this.pending.delete(gid));
    return job;
  }
  attach(id, pc, ch) {
    debug('channel from', id, ch.readyState);
    const g = { pc, ch, presence: {} };
    const hello = () => {
      if (this.closed) return;
      debug('welcome', id);
      this.guests.set(id, g);
      this.pending.delete(id);
      this.raw(g, JSON.stringify({ k: 'joined', you: id, peers: [{ id: this.me, presence: this.mine }, ...[...this.guests].filter(([k]) => k !== id).map(([k, o]) => ({ id: k, presence: o.presence }))] }));
      this.changed();
    };
    ch.onmessage = (e) => this.receive(id, e.data);
    ch.onclose = () => this.drop(id);
    pc.addEventListener('connectionstatechange', () => { if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.drop(id); });
    if (ch.readyState === 'open') hello(); else ch.onopen = hello;
  }
  receive(id, text) {
    const g = this.guests.get(id);
    if (!g || typeof text !== 'string' || text.length > 300000) return;
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (!m) return;
    if (m.k === 'p') {
      const p = m.p && typeof m.p === 'object' && !Array.isArray(m.p) ? m.p : {};
      // only the host speaks for the world
      if (p.r === 'h') p.r = 'g';
      delete p.w;
      g.presence = p;
      this.others(id, { k: 'p', from: id, p });
      this.changed();
    } else if (m.k === 'e' && typeof m.t === 'string') {
      // guests ask through their presence; an event from one goes to the host only
      const fns = this.handlers.get(m.t);
      if (fns) for (const f of fns) f(m.d, id);
    }
  }
  drop(id) {
    const g = this.guests.get(id);
    if (!g) return;
    this.guests.delete(id);
    try { g.ch.close(); } catch { /* closed */ }
    try { g.pc.close(); } catch { /* closed */ }
    this.others(id, { k: 'left', from: id });
    this.changed();
  }
  raw(g, s) {
    // a guest that cannot keep up loses messages rather than the host's memory
    if (g.ch.readyState !== 'open') return;
    if (g.ch.bufferedAmount > 8e6) { this.dropped++; return; }
    try { g.ch.send(s); } catch { this.dropped++; }
  }
  others(except, msg) {
    const s = JSON.stringify(msg);
    for (const [id, g] of this.guests) if (id !== except) this.raw(g, s);
  }
  changed() { const list = this.peers(); for (const f of this.peerFns) f(list); }
  emit(topic, data) { this.others(null, { k: 'e', from: this.me, t: topic, d: data }); return Promise.resolve(); }
  on(topic, fn) { if (!this.handlers.has(topic)) this.handlers.set(topic, []); this.handlers.get(topic).push(fn); }
  presence(obj) { this.mine = obj; this.others(null, { k: 'p', from: this.me, p: obj }); return Promise.resolve(); }
  peers() { return [{ peer: this.me, isMe: true, presence: this.mine }, ...[...this.guests].map(([peer, g]) => ({ peer, isMe: false, presence: g.presence }))]; }
  onPeers(fn) { this.peerFns.push(fn); }
  connected() { return !this.closed; }
  close() {
    this.closed = true;
    if (this.signal) this.signal.close();
    for (const id of [...this.guests.keys()]) this.drop(id);
  }
  setSignal(state) { this.signalState = state; if (this.onSignal) this.onSignal(state); }
}

// Wait on the brokers for guests knocking with this room's code.
async function listen(hub) {
  const { topic, key } = await codeSecrets(hub.code);
  const sig = new Signal(brokers, true);
  hub.signal = sig;
  if (hub.closed) { sig.close(); return; }
  const ok = await sig.start();
  if (hub.closed) { sig.close(); return; }
  await sig.subscribe(topic + '/h', async (bytes) => {
    const m = await unseal(key, bytes);
    if (!m || m.t !== 'offer') return;
    try {
      const sdp = await hub.answer(m.g, m.sdp);
      sig.publish(topic + '/g/' + m.g, await seal(key, { t: 'answer', sdp, n: rid() }));
    } catch (e) { console.warn('online: could not answer a guest', e); }
  });
  hub.setSignal(ok ? 'online' : 'offline');
  // a broker that comes up later still counts
  if (!ok) {
    const check = setInterval(() => {
      if (hub.closed) { clearInterval(check); return; }
      if (sig.online) { clearInterval(check); hub.setSignal('online'); }
    }, 2000);
  }
}

const NO_ANSWER = 'No world answered with that code. Check the code, and that your friend still has their world open to friends.';
const NO_ROUTE = 'Found your friend\'s world, but your two networks would not connect directly (some school, work and mobile networks block it). Try another network, or play through a relay server.';

export class OnlineLink {
  constructor() { this.kind = 'online'; this.label = 'Online — friends anywhere'; this.limited = false; }
  static create() { return typeof RTCPeerConnection === 'function' && typeof WebSocket === 'function' ? new OnlineLink() : null; }
  makeCode() {
    const r = crypto.getRandomValues(new Uint8Array(ONLINE_CODE_LENGTH));
    return [...r].map((v) => CODE_CHARS[v % CODE_CHARS.length]).join('');
  }
  accepts(code) { return code.length === ONLINE_CODE_LENGTH; }
  async open() { return null; } // no lobby to browse online
  async hostRoom(code) {
    const hub = new HubRoom(code);
    listen(hub).catch((e) => { console.warn('online: matchmaking failed', e); hub.setSignal('offline'); });
    return hub;
  }
  // Join with a room code, meeting the host through the brokers.
  async joinRoom(code, onStatus = () => {}) {
    onStatus('Reaching the matchmaking servers…');
    const secrets = codeSecrets(code);
    const sig = new Signal(brokers);
    let pc = null;
    try {
      if (!await sig.start()) throw new OnlineError('offline', 'Could not reach the online matchmaking servers from here. Use "Join with a request" below instead: it needs no server.');
      const { topic, key } = await secrets;
      const gid = rid();
      onStatus('Looking for the world…');
      const offer = await makeOffer();
      pc = offer.pc;
      let gotAnswer;
      const answered = new Promise((res) => { gotAnswer = res; });
      await sig.subscribe(topic + '/g/' + gid, async (bytes) => {
        const m = await unseal(key, bytes);
        if (m && m.t === 'answer' && typeof m.sdp === 'string') gotAnswer(m.sdp);
      });
      const msg = await seal(key, { t: 'offer', g: gid, sdp: offer.sdp, n: rid() });
      sig.publish(topic + '/h', msg);
      const again = setInterval(() => sig.publish(topic + '/h', msg), 3000);
      let sdp;
      try { sdp = await withTimeout(answered, 14000, new OnlineError('no_host', NO_ANSWER)); } finally { clearInterval(again); }
      onStatus('Connecting to your friend…');
      debug('answer', (sdp.match(/a=candidate.*/g) || []).length, 'candidates');
      await pc.setRemoteDescription({ type: 'answer', sdp });
      return await arrived(new ChannelClientRoom(pc, offer.ch), pc);
    } catch (e) {
      if (pc) try { pc.close(); } catch { /* closed */ }
      throw e;
    } finally { sig.close(); }
  }
  // The serverless way: the guest makes a request to paste to the host...
  async makeRequest() {
    const offer = await makeOffer();
    const gid = rid();
    const text = await packText(REQUEST, { g: gid, sdp: offer.sdp });
    return {
      text,
      // ...and connects with the reply the host pastes back
      finish: async (reply) => {
        const m = await unpackText(REPLY, reply);
        if (!m || typeof m.sdp !== 'string') throw new OnlineError('bad', 'That does not look like a reply code. Ask your friend to copy the whole reply.');
        if (m.g && m.g !== gid) throw new OnlineError('bad', 'That reply was made for a different join request.');
        await offer.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
        return arrived(new ChannelClientRoom(offer.pc, offer.ch), offer.pc);
      },
      cancel: () => { try { offer.pc.close(); } catch { /* closed */ } },
    };
  }
  // ...and the host turns a pasted request into a reply.
  async acceptRequest(hub, text) {
    const m = await unpackText(REQUEST, text);
    if (!m || typeof m.sdp !== 'string') throw new OnlineError('bad', 'That does not look like a join request. Ask your friend to copy the whole request.');
    const sdp = await hub.answer(m.g, m.sdp);
    return packText(REPLY, { g: m.g, sdp });
  }
}

export const isHubRoom = (room) => room instanceof HubRoom;
