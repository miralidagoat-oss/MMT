// Worker entry point: generation and meshing off the main thread.
import { handleJob } from './jobs.js';

self.onmessage = (e) => {
  try {
    const [res, transfer] = handleJob(e.data);
    self.postMessage(res, transfer);
  } catch (err) {
    self.postMessage({ id: e.data.id, type: 'error', job: e.data.type, cx: e.data.cx, cz: e.data.cz, error: String((err && err.stack) || err) });
  }
};
self.postMessage({ type: 'ready' });
