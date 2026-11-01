// Core game-state types. The whole GameState is plain JSON (saved to localStorage,
// cloned for outcome previews, replayed in tests).

import type { Dir } from './geom.ts';
import type { FloorMap } from './dungeon.ts';

export type ItemId = 'sword' | 'spear' | 'axe' | 'hammer' | 'fire' | 'frost' | 'shield' | 'flask' | 'boots' | 'bomb';

export interface ItemInst {
  id: ItemId;
  star: number; // 0 = base, 1 = upgraded
  cd: number; // turns until ready (0 = ready)
  charges: number; // for charge-based items (flask), else 0
}

export type EnemyKind = string;

export interface Unit {
  id: number;
  kind: EnemyKind;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  facing: Dir;
  awake: boolean;
  stun: number; // turns of skipped actions
  frozen: boolean; // visual flavour of stun
  burn: number; // turns of burning left
  timer: number; // generic per-kind counter (fuse, charge, cadence)
  mode: number; // generic per-kind state
  aim: number; // telegraphed direction (lines / charges) or countdown
  target: number; // telegraphed tile index (-1 none)
  boss: boolean;
  elite: boolean;
  spawnedBy: number; // id of the summoner (0 none)
  home: number; // room it was spawned in (-1 none) — cages open when a room is cleared
  immune: number; // turns of stun immunity left (heavy units shrug off control)
}

export type PropKind = 'pedestal' | 'anvil' | 'fountain' | 'chest' | 'barrel' | 'crate' | 'altar';

export interface Prop {
  id: number;
  kind: PropKind;
  x: number;
  y: number;
  item: ItemInst | null; // pedestal content
  price: number; // coins (0 = free)
  hp: number; // destructibles
  used: boolean;
  lockRoom: number; // caged pedestal: opens when every monster of that room is dead (-1 = open)
}

export type PickupKind = 'coin' | 'heart' | 'key';

export interface Pickup {
  id: number;
  kind: PickupKind;
  x: number;
  y: number;
  amount: number;
}

export interface Bomb {
  id: number;
  x: number;
  y: number;
  timer: number; // explodes when it reaches 0 at end of round
  radius: number; // + shape radius
  dmg: number;
  shape: 'plus' | 'square';
  owner: number; // 0 = player, else unit id
}

export interface Fire {
  x: number;
  y: number;
  turns: number;
}

export interface Player {
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  slots: (ItemInst | null)[]; // indexed by Dir (0 up, 1 right, 2 down, 3 left)
  coins: number;
  guard: Dir | -1; // braced side this round
  guardAll: boolean;
  lastDir: Dir | -1;
  streak: number; // consecutive steps in the same direction
  stun: number;
  burn: number;
}

export interface RunStats {
  kills: number;
  damageTaken: number;
  turns: number;
  floorsCleared: number;
  itemsFound: number;
  retries: number;
  startTime: number;
  endTime: number;
}

export type RunStatus = 'play' | 'dead' | 'won';

export interface GameState {
  version: number;
  seed: number;
  floor: number; // 1-based
  turn: number;
  status: RunStatus;
  map: FloorMap;
  explored: number[]; // 0/1 per tile
  stairsOpen: boolean;
  player: Player;
  units: Unit[];
  props: Prop[];
  pickups: Pickup[];
  bombs: Bomb[];
  fires: Fire[];
  nextId: number;
  rng: number; // RNG state
  stats: RunStats;
  bossId: number; // 0 none
  killedBy: string;
  checkpointFloor: number;
  rewinds?: number; // undo charges left on this floor (UI feature, saved with the run)
}

// ---------------------------------------------------------------------------
// events: produced by the engine, consumed by renderer / audio / UI

export type GameEvent =
  | { t: 'bump'; dir: Dir }
  | { t: 'brace'; dir: Dir }
  | { t: 'move'; id: number; fx: number; fy: number; tx: number; ty: number; how: 'step' | 'dash' | 'push' | 'pull' | 'leap' | 'hook' | 'slide' }
  | { t: 'swing'; id: number; dir: Dir; item: string; tiles: number[] }
  | { t: 'shot'; fx: number; fy: number; tx: number; ty: number; kind: string }
  | { t: 'beam'; tiles: number[]; kind: string }
  | { t: 'damage'; id: number; x: number; y: number; amount: number; kind: string }
  | { t: 'block'; id: number; x: number; y: number; dir: Dir | -1 }
  | { t: 'heal'; id: number; x: number; y: number; amount: number }
  | { t: 'death'; id: number; x: number; y: number; kind: string; how: string }
  | { t: 'explode'; x: number; y: number; tiles: number[] }
  | { t: 'status'; id: number; x: number; y: number; status: 'stun' | 'freeze' | 'burn' | 'wake' | 'guard' | 'rotate' }
  | { t: 'pickup'; kind: string; amount: number; x: number; y: number }
  | { t: 'equip'; dir: Dir; item: string; old: string | null; propId: number }
  | { t: 'upgrade'; dir: Dir; item: string }
  | { t: 'rotate'; cw: boolean }
  | { t: 'spawn'; id: number; x: number; y: number; kind: string }
  | { t: 'prop'; id: number; x: number; y: number; kind: string; what: string }
  | { t: 'stairs'; x: number; y: number }
  | { t: 'descend'; floor: number }
  | { t: 'enemyPhase' }
  | { t: 'sfx'; name: string }
  | { t: 'shake'; power: number }
  | { t: 'text'; x: number; y: number; text: string; color: string }
  | { t: 'trick'; x: number; y: number; text: string };
