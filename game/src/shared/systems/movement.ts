/**
 * First-person movement simulation. Runs identically on the server (authoritative)
 * and on the owning client (prediction + reconciliation). Pure function of
 * (state, input, environment) at a fixed step.
 */
import { PLAYER, SURVIVAL } from '../config';
import { clamp } from '../math/vec';
import type { CollisionWorld } from '../world/collision';

export interface InputFrame {
  seq: number;
  /** strafe (-1 left .. 1 right) */
  mx: number;
  /** forward (-1 back .. 1 forward) */
  mz: number;
  yaw: number;
  pitch: number;
  jump: boolean;
  sprint: boolean;
  crouch: boolean;
}

/** Subset of player state touched by movement (keeps prediction cheap to copy). */
export interface MoveState {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  yaw: number; pitch: number;
  onGround: boolean;
  crouching: boolean;
  sprinting: boolean;
  swimming: boolean;
  underwater: boolean;
  /** largest downward speed at the moment of landing this step (for fall damage) */
  landingSpeed: number;
}

export interface MoveEnv {
  col: CollisionWorld;
  /** water surface height at x,z (waves included) */
  waterLevel: (x: number, z: number) => number;
  /** stamina available — sprint/jump disabled when exhausted */
  canSprint: boolean;
  canJump: boolean;
  speedMul: number; // encumbrance / injuries
  swimMul: number;  // flippers etc
}

export function moveStateFrom(p: { pos: { x: number; y: number; z: number }; vel: { x: number; y: number; z: number }; yaw: number; pitch: number; onGround: boolean; crouching: boolean; sprinting: boolean; swimming: boolean; underwater: boolean }): MoveState {
  return {
    x: p.pos.x, y: p.pos.y, z: p.pos.z, vx: p.vel.x, vy: p.vel.y, vz: p.vel.z, yaw: p.yaw, pitch: p.pitch,
    onGround: p.onGround, crouching: p.crouching, sprinting: p.sprinting, swimming: p.swimming, underwater: p.underwater, landingSpeed: 0,
  };
}

export function sanitizeInput(f: InputFrame): InputFrame {
  const fin = (v: number) => (Number.isFinite(v) ? v : 0);
  return {
    seq: Math.floor(fin(f.seq)),
    mx: clamp(fin(f.mx), -1, 1),
    mz: clamp(fin(f.mz), -1, 1),
    yaw: fin(f.yaw) % (Math.PI * 2),
    pitch: clamp(fin(f.pitch), -1.55, 1.55),
    jump: !!f.jump, sprint: !!f.sprint, crouch: !!f.crouch,
  };
}

const SWIM_DEPTH = 1.25; // water depth above feet at which we start swimming
const FLOAT_OFFSET = 1.45; // feet sit this far below surface when floating

