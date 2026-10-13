/**
 * Consent for the hosted page's capabilities. Each capability (online play,
 * cloud saves, the player's account id, downloads) would otherwise ask on
 * first use, at scattered moments; instead the page asks once, in a single
 * batched dialog, right after the main menu appears.
 */
import { claudeHost } from './room';

type State = 'granted' | 'prompt' | 'denied' | 'unavailable';
interface Permissions {
  state(): Promise<Record<string, State>>;
  state(name: string): Promise<State>;
  request(names?: readonly string[]): Promise<Record<string, State>>;
  manage(): Promise<void>;
}

let perms: Promise<Permissions | null> | null = null;
function get(): Promise<Permissions | null> {
  if (!perms) {
    const c = claudeHost();
    perms = c ? (c.use('permissions') as Promise<Permissions | null>).catch(() => null) : Promise.resolve(null);
  }
  return perms;
}

/** Ask for everything still undecided, once. Never rejects. */
export async function requestAllOnce(): Promise<void> {
  try {
    const p = await get();
    if (!p) return;
    const st = await p.state();
    if (Object.values(st).includes('prompt')) await p.request();
  } catch { /* the page keeps working with whatever was granted */ }
}

/** The viewer's answer for one capability (unavailable outside the hosted page). */
export async function permissionState(name: string): Promise<State> {
  try { const p = await get(); return p ? await p.state(name) : 'unavailable'; } catch { return 'unavailable'; }
}

/** Open the platform's Permissions panel (from a button). Returns false if it could not open. */
export async function openPermissions(): Promise<boolean> {
  try { const p = await get(); if (!p) return false; await p.manage(); return true; } catch { return false; }
}
