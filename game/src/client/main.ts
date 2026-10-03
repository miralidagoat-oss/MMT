/**
 * Application shell: boot, menus, frame loop (FPS limiter / vsync / dynamic
 * resolution), single-player worker host and multiplayer connections.
 */
import { WorldRenderer } from './render/renderer';
import { AudioEngine } from './audio/audio';
import { Input } from './input/input';
import { loadSettings, saveSettings, identityToken, type Settings } from './settings';
import { Menus } from './ui/menus';
import { Game } from './game/game';
import { LocalHost } from './net/local';
import { WsTransport, type Transport } from './net/transport';
import { RelayTransport, RelayPeerLink } from './net/relay';
import { getLobby, isHostedPage, randomId, claudeHost, type CoopLobby } from './net/room';
import { listAllWorlds, ensureLocal, onWorldSaved, flushCloud, deleteWorldEverywhere, exportWorld, importWorld } from './net/worlds';
import { PROTOCOL_VERSION } from '../shared/config';
import { dayNumber } from '../shared/systems/weather';
import type { PauseCoop } from './ui/menus';
import { computePlacement } from '../shared/systems/building';

class App {
  settings: Settings = loadSettings();
  canvas = document.getElementById('game') as HTMLCanvasElement;
  ui = document.getElementById('ui') as HTMLElement;
  renderer!: WorldRenderer;
  audio: AudioEngine;
  input: Input;
  menus: Menus;
  game: Game | null = null;
  local: LocalHost | null = null;
  private mode: 'menu' | 'loading' | 'playing' = 'menu';
  private last = performance.now();
  private lastFrame = 0;
  private fpsWindow: number[] = [];
  private dynTimer = 0;
  private reconnect: { address: string; tries: number } | null = null;
  /** joined a friend's game through the hosted page */
  private relayJoin: { code: string; tries: number } | null = null;
  /** hosting: this world is open to friends */
  private coop: { lobby: CoopLobby; code: string; links: Map<number, RelayPeerLink>; nextId: number; adTimer: ReturnType<typeof setInterval> } | null = null;
  private slot = '';
  private userToken: string | null = null;
  private padPrev: boolean[] = [];

