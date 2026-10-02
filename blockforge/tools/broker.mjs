#!/usr/bin/env node
// A minimal MQTT 3.1.1 broker over WebSocket, enough for Blockforge's online
// handshake: CONNECT, SUBSCRIBE (exact topics), PUBLISH at QoS 0, PING and
// DISCONNECT. For tests and for running your own matchmaking point; no
// dependencies, plain Node 18+.
//
//   node tools/broker.mjs [port]
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = +(process.argv[2] || process.env.PORT || 8899);
const MAX = 64 * 1024;
const subs = new Map(); // topic -> Set(client)

const server = http.createServer((req, res) => { res.writeHead(426, { 'content-type': 'text/plain' }); res.end('MQTT over WebSocket only\n'); });

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  const protos = String(req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim());
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`,
    ...(protos.includes('mqtt') ? ['Sec-WebSocket-Protocol: mqtt'] : []), '', ''].join('\r\n'));
  socket.setNoDelay(true);
  const c = { socket, ws: Buffer.alloc(0), frags: [], mq: Buffer.alloc(0), topics: new Set(), ok: false };
  socket.on('data', (chunk) => { c.ws = Buffer.concat([c.ws, chunk]); readFrames(c); });
  socket.on('close', () => drop(c));
  socket.on('error', () => drop(c));
});

function readFrames(c) {
  for (;;) {
    const b = c.ws;
    if (b.length < 2) return;
    const fin = b[0] & 0x80, op = b[0] & 0x0f, masked = b[1] & 0x80;
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; } else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    if (len > MAX) { c.socket.destroy(); return; }
    const mo = off; if (masked) off += 4;
    if (b.length < off + len) return;
    const payload = Buffer.from(b.subarray(off, off + len));
    if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= b[mo + (i & 3)];
    c.ws = b.subarray(off + len);
    if (op === 8) { c.socket.end(); return; }
    if (op === 9) { sendFrame(c, payload, 10); continue; }
    if (op === 10) continue;
    c.frags.push(payload);
    if (!fin) continue;
    c.mq = Buffer.concat([c.mq, ...c.frags]);
    c.frags = [];
    readPackets(c);
  }
}

function sendFrame(c, payload, op = 2) {
  if (c.socket.destroyed) return;
  let head;
  if (payload.length < 126) head = Buffer.from([0x80 | op, payload.length]);
  else if (payload.length < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(payload.length, 2); } else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(payload.length), 2); }
  c.socket.write(Buffer.concat([head, payload]));
}

function packet(type, body) {
  const head = [type];
  let x = body.length;
  do { let d = x % 128; x = Math.floor(x / 128); if (x > 0) d |= 128; head.push(d); } while (x > 0);
  return Buffer.concat([Buffer.from(head), body]);
}

function readPackets(c) {
  for (;;) {
    const b = c.mq;
    if (b.length < 2) return;
    let len = 0, mul = 1, i = 1;
    for (;;) {
      if (i >= b.length) return;
      const d = b[i++];
      len += (d & 127) * mul; mul *= 128;
      if (!(d & 128)) break;
      if (i > 4) { c.socket.destroy(); return; }
    }
    if (b.length < i + len) return;
    const type = b[0] >> 4, flags = b[0] & 15, body = b.subarray(i, i + len);
    c.mq = b.subarray(i + len);
    if (type === 1) { c.ok = true; sendFrame(c, packet(0x20, Buffer.from([0, 0]))); continue; } // CONNECT -> CONNACK
    if (!c.ok) { c.socket.destroy(); return; }
    if (type === 8) { // SUBSCRIBE
      const id = body.subarray(0, 2), codes = [];
      for (let k = 2; k + 2 <= body.length;) {
        const tl = body.readUInt16BE(k), topic = body.subarray(k + 2, k + 2 + tl).toString('utf8');
        k += 2 + tl + 1;
        if (!subs.has(topic)) subs.set(topic, new Set());
        subs.get(topic).add(c); c.topics.add(topic);
        codes.push(0);
      }
      sendFrame(c, packet(0x90, Buffer.concat([id, Buffer.from(codes)])));
    } else if (type === 3) { // PUBLISH (delivered at QoS 0)
      const tl = body.readUInt16BE(0), topic = body.subarray(2, 2 + tl).toString('utf8');
      const qos = (flags >> 1) & 3;
      const payload = body.subarray(2 + tl + (qos ? 2 : 0));
      if (qos === 1) sendFrame(c, packet(0x40, body.subarray(2 + tl, 4 + tl)));
      const out = packet(0x30, Buffer.concat([body.subarray(0, 2 + tl), payload]));
      for (const o of subs.get(topic) || []) sendFrame(o, out);
    } else if (type === 12) sendFrame(c, Buffer.from([0xd0, 0])); // PINGREQ -> PINGRESP
    else if (type === 14) { c.socket.end(); return; } // DISCONNECT
  }
}

function drop(c) {
  for (const t of c.topics) { const s = subs.get(t); if (s) { s.delete(c); if (!s.size) subs.delete(t); } }
  c.topics.clear();
}

server.listen(PORT, () => console.log(`Blockforge test broker (MQTT over WebSocket) on ws://localhost:${PORT}`));
