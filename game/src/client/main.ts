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
  private padPrev: boolean[] = [];

  constructor() {
    this.audio = new AudioEngine(this.settings.audio);
    this.input = new Input(this.canvas, this.settings.controls);
    this.menus = new Menus(this.ui, this.settings, {
      newWorld: (o) => void this.startLocal({ mode: 'new', slot: `w${Date.now().toString(36)}`, name: o.name, seed: o.seed || undefined, settings: o.settings }),
      loadWorld: (slot) => void this.startLocal({ mode: 'load', slot }),
      deleteWorld: (slot) => LocalHost.deleteWorld(slot),
      listWorlds: () => LocalHost.listWorlds(),
      join: (addr) => this.join(addr),
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
  }

  async boot() {
    if (!document.createElement('canvas').getContext('webgl2')) {
      this.menus.error('WebGL2 required', 'Tidewake needs a browser with WebGL2 support (recent Chrome, Edge, Firefox or Safari) and hardware acceleration enabled.', () => location.reload());
      return;
    }
    this.renderer = new WorldRenderer(this.canvas, this.settings.graphics);
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
    return { name: g.name || 'Castaway', token: identityToken(), color: g.color };
  }

  async startLocal(opts: { mode: 'new' | 'load'; slot: string; name?: string; seed?: string; settings?: object }) {
    this.audio.unlock();
    this.mode = 'loading';
    this.menus.loading(opts.mode === 'new' ? 'Generating islands…' : 'Loading world…', 0.05);
    try {
      this.local = new LocalHost();
      await this.local.start({ mode: opts.mode, slot: opts.slot, name: opts.name, seed: opts.seed, settings: opts.settings });
      this.startGame(this.local.transport, null, true);
    } catch (e) {
      this.local?.worker.terminate();
      this.local = null;
      this.mode = 'menu';
      this.menus.error('Could not start world', (e as Error).message, () => void this.menus.main());
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
          save: async () => { if (this.local) { const ok = await this.local.save(); this.game?.hud.notify(ok ? 'Game saved.' : 'Save failed', ok ? 'good' : 'bad'); } else this.game?.session.requestSave(); },
          settings: () => this.menus.settingsScreen(() => this.game?.setPaused(true), true),
          quit: () => void this.quitToMenu(),
          invite: address,
        });
        else this.menus.hide();
        this.local?.setPaused(p);
      },
      requestSave: () => (this.local ? this.local.save() : Promise.resolve(false)),
      inviteAddress: address,
    });
    if (local) this.game.hello();
  }

  private onDisconnect(reason: string) {
    if (this.mode === 'menu') return;
    const rc = this.reconnect;
    const fatal = /full|Version|mismatch|token/i.test(reason);
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
    this.input.releaseLock();
    this.menus.resetBackdrop();
    this.menus.error('Disconnected', reason || 'The connection to the server was lost.', () => void this.menus.main());
  }

  async quitToMenu() {
    this.mode = 'menu';
    this.reconnect = null;
    this.input.releaseLock();
    this.game?.dispose();
    this.game = null;
    if (this.local) { this.menus.loading('Saving…', 0.9); await this.local.quit(); this.local = null; }
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

const app = new App();
void app.boot();
