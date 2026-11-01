// Enemy threat zones, attacks and movement. Fully deterministic (no RNG), so the red
// tiles on screen are exactly what will happen.

import { isWalkable, isFlyable, isOpaque, isDeadly, T } from './dungeon.ts';
import { DX, DY, DIRS, cw, roughDirTo, type Dir } from './geom.ts';
import { ENEMIES, ITEMS } from './content.ts';
import type { GameState, Unit } from './types.ts';
import {
  type Ctx,
  PLAYER,
  inMap,
  tileAt,
  unitAt,
  propAt,
  isPlayerAt,
  canEnter,
  def,
  hurtPlayer,
  hitUnit,
  pushPlayer,
  landUnit,
  blastTiles,
  wardenSide,
} from './world.ts';

const DIAG: [number, number][] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

/** Will this unit take an action in the coming enemy phase? */
export function willAct(s: GameState, u: Unit): boolean {
  if (!u.awake || u.stun > 0) return false;
  const d = def(u);
  if (d.slow && u.timer % 2 === 1) return false;
  if (u.kind === 'beetle') return false;
  void s;
  return true;
}

/** Which side of a unit faces tile (x,y). Ties go horizontal for the Warden, vertical otherwise. */
function sideToward(u: Unit, x: number, y: number): Dir {
  const dx = x - u.x;
  const dy = y - u.y;
  if (u.kind === 'boss_warden' && Math.abs(dx) === Math.abs(dy)) return dx > 0 ? 1 : 3;
  return roughDirTo(u, { x, y });
}

/** Tiles the Warden attacks with the item on `side` (relative pattern, rotated). */
function wardenPattern(s: GameState, u: Unit, side: Dir): number[] {
  const item = wardenSide(u, side);
  const out: number[] = [];
  const at = (f: number, sd: number) => {
    const r = cw(side);
    const x = u.x + DX[side] * f + DX[r] * sd;
    const y = u.y + DY[side] * f + DY[r] * sd;
    if (inMap(s, x, y) && !isOpaque(tileAt(s, x, y)) && sideToward(u, x, y) === side) out.push(y * s.map.w + x);
  };
  if (item === 'spear') {
    at(1, 0);
    const mx = u.x + DX[side];
    const my = u.y + DY[side];
    if (inMap(s, mx, my) && !isOpaque(tileAt(s, mx, my))) at(2, 0);
  } else if (item === 'axe') {
    at(1, -1);
    at(1, 0);
    at(1, 1);
  } else if (item === 'hammer') at(1, 0);
  return out;
}

/**
 * Tiles where the hero gets hit if they END their turn there (this unit only).
 * The hero's own position never blocks lines (it is the variable).
 */
export function zoneOf(s: GameState, u: Unit): number[] {
  if (!willAct(s, u)) return [];
  const d = def(u);
  const w = s.map.w;
  const out: number[] = [];
  const add = (x: number, y: number) => {
    if (inMap(s, x, y) && !isOpaque(tileAt(s, x, y))) out.push(y * w + x);
  };
  if (u.kind === 'boss_lancer' && u.mode === 1 && u.aim >= 0) return chargePath(s, u, u.aim as Dir);
  if (u.kind === 'boss_warden') {
    for (const side of DIRS) for (const i of wardenPattern(s, u, side)) out.push(i);
    return out;
  }
  if (u.kind === 'golem') {
    if (u.mode !== 1) return [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) add(u.x + dx, u.y + dy);
    return out;
  }
  switch (d.zone) {
    case 'orth':
      for (const dir of DIRS) add(u.x + DX[dir], u.y + DY[dir]);
      break;
    case 'diag':
      for (const [dx, dy] of DIAG) add(u.x + dx, u.y + dy);
      break;
    case 'adj8':
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) add(u.x + dx, u.y + dy);
      break;
    case 'line':
      for (const dir of DIRS) {
        for (let k = 1; k <= d.range[1]; k++) {
          const x = u.x + DX[dir] * k;
          const y = u.y + DY[dir] * k;
          if (!inMap(s, x, y) || isOpaque(tileAt(s, x, y))) break;
          if (unitAt(s, x, y) || propAt(s, x, y)) break; // never shoots through allies
          if (k >= d.range[0]) out.push(y * w + x);
        }
      }
      break;
    case 'beam':
      return beamPath(s, u);
    default:
      break;
  }
  return out;
}

