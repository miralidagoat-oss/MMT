// Status effects, potions and brewing recipes.
import { I, ITEMS } from './items.js';
import { B } from './blocks.js';

export const EFFECTS = {
  speed: { name: 'Swiftness', color: [110, 190, 230], good: true },
  slowness: { name: 'Slowness', color: [80, 96, 120] },
  strength: { name: 'Strength', color: [190, 40, 40], good: true },
  weakness: { name: 'Weakness', color: [90, 90, 84] },
  regeneration: { name: 'Regeneration', color: [220, 110, 190], good: true },
  poison: { name: 'Poison', color: [90, 160, 50] },
  fire_resistance: { name: 'Fire Resistance', color: [240, 150, 50], good: true },
  water_breathing: { name: 'Water Breathing', color: [50, 110, 200], good: true },
  night_vision: { name: 'Night Vision', color: [60, 60, 200], good: true },
  invisibility: { name: 'Invisibility', color: [180, 186, 200], good: true },
  jump_boost: { name: 'Leaping', color: [120, 230, 90], good: true },
  slow_falling: { name: 'Slow Falling', color: [240, 220, 200], good: true },
  absorption: { name: 'Absorption', color: [240, 200, 60], good: true },
  sea_grace: { name: 'Sea Grace', color: [80, 170, 230], good: true },
  ill_omen: { name: 'Ill Omen', color: [40, 70, 40] },
  village_hero: { name: 'Village Hero', color: [70, 200, 90], good: true },
  darkness: { name: 'Darkness', color: [34, 38, 52] },
  instant_health: { name: 'Healing', color: [250, 80, 90], good: true, instant: true },
  instant_damage: { name: 'Harming', color: [90, 20, 40], instant: true },
};

// Potion kind -> effect, durations in ticks (base, extended, level II).
export const POTIONS = {
  swiftness: { effect: 'speed', dur: 3600, long: 9600, strong: 1800 },
  slowness: { effect: 'slowness', dur: 1800, long: 4800, strong: 400, strongAmp: 3 },
  strength: { effect: 'strength', dur: 3600, long: 9600, strong: 1800 },
  weakness: { effect: 'weakness', dur: 1800, long: 4800 },
  healing: { effect: 'instant_health' },
  harming: { effect: 'instant_damage' },
  regeneration: { effect: 'regeneration', dur: 900, long: 1800, strong: 440 },
  poison: { effect: 'poison', dur: 900, long: 1800, strong: 420 },
  fire_resistance: { effect: 'fire_resistance', dur: 3600, long: 9600 },
  water_breathing: { effect: 'water_breathing', dur: 3600, long: 9600 },
  night_vision: { effect: 'night_vision', dur: 3600, long: 9600 },
  invisibility: { effect: 'invisibility', dur: 3600, long: 9600 },
  leaping: { effect: 'jump_boost', dur: 3600, long: 9600, strong: 1800 },
  slow_falling: { effect: 'slow_falling', dur: 1800, long: 4800 },
};

// The effect a potion stack gives: { effect, amp, ticks } (ticks 0 = instant).
export function potionEffect(stack) {
  const d = ITEMS[stack.id];
  if (!d || !d.potion || !POTIONS[d.potion]) return null;
  const p = POTIONS[d.potion];
  const lvl = stack.pot && stack.pot.lvl === 2 ? 1 : 0;
  const long = stack.pot && stack.pot.long;
  if (EFFECTS[p.effect].instant) return { effect: p.effect, amp: lvl, ticks: 0 };
  const ticks = lvl && p.strong ? p.strong : long && p.long ? p.long : p.dur;
  return { effect: p.effect, amp: lvl ? (p.strongAmp || 1) : 0, ticks };
}

export function potionLabel(stack) {
  const fx = potionEffect(stack);
  if (!fx) return '';
  const name = EFFECTS[fx.effect].name + (fx.amp ? ' ' + ['', 'II', 'III', 'IV'][fx.amp] : '');
  return fx.ticks ? `${name} (${fmtTime(fx.ticks)})` : name;
}

export const fmtTime = (ticks) => {
  const s = Math.ceil(ticks / 20);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// ---------------------------------------------------------------------------
// Brewing: what a bottle becomes with an ingredient, or null.
const BASE = () => ({
  [I.sugar]: 'swiftness', [I.ember_dust]: 'strength', [I.glistering_melon]: 'healing', [I.crawler_eye]: 'poison',
  [I.imp_horn]: 'regeneration', [I.golden_carrot]: 'night_vision', [I.pufferfish]: 'water_breathing',
  [B.magma_rock]: 'fire_resistance', [I.feather]: 'slow_falling', [I.string]: 'leaping', [I.rabbit_foot]: 'leaping',
  [I.scute]: 'water_breathing',
});
const CORRUPT = { swiftness: 'slowness', leaping: 'slowness', healing: 'harming', poison: 'harming', night_vision: 'invisibility', strength: 'weakness', regeneration: 'weakness' };
let baseMap = null;

export function isIngredient(id) {
  baseMap = baseMap || BASE();
  return !!baseMap[id] || id === B.glowcap || id === I.fermented_crawler_eye || id === I.spark_dust || id === B.ember_crystal || id === I.blast_powder;
}

export function brew(stack, ingredient) {
  baseMap = baseMap || BASE();
  const d = ITEMS[stack.id];
  if (!d || !d.potion) return null;
  const kind = d.potion, splash = !!d.splash;
  const make = (k, pot, toSplash = splash) => {
    const id = I[(toSplash ? 'splash_potion_' : 'potion_') + k] ?? (toSplash ? null : I['potion_' + k]);
    if (id === undefined || id === null) return null;
    const out = { id, count: 1 };
    if (pot && (pot.lvl || pot.long)) out.pot = { ...pot };
    return out;
  };
  if (kind === 'water') {
    if (ingredient === B.glowcap) return { id: I.potion_awkward, count: 1 };
    if (ingredient === I.fermented_crawler_eye) return make('weakness', null);
    return null;
  }
  if (kind === 'awkward') {
    const k = baseMap[ingredient];
    return k ? make(k, null) : null;
  }
  if (!POTIONS[kind]) return null;
  if (ingredient === I.fermented_crawler_eye) return CORRUPT[kind] ? make(CORRUPT[kind], stack.pot) : null;
  if (ingredient === I.spark_dust) {
    if (!POTIONS[kind].long || (stack.pot && stack.pot.long)) return null;
    return make(kind, { long: true });
  }
  if (ingredient === B.ember_crystal) {
    if ((!POTIONS[kind].strong && !['healing', 'harming'].includes(kind)) || (stack.pot && stack.pot.lvl === 2)) return null;
    return make(kind, { lvl: 2 });
  }
  if (ingredient === I.blast_powder) return splash ? null : make(kind, stack.pot, true);
  return null;
}

// ---------------------------------------------------------------------------
// Effect state on an entity: e.effects = { name: { amp, time } }.
export function addEffect(e, name, amp, ticks) {
  if (!e.effects) e.effects = {};
  const cur = e.effects[name];
  if (cur && cur.amp > amp) return;
  if (cur && cur.amp === amp && cur.time > ticks) return;
  e.effects[name] = { amp, time: ticks };
  if (name === 'absorption' && e.isPlayer) e.absorption = Math.max(e.absorption || 0, 4 * (amp + 1));
}

export const effectAmp = (e, name) => (e.effects && e.effects[name] ? e.effects[name].amp : -1);
export const hasEffect = (e, name) => !!(e.effects && e.effects[name]);
