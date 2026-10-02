import type { CropDef } from './types';

export const CROP_LIST: CropDef[] = [
  { id: 'taro', name: 'Taro', seed: 'taro_seed', growHours: 36, stages: 4, harvest: [{ item: 'taro_raw', min: 2, max: 4 }], seedReturn: { min: 1, max: 2 }, minTemp: 18, maxTemp: 38, waterNeed: 5 },
  { id: 'aloe', name: 'Aloe', seed: 'aloe_seed', growHours: 30, stages: 4, harvest: [{ item: 'aloe', min: 2, max: 4 }], seedReturn: { min: 1, max: 2 }, minTemp: 15, maxTemp: 42, waterNeed: 2 },
  { id: 'flax', name: 'Flax', seed: 'flax_seed', growHours: 24, stages: 4, harvest: [{ item: 'fiber', min: 6, max: 10 }], seedReturn: { min: 1, max: 2 }, minTemp: 14, maxTemp: 34, waterNeed: 4 },
  { id: 'berry', name: 'Berry Bush', seed: 'berry_seed', growHours: 40, stages: 4, harvest: [{ item: 'berries', min: 4, max: 7 }], seedReturn: { min: 1, max: 2 }, minTemp: 16, maxTemp: 36, waterNeed: 4 },
];
export const CROPS: Readonly<Record<string, CropDef>> = Object.fromEntries(CROP_LIST.map((c) => [c.id, c]));
