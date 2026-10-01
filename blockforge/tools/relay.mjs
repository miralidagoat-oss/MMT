#!/usr/bin/env node
// Blockforge relay: a tiny WebSocket server that passes messages between the
// players of a shared world, plus the game page itself.
//
//   node tools/relay.mjs [port]
//
// Then open http://<this computer's address>:<port>/ on each device, choose
// Multiplayer > Relay server and enter ws://<address>:<port>.
// No dependencies; plain Node 18+.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = +(process.argv[2] || process.env.PORT || 8787);
const here = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(here, '..', 'dist', 'blockforge.html');
const MAX_MESSAGE = 256 * 1024;

const rooms = new Map(); // name -> Map(id -> client)

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url.startsWith('/?') || req.url === '/index.html') {
    fs.readFile(PAGE, (err, data) => {
      if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Build the game first: npm run build'); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(data);
    });
    return;
  }
  if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ rooms: rooms.size })); return; }
  res.writeHead(404); res.end();
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'));
  socket.setNoDelay(true);
  const client = { id: crypto.randomBytes(6).toString('hex'), socket, room: null, presence: {}, buf: Buffer.alloc(0), frags: [] };
  socket.on('data', (chunk) => { client.buf = Buffer.concat([client.buf, chunk]); readFrames(client); });
  socket.on('close', () => leave(client));
  socket.on('error', () => leave(client));
});

function readFrames(c) {
  for (;;) {
    const b = c.buf;
    if (b.length < 2) return;
    const fin = b[0] & 0x80, op = b[0] & 0x0f, masked = b[1] & 0x80;
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; } else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    if (len > MAX_MESSAGE) { c.socket.destroy(); return; }
    const mo = off; if (masked) off += 4;
    if (b.length < off + len) return;
    const payload = Buffer.from(b.subarray(off, off + len));
    if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= b[mo + (i & 3)];
    c.buf = b.subarray(off + len);
    if (op === 8) { c.socket.end(); return; }
    if (op === 9) { send(c, payload, 10); continue; }
    if (op === 10) continue;
    if (op === 1 || op === 2 || op === 0) {
      c.frags.push(payload);
      if (!fin) continue;
      const text = Buffer.concat(c.frags).toString('utf8');
      c.frags = [];
      onMessage(c, text);
    }
  }
}

function send(c, data, op = 1) {
  if (c.socket.destroyed) return;
  const payload = typeof data === 'string' ? Buffer.from(data) : data;
  let head;
  if (payload.length < 126) head = Buffer.from([0x80 | op, payload.length]);
  else if (payload.length < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(payload.length, 2); } else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(payload.length), 2); }
  c.socket.write(Buffer.concat([head, payload]));
}

function others(c, msg) {
  const r = rooms.get(c.room);
  if (!r) return;
  const s = JSON.stringify(msg);
  for (const o of r.values()) if (o !== c) send(o, s);
}

function onMessage(c, text) {
  let m;
  try { m = JSON.parse(text); } catch { return; }
  if (m.k === 'join' && typeof m.room === 'string' && /^[a-z0-9_.-]{1,48}$/.test(m.room) && !c.room) {
    c.room = m.room;
    if (!rooms.has(c.room)) rooms.set(c.room, new Map());
    const r = rooms.get(c.room);
    send(c, JSON.stringify({ k: 'joined', you: c.id, peers: [...r.values()].map((o) => ({ id: o.id, presence: o.presence })) }));
    r.set(c.id, c);
    return;
  }
  if (!c.room) return;
  if (m.k === 'p') { c.presence = m.p || {}; others(c, { k: 'p', from: c.id, p: c.presence }); } else if (m.k === 'e' && typeof m.t === 'string') others(c, { k: 'e', from: c.id, t: m.t, d: m.d });
}

function leave(c) {
  if (!c.room) return;
  const r = rooms.get(c.room);
  if (r) {
    r.delete(c.id);
    others(c, { k: 'left', from: c.id });
    if (!r.size) rooms.delete(c.room);
  }
  c.room = null;
}

server.listen(PORT, () => {
  const addrs = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
  console.log(`Blockforge relay listening on port ${PORT}`);
  for (const a of addrs.length ? addrs : ['localhost']) console.log(`  play:  http://${a}:${PORT}/    relay: ws://${a}:${PORT}`);
});
