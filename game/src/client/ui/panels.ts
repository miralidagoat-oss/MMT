/** Build menu, world map and journal panels. */
import { h, clear } from './dom';
import { iconFor } from './icons';
import { STRUCTURE_LIST } from '../../shared/defs/structures';
import { ITEMS } from '../../shared/defs/items';
import { countItem } from '../../shared/systems/inventory';
import type { StructureCategory } from '../../shared/defs/types';
import type { ClientSession } from '../net/session';
import type { WorldGen } from '../../shared/world/worldgen';
import { OBJECTIVES } from './objectives';

const BUILD_GROUPS: { label: string; cats: StructureCategory[] }[] = [
  { label: 'Structure', cats: ['foundation', 'wall', 'floor', 'roof', 'stairs', 'door'] },
  { label: 'Crafting', cats: ['station'] },
  { label: 'Survival', cats: ['utility', 'farming', 'furniture', 'light'] },
  { label: 'Storage & Defense', cats: ['storage', 'defense'] },
  { label: 'Boats', cats: ['vehicle'] },
  { label: 'Rescue', cats: ['special'] },
];

export class BuildMenu {
  root = h('div', { class: 'panel build-menu hidden' });
  visible = false;
  private group = 0;

  constructor(parent: HTMLElement, private session: () => ClientSession, private pick: (id: string) => void, private sound: (id: string) => void) {
    parent.append(this.root);
  }

  open() { this.visible = true; this.root.classList.remove('hidden'); this.render(); this.sound('ui_open'); }
  close() { if (!this.visible) return; this.visible = false; this.root.classList.add('hidden'); }

  private render() {
    clear(this.root);
    const me = this.session().me;
    const tabs = h('div', { class: 'tabs' });
    BUILD_GROUPS.forEach((g, i) => tabs.append(h('div', { class: `tab ${i === this.group ? 'active' : ''}`, text: g.label, on: { click: () => { this.group = i; this.sound('ui_click'); this.render(); } } })));
    const grid = h('div', { class: 'bp-grid' });
    for (const s of STRUCTURE_LIST.filter((x) => BUILD_GROUPS[this.group]!.cats.includes(x.category))) {
      const ok = !!me && s.cost.every((c) => countItem(me.inventory.slots, c.item) >= c.qty);
      const cost = h('div', { class: 'cost' });
      for (const c of s.cost) {
        const have = me ? countItem(me.inventory.slots, c.item) : 0;
        cost.append(h('span', { class: `ing ${have < c.qty ? 'miss' : ''}` }, h('img', { src: iconFor(c.item) }), `${have}/${c.qty}`));
      }
      grid.append(h('div', { class: `bp ${ok ? '' : 'no'}`, title: s.description, on: { click: () => { this.sound('ui_click'); this.pick(s.id); } } },
        h('b', { text: s.name }), h('div', { style: 'color:var(--muted);font-size:11px;margin-top:2px', text: s.description }), cost));
    }
    this.root.append(
      h('div', { class: 'dialog-head' }, h('h2', { text: 'Blueprints' }), h('span', { style: 'color:var(--muted);font-size:12px', text: 'Pick a blueprint, aim, R to rotate, click to place. Right-click cancels. Aim at a piece and press X to dismantle or F to upgrade/repair.' })),
      tabs, grid);
  }
}

// ============================================================ map
const MAP_RES = 512;

export class MapPanel {
  root = h('div', { class: 'map-root hidden' });
  visible = false;
  private base: HTMLCanvasElement | null = null;
  private baseRow = 0;
  private rowOrder: number[] = [];
  private canvas = h('canvas', { width: 760, height: 760 }) as HTMLCanvasElement;
  private zoom = 1;
  private center = { x: 0, z: 0 };
  private dragging: { x: number; y: number; cx: number; cz: number } | null = null;
  private legend = h('div', { class: 'map-legend' });

