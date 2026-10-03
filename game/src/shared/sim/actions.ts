/**
 * Authoritative handlers for every client intent. Each handler validates range,
 * possession, tool requirements, cooldowns and state before mutating anything.
 */
import { BUILD, PLAYER, SURVIVAL, TIME, VEHICLE } from '../config';
import { ITEMS } from '../defs/items';
import { NODES } from '../defs/nodes';
import { STRUCTURES } from '../defs/structures';
import { CROPS } from '../defs/crops';
import { CREATURES } from '../defs/creatures';
import { VEHICLES } from '../defs/vehicles';
import { LOOT_TABLES } from '../defs/loot';
import type { EquipSlot } from '../defs/types';
import { addStack, hasItems, moveBetween, removeItem, wear, makeStack, countItem, type SlotRef } from '../systems/inventory';
import { validateGeometry, findUnsupported } from '../systems/building';
import type { Action } from '../net/protocol';
import type { ContainerState, ItemStack, PlayerState, Slots, StructureState, WeatherKind, WorldEvent } from '../state';
import { forceWeather } from '../systems/weather';
import { startEvent } from './events';
import type { Simulation } from './simulation';
import { startCraft, cancelCraft } from './crafting';
import { damageCreature, butcher } from './wildlife';
import { boardVehicle, createVehicle } from './vehicles';
import { ignite, stationSlots } from './stations';
import { startFishing, reel } from './fishing';
import { fireProjectile } from './combat';

type R = { ok: boolean; reason?: string };
const OK: R = { ok: true };
const fail = (reason: string): R => ({ ok: false, reason });

const CONTAINER_RANGE = 5;

export function handleAction(sim: Simulation, p: PlayerState, act: Action): R {
  if (!act || typeof act !== 'object' || typeof (act as { a?: unknown }).a !== 'string') return fail('Malformed');
  // actions allowed while dead/downed
  if (p.dead) {
    if (act.a === 'respawn') return sim.respawnPlayer(p, act.at === 'bed' ? 'bed' : 'beach') ? OK : fail('Cannot respawn');
    if (act.a === 'chat') return chat(sim, p, act.text);
    return fail('You are dead');
  }
  if (p.downed > 0 && act.a !== 'chat') return fail('You are down — wait for help');
  if (p.sleeping && act.a !== 'wake' && act.a !== 'chat') return fail('You are asleep');

  switch (act.a) {
    case 'use': return use(sim, p, act);
    case 'gather': return gather(sim, p, String(act.nodeId));
    case 'pickup': return pickup(sim, p, String(act.itemId));
    case 'interact': return interact(sim, p, act);
    case 'close_container': p.openContainer = null; sim.markPlayer(p.id); return OK;
    case 'move': return move(sim, p, act.from, act.to, act.qty);
    case 'quick_move': return quickMove(sim, p, act.from);
    case 'drop': return drop(sim, p, act.from, act.qty);
    case 'consume': return consume(sim, p, act.from);
    case 'equip': return equip(sim, p, act.from);
    case 'hotbar': {
      const i = Math.floor(Number(act.index));
      if (!(i >= 0 && i < PLAYER.hotbarSlots)) return fail('Bad slot');
      p.hotbar = i;
      if (p.fishing) p.fishing = null;
      sim.markPlayer(p.id);
      return OK;
    }
    case 'craft': return startCraft(sim, p, String(act.recipe), act.count);
    case 'craft_cancel': return cancelCraft(sim, p, Math.floor(Number(act.index)));
    case 'build': return build(sim, p, act);
    case 'demolish': return demolish(sim, p, String(act.id));
    case 'upgrade': return upgrade(sim, p, String(act.id));
    case 'repair': return repair(sim, p, String(act.id));
    case 'fill': return fill(sim, p, act.from, act.source, act.id);
    case 'drink_source': return drinkSource(sim, p, act.source, act.id);
    case 'fish_cast': return startFishing(sim, p, Number(act.x), Number(act.z));
    case 'fish_reel': return reel(sim, p);
    case 'shoot': return shoot(sim, p, act.yaw, act.pitch, act.charge);
    case 'board': {
      const v = sim.world.vehicles[String(act.id)];
      return v ? boardVehicle(sim, v, p) : fail('No such boat');
    }
    case 'leave_vehicle': if (!p.vehicleId) return fail('Not aboard'); sim.leaveVehicle(p); sim.markPlayer(p.id); return OK;
    case 'anchor': case 'sail': {
      const v = sim.world.vehicles[String(act.id)];
      if (!v || (p.vehicleId !== v.id && Math.hypot(v.x - p.pos.x, v.z - p.pos.z) > VEHICLE.boardRange + 2)) return fail('Not near the boat');
      if (act.a === 'anchor') { v.anchored = !v.anchored; sim.fx('anchor', v.x, v.y, v.z, v.anchored ? 'down' : 'up'); }
      else { if (!VEHICLES[v.type]!.sailForce) return fail('This boat has no sail'); v.sail = !v.sail; sim.fx('sail', v.x, v.y, v.z, v.sail ? 'up' : 'down'); }
      return OK;
    }
    case 'respawn': return fail('You are alive');
    case 'revive': return revive(sim, p, String(act.id));
    case 'sleep': return sleep(sim, p, String(act.id));
    case 'wake': p.sleeping = false; sim.markPlayer(p.id); return OK;
    case 'waypoint_add': {
      const x = Number(act.x), z = Number(act.z);
      if (!Number.isFinite(x) || !Number.isFinite(z)) return fail('Bad position');
      if (sim.world.waypoints.length >= 40) sim.world.waypoints.shift();
      sim.world.waypoints.push({ id: sim.newId('w'), x, z, label: String(act.label ?? '').slice(0, 24) || 'Marker', color: p.color, owner: p.id });
      sim.out.dirty.add('w');
      return OK;
    }
    case 'waypoint_remove': {
      const before = sim.world.waypoints.length;
      sim.world.waypoints = sim.world.waypoints.filter((w) => w.id !== act.id);
      if (before !== sim.world.waypoints.length) sim.out.dirty.add('w');
      return OK;
    }
    case 'plant': return plant(sim, p, String(act.id), Math.floor(Number(act.plot)), act.from);
    case 'harvest_crop': return harvestCrop(sim, p, String(act.id), Math.floor(Number(act.plot)));
    case 'water_crop': return waterCrop(sim, p, String(act.id), act.from);
    case 'ignite': {
      const s = sim.world.structures[String(act.id)];
      if (!s || !inRange(p, s, 4)) return fail('Too far');
      // prefer the held tool, otherwise use any fire starter in the pack
      let slot = p.hotbar;
      const canIgnite = (i: number) => !!p.inventory.slots[i] && !!ITEMS[p.inventory.slots[i]!.id]?.tool?.actions.includes('ignite');
      if (!canIgnite(slot)) slot = p.inventory.slots.findIndex((_, i) => canIgnite(i));
      const held = slot >= 0 ? p.inventory.slots[slot]! : null;
      const r = ignite(sim, s, held?.id);
      if (held && held.id !== 'lantern' && r.reason !== 'Already burning') {
        if (wear(p.inventory.slots, slot, held.id === 'torch' ? 20 : 1)) sim.notify(p.id, 'Your fire starter wore out.', 'warn');
        sim.markPlayer(p.id);
      }
      if (r.ok) sim.milestone(p, 'first_fire', 'Fire! Cook food and boil water in a clay pot over it.');
      return r;
    }
    case 'beacon': return activateBeacon(sim, p, String(act.id));
    case 'chat': return chat(sim, p, act.text);
    default: return fail('Unknown action');
  }
}

