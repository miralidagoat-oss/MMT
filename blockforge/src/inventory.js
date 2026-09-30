// Item stacks and containers.
import { ITEMS, maxStack } from './items.js';

// A stack is { id, count, dur? } (dur = damage taken, for tools).
export const cloneStack = (s) => (s ? { ...s } : null);
export const sameItem = (a, b) => !!a && !!b && a.id === b.id && !a.dur && !b.dur && !a.ench && !b.ench && maxStack(a.id) > 1;

export class Container {
  constructor(size) { this.slots = new Array(size).fill(null); }
  get size() { return this.slots.length; }
  get(i) { return this.slots[i]; }
  set(i, s) { this.slots[i] = s && s.count > 0 ? s : null; }

  // Add a stack; returns the count that did not fit. `order` lists slot indices.
  add(stack, order) {
    let left = stack.count;
    const idx = order || this.slots.map((_, i) => i);
    const max = maxStack(stack.id);
    if (max > 1 && !stack.dur && !stack.ench) {
      for (const i of idx) {
        const s = this.slots[i];
        if (s && s.id === stack.id && !s.dur && !s.ench && s.count < max) {
          const t = Math.min(max - s.count, left);
          s.count += t; left -= t;
          if (!left) return 0;
        }
      }
    }
    for (const i of idx) {
      if (!this.slots[i]) {
        const t = Math.min(max, left);
        this.slots[i] = { ...stack, count: t };
        left -= t;
        if (!left) return 0;
      }
    }
    return left;
  }

  count(id) { return this.slots.reduce((n, s) => n + (s && s.id === id ? s.count : 0), 0); }

  toJSON() { return this.slots.map((s) => (s ? { ...s } : null)); }
  load(arr) {
    this.slots.fill(null);
    if (!Array.isArray(arr)) return;
    arr.forEach((s, i) => { if (i < this.slots.length && s && ITEMS[s.id] && s.count > 0) this.slots[i] = { ...s }; });
  }
}

// Player inventory: slots 0-8 hotbar, 9-35 main, 36-39 armor (head, chest, legs, feet).
export class PlayerInventory extends Container {
  constructor() {
    super(40);
    this.selected = 0;
  }
  get held() { return this.slots[this.selected]; }
  set held(s) { this.set(this.selected, s); }
  // Picked-up items fill the hotbar first, then the main area.
  give(stack) {
    const order = [];
    for (let i = 0; i < 9; i++) order.push(i);
    for (let i = 9; i < 36; i++) order.push(i);
    return this.add(stack, order);
  }
  // Consume one of the held item.
  useHeld(n = 1) {
    const s = this.held;
    if (!s) return;
    s.count -= n;
    if (s.count <= 0) this.held = null;
  }
}

// Furnace state (stored as a block entity).
export function newFurnace() {
  return { type: 'furnace', slots: [null, null, null], burn: 0, burnMax: 0, cook: 0 };
}
export function newChest() {
  return { type: 'chest', slots: new Array(27).fill(null) };
}
