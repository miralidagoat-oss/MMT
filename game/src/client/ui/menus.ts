/** Front-end screens: main menu, new/load world, multiplayer, settings, pause, death, loading. */
import { h, clear } from './dom';
import { RESOLUTIONS, FPS_LIMITS, applyPreset, DEFAULT_BINDS, saveSettings, type Settings, type QualityPreset } from '../settings';
import { keyLabel } from '../input/input';
import type { WorldEntry } from '../net/worlds';
import { GAME_NAME, PROTOCOL_VERSION } from '../../shared/config';
import type { GameSettings } from '../../shared/state';

export interface OpenGameInfo { code: string; host: string; world: string; players: number; max: number; day: number; mine: boolean; compatible: boolean }

export interface MenuActions {
  newWorld(opts: { name: string; seed: string; settings: Partial<GameSettings>; coop: boolean }): void;
  loadWorld(slot: string, coop: boolean): void;
  deleteWorld(slot: string): Promise<void>;
  listWorlds(): Promise<WorldEntry[]>;
  exportWorld(slot: string): Promise<string>;
  importWorld(file: File): Promise<string>;
  /** dedicated-server join (self-hosted build only) */
  join(address: string): void;
  /** online co-op through the hosted page; null when unavailable in this view */
  coop(): Promise<{ watch(cb: (games: OpenGameInfo[]) => void): () => void; join(code: string): void } | null>;
  hosted: boolean;
  settingsChanged(s: Settings, what: 'graphics' | 'audio' | 'controls' | 'gameplay'): void;
  click(): void;
  hover(): void;
  captureKey(cb: (code: string) => void): void;
}

export interface PauseCoop { code: string | null; players: number; open(): Promise<string>; close(): void }

const TIPS = [
  'Coconuts are safe to drink. Sea water only makes thirst worse.',
  'A roof over your fire keeps the rain from smothering it.',
  'Sharks hunt swimmers. Rafts keep you out of their reach — mostly.',
  'Cook taro before eating it. Raw roots will poison you.',
  'Dry meat and fish on a drying rack and it will never spoil.',
  'Rest in a bed or lean-to to set where you wake up after dying.',
  'If you go down, a friend can revive you before you bleed out.',
  'Deep wrecks hold the electronics you need to call for rescue.',
  'Wet clothes and night wind will chill you. Stay near a fire.',
  'Islands on the horizon are reachable. Watch the weather before setting out.',
];

export function tip(): string { return TIPS[Math.floor(Math.random() * TIPS.length)]!; }

export class Menus {
  root: HTMLElement;
  private screen: HTMLElement | null = null;

  constructor(parent: HTMLElement, private settings: Settings, private actions: MenuActions) {
    this.root = h('div', { class: 'screen menu-bg hidden' });
    parent.append(this.root);
  }

  private show(el: HTMLElement) {
    clear(this.root);
    this.root.classList.remove('hidden');
    this.root.append(el);
    this.screen = el;
    el.querySelectorAll('.btn').forEach((b) => b.addEventListener('mouseenter', () => this.actions.hover()));
    (el.querySelector('.btn') as HTMLElement | null)?.focus();
  }

  hide() { this.root.classList.add('hidden'); clear(this.root); this.screen = null; }
  get visible() { return !this.root.classList.contains('hidden'); }

  private btn(label: string, fn: () => void, cls = '') {
    return h('button', { class: `btn ${cls}`, text: label, on: { click: () => { this.actions.click(); fn(); } } });
  }

  // ------------------------------------------------------------------ main
  async main() {
    const worlds = await this.actions.listWorlds().catch(() => []);
    const latest = worlds.find((w) => !w.corrupted);
    const col = h('div', { class: 'menu-col' },
      latest ? this.btn(`Continue — ${latest.name} (Day ${latest.day})`, () => this.actions.loadWorld(latest.slot, false), 'primary') : null,
      this.btn('New Game', () => this.newGame(), latest ? '' : 'primary'),
      this.btn('Load Game', () => void this.load()),
      this.btn('Play with Friends', () => this.multiplayer()),
      this.btn('Settings', () => this.settingsScreen(() => void this.main())),
      this.btn('How to Play', () => this.howTo()),
    );
    this.show(h('div', { class: 'menu-wrap' },
      h('div', {}, h('h1', { class: 'title', text: GAME_NAME }), h('div', { class: 'subtitle', text: 'Survive · Build · Sail · Together' }),
        h('p', { style: 'color:var(--muted);max-width:440px;line-height:1.6', text: 'Your ship went down. You washed up alone — or with up to three friends — on a scatter of islands in an endless sea. Find water, make fire, build a home, then salvage the deep wrecks for the parts to call a ship home.' })),
      col,
      h('div', { class: 'version', text: `v0.1 · protocol ${PROTOCOL_VERSION}` }),
    ));
  }

