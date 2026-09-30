// Pool of generation/meshing workers. Falls back to running jobs on the main
// thread (time-sliced) when workers cannot be created in this environment.
import { handleJob } from './jobs.js';

const PER_WORKER = 2;

export class WorkerPool {
  constructor(onResult) {
    this.onResult = onResult;
    this.workers = [];
    this.inflight = [];
    this.fallback = false;
    this.localQueue = [];
    this.nextId = 1;
    this.seed = 0;
    this.ready = this.start();
  }

  async start() {
    const hw = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    const count = Math.max(1, Math.min(6, hw - 1));
    try {
      const made = [];
      for (let i = 0; i < count; i++) made.push(this.createWorker());
      const ok = await Promise.all(made.map((w) => new Promise((res) => {
        const t = setTimeout(() => res(false), 8000);
        const onMsg = (e) => {
          if (e.data && e.data.type === 'ready') { clearTimeout(t); w.removeEventListener('message', onMsg); res(true); }
        };
        w.addEventListener('message', onMsg);
        w.addEventListener('error', () => { clearTimeout(t); res(false); });
      })));
      if (ok.some((x) => !x)) throw new Error('worker failed to start');
      this.workers = made;
      this.inflight = made.map(() => 0);
      made.forEach((w, i) => {
        w.onmessage = (e) => this.receive(i, e.data);
        w.onerror = (e) => console.error('worker error', e.message || e);
      });
    } catch (err) {
      console.warn('Workers unavailable, generating on the main thread:', err && err.message);
      for (const w of this.workers) w.terminate();
      this.workers = [];
      this.fallback = true;
    }
  }

  createWorker() {
    const src = typeof globalThis.__BF_WORKER_SRC__ === 'string' ? globalThis.__BF_WORKER_SRC__ : null;
    if (src) {
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      return new Worker(url);
    }
    return new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  }

  async init(seed, dim = 'overworld') {
    await this.ready;
    this.seed = seed;
    this.localQueue.length = 0;
    if (this.fallback) { handleJob({ type: 'init', seed, dim }); return; }
    // Wait until each worker has switched seeds so stale results are not mixed in.
    await Promise.all(this.workers.map((w) => new Promise((res) => {
      const id = this.nextId++;
      const onMsg = (e) => { if (e.data && e.data.id === id) { w.removeEventListener('message', onMsg); res(); } };
      w.addEventListener('message', onMsg);
      w.postMessage({ type: 'init', seed, dim, id });
    })));
    this.inflight = this.workers.map(() => 0);
  }

  get capacity() { return this.fallback ? 1 : this.workers.length * PER_WORKER; }

  freeSlots() {
    if (this.fallback) return this.localQueue.length ? 0 : 1;
    let n = 0;
    for (const c of this.inflight) n += PER_WORKER - c;
    return n;
  }

  get pending() {
    if (this.fallback) return this.localQueue.length;
    return this.inflight.reduce((a, b) => a + b, 0);
  }

  submit(msg, transfer = []) {
    msg.id = this.nextId++;
    msg.seed = this.seed;
    if (this.fallback) { this.localQueue.push(msg); return; }
    let best = 0;
    for (let i = 1; i < this.inflight.length; i++) if (this.inflight[i] < this.inflight[best]) best = i;
    this.inflight[best]++;
    this.workers[best].postMessage(msg, transfer);
  }

  receive(i, data) {
    if (data.type === 'ready' || data.type === 'init') return;
    this.inflight[i] = Math.max(0, this.inflight[i] - 1);
    if (data.type === 'error') { console.error('job failed', data.error); this.onResult({ ...data, failed: true }); return; }
    this.onResult(data);
  }

  // Main-thread fallback: run queued jobs within a time budget.
  pump(budgetMs) {
    if (!this.fallback) return;
    const end = performance.now() + budgetMs;
    while (this.localQueue.length && performance.now() < end) {
      const msg = this.localQueue.shift();
      try {
        const [res] = handleJob(msg);
        this.onResult(res);
      } catch (err) {
        console.error('job failed', err);
        this.onResult({ id: msg.id, type: 'error', failed: true, cx: msg.cx, cz: msg.cz, job: msg.type });
      }
    }
  }

  terminate() { for (const w of this.workers) w.terminate(); }
}
