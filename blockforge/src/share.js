// Taking the game and its worlds elsewhere: save a file for the player (through
// the claude.ai page's downloads capability when the game runs there, or a
// plain download otherwise), export and import worlds, and rebuild this page
// as a standalone file that runs anywhere, including places where online play
// is allowed.

// ---- files ---------------------------------------------------------------------
// Save `data` as `filename`. Resolves { ok, code } (code: 'declined',
// 'unavailable', ... when it did not happen).
export async function saveFile(filename, data, mime = 'application/octet-stream') {
  const c = globalThis.claude;
  if (c && typeof c.use === 'function') {
    let dl = null;
    try { dl = await Promise.race([c.use('downloads'), new Promise((r) => setTimeout(() => r(null), 4000))]); } catch { dl = null; }
    if (dl) {
      try { await dl.save({ filename, data: typeof data === 'string' ? new Blob([data], { type: mime }) : data }); return { ok: true }; } catch (e) { return { ok: false, code: (e && e.code) || 'unavailable' }; }
    }
  }
  try {
    const blob = typeof data === 'string' ? new Blob([data], { type: mime }) : data;
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return { ok: true };
  } catch { return { ok: false, code: 'unavailable' }; }
}

// Ask the player for a file and read it as text.
export function pickTextFile(accept = '.json,application/json') {
  return new Promise((resolve) => {
    const inp = Object.assign(document.createElement('input'), { type: 'file', accept });
    inp.style.display = 'none';
    inp.addEventListener('change', () => {
      const f = inp.files && inp.files[0];
      inp.remove();
      if (!f) { resolve(null); return; }
      f.text().then((t) => resolve({ name: f.name, text: t }), () => resolve(null));
    });
    document.body.appendChild(inp);
    inp.click();
  });
}

// ---- the game as a standalone page ----------------------------------------------------
// The build captures the page as it stood when the game's script started
// (globalThis.__BF_PAGE__). Inside a host page only the game's own part,
// from the <!--BF-PAGE--> marker to the end of its script, is kept.
export function standalonePage() {
  const src = globalThis.__BF_PAGE__;
  if (typeof src !== 'string' || !src.includes('__BF_WORKER_SRC__')) return null;
  // (built at run time so the marker never appears in this script's own text)
  const a = src.indexOf(['<!--', 'BF-PAGE', '-->'].join(''));
  if (a < 0) return src.startsWith('<!doctype') ? src : '<!doctype html>\n' + src;
  const b = src.lastIndexOf('</script>');
  if (b < a) return null;
  // leave behind anything the host page slipped in (scripts loaded by URL)
  const body = src.slice(a, b + 9).replace(/<script\b[^>]*\bsrc=[^>]*>\s*<\/script>/gi, '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
</head>
<body>
${body}
</body>
</html>
`;
}
export const isStandaloneAvailable = () => !!standalonePage();

// ---- worlds as files --------------------------------------------------------------------
const TYPED = { Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array, Uint8ClampedArray };
function b64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
  return btoa(s);
}
function unb64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const replacer = (k, v) => {
  if (ArrayBuffer.isView(v)) return { __t: v.constructor.name, b: b64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
  if (v instanceof ArrayBuffer) return { __t: 'ArrayBuffer', b: b64(new Uint8Array(v)) };
  return v;
};
const reviver = (k, v) => {
  if (v && typeof v === 'object' && typeof v.__t === 'string' && typeof v.b === 'string' && Object.keys(v).length === 2) {
    const bytes = unb64(v.b);
    if (v.__t === 'ArrayBuffer') return bytes.buffer;
    const T = TYPED[v.__t];
    if (T) return new T(bytes.buffer, 0, bytes.byteLength / T.BYTES_PER_ELEMENT);
  }
  return v;
};

// A world and every chunk saved for it, as one JSON text.
export async function exportWorld(storage, meta) {
  const chunks = await storage.worldChunks(meta.id);
  return JSON.stringify({ blockforge: 1, exported: Date.now(), meta, chunks }, replacer);
}

// Add an exported world to this browser's saves (as a new world, never over one).
export async function importWorld(storage, text) {
  let doc;
  try { doc = JSON.parse(text, reviver); } catch { throw new Error('That file is not a Blockforge world.'); }
  if (!doc || doc.blockforge !== 1 || !doc.meta || typeof doc.meta !== 'object' || !Array.isArray(doc.chunks)) throw new Error('That file is not a Blockforge world.');
  const id = 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const existing = await storage.listWorlds();
  let name = String(doc.meta.name || 'World').slice(0, 40);
  if (existing.some((w) => w.name === name)) name = (name + ' (imported)').slice(0, 40);
  const meta = { ...doc.meta, id, name, lastPlayed: Date.now() };
  const list = [];
  for (const pair of doc.chunks) {
    if (!Array.isArray(pair) || typeof pair[0] !== 'string') continue;
    list.push([pair[0], pair[1]]);
  }
  await storage.putChunks(id, list);
  await storage.saveWorld(meta);
  return meta;
}
