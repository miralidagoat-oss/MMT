/**
 * Input layer: keyboard + mouse (pointer lock) + gamepad mapped to named actions
 * through rebindable bindings. Gameplay reads `held()` / `pressed()` per frame.
 */
import type { ControlSettings } from '../settings';

export class Input {
  private down = new Set<string>();
  private justDown = new Set<string>();
  private justUp = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  locked = false;
  /** when true, game actions are suppressed (UI has focus) */
  uiCapture = false;
  private padPrev: boolean[] = [];
  padMove = { x: 0, y: 0 };
  padLook = { x: 0, y: 0 };
  usingGamepad = false;
  onAnyKey: ((code: string) => void) | null = null;
  /** when true, clicking the game canvas captures the mouse (and that click is swallowed) */
  autoLock = false;

  constructor(private canvas: HTMLElement, public controls: ControlSettings) {
    window.addEventListener('keydown', (e) => {
      if (this.onAnyKey) { e.preventDefault(); this.onAnyKey(e.code); return; }
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      if (!this.down.has(e.code)) this.justDown.add(e.code);
      this.down.add(e.code);
      this.usingGamepad = false;
    });
    window.addEventListener('keyup', (e) => { this.down.delete(e.code); this.justUp.add(e.code); });
    window.addEventListener('blur', () => { this.down.clear(); });
    canvas.addEventListener('mousedown', (e) => {
      const c = `Mouse${e.button}`;
      if (this.onAnyKey) { this.onAnyKey(c); return; }
      if (this.autoLock && !this.locked) { this.requestLock(); return; } // user gesture: lock, don't act
      if (!this.down.has(c)) this.justDown.add(c);
      this.down.add(c);
      this.usingGamepad = false;
    });
    window.addEventListener('mouseup', (e) => { const c = `Mouse${e.button}`; this.down.delete(c); this.justUp.add(c); });
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    canvas.addEventListener('wheel', (e) => { this.wheel += Math.sign(e.deltaY); }, { passive: true });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => { this.locked = document.pointerLockElement === canvas; });
  }

  requestLock(): void {
    if (!this.locked && document.pointerLockElement !== this.canvas) {
      try { const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined; p?.catch?.(() => {}); } catch { /* not allowed yet */ }
    }
  }

  releaseLock(): void { if (document.pointerLockElement) document.exitPointerLock(); }

  private codes(action: string): string[] { return this.controls.binds[action] ?? []; }

  held(action: string): boolean {
    if (this.uiCapture && action !== 'pause') return false;
    return this.codes(action).some((c) => this.down.has(c)) || this.padHeld(action);
  }

  pressed(action: string): boolean {
    if (this.uiCapture && !['pause', 'inventory', 'crafting', 'map', 'journal', 'build', 'players'].includes(action)) return false;
    return this.codes(action).some((c) => this.justDown.has(c)) || this.padPressed(action);
  }

  released(action: string): boolean { return this.codes(action).some((c) => this.justUp.has(c)); }

  keyPressed(code: string): boolean { return this.justDown.has(code); }

  /** call at end of frame */
  endFrame(): void {
    this.justDown.clear();
    this.justUp.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
  }

  // ------------------------------------------------------------------ gamepad (standard mapping)
  private pad(): Gamepad | null {
    const pads = navigator.getGamepads?.() ?? [];
    for (const p of pads) if (p && p.connected) return p;
    return null;
  }

  private static PAD_MAP: Record<string, number> = {
    jump: 0, interact: 2, crouch: 1, inventory: 3, primary: 7, secondary: 6, sprint: 10, crafting: 4, build: 5,
    pause: 9, map: 8, use: 11, rotate: 13,
  };

  pollGamepad(): void {
    const p = this.pad();
    if (!p) { this.padMove = { x: 0, y: 0 }; this.padLook = { x: 0, y: 0 }; return; }
    const dz = (v: number) => (Math.abs(v) < 0.15 ? 0 : (v - Math.sign(v) * 0.15) / 0.85);
    this.padMove = { x: dz(p.axes[0] ?? 0), y: dz(p.axes[1] ?? 0) };
    this.padLook = { x: dz(p.axes[2] ?? 0), y: dz(p.axes[3] ?? 0) };
    const now = p.buttons.map((b) => b.pressed);
    if (now.some(Boolean) || Math.abs(this.padMove.x) + Math.abs(this.padMove.y) + Math.abs(this.padLook.x) > 0) this.usingGamepad = true;
    this.padNow = now;
  }
  private padNow: boolean[] = [];

  /** call after reading pressed() for this frame */
  endPadFrame(): void { this.padPrev = this.padNow; }

  private padHeld(action: string): boolean {
    const i = Input.PAD_MAP[action];
    return i !== undefined && !!this.padNow[i];
  }

  private padPressed(action: string): boolean {
    const i = Input.PAD_MAP[action];
    return i !== undefined && !!this.padNow[i] && !this.padPrev[i];
  }

  padButtonPressed(i: number): boolean { return !!this.padNow[i] && !this.padPrev[i]; }
}

export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code === 'Mouse0') return 'LMB';
  if (code === 'Mouse1') return 'MMB';
  if (code === 'Mouse2') return 'RMB';
  if (code === 'ShiftLeft') return 'Shift';
  if (code === 'ControlLeft') return 'Ctrl';
  if (code === 'Space') return 'Space';
  if (code === 'Escape') return 'Esc';
  return code.replace('Arrow', '↑').replace('Left', '').replace('Right', '');
}
