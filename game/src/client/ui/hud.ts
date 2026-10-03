/** In-game HUD: vitals, effects, hotbar, compass, clock, prompts, notifications, chat, objectives. */
import { h, clear, fmtTime } from './dom';
import { iconFor } from './icons';
import { ITEMS } from '../../shared/defs/items';
import { PLAYER } from '../../shared/config';
import type { ClientSession } from '../net/session';
import type { Settings } from '../settings';
import { OBJECTIVES, currentObjective } from './objectives';

const EFFECT_INFO: Record<string, { label: string; kind: 'bad' | 'good' | 'info' }> = {
  bleeding: { label: '🩸 Bleeding', kind: 'bad' }, poisoned: { label: '☠ Poisoned', kind: 'bad' }, nausea: { label: '🤢 Nauseous', kind: 'bad' },
  fracture: { label: '🦴 Fractured leg', kind: 'bad' }, exhausted: { label: '😮‍💨 Exhausted', kind: 'bad' }, starving: { label: '🍖 Starving', kind: 'bad' },
  dehydrated: { label: '💧 Dehydrated', kind: 'bad' }, cold: { label: '❄ Cold', kind: 'bad' }, hot: { label: '🔥 Overheating', kind: 'bad' },
  wet: { label: '💦 Wet', kind: 'info' }, wellfed: { label: '✨ Well fed', kind: 'good' }, sheltered: { label: '🏠 Sheltered', kind: 'good' }, warm: { label: '🔥 Warm', kind: 'good' },
};

export class Hud {
  root = h('div', { class: 'hud hidden' });
  private crosshair = h('div', { class: 'crosshair' });
  private prompt = h('div', { class: 'prompt hidden' });
  private vitals = h('div', { class: 'vitals' });
  private bars: Record<string, { row: HTMLElement; fill: HTMLElement }> = {};
  private effects = h('div', { class: 'effects' });
  private hotbar = h('div', { class: 'hotbar' });
  private heldName = h('div', { class: 'held-name' });
  private compass = h('div', { class: 'compass' });
  private strip = h('div', { class: 'strip' });
  private clock = h('div', { class: 'clock' });
  private notes = h('div', { class: 'notes' });
  private pickups = h('div', { class: 'pickups' });
  private chat = h('div', { class: 'chat' });
  private chatInput = h('input', { type: 'text', maxlength: 200, class: 'hidden', placeholder: 'Say something…' }) as HTMLInputElement;
  private center = h('div', { class: 'center-msg' });
  private objective = h('div', { class: 'objective hidden' });
  private netstat = h('div', { class: 'netstat' });
  private markers = h('div', { class: 'passthru', style: 'position:absolute;inset:0' });
  private fish = h('div', { class: 'fishmeter hidden' });
  private boat = h('div', { class: 'boat-hud hidden' });
  private players = h('div', { class: 'panel players hidden' });
  private hotbarSig = '';
  private effectsSig = '';
  private clockHtml = '';
  private compassSig = '';
  private markerPool: HTMLElement[] = [];
  private objectiveSig = '';
  private fishSig = '';
  private boatHtml = '';
  chatOpen = false;
  onChat: ((text: string) => void) | null = null;

