// World layout constants shared by the main thread and the workers.
export const CHUNK = 16;            // chunk width/depth in blocks
export const HEIGHT = 256;          // world height in blocks
export const CHUNK_AREA = CHUNK * CHUNK;
export const CHUNK_VOLUME = CHUNK_AREA * HEIGHT;
export const SEA_LEVEL = 63;
export const TICKS_PER_SECOND = 20;
export const TICK_MS = 1000 / TICKS_PER_SECOND;
export const DAY_TICKS = 24000;

// Block index inside a chunk: x fastest, then z, then y.
export const blockIndex = (x, y, z) => x | (z << 4) | (y << 8);

// Integer key for a chunk coordinate pair.
export const chunkKey = (cx, cz) => (cx + 32768) * 65536 + (cz + 32768);
