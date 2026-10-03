/**
 * Cloud copies of worlds for the hosted web build: each signed-in player's
 * saves live in their own private area of the page's document store, so a
 * world survives cleared browser data and follows them to another device.
 *
 * A save is split into parts (documents are capped at 256 KiB). Parts are
 * written under a fresh generation first and the index document is switched
 * last, so an interrupted upload never replaces a good cloud save with a
 * partial one; the envelope's CRC is checked again on download.
 */
import { claudeHost } from './room';
import { readEnvelope } from '../../shared/save';
import type { LocalWorld } from './local';

interface DocSnap { id: string; exists: boolean; data(): Record<string, unknown> | undefined }
interface DocRef { get(): Promise<DocSnap>; set(d: Record<string, unknown>): Promise<void>; delete(): Promise<void>; collection(p: string): ColRef }
interface ColRef { doc(id: string): DocRef; get(): Promise<{ docs: DocSnap[] }> }
interface Db { doc(p: string): DocRef }
interface User { id(): Promise<string | null> }

const PART = 200_000;
const MIN_UPLOAD_GAP_MS = 120_000;

export interface CloudWorld extends LocalWorld { gen: string; parts: number }

export class CloudSaves {
  private lastUpload = new Map<string, number>();
  private inflight = new Map<string, Promise<boolean>>();
  private queued = new Map<string, string>();
  /** false once the store has refused a write (view-only viewers) */
  writable = true;

  private constructor(private db: Db, private uid: string) {}

  static async connect(): Promise<CloudSaves | null> {
    const c = claudeHost();
    if (!c) return null;
    try {
      const [db, user] = await Promise.all([c.use('db') as Promise<Db | null>, c.use('user') as Promise<User | null>]);
      if (!db || !user) return null;
      const uid = await user.id();
      if (!uid) return null;
      return new CloudSaves(db, uid);
    } catch { return null; }
  }

  private root(): DocRef { return this.db.doc(`data/users/${this.uid}/saves`); }
  private index(slot: string): DocRef { return this.root().collection('worlds').doc(slot); }
  private part(slot: string, gen: string, i: number): DocRef { return this.root().collection('parts').doc(`${slot}~${gen}~${i}`); }

  async list(): Promise<CloudWorld[]> {
    try {
      const snap = await this.root().collection('worlds').get();
      return snap.docs.filter((d) => d.exists).map((d) => {
        const v = d.data() ?? {};
        return { slot: d.id, name: String(v.name ?? d.id).slice(0, 40), day: Number(v.day) | 0, savedAt: Number(v.savedAt) || 0, seed: Number(v.seed) | 0, gen: String(v.gen ?? ''), parts: Number(v.parts) | 0 };
      }).filter((w) => w.gen && w.parts > 0);
    } catch { return []; }
  }

  async download(slot: string): Promise<string> {
    const idx = await this.index(slot).get();
    const v = idx.data();
    if (!idx.exists || !v) throw new Error('Cloud save not found');
    const parts = Number(v.parts) | 0;
    const gen = String(v.gen);
    const texts = await Promise.all(Array.from({ length: parts }, async (_, i) => {
      const p = await this.part(slot, gen, i).get();
      const d = p.data()?.d;
      if (typeof d !== 'string') throw new Error('Cloud save is incomplete');
      return d;
    }));
    const text = texts.join('');
    readEnvelope(text); // throws if corrupted
    return text;
  }

  /** Upload a save. Throttled per slot unless forced; the newest pending text always wins. */
  upload(slot: string, text: string, force = false): Promise<boolean> {
    if (!this.writable) return Promise.resolve(false);
    const last = this.lastUpload.get(slot) ?? 0;
    if (!force && Date.now() - last < MIN_UPLOAD_GAP_MS) { this.queued.set(slot, text); return Promise.resolve(false); }
    const running = this.inflight.get(slot);
    if (running) { this.queued.set(slot, text); return running; }
    const job = this.doUpload(slot, text).finally(() => {
      this.inflight.delete(slot);
      const next = this.queued.get(slot);
      if (next && force) { this.queued.delete(slot); void this.upload(slot, next, true); }
    });
    this.inflight.set(slot, job);
    return job;
  }

  /** Push any throttled save now (on quit / page hide). */
  flush(slot: string): Promise<boolean> {
    const t = this.queued.get(slot);
    if (!t) return Promise.resolve(true);
    this.queued.delete(slot);
    return this.upload(slot, t, true);
  }

  private async doUpload(slot: string, text: string): Promise<boolean> {
    let env;
    try { env = readEnvelope(text); } catch { return false; }
    const gen = Date.now().toString(36);
    const n = Math.max(1, Math.ceil(text.length / PART));
    try {
      const prev = (await this.index(slot).get()).data();
      for (let i = 0; i < n; i++) await this.part(slot, gen, i).set({ d: text.slice(i * PART, (i + 1) * PART) });
      await this.index(slot).set({ name: env.name, day: env.day, savedAt: env.savedAt, seed: env.seed, gen, parts: n });
      this.lastUpload.set(slot, Date.now());
      // drop the previous generation's parts
      if (prev && typeof prev.gen === 'string' && prev.gen !== gen) {
        for (let i = 0; i < (Number(prev.parts) | 0); i++) void this.part(slot, prev.gen, i).delete().catch(() => {});
      }
      return true;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'invalid_argument' || code === 'not_granted' || code === 'revoked') this.writable = false;
      console.warn('cloud save failed', code ?? e);
      return false;
    }
  }

  async remove(slot: string): Promise<void> {
    try {
      const v = (await this.index(slot).get()).data();
      await this.index(slot).delete();
      if (v && typeof v.gen === 'string') for (let i = 0; i < (Number(v.parts) | 0); i++) void this.part(slot, v.gen, i).delete().catch(() => {});
    } catch { /* not there / not writable */ }
  }
}

let cloud: Promise<CloudSaves | null> | null = null;
export function getCloud(): Promise<CloudSaves | null> {
  if (!cloud) cloud = CloudSaves.connect();
  return cloud;
}
