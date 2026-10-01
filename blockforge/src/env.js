// Day/night cycle, sky and fog colours, weather tinting.
import { DAY_TICKS } from './constants.js';
import { smoothstep, lerp } from './math.js';

const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

const DAY_ZENITH = [0.36, 0.58, 0.98], DAY_HORIZON = [0.70, 0.83, 1.0];
const NIGHT_ZENITH = [0.008, 0.012, 0.035], NIGHT_HORIZON = [0.035, 0.045, 0.09];
const RAIN_TINT = [0.42, 0.45, 0.5];
const SUNSET = [1.0, 0.42, 0.14];

// dayTime: 0 sunrise, 6000 noon, 12000 sunset, 18000 midnight.
export function sunDirection(dayTime) {
  const a = (dayTime / DAY_TICKS) * Math.PI * 2;
  const tilt = 0.32;
  return [Math.cos(a), Math.sin(a) * Math.cos(tilt), Math.sin(a) * Math.sin(tilt)];
}

// Daylight factor used for sky light, mob burning, spawn checks.
export function daylight(dayTime, rain = 0) {
  const e = sunDirection(dayTime)[1];
  const d = smoothstep(-0.18, 0.22, e);
  return d * (1 - rain * 0.25);
}

export function computeEnv(o, { dayTime, day, rain, thunder = 0, underwater, inLava, renderDist, gamma, flicker, blindness = 0, snow = false, dim = 'overworld', flash = 0, nightVision = 0 }) {
  const sd = sunDirection(dayTime);
  const e = sd[1];
  const dayF = smoothstep(-0.2, 0.25, e);
  let zenith = mix3(NIGHT_ZENITH, DAY_ZENITH, dayF);
  let horizon = mix3(NIGHT_HORIZON, DAY_HORIZON, dayF);
  if (rain > 0) {
    const r = rain * 0.75;
    const grey = RAIN_TINT.map((v) => v * (0.15 + 0.85 * dayF));
    zenith = mix3(zenith, grey, r);
    horizon = mix3(horizon, grey.map((v) => v * 1.08), r);
  }
  // sunrise / sunset glow strength
  const sunsetA = Math.pow(Math.max(0, 1 - Math.abs(e) / 0.38), 2) * (1 - rain * 0.8);

  o.sunDir = sd;
  o.zenith = zenith;
  o.fogColor = horizon;
  o.sunset = [SUNSET[0], SUNSET[1], SUNSET[2], sunsetA * 0.9];
  o.skyBright = (0.18 + 0.82 * dayF) * (1 - rain * 0.28);
  o.skyLightColor = mix3([0.62, 0.68, 1.0], [1.0, 0.98, 0.95], dayF);
  if (sunsetA > 0 && e > -0.1) o.skyLightColor = mix3(o.skyLightColor, [1.0, 0.82, 0.68], sunsetA * 0.5);
  o.stars = (1 - smoothstep(-0.25, 0.02, e)) * (1 - rain);
  o.day = dayF;
  o.rain = rain;
  o.moonPhase = ((day % 8) + 8) % 8 / 8;
  o.gamma = gamma;
  o.flicker = flicker;
  o.cloudColor = mix3([0.12, 0.13, 0.17], [1, 1, 1], dayF).map((v, i) => v * (1 - rain * 0.35) + (i === 0 ? sunsetA * 0.12 : 0));
  // stars rotate with the sun
  const a = (dayTime / DAY_TICKS) * Math.PI * 2;
  const c = Math.cos(a), s = Math.sin(a);
  o.celestial = new Float32Array([c, -s, 0, s, c, 0, 0, 0, 1]);

  const far = renderDist * 16;
  o.fogMode = 0;
  o.fogStart = far * 0.7;
  o.fogEnd = far;
  if (rain > 0) { o.fogStart *= 1 - rain * 0.35; }
  if (underwater) {
    o.fogMode = 1;
    const w = 0.3 + 0.7 * dayF;
    o.fogColor = [0.05 * w, 0.2 * w, 0.42 * w];
    o.fogStart = 0; o.fogEnd = 28;
  } else if (inLava) {
    o.fogMode = 1;
    o.fogColor = [0.7, 0.2, 0.02];
    o.fogStart = 0; o.fogEnd = 1.5;
  }
  // sun (or, more faintly, moon) shadows fade out around sunrise and sunset
  o.shadowStrength = dim === 'overworld'
    ? Math.max(smoothstep(0.05, 0.24, e), smoothstep(0.05, 0.24, -e) * 0.45) * (1 - rain * 0.85) : 0;
  o.ambient = [0.028, 0.028, 0.028];
  if (dim === 'underworld' && !underwater && !inLava) {
    o.fogMode = 1;
    o.fogColor = [0.24, 0.055, 0.035];
    o.zenith = o.fogColor;
    o.fogStart = 6; o.fogEnd = Math.min(far, 110);
    o.stars = 0; o.sunset = [0, 0, 0, 0]; o.day = 0; o.skyBright = 0;
    o.ambient = [0.25, 0.16, 0.13];
  } else if (dim === 'underworld') o.ambient = [0.25, 0.16, 0.13];
  o.skyMode = 0;
  if (dim === 'void') {
    o.ambient = [0.56, 0.52, 0.64];
    o.stars = 1; o.sunset = [0, 0, 0, 0]; o.day = 0; o.skyBright = 0; o.rain = 0;
    if (!underwater && !inLava) {
      o.skyMode = 1;
      o.fogColor = [0.07, 0.045, 0.1];
      o.zenith = [0.03, 0.015, 0.05];
      o.fogStart = far * 0.55; o.fogEnd = far;
    }
  }
  if (nightVision > 0) o.ambient = mix3(o.ambient, [0.78, 0.8, 0.86], nightVision);
  if (flash > 0 && dim === 'overworld') {
    o.fogColor = mix3(o.fogColor, [0.85, 0.87, 1], flash * 0.55);
    o.zenith = mix3(o.zenith, [0.8, 0.82, 1], flash * 0.5);
    o.skyBright = Math.min(1, o.skyBright + flash * 0.6);
  }
  if (blindness) { o.fogMode = 1; o.fogColor = [0, 0, 0]; o.fogStart = 0; o.fogEnd = 5; }
  void thunder; void snow;
  return o;
}
