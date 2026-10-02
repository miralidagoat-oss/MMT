import { describe, it, expect } from 'vitest';
import { addStack, removeItem, moveBetween, countItem, makeStack, emptyInventory, spaceFor, wear, totalWeight, carryCapacity } from '../src/shared/systems/inventory';

describe('inventory', () => {
  it('stacks up to max and spills into new slots', () => {
    const inv = emptyInventory();
    const s = makeStack('stone', 30);
    addStack(inv.slots, s);
    addStack(inv.slots, makeStack('stone', 25));
    expect(countItem(inv.slots, 'stone')).toBe(55);
    expect(inv.slots[0]!.qty).toBe(30);
    expect(inv.slots[1]!.qty).toBe(25);
  });

  it('does not stack non-stackables or durability items', () => {
    const slots = [null, null, null] as ReturnType<typeof emptyInventory>['slots'];
    addStack(slots, makeStack('stone_axe'));
    addStack(slots, makeStack('stone_axe'));
    expect(slots.filter(Boolean).length).toBe(2);
  });

  it('reports remainder when full', () => {
    const slots = [null] as ReturnType<typeof emptyInventory>['slots'];
    const s = makeStack('fiber', 50);
    addStack(slots, s);
    const extra = makeStack('fiber', 10);
    const n = addStack(slots, extra);
    expect(n).toBe(0);
    expect(extra.qty).toBe(10);
    expect(spaceFor(slots, makeStack('fiber', 1))).toBe(0);
  });

  it('splits, merges and swaps', () => {
    const inv = emptyInventory();
    inv.slots[0] = makeStack('stick', 20);
    expect(moveBetween(inv.slots, 0, inv.slots, 1, 5)).toBe(true);
    expect(inv.slots[0]!.qty).toBe(15);
    expect(inv.slots[1]!.qty).toBe(5);
    expect(moveBetween(inv.slots, 1, inv.slots, 0)).toBe(true);
    expect(inv.slots[0]!.qty).toBe(20);
    expect(inv.slots[1]).toBeNull();
    inv.slots[2] = makeStack('stone', 3);
    expect(moveBetween(inv.slots, 0, inv.slots, 2)).toBe(true); // swap
    expect(inv.slots[0]!.id).toBe('stone');
    expect(inv.slots[2]!.id).toBe('stick');
    // invalid quantities rejected
    expect(moveBetween(inv.slots, 0, inv.slots, 5, 99)).toBe(false);
    expect(moveBetween(inv.slots, 0, inv.slots, 5, 0)).toBe(false);
    expect(moveBetween(inv.slots, 0, inv.slots, 999)).toBe(false);
  });

  it('removes across stacks, soonest-spoiling first', () => {
    const slots = [makeStack('fish_raw', 2, 100), makeStack('fish_raw', 2, 0), null];
    expect(removeItem(slots, 'fish_raw', 3)).toBe(3);
    expect(countItem(slots, 'fish_raw')).toBe(1);
    expect(slots[0]!.qty).toBe(1); // the older (index 1) stack was consumed first
  });

  it('wears tools until they break', () => {
    const slots = [makeStack('sharp_stone')];
    const dur = slots[0]!.dur!;
    for (let i = 0; i < dur - 1; i++) expect(wear(slots, 0)).toBe(false);
    expect(wear(slots, 0)).toBe(true);
    expect(slots[0]).toBeNull();
  });

  it('computes weight and capacity with backpack bonus', () => {
    const inv = emptyInventory();
    inv.slots[0] = makeStack('log', 10);
    expect(totalWeight(inv)).toBeCloseTo(30);
    const base = carryCapacity(inv);
    inv.equip.back = makeStack('backpack');
    expect(carryCapacity(inv)).toBe(base + 25);
  });
});
