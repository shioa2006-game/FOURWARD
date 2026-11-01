// The turn engine: one call to act() = one hero action + the enemies' reply.

import { T, isWalkable } from './dungeon.ts';
import { DX, DY, opposite, type Dir } from './geom.ts';
import { ITEMS, LAST_FLOOR, FLOORS } from './content.ts';
import { computeVisible } from './fov.ts';
import type { GameEvent, GameState, ItemInst } from './types.ts';
import { enemyPhase, zoneOf, delayedThreats, bossReactions } from './ai.ts';
import { useSlot, slotArmed } from './items.ts';
import { buildFloor, newItem } from './floor.ts';
import { type Ctx, PLAYER, mkCtx, propAt, unitAt, hitUnit, hurtPlayer, resolveBlasts, killUnit, igniteTile, tileAt, blastTiles } from './world.ts';

export const SAVE_VERSION = 3;

export interface ActResult {
  used: boolean;
  events: GameEvent[];
  descended: boolean;
  ctx: Ctx | null;
}

export function newRun(seed: number, kit: 'knight' | 'lancer' | 'mage' = 'knight'): GameState {
  const slots: (ItemInst | null)[] = [null, null, null, null];
  if (kit === 'knight') {
    slots[0] = newItem('sword');
    slots[2] = newItem('flask');
  } else if (kit === 'lancer') {
    slots[0] = newItem('spear');
    slots[1] = newItem('shield');
    slots[2] = newItem('flask');
    slots[3] = newItem('hammer');
  } else {
    slots[0] = newItem('fire');
    slots[3] = newItem('frost');
    slots[2] = newItem('flask');
  }
  const s: GameState = {
    version: SAVE_VERSION,
    seed,
    floor: 1,
    turn: 0,
    status: 'play',
    map: { w: 1, h: 1, tiles: [0], room: [-1], rooms: [], doors: [], start: 0, stairs: 0, startRoom: 0, stairsRoom: 0, attempts: 0 },
    explored: [],
    stairsOpen: true,
    player: { x: 0, y: 0, hp: 5, maxHp: 5, slots, coins: 0, guard: -1, guardAll: false, lastDir: -1, streak: 0, stun: 0, burn: 0 },
    units: [],
    props: [],
    pickups: [],
    bombs: [],
    fires: [],
    nextId: 1,
    rng: seed ^ 0x5a5a5a5a,
    stats: { kills: 0, damageTaken: 0, turns: 0, floorsCleared: 0, itemsFound: 0, retries: 0, startTime: 0, endTime: 0 },
    bossId: 0,
    killedBy: '',
    checkpointFloor: 1,
  };
  buildFloor(s, 1);
  revealAround(s);
  return s;
}

export function zoneOfFloor(floor: number): number {
  return FLOORS[Math.max(1, Math.min(LAST_FLOOR, floor)) - 1].zone;
}

export function visibleSet(s: GameState): Set<number> {
  return computeVisible(s.map, s.player.x, s.player.y);
}

export function revealAround(s: GameState): Set<number> {
  const vis = visibleSet(s);
  for (const i of vis) s.explored[i] = 1;
  return vis;
}