// ------------------------------------------------------------------ helpers
function inRange(p: PlayerState, t: { x: number; y?: number; z: number }, r: number): boolean {
  return Math.hypot(t.x - p.pos.x, ((t.y ?? p.pos.y) - p.pos.y) * 0.6, t.z - p.pos.z) <= r;
}

function chat(sim: Simulation, p: PlayerState, text: unknown): R {
  const t = String(text ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 200);
  if (!t) return fail('Empty');
  if (t.startsWith('/')) return command(sim, p, t.slice(1).split(/\s+/));
  sim.out.chat.push({ from: p.id, name: p.name, text: t });
  return OK;
}

/** Debug / admin commands, only when the world was created with cheats enabled. */
function command(sim: Simulation, p: PlayerState, args: string[]): R {
  const [cmd, a1, a2] = args;
  if (cmd === 'help') { sim.notify(p.id, 'Commands: /time <hour> · /weather <clear|cloudy|rain|storm|fog> · /give <item> [qty] · /tp <x> <z> · /heal · /event <kind> · /kill', 'info'); return OK; }
  if (!sim.world.settings.cheats) return fail('Cheats are disabled in this world');
  switch (cmd) {
    case 'time': {
      const hr = Number(a1);
      if (!Number.isFinite(hr)) return fail('Usage: /time <hour>');
      const day = TIME.dayLengthSeconds;
      const cur = ((sim.world.time + sim.world.dayOffset) % day + day) % day;
      sim.world.dayOffset += (((hr % 24) / 24) * day - cur + day) % day;
      return OK;
    }
    case 'weather': {
      const k = a1 as WeatherKind;
      if (!['clear', 'cloudy', 'rain', 'storm', 'fog'].includes(k)) return fail('Unknown weather');
      forceWeather(sim.world.weather, k, sim.now, sim.rng);
      sim.world.weather.blend = 1; sim.world.weather.kind = k; sim.world.weather.next = k;
      return OK;
    }
    case 'give': {
      if (!a1 || !ITEMS[a1]) return fail('Unknown item');
      sim.give(p, a1, Math.max(1, Math.min(500, Math.floor(Number(a2) || 1))));
      return OK;
    }
    case 'tp': {
      const x = Number(a1), z = Number(a2);
      if (!Number.isFinite(x) || !Number.isFinite(z)) return fail('Usage: /tp <x> <z>');
      if (p.vehicleId) sim.leaveVehicle(p);
      p.pos = { x, y: Math.max(sim.gen.heightAt(x, z), sim.waterLevel(x, z) - 1.4) + 0.1, z };
      p.vel = { x: 0, y: 0, z: 0 };
      sim.markPlayer(p.id);
      return OK;
    }
    case 'heal':
      p.health = 100; p.hunger = 100; p.thirst = 100; p.stamina = 100; p.oxygen = 100; p.bodyTemp = 37; p.effects = {};
      sim.markPlayer(p.id);
      return OK;
    case 'kill': sim.kill(p, 'command'); return OK;
    case 'event': {
      const k = a1 as WorldEvent['kind'];
      if (!['supply_drop', 'storm_front', 'shark_frenzy', 'fish_run'].includes(k)) return fail('Unknown event');
      startEvent(sim, k);
      return OK;
    }
  }
  return fail('Unknown command (try /help)');
}

/** Resolve a slot reference to (array, index) with authority checks. */
function resolve(sim: Simulation, p: PlayerState, ref: SlotRef | undefined): { slots: Slots; i: number; box?: ContainerState } | null {
  if (!ref || typeof ref !== 'object') return null;
  if (ref.c === 'inv') {
    const i = Math.floor(Number(ref.i));
    if (!(i >= 0 && i < p.inventory.slots.length)) return null;
    return { slots: p.inventory.slots, i };
  }
  if (ref.c === 'box') {
    if (p.openContainer !== ref.id) return null;
    const box = sim.world.containers[ref.id];
    if (!box || !containerReachable(sim, p, box)) return null;
    const i = Math.floor(Number(ref.i));
    if (!(i >= 0 && i < box.slots.length)) return null;
    return { slots: box.slots, i, box };
  }
  return null;
}

function containerReachable(sim: Simulation, p: PlayerState, box: ContainerState): boolean {
  if (box.kind === 'cargo') {
    const v = Object.values(sim.world.vehicles).find((vv) => vv.containerId === box.id);
    if (v && p.vehicleId === v.id) return true;
  }
  return inRange(p, box, CONTAINER_RANGE);
}

/** Wrap equip slot as a single-element array view. */
function equipView(p: PlayerState, s: EquipSlot): Slots {
  return [p.inventory.equip[s]];
}

function stationAccepts(sim: Simulation, box: ContainerState, i: number, stack: ItemStack): string | null {
  const owner = Object.values(sim.world.structures).find((s) => s.containerId === box.id);
  if (!owner) return null;
  const def = STRUCTURES[owner.type]!;
  if (def.fire && i === 0 && !ITEMS[stack.id]?.fuelSeconds) return 'Only fuel goes in the fuel slot';
  if (def.fire && i > 0 && !ITEMS[stack.id]?.food?.cooksTo && stack.id !== 'clay_pot') return 'That cannot be cooked';
  if (def.dryingRack && !ITEMS[stack.id]?.food?.dryTo) return 'That cannot be dried';
  return null;
}

