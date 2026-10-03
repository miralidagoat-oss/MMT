/**
 * The world library: browser saves (IndexedDB), cloud copies (hosted build) and
 * save files the player can download and import anywhere.
 */
import { saveStore } from './idb';
import { getCloud } from './cloud';
import { claudeHost } from './room';
import { readEnvelope } from '../../shared/save';
import { LocalHost, type LocalWorld } from './local';

export interface WorldEntry extends LocalWorld { where: 'device' | 'cloud' | 'both' }

export async function listAllWorlds(): Promise<WorldEntry[]> {
  const [local, cloud] = await Promise.all([LocalHost.listWorlds().catch(() => []), getCloud().then((c) => c?.list() ?? []).catch(() => [])]);
  const map = new Map<string, WorldEntry>();
  for (const w of local) map.set(w.slot, { ...w, where: 'device' });
  for (const c of cloud) {
    const l = map.get(c.slot);
    if (!l) map.set(c.slot, { slot: c.slot, name: c.name, day: c.day, savedAt: c.savedAt, seed: c.seed, where: 'cloud' });
    else if (l.corrupted || c.savedAt > l.savedAt) map.set(c.slot, { ...l, name: c.name, day: c.day, savedAt: c.savedAt, seed: c.seed, corrupted: false, where: 'both' });
    else l.where = 'both';
  }
  return [...map.values()].sort((a, b) => b.savedAt - a.savedAt);
}

/** Make sure the newest copy of a world is on this device before loading it. */
export async function ensureLocal(slot: string): Promise<void> {
  const cloud = await getCloud();
  if (!cloud) return;
  const local = await saveStore.get(`world:${slot}`);
  let localAt = -1;
  if (local) { try { localAt = readEnvelope(local).savedAt; } catch { localAt = -1; } }
  const meta = (await cloud.list()).find((w) => w.slot === slot);
  if (!meta || meta.savedAt <= localAt) return;
  const text = await cloud.download(slot);
  if (local) await saveStore.put(`backup:${slot}`, local);
  await saveStore.put(`world:${slot}`, text);
}

/** Called after every save the host makes. */
export async function onWorldSaved(slot: string, text: string, storedLocally: boolean, force = false): Promise<void> {
  if (!storedLocally) { try { localStorage.setItem(`tw.save.world:${slot}`, text); } catch { /* full or blocked */ } }
  const cloud = await getCloud();
  if (cloud) await cloud.upload(slot, text, force);
}

export async function flushCloud(slot: string): Promise<void> {
  const cloud = await getCloud();
  if (cloud) await cloud.flush(slot);
}

export async function deleteWorldEverywhere(slot: string): Promise<void> {
  await LocalHost.deleteWorld(slot);
  const cloud = await getCloud();
  await cloud?.remove(slot);
}

function fileName(name: string) {
  return `${(name.replace(/[^\w\- ]+/g, '').trim() || 'world').slice(0, 40)}.tidewake.json`;
}

/** Offer the world as a file. Returns a user-facing status line. */
export async function exportWorld(slot: string): Promise<string> {
  await ensureLocal(slot).catch(() => {});
  const text = await saveStore.get(`world:${slot}`);
  if (!text) return 'This world has no save on this device yet.';
  const env = readEnvelope(text);
  const blob = new Blob([text], { type: 'application/json' });
  const host = claudeHost();
  if (host) {
    const dl = await host.use('downloads').catch(() => null) as { save(r: { filename: string; data: Blob }): Promise<unknown> } | null;
    if (!dl) return 'Downloads are not available in this view.';
    try { await dl.save({ filename: fileName(env.name), data: blob }); return 'Save file ready.'; }
    catch (e) { const code = (e as { code?: string }).code; return code === 'declined' ? 'Download cancelled.' : 'The download could not be started.'; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName(env.name);
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return 'Save file downloaded.';
}

/** Import a save file chosen by the player. Returns the new slot. */
export async function importWorld(file: File): Promise<string> {
  if (file.size > 64 * 1024 * 1024) throw new Error('That file is too large to be a Tidewake save.');
  const text = await file.text();
  const env = readEnvelope(text); // validates JSON, version and checksum
  const slot = `i${Date.now().toString(36)}`;
  await saveStore.put(`world:${slot}`, text);
  await onWorldSaved(slot, text, true, true).catch(() => {});
  void env;
  return slot;
}
