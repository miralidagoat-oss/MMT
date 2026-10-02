export interface VehicleDef {
  id: string;
  name: string;
  maxHp: number;
  /** deck half extents (x, z) */
  deck: [number, number];
  deckHeight: number;
  draft: number;
  mass: number;
  paddleForce: number;
  sailForce: number;
  maxSpeed: number;
  turnRate: number;
  drag: number;
  cargoSlots: number;
  seats: { x: number; z: number; driver: boolean }[];
}

export const VEHICLE_LIST: VehicleDef[] = [
  {
    id: 'log_raft', name: 'Log Raft', maxHp: 300, deck: [1.5, 2.1], deckHeight: 0.35, draft: 0.35, mass: 400,
    paddleForce: 1400, sailForce: 0, maxSpeed: 3.6, turnRate: 0.7, drag: 0.9, cargoSlots: 6,
    seats: [{ x: 0, z: 1.4, driver: true }, { x: -0.8, z: -0.4, driver: false }, { x: 0.8, z: -0.4, driver: false }, { x: 0, z: -1.4, driver: false }],
  },
  {
    id: 'outrigger', name: 'Outrigger Sailboat', maxHp: 700, deck: [1.4, 3.3], deckHeight: 0.5, draft: 0.5, mass: 700,
    paddleForce: 1600, sailForce: 5200, maxSpeed: 10, turnRate: 0.55, drag: 0.55, cargoSlots: 16,
    seats: [{ x: 0, z: 2.6, driver: true }, { x: -0.7, z: 0.6, driver: false }, { x: 0.7, z: 0.6, driver: false }, { x: 0, z: -1.8, driver: false }],
  },
];
export const VEHICLES: Readonly<Record<string, VehicleDef>> = Object.fromEntries(VEHICLE_LIST.map((v) => [v.id, v]));