function afterContainerChange(sim: Simulation, box?: ContainerState) {
  if (!box) return;
  sim.markContainer(box.id);
  if (box.transient && box.slots.every((s) => !s)) sim.removeContainer(box.id, false);
}

// ------------------------------------------------------------------ inventory actions
function move(sim: Simulation, p: PlayerState, from: SlotRef, to: SlotRef, qty?: number): R {
  if (from?.c === 'equip' || to?.c === 'equip') return moveEquip(sim, p, from, to);
  const a = resolve(sim, p, from), b = resolve(sim, p, to);
  if (!a || !b) return fail('Invalid slot');
  const st = a.slots[a.i];
  if (!st) return fail('Empty slot');
  if (b.box) { const err = stationAccepts(sim, b.box, b.i, st); if (err) return fail(err); }
  const dst = b.slots[b.i];
  if (a.box && dst) { const err = stationAccepts(sim, a.box, a.i, dst); if (err) return fail(err); }
  if (!moveBetween(a.slots, a.i, b.slots, b.i, qty)) return fail('Cannot move there');
  const moved = b.slots[b.i];
  if (moved) sim.discover(p, moved.id);
  sim.markPlayer(p.id);
  afterContainerChange(sim, a.box);
  afterContainerChange(sim, b.box);
  return OK;
}

function moveEquip(sim: Simulation, p: PlayerState, from: SlotRef, to: SlotRef): R {
  if (from?.c === 'equip' && to?.c === 'inv') {
    const s = from.s;
    const st = p.inventory.equip[s];
    if (!st) return fail('Empty');
    const i = Math.floor(Number(to.i));
    if (!(i >= 0 && i < p.inventory.slots.length)) return fail('Bad slot');
    const dst = p.inventory.slots[i];
    if (dst && ITEMS[dst.id]?.equip?.slot !== s) return fail('Slot occupied');
    p.inventory.slots[i] = st;
    p.inventory.equip[s] = dst ?? null;
    sim.markPlayer(p.id);
    return OK;
  }
  if (to?.c === 'equip') return equip(sim, p, from, to.s);
  return fail('Invalid');
}

function equip(sim: Simulation, p: PlayerState, from: SlotRef, want?: EquipSlot): R {
  if (from?.c === 'equip') {
    // unequip to first free inventory slot
    const st = p.inventory.equip[from.s];
    if (!st) return fail('Empty');
    const free = p.inventory.slots.indexOf(null);
    if (free < 0) return fail('Inventory full');
    p.inventory.slots[free] = st;
    p.inventory.equip[from.s] = null;
    sim.markPlayer(p.id);
    return OK;
  }
  const a = resolve(sim, p, from);
  if (!a) return fail('Invalid slot');
  const st = a.slots[a.i];
  const slot = st ? ITEMS[st.id]?.equip?.slot : undefined;
  if (!st || !slot) return fail('Not wearable');
  if (want && want !== slot) return fail(`Goes in the ${slot} slot`);
  const prev = p.inventory.equip[slot];
  p.inventory.equip[slot] = st;
  a.slots[a.i] = prev;
  void equipView;
  sim.markPlayer(p.id);
  afterContainerChange(sim, a.box);
  sim.fx('equip', p.pos.x, p.pos.y, p.pos.z, st.id, undefined, p.id);
  return OK;
}

function quickMove(sim: Simulation, p: PlayerState, from: SlotRef): R {
  const a = resolve(sim, p, from);
  if (!a) return fail('Invalid slot');
  const st = a.slots[a.i];
  if (!st) return fail('Empty');
  let target: Slots;
  let box: ContainerState | undefined;
  if (a.box) target = p.inventory.slots;
  else {
    if (!p.openContainer) {
      // inventory <-> hotbar shuffle
      const isHot = a.i < PLAYER.hotbarSlots;
      const range = isHot ? [PLAYER.hotbarSlots, p.inventory.slots.length] : [0, PLAYER.hotbarSlots];
      for (let i = range[0]!; i < range[1]!; i++) if (!p.inventory.slots[i]) { p.inventory.slots[i] = st; a.slots[a.i] = null; sim.markPlayer(p.id); return OK; }
      return fail('No room');
    }
    box = sim.world.containers[p.openContainer];
    if (!box || !containerReachable(sim, p, box)) return fail('Container out of reach');
    target = box.slots;
  }
  if (box) {
    // station containers: route into an accepting slot
    for (let i = 0; i < box.slots.length; i++) {
      if (stationAccepts(sim, box, i, st)) continue;
      if (moveBetween(a.slots, a.i, box.slots, i)) { sim.markPlayer(p.id); afterContainerChange(sim, box); return OK; }
    }
    return fail('No room');
  }
  const copy = { ...st };
  addStack(target, copy);
  if (copy.qty === st.qty) return fail('No room');
  if (copy.qty > 0) st.qty = copy.qty; else a.slots[a.i] = null;
  sim.discover(p, st.id);
  sim.markPlayer(p.id);
  afterContainerChange(sim, a.box);
  return OK;
}

function drop(sim: Simulation, p: PlayerState, from: SlotRef, qty?: number): R {
  let st: ItemStack | null;
  let box: ContainerState | undefined;
  if (from?.c === 'equip') { st = p.inventory.equip[from.s]; if (!st) return fail('Empty'); p.inventory.equip[from.s] = null; }
  else {
    const a = resolve(sim, p, from);
    if (!a) return fail('Invalid slot');
    st = a.slots[a.i];
    if (!st) return fail('Empty');
    box = a.box;
    const n = qty === undefined ? st.qty : Math.floor(Number(qty));
    if (!(n >= 1 && n <= st.qty)) return fail('Bad quantity');
    if (n < st.qty) { st.qty -= n; st = { ...st, qty: n }; } else a.slots[a.i] = null;
  }
  const fx = -Math.sin(p.yaw) * 0.9, fz = -Math.cos(p.yaw) * 0.9;
  sim.spawnItem(st, p.pos.x + fx, p.pos.y + 1, p.pos.z + fz);
  sim.markPlayer(p.id);
  afterContainerChange(sim, box);
  return OK;
}

