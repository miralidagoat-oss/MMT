/**
 * Procedural audio engine (ASSET REPLACEMENT POINT: register decoded AudioBuffers in
 * `SoundBank.buffers` under the same ids to replace any synthesized sound).
 * Buses: master -> {music, sfx, ambient, ui}; underwater low-pass on world sound.
 */
import type { AudioSettings } from '../settings';

type Synth = (ctx: AudioContext, out: AudioNode, t: number, p: SoundParams) => void;
export interface SoundParams { pitch?: number; gain?: number; variant?: string }

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private buses!: Record<'music' | 'sfx' | 'ambient' | 'ui', GainNode>;
  private worldFilter!: BiquadFilterNode;
  private noiseBuf!: AudioBuffer;
  private brownBuf!: AudioBuffer;
  private amb: Record<string, { src: AudioBufferSourceNode; gain: GainNode; filter: BiquadFilterNode }> = {};
  private nextChirp = 0;
  private nextCricket = 0;
  private nextMusic = 20;
  private nextCrackle = 0;
  readonly buffers = new Map<string, AudioBuffer>(); // replacement assets
  private lastStep = 0;
  private synths: Record<string, Synth>;

  constructor(public settings: AudioSettings) {
    this.synths = this.makeSynths();
  }

  /** Must be called from a user gesture (browser autoplay policy). */
  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') void this.ctx.resume(); return; }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4;
    this.master = ctx.createGain();
    this.master.connect(comp).connect(ctx.destination);
    this.worldFilter = ctx.createBiquadFilter();
    this.worldFilter.type = 'lowpass';
    this.worldFilter.frequency.value = 20000;
    this.worldFilter.connect(this.master);
    const bus = (to: AudioNode) => { const g = ctx.createGain(); g.connect(to); return g; };
    this.buses = { music: bus(this.master), sfx: bus(this.worldFilter), ambient: bus(this.worldFilter), ui: bus(this.master) };
    this.noiseBuf = this.makeNoise(false);
    this.brownBuf = this.makeNoise(true);
    this.applySettings(this.settings);
    // ambience loops
    this.loop('ocean', this.brownBuf, 'lowpass', 500);
    this.loop('wind', this.noiseBuf, 'bandpass', 600);
    this.loop('rain', this.noiseBuf, 'highpass', 1800);
    this.loop('under', this.brownBuf, 'lowpass', 180);
    this.loop('surf', this.noiseBuf, 'bandpass', 900);
  }

  applySettings(s: AudioSettings) {
    this.settings = s;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(s.master, t, 0.05);
    this.buses.music.gain.setTargetAtTime(s.music, t, 0.05);
    this.buses.sfx.gain.setTargetAtTime(s.sfx, t, 0.05);
    this.buses.ambient.gain.setTargetAtTime(s.ambient, t, 0.05);
    this.buses.ui.gain.setTargetAtTime(s.ui, t, 0.05);
  }

  setFocused(focused: boolean) {
    if (!this.ctx) return;
    const v = !focused && this.settings.muteUnfocused ? 0 : this.settings.master;
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.2);
  }

  private makeNoise(brown: boolean): AudioBuffer {
    const ctx = this.ctx!;
    const len = ctx.sampleRate * 4;
    const b = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = b.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w;
    }
    return b;
  }

  private loop(name: string, buf: AudioBuffer, type: BiquadFilterType, freq: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    src.playbackRate.value = 0.9 + Math.random() * 0.2;
    const filter = ctx.createBiquadFilter();
    filter.type = type; filter.frequency.value = freq; filter.Q.value = type === 'bandpass' ? 0.6 : 0.7;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(this.buses.ambient);
    src.start();
    this.amb[name] = { src, gain, filter };
  }

  /** Per-frame ambience mix from the environment around the listener. */
  updateAmbience(e: { shoreDist: number; altitude: number; wind: number; rain: number; underwater: boolean; daylight: number; nearFire: number; inJungle: boolean; time: number }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const set = (n: string, v: number, f?: number) => {
      const a = this.amb[n];
      if (!a) return;
      a.gain.gain.setTargetAtTime(v, t, 0.4);
      if (f) a.filter.frequency.setTargetAtTime(f, t, 0.4);
    };
    const shore = Math.max(0, 1 - e.shoreDist / 70);
    const swell = 0.6 + 0.4 * Math.sin(e.time * 0.45) * Math.sin(e.time * 0.17 + 1);
    if (e.underwater) {
      set('ocean', 0); set('surf', 0); set('wind', 0); set('rain', 0); set('under', 0.6);
      this.worldFilter.frequency.setTargetAtTime(700, t, 0.1);
    } else {
      this.worldFilter.frequency.setTargetAtTime(20000, t, 0.2);
      set('under', 0);
      set('ocean', (0.12 + 0.35 * shore) * (0.7 + 0.5 * swell) + e.wind * 0.1, 300 + 400 * swell);
      set('surf', shore * 0.12 * swell * swell, 700 + swell * 600);
      set('wind', 0.03 + e.wind * 0.22 + Math.max(0, e.altitude - 10) * 0.004, 400 + e.wind * 900 + Math.sin(e.time * 0.3) * 150);
      set('rain', e.rain * 0.32);
    }
    // birds by day, crickets by night
    const now = this.ctx.currentTime;
    if (!e.underwater && e.rain < 0.5) {
      if (e.daylight > 0.4 && now > this.nextChirp && e.shoreDist > -1) {
        this.nextChirp = now + (e.inJungle ? 0.8 : 3) + Math.random() * 4;
        this.chirp((Math.random() - 0.5) * 2);
      }
      if (e.daylight < 0.25 && now > this.nextCricket) {
        this.nextCricket = now + 0.05 + Math.random() * 0.25;
        this.cricket();
      }
    }
    if (e.nearFire > 0 && now > this.nextCrackle) {
      this.nextCrackle = now + 0.04 + Math.random() * 0.2;
      this.crackle(e.nearFire);
    }
    if (now > this.nextMusic) { this.nextMusic = now + 150 + Math.random() * 180; this.music(e.daylight); }
  }

  setListener(x: number, y: number, z: number, fx: number, fz: number) {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    if (l.positionX) {
      const t = this.ctx.currentTime;
      l.positionX.setValueAtTime(x, t); l.positionY.setValueAtTime(y, t); l.positionZ.setValueAtTime(z, t);
      l.forwardX.setValueAtTime(fx, t); l.forwardY.setValueAtTime(0, t); l.forwardZ.setValueAtTime(fz, t);
      l.upX.setValueAtTime(0, t); l.upY.setValueAtTime(1, t); l.upZ.setValueAtTime(0, t);
    }
  }

  /** Play a sound; with `pos` it is spatialized in 3D. */
  play(id: string, p: SoundParams = {}, pos?: { x: number; y: number; z: number }, bus: 'sfx' | 'ui' = 'sfx') {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const ctx = this.ctx;
    let out: AudioNode = this.buses[bus];
    if (pos) {
      const pan = ctx.createPanner();
      pan.panningModel = 'HRTF';
      pan.distanceModel = 'inverse';
      pan.refDistance = 2; pan.maxDistance = 120; pan.rolloffFactor = 1.2;
      pan.positionX.value = pos.x; pan.positionY.value = pos.y; pan.positionZ.value = pos.z;
      pan.connect(out);
      out = pan;
    }
    const g = ctx.createGain();
    g.gain.value = p.gain ?? 1;
    g.connect(out);
    const buf = this.buffers.get(id);
    if (buf) {
      const s = ctx.createBufferSource();
      s.buffer = buf; s.playbackRate.value = p.pitch ?? 1;
      s.connect(g); s.start();
      return;
    }
    const synth = this.synths[id];
    if (synth) synth(ctx, g, ctx.currentTime, p);
  }

  footstep(surface: string, pos: { x: number; y: number; z: number }) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (now - this.lastStep < 0.12) return;
    this.lastStep = now;
    this.play('step', { variant: surface, pitch: 0.9 + Math.random() * 0.2, gain: 0.5 }, pos);
  }

  // ------------------------------------------------------------------ synthesis primitives
  private noise(ctx: AudioContext, out: AudioNode, t: number, dur: number, type: BiquadFilterType, freq: number, q: number, gain: number, attack = 0.005, freqEnd?: number) {
    const s = ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(out);
    s.start(t, Math.random() * 3);
    s.stop(t + dur + 0.05);
  }

  private tone(ctx: AudioContext, out: AudioNode, t: number, dur: number, type: OscillatorType, f0: number, f1: number, gain: number, attack = 0.005) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private chirp(pan: number) {
    const ctx = this.ctx!;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    p.connect(this.buses.ambient);
    const t = ctx.currentTime;
    const base = 2200 + Math.random() * 1800;
    const n = 2 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) this.tone(ctx, p, t + i * 0.09, 0.07, 'sine', base * (1 + Math.random() * 0.3), base * 0.8, 0.025);
  }

  private cricket() {
    const ctx = this.ctx!;
    const p = ctx.createStereoPanner();
    p.pan.value = Math.random() * 2 - 1;
    p.connect(this.buses.ambient);
    const t = ctx.currentTime;
    for (let i = 0; i < 3; i++) this.tone(ctx, p, t + i * 0.035, 0.02, 'sine', 4400, 4300, 0.008);
  }

  private crackle(strength: number) {
    const ctx = this.ctx!;
    this.noise(ctx, this.buses.ambient, ctx.currentTime, 0.03 + Math.random() * 0.05, 'highpass', 1500 + Math.random() * 3000, 1, 0.08 * strength);
  }

  private music(daylight: number) {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const scale = daylight > 0.5 ? [261.6, 293.7, 329.6, 392, 440, 523.3] : [220, 246.9, 261.6, 329.6, 392, 440];
    const rev = ctx.createConvolver();
    const len = ctx.sampleRate * 3;
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3); }
    rev.buffer = ir;
    rev.connect(this.buses.music);
    for (let bar = 0; bar < 8; bar++) {
      const chord = [0, 2, 4].map((k) => scale[(bar * 3 + k) % scale.length]! / 2);
      for (const f of chord) this.tone(ctx, rev, t + bar * 3, 3.4, 'triangle', f, f, 0.035, 0.8);
      for (let n = 0; n < 3; n++) if (Math.random() < 0.6) { const f = scale[Math.floor(Math.random() * scale.length)]!; this.tone(ctx, rev, t + bar * 3 + n, 1.2, 'sine', f * 2, f * 2, 0.04, 0.02); }
    }
  }

  private makeSynths(): Record<string, Synth> {
    return {
      step: (c, o, t, p) => {
        const v = p.variant ?? 'sand';
        if (v === 'water') this.noise(c, o, t, 0.25, 'bandpass', 900, 0.8, 0.35, 0.01);
        else if (v === 'wood') { this.tone(c, o, t, 0.08, 'sine', 180 * (p.pitch ?? 1), 90, 0.3); this.noise(c, o, t, 0.06, 'bandpass', 1500, 1, 0.12); }
        else if (v === 'rock') this.noise(c, o, t, 0.07, 'bandpass', 2400 * (p.pitch ?? 1), 1.5, 0.25);
        else if (v === 'grass') this.noise(c, o, t, 0.14, 'highpass', 2500, 0.7, 0.18, 0.02);
        else this.noise(c, o, t, 0.16, 'bandpass', 1100 * (p.pitch ?? 1), 0.6, 0.3, 0.02);
      },
      splash: (c, o, t, p) => { this.noise(c, o, t, 0.6 * (p.gain ?? 1), 'lowpass', 2500, 0.5, 0.6, 0.01, 400); this.noise(c, o, t + 0.05, 0.3, 'highpass', 3000, 0.5, 0.2); },
      swim: (c, o, t) => this.noise(c, o, t, 0.4, 'bandpass', 700, 0.6, 0.2, 0.08),
      chop: (c, o, t, p) => { this.tone(c, o, t, 0.12, 'triangle', 240 * (p.pitch ?? 1), 110, 0.5); this.noise(c, o, t, 0.1, 'bandpass', 1800, 2, 0.4); },
      mine: (c, o, t, p) => { this.tone(c, o, t, 0.25, 'square', 1400 * (p.pitch ?? 1), 1300, 0.08); this.noise(c, o, t, 0.12, 'highpass', 3500, 1, 0.45); },
      gather: (c, o, t) => this.noise(c, o, t, 0.25, 'highpass', 2200, 0.5, 0.25, 0.03),
      fell: (c, o, t) => { this.noise(c, o, t, 1.2, 'lowpass', 900, 0.7, 0.7, 0.05, 120); this.tone(c, o, t + 0.9, 0.5, 'sine', 70, 40, 0.6); },
      break_rock: (c, o, t) => { this.noise(c, o, t, 0.6, 'lowpass', 2000, 0.6, 0.6, 0.005, 300); },
      swing: (c, o, t) => this.noise(c, o, t, 0.18, 'bandpass', 1200, 0.8, 0.12, 0.05, 500),
      hit: (c, o, t) => { this.tone(c, o, t, 0.1, 'sine', 160, 60, 0.6); this.noise(c, o, t, 0.08, 'lowpass', 1200, 1, 0.4); },
      hurt: (c, o, t) => { this.tone(c, o, t, 0.25, 'sawtooth', 220, 130, 0.12, 0.01); this.noise(c, o, t, 0.15, 'lowpass', 900, 1, 0.3); },
      pickup: (c, o, t) => { this.tone(c, o, t, 0.08, 'sine', 700, 1100, 0.15); this.tone(c, o, t + 0.06, 0.1, 'sine', 1100, 1500, 0.1); },
      craft: (c, o, t) => { for (let i = 0; i < 3; i++) this.noise(c, o, t + i * 0.13, 0.08, 'bandpass', 1500 + i * 400, 2, 0.25); this.tone(c, o, t + 0.4, 0.25, 'sine', 880, 1320, 0.1); },
      build: (c, o, t) => { for (let i = 0; i < 2; i++) { this.tone(c, o, t + i * 0.18, 0.12, 'triangle', 300, 150, 0.45); this.noise(c, o, t + i * 0.18, 0.08, 'bandpass', 2000, 2, 0.3); } },
      demolish: (c, o, t) => this.noise(c, o, t, 0.8, 'lowpass', 1500, 0.6, 0.6, 0.01, 150),
      eat: (c, o, t) => { for (let i = 0; i < 3; i++) this.noise(c, o, t + i * 0.12, 0.07, 'bandpass', 900 + Math.random() * 600, 3, 0.3); },
      drink: (c, o, t) => { for (let i = 0; i < 3; i++) this.tone(c, o, t + i * 0.18, 0.12, 'sine', 300, 600, 0.15); },
      ignite: (c, o, t) => { this.noise(c, o, t, 0.9, 'bandpass', 600, 0.5, 0.5, 0.2, 2000); },
      fire_out: (c, o, t) => this.noise(c, o, t, 0.8, 'highpass', 3000, 0.5, 0.25, 0.01, 6000),
      door: (c, o, t) => { this.tone(c, o, t, 0.35, 'sawtooth', 110, 90, 0.05, 0.05); this.tone(c, o, t + 0.3, 0.1, 'sine', 140, 70, 0.4); },
      bow: (c, o, t) => { this.tone(c, o, t, 0.15, 'triangle', 180, 90, 0.35); this.noise(c, o, t, 0.2, 'bandpass', 2500, 1, 0.15, 0.01, 800); },
      thunder: (c, o, t) => { this.noise(c, o, t, 4.5, 'lowpass', 300, 0.5, 1.0, 0.05, 60); this.noise(c, o, t + 0.05, 1.5, 'lowpass', 900, 0.5, 0.5, 0.01, 100); },
      creature_boar: (c, o, t) => { this.tone(c, o, t, 0.35, 'sawtooth', 120, 80, 0.25, 0.03); this.noise(c, o, t, 0.3, 'bandpass', 500, 2, 0.3, 0.03); },
      creature_crab: (c, o, t) => { for (let i = 0; i < 4; i++) this.noise(c, o, t + i * 0.04, 0.02, 'highpass', 4000, 2, 0.15); },
      creature_snake: (c, o, t) => this.noise(c, o, t, 0.9, 'highpass', 5000, 1, 0.25, 0.1),
      creature_shark: (c, o, t) => { this.tone(c, o, t, 1.0, 'sine', 55, 45, 0.5, 0.3); },
      creature_gull: (c, o, t) => { for (let i = 0; i < 3; i++) this.tone(c, o, t + i * 0.2, 0.15, 'sawtooth', 1500, 900, 0.05, 0.02); },
      creature_die: (c, o, t) => this.tone(c, o, t, 0.6, 'sawtooth', 300, 60, 0.15, 0.02),
      bite: (c, o, t) => { this.noise(c, o, t, 0.15, 'bandpass', 1200, 2, 0.4); this.tone(c, o, t, 0.15, 'sine', 600, 300, 0.2); },
      catch: (c, o, t) => { this.noise(c, o, t, 0.4, 'lowpass', 2500, 0.6, 0.5, 0.01, 500); this.tone(c, o, t + 0.2, 0.3, 'sine', 660, 990, 0.15); },
      cast: (c, o, t) => this.noise(c, o, t, 0.4, 'bandpass', 2000, 1, 0.2, 0.05, 600),
      ui_click: (c, o, t) => this.tone(c, o, t, 0.05, 'sine', 900, 700, 0.15),
      ui_hover: (c, o, t) => this.tone(c, o, t, 0.03, 'sine', 1200, 1100, 0.04),
      ui_open: (c, o, t) => { this.noise(c, o, t, 0.15, 'bandpass', 1500, 1, 0.2, 0.02); },
      ui_close: (c, o, t) => { this.noise(c, o, t, 0.12, 'bandpass', 900, 1, 0.15, 0.02); },
      ui_error: (c, o, t) => { this.tone(c, o, t, 0.12, 'square', 220, 200, 0.06); this.tone(c, o, t + 0.13, 0.14, 'square', 180, 160, 0.06); },
      notify: (c, o, t) => { this.tone(c, o, t, 0.25, 'sine', 784, 784, 0.1); this.tone(c, o, t + 0.12, 0.35, 'sine', 1046, 1046, 0.1); },
      milestone: (c, o, t) => { [523, 659, 784, 1046].forEach((f, i) => this.tone(c, o, t + i * 0.1, 0.5, 'triangle', f, f, 0.12)); },
      death: (c, o, t) => { [392, 349, 311, 262].forEach((f, i) => this.tone(c, o, t + i * 0.35, 0.8, 'triangle', f, f * 0.98, 0.15, 0.05)); },
      heartbeat: (c, o, t) => { this.tone(c, o, t, 0.12, 'sine', 60, 40, 0.6); this.tone(c, o, t + 0.18, 0.12, 'sine', 55, 40, 0.45); },
      gasp: (c, o, t) => this.noise(c, o, t, 0.5, 'bandpass', 1000, 1, 0.3, 0.05),
      paddle: (c, o, t) => this.noise(c, o, t, 0.45, 'bandpass', 600, 0.8, 0.25, 0.1),
      vehicle_hit: (c, o, t) => { this.tone(c, o, t, 0.3, 'triangle', 90, 50, 0.5); this.noise(c, o, t, 0.25, 'lowpass', 900, 1, 0.4); },
    };
  }
}
