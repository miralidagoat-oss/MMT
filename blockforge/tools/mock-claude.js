// A stand-in for the claude.ai page runtime, injected into test pages before
// the game loads. It follows the documented `room` contract closely enough
// to catch the mistakes that matter: events and presence over 4 KiB are
// refused, presence MERGES field by field (null removes a field), events
// and presence share a budget of about 40 a second (events past it are
// dropped), your own events come back to you marked sameTab, viewers may
// only set presence (events need admin, or a topic opened to "interact",
// which viewers are below), and named rooms are separate. Tabs of one
// browser talk over BroadcastChannel. Also offers `downloads`.
//
// Configure before load: window.__mockRole = 'admin' | 'interact' | 'viewer'
(() => {
  const OPEN_TOPICS = { wel: 'interact', d: 'interact', b: 'interact', s: 'interact', ev: 'interact', c: 'interact' };
  const LEVEL = { viewer: 0, interact: 1, admin: 2 };
  const enc = new TextEncoder();
  const bytes = (v) => enc.encode(JSON.stringify(v)).length;
  const err = (code, message) => Object.assign(new Error(message), { code });
  const me = Math.random().toString(36).slice(2, 12);
  const role = () => window.__mockRole || 'admin';
  const stats = (window.__mockStats = { refused: 0, dropped: 0, sent: 0, presence: 0 });
  // one shared budget: 40 a second, bursts of 80
  let tokens = 80, last = performance.now();
  const take = () => {
    const now = performance.now();
    tokens = Math.min(80, tokens + ((now - last) / 1000) * 40); last = now;
    if (tokens < 1) return false;
    tokens -= 1; return true;
  };

  function makeRoom(name) {
    const ch = new BroadcastChannel('mockclaude:' + name);
    const handlers = new Map(); // topic -> Set(fn)
    const peerFns = new Set();
    const others = new Map(); // peer -> { presence, seen, updatedAt }
    let mine = {}, snapshot = Object.freeze([]), pending = { joined: [], left: [], updated: [] }, scheduled = false, first = true;
    let left = false, presenceTimer = null;
    const peerObj = (peer, presence, updatedAt) => Object.freeze({ peer, by: null, isMe: peer === me, sameTab: peer === me, kind: 'viewer', guest: false, presence: Object.freeze({ ...presence }), updatedAt });
    const rebuild = () => {
      snapshot = Object.freeze([peerObj(me, mine, Date.now()), ...[...others].map(([p, o]) => peerObj(p, o.presence, o.updatedAt))]);
    };
    const changed = (kind, peer) => {
      rebuild();
      const p = snapshot.find((x) => x.peer === peer) || peerObj(peer, {}, Date.now());
      pending[kind].push(p);
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        const change = { peers: snapshot, joined: first ? snapshot.slice() : pending.joined, left: pending.left, updated: pending.updated };
        first = false;
        pending = { joined: [], left: [], updated: [] };
        for (const f of peerFns) f(change);
      }, 16);
    };
    const post = (m) => { if (!left) { m.from = me; ch.postMessage(m); } };
    ch.onmessage = (e) => {
      const m = e.data;
      if (!m || m.from === me) return;
      if (m.k === 'hello') { post({ k: 'p', p: mine }); return; }
      if (m.k === 'p') {
        const had = others.has(m.from);
        others.set(m.from, { presence: m.p || {}, seen: Date.now(), updatedAt: Date.now() });
        changed(had ? 'updated' : 'joined', m.from);
        return;
      }
      if (m.k === 'beat') { const o = others.get(m.from); if (o) o.seen = Date.now(); else { others.set(m.from, { presence: m.p || {}, seen: Date.now(), updatedAt: Date.now() }); changed('joined', m.from); } return; }
      if (m.k === 'bye') { if (others.delete(m.from)) changed('left', m.from); return; }
      if (m.k === 'e') {
        const fns = handlers.get(m.t);
        if (fns) for (const f of fns) f(Object.freeze({ topic: m.t, data: m.d, peer: m.from, by: null, isMe: false, sameTab: false, kind: 'viewer', guest: false }));
      }
    };
    const beat = setInterval(() => {
      post({ k: 'beat', p: mine });
      const now = Date.now();
      for (const [p, o] of others) if (now - o.seen > 20000) { others.delete(p); changed('left', p); }
    }, 1000);
    post({ k: 'hello' });
    rebuild();
    const ns = {
      name,
      emit(topic, data) {
        if (left) return Promise.reject(err('invalid_argument', 'left'));
        if (typeof topic !== 'string' || !/^[a-z][a-z0-9_.-]{0,47}$/.test(topic)) { stats.refused++; return Promise.reject(err('invalid_argument', 'topic grammar')); }
        if (data !== undefined && bytes(data) > 4096) { stats.refused++; return Promise.reject(err('invalid_argument', `data over 4 KiB (${bytes(data)} bytes)`)); }
        const need = OPEN_TOPICS[topic] ? LEVEL[OPEN_TOPICS[topic]] : LEVEL.admin;
        if (LEVEL[role()] < need) { stats.refused++; return Promise.reject(err('not_permitted', 'this viewer may not send on ' + topic)); }
        if (!take()) { stats.dropped++; return Promise.resolve(); } // past the budget: dropped
        stats.sent++;
        post({ k: 'e', t: topic, d: data });
        // your own message comes back to you, marked sameTab
        setTimeout(() => { const fns = handlers.get(topic); if (fns) for (const f of fns) f(Object.freeze({ topic, data, peer: me, by: null, isMe: true, sameTab: true, kind: 'viewer', guest: false })); }, 0);
        return Promise.resolve();
      },
      on(topic, fn) {
        if (typeof fn !== 'function') throw new TypeError('handler');
        if (!handlers.has(topic)) handlers.set(topic, new Set());
        const wrap = (m) => fn(m);
        handlers.get(topic).add(wrap);
        return () => handlers.get(topic).delete(wrap);
      },
      presence(patch) {
        if (left) return Promise.reject(err('invalid_argument', 'left'));
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return Promise.reject(err('invalid_argument', 'patch'));
        const merged = { ...mine };
        for (const [k, v] of Object.entries(patch)) { if (v === null) delete merged[k]; else merged[k] = v; }
        if (bytes(merged) > 4096) { stats.refused++; return Promise.reject(err('invalid_argument', `presence over 4 KiB (${bytes(merged)} bytes)`)); }
        mine = merged;
        rebuild();
        // sent coalesced, about 30 a second, out of the shared budget
        if (!presenceTimer) {
          presenceTimer = setTimeout(function send() {
            if (!take()) { presenceTimer = setTimeout(send, 30); return; }
            presenceTimer = null; stats.presence++;
            post({ k: 'p', p: mine });
          }, 33);
        }
        return Promise.resolve();
      },
      peers() { return snapshot; },
      onPeers(fn) { peerFns.add(fn); setTimeout(() => { if (peerFns.has(fn)) fn({ peers: snapshot, joined: snapshot.slice(), left: [], updated: [] }); }, 0); return () => peerFns.delete(fn); },
      connected() { return !left; },
      onConnection(fn) { setTimeout(() => fn(!left), 0); return () => {}; },
      leave() { if (!left) { post({ k: 'bye' }); left = true; clearInterval(beat); ch.close(); } return Promise.resolve(); },
    };
    return ns;
  }

  const lobby = makeRoom('lobby');
  const named = new Map();
  lobby.join = (name) => {
    if (!/^[a-z0-9][a-z0-9_.-]{0,47}$/.test(name)) return Promise.reject(err('invalid_argument', 'room name'));
    // joining a name you are in returns the same room; after leaving, a fresh one
    if (!named.has(name) || !named.get(name).connected()) named.set(name, makeRoom('room:' + name));
    return Promise.resolve(named.get(name));
  };
  delete lobby.leave;
  const downloads = { save: async ({ filename, data }) => {
    const text = typeof data === 'string' ? data : data instanceof Blob ? await data.text() : new TextDecoder().decode(data);
    window.__mockSaved = { filename, size: text.length, data: text };
    return { saved: true };
  } };
  window.claude = Object.freeze({ use: async (n) => (n === 'room' ? Object.freeze(lobby) : n === 'downloads' ? Object.freeze(downloads) : null) });
})();