function consume(sim: Simulation, p: PlayerState, from: SlotRef): R {
  const a = resolve(sim, p, from);
  if (!a) return fail('Invalid slot');
  const st = a.slots[a.i];
  if (!st) return fail('Empty');
  const def = ITEMS[st.id];
  if (!def) return fail('Unknown item');
  if (def.water && def.id !== 'watering_can') {
    if (!st.water || st.water < 1) return fail('It is empty');
    st.water -= 1;
    drinkWater(sim, p, st.quality ?? 'salt', def.water.hydrationPerUnit);
    if (st.water <= 0) { st.water = 0; delete st.quality; }
    sim.markPlayer(p.id);
    afterContainerChange(sim, a.box);
    return OK;
  }
  if (def.food) {
    const f = def.food;
    if (p.effects.nausea && f.nutrition > 5) return fail('You feel too sick to eat');
    if (p.hunger >= SURVIVAL.maxHunger - 1 && f.nutrition > 0 && f.hydration <= 0) return fail('You are full');
    p.hunger = Math.min(SURVIVAL.maxHunger, p.hunger + f.nutrition);
    p.thirst = Math.max(0, Math.min(SURVIVAL.maxThirst, p.thirst + f.hydration));
    if (f.health) p.health = Math.min(SURVIVAL.maxHealth, p.health + f.health);
    if (f.poisonChance && sim.rng.chance(f.poisonChance)) {
      p.effects.poisoned = 45;
      p.effects.nausea = 60;
      sim.notify(p.id, 'Your stomach turns. Food poisoning!', 'bad');
    }
    st.qty--;
    if (st.qty <= 0) a.slots[a.i] = null;
    sim.fx('eat', p.pos.x, p.pos.y + 1.5, p.pos.z, def.id, undefined, p.id);
    sim.markPlayer(p.id);
    afterContainerChange(sim, a.box);
    if (def.id === 'coconut') sim.milestone(p, 'drank_coconut', 'Coconuts are safe to drink. Craft a flask from one to carry water.');
    return OK;
  }
  if (def.medical) {
    const m = def.medical;
    let used = false;
    if (m.heal && p.health < SURVIVAL.maxHealth) { p.health = Math.min(SURVIVAL.maxHealth, p.health + m.heal); used = true; }
    for (const c of m.cures ?? []) if (p.effects[c]) { delete p.effects[c]; used = true; }
    if (!used) return fail('You don\'t need that now');
    st.qty--;
    if (st.qty <= 0) a.slots[a.i] = null;
    sim.fx('heal', p.pos.x, p.pos.y + 1, p.pos.z, def.id, undefined, p.id);
    sim.markPlayer(p.id);
    return OK;
  }
  if (def.equip) return equip(sim, p, from);
  return fail('You cannot use that');
}

function drinkWater(sim: Simulation, p: PlayerState, quality: 'salt' | 'clean', perUnit: number) {
  if (quality === 'clean') {
    p.thirst = Math.min(SURVIVAL.maxThirst, p.thirst + perUnit);
    sim.milestone(p, 'clean_water');
  } else {
    p.thirst = Math.max(0, p.thirst + SURVIVAL.saltWaterThirst);
    p.effects.nausea = SURVIVAL.saltWaterNauseaSeconds;
    sim.notify(p.id, 'Salt water! It only makes your thirst worse.', 'bad');
  }
  sim.fx('drink', p.pos.x, p.pos.y + 1.5, p.pos.z, quality, undefined, p.id);
}

function waterSourceNear(sim: Simulation, p: PlayerState): boolean {
  if (p.swimming) return true;
  for (const [dx, dz] of [[0, 0], [1.5, 0], [-1.5, 0], [0, 1.5], [0, -1.5]] as const) {
    const x = p.pos.x + dx!, z = p.pos.z + dz!;
    if (sim.waterLevel(x, z) - sim.gen.heightAt(x, z) > 0.25 && sim.waterLevel(x, z) > p.pos.y - 1.5) return true;
  }
  return false;
}

function fill(sim: Simulation, p: PlayerState, from: SlotRef, source: 'sea' | 'structure', id?: string): R {
  const a = resolve(sim, p, from);
  if (!a) return fail('Invalid slot');
  const st = a.slots[a.i];
  const def = st ? ITEMS[st.id] : undefined;
  if (!st || !def?.water) return fail('Not a water container');
  const space = def.water.capacity - (st.water ?? 0);
  if (space <= 0) return fail('Already full');
  if (source === 'sea') {
    if (!waterSourceNear(sim, p)) return fail('Get closer to the water');
    st.water = def.water.capacity;
    st.quality = 'salt';
  } else {
    const s = id ? sim.world.structures[id] : undefined;
    if (!s || !inRange(p, s, 4)) return fail('Too far');
    const have = Math.floor(s.water ?? 0);
    if (have <= 0) return fail('No fresh water collected yet');
    const n = Math.min(have, space);
    if ((st.water ?? 0) > 0 && st.quality === 'salt') return fail('Empty the salt water first');
    st.water = (st.water ?? 0) + n;
    st.quality = 'clean';
    s.water = (s.water ?? 0) - n;
    sim.markStructure(s.id);
  }
  sim.fx('fill', p.pos.x, p.pos.y + 1, p.pos.z, st.quality, undefined, p.id);
  sim.markPlayer(p.id);
  afterContainerChange(sim, a.box);
  return OK;
}

function drinkSource(sim: Simulation, p: PlayerState, source: 'sea' | 'structure', id?: string): R {
  if (source === 'sea') {
    if (!waterSourceNear(sim, p)) return fail('No water here');
    drinkWater(sim, p, 'salt', 0);
    sim.markPlayer(p.id);
    return OK;
  }
  const s = id ? sim.world.structures[id] : undefined;
  if (!s || !inRange(p, s, 4)) return fail('Too far');
  if ((s.water ?? 0) < 1) return fail('It is empty');
  s.water! -= 1;
  drinkWater(sim, p, 'clean', 16);
  sim.markStructure(s.id);
  sim.markPlayer(p.id);
  return OK;
}

// ------------------------------------------------------------------ gathering / combat
function nodeHp(sim: Simulation, id: string, max: number): number {
  return sim.world.nodes[id]?.hp ?? max;
}

