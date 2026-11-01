// Headless play-testing bot + invariant checker.
//   node tools/sim.ts [runs=100] [seedBase=1] [--verbose]
// The bot explores, fights using the engine's own outcome previews, picks up items,
// and descends. Every turn the world invariants are checked; soft-locks (no progress
// for too long) and exceptions are reported with their seed so they can be replayed.

import { newRun, act, previewAll, visibleSet } from '../src/core/engine.ts';
import { isWalkable, T } from '../src/core/dungeon.ts';
import { DX, DY, type Dir } from '../src/core/geom.ts';
import { ITEMS } from '../src/core/content.ts';
import { Rng } from '../src/core/rng.ts';
import type { GameState, ItemId } from '../src/core/types.ts';
import { propAt, unitAt } from '../src/core/world.ts';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const RUNS = Number(args[0] ?? 100);
const SEED0 = Number(args[1] ?? 1);
const VERBOSE = process.argv.includes('--verbose');
const KIT = (process.argv.find((a) => a.startsWith('--kit='))?.slice(6) ?? 'knight') as 'knight' | 'lancer' | 'mage';

const ITEM_RANK: Record<ItemId, number> = {
  sword: 7, spear: 6, axe: 6, hammer: 6, fire: 7, frost: 5, shield: 5, flask: 8, boots: 4, bomb: 5,
};

function invariants(s: GameState): string[] {
  const out: string[] = [];
  const p = s.player;
  const w = s.map.w;
  if (p.hp > p.maxHp) out.push(`hp ${p.hp} > max ${p.maxHp}`);
  if (s.status === 'play' && p.hp <= 0) out.push('alive with hp<=0');
  if (!isWalkable(s.map.tiles[p.y * w + p.x])) out.push(`player on non-walkable tile ${s.map.tiles[p.y * w + p.x]}`);
  const seen = new Set<number>();
  for (const u of s.units) {
    const i = u.y * w + u.x;
    if (seen.has(i)) out.push(`two units on ${u.x},${u.y}`);
    seen.add(i);
    if (u.x === p.x && u.y === p.y) out.push(`unit ${u.kind} on player`);
    if (u.hp <= 0) out.push(`dead unit ${u.kind} still present`);
    const t = s.map.tiles[i];
    const flying = u.kind === 'bat';
    if (!isWalkable(t) && !(flying && (t === T.Pit || t === T.Lava))) out.push(`${u.kind} on bad tile ${t}`);
    if (propAt(s, u.x, u.y)) out.push(`${u.kind} on prop`);
  }
  for (const pr of s.props) if (pr.x === p.x && pr.y === p.y) out.push('player on prop');
  if (s.status === 'play') {
    const d = distMap(s, p.y * w + p.x);
    if (d[s.map.stairs] < 0) out.push('UNREACHABLE stairs');
  }
  if (p.slots.length !== 4) out.push('slots corrupted');
  return out;
}

/** BFS over tiles the hero can walk (props block, units do not). */
function distMap(s: GameState, from: number): Int32Array {
  const { w, h, tiles } = s.map;
  const dist = new Int32Array(w * h).fill(-1);
  const blocked = new Set(s.props.map((q) => q.y * w + q.x));
  dist[from] = 0;
  const q = [from];
  for (let qi = 0; qi < q.length; qi++) {
    const i = q[qi];
    const x = i % w;
    const y = Math.floor(i / w);
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (dist[ni] >= 0 || blocked.has(ni) || !isWalkable(tiles[ni])) continue;
      if (tiles[ni] === T.Spikes) {
        // walkable but avoided when possible: treat as farther
      }
      dist[ni] = dist[i] + 1;
      q.push(ni);
    }
  }
  return dist;
}