/** Bumping into pedestals / anvils / fountains / chests. null = no interaction. */
function interact(ctx: Ctx, dir: Dir): boolean | null {
  const s = ctx.s;
  const p = s.player;
  const pr = propAt(s, p.x + DX[dir], p.y + DY[dir]);
  if (!pr) return null;
  const slot = p.slots[dir];
  switch (pr.kind) {
    case 'pedestal': {
      if (pr.lockRoom >= 0) {
        ctx.ev.push({ t: 'sfx', name: 'deny' });
        return false;
      }
      if (!pr.item && !slot) return false;
      if (pr.price > 0 && pr.item) {
        if (p.coins < pr.price) {
          ctx.ev.push({ t: 'sfx', name: 'deny' });
          return false;
        }
        p.coins -= pr.price;
        pr.price = 0;
      }
      // duplicate -> merge into a star upgrade
      if (pr.item && slot && pr.item.id === slot.id && slot.star === 0) {
        slot.star = 1;
        if (ITEMS[slot.id].charges > 0) slot.charges += 1;
        pr.item = null;
        ctx.ev.push({ t: 'upgrade', dir, item: slot.id });
        s.stats.itemsFound++;
        return true;
      }
      const incoming = pr.item;
      pr.item = slot;
      p.slots[dir] = incoming;
      if (incoming) {
        incoming.cd = 0;
        s.stats.itemsFound++;
      }
      ctx.ev.push({ t: 'equip', dir, item: incoming ? incoming.id : '', old: slot ? slot.id : null, propId: pr.id });
      return true;
    }
    case 'anvil': {
      if (pr.used || !slot || slot.star > 0 || p.coins < pr.price) {
        ctx.ev.push({ t: 'sfx', name: 'deny' });
        return false;
      }
      p.coins -= pr.price;
      slot.star = 1;
      if (ITEMS[slot.id].charges > 0) slot.charges += 1;
      pr.used = true;
      ctx.ev.push({ t: 'upgrade', dir, item: slot.id });
      return true;
    }
    case 'fountain': {
      if (pr.used) return false;
      pr.used = true;
      const before = p.hp;
      p.hp = p.maxHp;
      for (const it of p.slots) if (it && ITEMS[it.id].charges > 0) it.charges = ITEMS[it.id].charges + (it.id === 'flask' ? it.star : 0);
      ctx.ev.push({ t: 'heal', id: PLAYER, x: p.x, y: p.y, amount: Math.max(0, p.hp - before) });
      return true;
    }
    case 'chest': {
      if (pr.used) return false;
      pr.used = true;
      const amt = ctx.rng.int(3, 5);
      p.coins += amt;
      ctx.ev.push({ t: 'prop', id: pr.id, x: pr.x, y: pr.y, kind: 'chest', what: 'open' });
      ctx.ev.push({ t: 'pickup', kind: 'coin', amount: amt, x: pr.x, y: pr.y });
      return true;
    }
    default:
      return null; // barrels / crates are hit by items
  }
}

/** Arriving on a tile: pickups, hazards, turnstiles. Returns true if the stairs were reached. */
function arrive(ctx: Ctx): boolean {
  const s = ctx.s;
  const p = s.player;
  // pickups
  for (const pk of [...s.pickups]) {
    if (pk.x !== p.x || pk.y !== p.y) continue;
    if (pk.kind === 'heart') {
      if (p.hp >= p.maxHp) continue;
      const amt = Math.min(pk.amount, p.maxHp - p.hp);
      p.hp += amt;
      ctx.ev.push({ t: 'pickup', kind: 'heart', amount: amt, x: p.x, y: p.y });
    } else {
      p.coins += pk.amount;
      ctx.ev.push({ t: 'pickup', kind: pk.kind, amount: pk.amount, x: p.x, y: p.y });
    }
    s.pickups = s.pickups.filter((q) => q !== pk);
  }
  const t = tileAt(s, p.x, p.y);
  if (t === T.Spikes) hurtPlayer(ctx, 1, p.x, p.y, 'spikes', 'トゲ');
  if (s.fires.some((f) => f.x === p.x && f.y === p.y)) p.burn = Math.max(p.burn, 1);
  return t === T.Stairs && s.stairsOpen && s.status === 'play';
}