  constructor(parent: HTMLElement, private session: () => ClientSession, private addWaypoint: (x: number, z: number) => void, private removeWaypoint: (id: string) => void) {
    parent.append(this.root);
    this.root.append(h('div', { class: 'panel map-frame' }, this.canvas, this.legend));
    this.canvas.addEventListener('wheel', (e) => { e.preventDefault(); this.zoom = Math.max(1, Math.min(8, this.zoom * (e.deltaY < 0 ? 1.25 : 0.8))); this.draw(); });
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0 && e.shiftKey) { const w = this.toWorld(e); this.addWaypoint(w.x, w.z); return; }
      if (e.button === 2) {
        const w = this.toWorld(e);
        const s = this.session();
        const near = s.waypoints.find((wp) => Math.hypot(wp.x - w.x, wp.z - w.z) < 40 / this.zoom * (5200 / 760));
        if (near) this.removeWaypoint(near.id); else this.addWaypoint(w.x, w.z);
        return;
      }
      this.dragging = { x: e.clientX, y: e.clientY, cx: this.center.x, cz: this.center.z };
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.dragging) return;
      const k = this.worldSize / (this.canvas.width * this.zoom);
      this.center.x = this.dragging.cx - (e.clientX - this.dragging.x) * k;
      this.center.z = this.dragging.cz - (e.clientY - this.dragging.y) * k;
      this.draw();
    });
    window.addEventListener('mouseup', () => { this.dragging = null; });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private get worldSize() { return this.session().gen?.half ? this.session().gen!.half * 2 : 5200; }

  private toWorld(e: MouseEvent) {
    const r = this.canvas.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * this.canvas.width, py = ((e.clientY - r.top) / r.height) * this.canvas.height;
    const k = this.worldSize / (this.canvas.width * this.zoom);
    return { x: this.center.x + (px - this.canvas.width / 2) * k, z: this.center.z + (py - this.canvas.height / 2) * k };
  }

  /** Progressive background render of the world relief map (call each frame); rows nearest the player first. */
  bake(gen: WorldGen, budgetMs = 2) {
    if (!this.base) {
      this.base = h('canvas', { width: MAP_RES, height: MAP_RES }) as HTMLCanvasElement;
      const ctx0 = this.base.getContext('2d')!;
      ctx0.fillStyle = '#0e2a3c';
      ctx0.fillRect(0, 0, MAP_RES, MAP_RES);
      const pz = this.session().viewPosition().z;
      const start = Math.max(0, Math.min(MAP_RES - 1, Math.floor(((pz + gen.half) / (gen.half * 2)) * MAP_RES)));
      this.rowOrder = [start];
      for (let d = 1; d < MAP_RES; d++) { if (start - d >= 0) this.rowOrder.push(start - d); if (start + d < MAP_RES) this.rowOrder.push(start + d); }
      this.baseRow = 0;
    }
    if (this.baseRow >= MAP_RES) return;
    const ctx = this.base.getContext('2d')!;
    const t0 = performance.now();
    const size = gen.half * 2;
    while (this.baseRow < MAP_RES && performance.now() - t0 < budgetMs) {
      const row = this.rowOrder[this.baseRow]!;
      const img = ctx.createImageData(MAP_RES, 1);
      const z = -gen.half + (row + 0.5) * (size / MAP_RES);
      for (let i = 0; i < MAP_RES; i++) {
        const x = -gen.half + (i + 0.5) * (size / MAP_RES);
        const [r, g, b] = reliefColor(gen.heightAt(x, z));
        img.data[i * 4] = r; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, row);
      this.baseRow++;
    }
  }

  get baked() { return this.baseRow >= MAP_RES; }

  open() {
    const p = this.session().viewPosition();
    this.center = { x: p.x, z: p.z };
    this.zoom = 3;
    this.visible = true;
    this.root.classList.remove('hidden');
    const size = Math.min(window.innerWidth, window.innerHeight) * 0.82;
    this.canvas.style.width = this.canvas.style.height = `${size}px`;
    this.draw();
  }

  close() { this.visible = false; this.root.classList.add('hidden'); }

  draw() {
    if (!this.visible) return;
    const s = this.session();
    const gen = s.gen;
    const me = s.me;
    if (!gen || !me) return;
    const ctx = this.canvas.getContext('2d')!;
    const W = this.canvas.width;
    const size = gen.half * 2;
    const k = (W * this.zoom) / size; // px per meter
    const sx = (x: number) => W / 2 + (x - this.center.x) * k, sy = (z: number) => W / 2 + (z - this.center.z) * k;
    ctx.fillStyle = '#0d2a36';
    ctx.fillRect(0, 0, W, W);
    if (this.base) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.base, sx(-gen.half), sy(-gen.half), size * k, size * k);
    }
    // fog of war over unexplored 128 m cells
    const explored = new Set(me.explored);
    ctx.fillStyle = 'rgba(8,22,30,0.92)';
    const cs = 128;
    const x0 = Math.floor((this.center.x - W / 2 / k) / cs), x1 = Math.ceil((this.center.x + W / 2 / k) / cs);
    const z0 = Math.floor((this.center.z - W / 2 / k) / cs), z1 = Math.ceil((this.center.z + W / 2 / k) / cs);
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
      if (explored.has(`${cx},${cz}`)) continue;
      ctx.fillRect(Math.floor(sx(cx * cs)), Math.floor(sy(cz * cs)), Math.ceil(cs * k) + 1, Math.ceil(cs * k) + 1);
    }
    // grid
    const hasChart = me.inventory.slots.some((x) => x?.id === 'chart');
    if (hasChart) {
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 1;
      for (let g = -gen.half; g <= gen.half; g += 500) {
        ctx.beginPath(); ctx.moveTo(sx(g), 0); ctx.lineTo(sx(g), W); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, sy(g)); ctx.lineTo(W, sy(g)); ctx.stroke();
      }
    }
    // island names (discovered)
    ctx.font = '600 13px system-ui';
    ctx.textAlign = 'center';
    for (const id of s.progression?.discoveredIslands ?? []) {
      const isl = gen.islands[id];
      if (!isl) continue;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillText(isl.name, sx(isl.x) + 1, sy(isl.z - isl.radius * 1.1) + 1);
      ctx.fillStyle = '#fff3dc';
      ctx.fillText(isl.name, sx(isl.x), sy(isl.z - isl.radius * 1.1));
    }
    // wrecks in explored cells
    for (const w of gen.wrecks) {
      if (!explored.has(`${Math.floor(w.x / cs)},${Math.floor(w.z / cs)}`)) continue;
      ctx.fillStyle = w.kind === 'deep' ? '#ff7a5a' : '#d8b28a';
      ctx.font = '14px system-ui';
      ctx.fillText('⚓', sx(w.x), sy(w.z) + 5);
    }
    // events
    for (const e of s.events) {
      if (e.kind !== 'supply_drop' && e.kind !== 'rescue') continue;
      ctx.fillStyle = e.kind === 'rescue' ? '#7be38a' : '#ffb35c';
      ctx.beginPath(); ctx.arc(sx(e.x), sy(e.z), 6, 0, 7); ctx.fill();
    }
    // waypoints
    for (const wp of s.waypoints) {
      ctx.fillStyle = wp.color;
      ctx.beginPath(); ctx.moveTo(sx(wp.x), sy(wp.z)); ctx.lineTo(sx(wp.x) - 6, sy(wp.z) - 14); ctx.lineTo(sx(wp.x) + 6, sy(wp.z) - 14); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = '11px system-ui'; ctx.fillText(wp.label, sx(wp.x), sy(wp.z) - 18);
    }
    // structures (tiny squares)
    ctx.fillStyle = 'rgba(255,220,170,0.8)';
    for (const st of Object.values(s.structures)) ctx.fillRect(sx(st.x) - 1, sy(st.z) - 1, 2, 2);
    // boats
    for (const v of s.vehicles()) { ctx.fillStyle = '#c9a26b'; ctx.fillRect(sx(v.x) - 3, sy(v.z) - 3, 6, 6); }
    // teammates
    for (const p of s.remotePlayers()) {
      ctx.fillStyle = p.c; ctx.beginPath(); ctx.arc(sx(p.x), sy(p.z), 5, 0, 7); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = '11px system-ui'; ctx.fillText(p.n, sx(p.x), sy(p.z) - 9);
    }
    // me (arrow)
    const mp = s.viewPosition();
    const yaw = s.pred.yaw;
    ctx.save();
    ctx.translate(sx(mp.x), sy(mp.z));
    ctx.rotate(-yaw);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.beginPath(); ctx.moveTo(0, -9); ctx.lineTo(6, 7); ctx.lineTo(0, 3); ctx.lineTo(-6, 7); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
    // compass rose
    ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.font = 'bold 14px system-ui'; ctx.fillText('N', W - 26, 24);
    this.legend.textContent = `${hasChart ? `Position ${mp.x.toFixed(0)}, ${mp.z.toFixed(0)} · ` : 'Craft a Sea Chart for a coordinate grid · '}Scroll to zoom · drag to pan · right-click to add/remove waypoint`;
  }
}