/** Sentinel beam along its facing, up to (and including) the first unit. */
export function beamPath(s: GameState, u: Unit): number[] {
  const d = def(u);
  const out: number[] = [];
  const dir = u.facing;
  for (let k = 1; k <= d.range[1]; k++) {
    const x = u.x + DX[dir] * k;
    const y = u.y + DY[dir] * k;
    if (!inMap(s, x, y) || isOpaque(tileAt(s, x, y))) break;
    out.push(y * s.map.w + x);
    if (unitAt(s, x, y) || propAt(s, x, y)) break;
  }
  return out;
}

export function chargePath(s: GameState, u: Unit, dir: Dir): number[] {
  const out: number[] = [];
  let x = u.x;
  let y = u.y;
  for (let k = 0; k < 20; k++) {
    x += DX[dir];
    y += DY[dir];
    if (!inMap(s, x, y)) break;
    const t = tileAt(s, x, y);
    if (isOpaque(t) || isDeadly(t) || propAt(s, x, y) || unitAt(s, x, y)) break;
    out.push(y * s.map.w + x);
  }
  return out;
}

/** Delayed dangers: tile -> turns until it lands (bombs, lit beetles, fire). */
export function delayedThreats(s: GameState): Map<number, number> {
  const m = new Map<number, number>();
  const put = (i: number, t: number) => {
    const cur = m.get(i);
    if (cur === undefined || t < cur) m.set(i, t);
  };
  for (const b of s.bombs) for (const i of blastTiles(s, b.x, b.y, b.shape, b.radius)) put(i, b.timer);
  for (const u of s.units) {
    if (u.kind === 'beetle' && u.mode === 1) for (const i of blastTiles(s, u.x, u.y, 'square', 1)) put(i, u.timer);
  }
  for (const f of s.fires) put(f.y * s.map.w + f.x, 1);
  return m;
}

// ---------------------------------------------------------------------------
// distance maps

function bfsFrom(s: GameState, sources: number[], pass: (i: number) => boolean, diagonal = false): Int32Array {
  const { w, h } = s.map;
  const dist = new Int32Array(w * h).fill(-1);
  const q: number[] = [];
  for (const i of sources) {
    if (dist[i] < 0) {
      dist[i] = 0;
      q.push(i);
    }
  }
  const steps: [number, number][] = diagonal
    ? DIAG
    : [
        [0, -1],
        [1, 0],
        [0, 1],
        [-1, 0],
      ];
  for (let qi = 0; qi < q.length; qi++) {
    const i = q[qi];
    const x = i % w;
    const y = Math.floor(i / w);
    for (const [dx, dy] of steps) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (dist[ni] >= 0 || !pass(ni)) continue;
      if (diagonal && isOpaque(s.map.tiles[y * w + nx]) && isOpaque(s.map.tiles[ny * w + x])) continue;
      dist[ni] = dist[i] + 1;
      q.push(ni);
    }
  }
  return dist;
}

/** BFS over 8-neighbour moves (no corner cutting past walls). */
function bfs8(s: GameState, sources: number[], pass: (i: number) => boolean): Int32Array {
  const { w, h } = s.map;
  const dist = new Int32Array(w * h).fill(-1);
  const q: number[] = [];
  for (const i of sources) {
    if (dist[i] < 0) {
      dist[i] = 0;
      q.push(i);
    }
  }
  for (let qi = 0; qi < q.length; qi++) {
    const i = q[qi];
    const x = i % w;
    const y = Math.floor(i / w);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (dist[ni] >= 0 || !pass(ni)) continue;
        if (dx && dy && (isOpaque(s.map.tiles[y * w + nx]) || isOpaque(s.map.tiles[ny * w + x]))) continue;
        dist[ni] = dist[i] + 1;
        q.push(ni);
      }
  }
  return dist;
}

interface Maps {
  ground: Int32Array;
  fly: Int32Array;
  cache: Map<string, Int32Array>;
}

function buildMaps(s: GameState): Maps {
  const pi = s.player.y * s.map.w + s.player.x;
  const tiles = s.map.tiles;
  return {
    ground: bfsFrom(s, [pi], (i) => isWalkable(tiles[i])),
    fly: bfsFrom(s, [pi], (i) => isFlyable(tiles[i])),
    cache: new Map(),
  };
}