export function act(s: GameState, dir: Dir, preview = false): ActResult {
  if (s.status !== 'play') return { used: false, events: [], descended: false, ctx: null };
  const ctx = mkCtx(s, preview);
  const p = s.player;
  const vis0 = visibleSet(s);
  const seenBefore = new Set(s.units.filter((u) => u.awake && vis0.has(u.y * s.map.w + u.x)).map((u) => u.id));
  p.guard = -1;
  p.guardAll = false;
  const sx = p.x;
  const sy = p.y;
  let used = interact(ctx, dir);
  let moveDir: Dir | -1 = -1;
  if (used === null) {
    const r = useSlot(ctx, dir, vis0);
    used = r.used;
    moveDir = r.moveDir;
  }
  if (!used) {
    // Safety valve: if NO direction can do anything (walled in by monsters with empty
    // hands), any press simply passes the turn so the game can never lock up.
    if (!preview && !hasAnyAction(s)) {
      used = true;
      ctx.ev.push({ t: 'text', x: p.x, y: p.y - 0.6, text: '…', color: '#b7bcc7' });
    } else {
      const ev = ctx.ev.length ? ctx.ev : [{ t: 'bump', dir } as GameEvent];
      return { used: false, events: ev, descended: false, ctx };
    }
  }
  resolveBlasts(ctx);
  bossReactions(ctx);
  const moved = p.x !== sx || p.y !== sy;
  if (moved && moveDir < 0) moveDir = dir;
  p.lastDir = dir;
  let reachedStairs = false;
  if (moved && s.status === 'play') reachedStairs = arrive(ctx);
  resolveBlasts(ctx);
  if (s.status !== 'play') return finish(ctx, false);
  if (reachedStairs) {
    if (!preview) descend(ctx);
    return finish(ctx, true);
  }
  const vis = revealAround(s);
  callTricks(ctx, 0, ctx.ev.length, true);
  if (!ctx.freeTurn) {
    ctx.ev.push({ t: 'enemyPhase' });
    const from = ctx.ev.length;
    enemyPhase(ctx, vis, moveDir, seenBefore);
    resolveBlasts(ctx);
    bossReactions(ctx);
    callTricks(ctx, from, ctx.ev.length, false);
  }
  // a free turn (Sword★ kill) freezes the whole world: no enemy phase, no ticking
  const fromRound = ctx.ev.length;
  if (s.status === 'play' && !ctx.freeTurn) endRound(ctx);
  resolveBlasts(ctx);
  if (ctx.ev.slice(fromRound).filter((e) => e.t === 'death' && e.how === 'blast').length >= 2) ctx.ev.push({ t: 'trick', text: '連鎖！', x: p.x, y: p.y });
  bossReactions(ctx);
  openCages(ctx);
  s.turn++;
  s.stats.turns++;
  revealAround(s);
  return finish(ctx, false);
}

export function hasAnyAction(s: GameState): boolean {
  for (const d of [0, 1, 2, 3] as Dir[]) {
    const c = cloneState(s);
    if (act(c, d, true).used) return true;
  }
  return false;
}

/**
 * Name the emergent combos the moment they happen (落下! 激突! 連鎖! ...), so players
 * notice that the terrain and the monsters themselves are weapons.
 */
function callTricks(ctx: Ctx, from: number, to: number, heroPhase: boolean): void {
  if (ctx.preview) return;
  const p = ctx.s.player;
  const deaths = ctx.ev.slice(from, to).filter((e): e is Extract<GameEvent, { t: 'death' }> => e.t === 'death' && e.id !== PLAYER && e.how !== 'despawn');
  if (!deaths.length) return;
  let text = '';
  if (heroPhase) {
    if (deaths.some((d) => d.how === 'fall')) text = '落下！';
    else if (deaths.filter((d) => d.how === 'blast').length >= 2) text = '連鎖！';
    else if (deaths.some((d) => d.how === 'slam')) text = '激突！';
    else if (deaths.length >= 2) text = 'まとめて！';
  } else {
    // monsters killed during their own phase were killed by monsters (beams, slams, blasts)
    text = deaths.length >= 2 ? '同士討ち×' + deaths.length : '同士討ち！';
  }
  if (text) ctx.ev.push({ t: 'trick', text, x: p.x, y: p.y });
}

function openCages(ctx: Ctx): void {
  const s = ctx.s;
  for (const pr of s.props) {
    if (pr.lockRoom < 0) continue;
    if (s.units.some((u) => u.home === pr.lockRoom)) continue;
    pr.lockRoom = -1;
    ctx.ev.push({ t: 'prop', id: pr.id, x: pr.x, y: pr.y, kind: pr.kind, what: 'unlock' });
  }
}

