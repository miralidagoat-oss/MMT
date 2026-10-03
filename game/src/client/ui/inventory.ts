/**
 * Inventory screen: equipment, inventory grid (drag & drop / split / context menu),
 * the opened container or station, and the crafting panel. All mutations are sent
 * as intents; the screen re-renders from replicated state.
 */
import { h, clear } from './dom';
import { slotEl } from './hud';
import { iconFor } from './icons';
import { ITEMS } from '../../shared/defs/items';
import { RECIPE_LIST, RECIPES } from '../../shared/defs/recipes';
import { STRUCTURES } from '../../shared/defs/structures';
import { CROPS } from '../../shared/defs/crops';
import { knowsRecipe, stationsNear } from '../../shared/sim/crafting';
import { countItem, totalWeight, carryCapacity, type SlotRef } from '../../shared/systems/inventory';
import { TIME } from '../../shared/config';
import type { Action } from '../../shared/net/protocol';
import type { ClientSession } from '../net/session';
import type { ItemStack, ContainerState, StructureState } from '../../shared/state';
import type { EquipSlot } from '../../shared/defs/types';

export interface PanelCtx {
  session: ClientSession;
  act: (a: Action) => Promise<{ ok: boolean; reason?: string }>;
  sound: (id: string) => void;
}

const CATS = ['all', 'basics', 'tools', 'weapons', 'survival', 'materials', 'equipment', 'medical', 'navigation', 'advanced'] as const;

export class InventoryScreen {
  root = h('div', { class: 'inv-root hidden' });
  private tooltip = h('div', { class: 'tooltip hidden' });
  private ctxMenu = h('div', { class: 'ctx hidden' });
  private drag: { ref: SlotRef; ghost: HTMLElement; split: boolean } | null = null;
  private sig = '';
  private cat: (typeof CATS)[number] = 'all';
  private selected = '';
  /** structure id of a non-container station being viewed (rain catcher, still, planter, beacon) */
  station: string | null = null;
  craftOnly = false;
  visible = false;

  constructor(parent: HTMLElement, private ctx: PanelCtx) {
    parent.append(this.root, this.tooltip, this.ctxMenu);
    window.addEventListener('mousemove', (e) => {
      if (this.drag) { this.drag.ghost.style.left = `${e.clientX - 26}px`; this.drag.ghost.style.top = `${e.clientY - 26}px`; }
      if (!this.tooltip.classList.contains('hidden')) { this.tooltip.style.left = `${e.clientX + 16}px`; this.tooltip.style.top = `${e.clientY + 12}px`; }
    });
    window.addEventListener('mouseup', () => { if (this.drag) { this.drag.ghost.remove(); this.drag = null; } });
    window.addEventListener('mousedown', (e) => { if (!this.ctxMenu.contains(e.target as Node)) this.ctxMenu.classList.add('hidden'); });
  }

  open(opts: { station?: string | null; craftOnly?: boolean } = {}) {
    this.station = opts.station ?? null;
    this.craftOnly = !!opts.craftOnly;
    this.visible = true;
    this.root.classList.remove('hidden');
    this.sig = '';
    this.ctx.sound('ui_open');
  }

  close() {
    if (!this.visible) return;
    this.visible = false;
    this.root.classList.add('hidden');
    this.tooltip.classList.add('hidden');
    this.ctxMenu.classList.add('hidden');
    this.station = null;
    if (this.ctx.session.self?.openContainer) void this.ctx.act({ a: 'close_container' });
    this.ctx.sound('ui_close');
  }

  /** Re-render when replicated state changed. */
  update(force = false) {
    if (!this.visible) return;
    const s = this.ctx.session;
    const me = s.me;
    if (!me) return;
    const boxId = s.self?.openContainer ?? null;
    const box = boxId ? s.containers[boxId] : null;
    const st = this.station ? s.structures[this.station] : null;
    const sig = JSON.stringify([me.inventory, me.hotbar, box, st, s.self?.craftQueue, this.cat, this.selected, this.craftOnly, me.discovered.length, Math.floor(s.serverTime())]);
    if (!force && sig === this.sig) return;
    this.sig = sig;
    clear(this.root);
    if (box || st) this.root.append(this.containerPanel(box, st));
    if (!this.craftOnly || box) this.root.append(this.inventoryPanel());
    this.root.append(this.craftPanel());
  }