function lineClear(s: GameState, ax: number, ay: number, bx: number, by: number): boolean {
  if (ax !== bx && ay !== by) return false;
  const dx = Math.sign(bx - ax);
  const dy = Math.sign(by - ay);
  let x = ax + dx;
  let y = ay + dy;
  while (x !== bx || y !== by) {
    if (isOpaque(tileAt(s, x, y)) || propAt(s, x, y)) return false;
    x += dx;
    y += dy;
  }
  return true;
}

function firingMap(s: GameState, maps: Maps, r0: number, r1: number): Int32Array {
  const key = `fire${r0}-${r1}`;
  const hit = maps.cache.get(key);
  if (hit) return hit;
  const p = s.player;
  const src: number[] = [];
  for (const dir of DIRS) {
    for (let k = r0; k <= r1; k++) {
      const x = p.x + DX[dir] * k;
      const y = p.y + DY[dir] * k;
      if (!inMap(s, x, y)) break;
      if (isOpaque(tileAt(s, x, y))) break;
      if (isWalkable(tileAt(s, x, y)) && lineClear(s, x, y, p.x, p.y)) src.push(y * s.map.w + x);
    }
  }
  const m = bfsFrom(s, src, (i) => isWalkable(s.map.tiles[i]));
  maps.cache.set(key, m);
  return m;
}

function diagMap(s: GameState, maps: Maps): Int32Array {
  const hit = maps.cache.get('diag');
  if (hit) return hit;
  const p = s.player;
  const src: number[] = [];
  for (const [dx, dy] of DIAG) {
    const x = p.x + dx;
    const y = p.y + dy;
    if (inMap(s, x, y) && isFlyable(tileAt(s, x, y))) src.push(y * s.map.w + x);
  }
  const m = bfs8(s, src, (i) => isFlyable(s.map.tiles[i]));
  maps.cache.set('diag', m);
  return m;
}

/** Would the hero's item on side `d` hurt a monster standing there? (goblin logic) */
function sideIsDangerous(s: GameState, d: Dir): boolean {
  const it = s.player.slots[d];
  if (!it || it.cd > 0) return false;
  const k = ITEMS[it.id].kind;
  if (it.id === 'boots') return true;
  return k === 'weapon' || k === 'magic';
}

/** Goblins circle to your weakest side: an empty hand, a flask, a shield, a cooling item. */
function flankMap(s: GameState, maps: Maps): Int32Array {
  const hit = maps.cache.get('flank');
  if (hit) return hit;
  const p = s.player;
  const src: number[] = [];
  for (const d of DIRS) {
    if (sideIsDangerous(s, d)) continue;
    const x = p.x + DX[d];
    const y = p.y + DY[d];
    if (inMap(s, x, y) && isWalkable(tileAt(s, x, y))) src.push(y * s.map.w + x);
  }
  if (src.length === 0) {
    // every side is armed: lurk at distance 2 and wait for an opening
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        if (Math.abs(dx) + Math.abs(dy) !== 2) continue;
        const x = p.x + dx;
        const y = p.y + dy;
        if (inMap(s, x, y) && isWalkable(tileAt(s, x, y))) src.push(y * s.map.w + x);
      }
  }
  const m = bfsFrom(s, src, (i) => isWalkable(s.map.tiles[i]));
  maps.cache.set('flank', m);
  return m;
}

// ---------------------------------------------------------------------------
// enemy phase

export function enemyPhase(ctx: Ctx, visible: Set<number>, playerMoveDir: Dir | -1, seenBefore?: Set<number>): void {
  const s = ctx.s;
  const p = s.player;
  const w = s.map.w;
  const pi = p.y * w + p.x;
  // 1) attackers are decided simultaneously from the state the hero left behind
  const order = [...s.units].sort((a, b) => Math.abs(a.x - p.x) + Math.abs(a.y - p.y) - (Math.abs(b.x - p.x) + Math.abs(b.y - p.y)) || a.id - b.id);
  const attacking = new Set<number>();
  for (const u of order) {
    if (!visible.has(u.y * w + u.x)) continue;
    // a monster you could not see when you pressed the key never hits you that turn
    if (seenBefore && !seenBefore.has(u.id)) continue;
    if (zoneOf(s, u).includes(pi)) attacking.add(u.id);
  }
  const maps = buildMaps(s);
  void playerMoveDir;
  for (const u of order) {
    if (s.status !== 'play') return;
    if (!s.units.includes(u)) continue;
    const d = def(u);
    if (!u.awake) continue;
    if (u.immune > 0) u.immune--;
    if (u.kind === 'knight') u.mode = 0; // shield back up
    if (u.stun > 0) {
      u.stun--;
      if (u.stun === 0) u.frozen = false;
      continue;
    }
    if (d.slow) {
      u.timer++;
      if (u.timer % 2 === 0) continue; // resting (it acted last phase)
    }
    if (attacking.has(u.id)) {
      attack(ctx, u);
      continue;
    }
    act(ctx, u, maps, visible);
  }
}