function finish(ctx: Ctx, descended: boolean): ActResult {
  ctx.s.rng = ctx.rng.s;
  return { used: true, events: ctx.ev, descended, ctx };
}

function endRound(ctx: Ctx): void {
  const s = ctx.s;
  const p = s.player;
  const vis = visibleSet(s);
  // burning
  for (const u of [...s.units]) {
    if (u.burn > 0 && s.units.includes(u)) {
      u.burn--;
      hitUnit(ctx, u, 1, { dir: -1, kind: 'burn', byPlayer: true });
    }
  }
  if (p.burn > 0) {
    p.burn--;
    hurtPlayer(ctx, 1, p.x, p.y, 'burn', '炎');
  }
  // fires: occupants catch fire, flames spread through grass, then die down
  const spread: [number, number][] = [];
  for (const f of s.fires) {
    const u = unitAt(s, f.x, f.y);
    if (u) u.burn = Math.max(u.burn, 1);
    for (const [dx, dy] of [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ]) {
      if (tileAt(s, f.x + dx, f.y + dy) === T.Grass) spread.push([f.x + dx, f.y + dy]);
    }
    f.turns--;
  }
  s.fires = s.fires.filter((f) => f.turns > 0);
  for (const [x, y] of spread) igniteTile(ctx, x, y, 2);
  // bombs
  for (const b of [...s.bombs]) {
    b.timer--;
    if (b.timer <= 0) {
      s.bombs = s.bombs.filter((q) => q !== b);
      ctx.pendingBlasts.push({ x: b.x, y: b.y, shape: b.shape, r: b.radius, dmg: b.dmg, src: b.owner === 0 ? 0 : -1 });
    }
  }
  // lit beetles
  for (const u of [...s.units]) {
    if (u.kind === 'beetle' && u.mode === 1 && s.units.includes(u)) {
      if (u.stun > 0) continue;
      u.timer--;
      if (u.timer <= 0) killUnit(ctx, u, 'hit', false);
    }
  }
  resolveBlasts(ctx);
  // cooldowns
  for (const it of p.slots) if (it && it.cd > 0) it.cd--;
  // wake sleepers that can see the hero
  const pr = s.map.room[p.y * s.map.w + p.x];
  for (const u of s.units) {
    if (u.awake) continue;
    if (!vis.has(u.y * s.map.w + u.x)) continue;
    const ur = s.map.room[u.y * s.map.w + u.x];
    const dist = Math.abs(u.x - p.x) + Math.abs(u.y - p.y);
    if ((pr >= 0 && ur === pr && dist <= 7) || dist <= 3) {
      u.awake = true;
      ctx.ev.push({ t: 'status', id: u.id, x: u.x, y: u.y, status: 'wake' });
      if (u.boss) ctx.ev.push({ t: 'sfx', name: 'boss' });
    }
  }
}

function descend(ctx: Ctx): void {
  const s = ctx.s;
  s.stats.floorsCleared++;
  const next = s.floor + 1;
  if (next > LAST_FLOOR) {
    s.status = 'won';
    return;
  }
  ctx.ev.push({ t: 'descend', floor: next });
  buildFloor(s, next);
  // catching your breath on the stairs: +1 heart
  s.player.hp = Math.min(s.player.maxHp, s.player.hp + 1);
  if (zoneOfFloor(next) !== zoneOfFloor(next - 1)) s.checkpointFloor = next;
  revealAround(s);
}

// ---------------------------------------------------------------------------
// threat & previews (pure: never mutate the live state)

export interface Threat {
  now: Map<number, number>; // tile -> damage if you end your turn there
  later: Map<number, number>; // tile -> turns until a delayed blast
}

