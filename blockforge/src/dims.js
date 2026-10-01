// Dimension registry: terrain generator and lighting per dimension.
import { WorldGen } from './worldgen.js';
import { UnderworldGen } from './underworld.js';
import { VoidGen } from './voidlands.js';

export const DIMENSIONS = ['overworld', 'underworld', 'void'];
export const noSky = (dim) => dim === 'underworld' || dim === 'void';
export function makeGenerator(dim, seed) {
  if (dim === 'underworld') return new UnderworldGen(seed);
  if (dim === 'void') return new VoidGen(seed);
  return new WorldGen(seed);
}
export const DIM_NAMES = { overworld: 'the Overworld', underworld: 'the Underworld', void: 'the Void' };
