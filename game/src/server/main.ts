/**
 * Tidewake dedicated / listen server.
 *   npx tsx src/server/main.ts --port 7777 --world island --seed 1234 [--serve-client] [--lag 80 --loss 0.02]
 * Serves the built client (dist/client) when --serve-client is given so friends can
 * simply open http://host:port in a browser.
 */
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { Simulation } from '../shared/sim/simulation';
import { GameHost, type Peer } from '../shared/net/host';
import { encode, decode } from '../shared/net/codec';
import { SIM, NET, GAME_NAME, PROTOCOL_VERSION } from '../shared/config';
import { dayNumber } from '../shared/systems/weather';
import type { ClientMsg, ServerMsg } from '../shared/net/protocol';
import { FsSaveStore } from './savestore';

const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port ?? process.env.PORT ?? 7777);
const WORLD = String(args.world ?? 'island');
const SAVE_DIR = String(args['save-dir'] ?? path.resolve(process.cwd(), 'saves'));
const LAG = Number(args.lag ?? 0);
const JITTER = Number(args.jitter ?? 0);
const LOSS = Number(args.loss ?? 0);
const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.resolve(here, '../../dist/client');

function log(m: string) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`); }

function parseArgs(a: string[]): Record<string, string | boolean> {
  const o: Record<string, string | boolean> = {};
  for (let i = 0; i < a.length; i++) {
    const k = a[i]!;
    if (!k.startsWith('--')) continue;
    const n = a[i + 1];
    if (n && !n.startsWith('--')) { o[k.slice(2)] = n; i++; } else o[k.slice(2)] = true;
  }
  return o;
}

async function main() {
  const store = new FsSaveStore(SAVE_DIR, log);
  let world = null;
  try { world = await store.load(WORLD); } catch (e) { log(`FATAL: ${(e as Error).message}`); process.exit(2); }
  const sim = world
    ? new Simulation({ world, log })
    : new Simulation({ seed: args.seed !== undefined ? String(args.seed) : undefined, name: WORLD, log, settings: args.difficulty ? { difficulty: args.difficulty as 'normal' } : undefined });
  log(`${world ? 'Loaded' : 'Created'} world '${WORLD}' seed=${sim.world.seed} day=${dayNumber(sim.world)} islands=${sim.gen.islands.length}`);

  let saving = false;
  const save = async () => {
    if (saving) return false;
    saving = true;
    try { await store.save(WORLD, sim.world, dayNumber(sim.world)); log('world saved'); return true; }
    catch (e) { log(`save failed: ${(e as Error).message}`); return false; }
    finally { saving = false; }
  };

  const host = new GameHost(sim, { log, onSaveRequest: save });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/api/info') {
      const players = Object.values(sim.world.players).filter((p) => p.connected).map((p) => p.name);
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ game: GAME_NAME, protocol: PROTOCOL_VERSION, name: sim.world.name, players, max: SIM.maxPlayers, day: dayNumber(sim.world) }));
      return;
    }
    if (url.pathname === '/api/stats') {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      const s = host.stats;
      res.end(JSON.stringify({ ticks: s.ticks, avgTickMs: s.ticks ? s.tickMsTotal / s.ticks : 0, maxTickMs: s.tickMsMax, bytesOut: s.bytesOut, creatures: Object.keys(sim.world.creatures).length, structures: Object.keys(sim.world.structures).length }));
      return;
    }
    if (!args['serve-client']) { res.writeHead(404); res.end(); return; }
    // static client
    let p = decodeURIComponent(url.pathname);
    if (p === '/' || !path.extname(p)) p = '/index.html';
    const file = path.join(CLIENT_DIR, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(CLIENT_DIR)) { res.writeHead(403); res.end(); return; }
    try {
      const data = await fs.readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      res.end(data);
    } catch { res.writeHead(404); res.end('Not found (did you run npm run build?)'); }
  });

  const wss = new WebSocketServer({ server, maxPayload: NET.maxMessageBytes });
  wss.on('connection', (ws: WebSocket, req) => {
    const ip = req.socket.remoteAddress;
    let peer: Peer | null = null;
    const send = (msg: ServerMsg) => {
      if (ws.readyState !== ws.OPEN) return;
      const data = encode(msg);
      host.stats.bytesOut += data.byteLength;
      if (peer) peer.bytesOut += data.byteLength;
      const unreliable = msg.t === 'snap';
      if (LOSS > 0 && unreliable && Math.random() < LOSS) return;
      const delay = LAG + Math.random() * JITTER;
      if (delay > 0) setTimeout(() => { if (ws.readyState === ws.OPEN) ws.send(data); }, delay);
      else ws.send(data);
    };
    peer = host.connect(send, (reason) => { try { ws.close(1000, reason); } catch { /* ignore */ } });
    log(`connection from ${ip} (peer ${peer.id})`);
    ws.on('message', (raw: Buffer) => {
      let msg: ClientMsg;
      try { msg = decode<ClientMsg>(raw); } catch { log(`bad packet from peer ${peer!.id}`); return; }
      const handle = () => { try { host.handle(peer!, msg); } catch (e) { log(`handler error: ${(e as Error).stack}`); } };
      if (LAG > 0) setTimeout(handle, LAG + Math.random() * JITTER); else handle();
    });
    ws.on('close', () => host.disconnect(peer!, 'socket closed'));
    ws.on('error', (e) => log(`socket error peer ${peer!.id}: ${e.message}`));
  });

  host.start();
  const autosave = setInterval(save, SIM.autosaveSeconds * 1000);
  server.listen(PORT, () => {
    log(`${GAME_NAME} server listening on :${PORT}${args['serve-client'] ? ` — open http://localhost:${PORT}` : ''}`);
    if (LAG || LOSS) log(`network conditioner: lag=${LAG}ms jitter=${JITTER}ms snapshot-loss=${LOSS}`);
  });

  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${sig}: saving and shutting down`);
    clearInterval(autosave);
    host.stop();
    host.broadcast({ t: 'notify', text: 'Server is shutting down. World saved.', level: 'warn' });
    await save();
    wss.close();
    server.close();
    setTimeout(() => process.exit(0), 200);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('uncaughtException', (e) => { log(`uncaught: ${e.stack}`); void shutdown('crash'); });
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

void main();
