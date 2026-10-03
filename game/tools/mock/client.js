// Browser half of the local test platform (see server.ts). Defines window.claude
// with use('room' | 'db' | 'user' | 'downloads') before the page's scripts run.
(() => {
  const params = new URLSearchParams(location.search);
  const user = params.get('mockuser') || ('u-' + Math.random().toString(36).slice(2, 8));
  const peerId = 'p' + Math.random().toString(36).slice(2, 12);
  const ws = new WebSocket(`ws://${location.host}/mock-room?peer=${peerId}&user=${user}`);
  let nextId = 1;
  const waiting = new Map();
  const queue = [];
  let open = false;
  ws.onopen = () => { open = true; for (const q of queue.splice(0)) ws.send(q); };
  const send = (m) => new Promise((resolve, reject) => { m.id = nextId++; waiting.set(m.id, { resolve, reject }); const s = JSON.stringify(m); if (open) ws.send(s); else queue.push(s); });
  const rooms = new Map(); // name -> state
  const mkRoom = (name) => {
    const st = { peers: Object.freeze([]), listeners: new Set(), byPeer: new Map() };
    rooms.set(name, st);
    const api = {
      name,
      presence: (patch) => send({ op: 'presence', room: name, patch }).then((r) => { if (r.error) throw r.error; }),
      peers: () => st.peers,
      onPeers: (h) => { st.listeners.add(h); queueMicrotask(() => h({ peers: st.peers, joined: st.peers, left: [], updated: [] })); return () => st.listeners.delete(h); },
      connected: () => open,
      onConnection: (h) => { setTimeout(() => h(open)); return () => {}; },
      emit: async () => {}, on: () => () => {},
      leave: () => send({ op: 'leave', room: name }).then(() => { rooms.delete(name); }),
    };
    return api;
  };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.op === 'reply') { const w = waiting.get(m.id); waiting.delete(m.id); w?.resolve(m); return; }
    if (m.op === 'peers') {
      const st = rooms.get(m.room);
      if (!st) return;
      const prev = st.byPeer;
      const next = new Map();
      const list = m.peers.map((p) => {
        const old = prev.get(p.peer);
        const same = old && JSON.stringify(old.presence) === JSON.stringify(p.presence);
        const v = same ? old : Object.freeze({ peer: p.peer, by: p.by, isMe: p.peer === peerId, sameTab: p.peer === peerId, kind: 'viewer', guest: false, presence: Object.freeze(p.presence || {}), updatedAt: Date.now() });
        next.set(p.peer, v);
        return v;
      });
      st.byPeer = next;
      st.peers = Object.freeze(list);
      const change = { peers: st.peers, joined: list.filter((p) => !prev.has(p.peer)), left: [...prev.values()].filter((p) => !next.has(p.peer)), updated: [] };
      for (const h of st.listeners) h(change);
    }
  };
  const lobby = mkRoom('');
  lobby.join = (name) => { const api = mkRoom(name); return send({ op: 'join', room: name }).then(() => api); };
  const snap = (id, r) => ({ id, exists: !!r.exists, data: () => r.data, metadata: { fromCache: false, hasPendingWrites: false } });
  const docRef = (path) => ({
    get: () => send({ op: 'db', verb: 'get', path }).then((r) => snap(path.split('/').pop(), r)),
    set: (data) => send({ op: 'db', verb: 'set', path, data }).then((r) => { if (r.error) throw r.error; }),
    delete: () => send({ op: 'db', verb: 'delete', path }).then(() => {}),
    collection: (sub) => colRef(path + '/' + sub),
  });
  const colRef = (path) => ({
    doc: (id) => docRef(path + '/' + id),
    get: () => send({ op: 'db', verb: 'list', path }).then((r) => ({ docs: r.docs.map((d) => snap(d.id, { exists: true, data: d.data })), size: r.docs.length, empty: !r.docs.length })),
  });
  const db = { doc: docRef, collection: colRef };
  const userApi = { id: async () => user, isOwner: async () => true, canEdit: async () => true, can: async () => true };
  window.__mockDownloads = [];
  const downloads = { save: async ({ filename, data }) => { const text = typeof data === 'string' ? data : await data.text(); window.__mockDownloads.push({ filename, size: text.length, text }); return { ok: true }; } };
  const caps = { room: lobby, db, user: userApi, downloads };
  window.claude = { use: (name) => new Promise((r) => setTimeout(() => r(caps[name] ?? null), 30)) };
})();
