/** Filesystem save store: atomic writes, rotating backups, corruption fallback. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { deserializeWorld, serializeWorld, readEnvelope, SaveError } from '../shared/save';
import type { WorldState } from '../shared/state';

const BACKUPS = 3;

export class FsSaveStore {
  constructor(private dir: string, private log: (m: string) => void = console.log) {}

  private file(name: string) {
    const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) || 'world';
    return path.join(this.dir, `${safe}.tws`);
  }

  async save(name: string, world: WorldState, day: number): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const f = this.file(name);
    const text = serializeWorld(world, day);
    // rotate backups: .bak2 <- .bak1 <- current
    for (let i = BACKUPS - 1; i >= 1; i--) {
      await fs.rename(`${f}.bak${i}`, `${f}.bak${i + 1}`).catch(() => {});
    }
    await fs.copyFile(f, `${f}.bak1`).catch(() => {});
    const tmp = `${f}.tmp`;
    await fs.writeFile(tmp, text, 'utf8');
    await fs.rename(tmp, f);
  }

  /** Loads the newest valid save, falling back to backups if the main file is corrupted. */
  async load(name: string): Promise<WorldState | null> {
    const f = this.file(name);
    const candidates = [f, ...Array.from({ length: BACKUPS }, (_, i) => `${f}.bak${i + 1}`)];
    let sawAny = false;
    for (const c of candidates) {
      let text: string;
      try { text = await fs.readFile(c, 'utf8'); } catch { continue; }
      sawAny = true;
      try {
        const w = deserializeWorld(text);
        if (c !== f) this.log(`[save] main save unreadable, recovered from ${path.basename(c)}`);
        return w;
      } catch (e) {
        this.log(`[save] ${path.basename(c)} rejected: ${(e as Error).message}`);
      }
    }
    if (sawAny) throw new SaveError('All save files are corrupted');
    return null;
  }

  async list(): Promise<{ name: string; savedAt: number; day: number; players: string[] }[]> {
    let files: string[] = [];
    try { files = await fs.readdir(this.dir); } catch { return []; }
    const out = [];
    for (const f of files.filter((x) => x.endsWith('.tws'))) {
      try {
        const env = readEnvelope(await fs.readFile(path.join(this.dir, f), 'utf8'));
        out.push({ name: f.replace(/\.tws$/, ''), savedAt: env.savedAt, day: env.day, players: env.players });
      } catch { /* skip corrupted */ }
    }
    return out.sort((a, b) => b.savedAt - a.savedAt);
  }
}
