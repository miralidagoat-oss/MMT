/** Tiny IndexedDB key-value store for single-player saves (with localStorage fallback). */
const DB = 'tidewake';
const STORE = 'saves';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export const saveStore = {
  async get(key: string): Promise<string | null> {
    try { return (await tx<string | undefined>('readonly', (s) => s.get(key))) ?? null; }
    catch { try { return localStorage.getItem(`tw.save.${key}`); } catch { return null; } }
  },
  async put(key: string, value: string): Promise<void> {
    try { await tx('readwrite', (s) => s.put(value, key)); }
    catch { localStorage.setItem(`tw.save.${key}`, value); }
  },
  async del(key: string): Promise<void> {
    try { await tx('readwrite', (s) => s.delete(key)); } catch { /* ignore */ }
    try { localStorage.removeItem(`tw.save.${key}`); } catch { /* ignore */ }
  },
  async keys(): Promise<string[]> {
    try { return (await tx<IDBValidKey[]>('readonly', (s) => s.getAllKeys())).map(String); }
    catch { return []; }
  },
};