function faceToward(u: Unit, x: number, y: number): void {
  if (u.x === x && u.y === y) return;
  u.facing = roughDirTo(u, { x, y });
}

function attack(ctx: Ctx, u: Unit): void {
  const s = ctx.s;
  const p = s.player;
  const d = def(u);
  if (u.kind === 'boss_lancer' && u.mode === 1) {
    lancerCharge(ctx, u, true);
    return;
  }
  if (u.kind === 'boss_warden') {
    const side = sideToward(u, p.x, p.y);
    const item = wardenSide(u, side);
    ctx.ev.push({ t: 'swing', id: u.id, dir: side, item: 'enemy', tiles: [p.y * s.map.w + p.x] });
    hurtPlayer(ctx, item === 'hammer' ? 2 : 1, u.x, u.y, 'claw', d.name);
    if (item === 'hammer' && s.status === 'play' && ctx.blockedDmg === 0) pushPlayer(ctx, side, 2, d.name);
    wardenTick(ctx, u);
    return;
  }
  if (d.zone === 'beam') {
    sentinelFire(ctx, u, true);
    return;
  }
  if (u.kind === 'golem') {
    golemSlam(ctx, u, true);
    return;
  }
  faceToward(u, p.x, p.y);
  if (u.kind === 'knight') u.mode = 1; // swinging lowers the shield until its next action
  if (d.zone === 'line') {
    ctx.ev.push({ t: 'shot', fx: u.x, fy: u.y, tx: p.x, ty: p.y, kind: 'enemy' });
    hurtPlayer(ctx, d.dmg, u.x, u.y, 'arrow', d.name);
    return;
  }
  ctx.ev.push({ t: 'swing', id: u.id, dir: u.facing, item: 'enemy', tiles: [p.y * s.map.w + p.x] });
  hurtPlayer(ctx, d.dmg, u.x, u.y, 'claw', d.name);
  if (s.status !== 'play') return;
  if (d.pushOnHit > 0 && ctx.blockedDmg === 0) pushPlayer(ctx, roughDirTo(u, p), d.pushOnHit, d.name);
}

function golemSlam(ctx: Ctx, u: Unit, hurtHero: boolean): void {
  const s = ctx.s;
  const tiles: number[] = [];
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const x = u.x + dx;
      const y = u.y + dy;
      if (!inMap(s, x, y) || isOpaque(tileAt(s, x, y))) continue;
      tiles.push(y * s.map.w + x);
    }
  ctx.ev.push({ t: 'explode', x: u.x, y: u.y, tiles });
  for (const i of tiles) {
    const x = i % s.map.w;
    const y = Math.floor(i / s.map.w);
    if (hurtHero && isPlayerAt(s, x, y)) hurtPlayer(ctx, 2, u.x, u.y, 'slam', def(u).name);
    const o = unitAt(s, x, y);
    if (o) hitUnit(ctx, o, 1, { dir: -1, kind: 'slam', byPlayer: false });
  }
  u.mode = 2;
}

export function rotateLoadout(ctx: Ctx, clockwise: boolean): void {
  const sl = ctx.s.player.slots;
  const old = [...sl];
  for (let d = 0; d < 4; d++) sl[clockwise ? (d + 1) % 4 : (d + 3) % 4] = old[d];
  ctx.ev.push({ t: 'rotate', cw: clockwise });
  ctx.ev.push({ t: 'status', id: PLAYER, x: ctx.s.player.x, y: ctx.s.player.y, status: 'rotate' });
}

