// Boot: build textures, create the renderer and systems, run the frame loop.
import { Renderer } from './renderer.js';
import { generateBlockTextures, generateItemTextures } from './textures.js';
import { generateSkins, SKIN } from './models.js';
import { SceneRenderer } from './scene.js';
import { Audio } from './audio.js';
import { Input } from './input.js';
import { UI } from './ui.js';
import { Game } from './game.js';
import { Storage } from './storage.js';
import { Icons } from './icons.js';
import { hashSeed } from './noise.js';
import { WorldGen } from './worldgen.js';
import { I } from './items.js';
import { B } from './blocks.js';
import { PRESETS, applyPreset, matchPreset, detectPreset, applyQuality } from './quality.js';

const VERSION = '1.0';
const SETTINGS_KEY = 'blockforge:settings';
const DEFAULTS = {
  renderDistance: 8, fov: 70, sensitivity: 100, renderScale: 100, guiScale: 0, brightness: 50,
  volume: 80, music: 45, bobbing: true, clouds: true, invertMouse: false, peaceful: false,
  ...PRESETS.balanced, graphics: 'balanced', maxFps: 0, playerName: '',
};

function loadSettings() {
  const s = { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) Object.assign(s, JSON.parse(raw));
  } catch { /* storage unavailable */ }
  return s;
}
function localStorage_has() { try { return !!localStorage.getItem(SETTINGS_KEY); } catch { return false; } }

function fatal(title, err) {
  const app = document.getElementById('app');
  const box = document.createElement('div');
  box.id = 'fatal';
  box.innerHTML = `<div><b>${title}</b><p>${err && err.message ? String(err.message).replace(/</g, '&lt;') : ''}</p><pre>${err && err.stack ? String(err.stack).replace(/</g, '&lt;') : ''}</pre></div>`;
  app.appendChild(box);
}

async function boot() {
  const settings = loadSettings();
  const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ } };
  const canvas = document.getElementById('game');
  let renderer;
  try {
    renderer = new Renderer(canvas);
  } catch (err) {
    fatal('Blockforge needs WebGL 2. Try an up-to-date Chrome, Edge, Firefox or Safari with hardware acceleration enabled.', err);
    return;
  }
  // first run: pick a graphics preset that suits this machine
  if (!localStorage_has()) applyPreset(settings, detectPreset(renderer.gpuName));
  else if (!settings.graphics || settings.graphics !== matchPreset(settings)) settings.graphics = matchPreset(settings);
  const blockTex = generateBlockTextures();
  const itemTex = generateItemTextures();
  const skins = generateSkins();
  renderer.setTextures(blockTex, itemTex, skins);
  const storage = await Storage.open();
  const audio = new Audio();
  const icons = new Icons(blockTex, itemTex);
  const scene = new SceneRenderer(renderer, blockTex, itemTex);

  let game;
  const app = {
    version: VERSION,
    newWorld: async ({ name, seed, mode }) => {
      const seedNum = seed ? (/^-?\d+$/.test(seed) ? (parseInt(seed, 10) | 0) : hashSeed(seed)) : (Math.random() * 4294967296) | 0;
      const now = Date.now();
      const meta = {
        id: 'w' + now.toString(36) + Math.floor(Math.random() * 1e6).toString(36),
        name, seed: seedNum, seedText: seed || String(seedNum), mode, created: now, lastPlayed: now,
      };
      await storage.saveWorld(meta);
      enterWorld(meta, true);
    },
    loadWorld: (meta) => enterWorld(meta, false),
    quit: async () => {
      ui.showLoading('Saving world', 1);
      await game.save();
      await startDemo();
      ui.showTitle();
    },
    applySettings: () => {
      applyQuality(settings, renderer, game);
      audio.setVolumes(settings.volume / 100, settings.music / 100);
      ui.applyGuiScale();
      saveSettings();
    },
  };

  const ui = new UI(document.getElementById('app'), { icons, settings, saveSettings, storage, app, playerSkin: skins[SKIN.PLAYER] });
  const input = new Input(canvas, {
    isPlaying: () => game && game.state === 'playing',
    onKey: (e) => ui.onKey(e),
    onUnlock: () => ui.onUnlock(),
    onLockError: () => {},
    onTouchAction: (a) => {
      if (a === 'pause') ui.pause();
      else if (a === 'inventory' && game.state === 'playing') ui.openScreen(game.player.creative ? 'creative' : 'inventory');
    },
  });
  game = new Game({ renderer, scene, audio, input, ui, storage, settings });
  ui.attach(game);
  app.applySettings();
  const unlockAudio = () => audio.unlock();
  document.addEventListener('pointerdown', unlockAudio);
  document.addEventListener('keydown', unlockAudio);

  let loadingSince = 0;
  async function enterWorld(meta, isNew) {
    ui.closeMenus();
    ui.lastLoadingText = null;
    ui.showLoading(isNew ? 'Generating terrain' : 'Loading world', 0);
    game.state = 'loading';
    await game.startWorld(meta);
    if (isNew && meta.mode === 'survival') {
      // nothing in the pockets, like any fresh start
    } else if (isNew && meta.mode === 'creative') {
      const starter = [B.grass, B.stone, B.oak_planks, B.oak_log, B.glass, B.torch, B.lamp, B.bricks, I.water_bucket];
      starter.forEach((id, i) => game.player.inventory.set(i, { id, count: id === I.water_bucket ? 1 : 64 }));
    }
    loadingSince = performance.now();
    input.showTouch(true);
  }

  async function startDemo() {
    input.showTouch(false);
    const seed = hashSeed('blockforge-panorama-7');
    game.state = 'title';
    await game.startWorld({ seed, mode: 'creative', dayTime: 2200 }, { demo: true });
    const s = new WorldGen(seed).findSpawn();
    game.demoCam = { x: s.x, y: Math.max(s.h + 14, 80), z: s.z };
  }

  function checkLoading() {
    const p = game.player;
    const r = Math.min(3, settings.renderDistance);
    const prog = game.world.loadProgress(p.x, p.z, r);
    ui.showLoading(ui.lastLoadingText || 'Building terrain', prog);
    if (prog >= 1 && game.resolveSpawn()) {
      game.state = 'playing';
      ui.closeMenus();
      game.last = performance.now();
      input.reset();
      input.requestLock();
      if (!ui.lastLoadingText) ui.message(`Welcome to Blockforge! Press T to chat, /help for commands.`, '#f2b33a');
      ui.lastLoadingText = null;
      if (performance.now() - loadingSince > 60000) console.warn('slow load');
    }
  }

  await startDemo();
  ui.showTitle();

  const save = () => { if (game.state !== 'title' && game.state !== 'loading') game.save(); };
  document.addEventListener('visibilitychange', () => { if (document.hidden) { save(); if (game.state === 'playing') ui.pause(); } });
  window.addEventListener('beforeunload', save);

  let crashed = false;
  let lastFrame = 0;
  const loop = (now) => {
    requestAnimationFrame(loop);
    if (crashed) return;
    // optional frame cap (0 = follow the display)
    if (settings.maxFps > 0 && now - lastFrame < 1000 / settings.maxFps - 1.5) return;
    lastFrame = now;
    try {
      game.frame(now);
      if (game.state === 'loading' && game.world) checkLoading();
    } catch (err) {
      crashed = true;
      console.error(err);
      fatal('Something went wrong while running the game.', err);
    }
  };
  requestAnimationFrame(loop);
  window.__blockforge = { game, ui, renderer, settings, B, I, quality: { applyPreset, PRESETS } };
}

boot().catch((err) => { console.error(err); fatal('Blockforge failed to start.', err); });
