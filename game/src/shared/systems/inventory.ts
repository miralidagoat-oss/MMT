/**
 * Pure inventory operations. These functions never trust callers: they validate
 * indices, quantities and stack rules and return false when an operation is illegal.
 * The server simulation is the only place they mutate authoritative state.
 */
import { ITEMS, itemDef } from '../defs/items';
import type { EquipSlot } from '../defs/types';
import type { Inventory, ItemStack, Slots } from '../state';
import { PLAYER } from '../config';

export function makeStack(id: string, qty = 1, now = 0): ItemStack {
  const def = itemDef(id);
  const s: ItemStack = { id, qty: Math.max(1, Math.min(qty, def.maxStack)) };
  if (def.durability) s.dur = def.durability;
  if (def.water) { s.water = 0; }
  if (def.food?.spoilSeconds) s.spoilAt = now + def.food.spoilSeconds;
  return s;
}

export function emptyInventory(): Inventory {
  return { slots: new Array(PLAYER.inventorySlots).fill(null), equip: { head: null, body: null, back: null, feet: null } };
}

export function cloneStack(s: ItemStack): ItemStack { return { ...s }; }

/** Two stacks can merge if same item and neither carries per-instance state that differs. */
export function canMerge(a: ItemStack, b: ItemStack): boolean {
  if (a.id !== b.id) return false;
  const def = ITEMS[a.id];
  if (!def || def.maxStack <= 1) return false;
  if (a.dur !== undefined || b.dur !== undefined) return false;
  if (a.water !== undefined || b.water !== undefined) return false;
  return true;
}

function mergeSpoil(a: ItemStack, b: ItemStack, moved: number) {
  if (a.spoilAt === undefined && b.spoilAt === undefined) return;
  const sa = a.spoilAt ?? b.spoilAt!, sb = b.spoilAt ?? a.spoilAt!;
  // weighted average keeps freshness fair when merging
  a.spoilAt = (sa * a.qty + sb * moved) / (a.qty + moved);
}

/** Count of an item across slots. */
export function countItem(slots: Slots, id: string): number {
  let n = 0;
  for (const s of slots) if (s && s.id === id) n += s.qty;
  return n;
}

export function countInInventory(inv: Inventory, id: string): number {
  return countItem(inv.slots, id);
}

/** How many of `stack` would fit in slots. */
export function spaceFor(slots: Slots, stack: ItemStack): number {
  const def = itemDef(stack.id);
  let space = 0;
  for (const s of slots) {
    if (!s) space += def.maxStack;
    else if (canMerge(s, stack)) space += def.maxStack - s.qty;
  }
  return space;
}

/**
 * Insert a stack into slots, merging first then using empty slots.
 * Mutates `stack.qty` to the remainder that did not fit. Returns amount inserted.
 */
export function addStack(slots: Slots, stack: ItemStack, preferSlot = -1): number {
  const def = itemDef(stack.id);
  let inserted = 0;
  if (stack.qty <= 0) return 0;
  if (def.maxStack > 1) {
    for (const s of slots) {
      if (stack.qty <= 0) break;
      if (s && canMerge(s, stack) && s.qty < def.maxStack) {
        const n = Math.min(def.maxStack - s.qty, stack.qty);
        mergeSpoil(s, stack, n);
        s.qty += n;
        stack.qty -= n;
        inserted += n;
      }
    }
  }
  const order: number[] = [];
  if (preferSlot >= 0 && preferSlot < slots.length) order.push(preferSlot);
  for (let i = 0; i < slots.length; i++) if (i !== preferSlot) order.push(i);
  for (const i of order) {
    if (stack.qty <= 0) break;
    if (slots[i] === null) {
      const n = Math.min(def.maxStack, stack.qty);
      slots[i] = { ...stack, qty: n };
      stack.qty -= n;
      inserted += n;
    }
  }
  return inserted;
}

/** Remove qty of an item (consumes stacks closest to spoiling first). Returns removed count. */
export function removeItem(slots: Slots, id: string, qty: number): number {
  let left = qty;
  const idx = slots.map((s, i) => [s, i] as const).filter(([s]) => s && s.id === id)
    .sort((a, b) => (a[0]!.spoilAt ?? Infinity) - (b[0]!.spoilAt ?? Infinity));
  for (const [s, i] of idx) {
    if (left <= 0) break;
    const n = Math.min(s!.qty, left);
    s!.qty -= n;
    left -= n;
    if (s!.qty <= 0) slots[i] = null;
  }
  return qty - left;
}

export function hasItems(slots: Slots, req: { item: string; qty: number }[]): boolean {
  for (const r of req) {
    const need = Math.max(r.qty, 1);
    if (countItem(slots, r.item) < need) return false;
  }
  return true;
}

export type SlotRef = { c: 'inv'; i: number } | { c: 'equip'; s: EquipSlot } | { c: 'box'; id: string; i: number };

export function totalWeight(inv: Inventory): number {
  let w = 0;
  for (const s of inv.slots) if (s) w += (ITEMS[s.id]?.weight ?? 0) * s.qty;
  for (const k of Object.keys(inv.equip) as EquipSlot[]) {
    const s = inv.equip[k];
    if (s) w += ITEMS[s.id]?.weight ?? 0;
  }
  return w;
}

export function carryCapacity(inv: Inventory): number {
  let cap = PLAYER.baseCarryWeight;
  for (const k of Object.keys(inv.equip) as EquipSlot[]) {
    const s = inv.equip[k];
    if (s) cap += ITEMS[s.id]?.equip?.carryBonus ?? 0;
  }
  return cap;
}

/**
 * Move/merge/swap between two slot arrays. qty < full stack splits.
 * Returns false if the move is invalid (nothing changes).
 */
export function moveBetween(src: Slots, si: number, dst: Slots, di: number, qty?: number): boolean {
  if (si < 0 || si >= src.length || di < 0 || di >= dst.length) return false;
  if (src === dst && si === di) return false;
  const a = src[si];
  if (!a) return false;
  const n = qty === undefined ? a.qty : Math.floor(qty);
  if (!(n >= 1 && n <= a.qty)) return false;
  const b = dst[di];
  const def = itemDef(a.id);
  if (!b) {
    if (n === a.qty) { dst[di] = a; src[si] = null; }
    else { dst[di] = { ...a, qty: n }; a.qty -= n; }
    return true;
  }
  if (canMerge(a, b)) {
    const m = Math.min(n, def.maxStack - b.qty);
    if (m <= 0) return false;
    mergeSpoil(b, a, m);
    b.qty += m;
    a.qty -= m;
    if (a.qty <= 0) src[si] = null;
    return true;
  }
  // swap only for full-stack moves
  if (n !== a.qty) return false;
  dst[di] = a;
  src[si] = b;
  return true;
}

/** Wear a tool/equipment; returns true if it broke (slot cleared). */
export function wear(slots: Slots, i: number, amount = 1): boolean {
  const s = slots[i];
  if (!s || s.dur === undefined) return false;
  s.dur -= amount;
  if (s.dur <= 0) { slots[i] = null; return true; }
  return false;
}

export function isStackValid(s: unknown): s is ItemStack {
  if (!s || typeof s !== 'object') return false;
  const st = s as ItemStack;
  const def = ITEMS[st.id];
  return !!def && Number.isInteger(st.qty) && st.qty >= 1 && st.qty <= def.maxStack;
}