function harvestNode(sim: Simulation, p: PlayerState, nodeId: string, toolPower: number | null, toolAction: string | null, tier: number): R {
  const n = sim.gen.nodeById(nodeId);
  if (!n) return fail('Nothing there');
  const def = NODES[n.type]!;
  if (sim.isNodeDepleted(nodeId)) return fail('Already harvested');
  const reach = (toolPower !== null ? 3.2 : PLAYER.interactRange) + def.radius * n.scale + 0.8;
  if (Math.hypot(n.x - p.pos.x, n.z - p.pos.z) > reach || Math.abs(n.y - p.pos.y) > def.height * n.scale + 3) return fail('Too far');
  if (def.action !== 'gather') {
    if (toolAction !== def.action && !(def.action === 'dig' && toolAction === 'mine')) {
      const need = def.action === 'chop' ? 'an axe' : def.action === 'mine' ? 'a pick' : 'a digging tool';
      return fail(`You need ${need}`);
    }
    if (tier < def.minTier) return fail('Your tool is too weak for this');
  }
  const hp = nodeHp(sim, nodeId, def.hp);
  const dmg = def.action === 'gather' ? def.hp : (toolPower ?? 0);
  const left = hp - dmg;
  for (const ph of def.perHit ?? []) if (sim.rng.chance(ph.chance)) sim.give(p, ph.item, ph.qty);
  sim.fx(left <= 0 ? 'node_break' : 'node_hit', n.x, n.y + Math.min(1.5, def.height * n.scale * 0.5), n.z, n.type, undefined, p.id);
  if (left > 0) {
    sim.world.nodes[nodeId] = { hp: left };
    sim.out.dirty.add(`n:${nodeId}`);
    return OK;
  }
  for (const y of def.yields) {
    if (y.chance !== undefined && !sim.rng.chance(y.chance)) continue;
    const q = sim.rng.int(y.min, y.max);
    if (q > 0) sim.give(p, y.item, q);
  }
  sim.world.nodes[nodeId] = { respawnAt: sim.now + def.respawnSeconds * sim.world.settings.resourceRespawnMul };
  sim.out.dirty.add(`n:${nodeId}`);
  p.stats.harvested++;
  if (n.type === 'palm' || n.type === 'hardwood') sim.milestone(p, 'felled_tree', 'Timber! Logs make planks, rafts and fuel.');
  return OK;
}

function gather(sim: Simulation, p: PlayerState, nodeId: string): R {
  const n = sim.gen.nodeById(nodeId);
  if (!n) return fail('Nothing there');
  if (NODES[n.type]!.action !== 'gather') return fail('Use a tool on this');
  return harvestNode(sim, p, nodeId, null, null, 0);
}

function use(sim: Simulation, p: PlayerState, act: Extract<Action, { a: 'use' }>): R {
  const held = sim.heldItem(p);
  const def = held ? ITEMS[held.id] : undefined;
  const tool = def?.tool;
  const cooldown = tool?.cooldown ?? 0.6;
  if (sim.now - p.lastUseAt < cooldown * 0.85) return fail('Too soon');
  const cost = tool?.staminaCost ?? 3;
  if (p.stamina < cost) return fail('Too exhausted');
  p.lastUseAt = sim.now;
  p.stamina -= cost;
  p.staminaDelay = SURVIVAL.staminaRegenDelay;
  p.yaw = Number.isFinite(act.yaw) ? act.yaw : p.yaw;
  sim.fx('swing', p.pos.x, p.pos.y + 1.4, p.pos.z, held?.id ?? 'hand', undefined, p.id);
  const t = act.target;
  let r: R = OK;
  if (t?.kind === 'node') {
    const action = tool?.actions.find((a) => a === 'chop' || a === 'mine' || a === 'dig') ?? null;
    r = harvestNode(sim, p, String(t.id), action ? tool!.power : null, action, tool?.tier ?? 0);
    if (r.ok && held && action && wear(p.inventory.slots, p.hotbar)) sim.notify(p.id, `Your ${def!.name} broke!`, 'warn');
  } else if (t?.kind === 'creature') {
    const c = sim.world.creatures[String(t.id)];
    if (!c) return fail('Gone');
    const cdef = CREATURES[c.kind];
    const range = (tool?.range ?? 2) + cdef.radius + 1;
    if (Math.hypot(c.x - p.pos.x, c.y - p.pos.y - 1, c.z - p.pos.z) > range) return fail('Too far');
    if (c.mode === 'dead') {
      if (!tool?.actions.includes('cut')) return fail('You need a cutting tool to butcher this');
      r = butcher(sim, c, p);
    } else {
      const dmg = tool?.damage ?? 3;
      damageCreature(sim, c, dmg, p.id, tool?.bleedChance ?? 0);
    }
    if (held && tool && wear(p.inventory.slots, p.hotbar)) sim.notify(p.id, `Your ${def!.name} broke!`, 'warn');
  } else if (t?.kind === 'structure') {
    // tools are not weapons against your own base; hammer handled by build actions
    r = OK;
  }
  sim.markPlayer(p.id);
  return r;
}

function shoot(sim: Simulation, p: PlayerState, yaw: number, pitch: number, charge: number): R {
  const held = sim.heldItem(p);
  const proj = held ? ITEMS[held.id]?.tool?.projectile : undefined;
  if (!held || !proj) return fail('No ranged weapon');
  if (sim.now - p.lastUseAt < ITEMS[held.id]!.tool!.cooldown * 0.85) return fail('Too soon');
  if (countItem(p.inventory.slots, proj.ammo) < 1) return fail('No arrows');
  if (p.swimming) return fail('Cannot shoot while swimming');
  const ch = Math.max(0.2, Math.min(1, Number(charge) || 0));
  removeItem(p.inventory.slots, proj.ammo, 1);
  p.lastUseAt = sim.now;
  const y = Number.isFinite(yaw) ? yaw : p.yaw, pt = Number.isFinite(pitch) ? Math.max(-1.5, Math.min(1.5, pitch)) : p.pitch;
  fireProjectile(sim, p.id, p.pos.x, p.pos.y + PLAYER.eyeHeight, p.pos.z, y, pt, proj.speed * ch, proj.damage * ch, proj.ammo);
  if (wear(p.inventory.slots, p.hotbar)) sim.notify(p.id, 'Your bow snapped!', 'warn');
  sim.fx('bow_shot', p.pos.x, p.pos.y + 1.5, p.pos.z, undefined, ch, p.id);
  sim.markPlayer(p.id);
  return OK;
}

