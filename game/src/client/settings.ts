/**
 * Player-local settings (graphics / audio / controls / gameplay), persisted in
 * localStorage. World rules (difficulty etc.) live in the save, not here.
 */
export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra' | 'insane' | 'custom';
export type AAMode = 'off' | 'fxaa' | 'smaa' | 'msaa';

export interface GraphicsSettings {
  preset: QualityPreset;
  /** 'native' or "WxH" internal render resolution */
  resolution: string;
  /** additional multiplier applied on top of resolution (dynamic res / supersampling) */
  renderScale: number;
  fullscreen: boolean;
  /** 0 = unlimited */
  fpsLimit: number;
  vsync: boolean;
  showFps: boolean;
  shadows: 0 | 1 | 2 | 3 | 4; // off, low, medium, high, ultra
  viewDistance: number; // meters
  terrainDetail: number; // 1..3
  vegetationDensity: number; // 0.25..1.5
  grassDensity: number; // 0..1.5
  waterQuality: 1 | 2 | 3;
  ambientOcclusion: boolean;
  bloom: boolean;
  antiAliasing: AAMode;
  anisotropy: number;
  postProcessing: boolean;
  godRays: boolean;
  fov: number;
  brightness: number;
  dynamicResolution: boolean;
}

export interface AudioSettings { master: number; music: number; sfx: number; ambient: number; ui: number; muteUnfocused: boolean }

export interface ControlSettings {
  sensitivity: number;
  invertY: boolean;
  gamepadSensitivity: number;
  toggleCrouch: boolean;
  toggleSprint: boolean;
  binds: Record<string, string[]>;
}

export interface GameplaySettings {
  name: string;
  color: string;
  hudScale: number;
  showTutorial: boolean;
  headBob: boolean;
  crosshair: boolean;
  showCoords: boolean;
  lastServer: string;
  recentServers: string[];
}

export interface Settings { graphics: GraphicsSettings; audio: AudioSettings; controls: ControlSettings; gameplay: GameplaySettings }

export const DEFAULT_BINDS: Record<string, string[]> = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  sprint: ['ShiftLeft'],
  crouch: ['KeyC', 'ControlLeft'],
  interact: ['KeyE'],
  primary: ['Mouse0'],
  secondary: ['Mouse2'],
  inventory: ['Tab', 'KeyI'],
  crafting: ['KeyQ'],
  build: ['KeyB'],
  map: ['KeyM'],
  journal: ['KeyJ'],
  drop: ['KeyG'],
  rotate: ['KeyR'],
  use: ['KeyF'],
  chat: ['Enter'],
  players: ['KeyP'],
  waypoint: ['KeyX'],
  pause: ['Escape'],
};

const PRESETS: Record<Exclude<QualityPreset, 'custom'>, Partial<GraphicsSettings>> = {
  low: { shadows: 1, viewDistance: 500, terrainDetail: 1, vegetationDensity: 0.4, grassDensity: 0, waterQuality: 1, ambientOcclusion: false, bloom: false, antiAliasing: 'fxaa', anisotropy: 1, postProcessing: true, godRays: false, renderScale: 0.85 },
  medium: { shadows: 2, viewDistance: 800, terrainDetail: 2, vegetationDensity: 0.7, grassDensity: 0.4, waterQuality: 2, ambientOcclusion: false, bloom: true, antiAliasing: 'fxaa', anisotropy: 4, postProcessing: true, godRays: false, renderScale: 1 },
  high: { shadows: 3, viewDistance: 1200, terrainDetail: 2, vegetationDensity: 1, grassDensity: 0.8, waterQuality: 3, ambientOcclusion: false, bloom: true, antiAliasing: 'smaa', anisotropy: 8, postProcessing: true, godRays: true, renderScale: 1 },
  ultra: { shadows: 4, viewDistance: 1800, terrainDetail: 3, vegetationDensity: 1.2, grassDensity: 1.1, waterQuality: 3, ambientOcclusion: true, bloom: true, antiAliasing: 'smaa', anisotropy: 16, postProcessing: true, godRays: true, renderScale: 1 },
  insane: { shadows: 4, viewDistance: 2600, terrainDetail: 3, vegetationDensity: 1.5, grassDensity: 1.5, waterQuality: 3, ambientOcclusion: true, bloom: true, antiAliasing: 'smaa', anisotropy: 16, postProcessing: true, godRays: true, renderScale: 1.25 },
};

export const RESOLUTIONS = ['native', '1280x720', '1366x768', '1600x900', '1920x1080', '2560x1440', '3440x1440', '3840x2160'];
export const FPS_LIMITS = [30, 60, 75, 90, 120, 144, 165, 240, 0];

export function applyPreset(g: GraphicsSettings, p: Exclude<QualityPreset, 'custom'>): void {
  Object.assign(g, PRESETS[p]);
  g.preset = p;
}

export function defaultSettings(): Settings {
  const g: GraphicsSettings = {
    preset: 'high', resolution: 'native', renderScale: 1, fullscreen: false, fpsLimit: 0, vsync: true, showFps: false,
    shadows: 3, viewDistance: 1200, terrainDetail: 2, vegetationDensity: 1, grassDensity: 0.8, waterQuality: 3, ambientOcclusion: false,
    bloom: true, antiAliasing: 'smaa', anisotropy: 8, postProcessing: true, godRays: true, fov: 75, brightness: 1, dynamicResolution: false,
  };
  return {
    graphics: g,
    audio: { master: 0.8, music: 0.35, sfx: 0.9, ambient: 0.8, ui: 0.6, muteUnfocused: true },
    controls: { sensitivity: 1, invertY: false, gamepadSensitivity: 1, toggleCrouch: false, toggleSprint: false, binds: structuredClone(DEFAULT_BINDS) },
    gameplay: {
      name: 'Castaway', color: SHIRTS[Math.floor(Math.random() * SHIRTS.length)]!, hudScale: 1, showTutorial: true, headBob: true, crosshair: true, showCoords: false,
      lastServer: '', recentServers: [],
    },
  };
}

const KEY = 'tidewake.settings.v1';
/** a random shirt for new players so friends are easy to tell apart */
const SHIRTS = ['#ff8a4a', '#4a9dff', '#e9d34a', '#5fcf73', '#c95fd6', '#ff5f6d', '#f2f2ea', '#3fc7c0'];

export function loadSettings(): Settings {
  const d = defaultSettings();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const s = JSON.parse(raw) as Partial<Settings>;
    return {
      graphics: { ...d.graphics, ...s.graphics },
      audio: { ...d.audio, ...s.audio },
      controls: { ...d.controls, ...s.controls, binds: { ...d.controls.binds, ...(s.controls?.binds ?? {}) } },
      gameplay: { ...d.gameplay, ...s.gameplay },
    };
  } catch {
    return d;
  }
}

export function saveSettings(s: Settings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}

/** Stable per-browser identity used to rejoin as the same survivor. */
export function identityToken(): string {
  const k = 'tidewake.identity';
  try {
    let t = localStorage.getItem(k);
    if (!t) {
      t = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem(k, t);
    }
    return t;
  } catch {
    return 'guest-' + Math.random().toString(36).slice(2, 12);
  }
}