  newGame(coop = false) {
    const name = h('input', { type: 'text', value: 'My Island' }) as HTMLInputElement;
    const seed = h('input', { type: 'text', placeholder: 'random' }) as HTMLInputElement;
    const diff = h('select', {}, h('option', { value: 'relaxed', text: 'Relaxed — slower needs, gentler wildlife' }), h('option', { value: 'normal', text: 'Normal', selected: true }), h('option', { value: 'hard', text: 'Hard — the sea is merciless' })) as HTMLSelectElement;
    diff.value = 'normal';
    const keep = h('input', { type: 'checkbox' }) as HTMLInputElement;
    const ff = h('input', { type: 'checkbox' }) as HTMLInputElement;
    const cheats = h('input', { type: 'checkbox' }) as HTMLInputElement;
    const body = h('div', { class: 'dialog-body' },
      row('World name', name), row('Seed', seed, 'Same seed = same islands'), row('Difficulty', diff),
      row('Keep inventory on death', keep), row('Friendly fire', ff), row('Allow cheats', cheats, 'Host commands: /time /weather /give /tp /heal'),
    );
    this.show(h('div', { class: 'panel dialog' },
      h('div', { class: 'dialog-head' }, h('h2', { text: coop ? 'Host a New World' : 'New World' })), body,
      h('div', { class: 'dialog-foot' }, this.btn('Back', () => (coop ? this.multiplayer() : void this.main())), this.btn(coop ? 'Start & Invite' : 'Start', () => {
        this.actions.newWorld({ name: name.value.trim() || 'My Island', seed: seed.value.trim(), coop, settings: { difficulty: diff.value as GameSettings['difficulty'], keepInventoryOnDeath: keep.checked, friendlyFire: ff.checked, cheats: cheats.checked } });
      }, 'primary')),
    ));
  }