function pickup(sim: Simulation, p: PlayerState, itemId: string): R {
  const it = sim.world.items[itemId];
  if (!it) return fail('Already taken');
  if (Math.hypot(it.x - p.pos.x, (it.y - p.pos.y - 0.8) * 0.5, it.z - p.pos.z) > PLAYER.interactRange + 0.8) return fail('Too far');
  const st = { ...it.stack };
  const before = st.qty;
  addStack(p.inventory.slots, st);
  if (st.qty === before) return fail('Inventory full');
  sim.discover(p, st.id);
  if (st.qty > 0) it.stack.qty = st.qty;
  else delete sim.world.items[itemId];
  sim.out.dirty.add(`i:${itemId}`);
  sim.markPlayer(p.id);
  sim.fx('pickup', it.x, it.y, it.z, it.stack.id, undefined, p.id);
  return OK;
}

// ------------------------------------------------------------------ interaction
function rollLoot(sim: Simulation, box: ContainerState) {
  if (!box.loot) return;
  const table = LOOT_TABLES[box.loot];
  delete box.loot;
  if (!table) return;
  const rolls = sim.rng.int(table.rolls[0], table.rolls[1]);
  let guaranteedDeep = box.id.startsWith('wreck') && table === LOOT_TABLES.wreck_deep;
  for (let i = 0; i < rolls; i++) {
    const e = sim.rng.pick(table.entries);
    if (!sim.rng.chance(e.chance)) continue;
    addStack(box.slots, makeStack(e.item, sim.rng.int(e.min, e.max), sim.now));
  }
  // deep wrecks always contain beacon parts so the endgame is reachable
  if (guaranteedDeep) {
    if (countItem(box.slots, 'circuit_board') < 1) addStack(box.slots, makeStack('circuit_board', 1));
    if (countItem(box.slots, 'battery_cell') < 1) addStack(box.slots, makeStack('battery_cell', 1));
    guaranteedDeep = false;
  }
  sim.markContainer(box.id);
}

function openContainer(sim: Simulation, p: PlayerState, box: ContainerState): R {
  if (!containerReachable(sim, p, box)) return fail('Too far');
  rollLoot(sim, box);
  p.openContainer = box.id;
  sim.markPlayer(p.id);
  sim.fx('open', box.x, box.y, box.z, box.kind, undefined, p.id);
  if (box.kind === 'crate' && box.id.startsWith('wreck')) sim.milestone(p, 'looted_wreck');
  return OK;
}

function interact(sim: Simulation, p: PlayerState, act: Extract<Action, { a: 'interact' }>): R {
  const id = String(act.id);
  switch (act.kind) {
    case 'container': {
      const box = sim.world.containers[id];
      return box ? openContainer(sim, p, box) : fail('Nothing there');
    }
    case 'vehicle': {
      const v = sim.world.vehicles[id];
      if (!v) return fail('No boat');
      if (act.verb === 'cargo') { const box = sim.world.containers[v.containerId]; return box ? openContainer(sim, p, box) : fail('No cargo'); }
      return boardVehicle(sim, v, p);
    }
    case 'player': return revive(sim, p, id);
    case 'creature': {
      const c = sim.world.creatures[id];
      if (!c || c.mode !== 'dead') return fail('Nothing to do');
      if (Math.hypot(c.x - p.pos.x, c.z - p.pos.z) > 4) return fail('Too far');
      const tool = ITEMS[sim.heldItem(p)?.id ?? '']?.tool;
      if (!tool?.actions.includes('cut')) return fail('Hold a cutting tool to butcher');
      return butcher(sim, c, p);
    }
    case 'structure': {
      const s = sim.world.structures[id];
      if (!s) return fail('Nothing there');
      if (!inRange(p, s, 4.5)) return fail('Too far');
      return structureVerb(sim, p, s, act.verb ?? 'use');
    }
  }
  return fail('Unknown interaction');
}

function structureVerb(sim: Simulation, p: PlayerState, s: StructureState, verb: string): R {
  const def = STRUCTURES[s.type]!;
  switch (verb) {
    case 'open': case 'use': {
      if (def.door) {
        s.on = !s.on;
        sim.col.addStructure(s, !!s.on);
        sim.markStructure(s.id);
        sim.fx('door', s.x, s.y + 1, s.z, s.on ? 'open' : 'close');
        return OK;
      }
      if (s.containerId) {
        const box = sim.world.containers[s.containerId];
        return box ? openContainer(sim, p, box) : fail('Broken');
      }
      if (def.bed) return sleep(sim, p, s.id);
      if (def.beacon) return activateBeacon(sim, p, s.id);
      return fail('Nothing to do');
    }
    case 'ignite': {
      const held = sim.heldItem(p);
      return ignite(sim, s, held?.id);
    }
    case 'extinguish':
      if (!s.on) return fail('Not lit');
      s.on = false; sim.markStructure(s.id); sim.fx('fire_out', s.x, s.y, s.z);
      return OK;
    case 'refuel': {
      if (!def.light?.fuelSeconds) return fail('Nothing to refuel');
      for (const fuel of ['animal_fat', 'resin', 'torch']) {
        if (countItem(p.inventory.slots, fuel) > 0) {
          removeItem(p.inventory.slots, fuel, 1);
          s.fuel = Math.min(def.light.fuelSeconds * 1.5, (s.fuel ?? 0) + def.light.fuelSeconds * (fuel === 'torch' ? 1 : 0.6));
          sim.markStructure(s.id);
          sim.markPlayer(p.id);
          return OK;
        }
      }
      return fail('You need resin, fat or a torch');
    }
    case 'pour': {
      if (!def.still) return fail('Nothing to pour into');
      const slots = p.inventory.slots;
      let poured = 0;
      for (const st of slots) {
        if (!st || st.quality !== 'salt' || !st.water) continue;
        const room = def.still.capacity - (s.saltWater ?? 0);
        const n = Math.min(room, st.water);
        if (n <= 0) break;
        s.saltWater = (s.saltWater ?? 0) + n;
        st.water -= n;
        if (st.water <= 0) { st.water = 0; delete st.quality; }
        poured += n;
      }
      if (!poured) return fail('Carry sea water in a container to pour in');
      sim.markStructure(s.id);
      sim.markPlayer(p.id);
      return OK;
    }
    case 'sleep': return sleep(sim, p, s.id);
    case 'beacon': return activateBeacon(sim, p, s.id);
  }
  return fail('Unknown verb');
}

