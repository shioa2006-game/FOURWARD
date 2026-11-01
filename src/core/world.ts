// World queries and the shared combat primitives (damage, knockback, explosions...).
// Everything here mutates the GameState and appends GameEvents to ctx.ev.

import { T, isWalkable, isFlyable, isOpaque, isDeadly } from './dungeon.ts';
import { DX, DY, opposite, type Dir } from './geom.ts';
import { Rng } from './rng.ts';
import { ENEMIES, WARDEN_CROSS, LAST_FLOOR } from './content.ts';
import type { GameEvent, GameState, Prop, Unit } from './types.ts';

export interface Ctx {
  s: GameState;
  ev: GameEvent[];
  rng: Rng;
  preview: boolean;
  freeTurn: boolean; // set by the dagger: enemies skip this round
  pendingBlasts: { x: number; y: number; shape: 'plus' | 'square'; r: number; dmg: number; src: number }[];
  hitIds: Set<number>;
  killIds: Set<number>;
  blockedDmg: number;
}

export const PLAYER = 0;

export function mkCtx(s: GameState, preview = false): Ctx {
  return { s, ev: [], rng: new Rng(s.rng), preview, freeTurn: false, pendingBlasts: [], hitIds: new Set(), killIds: new Set(), blockedDmg: 0 };
}

export function inMap(s: GameState, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < s.map.w && y < s.map.h;
}
export function tileAt(s: GameState, x: number, y: number): number {
  return inMap(s, x, y) ? s.map.tiles[y * s.map.w + x] : T.Wall;
}
export function unitAt(s: GameState, x: number, y: number): Unit | undefined {
  for (const u of s.units) if (u.x === x && u.y === y) return u;
  return undefined;
}
export function propAt(s: GameState, x: number, y: number): Prop | undefined {
  for (const p of s.props) if (p.x === x && p.y === y) return p;
  return undefined;
}
export function isPlayerAt(s: GameState, x: number, y: number): boolean {
  return s.player.x === x && s.player.y === y;
}
/** Props that occupy their tile (everything except used chests? no — all props block). */
export function propBlocks(p: Prop | undefined): boolean {
  return !!p;
}
export function destructible(p: Prop | undefined): boolean {
  return !!p && (p.kind === 'barrel' || p.kind === 'crate');
}

/** Can a unit (or the player) enter this tile right now? */
export function canEnter(s: GameState, x: number, y: number, flying = false): boolean {
  if (!inMap(s, x, y)) return false;
  const t = s.map.tiles[y * s.map.w + x];
  if (!(flying ? isFlyable(t) : isWalkable(t))) return false;
  if (unitAt(s, x, y)) return false;
  if (propAt(s, x, y)) return false;
  if (isPlayerAt(s, x, y)) return false;
  return true;
}

export function idx(s: GameState, x: number, y: number): number {
  return y * s.map.w + x;
}

export function def(u: Unit) {
  return ENEMIES[u.kind];
}

/** Which sides of the player an attacker at (ax, ay) counts as (for shields). */
export function sidesOf(px: number, py: number, ax: number, ay: number): Dir[] {
  const dx = ax - px;
  const dy = ay - py;
  if (dx === 0 && dy === 0) return [];
  const out: Dir[] = [];
  if (Math.abs(dy) >= Math.abs(dx)) out.push(dy < 0 ? 0 : 2);
  if (Math.abs(dx) >= Math.abs(dy)) out.push(dx > 0 ? 1 : 3);
  return out;
}

// ---------------------------------------------------------------------------
// damage

export interface HitOpt {
  dir: Dir | -1; // travel direction of the blow (-1 = area / no direction)
  push?: number;
  stun?: number;
  freeze?: boolean;
  burn?: number;
  kind: string; // 'sword', 'slam', 'blast', ...
  byPlayer: boolean;
}

/** Is this unit's front shield facing the incoming blow? */
export function shieldBlocks(u: Unit, dir: Dir | -1): boolean {
  if (dir < 0) return false;
  const d = def(u);
  if (!d.frontShield || u.stun > 0) return false;
  if (u.kind === 'knight' && u.mode === 1) return false; // shield lowered after its own swing
  if (u.kind === 'boss_warden') return wardenSide(u, opposite(dir as Dir)) !== 'core'; // only the core side is soft
  return opposite(dir as Dir) === u.facing;
}

