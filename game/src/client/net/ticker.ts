/**
 * A steady tick that keeps running while the tab is in the background.
 * Browsers throttle main-thread timers in hidden tabs (to 1 Hz, then once a
 * minute), which would stall online co-op whenever the host switches tabs.
 * Timers inside a dedicated worker are not throttled that way, and messages
 * posted from it are delivered promptly, so the worker paces the main thread.
 * Falls back to setInterval when workers are unavailable.
 */
type Fn = () => void;

const listeners = new Set<Fn>();
let started = false;
let worker: Worker | null = null;
let fallback: ReturnType<typeof setInterval> | null = null;
const INTERVAL_MS = 15;

function fire() { for (const f of listeners) { try { f(); } catch (e) { console.warn('tick listener failed', e); } } }

function start() {
  if (started) return;
  started = true;
  try {
    const src = `let t = null; onmessage = (e) => { if (t) clearInterval(t); t = e.data > 0 ? setInterval(() => postMessage(0), e.data) : null; };`;
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    worker = new Worker(url);
    URL.revokeObjectURL(url);
    worker.onmessage = fire;
    worker.onerror = () => { worker?.terminate(); worker = null; fallback = setInterval(fire, INTERVAL_MS); };
    worker.postMessage(INTERVAL_MS);
  } catch {
    worker = null;
    fallback = setInterval(fire, INTERVAL_MS);
  }
}

function stop() {
  if (!started || listeners.size) return;
  started = false;
  worker?.terminate();
  worker = null;
  if (fallback) clearInterval(fallback);
  fallback = null;
}

/** Call `fn` about every 15 ms, also in background tabs. Returns an unsubscribe. */
export function onTick(fn: Fn): () => void {
  listeners.add(fn);
  start();
  return () => { listeners.delete(fn); stop(); };
}
