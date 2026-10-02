/**
 * Shared analytic ocean surface. The SAME function is mirrored in the GLSL ocean
 * shader (client/render/ocean.ts) so buoyancy and visuals agree exactly.
 * Height-only displacement of sharpened directional waves.
 */
export interface SeaState {
  /** overall amplitude multiplier: ~0.35 calm, 1 normal, 2.4 storm */
  amplitude: number;
  /** wind direction (radians, direction waves travel towards) */
  windDir: number;
}

export interface WaveComponent { dirOffset: number; wavelength: number; amp: number; speedMul: number; sharp: number }

export const WAVES: readonly WaveComponent[] = [
  { dirOffset: 0.0, wavelength: 38, amp: 0.42, speedMul: 1.0, sharp: 1.6 },
  { dirOffset: 0.55, wavelength: 21, amp: 0.22, speedMul: 1.0, sharp: 1.8 },
  { dirOffset: -0.7, wavelength: 13, amp: 0.12, speedMul: 1.1, sharp: 2.0 },
  { dirOffset: 1.3, wavelength: 7.5, amp: 0.06, speedMul: 1.2, sharp: 2.2 },
];

const G = 9.81;

export function waveHeight(x: number, z: number, t: number, sea: SeaState): number {
  let h = 0;
  for (let i = 0; i < WAVES.length; i++) {
    const w = WAVES[i]!;
    const dir = sea.windDir + w.dirOffset;
    const k = (Math.PI * 2) / w.wavelength;
    const c = Math.sqrt(G / k) * w.speedMul;
    const phase = k * (Math.cos(dir) * x + Math.sin(dir) * z - c * t);
    // sharpened crest: map sin to [0,1], raise to power, back to [-1,1]
    const s = Math.pow((Math.sin(phase) + 1) * 0.5, w.sharp) * 2 - 1;
    h += s * w.amp;
  }
  return h * sea.amplitude;
}

/** Approximate surface normal via central differences. */
export function waveNormal(x: number, z: number, t: number, sea: SeaState): [number, number, number] {
  const e = 0.5;
  const hx = waveHeight(x + e, z, t, sea) - waveHeight(x - e, z, t, sea);
  const hz = waveHeight(x, z + e, t, sea) - waveHeight(x, z - e, t, sea);
  const nx = -hx / (2 * e), nz = -hz / (2 * e);
  const len = Math.hypot(nx, 1, nz);
  return [nx / len, 1 / len, nz / len];
}

/** Shallow water dampens waves near shore (depth = positive meters below sea level). */
export function shoreDamping(depth: number): number {
  if (depth <= 0) return 0.15;
  return Math.min(1, 0.15 + depth / 6);
}