  async load(coop = false) {
    const status = h('div', { class: 'meta', style: 'color:var(--muted);min-height:18px;font-size:13px' });
    const list = h('div', { class: 'list' }, h('div', { style: 'color:var(--muted)', text: 'Loading saves…' }));
    const file = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none' }) as HTMLInputElement;
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      file.value = '';
      if (!f) return;
      status.textContent = 'Importing…';
      try { await this.actions.importWorld(f); status.textContent = `Imported "${f.name}".`; await render(); }
      catch (e) { status.textContent = `Could not import: ${(e as Error).message}`; }
    });
    const where = { device: 'On this device', cloud: 'In your cloud saves', both: 'On this device + cloud' } as const;
    const render = async () => {
      const worlds = await this.actions.listWorlds().catch(() => []);
      clear(list);
      if (!worlds.length) list.append(h('div', { style: 'color:var(--muted)', text: 'No saved worlds yet. Start a new game, or import a save file.' }));
      for (const w of worlds) {
        let armed = false;
        const del = this.btn('Delete', async () => {
          if (!armed) { armed = true; del.textContent = 'Confirm delete'; setTimeout(() => { armed = false; del.textContent = 'Delete'; }, 4000); return; }
          await this.actions.deleteWorld(w.slot);
          status.textContent = `Deleted "${w.name}".`;
          await render();
        }, 'small danger');
        list.append(h('div', { class: 'list-item' },
          h('div', { style: 'min-width:0' }, h('div', { text: w.name }), h('div', { class: 'meta', text: w.corrupted ? 'Corrupted save' : `Day ${w.day} · seed ${w.seed} · ${new Date(w.savedAt).toLocaleString()} · ${where[w.where]}` })),
          h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end' },
            this.btn(coop ? 'Host' : 'Play', () => this.actions.loadWorld(w.slot, coop), 'small primary'),
            w.corrupted ? null : this.btn('Export', async () => { status.textContent = 'Preparing save file…'; status.textContent = await this.actions.exportWorld(w.slot).catch((e) => `Export failed: ${(e as Error).message}`); }, 'small'),
            del)));
      }
    };
    this.show(h('div', { class: 'panel dialog' },
      h('div', { class: 'dialog-head' }, h('h2', { text: coop ? 'Host a Saved World' : 'Load World' })),
      h('div', { class: 'dialog-body' }, list, status, file,
        h('p', { style: 'color:var(--muted);font-size:12px;line-height:1.6;margin-top:10px', text: this.actions.hosted
          ? 'Worlds save automatically to this browser and, when you are signed in with edit access, to your private cloud saves so they follow you to other devices. Export a world to keep a file copy; import it here on any device.'
          : 'Worlds save automatically in this browser. Export a world to keep a file copy; import it on any device.' })),
      h('div', { class: 'dialog-foot' }, this.btn('Back', () => (coop ? this.multiplayer() : void this.main())), this.btn('Import Save File', () => file.click()))));
    await render();
  }

  multiplayer() {
    if (!this.actions.hosted) { this.dedicated(); return; }
    const g = this.settings.gameplay;
    const nameIn = h('input', { type: 'text', value: g.name, maxlength: 24 }) as HTMLInputElement;
    const color = h('input', { type: 'color', value: g.color, style: 'width:60px;height:34px;border:0;background:none' }) as HTMLInputElement;
    const code = h('input', { type: 'text', placeholder: 'e.g. k7m2qa', maxlength: 6, style: 'text-transform:lowercase' }) as HTMLInputElement;
    const games = h('div', { class: 'list' }, h('div', { style: 'color:var(--muted)', text: 'Looking for open games…' }));
    const status = h('div', { class: 'meta', style: 'color:var(--muted);font-size:13px;min-height:18px' });
    const remember = () => { g.name = nameIn.value.trim().slice(0, 24) || 'Castaway'; g.color = color.value; saveSettings(this.settings); };
    let stop: (() => void) | null = null;
    const leave = (fn: () => void) => { stop?.(); stop = null; remember(); fn(); };
    const body = h('div', { class: 'dialog-body' },
      row('Your name', nameIn), row('Shirt colour', color),
      h('h3', { style: 'margin:18px 0 8px;font-size:14px;color:var(--muted)', text: 'OPEN GAMES' }), games,
      h('div', { style: 'display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap' }, h('span', { style: 'color:var(--muted);font-size:13px', text: 'Join with a code' }), code,
        this.btn('Join', () => { const c = code.value.trim().toLowerCase(); if (!/^[a-z0-9]{6}$/.test(c)) { status.textContent = 'Codes are 6 letters or digits.'; return; } leave(() => void this.actions.coop().then((n) => n?.join(c))); }, 'small')),
      status,
      h('h3', { style: 'margin:18px 0 8px;font-size:14px;color:var(--muted)', text: 'HOST A GAME' }),
      h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' },
        this.btn('Host a New World', () => leave(() => this.newGame(true)), 'primary'),
        this.btn('Host a Saved World', () => leave(() => void this.load(true)))),
      h('p', { style: 'color:var(--muted);font-size:13px;line-height:1.6;margin-top:12px', html: 'Up to <b>4 players</b>. The host runs the world in their browser and keeps the game tab open; it saves to the host\'s worlds. To invite friends, share <b>this page\'s link</b> with them from the page\'s Share menu. They open it signed in, choose <b>Play with Friends</b>, and pick your game or type your code. You can also invite friends from the pause menu during any game.' }));
    this.show(h('div', { class: 'panel dialog' },
      h('div', { class: 'dialog-head' }, h('h2', { text: 'Play with Friends' })), body,
      h('div', { class: 'dialog-foot' }, this.btn('Back', () => leave(() => void this.main())))));
    void this.actions.coop().then((net) => {
      if (!this.root.contains(games)) return;
      if (!net) {
        clear(games);
        games.append(h('div', { style: 'color:var(--muted);line-height:1.6', text: 'Online play is not available in this view. Open the game from its claude.ai link while signed in. Single-player works everywhere.' }));
        return;
      }
      stop = net.watch((list) => {
        clear(games);
        const others = list.filter((x) => !x.mine);
        if (!others.length) games.append(h('div', { style: 'color:var(--muted)', text: 'No open games right now. Host one, or ask a friend to host and share their code.' }));
        for (const x of others) {
          const full = x.players >= x.max;
          games.append(h('div', { class: 'list-item' },
            h('div', { style: 'min-width:0' }, h('div', { text: `${x.host}'s game · ${x.world}` }), h('div', { class: 'meta', text: `${x.players}/${x.max} players · day ${x.day} · code ${x.code}${x.compatible ? '' : ' · different game version'}` })),
            full || !x.compatible ? h('span', { class: 'meta', text: full ? 'Full' : 'Update needed' }) : this.btn('Join', () => leave(() => net.join(x.code)), 'small primary')));
        }
      });
    });
  }

  /** Self-hosted build: join a dedicated server by address. */
  private dedicated() {
    const g = this.settings.gameplay;
    const addr = h('input', { type: 'text', value: g.lastServer || `${location.hostname || 'localhost'}:7777`, placeholder: 'host:port' }) as HTMLInputElement;
    const nameIn = h('input', { type: 'text', value: g.name, maxlength: 24 }) as HTMLInputElement;
    const color = h('input', { type: 'color', value: g.color, style: 'width:60px;height:34px;border:0;background:none' }) as HTMLInputElement;
    const servers = h('div', { class: 'list' });
    const known = [...new Set([`${location.hostname || 'localhost'}:${location.port || '7777'}`, 'localhost:7777', ...g.recentServers])].slice(0, 8);
    for (const s of known) {
      const meta = h('span', { class: 'meta', text: 'checking…' });
      const item = h('div', { class: 'list-item' }, h('div', {}, h('div', { text: s }), meta), this.btn('Join', () => { addr.value = s; go(); }, 'small'));
      servers.append(item);
      const t0 = performance.now();
      fetch(`${location.protocol === 'https:' ? 'https' : 'http'}://${s}/api/info`, { signal: AbortSignal.timeout(2500) }).then((r) => r.json()).then((info: { name: string; players: string[]; max: number; day: number; protocol: number }) => {
        meta.textContent = `${info.name} · ${info.players.length}/${info.max} players · day ${info.day} · ${Math.round(performance.now() - t0)} ms${info.protocol !== PROTOCOL_VERSION ? ' · VERSION MISMATCH' : ''}`;
      }).catch(() => { meta.textContent = 'offline'; item.style.opacity = '0.5'; });
    }
    const go = () => {
      g.name = nameIn.value.trim().slice(0, 24) || 'Castaway';
      g.color = color.value;
      g.lastServer = addr.value.trim();
      g.recentServers = [g.lastServer, ...g.recentServers.filter((x) => x !== g.lastServer)].slice(0, 6);
      saveSettings(this.settings);
      this.actions.join(g.lastServer);
    };
    this.show(h('div', { class: 'panel dialog' },
      h('div', { class: 'dialog-head' }, h('h2', { text: 'Multiplayer' })),
      h('div', { class: 'dialog-body' },
        row('Your name', nameIn), row('Shirt colour', color), row('Server address', addr, 'host:port of a Tidewake server'),
        h('h3', { style: 'margin:18px 0 8px;font-size:14px;color:var(--muted)', text: 'SERVERS' }), servers,
        h('h3', { style: 'margin:18px 0 8px;font-size:14px;color:var(--muted)', text: 'HOSTING A GAME' }),
        h('p', { style: 'color:var(--muted);font-size:13px;line-height:1.6', html: 'Run <span class="keycap">npm start</span> in the game folder (or <span class="keycap">npm run server -- --world island --port 7777</span> for a dedicated server). Friends open <b>http://YOUR-IP:7777</b> in a browser or enter your address here. Up to 4 players; the world auto-saves every 5 minutes and when the server stops.' })),
      h('div', { class: 'dialog-foot' }, this.btn('Back', () => void this.main()), this.btn('Join', go, 'primary')),
    ));
  }

  howTo() {
    const b = this.settings.controls.binds;
    const k = (a: string) => `<span class="keycap">${keyLabel(b[a]?.[0] ?? '?')}</span>`;
    this.show(h('div', { class: 'panel dialog' },
      h('div', { class: 'dialog-head' }, h('h2', { text: 'How to Play' })),
      h('div', { class: 'dialog-body', style: 'line-height:1.8;font-size:14px', html: `
        <p><b>Move</b> ${k('forward')}${k('left')}${k('back')}${k('right')} · <b>Sprint</b> ${k('sprint')} · <b>Jump / swim up</b> ${k('jump')} · <b>Crouch / dive</b> ${k('crouch')}</p>
        <p><b>Use tool / attack</b> ${k('primary')} · <b>Aim / zoom / secondary</b> ${k('secondary')} · <b>Interact / pick up / gather</b> ${k('interact')} · <b>Eat, drink or use held item</b> ${k('use')}</p>
        <p><b>Inventory</b> ${k('inventory')} · <b>Crafting</b> ${k('crafting')} · <b>Build menu</b> ${k('build')} (hold the Builder's Mallet) · <b>Rotate blueprint</b> ${k('rotate')} · <b>Map</b> ${k('map')} · <b>Journal</b> ${k('journal')} · <b>Drop</b> ${k('drop')} · <b>Waypoint</b> ${k('waypoint')} · <b>Chat</b> ${k('chat')}</p>
        <p><b>Survive:</b> keep hunger, thirst, temperature and health up. Drink coconuts early; collect rain or distill sea water later. Cook meat and roots on a fire. Night is cold — stay dry and near a fire.</p>
        <p><b>Progress:</b> stone tools → workbench → clay kiln → forge. Explore wrecks, hunt, farm, and build a raft to reach other islands. Salvage circuit boards and batteries from deep wrecks to build the distress beacon on a high peak.</p>` }),
      h('div', { class: 'dialog-foot' }, this.btn('Back', () => void this.main())),
    ));
  }

  // ------------------------------------------------------------------ settings
  settingsScreen(back: () => void, inGame = false) {
    const s = this.settings;
    const tabs = ['Graphics', 'Audio', 'Controls', 'Gameplay'];
    let active = 'Graphics';
    const body = h('div', { class: 'dialog-body' });
    const tabBar = h('div', { class: 'tabs' });
    const render = () => {
      clear(tabBar);
      for (const t of tabs) tabBar.append(h('div', { class: `tab ${t === active ? 'active' : ''}`, text: t, on: { click: () => { active = t; this.actions.click(); render(); } } }));
      clear(body);
      if (active === 'Graphics') this.graphicsTab(body, render);
      if (active === 'Audio') this.audioTab(body);
      if (active === 'Controls') this.controlsTab(body, render);
      if (active === 'Gameplay') this.gameplayTab(body);
    };
    render();
    const panel = h('div', { class: 'panel dialog', style: 'width:min(780px,94vw)' },
      h('div', { class: 'dialog-head' }, h('h2', { text: 'Settings' })), tabBar, body,
      h('div', { class: 'dialog-foot' }, this.btn('Done', () => { saveSettings(s); back(); }, 'primary')));
    if (inGame) { clear(this.root); this.root.classList.remove('hidden'); this.root.append(panel); }
    else this.show(panel);
  }

  private graphicsTab(body: HTMLElement, rerender: () => void) {
    const g = this.settings.graphics;
    const changed = () => { if (g.preset !== 'custom') g.preset = 'custom'; this.actions.settingsChanged(this.settings, 'graphics'); };
    const preset = select(['low', 'medium', 'high', 'ultra', 'insane', 'custom'], g.preset, (v) => { if (v !== 'custom') applyPreset(g, v as Exclude<QualityPreset, 'custom'>); else g.preset = 'custom'; this.actions.settingsChanged(this.settings, 'graphics'); rerender(); }, (v) => v[0]!.toUpperCase() + v.slice(1));
    body.append(
      row('Quality preset', preset, 'Insane: supersampled, max view distance and effects'),
      row('Resolution', select(RESOLUTIONS, g.resolution, (v) => { g.resolution = v; this.actions.settingsChanged(this.settings, 'graphics'); }, (v) => (v === 'native' ? 'Native (display)' : v.replace('x', ' × '))), 'Internal render resolution'),
      row('Render scale', slider(0.5, 2, 0.05, g.renderScale, (v) => { g.renderScale = v; changed(); }, (v) => `${Math.round(v * 100)}%`), 'Above 100% supersamples for extra sharpness'),
      row('Dynamic resolution', check(g.dynamicResolution, (v) => { g.dynamicResolution = v; this.actions.settingsChanged(this.settings, 'graphics'); }), 'Lowers resolution automatically to hold the frame-rate cap'),
      row('Display mode', select(['windowed', 'fullscreen'], g.fullscreen ? 'fullscreen' : 'windowed', (v) => { g.fullscreen = v === 'fullscreen'; this.actions.settingsChanged(this.settings, 'graphics'); }, (v) => v[0]!.toUpperCase() + v.slice(1))),
      row('FPS limit', select(FPS_LIMITS.map(String), String(g.fpsLimit), (v) => { g.fpsLimit = Number(v); this.actions.settingsChanged(this.settings, 'graphics'); }, (v) => (v === '0' ? 'Unlimited' : `${v} FPS`))),
      row('V-Sync', check(g.vsync, (v) => { g.vsync = v; this.actions.settingsChanged(this.settings, 'graphics'); }), 'Off: render as fast as the browser allows (limited by FPS cap)'),
      row('Show FPS counter', check(g.showFps, (v) => { g.showFps = v; this.actions.settingsChanged(this.settings, 'graphics'); })),
      row('Field of view', slider(60, 110, 1, g.fov, (v) => { g.fov = v; this.actions.settingsChanged(this.settings, 'graphics'); }, (v) => `${v}°`)),
      row('Brightness', slider(0.6, 1.6, 0.05, g.brightness, (v) => { g.brightness = v; this.actions.settingsChanged(this.settings, 'graphics'); }, (v) => v.toFixed(2))),
      row('Shadows', select(['0', '1', '2', '3', '4'], String(g.shadows), (v) => { g.shadows = Number(v) as GraphicsSettingsShadows; changed(); }, (v) => ['Off', 'Low', 'Medium', 'High', 'Ultra'][Number(v)]!)),
      row('View distance', slider(400, 3000, 50, g.viewDistance, (v) => { g.viewDistance = v; changed(); }, (v) => `${v} m`)),
      row('Terrain detail', slider(1, 3, 1, g.terrainDetail, (v) => { g.terrainDetail = v; changed(); }, (v) => ['', 'Low', 'Medium', 'High'][v]!)),
      row('Vegetation density', slider(0.25, 1.5, 0.05, g.vegetationDensity, (v) => { g.vegetationDensity = v; changed(); }, (v) => `${Math.round(v * 100)}%`)),
      row('Grass density', slider(0, 1.5, 0.05, g.grassDensity, (v) => { g.grassDensity = v; changed(); }, (v) => (v === 0 ? 'Off' : `${Math.round(v * 100)}%`))),
      row('Water quality', select(['1', '2', '3'], String(g.waterQuality), (v) => { g.waterQuality = Number(v) as 1 | 2 | 3; changed(); }, (v) => ['', 'Low', 'Medium', 'High'][Number(v)]!), 'Takes effect on next world load'),
      row('Water reflections', select(['0', '1', '2'], String(g.reflections), (v) => { g.reflections = Number(v) as 0 | 1 | 2; changed(); }, (v) => ['Off', 'Half resolution', 'Full resolution'][Number(v)]!), 'Islands, trees and boats mirrored in the sea'),
      row('Anti-aliasing', select(['off', 'fxaa', 'smaa', 'msaa'], g.antiAliasing, (v) => { g.antiAliasing = v as typeof g.antiAliasing; changed(); }, (v) => v.toUpperCase())),
      row('Ambient occlusion (GTAO)', check(g.ambientOcclusion, (v) => { g.ambientOcclusion = v; changed(); })),
      row('Bloom', check(g.bloom, (v) => { g.bloom = v; changed(); })),
      row('God rays', check(g.godRays, (v) => { g.godRays = v; changed(); })),
      row('Post-processing', check(g.postProcessing, (v) => { g.postProcessing = v; changed(); }), 'Disabling turns off AO, bloom, god rays and grading'),
      row('Texture filtering', select(['1', '2', '4', '8', '16'], String(g.anisotropy), (v) => { g.anisotropy = Number(v); changed(); }, (v) => `${v}× anisotropic`)),
    );
  }

  private audioTab(body: HTMLElement) {
    const a = this.settings.audio;
    const ch = () => this.actions.settingsChanged(this.settings, 'audio');
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    body.append(
      row('Master volume', slider(0, 1, 0.01, a.master, (v) => { a.master = v; ch(); }, pct)),
      row('Music', slider(0, 1, 0.01, a.music, (v) => { a.music = v; ch(); }, pct)),
      row('Effects', slider(0, 1, 0.01, a.sfx, (v) => { a.sfx = v; ch(); }, pct)),
      row('Ambience', slider(0, 1, 0.01, a.ambient, (v) => { a.ambient = v; ch(); }, pct)),
      row('Interface', slider(0, 1, 0.01, a.ui, (v) => { a.ui = v; ch(); }, pct)),
      row('Mute when unfocused', check(a.muteUnfocused, (v) => { a.muteUnfocused = v; ch(); })),
    );
  }

  private controlsTab(body: HTMLElement, rerender: () => void) {
    const c = this.settings.controls;
    const ch = () => this.actions.settingsChanged(this.settings, 'controls');
    body.append(
      row('Mouse sensitivity', slider(0.1, 3, 0.05, c.sensitivity, (v) => { c.sensitivity = v; ch(); }, (v) => v.toFixed(2))),
      row('Invert Y', check(c.invertY, (v) => { c.invertY = v; ch(); })),
      row('Gamepad look speed', slider(0.2, 3, 0.05, c.gamepadSensitivity, (v) => { c.gamepadSensitivity = v; ch(); }, (v) => v.toFixed(2))),
      row('Toggle crouch', check(c.toggleCrouch, (v) => { c.toggleCrouch = v; ch(); })),
      row('Toggle sprint', check(c.toggleSprint, (v) => { c.toggleSprint = v; ch(); })),
      h('h3', { style: 'margin:16px 0 4px;font-size:13px;color:var(--muted)', text: 'KEY BINDINGS (click to rebind, Esc to cancel)' }),
    );
    for (const action of Object.keys(DEFAULT_BINDS)) {
      const codes = c.binds[action] ?? [];
      const keys = h('div', { style: 'display:flex;gap:6px' });
      codes.forEach((code, i) => {
        const kc = h('span', { class: 'keycap keybind', text: keyLabel(code) });
        kc.addEventListener('click', () => {
          kc.classList.add('listening');
          kc.textContent = '…';
          this.actions.captureKey((nc) => {
            if (nc !== 'Escape' || action === 'pause') { codes[i] = nc; c.binds[action] = codes; ch(); }
            rerender();
          });
        });
        keys.append(kc);
      });
      body.append(row(action.replace(/^\w/, (m) => m.toUpperCase()), keys));
    }
    body.append(h('div', { style: 'margin-top:12px' }, this.btn('Reset bindings', () => { c.binds = structuredClone(DEFAULT_BINDS); ch(); rerender(); }, 'small')));
  }

  private gameplayTab(body: HTMLElement) {
    const g = this.settings.gameplay;
    const ch = () => this.actions.settingsChanged(this.settings, 'gameplay');
    const name = h('input', { type: 'text', value: g.name, maxlength: 24, on: { change: (e) => { g.name = (e.target as HTMLInputElement).value.slice(0, 24); ch(); } } });
    body.append(
      row('Player name', name, 'Used for multiplayer'),
      row('HUD scale', slider(0.75, 1.5, 0.05, g.hudScale, (v) => { g.hudScale = v; ch(); }, (v) => `${Math.round(v * 100)}%`)),
      row('Tutorial hints', check(g.showTutorial, (v) => { g.showTutorial = v; ch(); })),
      row('Head bob', check(g.headBob, (v) => { g.headBob = v; ch(); })),
      row('Crosshair', check(g.crosshair, (v) => { g.crosshair = v; ch(); })),
      row('Show coordinates', check(g.showCoords, (v) => { g.showCoords = v; ch(); })),
    );
  }

  // ------------------------------------------------------------------ in-game overlays
  pause(actions: { resume(): void; save(): void; settings(): void; quit(): void; invite: string | null; coop: PauseCoop | null }) {
    const coop = actions.coop;
    const coopBox = h('div', { class: 'coop-box' });
    const renderCoop = () => {
      clear(coopBox);
      if (!coop) return;
      if (coop.code) {
        coopBox.append(
          h('div', { class: 'meta', style: 'color:var(--muted);font-size:12px;line-height:1.5;padding:4px 2px' }, 'Open to friends · code ', h('b', { class: 'code', text: coop.code }), ` · ${coop.players}/4 players. Friends open this page, choose Play with Friends and pick your game.`),
          this.btn('Close to Friends', () => { coop.close(); coop.code = null; renderCoop(); }, 'small'));
      } else {
        const note = h('div', { class: 'meta', style: 'color:var(--muted);font-size:12px;min-height:0' });
        coopBox.append(this.btn('Invite Friends (online co-op)', async () => {
          note.textContent = 'Opening your world…';
          try { coop.code = await coop.open(); renderCoop(); } catch (e) { note.textContent = (e as Error).message; }
        }), note);
      }
    };
    renderCoop();
    this.show(h('div', { class: 'panel dialog', style: 'width:min(380px,92vw)' },
      h('div', { class: 'dialog-head' }, h('h2', { text: coop?.code ? 'Menu (game keeps running)' : 'Paused' })),
      h('div', { class: 'dialog-body menu-col' },
        this.btn('Resume', actions.resume, 'primary'),
        this.btn('Save Game', actions.save),
        coopBox,
        this.btn('Settings', actions.settings),
        actions.invite ? h('div', { class: 'meta', style: 'color:var(--muted);font-size:12px;padding:6px 2px', text: `Friends can join at ${actions.invite}` }) : null,
        this.btn('Save & Quit to Menu', actions.quit, 'danger'))));
    this.root.classList.remove('menu-bg');
    this.root.style.background = 'rgba(3,8,10,0.55)';
  }

  loading(text: string, progress: number) {
    let el = this.root.querySelector('.loading') as HTMLElement | null;
    if (!el) {
      el = h('div', { class: 'screen loading' }, h('h1', { class: 'title', style: 'font-size:56px', text: GAME_NAME }), h('div', { class: 'stat', style: 'color:var(--muted)' }), h('div', { class: 'bar' }, h('div', { style: 'width:0%' })), h('div', { class: 'tip', text: tip() }));
      this.show(el);
    }
    (el.querySelector('.stat') as HTMLElement).textContent = text;
    (el.querySelector('.bar > div') as HTMLElement).style.width = `${Math.round(progress * 100)}%`;
  }

  error(title: string, msg: string, back: () => void) {
    this.root.style.background = '';
    this.root.classList.add('menu-bg');
    this.show(h('div', { class: 'panel dialog', style: 'width:min(520px,92vw)' },
      h('div', { class: 'dialog-head' }, h('h2', { text: title })), h('div', { class: 'dialog-body', style: 'color:var(--muted);line-height:1.6', text: msg }),
      h('div', { class: 'dialog-foot' }, this.btn('OK', back, 'primary'))));
  }

  resetBackdrop() { this.root.style.background = ''; this.root.classList.add('menu-bg'); }
}