function reliefColor(h: number): [number, number, number] {
  if (h < -25) return [14, 42, 60];
  if (h < -8) return [20, 70, 92];
  if (h < -2) return [36, 120, 132];
  if (h < 0) return [80, 170, 168];
  if (h < 1.8) return [220, 204, 160];
  if (h < 12) return [70 + h * 2, 120 + h, 60];
  if (h < 28) return [110, 115, 90];
  return [170, 165, 160];
}

// ============================================================ journal
export class Journal {
  root = h('div', { class: 'overlay hidden' });
  visible = false;
  constructor(parent: HTMLElement, private session: () => ClientSession) { parent.append(this.root); }

  open() {
    this.visible = true;
    this.root.classList.remove('hidden');
    clear(this.root);
    const s = this.session();
    const list = h('div', {});
    for (const o of OBJECTIVES) {
      const done = o.done(s);
      list.append(h('div', { class: `task ${done ? 'done' : ''}` }, h('div', { class: 'ck', text: done ? '✓' : '' }), h('div', { class: 'txt' }, o.title, h('span', { class: 'd', text: o.hint }))));
    }
    const st = s.me?.stats;
    const known = s.me?.discovered.filter((d) => ITEMS[d]).length ?? 0;
    this.root.append(h('div', { class: 'panel dialog journal' },
      h('div', { class: 'dialog-head' }, h('h2', { text: 'Survival Journal' }), h('span', { style: 'color:var(--muted);font-size:13px', text: st ? `Days survived ${st.daysSurvived} · crafted ${st.crafted} · harvested ${st.harvested} · walked ${(st.distance / 1000).toFixed(1)} km · deaths ${st.deaths} · ${known} items discovered` : '' })),
      h('div', { class: 'dialog-body' }, list)));
  }

  close() { this.visible = false; this.root.classList.add('hidden'); }
}