/** Which item of the Warden's cross faces world side `side` (mode = rotation). */
export function wardenSide(u: Unit, side: Dir): (typeof WARDEN_CROSS)[number] {
  return WARDEN_CROSS[(side - u.mode + 4) % 4];
}

export function hitUnit(ctx: Ctx, u: Unit, dmg: number, o: HitOpt): void {
  const s = ctx.s;
  if (!s.units.includes(u)) return;
  if (o.byPlayer) ctx.hitIds.add(u.id);
  if (!u.awake) {
    u.awake = true;
    u.stun = Math.max(u.stun, 1); // startled: loses its first turn
    ctx.ev.push({ t: 'status', id: u.id, x: u.x, y: u.y, status: 'wake' });
  }
  if (dmg > 0 && shieldBlocks(u, o.dir)) {
    // The shield stops the damage, but the blow still drives the bearer back a tile.
    // Pinned against a wall / another unit, that recoil becomes slam damage — so any
    // weapon can crack a shield-bearer with the help of terrain.
    ctx.ev.push({ t: 'block', id: u.id, x: u.x, y: u.y, dir: u.facing });
    if (o.burn && o.burn > 0) {
      // flames lick around the shield
      u.burn = Math.max(u.burn, o.burn);
      ctx.ev.push({ t: 'status', id: u.id, x: u.x, y: u.y, status: 'burn' });
    }
    if (u.kind !== 'boss_warden') pushUnit(ctx, u, o.dir as Dir, Math.max(1, o.push ?? 0), o.byPlayer);
    return;
  }
  // stone skin: weapon blows chip at most 1; blasts, fire and slams hit in full
  if (u.kind === 'golem' && dmg > 1 && ['sword', 'spear', 'axe', 'hammer', 'ram'].includes(o.kind)) dmg = 1;
  if (dmg > 0) {
    u.hp -= dmg;
    ctx.ev.push({ t: 'damage', id: u.id, x: u.x, y: u.y, amount: dmg, kind: o.kind });
    if (u.hp <= 0) {
      killUnit(ctx, u, o.kind === 'slam' ? 'slam' : o.kind === 'blast' ? 'blast' : 'hit', o.byPlayer);
      return;
    }
  }
  if (o.stun && o.stun > 0 && !(def(u).heavy && u.immune > 0)) {
    const heavy = def(u).heavy;
    u.stun = Math.max(u.stun, heavy ? 1 : o.stun);
    if (heavy) u.immune = 3;
    u.frozen = !!o.freeze;
    ctx.ev.push({ t: 'status', id: u.id, x: u.x, y: u.y, status: o.freeze ? 'freeze' : 'stun' });
    if (u.kind === 'beetle' && u.mode === 1 && o.freeze) {
      // frost snuffs a lit fuse
      u.mode = 0;
      u.timer = 0;
    }
  }
  if (o.burn && o.burn > 0) {
    u.burn = Math.max(u.burn, o.burn);
    ctx.ev.push({ t: 'status', id: u.id, x: u.x, y: u.y, status: 'burn' });
  }
  if (o.push && o.push > 0 && o.dir >= 0) pushUnit(ctx, u, o.dir as Dir, o.push, o.byPlayer);
}

