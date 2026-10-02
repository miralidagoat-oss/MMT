import { GAME_DAY_SECONDS } from './items';
import type { CreatureDef, CreatureKind } from './types';

export const CREATURE_LIST: CreatureDef[] = [
  {
    id: 'crab', name: 'Shore Crab', habitat: 'beach', maxHp: 14, speed: 0.9, runSpeed: 2.6, aggression: 'defensive',
    sightRange: 8, hearingRange: 6, attackRange: 1.0, attackDamage: 4, attackCooldown: 1.4, fleeHealthFraction: 0.5,
    loot: [{ item: 'crab_raw', min: 1, max: 2 }, { item: 'shell', min: 0, max: 1 }], radius: 0.35, aquatic: false, respawnSeconds: GAME_DAY_SECONDS * 0.5,
  },
  {
    id: 'boar', name: 'Wild Boar', habitat: 'jungle', maxHp: 90, speed: 1.6, runSpeed: 6.4, aggression: 'territorial',
    sightRange: 22, hearingRange: 16, attackRange: 1.7, attackDamage: 16, attackCooldown: 1.3, bleedChance: 0.25, fleeHealthFraction: 0.2,
    loot: [{ item: 'meat_raw', min: 2, max: 4 }, { item: 'hide', min: 1, max: 2 }, { item: 'bone', min: 1, max: 3 }, { item: 'animal_fat', min: 1, max: 1 }],
    butcherTool: 'cut', radius: 0.6, aquatic: false, respawnSeconds: GAME_DAY_SECONDS * 1.5,
  },
  {
    id: 'snake', name: 'Banded Viper', habitat: 'jungle', maxHp: 20, speed: 0.8, runSpeed: 3.2, aggression: 'defensive',
    sightRange: 6, hearingRange: 9, attackRange: 1.4, attackDamage: 8, attackCooldown: 1.6, poisonChance: 0.6, fleeHealthFraction: 0.4,
    loot: [{ item: 'meat_raw', min: 1, max: 1 }, { item: 'hide', min: 0, max: 1 }], butcherTool: 'cut', radius: 0.3, aquatic: false, nocturnalBoost: 1.5,
    respawnSeconds: GAME_DAY_SECONDS,
  },
  {
    id: 'fish', name: 'Reef Fish', habitat: 'shallows', maxHp: 8, speed: 1.4, runSpeed: 5, aggression: 'passive',
    sightRange: 7, hearingRange: 5, attackRange: 0, attackDamage: 0, attackCooldown: 99, fleeHealthFraction: 1,
    loot: [{ item: 'fish_raw', min: 1, max: 1 }], radius: 0.25, aquatic: true, respawnSeconds: GAME_DAY_SECONDS * 0.3,
  },
  {
    id: 'ray', name: 'Spotted Ray', habitat: 'shallows', maxHp: 40, speed: 1.1, runSpeed: 3.6, aggression: 'defensive',
    sightRange: 5, hearingRange: 4, attackRange: 1.6, attackDamage: 14, attackCooldown: 2.4, poisonChance: 0.5, fleeHealthFraction: 0.6,
    loot: [{ item: 'fish_raw', min: 2, max: 3 }], butcherTool: 'cut', radius: 0.8, aquatic: true, respawnSeconds: GAME_DAY_SECONDS,
  },
  {
    id: 'shark', name: 'Reef Shark', habitat: 'deep', maxHp: 160, speed: 2.4, runSpeed: 7.2, aggression: 'predator',
    sightRange: 34, hearingRange: 40, attackRange: 2.2, attackDamage: 26, attackCooldown: 2.2, bleedChance: 0.6, fleeHealthFraction: 0.3,
    loot: [{ item: 'shark_raw', min: 2, max: 4 }, { item: 'shark_tooth', min: 1, max: 3 }, { item: 'hide', min: 1, max: 2 }, { item: 'animal_fat', min: 1, max: 2 }],
    butcherTool: 'cut', radius: 1.1, aquatic: true, nocturnalBoost: 1.3, respawnSeconds: GAME_DAY_SECONDS,
  },
  {
    id: 'gull', name: 'Gull', habitat: 'air', maxHp: 6, speed: 4, runSpeed: 9, aggression: 'passive',
    sightRange: 14, hearingRange: 14, attackRange: 0, attackDamage: 0, attackCooldown: 99, fleeHealthFraction: 1,
    loot: [{ item: 'meat_raw', min: 1, max: 1 }], radius: 0.3, aquatic: false, respawnSeconds: GAME_DAY_SECONDS * 0.5,
  },
];

export const CREATURES = Object.fromEntries(CREATURE_LIST.map((c) => [c.id, c])) as Record<CreatureKind, CreatureDef>;
