/**
 * Watercraft: server-authoritative 2.5D boat physics on the shared wave field.
 * Driver input arrives through the normal input stream (Simulation.vehicleInputs).
 */
import { VEHICLES } from '../defs/vehicles';
import { clamp, wrapAngle } from '../math/vec';
import type { PlayerState, VehicleState } from '../state';
import type { Simulation } from './simulation';

export function vehicleForward(yaw: number): [number, number] { return [-Math.sin(yaw), -Math.cos(yaw)]; }

/** world position of a seat */
export function seatWorld(v: VehicleState, seat: number): { x: number; y: number; z: number } {
  return seatPosition(v.type, v.x, v.y, v.z, v.yaw, seat);
}

export function seatPosition(type: string, x: number, y: number, z: number, yaw: number, seat: number): { x: number; y: number; z: number } {
  const def = VEHICLES[type]!;
  const s = def.seats[seat] ?? def.seats[0]!;
  const c = Math.cos(yaw), n = Math.sin(yaw);
  return { x: x + c * s.x + n * s.z, y: y + def.deckHeight, z: z - n * s.x + c * s.z };
}

export function createVehicle(sim: Simulation, type: string, x: number, z: number, yaw: number, owner: string): VehicleState {
  const def = VEHICLES[type]!;
  const id = sim.newId('v');
  const box = sim.createContainer('cargo', def.cargoSlots, x, 0, z, { label: def.name });
  const v: VehicleState = {
    id, type, x, y: sim.waterLevel(x, z), z, yaw, pitch: 0, roll: 0, vx: 0, vz: 0, yawRate: 0, hp: def.maxHp,
    anchored: false, sail: false, seats: def.seats.map(() => null), containerId: box.id, grounded: false, owner,
  };
  sim.world.vehicles[id] = v;
  return v;
}

export function boardVehicle(sim: Simulation, v: VehicleState, p: PlayerState): { ok: boolean; reason?: string } {
  if (p.vehicleId) return { ok: false, reason: 'Already aboard' };
  const def = VEHICLES[v.type]!;
  if (Math.hypot(v.x - p.pos.x, v.z - p.pos.z) > Math.max(def.deck[0], def.deck[1]) + 3) return { ok: false, reason: 'Too far away' };
  // driver seat first if free, else first free passenger seat
  const seat = v.seats.findIndex((s) => s === null);
  if (seat < 0) return { ok: false, reason: 'No free seats' };
  v.seats[seat] = p.id;
  p.vehicleId = v.id;
  p.seat = seat;
  p.fishing = null;
  const sp = seatWorld(v, seat);
  p.pos = { ...sp };
  p.vel = { x: 0, y: 0, z: 0 };
  p.swimming = false;
  p.underwater = false;
  sim.markPlayer(p.id);
  sim.milestone(p, 'boarded_vehicle', seat === 0 ? 'You take the helm. W/S paddle, A/D steer, Space to disembark.' : undefined);
  return { ok: true };
}

export function damageVehicle(sim: Simulation, v: VehicleState, amount: number, cause: string): void {
  v.hp -= amount;
  sim.fx('vehicle_hit', v.x, v.y, v.z, cause, amount);
  if (v.hp <= 0) {
    // sink: eject everyone, float the cargo
    for (const pid of v.seats) {
      const p = pid ? sim.world.players[pid] : undefined;
      if (p) { sim.leaveVehicle(p); sim.notify(p.id, 'Your boat broke apart!', 'bad'); }
    }
    const box = sim.world.containers[v.containerId];
    if (box) {
      box.x = v.x; box.z = v.z; box.y = v.y;
      sim.removeContainer(box.id, true);
    }
    sim.spawnItem({ id: 'log', qty: 2 }, v.x, v.y, v.z);
    delete sim.world.vehicles[v.id];
    sim.fx('vehicle_sink', v.x, v.y, v.z);
  }
}