export function killUnit(ctx: Ctx, u: Unit, how: string, byPlayer: boolean): void {
  const s = ctx.s;
  const i = s.units.indexOf(u);
  if (i < 0) return;
  s.units.splice(i, 1);
  if (byPlayer || how !== 'despawn') ctx.killIds.add(u.id);
  ctx.ev.push({ t: 'death', id: u.id, x: u.x, y: u.y, kind: u.kind, how });
  if (how !== 'despawn') s.stats.kills++;
  const d = def(u);
  // drops
  if (how !== 'fall' && how !== 'despawn') {
    if (d.coin > 0 && !u.spawnedBy) dropPickup(ctx, u.x, u.y, 'coin', d.coin);
    else if (u.spawnedBy && ctx.rng.chance(0.25)) dropPickup(ctx, u.x, u.y, 'coin', 1);
    if (!u.boss && ctx.rng.chance(0.07)) dropPickup(ctx, u.x, u.y, 'heart', 1);
  }
  // the last monster of a room is gone: the room is cleared and leaves a heart behind,
  // so fighting through a room pays for itself (and opens its cage at the same moment)
  if (u.home >= 0 && how !== 'despawn' && !s.units.some((o) => o.home === u.home)) {
    const spot = nearestOpen(s, u.x, u.y);
    if (spot) {
      dropPickup(ctx, spot.x, spot.y, 'heart', 1);
      ctx.ev.push({ t: 'text', x: spot.x, y: spot.y - 0.6, text: '制圧！', color: '#ff8fc6' });
    }
  }
  if (d.explodes && how !== 'fall') {
    if (how === 'blast') ctx.pendingBlasts.push({ x: u.x, y: u.y, shape: 'square', r: 1, dmg: 2, src: u.id });
    // killed by hand: the fuse catches — one turn to step away
    else s.bombs.push({ id: s.nextId++, x: u.x, y: u.y, timer: 2, radius: 1, dmg: 2, shape: 'square', owner: -1 });
  }
  if (u.boss) onBossDeath(ctx, u);
}

/** Closest walkable tile without a prop (the kill spot itself may be a pit). */
function nearestOpen(s: GameState, x: number, y: number): { x: number; y: number } | null {
  for (let r = 0; r <= 3; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (isWalkable(tileAt(s, nx, ny)) && !propAt(s, nx, ny) && tileAt(s, nx, ny) !== T.Stairs) return { x: nx, y: ny };
      }
  return null;
}

function onBossDeath(ctx: Ctx, u: Unit): void {
  const s = ctx.s;
  // minions vanish with their master
  for (const m of [...s.units]) if (m.spawnedBy === u.id) killUnit(ctx, m, 'despawn', false);
  s.bossId = 0;
  if (s.floor >= LAST_FLOOR) {
    s.status = 'won';
    s.stats.endTime = s.stats.endTime || 1;
    return;
  }
  // reward: +1 max heart, full heal, stairs revealed
  s.player.maxHp += 1;
  const before = s.player.hp;
  s.player.hp = s.player.maxHp;
  ctx.ev.push({ t: 'heal', id: PLAYER, x: s.player.x, y: s.player.y, amount: s.player.hp - before });
  openStairs(ctx);
}

export function openStairs(ctx: Ctx): void {
  const s = ctx.s;
  if (s.stairsOpen) return;
  s.stairsOpen = true;
  const i = s.map.stairs;
  // clear anything sitting on the stairs tile
  const x = i % s.map.w;
  const y = Math.floor(i / s.map.w);
  s.map.tiles[i] = T.Stairs;
  s.props = s.props.filter((p) => !(p.x === x && p.y === y));
  ctx.ev.push({ t: 'stairs', x, y });
}

export function dropPickup(ctx: Ctx, x: number, y: number, kind: 'coin' | 'heart' | 'key', amount: number): void {
  const s = ctx.s;
  if (!isWalkable(tileAt(s, x, y))) return;
  const existing = s.pickups.find((p) => p.x === x && p.y === y && p.kind === kind);
  if (existing) existing.amount += amount;
  else s.pickups.push({ id: s.nextId++, kind, x, y, amount });
}

export function guardSides(p: { guard: number; guardAll: boolean }): Dir[] {
  if (p.guard < 0) return [];
  const d = p.guard as Dir;
  return p.guardAll ? [d, ((d + 1) % 4) as Dir, ((d + 3) % 4) as Dir] : [d];
}

