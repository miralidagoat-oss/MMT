import { Rng } from '../math/rng';

const PRE = ['Kai', 'Mara', 'Tolu', 'Vesh', 'Oru', 'Sela', 'Nami', 'Rho', 'Tavi', 'Luma', 'Ekko', 'Pele', 'Haro', 'Zeph', 'Ilu', 'Moa', 'Quen', 'Avo'];
const MID = ['', 'na', 'ri', 'lo', 'ka', 've', 'mu', 'ta', 'si'];
const SUF = [' Cay', ' Key', ' Isle', ' Atoll', ' Rock', ' Reach', ' Spit', ' Holm', ' Shoal'];

export function islandName(rng: Rng, archetype: string): string {
  const base = rng.pick(PRE) + rng.pick(MID);
  let suf = rng.pick(SUF);
  if (archetype === 'atoll') suf = ' Atoll';
  if (archetype === 'sandbar') suf = rng.pick([' Spit', ' Shoal', ' Bar']);
  if (archetype === 'volcanic') suf = rng.pick([' Peak', ' Cinder', ' Crown']);
  if (archetype === 'rocky') suf = rng.pick([' Rock', ' Crag', ' Holm']);
  return base + suf;
}