function sentinelFire(ctx: Ctx, u: Unit, hurtHero: boolean): void {
  const s = ctx.s;
  const path = beamPath(s, u);
  ctx.ev.push({ t: 'beam', tiles: path, kind: 'thunder' });
  for (const i of path) {
    const x = i % s.map.w;
    const y = Math.floor(i / s.map.w);
    if (hurtHero && isPlayerAt(s, x, y)) hurtPlayer(ctx, def(u).dmg, u.x, u.y, 'beam', def(u).name);
    const other = unitAt(s, x, y);
    if (other && other !== u) hitUnit(ctx, other, 1, { dir: u.facing, kind: 'beam', byPlayer: false });
  }
  u.facing = cw(u.facing);
}

function act(ctx: Ctx, u: Unit, maps: Maps, visible: Set<number>): void {
  const s = ctx.s;
  const d = def(u);
  const p = s.player;
  switch (u.kind) {
    case 'beetle': {
      if (u.mode === 1) return; // lit: waiting for the fuse
      const near = Math.max(Math.abs(u.x - p.x), Math.abs(u.y - p.y)) <= 1;
      if (near && visible.has(u.y * s.map.w + u.x)) {
        u.mode = 1;
        u.timer = 3;
        ctx.ev.push({ t: 'sfx', name: 'fuse' });
        return;
      }
      stepToward(ctx, u, maps.ground);
      return;
    }
    case 'sentinel':
      // fires every turn whether or not the hero is in the beam (allies get hit too)
      sentinelFire(ctx, u, false);
      return;
    case 'golem': {
      if (u.mode === 1) {
        golemSlam(ctx, u, false); // the hero got out of the way: it still comes down
        return;
      }
      if (u.mode === 2) {
        u.mode = 0; // catching its breath after a slam
        return;
      }
      if (Math.max(Math.abs(u.x - p.x), Math.abs(u.y - p.y)) <= 1) {
        u.mode = 1; // raises its fists: the 3x3 around it turns red
        ctx.ev.push({ t: 'sfx', name: 'boss' });
        return;
      }
      stepToward(ctx, u, maps.ground);
      return;
    }
    case 'boss_slime':
      if (u.timer++ % 2 === 1) return; // slow
      stepToward(ctx, u, maps.ground);
      return;
    case 'boss_lancer':
      lancerAct(ctx, u, maps);
      return;
    case 'boss_warden':
      if (u.timer % 2 === 0) stepToward(ctx, u, maps.ground);
      wardenTick(ctx, u);
      return;
  }
  switch (d.move) {
    case 'chase':
      // shield-bearers keep their shield the way they walked: make them walk around you
      // and their flank is open
      stepToward(ctx, u, d.flying ? maps.fly : maps.ground);
      break;
    case 'flank':
      stepToward(ctx, u, flankMap(s, maps));
      break;
    case 'diag': {
      const m = diagMap(s, maps);
      let best: [number, number] | null = null;
      let bestD = m[u.y * s.map.w + u.x] < 0 ? 1e9 : m[u.y * s.map.w + u.x];
      // bats flutter in all 8 directions (diagonals first) but only bite diagonally
      const steps: [number, number][] = [...DIAG, [0, -1], [1, 0], [0, 1], [-1, 0]];
      for (const [dx, dy] of steps) {
        const x = u.x + dx;
        const y = u.y + dy;
        if (!canEnter(s, x, y, true)) continue;
        if (dx && dy && (isOpaque(tileAt(s, u.x + dx, u.y)) || isOpaque(tileAt(s, u.x, u.y + dy)))) continue;
        const dd = m[y * s.map.w + x];
        if (dd < 0) continue;
        if (dd < bestD) {
          bestD = dd;
          best = [x, y];
        }
      }
      if (!best) {
        stepToward(ctx, u, maps.fly);
        return;
      }
      moveTo(ctx, u, best[0], best[1], 'step');
      break;
    }
    case 'archer': {
      const dist = Math.abs(u.x - p.x) + Math.abs(u.y - p.y);
      if (dist <= 1) {
        fleeFrom(ctx, u, maps.ground);
        return;
      }
      stepToward(ctx, u, firingMap(s, maps, d.range[0], d.range[1]));
      break;
    }
    default:
      break;
  }
}

