// Synthesised sound effects and generative ambient music (WebAudio, no
// sample files). Audio starts on the first user gesture.
import { BLOCKS } from './blocks.js';

export class Audio {
  constructor() {
    this.ctx = null;
    this.volume = 0.8;
    this.musicVolume = 0.5;
    this.listener = { x: 0, y: 0, z: 0, yaw: 0 };
    this.nextMusic = 20;
    this.musicPlaying = false;
    this.rainGain = null;
  }

  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      const c = this.ctx;
      this.master = c.createGain(); this.master.gain.value = this.volume; this.master.connect(c.destination);
      this.sfx = c.createGain(); this.sfx.connect(this.master);
      this.music = c.createGain(); this.music.gain.value = this.musicVolume; this.music.connect(this.master);
      // noise buffer
      const len = c.sampleRate;
      this.noise = c.createBuffer(1, len, c.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      // reverb for music
      this.reverb = c.createConvolver();
      const ir = c.createBuffer(2, c.sampleRate * 3, c.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const b = ir.getChannelData(ch);
        for (let i = 0; i < b.length; i++) b[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / b.length, 3);
      }
      this.reverb.buffer = ir;
      const wet = c.createGain(); wet.gain.value = 0.45;
      this.reverb.connect(wet); wet.connect(this.music);
      // rain bed
      const rs = c.createBufferSource(); rs.buffer = this.noise; rs.loop = true;
      const rf = c.createBiquadFilter(); rf.type = 'bandpass'; rf.frequency.value = 2600; rf.Q.value = 0.4;
      this.rainGain = c.createGain(); this.rainGain.gain.value = 0;
      rs.connect(rf); rf.connect(this.rainGain); this.rainGain.connect(this.sfx);
      rs.start();
    } catch (err) {
      console.warn('audio unavailable', err);
      this.ctx = null;
    }
  }

  setVolumes(master, music) {
    this.volume = master; this.musicVolume = music;
    if (this.master) this.master.gain.value = master;
    if (this.music) this.music.gain.value = music;
  }

  setListener(x, y, z, yaw) { const l = this.listener; l.x = x; l.y = y; l.z = z; l.yaw = yaw; }

  // Output node with distance attenuation and stereo pan.
  out(x, y, z, vol = 1, range = 16) {
    const c = this.ctx;
    const g = c.createGain();
    let gain = vol;
    if (x !== undefined) {
      const l = this.listener;
      const dx = x - l.x, dy = y - l.y, dz = z - l.z;
      const d = Math.hypot(dx, dy, dz);
      gain *= Math.max(0, 1 - d / range);
      if (gain <= 0.001) return null;
      if (c.createStereoPanner && d > 0.5) {
        const p = c.createStereoPanner();
        const rx = Math.cos(l.yaw), rz = Math.sin(l.yaw);
        p.pan.value = Math.max(-1, Math.min(1, (dx * rx + dz * rz) / d)) * 0.8;
        g.connect(p); p.connect(this.sfx);
      } else g.connect(this.sfx);
    } else g.connect(this.sfx);
    g.gain.value = gain;
    return g;
  }

  burst(dest, t, dur, type, freq, q, vol, attack = 0.002) {
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = this.noise;
    src.loop = true; // the noise buffer is one second; longer bursts wrap around
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = c.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    src.connect(f); f.connect(g); g.connect(dest);
    src.start(t, Math.random() * 0.5, dur + 0.05);
  }

  tone(dest, t, dur, type, f0, f1, vol, attack = 0.004) {
    const c = this.ctx;
    const o = c.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g); g.connect(dest);
    o.start(t); o.stop(t + dur + 0.05);
    return o;
  }

  // Material voice: action is 'break' | 'place' | 'step' | 'hit'.
  material(mat, action, x, y, z) {
    if (!this.ctx) return;
    const scale = { break: 1, place: 0.8, step: 0.28, hit: 0.35 }[action] || 0.5;
    const dest = this.out(x, y, z, scale, action === 'step' ? 10 : 16);
    if (!dest) return;
    const t = this.ctx.currentTime + 0.001;
    const long = action === 'break' ? 1.6 : action === 'place' ? 1.1 : 0.7;
    const pitch = 0.85 + Math.random() * 0.3;
    switch (mat) {
      case 'stone':
        this.burst(dest, t, 0.09 * long, 'bandpass', 1700 * pitch, 1.2, 0.9);
        this.tone(dest, t, 0.07 * long, 'sine', 160 * pitch, 90, 0.5);
        if (action === 'break') this.burst(dest, t + 0.03, 0.12, 'bandpass', 900, 1, 0.5);
        break;
      case 'metal':
        for (const f of [880, 1320, 2150]) this.tone(dest, t, 0.35 * long, 'sine', f * pitch, f * pitch * 0.98, 0.16);
        this.burst(dest, t, 0.05, 'highpass', 3000, 0.7, 0.4);
        break;
      case 'wood':
        this.burst(dest, t, 0.08 * long, 'bandpass', 620 * pitch, 3.5, 1.1);
        this.tone(dest, t, 0.1 * long, 'triangle', 230 * pitch, 150 * pitch, 0.45);
        break;
      case 'grass':
        for (let i = 0; i < (action === 'break' ? 4 : 2); i++) this.burst(dest, t + i * 0.025, 0.05 * long, 'highpass', 2600 * pitch, 0.6, 0.55);
        break;
      case 'gravel':
        for (let i = 0; i < (action === 'break' ? 6 : 3); i++) this.burst(dest, t + i * 0.022 + Math.random() * 0.01, 0.035 * long, 'bandpass', 1100 * pitch + Math.random() * 400, 1.3, 0.7);
        break;
      case 'sand':
        this.burst(dest, t, 0.14 * long, 'lowpass', 1300 * pitch, 0.5, 0.6, 0.02);
        break;
      case 'snow':
        this.burst(dest, t, 0.12 * long, 'lowpass', 900 * pitch, 0.8, 0.6, 0.015);
        this.burst(dest, t + 0.03, 0.06, 'bandpass', 1800, 1, 0.2);
        break;
      case 'glass':
        if (action === 'break') {
          for (let i = 0; i < 7; i++) this.tone(dest, t + Math.random() * 0.08, 0.25 + Math.random() * 0.3, 'sine', 2200 + Math.random() * 3200, 0, 0.12);
          this.burst(dest, t, 0.3, 'highpass', 3500, 0.5, 0.7);
        } else this.burst(dest, t, 0.08, 'bandpass', 2400, 2, 0.6);
        break;
      case 'cloth':
      default:
        this.burst(dest, t, 0.1 * long, 'lowpass', 700 * pitch, 0.7, 0.8, 0.01);
    }
  }

  blockSound(id, action, x, y, z) {
    const b = BLOCKS[id];
    if (!b) return;
    this.material(b.sound, action, x, y, z);
  }

  play(name, x, y, z, vol = 1) {
    if (!this.ctx) return;
    const dest = this.out(x, y, z, vol, name === 'explode' ? 48 : name === 'thunder' ? 200 : name === 'portal_hum' ? 10 : name === 'firework' || name === 'horn' || name.startsWith('goat_horn') ? 96 : 16);
    if (!dest) return;
    const t = this.ctx.currentTime + 0.001;
    const r = () => 0.9 + Math.random() * 0.2;
    switch (name) {
      case 'pop':
        this.tone(dest, t, 0.08, 'sine', 500 * r(), 1300 * r(), 0.35);
        break;
      case 'click':
        this.tone(dest, t, 0.05, 'square', 900, 600, 0.12);
        this.burst(dest, t, 0.03, 'highpass', 4000, 0.7, 0.2);
        break;
      case 'hurt':
        this.tone(dest, t, 0.18, 'sawtooth', 210 * r(), 120, 0.25);
        this.burst(dest, t, 0.08, 'lowpass', 600, 0.8, 0.8);
        break;
      case 'land':
        this.burst(dest, t, 0.12, 'lowpass', 400, 0.8, 0.9);
        break;
      case 'splash':
        this.burst(dest, t, 0.45, 'lowpass', 1600 * r(), 0.6, 0.8, 0.01);
        this.burst(dest, t + 0.05, 0.3, 'bandpass', 3000, 1, 0.3);
        break;
      case 'swim':
        this.burst(dest, t, 0.25, 'lowpass', 900 * r(), 0.6, 0.35, 0.05);
        break;
      case 'fizz':
        this.burst(dest, t, 0.5, 'highpass', 3000, 0.4, 0.4, 0.01);
        break;
      case 'eat':
        for (let i = 0; i < 3; i++) this.burst(dest, t + i * 0.06, 0.05, 'bandpass', 1400 * r(), 1.5, 0.5);
        break;
      case 'burp':
        this.tone(dest, t, 0.35, 'sawtooth', 120, 80, 0.2);
        break;
      case 'shear':
        this.burst(dest, t, 0.04, 'highpass', 5000, 1, 0.6);
        this.burst(dest, t + 0.08, 0.04, 'highpass', 5000, 1, 0.6);
        break;
      case 'fuse':
        this.burst(dest, t, 1.2, 'highpass', 4000, 0.3, 0.35, 0.05);
        break;
      case 'explode': {
        this.burst(dest, t, 2.2, 'lowpass', 500, 0.5, 1.4, 0.005);
        this.tone(dest, t, 1.2, 'sine', 70, 30, 0.9);
        this.burst(dest, t, 0.4, 'bandpass', 1500, 0.5, 0.6);
        break;
      }
      case 'crit':
        this.burst(dest, t, 0.08, 'bandpass', 2500, 2, 0.5);
        break;
      case 'furnace':
        this.burst(dest, t, 0.6, 'lowpass', 500, 0.5, 0.25, 0.1);
        break;
      case 'chest_open':
        this.tone(dest, t, 0.25, 'triangle', 180, 260, 0.3);
        this.burst(dest, t, 0.2, 'bandpass', 700, 3, 0.4);
        break;
      case 'chest_close':
        this.tone(dest, t, 0.2, 'triangle', 240, 150, 0.3);
        this.burst(dest, t + 0.08, 0.1, 'bandpass', 500, 3, 0.6);
        break;
      case 'cave': {
        const o = this.tone(dest, t, 4, 'sine', 55 + Math.random() * 30, 40, 0.18, 1.2);
        void o;
        this.burst(dest, t, 4, 'lowpass', 300, 1, 0.25, 1.5);
        break;
      }
      case 'lava_pop':
        this.burst(dest, t, 0.08, 'bandpass', 700 * r(), 4, 0.5);
        break;
      case 'bow_draw':
        this.burst(dest, t, 0.5, 'bandpass', 900, 6, 0.25, 0.3);
        this.tone(dest, t, 0.5, 'triangle', 300, 420, 0.06, 0.3);
        break;
      case 'bow':
        this.tone(dest, t, 0.18, 'triangle', 520 * r(), 180, 0.35);
        this.burst(dest, t, 0.22, 'bandpass', 1800 * r(), 1.2, 0.5);
        break;
      case 'arrow_hit':
        this.burst(dest, t, 0.06, 'bandpass', 2400 * r(), 3, 0.6);
        this.tone(dest, t, 0.12, 'square', 190 * r(), 120, 0.12);
        break;
      case 'throw':
        this.burst(dest, t, 0.2, 'bandpass', 1300 * r(), 1.5, 0.35, 0.05);
        break;
      case 'ignite':
        this.burst(dest, t, 0.12, 'highpass', 3500, 0.8, 0.6);
        this.burst(dest, t + 0.05, 0.5, 'lowpass', 900, 0.6, 0.35, 0.05);
        break;
      case 'door_open':
        this.tone(dest, t, 0.35, 'sawtooth', 110 * r(), 160, 0.08, 0.05);
        this.burst(dest, t, 0.3, 'bandpass', 600 * r(), 5, 0.35, 0.04);
        break;
      case 'door_close':
        this.burst(dest, t, 0.12, 'lowpass', 500 * r(), 1, 0.9);
        this.tone(dest, t, 0.1, 'triangle', 140, 90, 0.25);
        break;
      case 'portal':
        this.tone(dest, t, 2.5, 'sine', 90, 480, 0.35, 0.8);
        this.tone(dest, t, 2.5, 'sine', 137, 720, 0.2, 0.8);
        this.burst(dest, t, 2.5, 'bandpass', 700, 0.8, 0.3, 1);
        break;
      case 'portal_hum':
        this.tone(dest, t, 1.1, 'sine', 70 + Math.random() * 10, 64, 0.2, 0.3);
        this.burst(dest, t, 1.1, 'bandpass', 380, 3, 0.12, 0.3);
        break;
      case 'thunder':
        this.burst(dest, t, 0.25, 'highpass', 1800, 0.5, 1.2);
        this.burst(dest, t + 0.05, 3.2, 'lowpass', 160, 0.7, 1.6, 0.08);
        this.burst(dest, t + 0.4, 2.4, 'lowpass', 90, 0.7, 1.2, 0.3);
        break;
      case 'orb': {
        const f = 1300 + Math.random() * 900;
        this.tone(dest, t, 0.12, 'sine', f, f * 1.08, 0.16);
        break;
      }
      case 'levelup':
        [523, 659, 784].forEach((f, i) => this.tone(dest, t + i * 0.07, 0.35, 'triangle', f, f, 0.2));
        break;
      case 'levelup_big':
        [392, 523, 659, 784, 1046].forEach((f, i) => this.tone(dest, t + i * 0.08, 0.6, 'triangle', f, f, 0.2));
        break;
      case 'advance':
        [659, 880, 1175].forEach((f, i) => this.tone(dest, t + i * 0.1, 0.5, 'sine', f, f, 0.18));
        this.tone(dest, t, 0.9, 'triangle', 329, 329, 0.1, 0.05);
        break;
      case 'enchant':
        for (let i = 0; i < 7; i++) { const f = 900 + Math.random() * 1400; this.tone(dest, t + i * 0.06, 0.4, 'sine', f, f * 1.5, 0.08); }
        break;
      case 'trade':
        this.tone(dest, t, 0.08, 'triangle', 1500, 1500, 0.15);
        this.tone(dest, t + 0.07, 0.15, 'triangle', 2000, 2000, 0.15);
        break;
      case 'piston_out':
        this.burst(dest, t, 0.12, 'lowpass', 700, 1, 0.8);
        this.tone(dest, t, 0.12, 'square', 160, 90, 0.12);
        break;
      case 'piston_in':
        this.burst(dest, t, 0.12, 'lowpass', 600, 1, 0.7);
        this.tone(dest, t, 0.12, 'square', 110, 160, 0.1);
        break;
      case 'cart_roll':
        this.burst(dest, t, 0.4, 'bandpass', 220 + Math.random() * 60, 4, 0.25, 0.05);
        break;
      case 'teleport':
        this.tone(dest, t, 0.35, 'sine', 900, 200, 0.25);
        this.tone(dest, t, 0.35, 'sine', 1300, 300, 0.12);
        this.burst(dest, t, 0.3, 'bandpass', 1200, 2, 0.2);
        break;
      case 'glass_break':
        for (let i = 0; i < 5; i++) this.tone(dest, t + i * 0.03, 0.15, 'triangle', 2500 + Math.random() * 2000, 1800, 0.08);
        this.burst(dest, t, 0.2, 'highpass', 4000, 0.7, 0.4);
        break;
      case 'void_burst':
        this.burst(dest, t, 0.8, 'lowpass', 800, 0.8, 0.8, 0.02);
        this.tone(dest, t, 0.6, 'sawtooth', 220, 60, 0.15);
        break;
      case 'milk':
        this.burst(dest, t, 0.4, 'lowpass', 900, 1, 0.4, 0.05);
        break;
      case 'shield_block':
        this.burst(dest, t, 0.08, 'lowpass', 600, 1, 1);
        this.tone(dest, t, 0.15, 'triangle', 180, 120, 0.3);
        break;
      case 'fish_cast':
        this.burst(dest, t, 0.3, 'bandpass', 2000, 2, 0.3, 0.05);
        break;
      case 'fish_bite':
        this.burst(dest, t, 0.25, 'lowpass', 1400, 1, 0.8);
        this.tone(dest, t, 0.1, 'sine', 600, 300, 0.2);
        break;
      case 'fish_reel':
        for (let i = 0; i < 4; i++) this.burst(dest, t + i * 0.05, 0.04, 'bandpass', 3000, 6, 0.3);
        break;
      case 'drink':
        this.tone(dest, t, 0.1, 'sine', 420 * r(), 300, 0.18);
        this.burst(dest, t, 0.1, 'lowpass', 800, 2, 0.25);
        break;
      case 'fire':
        for (let i = 0; i < 3; i++) this.burst(dest, t + Math.random() * 0.3, 0.05, 'bandpass', 1500 + Math.random() * 2500, 3, 0.25);
        this.burst(dest, t, 0.6, 'lowpass', 400, 0.8, 0.2, 0.1);
        break;
      case 'brew':
        for (let i = 0; i < 4; i++) this.tone(dest, t + i * 0.08, 0.12, 'sine', 300 + Math.random() * 400, 700, 0.1);
        break;
      case 'dispense':
        this.tone(dest, t, 0.06, 'square', 1000, 700, 0.12);
        this.burst(dest, t, 0.05, 'highpass', 3000, 0.7, 0.3);
        break;
      case 'gate_open':
        this.tone(dest, t, 3, 'sine', 110, 440, 0.3, 1);
        this.tone(dest, t, 3, 'sine', 165, 660, 0.2, 1);
        this.tone(dest, t + 0.5, 2.5, 'triangle', 330, 880, 0.12, 1);
        break;
      case 'eye_place':
        this.tone(dest, t, 0.4, 'sine', 880, 1320, 0.2);
        this.tone(dest, t + 0.05, 0.4, 'sine', 1320, 1760, 0.12);
        break;
      case 'page':
        this.burst(dest, t, 0.2, 'highpass', 2500, 0.5, 0.3, 0.03);
        break;
      case 'pick':
        this.burst(dest, t, 0.12, 'bandpass', 1400, 1.5, 0.5);
        this.tone(dest, t + 0.03, 0.06, 'sine', 700, 500, 0.2);
        break;
      case 'fill_bottle':
        for (let i = 0; i < 4; i++) this.tone(dest, t + i * 0.06, 0.08, 'sine', 380 + i * 140, 420 + i * 160, 0.18);
        this.burst(dest, t, 0.3, 'lowpass', 800, 1, 0.2, 0.02);
        break;
      case 'goat_horn0': case 'goat_horn1': case 'goat_horn2': case 'goat_horn3': {
        const k = +name.slice(-1);
        const c = this.ctx, f0 = [196, 220, 247, 175][k];
        for (const [m, v] of [[1, 0.45], [2, 0.18], [3, 0.08]]) {
          const o = c.createOscillator(); o.type = k === 3 ? 'square' : 'sawtooth';
          o.frequency.setValueAtTime(f0 * m * 0.94, t); o.frequency.linearRampToValueAtTime(f0 * m, t + 0.25);
          if (k === 1) o.frequency.setValueAtTime(f0 * m * 1.26, t + 1.1);
          if (k === 2) o.frequency.linearRampToValueAtTime(f0 * m * 0.8, t + 2.4);
          const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1100;
          const g = c.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v, t + 0.2); g.gain.setValueAtTime(v, t + 2.0); g.gain.exponentialRampToValueAtTime(0.001, t + 2.8);
          o.connect(lp); lp.connect(g); g.connect(dest); o.start(t); o.stop(t + 2.9);
        }
        break;
      }
      // round seven
      case 'wax':
        this.burst(dest, t, 0.25, 'bandpass', 2400 * r(), 1.5, 0.35, 0.02);
        this.tone(dest, t, 0.12, 'sine', 900 * r(), 1200 * r(), 0.08);
        break;
      case 'scrape':
        for (let i = 0; i < 3; i++) this.burst(dest, t + i * 0.07, 0.07, 'bandpass', (3200 + i * 500) * r(), 4, 0.3);
        break;
      case 'sculk_click':
        // a soft, wet clicking as the tendrils twitch
        for (let i = 0; i < 4; i++) this.burst(dest, t + i * 0.05, 0.03, 'bandpass', 900 * r(), 6, 0.35);
        this.tone(dest, t, 0.3, 'sine', 160 * r(), 120, 0.15);
        break;
      case 'shriek': {
        // a rising, hollow scream that hangs in the air
        const c = this.ctx;
        for (const [f, v] of [[420, 0.22], [633, 0.12], [1270, 0.05]]) {
          const o = c.createOscillator(); o.type = 'sawtooth';
          o.frequency.setValueAtTime(f * 0.7, t); o.frequency.exponentialRampToValueAtTime(f, t + 0.5); o.frequency.exponentialRampToValueAtTime(f * 0.92, t + 1.6);
          const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f * 1.5; bp.Q.value = 3;
          const gn = c.createGain(); gn.gain.setValueAtTime(0, t); gn.gain.linearRampToValueAtTime(v, t + 0.35); gn.gain.exponentialRampToValueAtTime(0.001, t + 1.8);
          o.connect(bp); bp.connect(gn); gn.connect(dest); o.start(t); o.stop(t + 1.9);
        }
        this.burst(dest, t, 1.2, 'highpass', 3000, 0.7, 0.08, 0.3);
        break;
      }
      case 'sculk_spread':
        this.burst(dest, t, 0.6, 'lowpass', 300 * r(), 1, 0.35, 0.1);
        for (let i = 0; i < 5; i++) this.burst(dest, t + 0.08 * i, 0.04, 'bandpass', 700 * r(), 5, 0.15);
        break;
      case 'horn': {
        // a low, wavering war horn
        const c = this.ctx;
        for (const [f, v] of [[110, 0.5], [165, 0.25], [220, 0.12]]) {
          const o = c.createOscillator(); o.type = 'sawtooth';
          o.frequency.setValueAtTime(f * 0.92, t); o.frequency.linearRampToValueAtTime(f, t + 0.4); o.frequency.setValueAtTime(f, t + 1.8); o.frequency.linearRampToValueAtTime(f * 0.85, t + 2.4);
          const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700;
          const g = c.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v, t + 0.3); g.gain.setValueAtTime(v, t + 1.9); g.gain.exponentialRampToValueAtTime(0.001, t + 2.6);
          o.connect(lp); lp.connect(g); g.connect(dest); o.start(t); o.stop(t + 2.7);
        }
        break;
      }
      case 'lead':
        this.burst(dest, t, 0.12, 'bandpass', 700, 1.5, 0.5);
        this.burst(dest, t + 0.06, 0.08, 'bandpass', 1100, 2, 0.3);
        break;
      case 'lead_snap':
        this.burst(dest, t, 0.08, 'highpass', 2500, 1, 0.8);
        this.tone(dest, t, 0.15, 'triangle', 400, 120, 0.3);
        break;
      case 'grind':
        this.burst(dest, t, 0.5, 'bandpass', 900, 0.8, 0.5, 0.05);
        this.burst(dest, t + 0.1, 0.4, 'highpass', 2600, 0.6, 0.25, 0.05);
        break;
      case 'craft':
        this.burst(dest, t, 0.08, 'lowpass', 500, 1, 0.9);
        this.burst(dest, t + 0.05, 0.05, 'highpass', 3000, 1, 0.4);
        break;
      case 'laser': {
        // a bright downward zap with a buzzy undertone
        this.tone(dest, t, 0.16, 'square', 1900 * r(), 260, 0.16);
        this.tone(dest, t, 0.2, 'sawtooth', 1200 * r(), 140, 0.12);
        this.tone(dest, t + 0.01, 0.1, 'sine', 3200, 900, 0.1);
        this.burst(dest, t, 0.06, 'highpass', 5000, 0.7, 0.18);
        break;
      }
      case 'laser_hit':
        this.burst(dest, t, 0.12, 'bandpass', 3000 * r(), 2, 0.4);
        this.tone(dest, t, 0.08, 'square', 700, 200, 0.08);
        break;
      case 'blaster_reload':
        this.tone(dest, t, 1.1, 'sawtooth', 120, 1400, 0.07, 0.05);
        this.tone(dest, t, 1.1, 'sine', 240, 2200, 0.08, 0.05);
        for (let i = 0; i < 3; i++) this.burst(dest, t + i * 0.12, 0.04, 'bandpass', 2200, 4, 0.2);
        break;
      case 'blaster_ready':
        this.tone(dest, t, 0.12, 'sine', 1320, 1320, 0.12);
        this.tone(dest, t + 0.08, 0.16, 'sine', 1760, 1760, 0.12);
        break;
      case 'blaster_empty':
        this.tone(dest, t, 0.05, 'square', 400, 300, 0.12);
        this.burst(dest, t, 0.03, 'highpass', 3500, 0.7, 0.25);
        break;
      case 'rocket':
        this.burst(dest, t, 0.9, 'bandpass', 1800, 0.7, 0.5, 0.02);
        this.tone(dest, t, 0.9, 'sawtooth', 300, 900, 0.05, 0.1);
        break;
      case 'firework': {
        this.burst(dest, t, 0.5, 'lowpass', 900, 0.8, 1.2);
        this.tone(dest, t, 0.3, 'sine', 90, 40, 0.5);
        for (let i = 0; i < 14; i++) this.burst(dest, t + 0.35 + Math.random() * 0.8, 0.04, 'highpass', 4000 + Math.random() * 3000, 1, 0.25);
        break;
      }
      default: break;
    }
  }

  mob(kind, action, x, y, z) {
    if (!this.ctx) return;
    const dest = this.out(x, y, z, 0.7, 20);
    if (!dest) return;
    const c = this.ctx, t = c.currentTime + 0.001;
    const hurt = action === 'hurt', death = action === 'death';
    const pitch = (hurt ? 1.25 : death ? 0.8 : 1) * (0.9 + Math.random() * 0.2);
    const voice = (type, f0, f1, dur, cutoff, q, vol, vib = 0) => {
      const o = c.createOscillator(); o.type = type;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f1, t + dur);
      if (vib) {
        const l = c.createOscillator(); l.frequency.value = vib;
        const lg = c.createGain(); lg.gain.value = f0 * 0.04;
        l.connect(lg); lg.connect(o.frequency); l.start(t); l.stop(t + dur + 0.05);
      }
      const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = cutoff; f.Q.value = q;
      const g = c.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.03);
      g.gain.setValueAtTime(vol, t + dur * 0.6);
      g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
      o.connect(f); f.connect(g); g.connect(dest);
      o.start(t); o.stop(t + dur + 0.05);
    };
    switch (kind) {
      case 'pig':
        voice('sawtooth', 140 * pitch, 100 * pitch, 0.22, 520, 2.5, 0.8, 18);
        if (!hurt) voice('square', 110 * pitch, 90 * pitch, 0.14, 380, 3, 0.4);
        break;
      case 'cow':
        voice('sawtooth', 105 * pitch, 82 * pitch, hurt ? 0.4 : 0.95, 520, 1.6, 0.8, 4);
        break;
      case 'sheep':
        voice('sawtooth', 230 * pitch, 200 * pitch, 0.55, 1100, 2, 0.6, 9);
        break;
      case 'chicken':
        for (let i = 0; i < (hurt ? 1 : 3); i++) this.tone(dest, t + i * 0.09, 0.07, 'triangle', 820 * pitch, 640 * pitch, 0.3);
        break;
      case 'settler':
        // a questioning hum, falling for "no"
        if (action === 'no') { voice('triangle', 190 * pitch, 130 * pitch, 0.3, 700, 1.5, 0.7, 6); break; }
        voice('triangle', 150 * pitch, 190 * pitch, hurt ? 0.2 : 0.35, 800, 1.5, 0.7, 6);
        voice('sawtooth', 150 * pitch, 190 * pitch, hurt ? 0.2 : 0.35, 1400, 3, 0.2);
        break;
      case 'archer':
        for (let i = 0; i < (death ? 6 : 3); i++) this.burst(dest, t + i * 0.07, 0.05, 'bandpass', (1300 + Math.random() * 800) * pitch, 6, 0.6);
        break;
      case 'crawler':
        this.burst(dest, t, hurt ? 0.25 : 0.5, 'highpass', 3000 * pitch, 1, 0.45, 0.05);
        for (let i = 0; i < 4; i++) this.burst(dest, t + i * 0.05, 0.03, 'bandpass', 2600 * pitch, 8, 0.35);
        break;
      case 'imp':
        voice('square', 330 * pitch, 520 * pitch, hurt ? 0.18 : 0.3, 1200, 2, 0.35, 22);
        this.burst(dest, t, 0.35, 'bandpass', 900, 1, 0.3, 0.05);
        break;
      case 'gloamer':
        // a low warbling hum
        voice('sine', 70 * pitch, 55 * pitch, death ? 1.4 : 0.8, 300, 1, 0.9, 7);
        voice('triangle', 140 * pitch, 92 * pitch, death ? 1.4 : 0.8, 600, 2, 0.4, 11);
        break;
      case 'wyrm':
        voice('sawtooth', 55 * pitch, 40 * pitch, death ? 3 : 1.6, 260, 0.8, 1.2, 4);
        voice('sawtooth', 82 * pitch, 50 * pitch, death ? 3 : 1.6, 520, 1.2, 0.6, 6);
        this.burst(dest, t, death ? 3 : 1.4, 'lowpass', 300, 0.6, 0.6, 0.2);
        break;
      case 'ghoul':
        voice('sawtooth', 78 * pitch, 58 * pitch, death ? 1.6 : 1.1, 420, 1.2, 0.9, 5);
        voice('sawtooth', 81 * pitch, 60 * pitch, death ? 1.6 : 1.1, 300, 1.5, 0.6, 3);
        break;
      case 'hound':
        if (action === 'growl') { voice('sawtooth', 90 * pitch, 80 * pitch, 0.7, 300, 1.5, 0.8, 30); break; }
        if (action === 'whine') { voice('sine', 700 * pitch, 520 * pitch, 0.5, 900, 2, 0.4, 6); break; }
        for (let i = 0; i < (hurt ? 1 : 2); i++) {
          this.tone(dest, t + i * 0.16, 0.09, 'square', 420 * pitch, 260 * pitch, 0.22);
          this.burst(dest, t + i * 0.16, 0.08, 'bandpass', 900 * pitch, 2, 0.5);
        }
        break;
      case 'steed':
        voice('sawtooth', 520 * pitch, 300 * pitch, hurt ? 0.35 : 1.0, 1300, 2, 0.6, 14);
        voice('square', 260 * pitch, 150 * pitch, hurt ? 0.35 : 1.0, 700, 2, 0.25, 9);
        break;
      case 'sentinel':
        this.tone(dest, t, death ? 1.2 : 0.4, 'triangle', 70 * pitch, 50 * pitch, 0.5);
        this.burst(dest, t, 0.25, 'bandpass', 2400, 4, 0.4);
        this.burst(dest, t + 0.08, 0.2, 'bandpass', 3400, 6, 0.25);
        break;
      case 'frost':
        this.burst(dest, t, 0.3, 'highpass', 2500, 0.8, 0.35, 0.03);
        break;
      case 'hexer':
        for (let i = 0; i < (death ? 5 : 3); i++) voice('triangle', (460 + (i % 2) * 140) * pitch, (420 + (i % 2) * 120) * pitch, 0.12, 1400, 2, 0.5);
        break;
      case 'warden':
        this.burst(dest, t, hurt ? 0.3 : 0.6, 'lowpass', 600 * pitch, 1.2, 0.6, 0.08);
        this.tone(dest, t, 0.25, 'sine', 300 * pitch, 180 * pitch, 0.3);
        break;
      case 'fox':
        // a short yip, or a thin scream when hurt
        if (hurt || death) { voice('sawtooth', 900 * pitch, 600 * pitch, 0.35, 1600, 3, 0.35, 18); break; }
        for (let i = 0; i < 2; i++) this.tone(dest, t + i * 0.12, 0.08, 'square', 700 * pitch, 520 * pitch, 0.12);
        break;
      case 'cat':
        if (action === 'purr') { voice('sawtooth', 48, 46, 1.1, 220, 1, 0.5, 22); break; }
        if (hurt || death) { voice('sawtooth', 700 * pitch, 900 * pitch, 0.3, 1800, 2, 0.4, 14); break; }
        voice('triangle', 520 * pitch, 760 * pitch, 0.18, 1400, 2.5, 0.5, 6);
        voice('triangle', 760 * pitch, 480 * pitch, 0.32, 1200, 2.5, 0.4, 6);
        break;
      case 'parrot':
        for (let i = 0; i < (hurt ? 1 : 3); i++) this.tone(dest, t + i * 0.07, 0.06, 'square', (1600 + Math.random() * 900) * pitch, (1100 + Math.random() * 700) * pitch, 0.1);
        break;
      case 'bee': {
        // a buzz, harsher when angry
        const f0 = action === 'angry' ? 260 : 190;
        voice('sawtooth', f0 * pitch, f0 * pitch * 1.05, hurt ? 0.25 : 0.6, 900, 1.5, action === 'angry' ? 0.35 : 0.18, 40);
        break;
      }
      case 'alpaca':
        if (action === 'spit') { this.burst(dest, t, 0.12, 'bandpass', 2200, 2, 0.5); break; }
        voice('sawtooth', 300 * pitch, 260 * pitch, hurt ? 0.25 : 0.45, 900, 2, 0.4, 9);
        voice('square', 150 * pitch, 140 * pitch, 0.2, 500, 2, 0.15);
        break;
      case 'dolphin':
        for (let i = 0; i < (hurt ? 2 : 5); i++) this.tone(dest, t + i * 0.05, 0.05, 'sine', (2400 + i * 300) * pitch, (2000 + i * 200) * pitch, 0.12);
        if (!hurt) voice('sine', 1800 * pitch, 3200 * pitch, 0.3, 2600, 2, 0.15, 30);
        break;
      case 'marauder':
        voice('sawtooth', 140 * pitch, 110 * pitch, hurt ? 0.2 : 0.5, 700, 1.6, 0.6, 5);
        voice('square', 210 * pitch, 160 * pitch, hurt ? 0.2 : 0.4, 1100, 2.5, 0.2);
        break;
      case 'rabbit':
        if (hurt || death) { voice('sine', 1400 * pitch, 900 * pitch, 0.2, 2000, 2, 0.35, 20); break; }
        this.burst(dest, t, 0.05, 'bandpass', 3000, 3, 0.15);
        break;
      case 'goat':
        if (action === 'ram') { this.burst(dest, t, 0.2, 'lowpass', 400, 1, 1); this.tone(dest, t, 0.15, 'sine', 120, 60, 0.6); break; }
        voice('sawtooth', 380 * pitch, 300 * pitch, hurt ? 0.3 : 0.6, 1300, 2, 0.5, 26);
        break;
      case 'turtle':
        voice('sine', 160 * pitch, 120 * pitch, 0.3, 500, 1.5, 0.4);
        break;
      case 'squid':
        this.burst(dest, t, 0.3, 'lowpass', 500 * pitch, 1, 0.4, 0.05);
        break;
      case 'frog':
        // a two-part croak
        for (let i = 0; i < 2; i++) voice('square', (180 - i * 30) * pitch, (150 - i * 30) * pitch, 0.14, 500, 3, 0.45, 40);
        break;
      case 'listener':
        if (action === 'heart') { this.tone(dest, t, 0.14, 'sine', 55, 40, 0.9); this.tone(dest, t + 0.2, 0.12, 'sine', 50, 38, 0.6); break; }
        if (action === 'sniff') { for (let i = 0; i < 3; i++) this.burst(dest, t + i * 0.16, 0.12, 'bandpass', 600, 2, 0.5, 0.03); break; }
        if (action === 'charge') { voice('sawtooth', 50, 160, 1.6, 400, 2, 0.8, 9); this.burst(dest, t, 1.6, 'lowpass', 200, 1, 0.5, 1.2); break; }
        if (action === 'boom') { this.burst(dest, t, 0.9, 'lowpass', 900, 0.8, 1.6, 0.005); this.tone(dest, t, 0.8, 'sine', 140, 35, 1.2); this.tone(dest, t, 0.5, 'square', 1800, 600, 0.12); break; }
        if (action === 'emerge' || action === 'dig') { this.burst(dest, t, 2.5, 'lowpass', 180, 1, 1.2, 0.4); voice('sawtooth', 40, 70, 2.2, 160, 1, 0.6, 3); break; }
        if (action === 'attack') { this.burst(dest, t, 0.25, 'lowpass', 300, 1, 1.4); voice('sawtooth', 90, 50, 0.3, 300, 1, 0.8); break; }
        voice('sawtooth', 70 * pitch, 50 * pitch, death ? 2.4 : hurt ? 0.4 : 1.1, 240, 1.2, 0.9, 4);
        this.burst(dest, t, death ? 2 : 0.6, 'lowpass', 260, 1, 0.5, 0.1);
        break;
      case 'camel':
        if (action === 'dash') { this.burst(dest, t, 0.3, 'lowpass', 500, 1, 0.6); voice('sawtooth', 220, 150, 0.35, 700, 2, 0.4); break; }
        voice('sawtooth', 150 * pitch, 110 * pitch, hurt ? 0.3 : 0.9, 500, 1.6, 0.55, 7);
        this.burst(dest, t + 0.1, 0.4, 'lowpass', 400, 1, 0.25, 0.05);
        break;
      case 'brute':
        voice('sawtooth', 60 * pitch, 45 * pitch, death ? 1.6 : 0.9, 260, 1, 1, 6);
        this.burst(dest, t, 0.5, 'lowpass', 220, 0.8, 0.8, 0.1);
        break;
      default: break;
    }
  }

  // Note blocks: 25 semitones from F#3, voiced by the block underneath.
  note(pitch, inst, x, y, z) {
    if (!this.ctx) return;
    const dest = this.out(x, y, z, 0.8, 48);
    if (!dest) return;
    const t = this.ctx.currentTime + 0.001;
    const f = 185 * Math.pow(2, pitch / 12);
    switch (inst) {
      case 'bass': this.tone(dest, t, 0.5, 'triangle', f / 4, f / 4, 0.6); this.tone(dest, t, 0.3, 'sine', f / 2, f / 2, 0.2); break;
      case 'drum': this.burst(dest, t, 0.25, 'lowpass', 160 + pitch * 10, 1, 1.2); this.tone(dest, t, 0.2, 'sine', 110 + pitch * 4, 50, 0.5); break;
      case 'snare': this.burst(dest, t, 0.18, 'bandpass', 1800 + pitch * 60, 1, 0.9); break;
      case 'click': this.burst(dest, t, 0.05, 'highpass', 5000 + pitch * 100, 2, 0.6); break;
      case 'bell': this.tone(dest, t, 1.4, 'sine', f * 2, f * 2, 0.35); this.tone(dest, t, 1.0, 'sine', f * 5.4, f * 5.4, 0.08); break;
      case 'guitar': this.tone(dest, t, 0.7, 'sawtooth', f, f, 0.12); this.tone(dest, t, 0.7, 'triangle', f / 2, f / 2, 0.2); break;
      case 'chime': this.tone(dest, t, 1.2, 'sine', f * 4, f * 4, 0.2); this.tone(dest, t, 0.8, 'sine', f * 6, f * 6, 0.08); break;
      default: this.tone(dest, t, 0.9, 'triangle', f, f, 0.35); this.tone(dest, t, 0.5, 'sine', f * 2, f * 2, 0.1);
    }
  }

  setRain(level) {
    if (this.rainGain) this.rainGain.gain.setTargetAtTime(level * 0.16, this.ctx.currentTime, 0.5);
  }

  // Generative ambient music: slow pentatonic phrases every few minutes.
  update(dt, enabled) {
    if (!this.ctx || !enabled || this.musicVolume <= 0) return;
    this.nextMusic -= dt;
    if (this.nextMusic > 0 || this.musicPlaying) return;
    this.playPiece();
  }

  playPiece() {
    const c = this.ctx;
    this.musicPlaying = true;
    const roots = [196, 220, 174.6, 246.9, 261.6];
    const root = roots[Math.floor(Math.random() * roots.length)];
    const scale = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21];
    let t = c.currentTime + 0.5;
    const bars = 10 + Math.floor(Math.random() * 8);
    const beat = 0.62 + Math.random() * 0.3;
    let deg = Math.floor(Math.random() * 5);
    for (let b = 0; b < bars; b++) {
      // bass note
      this.musicNote(root / 2 * Math.pow(2, scale[[0, 3, 4, 2][b % 4]] / 12), t, beat * 4, 0.12);
      for (let i = 0; i < 4; i++) {
        if (Math.random() < 0.3) continue;
        deg = Math.max(0, Math.min(scale.length - 1, deg + Math.floor(Math.random() * 5) - 2));
        const f = root * Math.pow(2, scale[deg] / 12);
        this.musicNote(f, t + i * beat + (Math.random() < 0.2 ? beat / 2 : 0), beat * 2.5, 0.1);
      }
      t += beat * 4;
    }
    const total = (t - c.currentTime) * 1000;
    setTimeout(() => {
      this.musicPlaying = false;
      this.nextMusic = 120 + Math.random() * 240;
    }, total + 4000);
  }

  // Soft mallet/piano-like voice.
  musicNote(freq, t, dur, vol) {
    const c = this.ctx;
    const g = c.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(vol * 0.3, t + 0.4);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2400;
    g.connect(lp); lp.connect(this.music); lp.connect(this.reverb);
    [[1, 1], [2, 0.35], [3, 0.12], [4.02, 0.05]].forEach(([m, a]) => {
      const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = freq * m;
      const og = c.createGain(); og.gain.value = a;
      o.connect(og); og.connect(g);
      o.start(t); o.stop(t + dur + 0.1);
    });
  }
}
