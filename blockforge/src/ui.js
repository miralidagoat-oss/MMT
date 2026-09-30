// HTML user interface: HUD, menus, inventory screens, chat and debug text.
import { ITEMS, I, matchRecipe, itemName, maxStack, SMELTING, fuelValue } from './items.js';
import { enchantOptions, enchantLabel, applicableEnchants } from './loot.js';
import { BLOCKS, B } from './blocks.js';
import { statusIcons, playerPortrait } from './icons.js';
import { BIOMES } from './worldgen.js';
import { DEFAULT_KEYS } from './input.js';

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CREATIVE_ORDER = () => {
  const out = [];
  for (const d of BLOCKS) if (d && d.item && d.creative !== false && ITEMS[d.id]) out.push(d.id);
  for (const d of ITEMS) if (d && d.id >= 256) out.push(d.id);
  return out;
};

export class UI {
  constructor(root, { icons, settings, saveSettings, storage, app, playerSkin }) {
    this.portrait = playerSkin ? playerPortrait(playerSkin) : '';
    this.root = root;
    this.icons = icons;
    this.settings = settings;
    this.saveSettings = saveSettings;
    this.storage = storage;
    this.app = app; // callbacks: newWorld, loadWorld, quit, applySettings
    this.status = statusIcons();
    this.cursor = null;
    this.screen = null;
    this.chatLines = [];
    this.messages = $('#chat-log');
    this.hudCache = {};
    this.buildHUD();
    this.tooltip = $('#tooltip');
    this.cursorEl = $('#cursor-item');
    document.addEventListener('mousemove', (e) => this.onMouseMove(e));
    document.addEventListener('mouseup', (e) => this.onMouseUp(e));
    window.addEventListener('resize', () => this.applyGuiScale());
    this.applyGuiScale();
  }

  attach(game) { this.game = game; }

  applyGuiScale() {
    const s = this.settings.guiScale;
    const u = s > 0 ? s : Math.max(1, Math.min(4, Math.min(window.innerWidth / 640, window.innerHeight / 400)));
    document.documentElement.style.setProperty('--u', `${u.toFixed(3)}px`);
  }

  // ---------------------------------------------------------------------------
  // HUD
  buildHUD() {
    const hot = $('#hotbar');
    hot.innerHTML = '';
    this.hotSlots = [];
    for (let i = 0; i < 9; i++) {
      const s = this.slotEl();
      s.classList.add('hot');
      hot.appendChild(s);
      this.hotSlots.push(s);
    }
    this.hotSel = el('div', 'hot-sel');
    hot.appendChild(this.hotSel);
    const mk = (id, n) => {
      const c = $(id); c.innerHTML = '';
      const arr = [];
      for (let i = 0; i < n; i++) { const im = el('img'); im.alt = ''; c.appendChild(im); arr.push(im); }
      return arr;
    };
    this.heartEls = mk('#hearts', 10);
    this.foodEls = mk('#food', 10);
    this.airEls = mk('#air', 10);
    this.armorEls = mk('#armor', 10);
    $('#b-wake').addEventListener('click', () => { this.click(); if (this.game) this.game.wakeUp(); });
  }

  slotEl() {
    const s = el('div', 'slot');
    s.innerHTML = '<img alt=""><span class="count"></span><span class="dur"><i></i></span>';
    return s;
  }

  fillSlot(s, stack) {
    const key = stack ? `${stack.id}:${stack.count}:${stack.dur || 0}:${stack.ench ? 1 : 0}` : '';
    if (s._key === key) return;
    s._key = key;
    const img = s.firstChild, cnt = s.children[1], dur = s.children[2];
    if (!stack) { img.removeAttribute('src'); img.style.visibility = 'hidden'; cnt.textContent = ''; dur.style.display = 'none'; s.classList.remove('ench'); return; }
    img.src = this.icons.get(stack.id); img.style.visibility = 'visible';
    s.classList.toggle('ench', !!stack.ench);
    cnt.textContent = stack.count > 1 ? stack.count : '';
    const d = ITEMS[stack.id];
    if (d && d.durability && stack.dur) {
      const f = Math.max(0, 1 - stack.dur / d.durability);
      dur.style.display = 'block';
      dur.firstChild.style.width = `${Math.round(f * 100)}%`;
      dur.firstChild.style.background = `hsl(${Math.round(f * 120)}, 90%, 50%)`;
    } else dur.style.display = 'none';
  }

  frame(dt, env) {
    const g = this.game;
    if (!g || !g.player) return;
    const p = g.player;
    const playing = g.state === 'playing' || g.state === 'screen' || g.state === 'dead';
    const hud = $('#hud');
    hud.hidden = !playing || g.hideHud || g.demo;
    $('#overlay-water').style.opacity = env.underwater && !g.demo ? '1' : '0';
    $('#overlay-lava').style.opacity = env.inLava ? '1' : '0';
    $('#overlay-fire').style.opacity = !g.demo && p.fireTicks > 0 && !p.creative && g.perspective === 0 ? '1' : '0';
    const hurt = !g.demo && p.hurtTime > 0 ? p.hurtTime / 10 : 0;
    $('#overlay-hurt').style.opacity = String(hurt * 0.35);
    $('#overlay-portal').style.opacity = !g.demo && env.portal > 0 ? String(0.25 + env.portal * 0.75) : '0';
    $('#overlay-sleep').style.opacity = !g.demo && env.sleep > 0 ? String(Math.min(0.92, env.sleep * 0.92)) : '0';
    $('#overlay-flash').style.opacity = !g.demo && g.flash > 0 && g.dim === 'overworld' ? String(g.flash * 0.5) : '0';
    $('#click-to-play').hidden = !(g.state === 'playing' && !g.input.locked && !g.input.dragLook && !g.input.touch.active);
    if (hud.hidden) { this.updateChat(); return; }
    // hotbar
    const inv = p.inventory;
    for (let i = 0; i < 9; i++) this.fillSlot(this.hotSlots[i], inv.get(i));
    this.hotSel.style.setProperty('--i', inv.selected);
    // selected item name
    const held = inv.held;
    const hid = held ? held.id : 0;
    if (hid !== this.lastHeldName) {
      this.lastHeldName = hid;
      const n = $('#item-name');
      n.textContent = held ? itemName(held.id) : '';
      n.classList.remove('fade'); void n.offsetWidth; n.classList.add('fade');
    }
    // status bars
    const survival = !p.creative && !p.spectator;
    $('#bars').hidden = !survival;
    $('#air').hidden = !survival || p.air >= 300;
    $('#xp').hidden = !survival;
    const armor = p.armorStats().points;
    $('#armor').hidden = !survival || armor <= 0;
    if (armor > 0) g.advance('armor');
    if (survival) {
      const xkey = `${p.xpLevel}|${p.xpPoints}|${armor}`;
      if (xkey !== this.hudCache.xp) {
        this.hudCache.xp = xkey;
        const xp = $('#xp');
        xp.firstChild.style.width = `${Math.round(Math.min(1, p.xpProgress) * 1000) / 10}%`;
        xp.lastChild.textContent = p.xpLevel > 0 ? p.xpLevel : '';
        for (let i = 0; i < 10; i++) {
          const v = armor - i * 2;
          this.armorEls[i].src = v >= 2 ? this.status.armor : v === 1 ? this.status.armorHalf : this.status.armorEmpty;
        }
      }
      const hkey = `${p.health}|${p.food}|${p.hurtTime > 0}|${p.air}|${Math.floor(g.tickCount / 3) % 2}`;
      if (hkey !== this.hudCache.bars) {
        this.hudCache.bars = hkey;
        const flash = p.hurtTime > 5;
        const low = p.health <= 4;
        for (let i = 0; i < 10; i++) {
          const v = p.health - i * 2;
          const img = this.heartEls[i];
          img.src = v >= 2 ? (flash ? this.status.heartFlash : this.status.heart) : v === 1 ? this.status.heartHalf : this.status.heartEmpty;
          img.style.transform = low ? `translateY(${((i * 37 + g.tickCount) % 3) - 1}px)` : '';
          const f = p.food - i * 2;
          // food icons fill from the right
          const fi = this.foodEls[9 - i];
          fi.src = f >= 2 ? this.status.food : f === 1 ? this.status.foodHalf : this.status.foodEmpty;
          fi.style.transform = p.saturation <= 0 && p.food < 6 ? `translateY(${((i * 13 + g.tickCount) % 3) - 1}px)` : '';
        }
        const bubbles = Math.ceil(Math.max(0, p.air) / 30);
        for (let i = 0; i < 10; i++) {
          const b = this.airEls[9 - i];
          b.src = i < bubbles ? this.status.bubble : this.status.bubblePop;
          b.style.visibility = i < bubbles || i === bubbles ? 'visible' : 'hidden';
        }
      }
    }
    $('#crosshair').hidden = g.perspective !== 0;
    this.updateGadget();
    this.updateDebug();
    this.updateChat();
    if (this.screen && this.screen.update) this.screen.update();
  }