let FLOOR_TURNS = 0;
function goalTile(s: GameState, rng: Rng): number[] {
  const w = s.map.w;
  if (FLOOR_TURNS > 500 && s.stairsOpen) return [s.map.stairs];
  // hunt awake visible enemies when healthy
  const vis = visibleSet(s);
  const prey = s.units.filter((u) => u.awake && vis.has(u.y * w + u.x) && Math.abs(u.x - s.player.x) + Math.abs(u.y - s.player.y) <= 8);
  if (prey.length && s.player.hp > 2 && FLOOR_TURNS < 250) {
    const g: number[] = [];
    for (const u of prey) for (let d = 0; d < 4; d++) g.push((u.y + DY[d] * 2) * w + u.x + DX[d] * 2);
    return g;
  }
  // 1) open stairs we have seen
  if (s.stairsOpen && s.explored[s.map.stairs]) return [s.map.stairs];
  // 2) boss alive: go hunt it
  if (s.bossId) {
    const b = s.units.find((u) => u.id === s.bossId);
    if (b) return [b.y * w + b.x];
  }
  // 3) pedestals with items worth taking (adjacent tiles as goals)
  const goals: number[] = [];
  for (const pr of s.props) {
    if (!s.explored[pr.y * w + pr.x]) continue;
    if (pr.kind === 'pedestal' && pr.item && wantsItem(s, pr.item.id)) {
      const d = desiredSlot(s, pr.item.id);
      // stand on the opposite side so that pressing d bumps the pedestal
      if (d >= 0) goals.push((pr.y - DY[d]) * w + pr.x - DX[d]);
    }
    if ((pr.kind === 'chest' && !pr.used) || (pr.kind === 'fountain' && !pr.used && s.player.hp < s.player.maxHp)) {
      for (let d = 0; d < 4; d++) goals.push((pr.y + DY[d]) * w + pr.x + DX[d]);
    }
  }
  if (goals.length) return goals;
  // 4) frontier: explored walkable tiles next to unexplored ones
  for (let i = 0; i < s.explored.length; i++) {
    if (!s.explored[i] || !isWalkable(s.map.tiles[i])) continue;
    const x = i % w;
    const y = Math.floor(i / w);
    for (let d = 0; d < 4; d++) {
      const ni = (y + DY[d]) * w + x + DX[d];
      if (!s.explored[ni]) {
        goals.push(i);
        break;
      }
    }
  }
  if (goals.length) return goals;
  // 5) stairs anyway (cheat) so the bot never stalls on a fully explored map
  void rng;
  return [s.map.stairs];
}

function wantsItem(s: GameState, id: ItemId): boolean {
  const slots = s.player.slots;
  if (slots.some((it) => !it)) return true;
  const worst = Math.min(...slots.map((it) => (it ? ITEM_RANK[it.id] + it.star * 2 : 0)));
  return ITEM_RANK[id] > worst || slots.some((it) => it && it.id === id && it.star === 0);
}

function desiredSlot(s: GameState, id: ItemId): Dir | -1 {
  const slots = s.player.slots;
  for (let d = 0 as Dir; d < 4; d = (d + 1) as Dir) if (slots[d] && slots[d]!.id === id && slots[d]!.star === 0) return d;
  for (let d = 0 as Dir; d < 4; d = (d + 1) as Dir) if (!slots[d]) return d;
  let worst: Dir | -1 = -1;
  let wv = 1e9;
  for (let d = 0 as Dir; d < 4; d = (d + 1) as Dir) {
    const it = slots[d]!;
    const v = ITEM_RANK[it.id] + it.star * 2;
    if (v < wv) { wv = v; worst = d; }
  }
  return ITEM_RANK[id] > wv ? worst : -1;
}

/** Pick the direction to bump a pedestal from so that the item lands in the best slot. */
function pedestalDir(s: GameState): Dir | -1 {
  const p = s.player;
  for (let d = 0 as Dir; d < 4; d = (d + 1) as Dir) {
    const pr = propAt(s, p.x + DX[d], p.y + DY[d]);
    if (!pr || pr.kind !== 'pedestal' || !pr.item) continue;
    if (!wantsItem(s, pr.item.id)) continue;
    if (desiredSlot(s, pr.item.id) === d) return d;
  }
  return -1;
}

const VISITS = new Map<number, number>();
function chooseDir(s: GameState, rng: Rng): Dir {
  const p = s.player;
  const w = s.map.w;
  const pv = previewAll(s);
  const goals = goalTile(s, rng);
  const pd = pedestalDir(s);
  // distance field from goals
  const { h } = s.map;
  const dist = new Int32Array(w * h).fill(-1);
  const blocked = new Set(s.props.map((q) => q.y * w + q.x));
  const q: number[] = [];
  for (const g of goals) {
    if (g >= 0 && g < w * h && dist[g] < 0 && !blocked.has(g)) {
      dist[g] = 0;
      q.push(g);
    }
  }
  for (let qi = 0; qi < q.length; qi++) {
    const i = q[qi];
    const x = i % w;
    const y = Math.floor(i / w);
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (dist[ni] >= 0 || blocked.has(ni) || !isWalkable(s.map.tiles[ni])) continue;
      dist[ni] = dist[i] + 1 + (s.map.tiles[ni] === T.Spikes ? 3 : 0);
      q.push(ni);
    }
  }
  const here = dist[p.y * w + p.x];
  let best: Dir = 0;
  let bestScore = -1e9;
  for (const v of pv) {
    if (!v.valid) continue;
    let sc = 0;
    sc -= v.dmgTaken * (p.hp <= 2 ? 400 : FLOOR_TURNS > 500 ? 20 : p.hp <= p.maxHp / 2 ? 120 : 50);
    sc += v.killIds.length * 40 + v.hitIds.length * 12;
    if (v.heal > 0) sc += p.hp <= p.maxHp / 2 ? 60 : -30;
    if (v.badge === 'swap') sc += pd === v.dir ? 80 : -200;
    if (v.badge === 'upgrade') sc += 50;
    const tp = propAt(s, p.x + DX[v.dir], p.y + DY[v.dir]);
    if (tp && tp.kind === 'chest' && !tp.used) sc += 60;
    if (tp && tp.kind === 'fountain' && !tp.used && p.hp < p.maxHp) sc += 60;
    if (v.badge === 'stairs') sc += s.player.hp >= 2 ? 300 : 100;
    if (v.dest) {
      const dd = dist[v.dest.y * w + v.dest.x];
      if (dd >= 0 && here >= 0) sc += (here - dd) * 8;
    }
    if (v.dest && v.dest.x === p.x && v.dest.y === p.y && !v.hitIds.length && !v.heal && v.badge !== 'swap' && v.badge !== 'upgrade') sc -= 15;
    if (v.dest) sc -= (VISITS.get(v.dest.y * w + v.dest.x) ?? 0) * 2;
    sc += rng.next() * 3;
    if (sc > bestScore) {
      bestScore = sc;
      best = v.dir;
    }
  }
  return best;
}