type GraphicsSettingsShadows = 0 | 1 | 2 | 3 | 4;

function row(label: string, control: HTMLElement, hint?: string) {
  return h('div', { class: 'row' }, h('label', {}, label, hint ? h('span', { class: 'hint', text: hint }) : null), control);
}

function select(opts: string[], value: string, on: (v: string) => void, label: (v: string) => string = (v) => v) {
  const s = h('select', { on: { change: (e) => on((e.target as HTMLSelectElement).value) } }) as HTMLSelectElement;
  for (const o of opts) s.append(h('option', { value: o, text: label(o) }));
  s.value = value;
  return s;
}

function slider(min: number, max: number, step: number, value: number, on: (v: number) => void, fmt: (v: number) => string) {
  const out = h('span', { style: 'min-width:64px;text-align:right;color:var(--muted);font-size:13px', text: fmt(value) });
  const r = h('input', { type: 'range', min, max, step, value: String(value), on: { input: (e) => { const v = Number((e.target as HTMLInputElement).value); out.textContent = fmt(v); on(v); } } });
  return h('div', { style: 'display:flex;align-items:center;gap:10px' }, r, out);
}

function check(value: boolean, on: (v: boolean) => void) {
  return h('input', { type: 'checkbox', checked: value, on: { change: (e) => on((e.target as HTMLInputElement).checked) } });
}