function revive(sim: Simulation, p: PlayerState, id: string): R {
  const o = sim.world.players[id];
  if (!o || o.downed <= 0 || o.dead) return fail('They don\'t need help');
  if (Math.hypot(o.pos.x - p.pos.x, o.pos.z - p.pos.z) > 3) return fail('Get closer');
  o.downed = 0;
  o.health = 25;
  o.invulnUntil = sim.now + 3;
  sim.markPlayer(o.id);
  sim.notify(null, `${p.name} revived ${o.name}.`, 'good');
  sim.fx('revive', o.pos.x, o.pos.y, o.pos.z, undefined, undefined, o.id);
  sim.milestone(p, 'revived_friend');
  return OK;
}

function sleep(sim: Simulation, p: PlayerState, id: string): R {
  const s = sim.world.structures[id];
  if (!s || !STRUCTURES[s.type]?.bed) return fail('Not a bed');
  if (!inRange(p, s, 3.5)) return fail('Too far');
  p.respawn = { x: s.x, y: s.y, z: s.z, structureId: s.id };
  const h = sim.hour;
  if (h > 19 || h < 6) {
    p.sleeping = true;
    sim.notify(p.id, 'You lie down. When everyone rests, the night passes.', 'info');
  } else sim.notify(p.id, 'Respawn point set. You can only sleep at night.', 'info');
  sim.markPlayer(p.id);
  return OK;
}

function activateBeacon(sim: Simulation, p: PlayerState, id: string): R {
  const s = sim.world.structures[id];
  if (!s || !STRUCTURES[s.type]?.beacon) return fail('Not a beacon');
  const pr = sim.world.progression;
  if (pr.rescued) return fail('Rescue already came');
  if (pr.beaconId === id && pr.rescueAt) return fail(`Transmitting… rescue in ${Math.ceil((pr.rescueAt - sim.now) / (TIME.dayLengthSeconds / 24))} hours`);
  pr.beaconId = id;
  pr.beaconStartedAt = sim.now;
  pr.rescueAt = sim.now + TIME.dayLengthSeconds * 0.5;
  s.on = true;
  sim.markStructure(id);
  sim.out.dirty.add('g');
  sim.notify(null, `${p.name} activated the distress beacon! Keep it standing for 12 hours until a ship arrives.`, 'good');
  sim.milestone(p, 'beacon_on');
  return OK;
}

// ------------------------------------------------------------------ building
function requireHammer(sim: Simulation, p: PlayerState): R | null {
  const held = sim.heldItem(p);
  if (!held || !ITEMS[held.id]?.tool?.actions.includes('build')) return fail('Hold a Builder\'s Mallet');
  return null;
}

function build(sim: Simulation, p: PlayerState, act: Extract<Action, { a: 'build' }>): R {
  const def = STRUCTURES[String(act.structure)];
  if (!def) return fail('Unknown blueprint');
  if (def.needsHammer !== false) { const e = requireHammer(sim, p); if (e) return e; }
  const x = Number(act.x), y = Number(act.y), z = Number(act.z), yaw = Number(act.yaw);
  if (![x, y, z, yaw].every(Number.isFinite)) return fail('Invalid position');
  if (Math.hypot(x - p.pos.x, z - p.pos.z) > BUILD.placeRange + 2 || Math.abs(y - p.pos.y) > 8) return fail('Too far away');
  if (Object.keys(sim.world.structures).length >= BUILD.maxStructuresPerWorld) return fail('Structure limit reached');
  if (!hasItems(p.inventory.slots, def.cost.filter((c) => c.qty > 0))) return fail('Missing materials');
  const ctx = { structures: sim.world.structures, col: sim.col, gen: sim.gen, waterLevel: sim.waterLevel };
  const err = validateGeometry(ctx, def, x, y, z, yaw);
  if (err) return fail(err);
  // never build inside a player (non-walkable solid pieces)
  if (def.solid && !def.walkable) {
    for (const o of Object.values(sim.world.players)) {
      if (!o.connected || o.dead) continue;
      const dx = o.pos.x - x, dz = o.pos.z - z;
      const c = Math.cos(yaw), s = Math.sin(yaw);
      const lx = c * dx - s * dz, lz = s * dx + c * dz;
      if (Math.abs(lx) < def.size[0] + PLAYER.radius && Math.abs(lz) < def.size[2] + PLAYER.radius && o.pos.y < y + def.size[1] && o.pos.y + PLAYER.height > y) return fail('Someone is in the way');
    }
  }
  for (const c of def.cost) if (c.qty > 0) removeItem(p.inventory.slots, c.item, c.qty);
  sim.markPlayer(p.id);
  if (def.vehicle) {
    const v = createVehicle(sim, def.vehicle, x, z, yaw, p.id);
    sim.fx('build', x, y, z, def.id, undefined, p.id);
    sim.milestone(p, 'built_boat', 'Your boat floats! Board it with the interact key.');
    sim.log(`${p.name} built vehicle ${v.id}`);
    return OK;
  }
  const s: StructureState = { id: sim.newId('s'), type: def.id, x, y, z, yaw, hp: def.maxHp, owner: p.id, builtAt: sim.now };
  const slots = stationSlots(def.id);
  if (slots > 0) {
    const box = sim.createContainer(def.fire || def.dryingRack ? 'station' : 'storage', slots, x, y + 0.5, z, { label: def.name });
    s.containerId = box.id;
  }
  if (def.planter) s.crops = new Array(def.planter.plots).fill(null);
  if (def.light?.fuelSeconds) { s.fuel = def.light.fuelSeconds; s.on = true; }
  if (def.rainCatcher || def.still) s.water = 0;
  sim.addStructure(s);
  sim.fx('build', x, y, z, def.id, undefined, p.id);
  if (def.category === 'foundation') sim.milestone(p, 'first_foundation', 'A foundation! Add walls, a roof, and you have shelter.');
  if (def.providesShelter && def.category === 'roof') sim.milestone(p, 'built_shelter');
  if (def.bed) sim.milestone(p, 'built_bed', 'Rest here at night to set your respawn point.');
  return OK;
}

function demolish(sim: Simulation, p: PlayerState, id: string): R {
  const e = requireHammer(sim, p); if (e) return e;
  const s = sim.world.structures[id];
  if (!s) return fail('Nothing there');
  if (!inRange(p, s, BUILD.placeRange)) return fail('Too far');
  const def = STRUCTURES[s.type]!;
  const fallen = findUnsupported(sim.world.structures, id);
  for (const c of def.cost) {
    const n = Math.floor(c.qty * BUILD.refundFraction * (s.hp / def.maxHp));
    if (n > 0) sim.give(p, c.item, n);
  }
  sim.removeStructure(id);
  for (const f of fallen) {
    const fs = sim.world.structures[f];
    if (fs) sim.fx('collapse', fs.x, fs.y, fs.z, fs.type);
    sim.removeStructure(f);
  }
  if (fallen.length) sim.notify(p.id, `${fallen.length} unsupported piece(s) collapsed.`, 'warn');
  sim.fx('demolish', s.x, s.y, s.z, s.type, undefined, p.id);
  return OK;
}

