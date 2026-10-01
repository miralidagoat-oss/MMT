// Graphics presets and the video settings they control.

export const PRESETS = {
  performance: {
    renderDistance: 5, renderScale: 70, shadows: 0, bloom: false, aa: 'off', grading: false, waterFx: false,
    clouds: false, particles: 1, entityShadows: false, waving: false,
  },
  balanced: {
    renderDistance: 8, renderScale: 100, shadows: 0, bloom: true, aa: 'fxaa', grading: true, waterFx: true,
    clouds: true, particles: 2, entityShadows: true, waving: true,
  },
  fancy: {
    renderDistance: 12, renderScale: 100, shadows: 2, bloom: true, aa: 'msaa', grading: true, waterFx: true,
    clouds: true, particles: 2, entityShadows: true, waving: true,
  },
  ultra: {
    renderDistance: 18, renderScale: 100, shadows: 3, bloom: true, aa: 'msaa', grading: true, waterFx: true,
    clouds: true, particles: 2, entityShadows: true, waving: true,
  },
};

export const PRESET_NAMES = { performance: 'Performance', balanced: 'Balanced', fancy: 'Fancy', ultra: 'Ultra', custom: 'Custom' };
export const VIDEO_KEYS = Object.keys(PRESETS.balanced);

export function applyPreset(settings, name) {
  if (!PRESETS[name]) return;
  Object.assign(settings, PRESETS[name]);
  settings.graphics = name;
}

// Which preset the current values match, or 'custom'.
export function matchPreset(settings) {
  for (const [name, p] of Object.entries(PRESETS)) {
    if (VIDEO_KEYS.every((k) => settings[k] === p[k])) return name;
  }
  return 'custom';
}

// A sensible first preset for this device.
export function detectPreset(gpuName = '') {
  const soft = /swiftshader|llvmpipe|software|basic render/i.test(gpuName);
  const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const mem = (typeof navigator !== 'undefined' && navigator.deviceMemory) || 8;
  if (soft || mem <= 2) return 'performance';
  if (touch || mem <= 4) return 'balanced';
  return 'balanced';
}

// Push the video settings into the renderer and other systems.
export function applyQuality(settings, renderer, game) {
  renderer.renderScale = settings.renderScale / 100;
  const q = renderer.quality;
  q.shadows = settings.shadows | 0;
  q.bloom = !!settings.bloom;
  q.aa = settings.aa || 'off';
  q.grading = !!settings.grading;
  q.waterFx = !!settings.waterFx;
  q.waving = settings.waving !== false;
  if (game && game.particles) game.particles.density = [0.2, 0.5, 1][settings.particles ?? 2];
}