function moveTo(ctx: Ctx, u: Unit, x: number, y: number, how: 'step' | 'leap' | 'dash'): void {
  const dx = x - u.x;
  if (dx > 0) u.facing = 1;
  else if (dx < 0) u.facing = 3;
  else u.facing = y < u.y ? 0 : 2;
  ctx.ev.push({ t: 'move', id: u.id, fx: u.x, fy: u.y, tx: x, ty: y, how });
  u.x = x;
  u.y = y;
  landUnit(ctx, u, false);
}

function hazardPenalty(s: GameState, x: number, y: number): number {
  const t = tileAt(s, x, y);
  let p = 0;
  if (t === T.Spikes) p += 3;
  if (s.fires.some((f) => f.x === x && f.y === y)) p += 3;
  return p;
}

/**
 * Step to the neighbour with the lowest distance. Ties: LINE UP FIRST — close the
 * smaller non-zero gap to the hero before the larger one, so chasers arrive in a
 * straight line (where a lunge can meet them).
 */
export function stepToward(ctx: Ctx, u: Unit, dist: Int32Array): boolean {
  const s = ctx.s;
  const p = s.player;
  const flying = def(u).flying;
  const here = dist[u.y * s.map.w + u.x];
  const adx = Math.abs(p.x - u.x);
  const ady = Math.abs(p.y - u.y);
  const hx: Dir = p.x > u.x ? 1 : 3;
  const vy: Dir = p.y > u.y ? 2 : 0;
  let order: Dir[];
  if (adx === 0) order = [vy];
  else if (ady === 0) order = [hx];
  else order = adx <= ady ? [hx, vy] : [vy, hx];
  for (const d of DIRS) if (!order.includes(d)) order.push(d);
  let best: Dir | -1 = -1;
  let bestScore = here < 0 ? 1e9 : here * 10 + hazardPenalty(s, u.x, u.y);
  for (const dir of order) {
    const x = u.x + DX[dir];
    const y = u.y + DY[dir];
    if (!canEnter(s, x, y, flying)) continue;
    if (!flying && isDeadly(tileAt(s, x, y))) continue;
    const dd = dist[y * s.map.w + x];
    if (dd < 0) continue;
    const score = dd * 10 + hazardPenalty(s, x, y);
    if (score < bestScore) {
      bestScore = score;
      best = dir;
    }
  }
  if (best === -1) return false;
  moveTo(ctx, u, u.x + DX[best], u.y + DY[best], 'step');
  return true;
}

function fleeFrom(ctx: Ctx, u: Unit, dist: Int32Array): void {
  const s = ctx.s;
  let best: Dir | -1 = -1;
  let bestD = dist[u.y * s.map.w + u.x];
  for (const dir of DIRS) {
    const x = u.x + DX[dir];
    const y = u.y + DY[dir];
    if (!canEnter(s, x, y) || isDeadly(tileAt(s, x, y))) continue;
    const dd = dist[y * s.map.w + x];
    if (dd > bestD) {
      bestD = dd;
      best = dir;
    }
  }
  if (best !== -1) moveTo(ctx, u, u.x + DX[best], u.y + DY[best], 'step');
}

// ---------------------------------------------------------------------------
// guardians

function aligned(s: GameState, u: Unit): Dir | -1 {
  const p = s.player;
  if (u.x !== p.x && u.y !== p.y) return -1;
  const dir = roughDirTo(u, p);
  const path = chargePath(s, u, dir);
  const pi = p.y * s.map.w + p.x;
  return path.indexOf(pi) >= 1 ? dir : -1;
}

function lancerAct(ctx: Ctx, u: Unit, maps: Maps): void {
  const s = ctx.s;
  const p = s.player;
  if (u.mode === 1) {
    lancerCharge(ctx, u, false);
    return;
  }
  const al = aligned(s, u);
  if (al !== -1) {
    // telegraph: lower the lance — the whole line turns red, charge next turn
    u.mode = 1;
    u.aim = al;
    u.facing = al;
    ctx.ev.push({ t: 'sfx', name: 'boss' });
    return;
  }
  stepToward(ctx, u, maps.ground);
  faceToward(u, p.x, p.y);
}

