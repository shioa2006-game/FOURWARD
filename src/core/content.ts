// Static game content: items, enemies, floors. Behaviour lives in items.ts / ai.ts.

import type { ItemId } from './types.ts';
import type { GenOptions } from './dungeon.ts';

export type ItemKind = 'weapon' | 'magic' | 'guard' | 'move' | 'support';

/**
 * How an item moves you. Shown as an icon on cards so the rule is learnt visually.
 *  lunge: step, then strike from the new tile          (Sword, Hammer)
 *  sweep: strike from where you stand, then step       (Axe)
 *  hold : if something is in reach, act in place; otherwise just step (Spear, staves)
 *  step : step, then a self effect                     (Shield, Flask, Bomb Bag)
 *  dash : run until blocked, ram what stops you        (Boots)
 */
export type Timing = 'lunge' | 'sweep' | 'hold' | 'step' | 'dash';

/** Mini-diagram for the text-free item card: offsets are [forward, side]. */
export interface ItemDiagram {
  hits: [number, number][]; // tiles struck, relative to where the effect happens
  push?: number;
  line?: number; // projectile range along the line
  self?: 'heal' | 'guard' | 'bomb';
}

export interface ItemDef {
  id: ItemId;
  name: string; // Japanese
  kind: ItemKind;
  timing: Timing;
  color: string; // accent colour for UI
  cooldown: number; // turns (0 = none)
  charges: number; // uses per floor (0 = unlimited)
  dmg: number;
  tier: number; // 1 = early, 2 = mid, 3 = late (spawn weighting)
  diagram: ItemDiagram;
  starNote: string; // short Japanese hint of the ★ upgrade
}

export const ITEMS: Record<ItemId, ItemDef> = {
  sword: { id: 'sword', name: '剣', kind: 'weapon', timing: 'lunge', color: '#8fb8ff', cooldown: 0, charges: 0, dmg: 2, tier: 1, diagram: { hits: [[1, 0]] }, starNote: '倒すと連続行動' },
  spear: { id: 'spear', name: '槍', kind: 'weapon', timing: 'hold', color: '#6fe2f0', cooldown: 0, charges: 0, dmg: 1, tier: 1, diagram: { hits: [[1, 0], [2, 0]] }, starNote: '届く距離+1' },
  axe: { id: 'axe', name: '斧', kind: 'weapon', timing: 'sweep', color: '#ef4a5a', cooldown: 0, charges: 0, dmg: 1, tier: 1, diagram: { hits: [[1, -1], [1, 0], [1, 1]] }, starNote: '左右も薙ぐ' },
  hammer: { id: 'hammer', name: '鎚', kind: 'weapon', timing: 'lunge', color: '#f7973c', cooldown: 2, charges: 0, dmg: 1, tier: 2, diagram: { hits: [[1, 0]], push: 2 }, starNote: '吹き飛ばした敵を気絶' },
  fire: { id: 'fire', name: '炎の杖', kind: 'magic', timing: 'hold', color: '#f7973c', cooldown: 3, charges: 0, dmg: 2, tier: 2, diagram: { hits: [], line: 5 }, starNote: '炎が周囲に燃え移る' },
  frost: { id: 'frost', name: '氷の杖', kind: 'magic', timing: 'hold', color: '#6fe2f0', cooldown: 3, charges: 0, dmg: 0, tier: 2, diagram: { hits: [], line: 5 }, starNote: '一直線を貫く' },
  shield: { id: 'shield', name: '盾', kind: 'guard', timing: 'step', color: '#ffd35c', cooldown: 0, charges: 0, dmg: 0, tier: 1, diagram: { hits: [], self: 'guard' }, starNote: '三方向を守る' },
  flask: { id: 'flask', name: '薬瓶', kind: 'support', timing: 'step', color: '#ff8fc6', cooldown: 0, charges: 2, dmg: 0, tier: 1, diagram: { hits: [], self: 'heal' }, starNote: '各階3回' },
  boots: { id: 'boots', name: '疾風靴', kind: 'move', timing: 'dash', color: '#8fb8ff', cooldown: 3, charges: 0, dmg: 1, tier: 2, diagram: { hits: [[1, 0]], push: 1 }, starNote: '体当たりで気絶' },
  bomb: { id: 'bomb', name: '爆弾袋', kind: 'support', timing: 'step', color: '#f7973c', cooldown: 4, charges: 0, dmg: 2, tier: 2, diagram: { hits: [], self: 'bomb' }, starNote: '爆風3×3' },
};

export const ALL_ITEMS = Object.keys(ITEMS) as ItemId[];

// ---------------------------------------------------------------------------

export type MoveStyle = 'chase' | 'diag' | 'archer' | 'flank' | 'none' | 'boss';
export type ZoneStyle = 'orth' | 'diag' | 'adj8' | 'line' | 'none' | 'beam' | 'boss';

export interface EnemyDef {
  kind: string;
  name: string;
  hp: number;
  dmg: number;
  move: MoveStyle;
  zone: ZoneStyle;
  range: [number, number]; // for lines
  flying: boolean;
  frontShield: boolean; // blocks damage from its facing side (and recoils)
  slow: boolean; // acts every other turn
  pushOnHit: number; // pushes the hero when it hits
  explodes: boolean; // bomb beetle
  heavy: boolean; // immune to knockback, stuns last 1 turn then 2 turns of immunity
  threat: number; // budget cost for population
  coin: number; // coins dropped
}

