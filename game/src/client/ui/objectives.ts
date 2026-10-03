/** Tutorial / progression objectives derived from replicated player + world state. */
import type { ClientSession } from '../net/session';

export interface Objective { id: string; title: string; hint: string; done: (s: ClientSession) => boolean }

const has = (s: ClientSession, ids: string[]) => ids.some((i) => s.me?.discovered.includes(i));
const ms = (s: ClientSession, id: string) => !!s.me?.milestones.includes(id) || !!s.progression?.milestones.includes(id);
const built = (s: ClientSession, types: string[]) => Object.values(s.structures).some((x) => types.includes(x.type));

export const OBJECTIVES: Objective[] = [
  { id: 'gather', title: 'Scavenge the beach', hint: 'Pick up sticks, stones and fiber with E.', done: (s) => has(s, ['stick']) && has(s, ['stone']) && has(s, ['fiber']) },
  { id: 'coconut', title: 'Quench your thirst', hint: 'Find a fallen coconut and drink it (F or right-click it in your inventory).', done: (s) => ms(s, 'drank_coconut') || ms(s, 'clean_water') },
  { id: 'axe', title: 'Craft a stone axe', hint: 'Open crafting (Q). Cordage comes from fiber.', done: (s) => has(s, ['stone_axe', 'metal_axe']) },
  { id: 'tree', title: 'Fell a palm tree', hint: 'Hold the axe and strike a palm repeatedly.', done: (s) => ms(s, 'felled_tree') },
  { id: 'fire', title: 'Make fire', hint: 'Craft a Builder\'s Mallet, build a campfire (B), add fuel and light it with a hand drill or torch.', done: (s) => ms(s, 'first_fire') },
  { id: 'cook', title: 'Cook a meal', hint: 'Put raw crab, fish or taro on a lit campfire. Don\'t let it burn!', done: (s) => has(s, ['crab_cooked', 'fish_cooked', 'meat_cooked', 'taro_cooked', 'shark_cooked']) },
  { id: 'shelter', title: 'Build a shelter', hint: 'A lean-to or a roofed hut keeps the rain off and sets your respawn.', done: (s) => built(s, ['lean_to', 'bed']) || ms(s, 'built_shelter') },
  { id: 'bench', title: 'Build a workbench', hint: 'Unlocks planks, fishing rods, bows and leatherwork.', done: (s) => built(s, ['workbench']) },
  { id: 'water', title: 'Secure fresh water', hint: 'Build a rain catcher, or distill sea water in a clay pot on the fire.', done: (s) => ms(s, 'clean_water') },
  { id: 'fish', title: 'Catch a fish', hint: 'Craft a fishing rod or spear fish in the shallows.', done: (s) => ms(s, 'caught_fish') || has(s, ['fish_raw']) },
  { id: 'raft', title: 'Take to the sea', hint: 'Build a log raft in waist-deep water with the mallet.', done: (s) => ms(s, 'built_boat') },
  { id: 'island', title: 'Discover another island', hint: 'Paddle to an island on the horizon. Watch for sharks and storms.', done: (s) => (s.progression?.discoveredIslands.length ?? 0) > 1 },
  { id: 'wreck', title: 'Loot a shipwreck', hint: 'Dive to a wreck. Crates hold salvage, cloth and metal.', done: (s) => ms(s, 'looted_wreck') },
  { id: 'kiln', title: 'Smelt metal', hint: 'Build a clay kiln, make charcoal and smelt scrap into ingots.', done: (s) => has(s, ['metal_ingot']) },
  { id: 'forge', title: 'Build a forge', hint: 'Bricks and ingots make a forge — the key to metal tools.', done: (s) => built(s, ['forge']) },
  { id: 'parts', title: 'Salvage electronics', hint: 'Deep wrecks (far from the start island) hold circuit boards and batteries.', done: (s) => has(s, ['circuit_board']) && has(s, ['battery_cell']) },
  { id: 'core', title: 'Assemble the beacon core', hint: 'Forge an antenna, then the beacon core.', done: (s) => has(s, ['beacon_core']) || !!s.progression?.beaconId },
  { id: 'beacon', title: 'Signal for rescue', hint: 'Build the distress beacon on a high peak and switch it on.', done: (s) => !!s.progression?.beaconId },
  { id: 'rescue', title: 'Hold out until rescue', hint: 'Keep the beacon standing for 12 hours.', done: (s) => !!s.progression?.rescued },
];

export function currentObjective(s: ClientSession): Objective | null {
  return OBJECTIVES.find((o) => !o.done(s)) ?? null;
}