interface RunResult {
  seed: number;
  floor: number;
  status: string;
  turns: number;
  kills: number;
  killedBy: string;
  problems: string[];
  stuckFloors: number[];
  floorTurns: number[];
  hpAtFloor: number[];
}

function runOne(seed: number): RunResult {
  const s = newRun(seed, KIT);
  VISITS.clear();
  const rng = new Rng(seed ^ 0x777);
  const res: RunResult = { seed, floor: 1, status: 'play', turns: 0, kills: 0, killedBy: '', problems: [], stuckFloors: [], floorTurns: [], hpAtFloor: [s.player.hp] };
  let floorStart = 0;
  let curFloor = 1;
  let noProgress = 0;
  for (let t = 0; t < 12000 && s.status === 'play'; t++) {
    FLOOR_TURNS = s.turn - floorStart;
    let dir = chooseDir(s, rng);
    if (noProgress > 40) dir = rng.int(0, 3) as Dir;
    let r;
    try {
      r = act(s, dir);
    } catch (e) {
      res.problems.push(`EXCEPTION floor ${s.floor}: ${(e as Error).stack?.split('\n').slice(0, 3).join(' | ')}`);
      break;
    }
    if (!r.used) {
      noProgress++;
      if (noProgress > 200) {
        res.problems.push(`no valid action for 200 tries on floor ${s.floor}`);
        break;
      }
      continue;
    }
    noProgress = 0;
    VISITS.set(s.player.y * s.map.w + s.player.x, (VISITS.get(s.player.y * s.map.w + s.player.x) ?? 0) + 1);
    const inv = invariants(s);
    if (inv.length) {
      res.problems.push(`floor ${s.floor} turn ${s.turn}: ${inv.join('; ')}`);
      if (res.problems.length > 5) break;
    }
    if (s.floor !== curFloor) {
      res.floorTurns.push(s.turn - floorStart);
      res.hpAtFloor.push(s.player.hp);
      floorStart = s.turn;
      curFloor = s.floor;
      VISITS.clear();
    } else if (s.turn - floorStart > 1500) {
      res.stuckFloors.push(s.floor);
      res.problems.push(`STUCK on floor ${s.floor} (seed ${seed})`);
      break;
    }
  }
  res.floor = s.floor;
  res.status = s.status;
  res.turns = s.turn;
  res.kills = s.stats.kills;
  res.killedBy = s.killedBy;
  void visibleSet;
  void unitAt;
  return res;
}

const results: RunResult[] = [];
const t0 = Date.now();
for (let k = 0; k < RUNS; k++) {
  const r = runOne(SEED0 + k * 7919);
  results.push(r);
  if (VERBOSE) console.log(`seed ${r.seed}: ${r.status} B${r.floor} turns ${r.turns} kills ${r.kills} ${r.killedBy} ${r.problems.join(' / ')}`);
}
const deaths: Record<number, number> = {};
const killers: Record<string, number> = {};
for (const r of results) {
  if (r.status === 'dead') {
    deaths[r.floor] = (deaths[r.floor] ?? 0) + 1;
    killers[r.killedBy] = (killers[r.killedBy] ?? 0) + 1;
  }
}
const wins = results.filter((r) => r.status === 'won').length;
const problems = results.flatMap((r) => r.problems.map((p) => `seed ${r.seed}: ${p}`));
const avgFloorTurns = results.flatMap((r) => r.floorTurns);
console.log(`runs ${RUNS} (${KIT}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`wins ${wins}  avg floor reached ${(results.reduce((a, r) => a + r.floor, 0) / RUNS).toFixed(2)}  avg turns/floor ${(avgFloorTurns.reduce((a, b) => a + b, 0) / Math.max(1, avgFloorTurns.length)).toFixed(0)}`);
console.log('deaths by floor', JSON.stringify(deaths));
console.log('killers', JSON.stringify(killers));
console.log(`problems ${problems.length}`);
for (const p of problems.filter((q) => !q.includes("STUCK")).slice(0, 30)) console.log('  ' + p);
