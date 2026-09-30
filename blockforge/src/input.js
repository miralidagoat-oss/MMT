// Keyboard, mouse, pointer lock and touch input.

export const DEFAULT_KEYS = {
  forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD', jump: 'Space', sneak: 'ShiftLeft',
  sprint: 'ControlLeft', inventory: 'KeyE', drop: 'KeyQ', chat: 'KeyT', command: 'Slash',
  perspective: 'F5', debug: 'F3', hideHud: 'F1', screenshot: 'F2', pause: 'Escape',
};

export class Input {
  constructor(canvas, handlers) {
    this.canvas = canvas;
    this.h = handlers;
    this.keys = new Set();
    this.mouse = { left: false, right: false, middle: false };
    this.clicks = { left: 0, right: 0, middle: 0 };
    this.dx = 0; this.dy = 0; this.wheel = 0;
    this.locked = false;
    this.dragLook = false;
    this.lastTap = {};
    this.doubleTap = { forward: false, jump: false };
    this.bindings = { ...DEFAULT_KEYS };
    this.touch = { active: false, moveX: 0, moveY: 0, jump: false, sneak: false };
    this.enabled = true;

    document.addEventListener('keydown', (e) => this.onKeyDown(e));
    document.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.mouse.left = this.mouse.right = this.mouse.middle = false; });
    document.addEventListener('pointerlockchange', () => {
      const was = this.locked;
      this.locked = document.pointerLockElement === this.canvas;
      if (was && !this.locked && this.h.onUnlock) this.h.onUnlock();
    });
    document.addEventListener('pointerlockerror', () => {
      this.dragLook = true;
      if (this.h.onLockError) this.h.onLockError();
    });
    canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouse.left = false;
      else if (e.button === 2) this.mouse.right = false;
      else if (e.button === 1) this.mouse.middle = false;
    });
    document.addEventListener('mousemove', (e) => {
      if (this.locked || (this.dragLook && (e.buttons & 1 || e.buttons & 2) && this.h.isPlaying())) {
        this.dx += e.movementX || 0; this.dy += e.movementY || 0;
      }
    });
    canvas.addEventListener('wheel', (e) => {
      if (!this.h.isPlaying()) return;
      e.preventDefault();
      this.wheel += Math.sign(e.deltaY);
    }, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.setupTouch();
  }

  isDown(action) { return this.keys.has(this.bindings[action]) || (action === 'sneak' && this.keys.has('ShiftRight')) || (action === 'sprint' && this.keys.has('ControlRight')); }

  onKeyDown(e) {
    if (this.h.onKey && this.h.onKey(e) === true) { e.preventDefault(); return; }
    if (!this.h.isPlaying()) return;
    const code = e.code;
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'F1', 'F2', 'F3', 'F5', 'Slash'].includes(code) || (e.ctrlKey && ['KeyW', 'KeyS', 'KeyD', 'KeyQ'].includes(code))) e.preventDefault();
    if (e.repeat) return;
    this.keys.add(code);
    const now = performance.now();
    for (const [action, key] of [['forward', this.bindings.forward], ['jump', this.bindings.jump]]) {
      if (code === key) {
        if (now - (this.lastTap[action] || 0) < 280) this.doubleTap[action] = true;
        this.lastTap[action] = now;
      }
    }
  }

  onMouseDown(e) {
    if (this.h.onCanvasClick && this.h.onCanvasClick(e)) return;
    if (!this.h.isPlaying()) return;
    if (!this.locked && !this.dragLook) { this.requestLock(); return; }
    if (e.button === 0) { this.mouse.left = true; this.clicks.left++; }
    else if (e.button === 2) { this.mouse.right = true; this.clicks.right++; }
    else if (e.button === 1) { this.mouse.middle = true; this.clicks.middle++; e.preventDefault(); }
  }

  requestLock() {
    if (this.dragLook) return;
    try {
      const p = this.canvas.requestPointerLock && this.canvas.requestPointerLock();
      if (p && p.catch) p.catch(() => { this.dragLook = true; if (this.h.onLockError) this.h.onLockError(); });
      if (!this.canvas.requestPointerLock) this.dragLook = true;
    } catch {
      this.dragLook = true;
    }
  }

  exitLock() { if (document.pointerLockElement) document.exitPointerLock(); }

  consumeLook() { const r = [this.dx, this.dy]; this.dx = 0; this.dy = 0; return r; }
  consumeWheel() { const w = this.wheel; this.wheel = 0; return w; }
  consumeClicks() { const c = { ...this.clicks }; this.clicks.left = this.clicks.right = this.clicks.middle = 0; return c; }
  consumeDoubleTap(action) { const v = this.doubleTap[action]; this.doubleTap[action] = false; return v; }

  reset() {
    this.keys.clear();
    this.mouse.left = this.mouse.right = this.mouse.middle = false;
    this.consumeClicks(); this.consumeLook(); this.consumeWheel();
    this.doubleTap.forward = this.doubleTap.jump = false;
  }

  // Movement vector and actions for the player tick.
  movement() {
    let f = 0, s = 0;
    if (this.isDown('forward')) f += 1;
    if (this.isDown('back')) f -= 1;
    if (this.isDown('left')) s -= 1;
    if (this.isDown('right')) s += 1;
    if (this.touch.active) { f += -this.touch.moveY; s += this.touch.moveX; }
    return {
      forward: Math.max(-1, Math.min(1, f)), strafe: Math.max(-1, Math.min(1, s)),
      jump: this.isDown('jump') || this.touch.jump,
      sneak: this.isDown('sneak') || this.touch.sneak,
      sprint: this.isDown('sprint') || this.touch.sprint,
    };
  }

  // ---------------------------------------------------------------------------
  setupTouch() {
    const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    if (!isTouch) return;
    const root = document.createElement('div');
    root.id = 'touch';
    root.innerHTML = `
      <div class="t-stick" id="t-stick"><div class="t-knob" id="t-knob"></div></div>
      <button class="t-btn t-jump" id="t-jump" aria-label="Jump">▲</button>
      <button class="t-btn t-sneak" id="t-sneak" aria-label="Sneak">▼</button>
      <button class="t-btn t-inv" id="t-inv" aria-label="Inventory">⋯</button>
      <button class="t-btn t-pause" id="t-pause" aria-label="Pause">II</button>`;
    document.getElementById('app').appendChild(root);
    this.touchRoot = root;
    const stick = root.querySelector('#t-stick'), knob = root.querySelector('#t-knob');
    let stickId = null, cx = 0, cy = 0;
    stick.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0]; stickId = t.identifier;
      const r = stick.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2;
      this.touch.active = true; e.preventDefault();
    }, { passive: false });
    const moveStick = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== stickId) continue;
        let dx = (t.clientX - cx) / 50, dy = (t.clientY - cy) / 50;
        const l = Math.hypot(dx, dy); if (l > 1) { dx /= l; dy /= l; }
        this.touch.moveX = dx; this.touch.moveY = dy;
        this.touch.sprint = dy < -0.95;
        knob.style.transform = `translate(${dx * 40}px, ${dy * 40}px)`;
      }
    };
    const endStick = (e) => {
      for (const t of e.changedTouches) if (t.identifier === stickId) {
        stickId = null; this.touch.moveX = this.touch.moveY = 0; this.touch.sprint = false; knob.style.transform = '';
      }
    };
    stick.addEventListener('touchmove', moveStick, { passive: true });
    stick.addEventListener('touchend', endStick);
    stick.addEventListener('touchcancel', endStick);
    const hold = (id, key) => {
      const b = root.querySelector(id);
      b.addEventListener('touchstart', (e) => { this.touch[key] = true; if (key === 'jump') { const now = performance.now(); if (now - (this.lastTap.tj || 0) < 280) this.doubleTap.jump = true; this.lastTap.tj = now; } e.preventDefault(); }, { passive: false });
      b.addEventListener('touchend', () => { this.touch[key] = false; });
    };
    hold('#t-jump', 'jump');
    root.querySelector('#t-sneak').addEventListener('touchstart', (e) => { this.touch.sneak = !this.touch.sneak; e.target.classList.toggle('on', this.touch.sneak); e.preventDefault(); }, { passive: false });
    root.querySelector('#t-inv').addEventListener('touchstart', (e) => { e.preventDefault(); this.h.onTouchAction && this.h.onTouchAction('inventory'); }, { passive: false });
    root.querySelector('#t-pause').addEventListener('touchstart', (e) => { e.preventDefault(); this.h.onTouchAction && this.h.onTouchAction('pause'); }, { passive: false });

    // look + tap/hold on the canvas
    let lookId = null, lx = 0, ly = 0, startT = 0, moved = 0, holdTimer = null;
    this.canvas.addEventListener('touchstart', (e) => {
      if (!this.h.isPlaying()) return;
      const t = e.changedTouches[0];
      lookId = t.identifier; lx = t.clientX; ly = t.clientY; startT = performance.now(); moved = 0;
      this.dragLook = true;
      clearTimeout(holdTimer);
      holdTimer = setTimeout(() => { if (moved < 12) { this.mouse.left = true; this.clicks.left++; } }, 280);
      e.preventDefault();
    }, { passive: false });
    this.canvas.addEventListener('touchmove', (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== lookId) continue;
        const dx = t.clientX - lx, dy = t.clientY - ly;
        moved += Math.abs(dx) + Math.abs(dy);
        this.dx += dx * 2.2; this.dy += dy * 2.2;
        lx = t.clientX; ly = t.clientY;
      }
      e.preventDefault();
    }, { passive: false });
    const end = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== lookId) continue;
        clearTimeout(holdTimer);
        if (!this.mouse.left && moved < 12 && performance.now() - startT < 280) { this.clicks.right++; }
        this.mouse.left = false;
        lookId = null;
      }
    };
    this.canvas.addEventListener('touchend', end);
    this.canvas.addEventListener('touchcancel', end);
  }

  showTouch(v) { if (this.touchRoot) this.touchRoot.hidden = !v; }
}