export function threatMap(s: GameState, vis?: Set<number>): Threat {
  const v = vis ?? visibleSet(s);
  const now = new Map<number, number>();
  const later = new Map<number, number>();
  const w = s.map.w;
  for (const u of s.units) {
    if (!v.has(u.y * w + u.x)) continue;
    const base = u.kind === 'boss_lancer' && u.mode === 1 ? 2 : ENEMY_DMG[u.kind] ?? 1;
    for (const i of zoneOf(s, u)) {
      let dmg = base;
      if (u.kind === 'boss_warden') dmg = wardenDamageAt(u, i % w, Math.floor(i / w));
      now.set(i, (now.get(i) ?? 0) + dmg);
    }
  }
  const fireTiles = new Set(s.fires.map((f) => f.y * w + f.x));
  for (const [i, t] of delayedThreats(s)) {
    // blasts hit for 2; a burning tile only sets you alight (1)
    const blast = s.bombs.length > 0 || s.units.some((u) => u.kind === 'beetle' && u.mode === 1);
    const dmg = fireTiles.has(i) && !(blast && t <= 1 && blastCovers(s, i)) ? 1 : 2;
    if (t <= 1) now.set(i, (now.get(i) ?? 0) + dmg);
    else later.set(i, t);
  }
  return { now, later };
}

import { ENEMIES } from './content.ts';
import { wardenSide } from './world.ts';
import { roughDirTo } from './geom.ts';
function wardenDamageAt(u: { x: number; y: number; mode: number; kind: string; id: number }, x: number, y: number): number {
  const dx = x - u.x;
  const dy = y - u.y;
  const side = Math.abs(dx) === Math.abs(dy) ? (dx > 0 ? 1 : 3) : roughDirTo(u, { x, y });
  return wardenSide(u as never, side as Dir) === 'hammer' ? 2 : 1;
}
const ENEMY_DMG: Record<string, number> = Object.fromEntries(Object.entries(ENEMIES).map(([k, d]) => [k, d.dmg]));

/** Is tile i inside a blast that goes off at the end of this round? */
function blastCovers(s: GameState, i: number): boolean {
  for (const b of s.bombs) if (b.timer <= 1 && blastTiles(s, b.x, b.y, b.shape, b.radius).includes(i)) return true;
  for (const u of s.units) if (u.kind === 'beetle' && u.mode === 1 && u.timer <= 1 && blastTiles(s, u.x, u.y, 'square', 1).includes(i)) return true;
  return false;
}

export interface Preview {
  dir: Dir;
  valid: boolean;
  dest: { x: number; y: number } | null;
  actionDest: { x: number; y: number } | null;
  path: number[];
  delayedTiles: number[];
  hitIds: number[];
  killIds: number[];
  dmgTaken: number;
  heal: number;
  badge: 'kill' | 'hit' | 'danger' | 'heal' | 'swap' | 'stairs' | 'upgrade' | 'blocked' | 'guard' | 'none';
  tiles: number[];
  /** top-left corner of the button: what happens to YOU */
  you: 'none' | 'hurt' | 'death';
  /** top-right corner: what happens to THEM / the world */
  them: 'none' | 'kill' | 'hit' | 'swap' | 'stairs' | 'upgrade' | 'brace' | 'heal' | 'chest';
}

export function cloneState(s: GameState): GameState {
  return structuredClone(s);
}