  constructor(parent: HTMLElement, private settings: Settings) {
    for (const [k, ic, col] of [['health', '❤', '#ff5d5d'], ['hunger', '🍖', '#ffb35c'], ['thirst', '💧', '#4fb4ff'], ['stamina', '⚡', '#f3e37c'], ['oxygen', '🫧', '#9fe8ff'], ['temp', '🌡', '#7be38a']] as const) {
      const fill = h('div', { class: 'fill', style: `background:${col};width:100%` });
      const row = h('div', { class: 'vital' }, h('span', { class: 'ic', text: ic }), h('div', { class: 'track' }, fill));
      this.bars[k] = { row, fill };
      this.vitals.append(row);
    }
    this.compass.append(this.strip);
    this.chat.append(this.chatInput);
    this.chatInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { const t = this.chatInput.value.trim(); if (t) this.onChat?.(t); this.closeChat(); }
      if (e.key === 'Escape') this.closeChat();
    });
    this.root.append(this.markers, this.crosshair, this.prompt, this.vitals, this.effects, this.hotbar, this.heldName, this.compass, this.clock, this.objective, this.notes, this.pickups, this.chat, this.center, this.netstat, this.fish, this.boat, this.players);
    parent.append(this.root);
  }

  show(v: boolean) { this.root.classList.toggle('hidden', !v); }

  openChat() { this.chatOpen = true; this.chatInput.classList.remove('hidden'); this.chatInput.value = ''; setTimeout(() => this.chatInput.focus(), 0); }
  closeChat() { this.chatOpen = false; this.chatInput.classList.add('hidden'); this.chatInput.blur(); }

  notify(text: string, level: string = 'info') {
    const n = h('div', { class: `note ${level}`, text });
    this.notes.prepend(n);
    while (this.notes.children.length > 6) this.notes.lastElementChild?.remove();
    setTimeout(() => { n.style.transition = 'opacity .6s'; n.style.opacity = '0'; setTimeout(() => n.remove(), 700); }, 6000);
  }

  pickup(id: string, qty: number) {
    const name = ITEMS[id]?.name ?? id;
    const p = h('div', { class: 'pickup' }, h('img', { src: iconFor(id) }), `+${qty} ${name}`);
    this.pickups.prepend(p);
    while (this.pickups.children.length > 5) this.pickups.lastElementChild?.remove();
    setTimeout(() => p.remove(), 3000);
  }

  chatLine(name: string, text: string) {
    const l = h('div', { class: 'line' }, h('b', { text: `${name}: ` }), text);
    this.chat.insertBefore(l, this.chatInput);
    const lines = this.chat.querySelectorAll('.line');
    if (lines.length > 8) lines[0]!.remove();
    setTimeout(() => { if (!this.chatOpen) { l.style.transition = 'opacity 1s'; l.style.opacity = '0'; setTimeout(() => l.remove(), 1000); } }, 15000);
  }

  setCenter(text: string) { this.center.textContent = text; }

  setPrompt(lines: { key?: string; text: string; sub?: string; hp?: number }[] | null) {
    if (!lines || !lines.length) { this.prompt.classList.add('hidden'); this.crosshair.classList.remove('active'); return; }
    clear(this.prompt);
    for (const l of lines) {
      if (l.key) this.prompt.append(h('span', { class: 'keycap', text: l.key }));
      this.prompt.append(h('span', { text: l.text }));
      if (l.sub) this.prompt.append(h('span', { class: 'sub', text: l.sub }));
      if (l.hp !== undefined) this.prompt.append(h('div', { class: 'hpbar' }, h('div', { style: `width:${Math.round(l.hp * 100)}%` })));
    }
    this.prompt.classList.remove('hidden');
    this.crosshair.classList.add('active');
  }

  togglePlayers(show: boolean, session: ClientSession) {
    this.players.classList.toggle('hidden', !show);
    if (!show) return;
    clear(this.players);
    this.players.append(h('h3', { style: 'margin:0 0 10px', text: `Survivors — ${session.worldName}` }));
    for (const r of session.roster) {
      this.players.append(h('div', { class: 'list-item' },
        h('span', {}, h('span', { style: `display:inline-block;width:10px;height:10px;border-radius:50%;background:${r.color};margin-right:8px` }), r.name + (r.id === session.playerId ? ' (you)' : '')),
        h('span', { class: 'meta', text: r.connected ? 'online' : 'away' })));
    }
    this.players.append(h('div', { class: 'meta', style: 'margin-top:8px;color:var(--muted);font-size:12px', text: `Ping ${Math.round(session.rtt)} ms` }));
  }

  update(session: ClientSession, view: { yaw: number; hour: number; day: number; temp: number; fps: number; showNet: boolean; netText: string; coords: { x: number; z: number }; hasCompass: boolean; weather: string }) {
    const s = session.self;
    const me = session.me;
    if (!s || !me) return;
    const set = (k: string, v: number, show = true) => {
      const b = this.bars[k]!;
      b.row.classList.toggle('hidden', !show);
      b.fill.style.width = `${Math.max(0, Math.min(100, v))}%`;
      b.row.classList.toggle('low', v < 20);
    };
    set('health', s.health);
    set('hunger', s.hunger);
    set('thirst', s.thirst);
    set('stamina', s.stamina, s.stamina < 99.5);
    set('oxygen', s.oxygen, s.oxygen < 99.5);
    const tempPct = 50 + (s.bodyTemp - 37) * 25;
    set('temp', tempPct, Math.abs(s.bodyTemp - 37) > 0.4);
    this.bars.temp!.fill.style.background = s.bodyTemp < 36.5 ? '#7fc4ff' : s.bodyTemp > 37.8 ? '#ff8a4a' : '#7be38a';
    // effects
    const effSig = JSON.stringify(s.effects);
    if (effSig !== this.effectsSig) {
      this.effectsSig = effSig;
      clear(this.effects);
      for (const [k, v] of Object.entries(s.effects)) {
        const info = EFFECT_INFO[k];
        if (!info) continue;
        this.effects.append(h('div', { class: `effect ${info.kind}`, text: info.label + (v > 0 && v < 1e6 ? ` ${v}s` : '') }));
      }
    }
    // hotbar
    const sig = JSON.stringify([me.hotbar, me.inventory.slots.slice(0, PLAYER.hotbarSlots)]);
    if (sig !== this.hotbarSig) {
      this.hotbarSig = sig;
      clear(this.hotbar);
      for (let i = 0; i < PLAYER.hotbarSlots; i++) this.hotbar.append(slotEl(me.inventory.slots[i] ?? null, i === me.hotbar, String(i + 1)));
      const held = me.inventory.slots[me.hotbar];
      this.heldName.textContent = held ? ITEMS[held.id]?.name ?? '' : '';
    }
    // compass
    this.compass.classList.toggle('hidden', !view.hasCompass);
    if (view.hasCompass) this.renderCompass(session, view.yaw);
    const icon = view.weather === 'storm' ? '⛈' : view.weather === 'rain' ? '🌧' : view.weather === 'cloudy' ? '☁' : view.weather === 'fog' ? '🌫' : view.hour > 6 && view.hour < 19 ? '☀' : '🌙';
    const clockHtml = `<b>${fmtTime(view.hour)}</b> ${icon}<br>Day ${view.day} · ${view.temp.toFixed(0)}°C${this.settings.gameplay.showCoords || view.hasCompass ? `<br>${view.coords.x.toFixed(0)}, ${view.coords.z.toFixed(0)}` : ''}${this.settings.graphics.showFps ? `<br>${view.fps} FPS` : ''}`;
    if (clockHtml !== this.clockHtml) { this.clockHtml = clockHtml; this.clock.innerHTML = clockHtml; }
    this.crosshair.classList.toggle('hidden', !this.settings.gameplay.crosshair);
    // objective
    if (this.settings.gameplay.showTutorial) {
      const o = currentObjective(session);
      const sig = o?.id ?? '';
      if (sig !== this.objectiveSig) {
        this.objectiveSig = sig;
        this.objective.classList.toggle('hidden', !o);
        if (o) this.objective.innerHTML = `<div class="t">Objective ${OBJECTIVES.indexOf(o) + 1}/${OBJECTIVES.length}</div>${o.title}<div style="color:var(--muted);font-size:12px">${o.hint}</div>`;
      }
    } else { this.objective.classList.add('hidden'); this.objectiveSig = '#off'; }
    this.netstat.textContent = view.showNet ? view.netText : '';
    // fishing
    const f = s.fishing;
    const fsig = f ? f.phase : '';
    if (fsig !== this.fishSig) {
      this.fishSig = fsig;
      this.fish.classList.toggle('hidden', !f);
      if (f) { this.fish.textContent = f.phase === 'bite' ? 'BITE! Click to reel in!' : 'Waiting for a bite… (click to reel in)'; this.fish.classList.toggle('bite', f.phase === 'bite'); }
    }
    // boat
    if (s.vehicleId) {
      const v = session.vehicleAt(s.vehicleId);
      this.boat.classList.remove('hidden');
      if (v) {
        const spd = Math.hypot(v.vx, v.vz);
        const boatHtml = `<b>${v.k === 'outrigger' ? 'Outrigger' : 'Log Raft'}</b> · ${s.seat === 0 ? 'Helm' : 'Passenger'}<br>Speed ${(spd * 1.94).toFixed(1)} kn · Hull ${v.h}<br>${v.an ? '⚓ Anchored' : 'Drifting'}${v.k === 'outrigger' ? ` · Sail ${v.sl ? 'up' : 'down'}` : ''}<br><span style="color:var(--muted);font-size:12px">${s.seat === 0 ? 'W/S paddle · A/D steer · ' : ''}F anchor · R sail · E cargo · Space leave</span>`;
        if (boatHtml !== this.boatHtml) { this.boatHtml = boatHtml; this.boat.innerHTML = boatHtml; }
      }
    } else this.boat.classList.add('hidden');
  }

  private renderCompass(session: ClientSession, yaw: number) {
    const me0 = session.viewPosition();
    const sig = `${Math.round(yaw * 400)}|${Math.round(me0.x / 4)}|${Math.round(me0.z / 4)}|${session.waypoints.length}|${session.remotePlayers().map((p) => `${Math.round(p.x / 4)},${Math.round(p.z / 4)}`).join(';')}`;
    if (sig === this.compassSig) return;
    this.compassSig = sig;
    clear(this.strip);
    const width = this.compass.clientWidth || 500;
    const pxPerRad = width / (Math.PI * 0.75);
    const heading = (((-yaw) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2); // 0 = north (-Z)
    const labels: Record<number, string> = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    for (let d = 0; d < 360; d += 15) {
      let delta = (d * Math.PI) / 180 - heading;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      if (Math.abs(delta) > Math.PI * 0.4) continue;
      const x = width / 2 + delta * pxPerRad;
      const lab = labels[d];
      this.strip.append(h('div', { class: `tick ${lab && lab.length === 1 ? 'major' : ''}`, style: `left:${x}px`, text: lab ?? '·' }));
    }
    const me = session.viewPosition();
    const mark = (x: number, z: number, color: string) => {
      const bearing = Math.atan2(x - me.x, -(z - me.z)); // 0 north, clockwise
      let delta = bearing - heading;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      if (Math.abs(delta) > Math.PI * 0.4) return;
      this.strip.append(h('div', { class: 'mark', style: `left:${width / 2 + delta * pxPerRad}px;background:${color}` }));
    };
    for (const w of session.waypoints) mark(w.x, w.z, w.color);
    for (const p of session.remotePlayers()) mark(p.x, p.z, p.c);
  }

  /** Screen-space markers for teammates/waypoints. */
  updateMarkers(items: { x: number; y: number; label: string; color: string; dist: number }[]) {
    // pooled elements: no per-frame DOM creation
    while (this.markerPool.length < items.length) {
      const el = h('div', { class: 'marker' }, h('div', {}), h('div', { class: 'dot' }));
      this.markers.append(el);
      this.markerPool.push(el);
    }
    this.markerPool.forEach((el, i) => {
      const m = items[i];
      if (!m) { if (el.style.display !== 'none') el.style.display = 'none'; return; }
      el.style.display = '';
      el.style.transform = `translate(${m.x.toFixed(0)}px, ${m.y.toFixed(0)}px) translate(-50%, -100%)`;
      const text = `${m.label} · ${Math.round(m.dist)} m`;
      const label = el.firstElementChild as HTMLElement, dot = el.lastElementChild as HTMLElement;
      if (label.textContent !== text) label.textContent = text;
      if (dot.style.background !== m.color) dot.style.background = m.color;
    });
  }
}

export function slotEl(st: { id: string; qty: number; dur?: number; water?: number; quality?: string } | null, sel = false, key?: string): HTMLElement {
  const el = h('div', { class: `slot ${sel ? 'sel' : ''}` });
  if (key) el.append(h('span', { class: 'key', text: key }));
  if (!st) return el;
  const def = ITEMS[st.id];
  el.append(h('img', { src: iconFor(st.id), draggable: false }));
  if (st.qty > 1) el.append(h('span', { class: 'qty', text: String(st.qty) }));
  if (st.dur !== undefined && def?.durability) {
    const f = st.dur / def.durability;
    el.append(h('div', { class: 'dur' }, h('div', { style: `width:${Math.max(4, f * 100)}%;background:${f > 0.5 ? '#7be38a' : f > 0.2 ? '#ffd166' : '#ff6b6b'}` })));
  }
  if (def?.water) {
    const f = (st.water ?? 0) / def.water.capacity;
    el.append(h('div', { class: 'water' }, h('div', { style: `height:${f * 100}%;background:${st.quality === 'salt' ? '#8fb3c9' : '#4fb4ff'}` })));
  }
  return el;
}