function upgrade(sim: Simulation, p: PlayerState, id: string): R {
  const e = requireHammer(sim, p); if (e) return e;
  const s = sim.world.structures[id];
  if (!s) return fail('Nothing there');
  if (!inRange(p, s, BUILD.placeRange)) return fail('Too far');
  const next = STRUCTURES[s.type]?.upgradesTo;
  if (!next) return fail('Cannot be upgraded');
  const nd = STRUCTURES[next]!;
  if (!hasItems(p.inventory.slots, nd.cost)) return fail('Missing materials');
  for (const c of nd.cost) removeItem(p.inventory.slots, c.item, c.qty);
  s.type = next;
  s.hp = nd.maxHp;
  sim.addStructure(s);
  sim.markPlayer(p.id);
  sim.fx('upgrade', s.x, s.y, s.z, next, undefined, p.id);
  return OK;
}

function repair(sim: Simulation, p: PlayerState, id: string): R {
  const e = requireHammer(sim, p); if (e) return e;
  const v = sim.world.vehicles[id];
  if (v) {
    const def = VEHICLES[v.type]!;
    if (Math.hypot(v.x - p.pos.x, v.z - p.pos.z) > 6) return fail('Too far');
    if (v.hp >= def.maxHp) return fail('Not damaged');
    const mat = v.type === 'log_raft' ? 'log' : 'plank';
    if (countItem(p.inventory.slots, mat) < 1 || countItem(p.inventory.slots, 'rope') < 1) return fail(`Needs 1 ${ITEMS[mat]!.name} and 1 Cordage`);
    removeItem(p.inventory.slots, mat, 1); removeItem(p.inventory.slots, 'rope', 1);
    v.hp = Math.min(def.maxHp, v.hp + def.maxHp * (VEHICLE.repairHpPerAction / 100));
    sim.markPlayer(p.id);
    sim.fx('repair', v.x, v.y, v.z, v.type, undefined, p.id);
    return OK;
  }
  const s = sim.world.structures[id];
  if (!s) return fail('Nothing there');
  const def = STRUCTURES[s.type]!;
  if (s.hp >= def.maxHp) return fail('Not damaged');
  const mat = def.cost[0];
  if (mat && countItem(p.inventory.slots, mat.item) < 1) return fail(`Needs 1 ${ITEMS[mat.item]!.name}`);
  if (mat) removeItem(p.inventory.slots, mat.item, 1);
  s.hp = def.maxHp;
  sim.markStructure(s.id);
  sim.markPlayer(p.id);
  sim.fx('repair', s.x, s.y, s.z, s.type, undefined, p.id);
  return OK;
}

// ------------------------------------------------------------------ farming
function planter(sim: Simulation, p: PlayerState, id: string): StructureState | R {
  const s = sim.world.structures[id];
  if (!s || !s.crops) return fail('Not a garden plot');
  if (!inRange(p, s, 4)) return fail('Too far');
  return s;
}

function plant(sim: Simulation, p: PlayerState, id: string, plot: number, from: SlotRef): R {
  const s = planter(sim, p, id);
  if ('ok' in s) return s;
  if (!(plot >= 0 && plot < s.crops!.length)) return fail('Bad plot');
  if (s.crops![plot]) return fail('Something is already growing there');
  const a = resolve(sim, p, from);
  const st = a ? a.slots[a.i] : null;
  const crop = st ? ITEMS[st.id]?.seedOf : undefined;
  if (!a || !st || !crop || !CROPS[crop]) return fail('That is not a seed');
  st.qty--;
  if (st.qty <= 0) a.slots[a.i] = null;
  s.crops![plot] = { crop, growth: 0, water: 0.5, dryHours: 0, withered: false };
  sim.markStructure(s.id);
  sim.markPlayer(p.id);
  sim.fx('plant', s.x, s.y, s.z, crop, undefined, p.id);
  sim.milestone(p, 'planted', 'Seeds planted. Keep the soil watered with clean water.');
  return OK;
}

function harvestCrop(sim: Simulation, p: PlayerState, id: string, plot: number): R {
  const s = planter(sim, p, id);
  if ('ok' in s) return s;
  const c = s.crops?.[plot];
  if (!c) return fail('Nothing planted');
  const def = CROPS[c.crop]!;
  if (c.withered) { s.crops![plot] = null; sim.give(p, 'fiber', 1); sim.markStructure(s.id); return OK; }
  if (c.growth < 1) return fail(`Not ripe yet (${Math.floor(c.growth * 100)}%)`);
  for (const h of def.harvest) sim.give(p, h.item, sim.rng.int(h.min, h.max));
  sim.give(p, def.seed, sim.rng.int(def.seedReturn.min, def.seedReturn.max));
  s.crops![plot] = null;
  sim.markStructure(s.id);
  sim.fx('harvest_crop', s.x, s.y, s.z, c.crop, undefined, p.id);
  sim.milestone(p, 'harvested_crop');
  return OK;
}

function waterCrop(sim: Simulation, p: PlayerState, id: string, from: SlotRef): R {
  const s = planter(sim, p, id);
  if ('ok' in s) return s;
  const a = resolve(sim, p, from);
  const st = a ? a.slots[a.i] : null;
  if (!a || !st || !ITEMS[st.id]?.water || !st.water) return fail('You need a container with water');
  let used = 0;
  for (const c of s.crops!) {
    if (!c || c.withered || st.water <= 0) continue;
    if (st.quality === 'salt') { c.withered = true; used++; continue; }
    c.water = 1;
    c.dryHours = 0;
    used++;
  }
  if (!used) return fail('Nothing to water');
  st.water = Math.max(0, st.water - 1);
  if (st.quality === 'salt') sim.notify(p.id, 'Salt water poisoned the soil — the plants withered.', 'bad');
  if (st.water <= 0) delete st.quality;
  sim.markStructure(s.id);
  sim.markPlayer(p.id);
  sim.fx('water', s.x, s.y, s.z, undefined, undefined, p.id);
  return OK;
}