function lancerCharge(ctx: Ctx, u: Unit, hurtHero: boolean): void {
  const s = ctx.s;
  const dir = u.aim as Dir;
  const path = chargePath(s, u, dir);
  u.mode = 0;
  u.aim = -1;
  let hitHero = false;
  let endX = u.x;
  let endY = u.y;
  for (const i of path) {
    const x = i % s.map.w;
    const y = Math.floor(i / s.map.w);
    if (isPlayerAt(s, x, y)) {
      // the charge stops in front of the hero; it only hurts if this was the announced attack
      hitHero = hurtHero;
      break;
    }
    endX = x;
    endY = y;
  }
  if (endX !== u.x || endY !== u.y) {
    ctx.ev.push({ t: 'move', id: u.id, fx: u.x, fy: u.y, tx: endX, ty: endY, how: 'dash' });
    u.x = endX;
    u.y = endY;
  }
  u.facing = dir;
  if (hitHero) {
    ctx.ev.push({ t: 'swing', id: u.id, dir, item: 'enemy', tiles: [s.player.y * s.map.w + s.player.x] });
    hurtPlayer(ctx, 2, u.x, u.y, 'charge', def(u).name);
    if (s.status === 'play' && ctx.blockedDmg === 0) pushPlayer(ctx, dir, 1, def(u).name);
    return;
  }
  // crashed into something solid: stunned and shield down for 2 turns
  const nx = u.x + DX[dir];
  const ny = u.y + DY[dir];
  const t = tileAt(s, nx, ny);
  if (isOpaque(t) || propAt(s, nx, ny) || isDeadly(t)) {
    u.stun = 2;
    ctx.ev.push({ t: 'shake', power: 8 });
    ctx.ev.push({ t: 'status', id: u.id, x: u.x, y: u.y, status: 'stun' });
    hitUnit(ctx, u, 1, { dir: -1, kind: 'slam', byPlayer: true });
  }
}

/** Warden: its cross turns a quarter every 3 actions (every 2 when wounded). */
function wardenTick(ctx: Ctx, u: Unit): void {
  const s = ctx.s;
  u.timer++;
  const wounded = u.hp <= u.maxHp / 2;
  const period = wounded ? 2 : 3;
  if (u.timer % period === 0) {
    u.mode = (u.mode + 1) % 4;
    ctx.ev.push({ t: 'status', id: u.id, x: u.x, y: u.y, status: 'rotate' });
  }
  if (wounded && u.timer % 5 === 0 && s.units.filter((m) => m.spawnedBy === u.id).length < 2) summonNear(ctx, u, 'goblin');
}

export function summonNear(ctx: Ctx, u: Unit, kind: string): void {
  const s = ctx.s;
  const p = s.player;
  for (const dir of DIRS) {
    const x = u.x + DX[dir];
    const y = u.y + DY[dir];
    // never appear right next to the hero
    if (Math.abs(x - p.x) + Math.abs(y - p.y) <= 1) continue;
    if (canEnter(s, x, y) && !isDeadly(tileAt(s, x, y))) {
      const m = makeUnit(s, kind, x, y);
      m.awake = true;
      m.spawnedBy = u.id;
      m.stun = 1; // spawned units never act on their spawn turn
      s.units.push(m);
      ctx.ev.push({ t: 'spawn', id: m.id, x, y, kind });
      return;
    }
  }
}

export function makeUnit(s: GameState, kind: string, x: number, y: number): Unit {
  const d = ENEMIES[kind];
  return {
    id: s.nextId++,
    kind,
    x,
    y,
    hp: d.hp,
    maxHp: d.hp,
    facing: 2,
    awake: false,
    stun: 0,
    frozen: false,
    burn: 0,
    timer: 0,
    mode: 0,
    aim: -1,
    target: -1,
    boss: kind.startsWith('boss_'),
    elite: false,
    spawnedBy: 0,
    home: -1,
    immune: 0,
  };
}

/** Slime Mother splits off a slime each time she is hurt (max 3 alive). */
export function bossReactions(ctx: Ctx): void {
  const s = ctx.s;
  for (const u of s.units) {
    if (u.kind !== 'boss_slime') continue;
    if (u.target < 0) u.target = u.maxHp;
    if (u.hp < u.target) {
      const lost = u.target - u.hp;
      u.target = u.hp;
      for (let k = 0; k < Math.min(2, lost); k++) {
        if (s.units.filter((m) => m.spawnedBy === u.id).length >= 3) break;
        summonNear(ctx, u, 'slime');
      }
    }
  }
}