  // ------------------------------------------------------------------ inventory
  private inventoryPanel(): HTMLElement {
    const me = this.ctx.session.me!;
    const eq = h('div', { class: 'equip' });
    for (const k of ['head', 'body', 'back', 'feet'] as EquipSlot[]) {
      const el = slotEl(me.inventory.equip[k]);
      el.append(h('span', { class: 'lbl', text: k }));
      this.wire(el, { c: 'equip', s: k }, me.inventory.equip[k]);
      eq.append(el);
    }
    const grid = h('div', { class: 'grid' });
    me.inventory.slots.forEach((stack, i) => {
      const el = slotEl(stack, i === me.hotbar, i < 8 ? String(i + 1) : undefined);
      if (i < 8) el.style.borderColor = i === me.hotbar ? '' : 'rgba(255,179,92,0.25)';
      this.wire(el, { c: 'inv', i }, stack);
      grid.append(el);
    });
    const w = totalWeight(me.inventory), cap = carryCapacity(me.inventory);
    return h('div', { class: 'panel inv-col' },
      h('h3', {}, 'Equipment'), eq,
      h('h3', {}, h('span', { text: 'Inventory' }), h('span', { class: 'weight', style: w > cap ? 'color:var(--bad)' : '', text: `${w.toFixed(1)} / ${cap} kg` })), grid,
      h('div', { style: 'font-size:11px;color:var(--muted)', text: 'Drag to move · Shift-click quick move · Ctrl-drag split · Right-click for options · top row = hotbar' }));
  }

