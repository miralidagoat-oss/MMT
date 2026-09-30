// Job handler shared by worker threads and the main-thread fallback.
import './items.js'; // registers item ids used by block drop tables
import { WorldGen } from './worldgen.js';
import { Mesher } from './mesher.js';

let gen = null;
let mesher = null;

// Returns [result, transferList].
export function handleJob(msg) {
  switch (msg.type) {
    case 'init':
      gen = new WorldGen(msg.seed);
      mesher = mesher || new Mesher();
      return [{ id: msg.id, type: 'init' }, []];
    case 'gen': {
      const r = gen.generate(msg.cx, msg.cz);
      return [{ id: msg.id, type: 'gen', cx: msg.cx, cz: msg.cz, ...r },
        [r.blocks.buffer, r.meta.buffer, r.tints.buffer]];
    }
    case 'mesh': {
      const r = mesher.build(msg);
      return [{ id: msg.id, type: 'mesh', cx: msg.cx, cz: msg.cz, version: msg.version, ...r },
        [r.opaque.buffer, r.cutout.buffer, r.translucent.buffer, r.light.buffer]];
    }
    default:
      throw new Error('unknown job ' + msg.type);
  }
}
