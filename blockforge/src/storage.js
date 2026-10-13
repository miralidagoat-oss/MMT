// World persistence in IndexedDB. Chunks are stored only once modified,
// run-length encoded. Everything degrades to "no saving" if storage is
// unavailable (private windows, sandboxed previews).

const DB_NAME = 'blockforge';
const DB_VERSION = 1;

export function rleEncode(arr) {
  const out = [];
  let i = 0;
  while (i < arr.length) {
    const v = arr[i];
    let n = 1;
    while (i + n < arr.length && arr[i + n] === v && n < 255) n++;
    out.push(v, n);
    i += n;
  }
  return new Uint8Array(out);
}

export function rleDecode(data, length) {
  const out = new Uint8Array(length);
  let o = 0;
  for (let i = 0; i + 1 < data.length && o < length; i += 2) {
    const v = data[i], n = data[i + 1];
    out.fill(v, o, Math.min(length, o + n));
    o += n;
  }
  return out;
}

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export class Storage {
  static async open() {
    try {
      if (typeof indexedDB === 'undefined') return new Storage(null);
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('worlds')) db.createObjectStore('worlds', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks');
      };
      const db = await Promise.race([req(r), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]);
      return new Storage(db);
    } catch (err) {
      console.warn('Saving disabled:', err && err.message);
      return new Storage(null);
    }
  }

  constructor(db) {
    this.db = db;
    this.memory = new Map(); // fallback when IndexedDB is unavailable
    this.memWorlds = new Map();
  }

  get persistent() { return !!this.db; }

  async listWorlds() {
    if (!this.db) return [...this.memWorlds.values()].sort((a, b) => b.lastPlayed - a.lastPlayed);
    try {
      const tx = this.db.transaction('worlds', 'readonly');
      const all = await req(tx.objectStore('worlds').getAll());
      return all.sort((a, b) => b.lastPlayed - a.lastPlayed);
    } catch { return []; }
  }

  async saveWorld(meta) {
    if (!this.db) { this.memWorlds.set(meta.id, structuredClone(meta)); return; }
    try {
      const tx = this.db.transaction('worlds', 'readwrite');
      await req(tx.objectStore('worlds').put(meta));
    } catch (err) { console.warn('save world failed', err); }
  }

  async deleteWorld(id) {
    if (!this.db) {
      this.memWorlds.delete(id);
      for (const k of [...this.memory.keys()]) if (k.startsWith(id + ':') || k.startsWith(id + '@')) this.memory.delete(k);
      return;
    }
    try {
      const tx = this.db.transaction(['worlds', 'chunks'], 'readwrite');
      tx.objectStore('worlds').delete(id);
      const range = IDBKeyRange.bound(id + ':', id + ':￿');
      tx.objectStore('chunks').delete(range);
      // chunks of other dimensions are stored as `${id}@dim:cx,cz`
      tx.objectStore('chunks').delete(IDBKeyRange.bound(id + '@', id + '@\uffff'));
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    } catch (err) { console.warn('delete failed', err); }
  }

  async loadChunk(worldId, cx, cz) {
    const key = `${worldId}:${cx},${cz}`;
    if (!this.db) return this.memory.get(key) || null;
    try {
      const tx = this.db.transaction('chunks', 'readonly');
      return (await req(tx.objectStore('chunks').get(key))) || null;
    } catch { return null; }
  }

  // Every chunk saved for a world (all its dimensions), as [key suffix, record].
  async worldChunks(worldId) {
    const out = [];
    const take = (k, v) => { if (k.startsWith(worldId + ':') || k.startsWith(worldId + '@')) out.push([k.slice(worldId.length), v]); };
    if (!this.db) { for (const [k, v] of this.memory) take(k, v); return out; }
    try {
      const tx = this.db.transaction('chunks', 'readonly');
      const st = tx.objectStore('chunks');
      for (const range of [IDBKeyRange.bound(worldId + ':', worldId + ':\uffff'), IDBKeyRange.bound(worldId + '@', worldId + '@\uffff')]) {
        const [keys, vals] = await Promise.all([req(st.getAllKeys(range)), req(st.getAll(range))]);
        keys.forEach((k, i) => take(k, vals[i]));
      }
    } catch (err) { console.warn('reading chunks failed', err); }
    return out;
  }

  // Store chunk records under a world, from [key suffix, record] pairs.
  async putChunks(worldId, pairs) {
    const ok = pairs.filter(([suf]) => /^(@[a-z_]+)?:-?\d+,-?\d+$/.test(suf));
    if (!this.db) { for (const [suf, v] of ok) this.memory.set(worldId + suf, v); return; }
    try {
      const tx = this.db.transaction('chunks', 'readwrite');
      const st = tx.objectStore('chunks');
      for (const [suf, v] of ok) st.put(v, worldId + suf);
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    } catch (err) { console.warn('chunk import failed', err); throw new Error('Could not store the world in this browser.'); }
  }

  async saveChunks(worldId, list) {
    if (!list.length) return;
    if (!this.db) { for (const c of list) this.memory.set(`${worldId}:${c.cx},${c.cz}`, c); return; }
    try {
      const tx = this.db.transaction('chunks', 'readwrite');
      const st = tx.objectStore('chunks');
      for (const c of list) st.put(c, `${worldId}:${c.cx},${c.cz}`);
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    } catch (err) { console.warn('chunk save failed', err); }
  }
}