/** Damage to the player from a source position (for shield sides). */
export function hurtPlayer(ctx: Ctx, dmg: number, sx: number, sy: number, kind: string, killer: string): void {
  const s = ctx.s;
  const p = s.player;
  if (s.status !== 'play' || dmg <= 0) return;
  const sides = sidesOf(p.x, p.y, sx, sy);
  const guarded = guardSides(p);
  const hitSide = sides.find((sd) => guarded.includes(sd));
  if (hitSide !== undefined && kind !== 'burn' && kind !== 'spikes' && kind !== 'blast') {
    // the shield soaks 1 damage from the side it faces (2-damage blows still bite)
    ctx.blockedDmg += 1;
    ctx.ev.push({ t: 'block', id: PLAYER, x: p.x, y: p.y, dir: hitSide });
    dmg -= 1;
    if (dmg <= 0) return;
  }
  p.hp -= dmg;
  s.stats.damageTaken += dmg;
  ctx.ev.push({ t: 'damage', id: PLAYER, x: p.x, y: p.y, amount: dmg, kind });
  if (p.hp <= 0) {
    p.hp = 0;
    s.status = 'dead';
    s.killedBy = killer;
    ctx.ev.push({ t: 'death', id: PLAYER, x: p.x, y: p.y, kind: 'hero', how: 'hit' });
  }
}

// ---------------------------------------------------------------------------
// movement effects

/** Knock a unit back `n` tiles. Walls/units/props stop it with 1 slam damage. */
export function pushUnit(ctx: Ctx, u: Unit, dir: Dir, n: number, byPlayer: boolean): void {
  const s = ctx.s;
  const flying = def(u).flying;
  if (def(u).heavy) return; // too heavy to budge
  for (let k = 0; k < n; k++) {
    if (!s.units.includes(u)) return;
    const nx = u.x + DX[dir];
    const ny = u.y + DY[dir];
    const t = tileAt(s, nx, ny);
    const other = unitAt(s, nx, ny);
    const prop = propAt(s, nx, ny);
    if (!inMap(s, nx, ny) || isOpaque(t) || prop || other || isPlayerAt(s, nx, ny)) {
      // slam
      ctx.ev.push({ t: 'shake', power: 4 });
      hitUnit(ctx, u, 1, { dir: -1, kind: 'slam', byPlayer });
      if (other) hitUnit(ctx, other, 1, { dir: -1, kind: 'slam', byPlayer });
      if (prop && destructible(prop)) damageProp(ctx, prop, 1);
      if (isPlayerAt(s, nx, ny)) hurtPlayer(ctx, 1, u.x, u.y, 'slam', def(u).name);
      return;
    }
    if (isDeadly(t) && !flying) {
      if (u.boss) {
        hitUnit(ctx, u, 1, { dir: -1, kind: 'slam', byPlayer });
        return;
      }
      ctx.ev.push({ t: 'move', id: u.id, fx: u.x, fy: u.y, tx: nx, ty: ny, how: 'push' });
      u.x = nx;
      u.y = ny;
      killUnit(ctx, u, 'fall', byPlayer);
      return;
    }
    ctx.ev.push({ t: 'move', id: u.id, fx: u.x, fy: u.y, tx: nx, ty: ny, how: 'push' });
    u.x = nx;
    u.y = ny;
    landUnit(ctx, u, byPlayer);
  }
}

/** Hazards when a unit ends up on a tile. */
export function landUnit(ctx: Ctx, u: Unit, byPlayer: boolean): void {
  const s = ctx.s;
  const t = tileAt(s, u.x, u.y);
  if (t === T.Spikes && !def(u).flying) hitUnit(ctx, u, 1, { dir: -1, kind: 'spikes', byPlayer });
  if (s.units.includes(u) && s.fires.some((f) => f.x === u.x && f.y === u.y)) {
    u.burn = Math.max(u.burn, 2);
  }
}

/** Player knocked back (ogre). Pits act like walls for the hero. */
export function pushPlayer(ctx: Ctx, dir: Dir, n: number, srcName: string): void {
  const s = ctx.s;
  const p = s.player;
  for (let k = 0; k < n; k++) {
    if (s.status !== 'play') return;
    const nx = p.x + DX[dir];
    const ny = p.y + DY[dir];
    const other = unitAt(s, nx, ny);
    if (!canEnter(s, nx, ny)) {
      ctx.ev.push({ t: 'shake', power: 5 });
      hurtPlayer(ctx, 1, p.x - DX[dir], p.y - DY[dir], 'slam', srcName);
      if (other) hitUnit(ctx, other, 1, { dir: -1, kind: 'slam', byPlayer: false });
      return;
    }
    ctx.ev.push({ t: 'move', id: PLAYER, fx: p.x, fy: p.y, tx: nx, ty: ny, how: 'push' });
    p.x = nx;
    p.y = ny;
  }
}