export function tickVehicles(sim: Simulation, dt: number): void {
  const w = sim.world.weather;
  const vlist = Object.values(sim.world.vehicles);
  for (const v of vlist) {
    const def = VEHICLES[v.type];
    if (!def) continue;
    const driverId = v.seats[0];
    const driver = driverId ? sim.world.players[driverId] : undefined;
    const inp = driver && driver.connected ? sim.vehicleInputs.get(v.id) : undefined;
    const [fx, fz] = vehicleForward(v.yaw);
    let ax = 0, az = 0;
    if (v.anchored) {
      v.vx *= Math.exp(-3 * dt); v.vz *= Math.exp(-3 * dt); v.yawRate *= Math.exp(-3 * dt);
    } else {
      if (inp) {
        const thrust = (def.paddleForce * clamp(inp.mz, -0.5, 1)) / def.mass;
        ax += fx * thrust; az += fz * thrust;
        const speed = Math.hypot(v.vx, v.vz);
        const steer = -clamp(inp.mx, -1, 1) * def.turnRate * (0.35 + Math.min(1, speed / 3) * 0.65);
        v.yawRate += (steer - v.yawRate) * Math.min(1, dt * 2.5);
      } else v.yawRate *= Math.exp(-1.5 * dt);
      if (v.sail && def.sailForce > 0) {
        const wx = Math.cos(w.windDir), wz = Math.sin(w.windDir);
        const eff = Math.max(0.18, (fx * wx + fz * wz) * 0.5 + 0.5);
        const f = (def.sailForce * w.wind * eff) / def.mass;
        ax += fx * f; az += fz * f;
      }
      // wind drift for everything on the water
      ax += Math.cos(w.windDir) * w.wind * 0.12; az += Math.sin(w.windDir) * w.wind * 0.12;
    }
    v.vx += ax * dt; v.vz += az * dt;
    // keel: kill lateral motion, drag forward motion
    const fwd = v.vx * fx + v.vz * fz;
    const latx = v.vx - fx * fwd, latz = v.vz - fz * fwd;
    const lat = Math.exp(-4 * dt), lon = Math.exp(-def.drag * dt);
    v.vx = fx * fwd * lon + latx * lat;
    v.vz = fz * fwd * lon + latz * lat;
    const sp = Math.hypot(v.vx, v.vz);
    const max = def.maxSpeed * (v.sail ? 1 : def.sailForce > 0 ? 0.45 : 1);
    if (sp > max) { v.vx *= max / sp; v.vz *= max / sp; }
    v.yaw = wrapAngle(v.yaw + v.yawRate * dt);

    let nx = v.x + v.vx * dt, nz = v.z + v.vz * dt;
    // grounding
    const depth = -sim.gen.heightAt(nx, nz);
    v.grounded = false;
    if (depth < def.draft + 0.1) {
      const impact = Math.hypot(v.vx, v.vz);
      if (impact > 2.5) damageVehicle(sim, v, (impact - 2.5) * 15, 'reef');
      v.grounded = true;
      nx = v.x; nz = v.z;
      v.vx *= -0.2; v.vz *= -0.2;
    }
    // vehicle-vehicle separation
    for (const o of vlist) {
      if (o === v) continue;
      const dx = nx - o.x, dz = nz - o.z;
      const d = Math.hypot(dx, dz);
      const min = 3;
      if (d < min && d > 1e-4) { nx = o.x + (dx / d) * min; nz = o.z + (dz / d) * min; }
    }
    v.x = nx; v.z = nz;
    // buoyancy from 4 sample points
    const c = Math.cos(v.yaw), n = Math.sin(v.yaw);
    const [hx, hz] = def.deck;
    const samp = (lx: number, lz: number) => sim.waterLevel(v.x + c * lx + n * lz, v.z - n * lx + c * lz);
    const hf = samp(0, -hz), hb = samp(0, hz), hl = samp(-hx, 0), hr = samp(hx, 0);
    const target = (hf + hb + hl + hr) / 4 + 0.05;
    v.y += (target - v.y) * Math.min(1, dt * 4);
    v.pitch += (Math.atan2(hf - hb, hz * 2) - v.pitch) * Math.min(1, dt * 3);
    v.roll += (Math.atan2(hr - hl, hx * 2) - v.roll) * Math.min(1, dt * 3);
    if (w.waves > 2 && !v.anchored && sim.rng.chance(dt * 0.02)) damageVehicle(sim, v, 5, 'storm');
    if (!sim.world.vehicles[v.id]) continue;
    // carry seated players
    for (let i = 0; i < v.seats.length; i++) {
      const pid = v.seats[i];
      if (!pid) continue;
      const p = sim.world.players[pid];
      if (!p || !p.connected || p.dead || p.vehicleId !== v.id) { v.seats[i] = null; continue; }
      const sp2 = seatWorld(v, i);
      const prev = p.pos;
      p.stats.distance += Math.hypot(sp2.x - prev.x, sp2.z - prev.z);
      p.pos = sp2;
      p.vel = { x: v.vx, y: 0, z: v.vz };
      p.onGround = true; p.swimming = false; p.underwater = false;
    }
    const box = sim.world.containers[v.containerId];
    if (box) { box.x = v.x; box.y = v.y; box.z = v.z; }
  }
}