  constructor() {
    this.audio = new AudioEngine(this.settings.audio);
    this.input = new Input(this.canvas, this.settings.controls);
    this.menus = new Menus(this.ui, this.settings, {
      newWorld: (o) => void this.startLocal({ mode: 'new', slot: `w${Date.now().toString(36)}`, name: o.name, seed: o.seed || undefined, settings: o.settings, coop: o.coop }),
      loadWorld: (slot, coop) => void this.startLocal({ mode: 'load', slot, coop }),
      deleteWorld: (slot) => deleteWorldEverywhere(slot),
      listWorlds: () => listAllWorlds(),
      exportWorld: (slot) => exportWorld(slot),
      importWorld: (file) => importWorld(file),
      join: (addr) => this.join(addr),
      coop: async () => {
        const lobby = await getLobby();
        if (!lobby) return null;
        return {
          watch: (cb) => { lobby.onGames((list) => cb(list.map((g) => ({ ...g, compatible: g.v === PROTOCOL_VERSION })))); return () => lobby.onGames(null); },
          join: (code) => { this.relayJoin = { code, tries: 0 }; void this.joinCoop(code); },
        };
      },
      hosted: isHostedPage(),
      settingsChanged: (s, what) => this.applySettings(s, what),
      click: () => { this.audio.unlock(); this.audio.play('ui_click', {}, undefined, 'ui'); },
      hover: () => this.audio.play('ui_hover', {}, undefined, 'ui'),
      captureKey: (cb) => { this.input.onAnyKey = (code) => { this.input.onAnyKey = null; cb(code); }; },
    });
    window.addEventListener('resize', () => this.renderer?.resize());
    window.addEventListener('focus', () => this.audio.setFocused(true));
    window.addEventListener('blur', () => this.audio.setFocused(false));
    window.addEventListener('pointerdown', () => this.audio.unlock(), { once: false });
    window.addEventListener('beforeunload', () => { if (this.local) void this.local.save(); });
    // tab hidden (switching away, closing on mobile): save while we still reliably can
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && this.local && this.mode === 'playing') void this.local.save().then(() => flushCloud(this.slot));
    });
  }

  async boot() {
    if (!document.createElement('canvas').getContext('webgl2')) {
      this.menus.error('WebGL2 required', 'Tidewake needs a browser with WebGL2 support (recent Chrome, Edge, Firefox or Safari) and hardware acceleration enabled.', () => location.reload());
      return;
    }
    this.renderer = new WorldRenderer(this.canvas, this.settings.graphics);
    this.userToken = await accountToken();
    this.applySettings(this.settings, 'gameplay');
    await this.menus.main();
    this.schedule();
    // handy for automated tests / debugging
    (window as unknown as { tidewake: App }).tidewake = this;
    (window as unknown as { __tw: object }).__tw = { computePlacement };
    const params = new URLSearchParams(location.search);
    if (params.get('join')) this.join(params.get('join')!);
    else if (params.get('autostart')) void this.startLocal({ mode: 'new', slot: `auto${Date.now().toString(36)}`, name: 'Quick Start', seed: params.get('seed') ?? undefined, settings: { cheats: params.get('cheats') === '1' } });
  }

  // ------------------------------------------------------------------ settings
  applySettings(s: Settings, what: 'graphics' | 'audio' | 'controls' | 'gameplay') {
    this.settings = s;
    if (what === 'graphics') {
      this.renderer.applySettings(s.graphics);
      if (s.graphics.fullscreen && !document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
      if (!s.graphics.fullscreen && document.fullscreenElement) void document.exitFullscreen?.();
    }
    if (what === 'audio') this.audio.applySettings(s.audio);
    if (what === 'controls') this.input.controls = s.controls;
    document.documentElement.style.setProperty('--hud-scale', String(s.gameplay.hudScale));
    saveSettings(s);
  }

  // ------------------------------------------------------------------ sessions
  private identity() {
    const g = this.settings.gameplay;
    // signed in on the hosted page: the same survivor on every device
    return { name: g.name || 'Castaway', token: this.userToken ?? identityToken(), color: g.color };
  }

  async startLocal(opts: { mode: 'new' | 'load'; slot: string; name?: string; seed?: string; settings?: object; coop?: boolean }) {
    this.audio.unlock();
    this.mode = 'loading';
    this.menus.loading(opts.mode === 'new' ? 'Generating islands…' : 'Loading world…', 0.05);
    try {
      if (opts.mode === 'load') await ensureLocal(opts.slot).catch((e) => console.warn('cloud copy unavailable', e));
      this.slot = opts.slot;
      this.local = new LocalHost();
      this.local.onSaved = (slot, text, stored) => void onWorldSaved(slot, text, stored).catch(() => {});
      await this.local.start({ mode: opts.mode, slot: opts.slot, name: opts.name, seed: opts.seed, settings: opts.settings });
      this.startGame(this.local.transport, null, true);
      if (opts.coop) {
        const g = this.game;
        const wait = setInterval(() => {
          if (this.game !== g || !g) { clearInterval(wait); return; }
          if (!g.isReady) return;
          clearInterval(wait);
          this.openToFriends().then((code) => g.hud.notify(`Open to friends. Your game code is ${code}.`, 'good'))
            .catch((e) => g.hud.notify((e as Error).message, 'bad'));
        }, 250);
      }
    } catch (e) {
      this.local?.worker.terminate();
      this.local = null;
      this.mode = 'menu';
      this.menus.error('Could not start world', (e as Error).message, () => void this.menus.main());
    }
  }

  // ------------------------------------------------------------------ online co-op (hosted page)
  private adInfo() {
    const s = this.game?.session;
    const players = s ? s.roster.filter((r) => r.connected).length : 1;
    const day = s ? dayNumber({ time: s.serverTime(), dayOffset: s.dayOffset }) : 1;
    return { host: this.settings.gameplay.name || 'Castaway', world: s?.worldName || 'Island', players, day };
  }

  /** Let friends join the world this browser is hosting. Returns the game code. */
  async openToFriends(): Promise<string> {
    if (this.coop) return this.coop.code;
    const local = this.local;
    if (!local) throw new Error('Only the host of a world can invite friends.');
    const lobby = await getLobby();
    if (!lobby) throw new Error('Online play needs the game opened from its claude.ai link while signed in.');
    const code = randomId(6);
    const coop = { lobby, code, links: new Map<number, RelayPeerLink>(), nextId: 1, adTimer: setInterval(() => lobby.advertise(code, this.adInfo()), 4000) };
    this.coop = coop;
    local.setOpen(true);
    local.setPaused(false);
    local.onPeer = (m) => {
      const link = coop.links.get(m.id);
      if (!link) return;
      if (m.type === 'peer-out' && m.data) link.send(m.data, !!m.snap);
      else if (m.type === 'peer-kick') link.end('kicked');
    };
    lobby.host(code, this.adInfo(), (pipe) => {
      const id = coop.nextId++;
      const link = new RelayPeerLink(pipe, (frame) => this.local?.peerFrame(id, frame), () => { coop.links.delete(id); this.local?.peerClose(id); });
      link.onSnapshotIdle = () => this.local?.peerReady(id);
      coop.links.set(id, link);
      local.peerOpen(id);
    });
    return code;
  }

  closeToFriends() {
    const c = this.coop;
    if (!c) return;
    this.coop = null;
    clearInterval(c.adTimer);
    // the worker tells each friend the world closed; give that a moment to go out
    this.local?.setOpen(false);
    c.lobby.stopHosting(false);
    setTimeout(() => { for (const l of c.links.values()) l.end('closed'); c.lobby.closeRooms(); }, 1200);
  }

  private pauseCoop(): PauseCoop | null {
    if (!this.local || !isHostedPage()) return null;
    return {
      code: this.coop?.code ?? null,
      players: this.adInfo().players,
      open: () => this.openToFriends(),
      close: () => this.closeToFriends(),
    };
  }

  async joinCoop(code: string) {
    this.audio.unlock();
    this.mode = 'loading';
    this.menus.loading('Finding the host…', 0.1);
    const lobby = await getLobby();
    if (!lobby) { this.mode = 'menu'; this.menus.error('Online play unavailable', 'Open the game from its claude.ai link while signed in to play with friends.', () => void this.menus.main()); return; }
    try {
      const pipe = await lobby.connect(code);
      if (this.mode !== 'loading') { pipe.close(); return; }
      const t = new RelayTransport(pipe);
      this.startGame(t, null, false);
      const g = this.game;
      setTimeout(() => {
        if (this.game === g && g && !g.session.connected && this.mode === 'loading') { t.close(); this.onDisconnect(`No answer from game ${code}. The host may have closed the game or left the page.`); }
      }, 25000);
    } catch (e) {
      this.onDisconnect((e as { message?: string }).message || 'Could not open the game room');
    }
  }

  join(address: string) {
    this.audio.unlock();
    this.mode = 'loading';
    this.menus.loading(`Connecting to ${address}…`, 0.1);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = address.includes('://') ? address : `${proto}://${address}`;
    this.reconnect = { address, tries: 0 };
    this.startGame(new WsTransport(url), address, false);
  }

  private startGame(transport: Transport, address: string | null, local: boolean) {
    this.game?.dispose();
    this.game = new Game(this.renderer, this.audio, this.input, this.settings, this.ui, transport, this.identity(), {
      onQuit: () => void this.quitToMenu(),
      onDisconnect: (reason) => this.onDisconnect(reason),
      onPause: (p) => {
        if (p) this.menus.pause({
          resume: () => this.game?.setPaused(false),
          save: async () => {
            if (this.local) {
              const ok = await this.local.save();
              await flushCloud(this.slot).catch(() => {});
              this.game?.hud.notify(ok ? 'Game saved.' : 'Save failed', ok ? 'good' : 'bad');
            } else this.game?.session.requestSave();
          },
          settings: () => this.menus.settingsScreen(() => this.game?.setPaused(true), true),
          quit: () => void this.quitToMenu(),
          invite: address,
          coop: this.pauseCoop(),
        });
        else this.menus.hide();
        // a world open to friends keeps running while the host is in the menu
        this.local?.setPaused(p && !this.coop);
      },
      requestSave: () => (this.local ? this.local.save() : Promise.resolve(false)),
      inviteAddress: address,
    });
    if (local) this.game.hello();
  }

  private onDisconnect(reason: string) {
    if (this.mode === 'menu') return;
    const rc = this.reconnect;
    const fatal = /full|Version|mismatch|token|closed the world|No answer/i.test(reason);
    const rj = this.relayJoin;
    if (rj && !fatal && rj.tries < 5 && this.game?.isReady) {
      rj.tries++;
      this.game?.dispose();
      this.game = null;
      this.mode = 'loading';
      this.menus.loading(`Connection lost (${reason}). Reconnecting… attempt ${rj.tries}/5`, 0.1);
      setTimeout(() => { if (this.mode === 'loading' && this.relayJoin === rj) void this.joinCoop(rj.code); }, 1500 * rj.tries);
      return;
    }
    if (rc && !this.local && !fatal && rc.tries < 5) {
      rc.tries++;
      this.mode = 'loading';
      this.menus.loading(`Connection lost (${reason}). Reconnecting… attempt ${rc.tries}/5`, 0.1);
      const delay = 1000 * 2 ** (rc.tries - 1);
      setTimeout(() => {
        if (this.mode !== 'loading' || !this.reconnect) return;
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        const url = rc.address.includes('://') ? rc.address : `${proto}://${rc.address}`;
        this.startGame(new WsTransport(url), rc.address, false);
      }, delay);
      return;
    }
    this.game?.dispose();
    this.game = null;
    this.mode = 'menu';
    this.relayJoin = null;
    this.input.releaseLock();
    this.menus.resetBackdrop();
    this.menus.error('Disconnected', reason || 'The connection to the server was lost.', () => void this.menus.main());
  }

  async quitToMenu() {
    this.mode = 'menu';
    this.reconnect = null;
    this.relayJoin = null;
    this.closeToFriends();
    this.input.releaseLock();
    this.game?.dispose();
    this.game = null;
    if (this.local) { this.menus.loading('Saving…', 0.9); await this.local.quit(); this.local = null; await flushCloud(this.slot).catch(() => {}); }
    this.menus.resetBackdrop();
    await this.menus.main();
  }

  // ------------------------------------------------------------------ frame loop
  private schedule() {
    const g = this.settings.graphics;
    const minDt = g.fpsLimit > 0 ? 1000 / g.fpsLimit : 0;
    if (g.vsync) requestAnimationFrame(() => this.frame());
    else {
      const wait = Math.max(0, minDt - (performance.now() - this.lastFrame) - 1);
      setTimeout(() => this.frame(), wait);
    }
  }

  private frame() {
    const now = performance.now();
    const g = this.settings.graphics;
    const minDt = g.fpsLimit > 0 ? 1000 / g.fpsLimit : 0;
    if (now - this.lastFrame >= minDt - 1) {
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.lastFrame = now;
      try { this.tick(dt); } catch (e) { console.error(e); }
      this.menuGamepad();
      this.input.endFrame();
      this.input.endPadFrame();
      this.dynamicResolution(dt);
    }
    this.schedule();
  }

  private tick(dt: number) {
    if (this.game) {
      this.game.update(dt);
      if (this.mode === 'loading') {
        if (this.game.isReady) {
          this.mode = 'playing';
          if (this.reconnect) this.reconnect.tries = 0;
          if (this.relayJoin) this.relayJoin.tries = 0;
          this.menus.hide();
        } else {
          this.menus.loading(this.game.session.connected ? 'Building the islands…' : 'Waiting for server…', this.game.progress);
          // keep the loading screen alive
          if (!this.game.session.connected) this.renderer.renderMenu(dt);
        }
      }
      return;
    }
    this.renderer.renderMenu(dt);
  }

  /** Controller navigation for menus and in-game panels: D-pad/bumpers move focus, A activates, B backs out. */
  private menuGamepad() {
    const pad = [...(navigator.getGamepads?.() ?? [])].find((p) => p && p.connected);
    if (!pad) return;
    const now = pad.buttons.map((b) => b.pressed);
    const pressed = (i: number) => !!now[i] && !this.padPrev[i];
    this.padPrev = now;
    const uiActive = this.menus.visible || !!this.game?.uiOpen;
    if (!uiActive) return;
    const els = [...document.querySelectorAll<HTMLElement>('#ui button:not([disabled]), #ui select, #ui input, #ui .recipe, #ui .bp, #ui .tab, #ui .slot')]
      .filter((el) => el.offsetParent !== null);
    if (!els.length) return;
    let idx = els.indexOf(document.activeElement as HTMLElement);
    let moved = false;
    if (pressed(13) || pressed(15) || pressed(5)) { idx = (idx + 1) % els.length; moved = true; }
    if (pressed(12) || pressed(14) || pressed(4)) { idx = (idx - 1 + els.length) % els.length; moved = true; }
    if (moved) {
      const el = els[idx]!;
      if (el.tabIndex < 0) el.tabIndex = 0;
      el.focus();
      el.scrollIntoView({ block: 'nearest' });
      this.audio.play('ui_hover', {}, undefined, 'ui');
    }
    if (pressed(0)) (document.activeElement as HTMLElement | null)?.click();
    if (pressed(1)) {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape' }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Escape', key: 'Escape' }));
      const back = [...document.querySelectorAll<HTMLButtonElement>('#ui .dialog-foot .btn')].find((b) => /back/i.test(b.textContent ?? ''));
      back?.click();
    }
  }

  private dynamicResolution(dt: number) {
    const g = this.settings.graphics;
    if (!g.dynamicResolution) { if (this.renderer.dynScale !== 1) { this.renderer.dynScale = 1; this.renderer.resize(); } return; }
    this.fpsWindow.push(dt);
    this.dynTimer += dt;
    if (this.dynTimer < 1.5) return;
    const avg = this.fpsWindow.reduce((a, b) => a + b, 0) / this.fpsWindow.length;
    this.fpsWindow = [];
    this.dynTimer = 0;
    const fps = 1 / avg;
    const target = g.fpsLimit > 0 ? g.fpsLimit : 60;
    const before = this.renderer.dynScale;
    if (fps < target * 0.9) this.renderer.dynScale = Math.max(0.5, before - 0.08);
    else if (fps > target * 1.08 && before < 1) this.renderer.dynScale = Math.min(1, before + 0.05);
    if (before !== this.renderer.dynScale) this.renderer.resize();
  }
}

/** On the hosted page, a signed-in player's account gives a stable identity across devices. */
async function accountToken(): Promise<string | null> {
  const c = claudeHost();
  if (!c) return null;
  try {
    const user = await Promise.race([c.use('user'), new Promise<null>((r) => setTimeout(() => r(null), 4000))]) as { id(): Promise<string | null> } | null;
    const id = user ? await user.id() : null;
    if (!id) return null;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`tidewake:${id}`));
    return 'acct' + Array.from(new Uint8Array(digest).slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}

const app = new App();
void app.boot();
