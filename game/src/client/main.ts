/**
 * Application shell: boot, menus, frame loop (FPS limiter / vsync / dynamic
 * resolution), single-player worker host and multiplayer connections.
 */
import { WorldRenderer } from './render/renderer';
import { AudioEngine } from './audio/audio';
import { Input } from './input/input';
import { loadSettings, saveSettings, identityToken, rememberIdentity, type Settings } from './settings';
import { requestAllOnce, permissionState, openPermissions } from './net/permissions';
import { Menus } from './ui/menus';
import { Game } from './game/game';
import { LocalHost } from './net/local';
import { WsTransport, type Transport } from './net/transport';
import { RelayTransport, RelayPeerLink } from './net/relay';
import { getLobby, isHostedPage, randomId, claudeHost, type CoopLobby, type OpenGame } from './net/room';
import { HostSuccession, BackupReceiver, checkHost, TAKEOVER_STAGGER_MS, type Backup, type SuccessionInfo } from './net/succession';
import { onTick } from './net/ticker';
import { readEnvelope } from '../shared/save';
import type { RelayMsg } from '../shared/net/protocol';
import { listAllWorlds, ensureLocal, onWorldSaved, flushCloud, deleteWorldEverywhere, exportWorld, importWorld, importWorldText } from './net/worlds';
import { saveStore } from './net/idb';
import { encode } from '../shared/net/codec';
import { canCompress, gzipText, gunzipText } from './net/compress';
import { PROTOCOL_VERSION } from '../shared/config';
import { dayNumber } from '../shared/systems/weather';
import type { PauseCoop, PauseRelay } from './ui/menus';
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
  private relayJoin: RelayJoin | null = null;
  /** hosting: this world is open to friends */
  private coop: Coop | null = null;
  /** as a friend: the takeover order the host last told us, and our copy of the world */
  private succ: SuccessionInfo | null = null;
  private backups = new BackupReceiver();
  private slot = '';
  private userToken: string | null = null;
  private userTokenP: Promise<string | null> = Promise.resolve(null);

  /** Wait (briefly) for the account identity so a world never sees two tokens for one player. */
  private async identityReady() {
    await Promise.race([this.userTokenP, new Promise((r) => setTimeout(r, 6000))]);
  }
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
          join: (code) => { this.relayJoin = newRelayJoin(code); this.succ = null; this.backups.reset(); void this.joinCoop(code); },
        };
      },
      hosted: isHostedPage(),
      roomPermission: () => permissionState('room'),
      openPermissions: () => openPermissions(),
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
    // the page is closing: tell friends right away so one of them takes the world over without waiting
    window.addEventListener('pagehide', () => this.pageClosing());
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
    this.applySettings(this.settings, 'gameplay');
    // one batched consent dialog (hosted page), then the account identity; never blocks the menu
    this.userTokenP = requestAllOnce().then(() => accountToken()).then((t) => {
      if (t) { this.userToken = t; rememberIdentity(t); }
      return t;
    });
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

  async startLocal(opts: { mode: 'new' | 'load'; slot: string; name?: string; seed?: string; settings?: object; coop?: boolean; code?: string; gen?: number; note?: (code: string) => string }) {
    this.audio.unlock();
    this.mode = 'loading';
    this.menus.loading(opts.mode === 'new' ? 'Generating islands…' : 'Loading world…', 0.05);
    try {
      await this.identityReady();
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
          this.openToFriends(opts.code, opts.gen).then((code) => g.hud.notify(opts.note ? opts.note(code) : `Open to friends. Your game code is ${code}.`, 'good'))
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
  async openToFriends(useCode?: string, gen = 0): Promise<string> {
    if (this.coop) return this.coop.code;
    const local = this.local;
    if (!local) throw new Error('Only the host of a world can invite friends.');
    const lobby = await getLobby();
    if (!lobby) throw new Error('Online play needs you signed in to claude.ai, with the game opened from its link (owner, or invited by email).');
    const code = useCode && /^[a-z0-9]{6}$/.test(useCode) ? useCode : randomId(6);
    const succession = new HostSuccession({
      code, gen, host: () => this.settings.gameplay.name || 'Castaway',
      getBackup: async () => {
        const text = await this.local?.snapshotText();
        if (!text) return null;
        return canCompress ? { data: await gzipText(text), gz: true } : { data: new TextEncoder().encode(text), gz: false };
      },
    });
    // driven by the background-safe tick: a hidden host tab keeps its ad fresh and its backups flowing
    let adAt = performance.now(), succAt = 0;
    const stopTick = onTick(() => {
      const now = performance.now();
      if (now - adAt >= 4000) { adAt = now; lobby.advertise(code, gen, this.adInfo()); }
      if (now - succAt >= 100) { succAt = now; succession.tick(); }
    });
    const coop: Coop = { lobby, code, gen, links: new Map(), nextId: 1, succession, stopTick };
    this.coop = coop;
    local.setOpen(true);
    local.setPaused(false);
    local.onPeer = (m) => {
      const link = coop.links.get(m.id);
      if (!link) return;
      if (m.type === 'peer-out' && m.data) link.send(m.data, !!m.snap);
      else if (m.type === 'peer-kick') link.end('kicked');
      else if (m.type === 'peer-named') succession.named(m.id, String(m.name ?? ''));
    };
    if (this.game) this.game.hud.inviteCode = code;
    lobby.host(code, gen, this.adInfo(), (pipe) => {
      const id = coop.nextId++;
      const link = new RelayPeerLink(pipe, (frame) => this.local?.peerFrame(id, frame), () => { coop.links.delete(id); succession.remove(id); this.local?.peerClose(id); });
      link.onSnapshotIdle = () => this.local?.peerReady(id);
      coop.links.set(id, link);
      succession.add(id, link);
      local.peerOpen(id);
    }, (by) => void this.yieldWorld(by));
    return code;
  }

  /** Stop hosting online. 'close' tells the friends the world closed; 'quiet' leaves them to move on. */
  private endCoop(c: Coop, how: 'close' | 'quiet') {
    if (this.coop === c) this.coop = null;
    c.stopTick();
    c.succession.dispose();
    if (this.game) this.game.hud.inviteCode = null;
    c.lobby.stopHosting(false);
    if (how === 'close') {
      // the worker tells each friend the world closed; give that a moment to go out
      this.local?.setOpen(false);
      setTimeout(() => { for (const l of [...c.links.values()]) l.end('closed'); c.lobby.closeRooms(); }, 1200);
    } else {
      for (const l of [...c.links.values()]) l.end('moved on');
      setTimeout(() => c.lobby.closeRooms(), 1500);
      this.local?.setOpen(false);
    }
  }

  /** The page is going away (tab closed, reloaded, navigated): best-effort word to the friends. */
  private pageClosing() {
    const c = this.coop;
    if (!c) return;
    const bye = encode({ t: 'host-gone', host: this.settings.gameplay.name || 'The host' } satisfies RelayMsg);
    for (const l of c.links.values()) l.urgent(bye);
    c.lobby.withdraw();
  }

  /**
   * The host is leaving while friends play: freeze the world, save it, send the
   * save to the longest-connected friend (who reopens it with the same game
   * code) and tell the others to reconnect to them.
   */
  private async handOver(): Promise<void> {
    const c = this.coop, local = this.local;
    if (!c || !local) return;
    const links = [...c.links.entries()];
    if (!links.length) return;
    this.mode = 'loading';
    this.menus.loading('Handing the world to a friend…', 0.3);
    // stop advertising and accepting players first, so reconnecting friends find the new host
    c.stopTick();
    c.succession.dispose();
    c.lobby.stopHosting(false);
    local.setPaused(true);
    const ok = await local.save();
    const text = ok ? await saveStore.get(`world:${this.slot}`) : null;
    if (!text) throw new Error('could not save the world for the handoff');
    const gz = canCompress;
    const save = gz ? await gzipText(text) : text;
    const host = this.settings.gameplay.name || 'The host';
    const [successorId, successor] = links[0]!;
    const notice = encode({ t: 'notify', text: `${host} is leaving and is handing the world over. Hold on…`, level: 'info' });
    for (const [, l] of links) l.send(notice, false);
    successor.send(encode({ t: 'handoff', code: c.code, host, gz, save, gen: c.gen } satisfies RelayMsg), false);
    for (const [id, l] of links) if (id !== successorId) l.send(encode({ t: 'reject', reason: `${host} left and handed the world to another player.` }), false);
    // wait until everything has been acknowledged (or give up after a minute)
    const t0 = performance.now();
    while (performance.now() - t0 < 30000 && links.some(([, l]) => l.link.backlog > 0 && !l.link.broken && !l.ended)) {
      this.menus.loading('Handing the world to a friend…', 0.3 + 0.6 * Math.min(1, (performance.now() - t0) / 15000));
      await new Promise((r) => setTimeout(r, 250));
    }
    // the friends now leave on their own; close quietly (no "world closed" message)
    this.endCoop(c, 'quiet');
  }

  /** A friend handed us their world: become its host under the same game code. */
  private async takeOver(m: Extract<RelayMsg, { t: 'handoff' }>) {
    if (!isHostedPage()) return;
    try {
      const text = m.gz && m.save instanceof Uint8Array ? await gunzipText(m.save) : typeof m.save === 'string' ? m.save : '';
      const slot = await importWorldText(text, m.code);
      const from = String(m.host).slice(0, 24);
      this.relayJoin = null;
      this.succ = null;
      this.backups.reset();
      this.input.releaseLock();
      this.game?.dispose();
      this.game = null;
      await this.startLocal({ mode: 'load', slot, coop: true, code: m.code, gen: safeGen(m.gen) + 1, note: (code) => `${from} left and handed you the world. You are the host now (code ${code}).` });
    } catch (e) {
      console.warn('could not take over the world', e);
      this.onDisconnect('The host tried to hand you the world, but it could not be loaded.');
    }
  }

  /** co-op relay messages from the host of the game we play in */
  private onRelay(m: RelayMsg) {
    const rj = this.relayJoin;
    if (!rj) return;
    switch (m.t) {
      case 'handoff': void this.takeOver(m); break;
      case 'backup': this.backups.receive(m); break;
      case 'succession': { const s = cleanSuccession(m); if (s && s.code === rj.code) this.succ = s; break; }
      case 'host-gone': this.hostLost(rj, true); break;
    }
  }

  /**
   * We lost the host of the game we play in without being told why: its page
   * may have closed. If we hold a backup and are next in the takeover order we
   * reopen the world ourselves (after checking the host is really gone);
   * otherwise we keep reconnecting by code until the new host answers.
   */
  private hostLost(rj: RelayJoin, gone: boolean) {
    if (this.relayJoin !== rj) return;
    const n = ++rj.losses;
    const succ = this.succ && this.succ.code === rj.code ? this.succ : null;
    const backup = this.backups.latest;
    this.backups.dropPartial();
    this.succ = null;
    this.game?.dispose();
    this.game = null;
    this.input.releaseLock();
    this.mode = 'loading';
    const host = succ?.host || 'the host';
    const why = gone ? `${cap(host)}'s game closed.` : `Lost the connection to ${host}.`;
    const next = succ?.names[0] ?? null;
    const lostGen = succ?.gen ?? 0;
    // someone may be reopening the world: wait longer for an answer, and say who
    rj.handoff = !!next;
    rj.tries = 0;
    if (succ && succ.rank !== null && backup) {
      const rank = succ.rank;
      rj.wait = rank === 0 ? `${why} Taking over the world…` : `${why} Waiting for ${next} to take over…`;
      this.menus.loading(rj.wait, 0.1);
      if (rank > 0) { rj.note = `${next} is hosting the world now.`; void this.joinCoop(rj.code); }
      setTimeout(() => void this.successionCheck(rj, n, backup, lostGen, gone, host), rank * TAKEOVER_STAGGER_MS);
      return;
    }
    rj.wait = next ? `${why} ${next} is taking over the world; joining them…` : `${why} Reconnecting…`;
    if (next) rj.note = `${next} is hosting the world now.`;
    this.menus.loading(rj.wait, 0.1);
    setTimeout(() => { if (this.relayJoin === rj && rj.losses === n && !this.game) void this.joinCoop(rj.code); }, 1500);
  }

  /** Our turn in the takeover order: take the world over unless someone hosts it. */
  private async successionCheck(rj: RelayJoin, n: number, backup: Backup, lostGen: number, gone: boolean, host: string) {
    const current = () => this.relayJoin === rj && rj.losses === n && !this.game?.session.connected;
    if (!current()) return;
    const lobby = await getLobby();
    if (!lobby) return;
    const verdict = await checkHost({ code: rj.code, lostGen, gone, ads: () => lobby.ads(), connected: () => lobby.connected });
    if (!current()) return;
    if (verdict === 'free') { await this.takeOverFromBackup(rj, lobby, backup, lostGen, host); return; }
    // the old host is still there, or a friend already took over: join whoever hosts the code
    rj.wait = verdict === 'taken' ? 'Joining the new host…' : `Reconnecting to ${host}…`;
    if (verdict === 'alive') rj.note = undefined;
    if (!this.game) void this.joinCoop(rj.code);
  }

  /** Reopen the world from our backup under the same game code, one generation on. */
  private async takeOverFromBackup(rj: RelayJoin, lobby: CoopLobby, backup: Backup, lostGen: number, host: string) {
    const code = rj.code, gen = lostGen + 1;
    // a join attempt still waiting for an answer is no longer needed
    this.game?.dispose();
    this.game = null;
    this.mode = 'loading';
    this.menus.loading(`${cap(host)}'s game closed. Reopening the world from your backup…`, 0.2);
    try {
      const text = backup.gz ? await gunzipText(backup.data) : new TextDecoder().decode(backup.data);
      const env = readEnvelope(text);
      // claim the code at once, so the other friends wait for us instead of taking over too
      lobby.advertise(code, gen, { host: this.settings.gameplay.name || 'Castaway', world: env.name, players: 1, day: env.day });
      const slot = await importWorldText(text, code);
      const age = Math.max(1, Math.round((Date.now() - backup.at) / 1000));
      this.relayJoin = null;
      this.backups.reset();
      await this.startLocal({ mode: 'load', slot, coop: true, code, gen, note: (c) => `${cap(host)}'s game closed, so you are the host now (code ${c}). The world continues from a backup made about ${age} s ago.` });
      if (!this.local) lobby.withdraw();
    } catch (e) {
      console.warn('takeover failed', e);
      lobby.withdraw();
      this.relayJoin = rj;
      this.onDisconnect('The host left and the world could not be reopened from your backup.');
    }
  }

  /**
   * While our connection was down a friend took this world over (a newer hosting
   * of the same code exists): stop hosting, keep our copy in our saves, and join
   * them, so everyone plays in one world again.
   */
  private async yieldWorld(by: OpenGame) {
    const c = this.coop, local = this.local;
    if (!c || !local || this.coop !== c) return;
    const code = c.code;
    this.mode = 'loading';
    this.menus.loading(`${by.host} took the world over while your connection was down. Joining their game…`, 0.2);
    const moved = encode({ t: 'reject', reason: `The world moved to ${by.host}'s game.` });
    for (const l of c.links.values()) l.send(moved, false);
    this.endCoop(c, 'quiet');
    this.input.releaseLock();
    this.game?.dispose();
    this.game = null;
    this.local = null;
    await local.quit();
    await flushCloud(this.slot).catch(() => {});
    this.relayJoin = newRelayJoin(code);
    this.relayJoin.handoff = true;
    this.relayJoin.note = `${by.host} is hosting the world now. Your own copy stays in your saves.`;
    void this.joinCoop(code);
  }

  closeToFriends() {
    const c = this.coop;
    if (c) this.endCoop(c, 'close');
  }

  private pauseCoop(): PauseCoop | null {
    if (!this.local || !isHostedPage()) return null;
    return {
      code: this.coop?.code ?? null,
      players: this.adInfo().players,
      next: () => this.coop?.succession.order()[0] ?? null,
      open: () => this.openToFriends(),
      close: () => this.closeToFriends(),
    };
  }

  /** what a friend's pause menu says about who carries the world on */
  private pauseRelay(): PauseRelay | null {
    const rj = this.relayJoin, s = this.succ;
    if (!rj || !this.game?.isReady) return null;
    return { code: rj.code, host: s?.host ?? null, next: s?.names[0] ?? null, you: s?.rank === 0 };
  }

  async joinCoop(code: string) {
    this.audio.unlock();
    this.mode = 'loading';
    this.menus.loading(this.relayJoin?.wait ?? 'Finding the host…', 0.1);
    await this.identityReady();
    const lobby = await getLobby();
    if (!lobby) { this.mode = 'menu'; this.menus.error('Online play unavailable', 'Sign in to claude.ai and open the game from the link the host invited you with. The host invites friends by email from the page\'s Share menu; a public link only allows single-player.', () => void this.menus.main()); return; }
    try {
      const pipe = await lobby.connect(code);
      if (this.mode !== 'loading' || this.game || (this.relayJoin && this.relayJoin.code !== code)) { pipe.close(); return; }
      const t = new RelayTransport(pipe);
      this.startGame(t, null, false);
      const g = this.game as Game | null;
      setTimeout(() => {
        if (this.game === g && g && !g.session.connected && this.mode === 'loading') { t.close(); this.onDisconnect(`No answer from game ${code}. The host may have closed the game or left the page.`); }
      }, this.relayJoin?.handoff ? 120000 : 25000);
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
      onDisconnect: (reason, rejected) => this.onDisconnect(reason, rejected),
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
          relay: this.pauseRelay(),
        });
        else this.menus.hide();
        // a world open to friends keeps running while the host is in the menu
        this.local?.setPaused(p && !this.coop);
      },
      requestSave: () => (this.local ? this.local.save() : Promise.resolve(false)),
      inviteAddress: address,
      onRelay: (m) => this.onRelay(m),
    });
    if (local) this.game.hello();
  }

  private onDisconnect(reason: string, rejected = false) {
    if (this.mode === 'menu') return;
    const rc = this.reconnect;
    const fatal = /full|Version|mismatch|token|closed the world|No answer|could not be reopened/i.test(reason);
    const rj = this.relayJoin;
    if (rj && /handed the world|moved to/i.test(reason)) rj.handoff = true;
    // the host went quiet without telling us why: its page may have closed
    if (rj && !rejected && !fatal && this.game?.isReady) { this.hostLost(rj, false); return; }
    if (rj && !fatal && rj.tries < 5 && this.game?.isReady) {
      rj.tries++;
      this.game?.dispose();
      this.game = null;
      this.mode = 'loading';
      rj.wait = rj.handoff ? 'The world moved to another player. Joining the new host…' : `Connection lost (${reason}). Reconnecting… attempt ${rj.tries}/5`;
      this.menus.loading(rj.wait, 0.1);
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
    // friends are playing in this world: one of them takes it over instead of everyone being kicked
    if (this.coop && this.coop.links.size > 0 && this.local) await this.handOver().catch((e) => console.warn('handoff failed', e));
    this.mode = 'menu';
    this.reconnect = null;
    this.relayJoin = null;
    this.succ = null;
    this.backups.reset();
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
          const rj = this.relayJoin;
          if (rj) {
            rj.tries = 0;
            rj.wait = undefined;
            if (rj.note) { this.game.hud.notify(rj.note, 'info'); rj.note = undefined; }
          }
          this.menus.hide();
        } else {
          this.menus.loading(this.game.session.connected ? 'Building the islands…' : this.relayJoin?.wait ?? 'Waiting for server…', this.game.progress);
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

interface RelayJoin {
  code: string;
  tries: number;
  /** the world is moving to another player: wait longer for an answer */
  handoff?: boolean;
  /** loading-screen line while waiting for the host to answer */
  wait?: string;
  /** shown once we are back in the game */
  note?: string;
  /** host losses so far (stale takeover timers check it) */
  losses: number;
}
const newRelayJoin = (code: string): RelayJoin => ({ code, tries: 0, losses: 0 });

interface Coop {
  lobby: CoopLobby; code: string; gen: number; links: Map<number, RelayPeerLink>; nextId: number;
  succession: HostSuccession; stopTick: () => void;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const safeGen = (g: unknown) => (Number.isSafeInteger(g) && (g as number) >= 0 && (g as number) < 1e6 ? (g as number) : 0);
const cleanName = (s: unknown) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, '').slice(0, 24);

/** validate the host's takeover order (it is still data from another page) */
function cleanSuccession(m: Extract<RelayMsg, { t: 'succession' }>): SuccessionInfo | null {
  if (typeof m.code !== 'string' || !/^[a-z0-9]{6}$/.test(m.code) || !Array.isArray(m.names)) return null;
  const names = m.names.slice(0, 8).map(cleanName);
  const rank = m.rank === null ? null : Number.isSafeInteger(m.rank) && m.rank >= 0 && m.rank < names.length ? m.rank : null;
  return { t: 'succession', code: m.code, gen: safeGen(m.gen), host: cleanName(m.host) || 'the host', rank, names };
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