  private wire(el: HTMLElement, ref: SlotRef, stack: ItemStack | null) {
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      if (e.shiftKey && stack && ref.c !== 'equip') { void this.send({ a: 'quick_move', from: ref }); return; }
      if (!stack) return;
      const ghost = h('div', { class: 'slot', style: `position:fixed;z-index:70;pointer-events:none;left:${e.clientX - 26}px;top:${e.clientY - 26}px;opacity:.85` }, h('img', { src: iconFor(stack.id) }));
      document.body.append(ghost);
      this.drag = { ref, ghost, split: e.ctrlKey || e.altKey };
    });
    el.addEventListener('mouseup', (e) => {
      if (!this.drag || e.button !== 0) return;
      const from = this.drag.ref;
      const split = this.drag.split;
      this.drag.ghost.remove();
      this.drag = null;
      if (JSON.stringify(from) === JSON.stringify(ref)) return;
      const src = this.stackAt(from);
      const qty = split && src ? Math.ceil(src.qty / 2) : undefined;
      void this.send({ a: 'move', from, to: ref, qty });
    });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); if (stack) this.contextMenu(e.clientX, e.clientY, ref, stack); });
    el.addEventListener('mouseenter', () => { if (stack) this.showTooltip(stack); });
    el.addEventListener('mouseleave', () => this.tooltip.classList.add('hidden'));
  }

  private stackAt(ref: SlotRef): ItemStack | null {
    const s = this.ctx.session;
    if (ref.c === 'inv') return s.me!.inventory.slots[ref.i] ?? null;
    if (ref.c === 'equip') return s.me!.inventory.equip[ref.s];
    return s.containers[ref.id]?.slots[ref.i] ?? null;
  }

  private async send(a: Action) {
    const r = await this.ctx.act(a);
    if (r.ok) this.ctx.sound('ui_click'); else { this.ctx.sound('ui_error'); if (r.reason) this.flash(r.reason); }
    this.sig = '';
    this.update();
  }

  private flash(text: string) {
    const n = h('div', { style: 'position:fixed;left:50%;top:12%;transform:translateX(-50%);z-index:80', class: 'note bad', text });
    document.body.append(n);
    setTimeout(() => n.remove(), 2200);
  }

  private showTooltip(st: ItemStack) {
    const def = ITEMS[st.id];
    if (!def) return;
    clear(this.tooltip);
    this.tooltip.append(h('div', { class: 'cat', text: def.category }), h('h4', { text: def.name }), h('div', { text: def.description }));
    const stats: string[] = [];
    if (def.food) stats.push(`Food +${def.food.nutrition}${def.food.hydration ? ` · Water ${def.food.hydration > 0 ? '+' : ''}${def.food.hydration}` : ''}${def.food.poisonChance ? ' · may cause food poisoning' : ''}`);
    if (st.spoilAt !== undefined) { const left = st.spoilAt - this.ctx.session.serverTime(); stats.push(left > 0 ? `Spoils in ${Math.ceil(left / (TIME.dayLengthSeconds / 24))} h` : 'Spoiling'); }
    if (def.water) stats.push(`Water ${st.water ?? 0}/${def.water.capacity} (${st.quality ?? 'empty'})`);
    if (def.tool) stats.push(`${def.tool.actions.join(', ')} · tier ${def.tool.tier}${def.tool.damage ? ` · dmg ${def.tool.damage}` : ''}`);
    if (def.durability && st.dur !== undefined) stats.push(`Durability ${Math.ceil(st.dur)}/${def.durability}`);
    if (def.equip) stats.push(`Wear: ${def.equip.slot}${def.equip.insulation ? ` · warmth +${def.equip.insulation}` : ''}${def.equip.armor ? ` · armor ${Math.round(def.equip.armor * 100)}%` : ''}${def.equip.carryBonus ? ` · +${def.equip.carryBonus} kg` : ''}`);
    if (def.fuelSeconds) stats.push(`Fuel ${def.fuelSeconds}s`);
    stats.push(`Weight ${def.weight} kg${st.qty > 1 ? ` (${(def.weight * st.qty).toFixed(1)})` : ''}`);
    for (const s of stats) this.tooltip.append(h('div', { class: 'stat', text: s }));
    this.tooltip.classList.remove('hidden');
  }

  private contextMenu(x: number, y: number, ref: SlotRef, st: ItemStack) {
    const def = ITEMS[st.id]!;
    clear(this.ctxMenu);
    const add = (label: string, a: Action) => this.ctxMenu.append(h('button', { text: label, on: { click: () => { this.ctxMenu.classList.add('hidden'); void this.send(a); } } }));
    if (def.food) add(def.category === 'drink' ? 'Drink' : 'Eat', { a: 'consume', from: ref });
    if (def.water && def.id !== 'watering_can' && (st.water ?? 0) > 0) add(`Drink (${st.quality === 'salt' ? 'salt water!' : 'fresh'})`, { a: 'consume', from: ref });
    if (def.medical) add('Use', { a: 'consume', from: ref });
    if (def.equip) add(ref.c === 'equip' ? 'Unequip' : 'Equip', { a: 'equip', from: ref });
    if (def.water) add('Fill with sea water', { a: 'fill', from: ref, source: 'sea' });
    if (ref.c !== 'equip' && st.qty > 1) add(`Split (${Math.floor(st.qty / 2)})`, { a: 'move', from: ref, to: this.freeSlot(ref) ?? ref, qty: Math.floor(st.qty / 2) });
    if (ref.c === 'inv') {
      const s = this.ctx.session.self;
      if (s?.openContainer) add('Move to container', { a: 'quick_move', from: ref });
      else add(ref.i < 8 ? 'Move to backpack' : 'Move to hotbar', { a: 'quick_move', from: ref });
    }
    if (ref.c === 'box') add('Take', { a: 'quick_move', from: ref });
    add('Drop one', { a: 'drop', from: ref, qty: 1 });
    if (st.qty > 1) add('Drop all', { a: 'drop', from: ref });
    this.ctxMenu.style.left = `${x}px`;
    this.ctxMenu.style.top = `${y}px`;
    this.ctxMenu.classList.remove('hidden');
  }

  private freeSlot(ref: SlotRef): SlotRef | null {
    if (ref.c === 'inv') { const i = this.ctx.session.me!.inventory.slots.findIndex((s) => !s); return i >= 0 ? { c: 'inv', i } : null; }
    if (ref.c === 'box') { const i = this.ctx.session.containers[ref.id]?.slots.findIndex((s) => !s) ?? -1; return i >= 0 ? { c: 'box', id: ref.id, i } : null; }
    return null;
  }

  // ------------------------------------------------------------------ containers & stations
  private containerPanel(box: ContainerState | null, st: StructureState | null): HTMLElement {
    const s = this.ctx.session;
    const owner = st ?? (box ? Object.values(s.structures).find((x) => x.containerId === box.id) ?? null : null);
    const def = owner ? STRUCTURES[owner.type] : undefined;
    const title = def?.name ?? box?.label ?? 'Container';
    const col = h('div', { class: 'panel inv-col', style: 'min-width:300px;max-width:420px' }, h('h3', { text: title }));
    if (owner && def?.fire) {
      const lit = owner.on;
      col.append(h('div', { class: 'station-info', html: `Status: <b style="color:${lit ? 'var(--accent)' : 'var(--muted)'}">${lit ? 'Burning' : 'Unlit'}</b> · Fuel <b>${Math.ceil(owner.fuel ?? 0)}s</b><br>${def.fire.cookSlots ? 'Slot 1 is fuel. Put raw food (or a clay pot of sea water) in the cooking slots — and take it off before it burns!' : 'Slot 1 is fuel. Keep it burning while you craft.'}` }));
      col.append(h('div', { style: 'display:flex;gap:6px' },
        lit ? h('button', { class: 'btn small', text: 'Extinguish', on: { click: () => void this.send({ a: 'interact', kind: 'structure', id: owner.id, verb: 'extinguish' }) } })
          : h('button', { class: 'btn small primary', text: 'Light fire', on: { click: () => void this.send({ a: 'ignite', id: owner.id }) } })));
    }
    if (owner && def?.rainCatcher) col.append(this.waterStation(owner.id, owner.water ?? 0, def.rainCatcher.capacity, 'Collects fresh water whenever it rains.'));
    if (owner && def?.still) {
      col.append(this.waterStation(owner.id, owner.water ?? 0, def.still.capacity, `Sea water waiting: ${(owner.saltWater ?? 0).toFixed(1)} · distills faster in sunlight.`));
      col.append(h('button', { class: 'btn small', text: 'Pour in sea water from your containers', on: { click: () => void this.send({ a: 'interact', kind: 'structure', id: owner.id, verb: 'pour' }) } }));
    }
    if (owner && def?.planter && owner.crops) col.append(this.planterUI(owner.id, owner.crops as ({ crop: string; growth: number; water: number; withered: boolean } | null)[]));
    if (owner && def?.beacon) {
      const pr = s.progression;
      const active = pr?.beaconId === owner.id;
      const hrs = active && pr ? Math.max(0, (pr.rescueAt - s.serverTime()) / (TIME.dayLengthSeconds / 24)) : 0;
      col.append(h('div', { class: 'station-info', html: pr?.rescued ? '<b style="color:var(--good)">Rescue has arrived!</b>' : active ? `Transmitting… rescue in <b>${hrs.toFixed(1)} h</b>. Protect the beacon.` : 'The beacon is ready. Activating it broadcasts a distress signal for 12 hours.' }));
      if (!active && !pr?.rescued) col.append(h('button', { class: 'btn primary', text: 'Activate distress beacon', on: { click: () => void this.send({ a: 'beacon', id: owner.id }) } }));
    }
    if (owner && def?.light?.fuelSeconds) col.append(h('div', { class: 'station-info', html: `Fuel: <b>${Math.ceil(owner.fuel ?? 0)}s</b>` }), h('div', { style: 'display:flex;gap:6px' },
      h('button', { class: 'btn small', text: 'Refuel (resin/fat/torch)', on: { click: () => void this.send({ a: 'interact', kind: 'structure', id: owner.id, verb: 'refuel' }) } }),
      h('button', { class: 'btn small', text: owner.on ? 'Extinguish' : 'Light', on: { click: () => void this.send(owner.on ? { a: 'interact', kind: 'structure', id: owner.id, verb: 'extinguish' } : { a: 'ignite', id: owner.id }) } })));
    if (box) {
      const grid = h('div', { class: 'grid', style: `grid-template-columns:repeat(${Math.min(6, box.slots.length)},58px)` });
      box.slots.forEach((stack, i) => {
        const el = slotEl(stack);
        if (def?.fire) el.append(h('span', { class: 'key', text: i === 0 ? 'fuel' : 'cook' }));
        const prog = owner?.progress?.[i];
        if (prog && stack) {
          const target = ITEMS[stack.id]?.food?.cookSeconds ?? ITEMS[stack.id]?.food?.drySeconds ?? 40;
          el.append(h('div', { class: 'dur' }, h('div', { style: `width:${Math.min(100, (prog / target) * 100)}%;background:var(--accent)` })));
        }
        this.wire(el, { c: 'box', id: box.id, i }, stack);
        grid.append(el);
      });
      col.append(grid);
      col.append(h('button', { class: 'btn small', text: 'Take all', on: { click: async () => { for (let i = 0; i < box.slots.length; i++) if (box.slots[i]) await this.ctx.act({ a: 'quick_move', from: { c: 'box', id: box.id, i } }); this.sig = ''; this.update(); } } }));
    }
    return col;
  }

  private waterStation(id: string, water: number, cap: number, text: string): HTMLElement {
    const me = this.ctx.session.me!;
    const containers = me.inventory.slots.map((s, i) => [s, i] as const).filter(([s]) => s && ITEMS[s.id]?.water);
    return h('div', { class: 'station-info' },
      h('div', { html: `Fresh water: <b>${water.toFixed(1)} / ${cap}</b><br>${text}` }),
      h('div', { style: 'display:flex;gap:6px;margin-top:6px;flex-wrap:wrap' },
        h('button', { class: 'btn small', text: 'Drink', on: { click: () => void this.send({ a: 'drink_source', source: 'structure', id }) } }),
        ...containers.map(([s, i]) => h('button', { class: 'btn small', text: `Fill ${ITEMS[s!.id]!.name}`, on: { click: () => void this.send({ a: 'fill', from: { c: 'inv', i }, source: 'structure', id }) } }))));
  }

  private planterUI(id: string, crops: ({ crop: string; growth: number; water: number; withered: boolean } | null)[]): HTMLElement {
    const me = this.ctx.session.me!;
    const seeds = me.inventory.slots.map((s, i) => [s, i] as const).filter(([s]) => s && ITEMS[s.id]?.seedOf);
    const can = me.inventory.slots.findIndex((s) => s && ITEMS[s.id]?.water && (s.water ?? 0) > 0);
    const wrap = h('div', { style: 'display:flex;flex-direction:column;gap:6px' });
    crops.forEach((c, plot) => {
      if (!c) {
        wrap.append(h('div', { class: 'list-item' }, h('span', { text: `Plot ${plot + 1}: empty` }),
          h('div', { style: 'display:flex;gap:4px;flex-wrap:wrap' }, ...seeds.slice(0, 4).map(([s, i]) => h('button', { class: 'btn small', text: `Plant ${ITEMS[s!.id]!.name}`, on: { click: () => void this.send({ a: 'plant', id, plot, from: { c: 'inv', i } }) } })))));
        return;
      }
      const def = CROPS[c.crop];
      wrap.append(h('div', { class: 'list-item' },
        h('div', {}, h('div', { text: `${def?.name ?? c.crop} — ${c.withered ? 'withered' : c.growth >= 1 ? 'ready!' : `${Math.floor(c.growth * 100)}%`}` }), h('div', { class: 'meta', text: `Soil moisture ${Math.round(c.water * 100)}%` })),
        h('button', { class: 'btn small', text: c.withered ? 'Clear' : 'Harvest', disabled: !c.withered && c.growth < 1, on: { click: () => void this.send({ a: 'harvest_crop', id, plot }) } })));
    });
    wrap.append(h('button', { class: 'btn small', text: can >= 0 ? 'Water all plots' : 'Water (need a container with fresh water)', disabled: can < 0, on: { click: () => void this.send({ a: 'water_crop', id, from: { c: 'inv', i: can } }) } }));
    return wrap;
  }

  // ------------------------------------------------------------------ crafting
  private craftPanel(): HTMLElement {
    const s = this.ctx.session;
    const me = s.me!;
    const pos = s.viewPosition();
    const stations = stationsNear({ world: { structures: s.structures } as never }, pos.x, pos.y, pos.z);
    const known = RECIPE_LIST.filter((r) => knowsRecipe(me, r));
    const locked = RECIPE_LIST.length - known.length;
    const cats = h('div', { class: 'cats' });
    for (const c of CATS) cats.append(h('div', { class: `tab ${this.cat === c ? 'active' : ''}`, text: c, on: { click: () => { this.cat = c; this.sig = ''; this.update(); } } }));
    const list = h('div', { class: 'recipes' });
    const shown = known.filter((r) => this.cat === 'all' || r.category === this.cat);
    const canMake = (rid: string) => {
      const r = RECIPES[rid]!;
      return r.inputs.every((i) => countItem(me.inventory.slots, i.item) >= Math.max(1, i.qty)) && (!r.station || stations.has(r.station));
    };
    shown.sort((a, b) => Number(canMake(b.id)) - Number(canMake(a.id)));
    for (const r of shown) {
      const ok = canMake(r.id);
      const out = ITEMS[r.output.item]!;
      const req = h('div', { class: 'req' });
      for (const i of r.inputs) {
        const have = countItem(me.inventory.slots, i.item);
        req.append(h('span', { class: `ing ${have < Math.max(1, i.qty) ? 'miss' : ''}` }, h('img', { src: iconFor(i.item) }), i.qty === 0 ? `(${ITEMS[i.item]!.name})` : `${have}/${i.qty}`));
      }
      if (r.station) req.append(h('span', { class: `ing ${stations.has(r.station) ? '' : 'miss'}`, text: `@ ${r.station}` }));
      const el = h('div', { class: `recipe ${ok ? '' : 'no'} ${this.selected === r.id ? 'sel' : ''}` },
        h('img', { src: iconFor(out.id) }),
        h('div', { style: 'flex:1' }, h('div', { class: 'nm', text: `${out.name}${r.output.qty > 1 ? ` ×${r.output.qty}` : ''}` }), req),
        h('button', { class: 'btn small', text: 'Craft', disabled: !ok, on: { click: (e) => { e.stopPropagation(); void this.send({ a: 'craft', recipe: r.id, count: (e as MouseEvent).shiftKey ? 5 : 1 }); this.ctx.sound('craft'); } } }));
      el.addEventListener('click', () => { this.selected = r.id; this.sig = ''; this.update(); });
      el.addEventListener('mouseenter', () => this.showTooltip({ id: out.id, qty: r.output.qty }));
      el.addEventListener('mouseleave', () => this.tooltip.classList.add('hidden'));
      list.append(el);
    }
    if (locked) list.append(h('div', { style: 'color:var(--muted);font-size:12px;padding:8px', text: `${locked} more recipes undiscovered — find new materials to learn them.` }));
    const queue = h('div', { class: 'queue' });
    for (const [i, j] of (s.self?.craftQueue ?? []).entries()) {
      const out = RECIPES[j.recipeId]?.output.item ?? 'stick';
      const el = slotEl({ id: out, qty: RECIPES[j.recipeId]?.output.qty ?? 1 });
      el.append(h('div', { class: 'prog', style: `width:${(1 - j.remaining / j.total) * 100}%` }));
      el.title = 'Click to cancel (refunds materials)';
      el.addEventListener('click', () => void this.send({ a: 'craft_cancel', index: i }));
      queue.append(el);
    }
    return h('div', { class: 'panel inv-col craft' },
      h('h3', {}, h('span', { text: 'Crafting' }), h('span', { class: 'weight', text: `Stations: ${[...stations].join(', ') || 'none'}` })),
      cats, list,
      (s.self?.craftQueue.length ?? 0) > 0 ? h('div', {}, h('h3', { text: 'Queue' }), queue) : null,
      h('div', { style: 'font-size:11px;color:var(--muted)', text: 'Shift-click Craft to make 5' }));
  }
}