export function stepMovement(s: MoveState, inp: InputFrame, env: MoveEnv, dt: number): void {
  s.yaw = inp.yaw;
  s.pitch = inp.pitch;
  s.landingSpeed = 0;

  // input direction in world space (yaw 0 faces -Z)
  let ix = inp.mx, iz = inp.mz;
  const il = Math.hypot(ix, iz);
  if (il > 1) { ix /= il; iz /= il; }
  const sy = Math.sin(s.yaw), cy = Math.cos(s.yaw);
  const wx = ix * cy - iz * sy;
  const wz = -ix * sy - iz * cy;

  const surface = env.waterLevel(s.x, s.z);
  const depthAtFeet = surface - s.y;
  const terrainH = env.col.terrainHeight(s.x, s.z);
  const waterDepth = surface - terrainH;
  const wasSwimming = s.swimming;
  s.swimming = depthAtFeet > SWIM_DEPTH && waterDepth > SWIM_DEPTH - 0.1;
  const eyeY = s.y + (s.crouching ? PLAYER.crouchHeight : PLAYER.eyeHeight) - 0.08;
  s.underwater = eyeY < surface - 0.05;

  if (s.swimming) {
    s.crouching = false;
    const sprint = inp.sprint && env.canSprint && il > 0.1;
    s.sprinting = sprint;
    const speed = (sprint ? PLAYER.swimSprintSpeed : PLAYER.swimSpeed) * env.swimMul * env.speedMul;
    // vertical intent: jump = ascend, crouch = dive; looking down while moving forward also dives when submerged
    let vyTarget = 0;
    if (inp.jump) vyTarget = PLAYER.diveSpeed;
    else if (inp.crouch) vyTarget = -PLAYER.diveSpeed;
    else if (s.underwater && inp.mz > 0.2) vyTarget = Math.sin(inp.pitch) * PLAYER.diveSpeed * inp.mz;
    const floatY = surface - FLOAT_OFFSET;
    const atSurface = s.y >= floatY - 0.15;
    if (vyTarget === 0) {
      // buoyancy: gently drift to the floating height
      vyTarget = clamp((floatY - s.y) * 2.2, -1.2, 1.2);
    }
    if (atSurface && vyTarget > 0 && s.y > floatY) vyTarget = 0; // can't fly out of the water
    const a = PLAYER.waterAccel * dt;
    s.vx += clamp(wx * speed - s.vx, -a * speed, a * speed);
    s.vz += clamp(wz * speed - s.vz, -a * speed, a * speed);
    s.vy += clamp(vyTarget - s.vy, -a * 2, a * 2);
    s.onGround = false;
  } else {
    const wantCrouch = inp.crouch;
    s.crouching = wantCrouch;
    const sprint = inp.sprint && env.canSprint && !s.crouching && inp.mz > 0.1;
    s.sprinting = sprint && s.onGround;
    const wadeMul = depthAtFeet > 0.4 ? clamp(1 - (depthAtFeet - 0.4) * 0.45, 0.55, 1) : 1;
    const speed = (s.crouching ? PLAYER.crouchSpeed : sprint ? PLAYER.sprintSpeed : PLAYER.walkSpeed) * env.speedMul * wadeMul;
    const accel = (s.onGround ? PLAYER.groundAccel : PLAYER.airAccel) * dt;
    const tx = wx * speed, tz = wz * speed;
    const dvx = tx - s.vx, dvz = tz - s.vz;
    const dl = Math.hypot(dvx, dvz);
    if (dl > 0) {
      const m = Math.min(dl, accel);
      s.vx += (dvx / dl) * m;
      s.vz += (dvz / dl) * m;
    }
    if (s.onGround && inp.jump && env.canJump && !s.crouching) {
      s.vy = PLAYER.jumpVelocity;
      s.onGround = false;
    }
    s.vy -= PLAYER.gravity * dt;
    if (depthAtFeet > 0.2) s.vy *= 1 - Math.min(0.6, depthAtFeet * 0.15) * dt * 4; // water drag when wading
    if (wasSwimming && !s.swimming && inp.jump && depthAtFeet > 0.6) s.vy = Math.max(s.vy, 3.5); // climb out
  }

  // integrate horizontal with collision
  const height = s.crouching ? PLAYER.crouchHeight : PLAYER.height;
  let nx = s.x + s.vx * dt;
  let nz = s.z + s.vz * dt;
  const res = env.col.resolve(nx, s.y, nz, PLAYER.radius, height, PLAYER.stepHeight);
  // slope check: prevent walking up too-steep terrain
  if (!s.swimming) {
    const curG = env.col.ground(s.x, s.z, s.y + PLAYER.stepHeight);
    const newG = env.col.ground(res.x, res.z, s.y + PLAYER.stepHeight);
    const rise = newG.h - curG.h;
    const run = Math.hypot(res.x - s.x, res.z - s.z);
    if (!newG.onStructure && run > 1e-4 && rise / run > 1.6 && newG.h > s.y + 0.05) {
      // too steep: cancel movement into slope
      res.x = s.x; res.z = s.z;
      s.vx *= 0.2; s.vz *= 0.2;
    }
  }
  if (res.x !== nx || res.z !== nz) {
    // collision: remove velocity component into obstacle (approx: scale by achieved move)
    const ax = res.x - s.x, az = res.z - s.z;
    const want = Math.hypot(nx - s.x, nz - s.z);
    if (want > 1e-6) {
      const got = Math.hypot(ax, az);
      const f = got / want;
      s.vx *= f; s.vz *= f;
    }
  }
  nx = res.x; nz = res.z;

  // vertical
  let ny = s.y + s.vy * dt;
  if (ny + height > res.ceiling && s.vy > 0) { ny = res.ceiling - height; s.vy = 0; }
  const g = env.col.ground(nx, nz, Math.max(s.y, ny) + PLAYER.stepHeight, PLAYER.radius);
  if (ny <= g.h) {
    if (s.vy < 0) s.landingSpeed = -s.vy;
    ny = g.h;
    s.vy = 0;
    s.onGround = true;
  } else if (!s.swimming && s.onGround && ny - g.h < PLAYER.stepHeight && s.vy <= 0) {
    // stick to ground when walking down slopes/steps
    ny = g.h;
    s.vy = 0;
  } else {
    s.onGround = false;
  }
  if (s.swimming) {
    s.onGround = ny <= g.h + 0.01;
    // can't swim out above water surface
    const maxY = env.waterLevel(nx, nz) - FLOAT_OFFSET + 0.25;
    if (ny > maxY && depthAtFeet > SWIM_DEPTH) { ny = maxY; if (s.vy > 0) s.vy = 0; }
  }
  // landing in water never hurts
  if (s.landingSpeed > 0 && env.waterLevel(nx, nz) - ny > 0.8) s.landingSpeed = 0;

  s.x = nx; s.y = ny; s.z = nz;
}

/** Stamina cost per second for current movement mode. */
export function movementStaminaCost(s: MoveState): number {
  if (s.swimming) return s.sprinting ? SURVIVAL.swimSprintStaminaCost : SURVIVAL.swimStaminaCost * (Math.hypot(s.vx, s.vz) > 0.3 ? 1 : 0.3);
  if (s.sprinting && Math.hypot(s.vx, s.vz) > 1) return SURVIVAL.sprintStaminaCost;
  return 0;
}
