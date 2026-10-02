/**
 * Day/night clock and weather Markov chain. Authoritative on the server, replicated
 * via snapshots; the client uses the same helpers to derive lighting.
 */
import { TIME, AMBIENT } from '../config';
import { Rng } from '../math/rng';
import { clamp, lerp } from '../math/vec';
import type { WeatherKind, WeatherState, WorldState } from '../state';
import type { SeaState } from '../world/ocean';

export interface WeatherParams { cloud: number; rain: number; wind: number; waves: number; fog: number; temp: number }

export const WEATHER_PARAMS: Record<WeatherKind, WeatherParams> = {
  clear: { cloud: 0.12, rain: 0, wind: 0.25, waves: 0.75, fog: 0, temp: 0 },
  cloudy: { cloud: 0.6, rain: 0, wind: 0.45, waves: 1.0, fog: 0.05, temp: -1.5 },
  rain: { cloud: 0.85, rain: 0.6, wind: 0.6, waves: 1.3, fog: 0.2, temp: AMBIENT.rainTempDelta },
  storm: { cloud: 1, rain: 1, wind: 1, waves: 2.3, fog: 0.35, temp: AMBIENT.stormTempDelta },
  fog: { cloud: 0.5, rain: 0, wind: 0.1, waves: 0.5, fog: 0.8, temp: -2 },
};

/** transition weights from -> to */
const TRANSITIONS: Record<WeatherKind, { value: WeatherKind; weight: number }[]> = {
  clear: [{ value: 'clear', weight: 4 }, { value: 'cloudy', weight: 4 }, { value: 'fog', weight: 1 }],
  cloudy: [{ value: 'clear', weight: 4 }, { value: 'rain', weight: 3 }, { value: 'cloudy', weight: 2 }, { value: 'storm', weight: 0.7 }],
  rain: [{ value: 'cloudy', weight: 4 }, { value: 'rain', weight: 1 }, { value: 'storm', weight: 1.2 }, { value: 'clear', weight: 1 }],
  storm: [{ value: 'rain', weight: 4 }, { value: 'cloudy', weight: 2 }],
  fog: [{ value: 'clear', weight: 3 }, { value: 'cloudy', weight: 2 }],
};

const DURATION: Record<WeatherKind, [number, number]> = {
  clear: [0.12, 0.3], cloudy: [0.06, 0.16], rain: [0.05, 0.12], storm: [0.04, 0.08], fog: [0.03, 0.06],
}; // in fractions of a day

export function initialWeather(rng: Rng): WeatherState {
  const dir = rng.range(0, Math.PI * 2);
  return {
    kind: 'clear', next: 'clear', blend: 1, changeAt: TIME.dayLengthSeconds * 0.2, transitionSeconds: 60,
    windDir: dir, windTarget: dir, ...pick(WEATHER_PARAMS.clear), lightningAt: 0,
  };
}

function pick(p: WeatherParams) {
  return { cloud: p.cloud, rain: p.rain, wind: p.wind, waves: p.waves, fog: p.fog };
}

export function forceWeather(w: WeatherState, kind: WeatherKind, now: number, rng: Rng): void {
  w.kind = blendedKind(w);
  w.next = kind;
  w.blend = 0;
  w.transitionSeconds = 45;
  const [a, b] = DURATION[kind];
  w.changeAt = now + rng.range(a, b) * TIME.dayLengthSeconds;
}

export function blendedKind(w: WeatherState): WeatherKind { return w.blend >= 0.5 ? w.next : w.kind; }

export function tickWeather(w: WeatherState, now: number, dt: number, rng: Rng, onLightning: () => void): void {
  if (now >= w.changeAt && w.blend >= 1) {
    w.kind = w.next;
    w.next = rng.weighted(TRANSITIONS[w.kind]);
    w.blend = 0;
    w.transitionSeconds = rng.range(60, 140);
    const [a, b] = DURATION[w.next];
    w.changeAt = now + rng.range(a, b) * TIME.dayLengthSeconds;
    w.windTarget = w.windDir + rng.range(-1, 1);
  }
  if (w.blend < 1) w.blend = Math.min(1, w.blend + dt / w.transitionSeconds);
  const A = WEATHER_PARAMS[w.kind], B = WEATHER_PARAMS[w.next];
  const t = w.blend;
  w.cloud = lerp(A.cloud, B.cloud, t);
  w.rain = lerp(A.rain, B.rain, t);
  w.wind = lerp(A.wind, B.wind, t);
  w.waves = lerp(A.waves, B.waves, t);
  w.fog = lerp(A.fog, B.fog, t);
  w.windDir += clamp(w.windTarget - w.windDir, -0.01 * dt, 0.01 * dt);
  if (w.rain > 0.85 && w.wind > 0.8 && rng.chance(dt * 0.06)) {
    w.lightningAt = now;
    onLightning();
  }
}

export function weatherTemp(w: WeatherState): number {
  const A = WEATHER_PARAMS[w.kind], B = WEATHER_PARAMS[w.next];
  return lerp(A.temp, B.temp, w.blend);
}

export function seaState(w: Pick<WeatherState, 'waves' | 'windDir'>): SeaState {
  return { amplitude: w.waves, windDir: w.windDir };
}

// ------------------------------------------------------------------ time
/** Hours [0,24) from world state. */
export function hourOf(world: Pick<WorldState, 'time' | 'dayOffset'>): number {
  const t = world.time + world.dayOffset;
  return ((t / TIME.dayLengthSeconds) * 24) % 24;
}

export function dayNumber(world: Pick<WorldState, 'time' | 'dayOffset'>): number {
  return Math.floor((world.time + world.dayOffset) / TIME.dayLengthSeconds) + 1;
}

/** 0 at night, 1 at full day; smooth around dawn/dusk. */
export function daylight(hour: number): number {
  const sun = Math.sin(((hour - 6) / 24) * Math.PI * 2);
  return clamp(sun * 2.2 + 0.25, 0, 1);
}

export function isNight(hour: number): boolean { return hour < 5.5 || hour > 19.5; }

/** Sun direction (unit vector) for a given hour: rises east (+X), sets west. */
export function sunDirection(hour: number): [number, number, number] {
  const a = ((hour - 6) / 24) * Math.PI * 2;
  const x = Math.cos(a), y = Math.sin(a);
  const tilt = 0.35;
  const l = Math.hypot(x, y, tilt);
  return [x / l, y / l, tilt / l];
}

export function ambientTemp(hour: number, w: WeatherState): number {
  const d = daylight(hour);
  return lerp(AMBIENT.nightTemp, AMBIENT.dayTemp, d) + weatherTemp(w);
}