export function previewDir(s: GameState, dir: Dir): Preview {
  const c = cloneState(s);
  const hp0 = c.player.hp;
  const target = propAt(c, c.player.x + DX[dir], c.player.y + DY[dir]);
  const r = act(c, dir, true);
  const res: Preview = { dir, valid: r.used, dest: null, actionDest: null, path: [], delayedTiles: [], hitIds: [], killIds: [], dmgTaken: 0, heal: 0, badge: 'none', tiles: [], you: 'none', them: 'none' };
  if (!r.used || !r.ctx) {
    res.badge = 'blocked';
    return res;
  }
  res.dest = { x: c.player.x, y: c.player.y };
  // only hits made during the hero's own action count for reticles
  const enemyIdx = r.events.findIndex((e) => e.t === 'enemyPhase');
  const heroEvents = enemyIdx >= 0 ? r.events.slice(0, enemyIdx) : r.events;
  res.actionDest = { x: s.player.x, y: s.player.y };
  const hit = new Set<number>();
  const kill = new Set<number>();
  for (const e of heroEvents) {
    if (e.t === 'move' && e.id === PLAYER) {
      const steps = Math.max(Math.abs(e.tx - e.fx), Math.abs(e.ty - e.fy));
      for (let k = 1; k <= steps; k++) res.path.push((e.fy + Math.sign(e.ty - e.fy) * k) * s.map.w + e.fx + Math.sign(e.tx - e.fx) * k);
      res.actionDest = { x: e.tx, y: e.ty };
    }
    if (e.t === 'damage' && e.id !== PLAYER) hit.add(e.id);
    if (e.t === 'block' && e.id !== PLAYER) hit.add(e.id);
    if (e.t === 'status' && e.id !== PLAYER) hit.add(e.id);
    if (e.t === 'death' && e.id !== PLAYER) kill.add(e.id);
    if (e.t === 'swing' && e.id === PLAYER) for (const t of e.tiles) res.tiles.push(t);
    if (e.t === 'explode') res.tiles.push(...e.tiles);
    if (e.t === 'prop' && e.what === 'break') res.tiles.push(e.y * s.map.w + e.x);
    if (e.t === 'heal' && e.id === PLAYER) res.heal += e.amount;
    if (e.t === 'pickup' && e.kind === 'heart') res.heal += e.amount;
  }
  for (const b of c.bombs) {
    if (b.owner === PLAYER && !s.bombs.some((old) => old.id === b.id)) res.delayedTiles.push(...blastTiles(c, b.x, b.y, b.shape, b.radius));
  }
  res.tiles = [...new Set(res.tiles)];
  res.hitIds = [...hit];
  res.killIds = [...kill];
  res.dmgTaken = Math.max(0, hp0 - c.player.hp + res.heal);
  if (c.status === 'dead') res.dmgTaken = Math.max(res.dmgTaken, hp0);
  const braced = heroEvents.some((ev) => ev.t === 'brace');
  res.you = c.status === 'dead' ? 'death' : res.dmgTaken > 0 ? 'hurt' : 'none';
  if (r.descended) res.them = 'stairs';
  else if (target && target.kind === 'pedestal') res.them = 'swap';
  else if (target && target.kind === 'anvil') res.them = 'upgrade';
  else if (target && (target.kind === 'chest' || target.kind === 'fountain') && !target.used) res.them = 'chest';
  else if (kill.size) res.them = 'kill';
  else if (hit.size) res.them = 'hit';
  else if (res.heal > 0) res.them = 'heal';
  else if (braced) res.them = 'brace';
  if (r.descended) res.badge = 'stairs';
  else if (target && target.kind === 'pedestal') res.badge = 'swap';
  else if (target && target.kind === 'anvil') res.badge = 'upgrade';
  else if (res.dmgTaken > 0) res.badge = 'danger';
  else if (kill.size) res.badge = 'kill';
  else if (hit.size) res.badge = 'hit';
  else if (res.heal > 0) res.badge = 'heal';
  else if (c.player.guard >= 0) res.badge = 'guard';
  return res;
}

export function previewAll(s: GameState): Preview[] {
  return ([0, 1, 2, 3] as Dir[]).map((d) => previewDir(s, d));
}

export function armedSlots(s: GameState): boolean[] {
  const ctx = mkCtx(s, true);
  const vis = visibleSet(s);
  return ([0, 1, 2, 3] as Dir[]).map((d) => slotArmed(ctx, d, vis));
}

/** Is any enemy awake and visible? (used to stop key-repeat walking) */
export function inCombat(s: GameState): boolean {
  const vis = visibleSet(s);
  const w = s.map.w;
  return s.units.some((u) => u.awake && vis.has(u.y * w + u.x)) || s.bombs.length > 0;
}

export function isStairsTile(s: GameState, x: number, y: number): boolean {
  return tileAt(s, x, y) === T.Stairs;
}

export { isWalkable, opposite };