const E = (o: Partial<EnemyDef> & { kind: string; name: string; hp: number }): EnemyDef => ({
  dmg: 1,
  move: 'chase',
  zone: 'orth',
  range: [1, 1],
  flying: false,
  frontShield: false,
  slow: false,
  pushOnHit: 0,
  explodes: false,
  heavy: false,
  threat: 2,
  coin: 1,
  ...o,
});

export const ENEMIES: Record<string, EnemyDef> = {
  slime: E({ kind: 'slime', name: 'スライム', hp: 2, threat: 2 }),
  bat: E({ kind: 'bat', name: 'コウモリ', hp: 1, move: 'diag', zone: 'diag', flying: true, threat: 2 }),
  archer: E({ kind: 'archer', name: '骸骨弓兵', hp: 2, move: 'archer', zone: 'line', range: [2, 5], threat: 3 }),
  goblin: E({ kind: 'goblin', name: 'ゴブリン', hp: 2, move: 'flank', threat: 3, coin: 2 }),
  knight: E({ kind: 'knight', name: '盾騎士', hp: 3, frontShield: true, threat: 4, coin: 2 }),
  ogre: E({ kind: 'ogre', name: '怪力オーガ', hp: 4, pushOnHit: 1, threat: 4, coin: 2 }),
  beetle: E({ kind: 'beetle', name: '爆弾虫', hp: 1, zone: 'none', explodes: true, threat: 3 }),
  golem: E({ kind: 'golem', name: '岩人形', hp: 5, dmg: 2, zone: 'adj8', heavy: true, threat: 5, coin: 3 }),
  sentinel: E({ kind: 'sentinel', name: '番兵の目', hp: 3, move: 'none', zone: 'beam', range: [1, 7], heavy: true, threat: 4, coin: 2 }),
  // guardians
  boss_slime: E({ kind: 'boss_slime', name: 'スライムの母', hp: 8, move: 'boss', zone: 'orth', heavy: true, threat: 0, coin: 6 }),
  boss_lancer: E({ kind: 'boss_lancer', name: '鉄の槍騎士', hp: 10, dmg: 1, frontShield: true, move: 'boss', zone: 'orth', threat: 0, coin: 8 }),
  boss_warden: E({ kind: 'boss_warden', name: '四方の番人', hp: 14, dmg: 1, frontShield: true, move: 'boss', zone: 'boss', heavy: true, threat: 0, coin: 0 }),
};

/** The Warden of Four carries a cross like the hero's: one weapon per side, one weak core side. */
export const WARDEN_CROSS: ('spear' | 'axe' | 'hammer' | 'core')[] = ['spear', 'axe', 'core', 'hammer'];

// ---------------------------------------------------------------------------

export interface FloorSpec {
  floor: number;
  zone: number; // 0..2
  gen: GenOptions;
  budget: number; // enemy threat budget
  pool: [string, number][];
  pedestals: number;
  anvil: boolean;
  fountain: boolean;
  chests: number;
  boss: string | null;
  wanderers: number; // enemies that start awake
}

export const ZONE_NAMES = ['苔むす地下墓所', '沈んだ洞窟', '熔鉄の炉'];
export const LAST_FLOOR = 9;

const genFor = (zone: number, floor: number, arena: boolean): GenOptions => {
  const f: GenOptions['features'][] = [
    { pillars: 0.5, grass: 0.3 },
    { pillars: 0.35, pits: 0.55, grass: 0.3, spikes: 0.25 },
    { pillars: 0.4, lava: 0.55, spikes: 0.2 },
  ];
  // floor "grain": odd floors favour horizontal corridors, even floors vertical ones,
  // so which pair of your slots does the fighting changes from floor to floor
  return {
    w: 34 + zone * 2,
    h: 24 + zone,
    minLeaf: 8,
    maxDepth: 4,
    extraLoops: zone === 0 ? 1 : 2,
    features: f[zone],
    arena,
    grain: floor % 2 === 1 ? 'h' : 'v',
  };
};

export const FLOORS: FloorSpec[] = [];
{
  const pools: [string, number][][] = [
    [
      ['slime', 5],
      ['bat', 3],
      ['archer', 2],
    ],
    [
      ['slime', 2],
      ['bat', 1],
      ['archer', 2],
      ['goblin', 3],
      ['knight', 4],
      ['ogre', 3],
    ],
    [
      ['bat', 1],
      ['archer', 2],
      ['goblin', 2],
      ['knight', 2],
      ['ogre', 1],
      ['beetle', 4],
      ['golem', 3],
      ['sentinel', 3],
    ],
  ];
  const bosses = ['boss_slime', 'boss_lancer', 'boss_warden'];
  for (let f = 1; f <= LAST_FLOOR; f++) {
    const zone = Math.floor((f - 1) / 3);
    const inZone = (f - 1) % 3; // 0,1 normal, 2 guardian
    const isBoss = inZone === 2;
    FLOORS.push({
      floor: f,
      zone,
      gen: genFor(zone, f, isBoss),
      budget: isBoss ? 3 + zone * 3 : 8 + zone * 4 + inZone * 3,
      pool: pools[zone],
      pedestals: f === 1 ? 2 : isBoss ? 1 : 2,
      anvil: inZone === 1,
      fountain: isBoss,
      chests: isBoss ? 0 : 1,
      boss: isBoss ? bosses[zone] : null,
      wanderers: zone,
    });
  }
}