  // Clock and compass readouts while one is held (or in the off hand of the hotbar).
  updateGadget() {
    const g = this.game, p = g.player;
    const box = $('#gadget');
    const inv = p.inventory;
    const held = inv.held ? inv.held.id : 0;
    const clock = held === I.clock, compass = held === I.compass;
    box.hidden = !(clock || compass);
    if (box.hidden) return;
    const key = `${held}|${Math.floor(g.dayTime / 50)}|${Math.round(p.yaw * 20)}|${Math.floor(p.x / 4)}|${Math.floor(p.z / 4)}|${g.dim}`;
    if (key === this.hudCache.gadget) return;
    this.hudCache.gadget = key;
    const wobble = g.dim !== 'overworld';
    if (clock) {
      // day starts at 6:00 in the morning
      const mins = Math.floor(((g.dayTime / 24000) * 24 * 60 + 6 * 60) % (24 * 60));
      const t = wobble ? '??:??' : `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
      const phase = g.dayTime < 12000 ? 'Day' : g.dayTime < 13800 ? 'Dusk' : g.dayTime < 22200 ? 'Night' : 'Dawn';
      const hand = wobble ? (performance.now() / 3) % 360 : (mins / 720) * 360;
      box.innerHTML = `<span class="needle" style="--a:${hand.toFixed(1)}deg"></span><span>${t} · ${wobble ? 'the hands spin wildly' : `${phase}, day ${g.day}`}</span>`;
    } else {
      const sp = p.worldSpawn || p.spawn || { x: 0, z: 0 };
      const dx = sp.x - p.x, dz = sp.z - p.z;
      const dist = Math.round(Math.hypot(dx, dz));
      // needle relative to where the player faces (yaw 0 looks toward -Z)
      const target = Math.atan2(dx, -dz);
      const a = wobble ? (performance.now() / 5) % 360 : ((target - p.yaw) * 180) / Math.PI;
      box.innerHTML = `<span class="needle" style="--a:${a.toFixed(1)}deg"></span><span>${wobble ? 'The needle spins' : `Spawn ${dist} m`}</span>`;
    }
  }

  showSleep(v) {
    const g = this.game;
    const box = $('#sleep-ui');
    if (v) {
      if (this.screen) this.closeScreen(true);
      g.input.exitLock();
      g.input.reset();
      g.state = 'screen';
      this.screen = { name: 'sleep' };
      box.hidden = false;
    } else {
      box.hidden = true;
      if (this.screen && this.screen.name === 'sleep') {
        this.screen = null;
        if (g.state === 'screen') this.resume();
      }
    }
  }

  toast(title, desc) {
    const box = $('#toasts');
    const t = el('div', 'toast', `<small>Milestone reached!</small><b>${esc(title)}</b><span>${esc(desc)}</span>`);
    box.appendChild(t);
    setTimeout(() => t.remove(), 5200);
    while (box.children.length > 3) box.firstChild.remove();
  }

  updateDebug() {
    const g = this.game;
    const d = $('#debug');
    if (!g.showDebug) { d.hidden = true; return; }
    d.hidden = false;
    if ((this.dbgT = (this.dbgT || 0) + 1) % 6) return;
    const p = g.player, w = g.world, r = g.renderer;
    const fx = Math.floor(p.x), fy = Math.floor(p.y), fz = Math.floor(p.z);
    const yawDeg = ((p.yaw * 180 / Math.PI) % 360 + 360) % 360;
    const dirs = ['north (-Z)', 'east (+X)', 'south (+Z)', 'west (-X)'];
    const facing = dirs[Math.round(yawDeg / 90) % 4];
    const l = w.getLight(fx, Math.floor(p.y + 0.5), fz);
    const bio = w.gen.biomeName ? { name: w.gen.biomeName(fx, fz) } : BIOMES[w.gen.biomeAt(fx, fz)];
    const t = g.target;
    const left = [
      `Blockforge ${this.app.version}  ${g.fps} fps  (${g.frameMs.toFixed(1)} ms render)`,
      `Chunks: ${r.stats.drawn}/${r.stats.chunks} drawn, ${w.chunks.size} loaded, ${w.pool.pending} jobs${w.pool.fallback ? ' (main thread)' : ` on ${w.pool.workers.length} workers`}`,
      `Quads: ${r.stats.quads.toLocaleString()}  Entities: ${g.entities.length}  Items: ${g.items.length}  Particles: ${g.particles.list.length}`,
      '',
      `XYZ: ${p.x.toFixed(3)} / ${p.y.toFixed(3)} / ${p.z.toFixed(3)}`,
      `Block: ${fx} ${fy} ${fz}  Chunk: ${fx >> 4} ${fz >> 4} [${fx & 15} ${fz & 15}]`,
      `Facing: ${facing}  (${yawDeg.toFixed(1)} / ${(p.pitch * 180 / Math.PI).toFixed(1)})`,
      `Light: ${l >> 4} sky, ${l & 15} block`,
      `Biome: ${bio ? bio.name : '?'}`,
      `Day ${g.day}, time ${g.dayTime}${g.rain > 0.1 ? ', raining' : ''}`,
      `Mode: ${p.mode}${p.flying ? ' (flying)' : ''}  Dimension: ${g.dim}`,
      `Level ${p.xpLevel} (${p.xpPoints}/${p.constructor.xpToNext(p.xpLevel)} xp)  Armor ${p.armorStats().points}`,
    ];
    const right = [
      `${r.width}x${r.height} (${(r.renderScale * 100).toFixed(0)}% scale, DPR ${(window.devicePixelRatio || 1).toFixed(2)})`,
      `GPU: ${esc(r.gpuName || 'unknown')}`,
      `Render distance: ${g.settings.renderDistance}`,
      '',
      t ? `Targeted: ${BLOCKS[t.id].display}` : g.targetEntity ? `Targeted: ${g.targetEntity.type}` : '',
      t ? `at ${t.x} ${t.y} ${t.z} (meta ${w.getMeta(t.x, t.y, t.z)})` : '',
    ];
    d.innerHTML = `<div class="dl">${left.map((s) => `<span>${esc(s)}</span>`).join('')}</div><div class="dr">${right.map((s) => `<span>${s}</span>`).join('')}</div>`;
  }

  // ---------------------------------------------------------------------------
  // Chat
  message(text, color) {
    if (!text) return;
    this.chatLines.push({ text, color, t: performance.now() });
    if (this.chatLines.length > 50) this.chatLines.shift();
    this.chatDirty = true;
  }

  updateChat() {
    const now = performance.now();
    const open = this.screen && this.screen.name === 'chat';
    const lines = open ? this.chatLines.slice(-14) : this.chatLines.filter((l) => now - l.t < 10000).slice(-8);
    const key = lines.map((l) => l.t).join(',') + open + Math.floor(now / 500);
    if (key === this.chatKey) return;
    this.chatKey = key;
    this.messages.innerHTML = lines.map((l) => {
      const age = now - l.t;
      const op = open ? 1 : Math.max(0, Math.min(1, (10000 - age) / 1000));
      return `<div style="opacity:${op}${l.color ? `;color:${l.color}` : ''}">${esc(l.text)}</div>`;
    }).join('');
  }

  openChat(prefix = '') {
    const g = this.game;
    this.screen = { name: 'chat' };
    g.state = 'screen';
    g.input.exitLock();
    g.input.reset();
    const box = $('#chat-input');
    box.hidden = false;
    box.value = prefix;
    this.chatHistoryIdx = -1;
    setTimeout(() => { box.focus(); box.setSelectionRange(prefix.length, prefix.length); }, 0);
  }

  closeChat(send) {
    const box = $('#chat-input');
    const text = box.value.trim();
    box.hidden = true; box.blur();
    this.screen = null;
    this.resume();
    if (send && text) {
      this.history = this.history || [];
      this.history.push(text);
      if (text.startsWith('/')) {
        this.message(text, '#9fb3c8');
        const res = this.game.runCommand(text);
        if (res) this.message(res, '#e8d48a');
      } else this.message(`<You> ${text}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Keyboard routing. Returns true when the UI consumed the key.
  onKey(e) {
    const g = this.game;
    if (!g) return false;
    const code = e.code;
    const k = this.settings.keys || DEFAULT_KEYS;
    if (this.screen && this.screen.name === 'chat') {
      if (code === 'Enter') { this.closeChat(true); return true; }
      if (code === 'Escape') { this.closeChat(false); return true; }
      if (code === 'ArrowUp' || code === 'ArrowDown') {
        const h = this.history || [];
        if (!h.length) return true;
        if (this.chatHistoryIdx < 0) this.chatHistoryIdx = h.length;
        this.chatHistoryIdx = Math.max(0, Math.min(h.length, this.chatHistoryIdx + (code === 'ArrowUp' ? -1 : 1)));
        $('#chat-input').value = h[this.chatHistoryIdx] || '';
        return true;
      }
      return false;
    }
    if (document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && code !== 'Escape') return false;
    if (g.state === 'screen' && this.screen) {
      if (code === 'Escape' || code === k.inventory) { this.closeScreen(); return true; }
      if (/^Digit[1-9]$/.test(code) && this.hover) { this.swapWithHotbar(this.hover, +code.slice(5) - 1); return true; }
      if (code === k.drop && this.hover) { this.dropFromSlot(this.hover, e.ctrlKey); return true; }
      return false;
    }
    if (g.state === 'paused') { if (code === 'Escape' && !e.repeat) { this.closeMenus(); this.resume(); } return true; }
    if (g.state === 'playing') {
      if (code === 'Escape') { this.pause(); return true; }
      if (e.repeat) return false;
      if (code === k.inventory) { this.openScreen(g.player.creative ? 'creative' : 'inventory'); return true; }
      if (code === k.chat) { e.preventDefault(); this.openChat(''); return true; }
      if (code === k.command) { e.preventDefault(); this.openChat('/'); return true; }
      if (code === k.debug) { g.showDebug = !g.showDebug; return true; }
      if (code === k.hideHud) { g.hideHud = !g.hideHud; return true; }
      if (code === k.perspective) { g.perspective = (g.perspective + 1) % 3; return true; }
      if (code === k.screenshot) { g.screenshotPending = true; return true; }
      if (code === k.drop) { g.dropHeld(e.ctrlKey); return true; }
      if (/^Digit[1-9]$/.test(code)) { g.player.inventory.selected = +code.slice(5) - 1; return true; }
      if (code === 'F11') return false;
    }
    if (g.state === 'dead') return true;
    return false;
  }

  pause() {
    const g = this.game;
    if (g.state !== 'playing') return;
    g.state = 'paused';
    g.input.exitLock();
    g.input.reset();
    this.showPause();
  }

  resume() {
    const g = this.game;
    this.closeMenus();
    g.state = 'playing';
    g.input.reset();
    g.last = performance.now();
    g.input.requestLock();
  }

  onUnlock() {
    const g = this.game;
    if (g && g.state === 'playing') this.pause();
  }

  screenshotTaken(url) {
    if (!url) { this.message('Screenshot failed', '#ff8080'); return; }
    let embedded = false;
    try { embedded = window.top !== window; } catch { embedded = true; }
    if (!embedded) {
      const a = document.createElement('a');
      a.href = url; a.download = `blockforge-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
      document.body.appendChild(a); a.click(); a.remove();
      this.message('Saved screenshot', '#9fe09f');
      return;
    }
    // Downloads may be blocked inside an embedding page: show the image so it
    // can be saved with the browser's own "Save image" menu.
    const box = el('div', 'shot', `<img src="${url}" alt="Screenshot"><p>Right-click the image to save it · click anywhere to close</p>`);
    box.addEventListener('click', () => box.remove());
    document.getElementById('app').appendChild(box);
    this.message('Screenshot captured', '#9fe09f');
  }

  // ---------------------------------------------------------------------------
  // Menus
  menu(html, cls = '') {
    const s = $('#screens');
    s.innerHTML = '';
    const m = el('div', `menu ${cls}`, html);
    s.appendChild(m);
    s.hidden = false;
    return m;
  }

  closeMenus() { const s = $('#screens'); s.innerHTML = ''; s.hidden = true; }

  click() { if (this.game) this.game.audio.play('click'); }

  bind(m, sel, fn) {
    const b = $(sel, m);
    if (b) b.addEventListener('click', (e) => { this.click(); fn(e); });
  }

  showTitle() {
    const m = this.menu(`
      <div class="logo"><span>BLOCK</span><span>FORGE</span></div>
      <p class="tagline">An open-world voxel sandbox</p>
      <div class="buttons">
        <button id="b-play" class="btn wide">Play</button>
        <div class="row"><button id="b-options" class="btn">Options</button><button id="b-controls" class="btn">Controls</button></div>
      </div>
      <p class="foot">Blockforge ${this.app.version} · all art, sound and code generated procedurally</p>`, 'title');
    this.bind(m, '#b-play', () => this.showWorlds());
    this.bind(m, '#b-options', () => this.showOptions(() => this.showTitle()));
    this.bind(m, '#b-controls', () => this.showControls(() => this.showTitle()));
  }

  async showWorlds() {
    const worlds = await this.storage.listWorlds();
    const fmt = (t) => new Date(t).toLocaleString();
    const m = this.menu(`
      <h2>Select World</h2>
      <div class="world-list" id="wl">${worlds.length ? '' : '<p class="muted">No saved worlds yet. Create one to start.</p>'}</div>
      ${this.storage.persistent ? '' : '<p class="warn">Saving is unavailable in this browser session; worlds last until the page closes.</p>'}
      <div class="row"><button id="b-playw" class="btn" disabled>Play Selected World</button><button id="b-new" class="btn">Create New World</button></div>
      <div class="row"><button id="b-del" class="btn" disabled>Delete</button><button id="b-back" class="btn">Back</button></div>`, 'worlds');
    const list = $('#wl', m);
    let sel = null;
    for (const w of worlds) {
      const it = el('button', 'world');
      it.innerHTML = `<b>${esc(w.name)}</b><span>${esc(w.mode === 'creative' ? 'Creative' : 'Survival')} · last played ${esc(fmt(w.lastPlayed))}</span>`;
      it.addEventListener('click', () => {
        for (const x of list.children) x.classList.remove('sel');
        it.classList.add('sel'); sel = w;
        $('#b-playw', m).disabled = false; $('#b-del', m).disabled = false;
      });
      it.addEventListener('dblclick', () => { this.click(); this.app.loadWorld(w); });
      list.appendChild(it);
    }
    this.bind(m, '#b-playw', () => sel && this.app.loadWorld(sel));
    this.bind(m, '#b-new', () => this.showCreate());
    this.bind(m, '#b-back', () => this.showTitle());
    this.bind(m, '#b-del', () => {
      if (!sel) return;
      const w = sel;
      const c = this.menu(`<h2>Delete “${esc(w.name)}”?</h2><p class="muted">This world will be gone for good.</p>
        <div class="row"><button id="b-yes" class="btn danger">Delete</button><button id="b-no" class="btn">Cancel</button></div>`);
      this.bind(c, '#b-yes', async () => { await this.storage.deleteWorld(w.id); this.showWorlds(); });
      this.bind(c, '#b-no', () => this.showWorlds());
    });
  }

  showCreate() {
    const m = this.menu(`
      <h2>Create New World</h2>
      <label class="field"><span>World name</span><input id="w-name" maxlength="40" value="New World"></label>
      <label class="field"><span>Seed (leave blank for random)</span><input id="w-seed" maxlength="60" placeholder="random"></label>
      <div class="field"><span>Game mode</span><div class="seg" id="w-mode">
        <button class="btn sel" data-m="survival">Survival</button><button class="btn" data-m="creative">Creative</button></div>
        <p class="muted" id="w-mode-desc">Gather resources, craft tools, stay fed and survive the night.</p></div>
      <div class="row"><button id="b-create" class="btn">Create World</button><button id="b-cancel" class="btn">Cancel</button></div>`, 'create');
    let mode = 'survival';
    for (const b of m.querySelectorAll('#w-mode button')) {
      b.addEventListener('click', () => {
        this.click();
        for (const x of m.querySelectorAll('#w-mode button')) x.classList.remove('sel');
        b.classList.add('sel'); mode = b.dataset.m;
        $('#w-mode-desc', m).textContent = mode === 'creative' ? 'Unlimited blocks, instant breaking and flight (double-tap jump).' : 'Gather resources, craft tools, stay fed and survive the night.';
      });
    }
    this.bind(m, '#b-create', () => {
      const name = $('#w-name', m).value.trim() || 'New World';
      const seed = $('#w-seed', m).value.trim();
      this.app.newWorld({ name, seed, mode });
    });
    this.bind(m, '#b-cancel', () => this.showWorlds());
    setTimeout(() => $('#w-name', m).select(), 0);
  }

  showLoading(text, progress) {
    let m = $('#screens .loading');
    if (!m) m = this.menu('<h2 id="ld-text"></h2><div class="bar"><i id="ld-bar"></i></div><p class="muted" id="ld-sub"></p>', 'loading');
    $('#ld-text', m).textContent = text;
    $('#ld-bar', m).style.width = `${Math.round(progress * 100)}%`;
    $('#ld-sub', m).textContent = `${Math.round(progress * 100)}%`;
  }

  showPause() {
    const m = this.menu(`
      <h2>Game Menu</h2>
      <div class="buttons">
        <button id="b-resume" class="btn wide">Back to Game</button>
        <div class="row"><button id="b-opt" class="btn">Options</button><button id="b-ctl" class="btn">Controls</button></div>
        <button id="b-quit" class="btn wide">Save and Quit to Title</button>
      </div>`, 'pause');
    this.bind(m, '#b-resume', () => this.resume());
    this.bind(m, '#b-opt', () => this.showOptions(() => this.showPause()));
    this.bind(m, '#b-ctl', () => this.showControls(() => this.showPause()));
    this.bind(m, '#b-quit', () => this.app.quit());
  }

  showDeath(msg) {
    const g = this.game;
    g.state = 'dead';
    g.input.exitLock();
    g.input.reset();
    if (this.screen) this.closeScreen(true);
    const m = this.menu(`<h1 class="dead">You Died!</h1><p>${esc(msg)}</p>
      <div class="buttons"><button id="b-respawn" class="btn wide">Respawn</button><button id="b-title" class="btn wide">Title Screen</button></div>`, 'death');
    const btns = m.querySelectorAll('button');
    btns.forEach((b) => { b.disabled = true; });
    setTimeout(() => btns.forEach((b) => { b.disabled = false; }), 1000);
    this.bind(m, '#b-respawn', () => { g.respawn(); this.resume(); });
    this.bind(m, '#b-title', () => { g.respawn(); this.app.quit(); });
  }

  showOptions(back) {
    const s = this.settings;
    const rows = [
      ['renderDistance', 'Render distance', 2, 24, 1, (v) => `${v} chunks`],
      ['fov', 'Field of view', 50, 110, 1, (v) => (v === 70 ? 'Normal' : `${v}°`)],
      ['sensitivity', 'Mouse sensitivity', 10, 200, 1, (v) => `${v}%`],
      ['renderScale', 'Resolution scale', 50, 200, 10, (v) => `${v}%${v > 100 ? ' (supersampled)' : ''}`],
      ['guiScale', 'Interface size', 0, 4, 1, (v) => (v === 0 ? 'Auto' : `${v}x`)],
      ['brightness', 'Brightness', 0, 100, 1, (v) => (v === 0 ? 'Moody' : v === 100 ? 'Bright' : `${v}%`)],
      ['volume', 'Sound volume', 0, 100, 1, (v) => `${v}%`],
      ['music', 'Music volume', 0, 100, 1, (v) => (v ? `${v}%` : 'Off')],
    ];
    const toggles = [['bobbing', 'View bobbing'], ['clouds', 'Clouds'], ['invertMouse', 'Invert mouse'], ['peaceful', 'Peaceful (no hostile creatures)']];
    const m = this.menu(`<h2>Options</h2><div class="opts">${rows.map(([k, label, min, max, step]) => `
      <label class="opt"><span class="ol">${label}: <b id="ov-${k}"></b></span><input type="range" id="o-${k}" min="${min}" max="${max}" step="${step}" value="${s[k]}"></label>`).join('')}
      ${toggles.map(([k, label]) => `<button class="btn tog" id="o-${k}">${label}: ${s[k] ? 'On' : 'Off'}</button>`).join('')}
      </div><button id="b-done" class="btn wide">Done</button>`, 'options');
    for (const [k, , , , , fmt] of rows) {
      const input = $(`#o-${k}`, m), out = $(`#ov-${k}`, m);
      const upd = () => { s[k] = +input.value; out.textContent = fmt(s[k]); this.app.applySettings(); };
      input.addEventListener('input', upd);
      out.textContent = fmt(s[k]);
    }
    for (const [k, label] of toggles) {
      const b = $(`#o-${k}`, m);
      b.addEventListener('click', () => { this.click(); s[k] = !s[k]; b.textContent = `${label}: ${s[k] ? 'On' : 'Off'}`; this.app.applySettings(); });
    }
    this.bind(m, '#b-done', () => { this.saveSettings(); back(); });
  }

  showControls(back) {
    const rows = [
      ['W A S D', 'Move'], ['Space', 'Jump · swim up · double-tap to fly (Creative)'], ['Shift', 'Sneak (won’t fall off edges) · fly down'],
      ['Ctrl / double-tap W', 'Sprint'], ['Mouse', 'Look (arrow keys also work)'], ['Left click', 'Break block · attack'],
      ['Right click', 'Place · use · eat · open doors · sleep · trade · hold to draw a bow'], ['Middle click', 'Pick block'], ['1–9 · wheel', 'Choose hotbar slot'],
      ['E', 'Inventory'], ['Q · Ctrl+Q', 'Drop item · drop stack'], ['T · /', 'Chat · command (/help)'],
      ['F1', 'Hide interface'], ['F2', 'Screenshot'], ['F3', 'Debug info'], ['F5', 'Change camera view'], ['Esc', 'Pause'],
      ['Inventory', 'Click: take/place · Right click: split/place one · Shift-click: move · Drag: spread · 1–9: swap to hotbar'],
      ['Right click (hoe)', 'Till dirt into farmland; plant seeds on it'], ['Flint and steel', 'Light an obsidian frame to open a rift to the Underworld'],
    ];
    const m = this.menu(`<h2>Controls</h2><div class="keys">${rows.map(([a, b]) => `<div><kbd>${esc(a)}</kbd><span>${esc(b)}</span></div>`).join('')}</div>
      <button id="b-done" class="btn wide">Done</button>`, 'controls');
    this.bind(m, '#b-done', back);
  }

  // ---------------------------------------------------------------------------
  // Inventory screens
  openScreen(name, data = {}) {
    const g = this.game;
    if (g.state !== 'playing' && g.state !== 'screen') return;
    if (this.screen) this.closeScreen(true);
    g.input.exitLock();
    g.input.reset();
    g.state = 'screen';
    this.screen = { name, data };
    this.buildInventoryScreen(name, data);
  }

  closeScreen(silent = false) {
    const g = this.game;
    const s = this.screen;
    if (!s) return;
    if (s.name === 'chat') { this.closeChat(false); return; }
    if (s.name === 'sleep') { if (g.player.sleeping) g.wakeUp(); else this.showSleep(false); return; }
    if (s.name === 'trade') g.tradingWith = null;
    if (s.name === 'chest' && !silent) g.audio.play('chest_close');
    // put back crafting ingredients and the cursor stack
    g.returnCraftingItems();
    if (this.cursor) {
      const left = g.player.inventory.give(this.cursor);
      if (left) g.throwStack({ ...this.cursor, count: left });
      this.cursor = null;
    }
    this.drag = null;
    this.hover = null;
    this.offersEl = null; this.enchantEl = null;
    this.updateCursor();
    this.tooltip.hidden = true;
    this.screen = null;
    this.closeMenus();
    if (!silent) this.resume();
  }

  onBlockEntityRemoved(key) {
    if (this.screen && this.screen.data && this.screen.data.key === key) this.closeScreen();
  }

  // Slot sources: returns {get, set, accept, takeOnly, special}
  slotSource(kind, index) {
    const g = this.game;
    const p = g.player;
    const sc = this.screen;
    switch (kind) {
      case 'inv': return {
        get: () => p.inventory.get(index), set: (s) => p.inventory.set(index, s),
        accept: index >= 36 ? (st) => !!(ITEMS[st.id].armor && ITEMS[st.id].armor.slot === index - 36) : undefined,
        single: index >= 36,
      };
      case 'ench': return { get: () => g.enchantSlot.get(0), set: (s) => g.enchantSlot.set(0, s), accept: (st) => applicableEnchants(st.id).length > 0 && !st.ench, single: true };
      case 'c2': return { get: () => g.craft2.get(index), set: (s) => g.craft2.set(index, s) };
      case 'c3': return { get: () => g.craft3.get(index), set: (s) => g.craft3.set(index, s) };
      case 'box': {
        const be = sc.data.be;
        return {
          get: () => be.slots[index], set: (s) => { be.slots[index] = s && s.count > 0 ? s : null; },
          accept: sc.name === 'furnace' && index === 2 ? () => false : undefined,
          takeOnly: sc.name === 'furnace' && index === 2,
        };
      }
      default: return null;
    }
  }

  craftResult() {
    const g = this.game;
    const c = this.screen.name === 'crafting' ? g.craft3 : g.craft2;
    const n = this.screen.name === 'crafting' ? 3 : 2;
    const grid = [];
    for (let i = 0; i < n * n; i++) { const s = c.get(i); grid.push(s ? s.id : 0); }
    return { res: matchRecipe(grid, n), c, n };
  }

  consumeCraft(c, n) {
    for (let i = 0; i < n * n; i++) {
      const s = c.get(i);
      if (!s) continue;
      s.count--;
      if (s.count <= 0) {
        // buckets used in recipes come back empty
        c.set(i, s.id === I.water_bucket || s.id === I.lava_bucket ? { id: I.bucket, count: 1 } : null);
      }
    }
  }

  buildInventoryScreen(name, data) {
    const creative = name === 'creative';
    const m = this.menu('', `inv inv-${name}`);
    const panel = el('div', 'panel');
    m.appendChild(panel);
    this.panel = panel;
    const title = { inventory: 'Inventory', crafting: 'Crafting', furnace: 'Furnace', chest: 'Chest', creative: 'Creative', trade: 'Trade', enchant: 'Enchanting' }[name];
    panel.appendChild(el('h3', 'ptitle', title));
    const mkGrid = (cls, cols, kind, from, count) => {
      const gr = el('div', `grid ${cls}`);
      gr.style.setProperty('--cols', cols);
      for (let i = 0; i < count; i++) {
        const s = this.slotEl();
        s.dataset.kind = kind; s.dataset.i = from + i;
        gr.appendChild(s);
      }
      return gr;
    };
    const top = el('div', 'top');
    panel.appendChild(top);
    if (name === 'inventory' || name === 'crafting') {
      const n = name === 'crafting' ? 3 : 2;
      const cr = el('div', 'craft');
      cr.appendChild(mkGrid('cgrid', n, n === 3 ? 'c3' : 'c2', 0, n * n));
      cr.appendChild(el('div', 'arrow', '<i></i>'));
      const res = this.slotEl(); res.classList.add('result'); res.dataset.kind = 'result'; res.dataset.i = 0;
      cr.appendChild(res);
      top.appendChild(cr);
      if (name === 'inventory') {
        top.prepend(el('div', 'portrait', this.portrait ? `<img src="${this.portrait}" alt="Your character">` : ''));
        const armor = mkGrid('armor', 1, 'inv', 36, 4);
        armor.querySelectorAll('.slot').forEach((sl, k) => sl.classList.add('armor-slot', ['a-head', 'a-chest', 'a-legs', 'a-feet'][k]));
        top.prepend(armor);
      }
    } else if (name === 'furnace') {
      const f = el('div', 'furnace');
      const col = el('div', 'fcol');
      const a = this.slotEl(); a.dataset.kind = 'box'; a.dataset.i = 0;
      const fl = el('div', 'flame', '<i></i>');
      const b = this.slotEl(); b.dataset.kind = 'box'; b.dataset.i = 1;
      col.append(a, fl, b);
      const ar = el('div', 'arrow prog', '<i></i>');
      const o = this.slotEl(); o.classList.add('result'); o.dataset.kind = 'box'; o.dataset.i = 2;
      f.append(col, ar, o);
      top.appendChild(f);
    } else if (name === 'chest') {
      top.appendChild(mkGrid('chestgrid', 9, 'box', 0, 27));
    } else if (name === 'trade') {
      const list = el('div', 'offers');
      this.offersEl = list;
      top.appendChild(list);
      this.buildOffers();
    } else if (name === 'enchant') {
      const box = el('div', 'enchant');
      const slot = this.slotEl(); slot.dataset.kind = 'ench'; slot.dataset.i = 0; slot.classList.add('result');
      const opts = el('div', 'eopts');
      this.enchantEl = opts;
      box.append(slot, opts);
      top.appendChild(box);
      this.lastEnchantKey = null;
    } else if (creative) {
      const bar = el('div', 'cbar', '<input id="c-search" placeholder="Search items…" autocomplete="off"><div class="slot trash" data-kind="trash" data-i="0" title="Destroy item"><span>✕</span></div>');
      top.appendChild(bar);
      const list = el('div', 'grid palette');
      list.style.setProperty('--cols', 9);
      this.paletteEl = list;
      top.appendChild(list);
      const fill = (q) => {
        list.innerHTML = '';
        const ids = CREATIVE_ORDER().filter((id) => !q || itemName(id).toLowerCase().includes(q.toLowerCase()));
        for (const id of ids) {
          const s = this.slotEl(); s.dataset.kind = 'palette'; s.dataset.i = id;
          this.fillSlot(s, { id, count: 1 });
          list.appendChild(s);
        }
      };
      fill('');
      const search = $('#c-search', bar);
      search.addEventListener('input', () => fill(search.value));
      search.addEventListener('keydown', (e) => { if (e.code === 'Escape') { e.preventDefault(); this.closeScreen(); } e.stopPropagation(); });
    }
    if (!creative) panel.appendChild(mkGrid('main', 9, 'inv', 9, 27));
    panel.appendChild(mkGrid('hotbar-row', 9, 'inv', 0, 9));

    panel.addEventListener('mousedown', (e) => this.onSlotDown(e));
    panel.addEventListener('mouseover', (e) => this.onSlotOver(e));
    panel.addEventListener('mouseleave', () => { this.hover = null; this.tooltip.hidden = true; });
    panel.addEventListener('contextmenu', (e) => e.preventDefault());
    // clicking outside the panel throws the cursor stack
    m.addEventListener('mousedown', (e) => {
      if (e.target === m && this.cursor) {
        const n = e.button === 2 ? 1 : this.cursor.count;
        this.game.throwStack({ ...this.cursor, count: n });
        this.cursor.count -= n;
        if (this.cursor.count <= 0) this.cursor = null;
        this.updateCursor();
      }
    });
    m.addEventListener('contextmenu', (e) => e.preventDefault());
    this.screen.update = () => this.refreshSlots();
    this.refreshSlots();
  }

  stackIn(slotEl) {
    const kind = slotEl.dataset.kind, i = +slotEl.dataset.i;
    if (kind === 'result') { const r = this.craftResult().res; return r ? { id: r.id, count: r.count } : null; }
    if (kind === 'palette') return { id: i, count: 1 };
    if (kind === 'trash') return null;
    const src = this.slotSource(kind, i);
    return src ? src.get() : null;
  }

  refreshSlots() {
    if (!this.panel) return;
    for (const s of this.panel.querySelectorAll('.slot')) {
      if (s.dataset.kind === 'palette' || s.dataset.kind === 'trash') continue;
      this.fillSlot(s, this.stackIn(s));
      s.classList.toggle('drag', !!(this.drag && this.drag.slots.includes(s)));
    }
    if (this.screen && this.screen.name === 'trade') {
      const mob = this.screen.data.mob;
      const p = this.game.player;
      if (mob.dead || Math.hypot(mob.x - p.x, mob.y - p.y, mob.z - p.z) > 8) { this.closeScreen(); return; }
      if (this.tradeKey() !== this.offerKey) this.buildOffers();
    }
    if (this.screen && this.screen.name === 'enchant' && this.enchantEl) {
      const d = this.screen.data;
      if (this.game.world.getBlock(d.x, d.y, d.z) !== B.enchanting_table) { this.closeScreen(); return; }
      this.updateEnchant();
    }
    if (this.screen && this.screen.name === 'furnace') {
      const be = this.screen.data.be;
      const fl = $('.flame i', this.panel), ar = $('.arrow.prog i', this.panel);
      if (fl) fl.style.height = `${be.burnMax ? Math.round((be.burn / be.burnMax) * 100) : 0}%`;
      if (ar) ar.style.width = `${Math.round((be.cook / 200) * 100)}%`;
    }
  }

  // -------------------------------------------------------------------------
  // Trading with settlers
  buildOffers() {
    const g = this.game, p = g.player;
    const mob = this.screen.data.mob;
    const list = this.offersEl;
    if (!list || !mob.trades) return;
    list.innerHTML = '';
    const prof = mob.profession || 'farmer';
    list.appendChild(el('div', 'who', `${esc(prof[0].toUpperCase() + prof.slice(1))} · click to trade, shift-click to trade repeatedly`));
    const mkIcon = (st) => {
      const o = this.slotEl(); o.className = 'oslot';
      this.fillSlot(o, st);
      o._stack = st;
      return o;
    };
    mob.trades.forEach((t, k) => {
      const row = el('button', 'offer');
      const gives = el('div', 'gives');
      for (const st of t.give) gives.appendChild(mkIcon(st));
      row.append(gives, el('i', 'to'), mkIcon(t.get));
      const out = t.uses >= t.max;
      row.appendChild(el('span', 'left', out ? 'Sold out' : `${t.max - t.uses} left`));
      const can = !out && t.give.every((st) => countItem(p.inventory, st.id) >= st.count);
      row.disabled = !can;
      row.addEventListener('click', (e) => this.doTrade(k, e.shiftKey));
      list.appendChild(row);
    });
    this.offerKey = this.tradeKey();
  }

  tradeKey() {
    const g = this.game, mob = this.screen && this.screen.data.mob;
    if (!mob || !mob.trades) return '';
    return mob.trades.map((t) => `${t.uses}:${t.give.map((st) => countItem(g.player.inventory, st.id)).join(',')}`).join('|');
  }

  doTrade(k, repeat) {
    const g = this.game, p = g.player;
    const mob = this.screen.data.mob;
    const t = mob.trades[k];
    let n = 0;
    while (n < (repeat ? 64 : 1)) {
      if (t.uses >= t.max) break;
      if (!t.give.every((st) => countItem(p.inventory, st.id) >= st.count)) break;
      for (const st of t.give) takeItem(p.inventory, st.id, st.count);
      const got = { id: t.get.id, count: t.get.count };
      if (t.get.ench) got.ench = { ...t.get.ench };
      const left = p.inventory.give(got);
      if (left) g.dropItem(p.x, p.y + 1.2, p.z, { ...got, count: left });
      t.uses++; n++;
      g.spawnXp(mob.x, mob.y + 1.2, mob.z, t.xp || 1);
    }
    if (n) {
      g.audio.play('trade', mob.x, mob.y + 1, mob.z);
      for (let i = 0; i < 4; i++) g.particles.heart(mob.x + (Math.random() - 0.5) * 0.6, mob.y + 1.9 + Math.random() * 0.3, mob.z + (Math.random() - 0.5) * 0.6);
      g.advance('trade');
    } else g.audio.mob('settler', 'no', mob.x, mob.y, mob.z);
    this.buildOffers();
    this.refreshSlots();
  }

  // -------------------------------------------------------------------------
  // Enchanting table
  updateEnchant() {
    const g = this.game, p = g.player;
    const st = g.enchantSlot.get(0);
    const shelves = this.screen.data.shelves || 0;
    const key = `${st ? st.id : 0}|${st && st.ench ? 1 : 0}|${p.enchantSeed}|${p.xpLevel}|${p.creative}|${shelves}`;
    if (key === this.lastEnchantKey) return;
    this.lastEnchantKey = key;
    const opts = st && !st.ench ? enchantOptions(st.id, shelves, p.enchantSeed ^ (st.id * 2654435761)) : [];
    const box = this.enchantEl;
    box.innerHTML = '';
    for (let k = 0; k < 3; k++) {
      const o = opts[k];
      const b = el('button', 'eopt');
      const runes = glyphs(p.enchantSeed + k * 7919 + (st ? st.id : 0), 14);
      if (!o || !o.ench) {
        b.disabled = true;
        b.innerHTML = `<span class="lv"></span><span class="glyphs">${st && !st.ench ? runes : ''}</span>`;
      } else {
        const need = k + 1;
        const ok = p.creative || p.xpLevel >= Math.max(o.cost, need);
        b.disabled = !ok;
        const first = Object.keys(o.ench)[0];
        b.innerHTML = `<span class="lv">${o.cost}</span><span class="glyphs">${runes}</span><span class="cost">${need} level${need > 1 ? 's' : ''}</span>
          <span class="hint">${esc(enchantLabel(first, o.ench[first]))}${Object.keys(o.ench).length > 1 ? ' … ?' : ''}</span>`;
        b.title = ok ? '' : `Requires experience level ${Math.max(o.cost, need)}`;
        b.addEventListener('click', () => this.doEnchant(k, o));
      }
      box.appendChild(b);
    }
  }

  doEnchant(k, o) {
    const g = this.game, p = g.player;
    const st = g.enchantSlot.get(0);
    if (!st || st.ench) return;
    const need = k + 1;
    if (!p.creative) {
      if (p.xpLevel < Math.max(o.cost, need)) return;
      p.xpLevel -= need;
    }
    g.enchantSlot.set(0, { ...st, ench: { ...o.ench } });
    p.enchantSeed = (Math.random() * 0x7fffffff) | 0;
    const d = this.screen.data;
    g.audio.play('enchant', d.x + 0.5, d.y + 0.5, d.z + 0.5);
    for (let i = 0; i < 16; i++) g.particles.glyph(d.x + 0.5 + (Math.random() - 0.5) * 3, d.y + 1 + Math.random() * 1.5, d.z + 0.5 + (Math.random() - 0.5) * 3, d.x + 0.5, d.y + 1.2, d.z + 0.5);
    g.advance('enchant');
    this.lastEnchantKey = null;
    this.refreshSlots();
  }

  showTip(st, e) {
    const d = ITEMS[st.id];
    let t = esc(itemName(st.id));
    if (st.ench) t = `<span class="en">${t}</span>` + Object.entries(st.ench).map(([k, v]) => `<br><small class="el">${esc(enchantLabel(k, v))}</small>`).join('');
    if (d.armor) t += `<br><small>+${d.armor.points} armor${d.armor.tough ? `, +${d.armor.tough} toughness` : ''}</small>`;
    if (d.durability) t += `<br><small>Durability ${d.durability - (st.dur || 0)} / ${d.durability}</small>`;
    if (d.food) t += `<br><small>Restores ${d.food[0] / 2} food</small>`;
    if (d.damage) t += `<br><small>${d.damage} attack damage</small>`;
    this.tooltip.innerHTML = t;
    this.tooltip.hidden = false;
    const px = e.clientX ?? this.mx, py = e.clientY ?? this.my;
    this.tooltip.style.transform = `translate(${px + 14}px, ${py - 28}px)`;
  }

  onSlotOver(e) {
    const os = e.target.closest('.oslot');
    if (os && os._stack) { this.hover = null; this.showTip(os._stack, e); return; }
    const s = e.target.closest('.slot');
    this.hover = s || null;
    if (!s) { this.tooltip.hidden = true; return; }
    if (this.drag && !this.drag.slots.includes(s) && this.canDragInto(s)) {
      this.drag.slots.push(s);
      this.refreshSlots();
    }
    const st = this.stackIn(s);
    if (st && !this.cursor) this.showTip(st, e);
    else this.tooltip.hidden = true;
  }

  onMouseMove(e) {
    this.mx = e.clientX; this.my = e.clientY;
    if (this.cursorEl && this.cursor) {
      this.cursorEl.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
    }
    if (this.tooltip && !this.tooltip.hidden) this.tooltip.style.transform = `translate(${e.clientX + 14}px, ${e.clientY - 28}px)`;
  }

  updateCursor() {
    const c = this.cursorEl;
    if (!this.cursor) { c.hidden = true; return; }
    c.hidden = false;
    if (!c.firstChild) c.appendChild(this.slotEl());
    this.fillSlot(c.firstChild, this.cursor);
    if (this.mx !== undefined) c.style.transform = `translate(${this.mx}px, ${this.my}px)`;
  }

  canDragInto(s) {
    const kind = s.dataset.kind;
    if (!this.drag || !this.cursor) return false;
    if (kind === 'result' || kind === 'palette' || kind === 'trash') return false;
    const src = this.slotSource(kind, +s.dataset.i);
    if (!src || src.takeOnly) return false;
    if (src.accept && !src.accept(this.cursor)) return false;
    const cur = src.get();
    return !cur || (cur.id === this.cursor.id && !cur.dur && cur.count < maxStack(cur.id));
  }

  onSlotDown(e) {
    const s = e.target.closest('.slot');
    if (!s) return;
    e.preventDefault();
    const kind = s.dataset.kind;
    const right = e.button === 2;
    if (e.button !== 0 && e.button !== 2) return;
    // start a drag-distribute when holding a stack over a normal slot
    if (this.cursor && !e.shiftKey && kind !== 'result' && kind !== 'palette' && kind !== 'trash') {
      this.drag = { right, slots: [s], origin: s };
      return;
    }
    this.slotClick(s, right, e.shiftKey);
  }

  onMouseUp() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (d.slots.length <= 1) { this.slotClick(d.origin, d.right, false); return; }
    // spread the cursor stack across the dragged slots
    const slots = d.slots;
    const cur = this.cursor;
    if (!cur) return;
    const each = d.right ? 1 : Math.floor(cur.count / slots.length);
    if (each < 1) { this.refreshSlots(); return; }
    for (const s of slots) {
      if (cur.count <= 0) break;
      const src = this.slotSource(s.dataset.kind, +s.dataset.i);
      if (!src || src.takeOnly) continue;
      if (src.accept && !src.accept(cur)) continue;
      const st = src.get();
      if (st && (st.id !== cur.id || st.dur || st.ench || cur.ench)) continue;
      const room = maxStack(cur.id) - (st ? st.count : 0);
      const n = Math.min(each, room, cur.count);
      if (n <= 0) continue;
      src.set(st ? { ...st, count: st.count + n } : { ...cur, count: n });
      cur.count -= n;
    }
    if (cur.count <= 0) this.cursor = null;
    this.updateCursor();
    this.refreshSlots();
  }

  slotClick(s, right, shift) {
    const g = this.game;
    const kind = s.dataset.kind, i = +s.dataset.i;
    const creative = g.player.creative;
    if (kind === 'trash') {
      if (shift && creative) for (let k = 0; k < 36; k++) g.player.inventory.set(k, null);
      this.cursor = null; this.updateCursor(); this.refreshSlots(); return;
    }
    if (kind === 'palette') {
      if (this.cursor) { if (this.cursor.id === i && !right && this.cursor.count < maxStack(i)) this.cursor.count++; else this.cursor = null; }
      else if (shift) g.player.inventory.give({ id: i, count: maxStack(i) });
      else this.cursor = { id: i, count: right ? 1 : maxStack(i) };
      this.updateCursor(); this.refreshSlots(); return;
    }
    if (kind === 'result') { this.takeResult(shift); return; }
    const src = this.slotSource(kind, i);
    if (!src) return;
    const st = src.get();
    if (shift) {
      if (st) {
        this.quickMove(kind, i, src, st);
        if (src.takeOnly) { const after = src.get(); g.onSmelted(st.id, st.count - (after ? after.count : 0)); }
      }
      this.refreshSlots(); return;
    }
    const cur = this.cursor;
    if (cur && src.accept && !src.accept(cur)) return;
    if (src.takeOnly) {
      if (!st) return;
      const n = st.count;
      if (!cur) { this.cursor = st; src.set(null); }
      else if (cur.id === st.id && !cur.dur && !cur.ench && !st.ench && cur.count + st.count <= maxStack(cur.id)) { cur.count += st.count; src.set(null); }
      if (!src.get()) g.onSmelted(st.id, n);
    } else if (!cur) {
      if (st) {
        if (right) { const n = Math.ceil(st.count / 2); this.cursor = { ...st, count: n }; st.count -= n; src.set(st.count ? st : null); }
        else { this.cursor = st; src.set(null); }
      }
    } else if (!st) {
      if (right) { src.set({ ...cur, count: 1 }); cur.count--; if (!cur.count) this.cursor = null; }
      else { src.set(cur); this.cursor = null; }
    } else if (st.id === cur.id && !st.dur && !cur.dur && !st.ench && !cur.ench && maxStack(st.id) > 1) {
      const room = maxStack(st.id) - st.count;
      const n = right ? Math.min(1, room) : Math.min(room, cur.count);
      st.count += n; cur.count -= n;
      if (!cur.count) this.cursor = null;
      src.set(st);
    } else {
      src.set(cur); this.cursor = st;
    }
    this.updateCursor();
    this.refreshSlots();
  }

  takeResult(shift) {
    const g = this.game;
    const { res, c, n } = this.craftResult();
    if (!res) return;
    if (shift) {
      // craft as many as fit
      for (let guard = 0; guard < 64; guard++) {
        const r = this.craftResult().res;
        if (!r || r.id !== res.id) break;
        const left = g.player.inventory.give({ id: r.id, count: r.count });
        if (left) { g.dropItem(g.player.x, g.player.y + 1.2, g.player.z, { id: r.id, count: left }); this.consumeCraft(c, n); break; }
        this.consumeCraft(c, n);
      }
    } else {
      const cur = this.cursor;
      if (cur && (cur.id !== res.id || cur.count + res.count > maxStack(res.id))) return;
      if (cur) cur.count += res.count; else this.cursor = { id: res.id, count: res.count };
      this.consumeCraft(c, n);
    }
    g.onCrafted(res.id);
    g.audio.play('click');
    this.updateCursor();
    this.refreshSlots();
  }

  quickMove(kind, i, src, st) {
    const g = this.game;
    const inv = g.player.inventory;
    const sc = this.screen.name;
    let left = st.count;
    const put = (container, order) => { left = container.add({ ...st, count: left }, order); };
    const armor = ITEMS[st.id] && ITEMS[st.id].armor;
    if (kind === 'inv' && i >= 36) {
      put(inv, [...range(9, 36), ...range(0, 9)]);
    } else if (kind === 'inv' && armor && (sc === 'inventory' || sc === 'enchant' && st.ench) && !inv.get(36 + armor.slot)) {
      inv.set(36 + armor.slot, st); left = 0;
    } else if (kind === 'inv' && sc === 'enchant' && !g.enchantSlot.get(0) && applicableEnchants(st.id).length && !st.ench) {
      g.enchantSlot.set(0, st); left = 0;
    } else if (kind === 'inv') {
      if (sc === 'chest') {
        const be = this.screen.data.be;
        const tmp = { slots: be.slots };
        left = addTo(tmp, { ...st, count: left }, [...Array(27).keys()]);
      } else if (sc === 'furnace') {
        const be = this.screen.data.be;
        const target = SMELTING.has(st.id) ? 0 : fuelValue(st.id) ? 1 : -1;
        if (target >= 0) left = addTo(be, { ...st, count: left }, [target]);
        else put(inv, i < 9 ? range(9, 36) : range(0, 9));
      } else if (sc === 'creative') {
        src.set(null); return;
      } else put(inv, i < 9 ? range(9, 36) : range(0, 9));
    } else if (kind === 'ench') {
      put(inv, [...range(0, 9), ...range(9, 36)]);
    } else {
      put(inv, [...range(0, 9), ...range(9, 36)]);
    }
    src.set(left ? { ...st, count: left } : null);
  }

  swapWithHotbar(slotEl, h) {
    const kind = slotEl.dataset.kind, i = +slotEl.dataset.i;
    const inv = this.game.player.inventory;
    if (kind === 'palette') { inv.set(h, { id: i, count: maxStack(i) }); this.refreshSlots(); return; }
    if (kind === 'result' || kind === 'trash') return;
    const src = this.slotSource(kind, i);
    if (!src || src.takeOnly) return;
    const a = src.get(), b = inv.get(h);
    if (b && src.accept && !src.accept(b)) return;
    src.set(b); inv.set(h, a);
    this.refreshSlots();
  }

  dropFromSlot(slotEl, all) {
    const kind = slotEl.dataset.kind, i = +slotEl.dataset.i;
    if (kind === 'result' || kind === 'palette' || kind === 'trash') return;
    const src = this.slotSource(kind, i);
    const st = src && src.get();
    if (!st) return;
    const n = all ? st.count : 1;
    this.game.throwStack({ ...st, count: n });
    st.count -= n;
    src.set(st.count ? st : null);
    this.refreshSlots();
  }
}

function range(a, b) { const r = []; for (let i = a; i < b; i++) r.push(i); return r; }

function addTo(be, stack, order) {
  let left = stack.count;
  const max = maxStack(stack.id);
  for (const i of order) {
    const s = be.slots[i];
    if (s && s.id === stack.id && !s.dur && s.count < max && max > 1) {
      const t = Math.min(max - s.count, left); s.count += t; left -= t;
      if (!left) return 0;
    }
  }
  for (const i of order) {
    if (!be.slots[i]) {
      const t = Math.min(max, left); be.slots[i] = { ...stack, count: t }; left -= t;
      if (!left) return 0;
    }
  }
  return left;
}

function countItem(inv, id) {
  let n = 0;
  for (let i = 0; i < 36; i++) { const s = inv.get(i); if (s && s.id === id && !s.ench) n += s.count; }
  return n;
}

function takeItem(inv, id, count) {
  for (let i = 35; i >= 0 && count > 0; i--) {
    const s = inv.get(i);
    if (!s || s.id !== id || s.ench) continue;
    const t = Math.min(s.count, count);
    s.count -= t; count -= t;
    inv.set(i, s.count ? s : null);
  }
}

// Decorative rune text for enchanting options.
const RUNES = 'ᚠᚢᚦᚨᚱᚲᚷᚹᚺᚾᛁᛃᛇᛈᛉᛊᛏᛒᛖᛗᛚᛜᛞᛟ';
function glyphs(seed, n) {
  let s = seed | 0, out = '';
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) | 0;
    out += (i && (s >>> 28) % 5 === 0) ? ' ' : RUNES[(s >>> 16) % RUNES.length];
  }
  return out;
}
