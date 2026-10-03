/**
 * Local stand-in for the hosted page platform, for automated tests only:
 *  - serves dist/web wrapped in the document skeleton (as the host does)
 *  - relays the `room` capability (lobby + named rooms, presence with the
 *    platform's limits: 4 KiB, coalesced ~30/s, merge semantics) with latency
 *  - an in-memory `db` (per-user private paths) and `user` ids
 * The browser half is tools/mock/client.js (injected before page scripts).
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';

export function startMockPlatform(port: number, opts: { latencyMs?: number; root?: string } = {}) {
  const root = path.resolve(opts.root ?? 'dist/web');
  const lat = opts.latencyMs ?? 40;
  const skeleton = (body: string) => `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui;background:#fafaf8}img{max-width:100%}[hidden]{display:none!important}</style></head><body>${body}</body></html>`;
  const types: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
  const http = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    let p = decodeURIComponent(url.pathname);
    if (p === '/' || p === '/index.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(skeleton(readFileSync(path.join(root, 'index.html'), 'utf8'))); return; }
    if (p === '/mock-client.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(readFileSync(path.resolve('tools/mock/client.js'))); return; }
    p = path.join(root, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!p.startsWith(root) || !existsSync(p)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': types[path.extname(p)] ?? 'application/octet-stream' });
    res.end(readFileSync(p));
  });

  type Conn = { ws: WebSocket; peer: string; user: string; rooms: Map<string, Record<string, unknown>>; dirty: Set<string> };
  const conns = new Set<Conn>();
  const db = new Map<string, Record<string, unknown>>();
  const stats = { presenceRejected: 0, maxPresence: 0 };
  const sendLater = (c: Conn, msg: unknown) => setTimeout(() => { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(msg)); }, lat);
  const roomPeers = (room: string) => [...conns].filter((c) => c.rooms.has(room)).map((c) => ({ peer: c.peer, by: c.user, presence: c.rooms.get(room) }));
  const broadcastRoom = (room: string) => { const peers = roomPeers(room); for (const c of conns) if (c.rooms.has(room)) sendLater(c, { op: 'peers', room, peers }); };
  // presence is coalesced: dirty rooms are broadcast at ~30 Hz
  const dirtyRooms = new Set<string>();
  const tick = setInterval(() => { for (const r of dirtyRooms) broadcastRoom(r); dirtyRooms.clear(); }, 33);

  const wss = new WebSocketServer({ server: http, path: '/mock-room' });
  wss.on('connection', (ws, req) => {
    const q = new URL(req.url ?? '', 'http://x').searchParams;
    const c: Conn = { ws, peer: q.get('peer') ?? Math.random().toString(36).slice(2), user: q.get('user') ?? 'u-anon', rooms: new Map([['', {}]]), dirty: new Set() };
    conns.add(c);
    sendLater(c, { op: 'hello', peer: c.peer, user: c.user });
    dirtyRooms.add('');
    ws.on('message', (raw) => {
      setTimeout(() => {
        let m: { op: string; room?: string; patch?: Record<string, unknown>; id?: number; verb?: string; path?: string; data?: Record<string, unknown> };
        try { m = JSON.parse(String(raw)); } catch { return; }
        const room = m.room ?? '';
        const reply = (x: Record<string, unknown>) => sendLater(c, { op: 'reply', id: m.id, ...x });
        if (m.op === 'join') { c.rooms.set(room, {}); dirtyRooms.add(room); reply({ ok: true }); }
        else if (m.op === 'leave') { c.rooms.delete(room); dirtyRooms.add(room); reply({ ok: true }); }
        else if (m.op === 'presence') {
          const cur = { ...(c.rooms.get(room) ?? {}) };
          for (const [k, v] of Object.entries(m.patch ?? {})) { if (v === null) delete cur[k]; else cur[k] = v; }
          const size = Buffer.byteLength(JSON.stringify(cur));
          stats.maxPresence = Math.max(stats.maxPresence, size);
          if (size > 4096) { stats.presenceRejected++; reply({ error: { code: 'invalid_argument', message: `presence over 4 KiB (${size})` } }); return; }
          if (!c.rooms.has(room)) { reply({ error: { code: 'invalid_argument', message: 'not in room' } }); return; }
          c.rooms.set(room, cur);
          dirtyRooms.add(room);
          reply({ ok: true });
        } else if (m.op === 'db') {
          const p = String(m.path);
          const priv = p.match(/^data\/users\/([^/]+)/);
          if (priv && priv[1] !== c.user) { reply(m.verb === 'get' ? { exists: false } : m.verb === 'list' ? { docs: [] } : { error: { code: 'invalid_argument', message: 'not yours' } }); return; }
          if (m.verb === 'get') { const d = db.get(p); reply(d ? { exists: true, data: d } : { exists: false }); }
          else if (m.verb === 'set') { const size = Buffer.byteLength(JSON.stringify(m.data)); if (size > 256 * 1024) { reply({ error: { code: 'invalid_argument', message: 'document over 256 KiB' } }); return; } db.set(p, m.data!); reply({ ok: true }); }
          else if (m.verb === 'delete') { db.delete(p); reply({ ok: true }); }
          else if (m.verb === 'list') { const pre = p + '/'; reply({ docs: [...db.entries()].filter(([k]) => k.startsWith(pre) && !k.slice(pre.length).includes('/')).map(([k, v]) => ({ id: k.slice(pre.length), data: v })) }); }
        }
      }, lat);
    });
    ws.on('close', () => { conns.delete(c); for (const r of c.rooms.keys()) dirtyRooms.add(r); });
  });

  return new Promise<{ close(): void; db: typeof db; stats: typeof stats }>((resolve) => http.listen(port, () => resolve({
    close: () => { clearInterval(tick); for (const c of conns) c.ws.terminate(); wss.close(); http.close(); },
    db, stats,
  })));
}

if (process.argv[1]?.endsWith('server.ts')) {
  const port = Number(process.argv[2] ?? 7795);
  void startMockPlatform(port).then(() => console.log(`mock platform on http://localhost:${port}/`));
}
