/** gzip helpers (CompressionStream) with a plain fallback where it is missing. */
export const canCompress = typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export async function gzipText(text: string): Promise<Uint8Array> {
  return pipe(new TextEncoder().encode(text), new CompressionStream('gzip'));
}

/** Inflate gzip bytes to text, refusing anything that would exceed `maxBytes`. */
export async function gunzipText(data: Uint8Array, maxBytes = 64 * 1024 * 1024): Promise<string> {
  const bytes = await pipe(data, new DecompressionStream('gzip'));
  if (bytes.length > maxBytes) throw new Error('save too large');
  return new TextDecoder().decode(bytes);
}