export function damageProp(ctx: Ctx, pr: Prop, dmg: number): void {
  const s = ctx.s;
  if (!destructible(pr)) return;
  pr.hp -= dmg;
  if (pr.hp > 0) return;
  s.props = s.props.filter((q) => q !== pr);
  ctx.ev.push({ t: 'prop', id: pr.id, x: pr.x, y: pr.y, kind: pr.kind, what: 'break' });
  if (pr.kind === 'barrel') ctx.pendingBlasts.push({ x: pr.x, y: pr.y, shape: 'plus', r: 1, dmg: 2, src: -1 });
  else if (ctx.rng.chance(0.5)) dropPickup(ctx, pr.x, pr.y, 'coin', 1);
}

export function blastTiles(s: GameState, x: number, y: number, shape: 'plus' | 'square', r: number): number[] {
  const out: number[] = [];
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) {
      if (shape === 'plus' && dx !== 0 && dy !== 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (!inMap(s, nx, ny)) continue;
      if (isOpaque(tileAt(s, nx, ny)) && !(dx === 0 && dy === 0)) continue;
      // plus-shaped blasts are stopped by walls
      if (shape === 'plus' && (Math.abs(dx) > 1 || Math.abs(dy) > 1)) {
        const mx = x + Math.sign(dx);
        const my = y + Math.sign(dy);
        if (isOpaque(tileAt(s, mx, my))) continue;
      }
      out.push(ny * s.map.w + nx);
    }
  return out;
}

/** Resolve queued explosions (chain reactions included). */
export function resolveBlasts(ctx: Ctx): void {
  const s = ctx.s;
  let guard = 0;
  const scorched = new Set<number>(); // each unit / the hero is hurt at most once per chain
  while (ctx.pendingBlasts.length && guard++ < 50) {
    const b = ctx.pendingBlasts.shift()!;
    const tiles = blastTiles(s, b.x, b.y, b.shape, b.r);
    ctx.ev.push({ t: 'explode', x: b.x, y: b.y, tiles });
    for (const i of tiles) {
      const x = i % s.map.w;
      const y = Math.floor(i / s.map.w);
      const u = unitAt(s, x, y);
      if (u && u.id !== b.src && !scorched.has(u.id)) {
        scorched.add(u.id);
        hitUnit(ctx, u, b.dmg, { dir: -1, kind: 'blast', byPlayer: b.src === 0 || b.src === -1 });
      }
      if (isPlayerAt(s, x, y) && !scorched.has(0)) {
        scorched.add(0);
        hurtPlayer(ctx, b.dmg, b.x, b.y, 'blast', '爆発');
      }
      const pr = propAt(s, x, y);
      if (pr && destructible(pr)) damageProp(ctx, pr, 9);
      if (tileAt(s, x, y) === T.Grass) igniteTile(ctx, x, y, 2);
      // bombs caught in a blast go off too
      for (const bb of [...s.bombs]) {
        if (bb.x === x && bb.y === y) {
          s.bombs = s.bombs.filter((q) => q !== bb);
          ctx.pendingBlasts.push({ x: bb.x, y: bb.y, shape: bb.shape, r: bb.radius, dmg: bb.dmg, src: bb.owner === 0 ? 0 : -1 });
        }
      }
      // lit beetles chain
      const lit = unitAt(s, x, y);
      if (lit && lit.kind === 'beetle' && s.units.includes(lit)) killUnit(ctx, lit, 'blast', b.src === 0);
    }
  }
}

export function igniteTile(ctx: Ctx, x: number, y: number, turns: number): void {
  const s = ctx.s;
  const t = tileAt(s, x, y);
  if (!isWalkable(t) || t === T.Water) return;
  const f = s.fires.find((q) => q.x === x && q.y === y);
  if (f) f.turns = Math.max(f.turns, turns);
  else s.fires.push({ x, y, turns });
  if (t === T.Grass) s.map.tiles[y * s.map.w + x] = T.Floor;
}

