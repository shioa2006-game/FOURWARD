// The 10 direction items. Pressing a direction always takes your turn:
//  * if you can move, you move (how depends on the item's timing family),
//  * if you cannot (wall, pillar, monster, crate), you BRACE: you stay put and the
//    item still acts from where you stand. Bracing is the only way to "wait".

import { isWalkable, isOpaque, T } from './dungeon.ts';
import { DX, DY, rel, roughDirTo, cw, ccw, type Dir } from './geom.ts';
import { ITEMS } from './content.ts';
import type { ItemInst } from './types.ts';
import { type Ctx, type HitOpt, PLAYER, inMap, tileAt, unitAt, propAt, destructible, hitUnit, damageProp, canEnter } from './world.ts';

export type StepResult = 'moved' | 'unit' | 'prop' | 'wall';

export interface UseResult {
  used: boolean;
  moveDir: Dir | -1; // the hero changed tiles in this direction
}

/** ALERT = an awake monster is in view. Otherwise CALM: utility items don't spend themselves. */
export function isAlert(ctx: Ctx, vis: Set<number>): boolean {
  const w = ctx.s.map.w;
  return ctx.s.units.some((u) => u.awake && vis.has(u.y * w + u.x));
}

export function stepPlayer(ctx: Ctx, dir: Dir): StepResult {
  const s = ctx.s;
  const p = s.player;
  const x = p.x + DX[dir];
  const y = p.y + DY[dir];
  if (unitAt(s, x, y)) return 'unit';
  const pr = propAt(s, x, y);
  if (pr) return destructible(pr) ? 'prop' : 'wall';
  if (!inMap(s, x, y) || !isWalkable(tileAt(s, x, y))) return 'wall';
  ctx.ev.push({ t: 'move', id: PLAYER, fx: p.x, fy: p.y, tx: x, ty: y, how: 'step' });
  p.x = x;
  p.y = y;
  return 'moved';
}

function brace(ctx: Ctx, dir: Dir): void {
  ctx.ev.push({ t: 'brace', dir });
}

/** Strike tiles; each blow travels from the hero toward its tile. Returns #targets hit. */
function strike(ctx: Ctx, dir: Dir, tiles: { x: number; y: number }[], dmg: number, extra: Partial<HitOpt>, item: string, alert: boolean): number {
  const s = ctx.s;
  const p = s.player;
  const w = s.map.w;
  const valid = tiles.filter((t) => inMap(s, t.x, t.y) && !isOpaque(tileAt(s, t.x, t.y)));
  const targets = valid.map((t) => ({ t, u: unitAt(s, t.x, t.y), pr: propAt(s, t.x, t.y) }));
  const anything = targets.some((q) => q.u || (q.pr && destructible(q.pr)));
  if (anything || alert || ctx.preview) ctx.ev.push({ t: 'swing', id: PLAYER, dir, item, tiles: valid.map((t) => t.y * w + t.x) });
  let hits = 0;
  for (const q of targets) {
    if (q.u && s.units.includes(q.u)) {
      const bd = roughDirTo(p, q.t);
      hitUnit(ctx, q.u, dmg, { dir: bd, kind: item, byPlayer: true, ...extra });
      hits++;
    } else if (q.pr && destructible(q.pr) && s.props.includes(q.pr)) {
      damageProp(ctx, q.pr, dmg);
      hits++;
    }
  }
  return hits;
}

/** First thing along a line: unit, destructible prop or wall (pits/lava are passed over). */
export function firstInLine(ctx: Ctx, x: number, y: number, dir: Dir, range: number) {
  const s = ctx.s;
  for (let k = 1; k <= range; k++) {
    const tx = x + DX[dir] * k;
    const ty = y + DY[dir] * k;
    if (!inMap(s, tx, ty)) return null;
    const u = unitAt(s, tx, ty);
    if (u) return { what: 'unit' as const, k, x: tx, y: ty, u };
    const pr = propAt(s, tx, ty);
    if (pr) return destructible(pr) ? { what: 'prop' as const, k, x: tx, y: ty, pr } : null;
    if (isOpaque(tileAt(s, tx, ty))) return null;
  }
  return null;
}

/** Plain step (empty slot / item with nothing to do). If blocked: brace. */
export function plainStep(ctx: Ctx, dir: Dir): UseResult {
  const r = stepPlayer(ctx, dir);
  if (r === 'moved') return { used: true, moveDir: dir };
  brace(ctx, dir);
  return { used: true, moveDir: -1 };
}

export function useSlot(ctx: Ctx, dir: Dir, vis: Set<number>): UseResult {
  const s = ctx.s;
  const p = s.player;
  const it: ItemInst | null = p.slots[dir];
  if (!it) return plainStep(ctx, dir);
  const alert = isAlert(ctx, vis);
  const D = ITEMS[it.id];
  if (it.cd > 0) return plainStep(ctx, dir);
  if (D.charges > 0 && it.charges <= 0) return plainStep(ctx, dir);
  const star = it.star;
  const kills0 = ctx.killIds.size;

  switch (it.id) {
    // ---------------------------------------------------------------- LUNGE
    case 'sword':
    case 'hammer': {
      const r = stepPlayer(ctx, dir);
      if (r !== 'moved') brace(ctx, dir);
      const front = rel(p, dir, 1, 0);
      const hits =
        it.id === 'sword'
          ? strike(ctx, dir, [front], 2, {}, 'sword', alert)
          : strike(ctx, dir, [front], 1, { push: 2, stun: star ? 1 : 0 }, 'hammer', alert);
      if (it.id === 'hammer' && hits > 0) it.cd = D.cooldown + 1;
      if (it.id === 'sword' && star && ctx.killIds.size > kills0) {
        ctx.freeTurn = true;
        ctx.ev.push({ t: 'text', x: p.x, y: p.y - 0.7, text: '»', color: '#8fb8ff' });
      }
      return { used: true, moveDir: r === 'moved' ? dir : -1 };
    }
    // ---------------------------------------------------------------- SWEEP
    case 'axe': {
      const tiles = [rel(p, dir, 1, -1), rel(p, dir, 1, 0), rel(p, dir, 1, 1)];
      if (star) tiles.push(rel(p, dir, 0, -1), rel(p, dir, 0, 1));
      strike(ctx, dir, tiles, 1, {}, 'axe', alert);
      const r = stepPlayer(ctx, dir);
      if (r !== 'moved') brace(ctx, dir);
      return { used: true, moveDir: r === 'moved' ? dir : -1 };
    }
    // ---------------------------------------------------------------- HOLD
    case 'spear': {
      const reach = 2 + star;
      const tiles: { x: number; y: number }[] = [];
      let target = false;
      for (let k = 1; k <= reach; k++) {
        const t = rel(p, dir, k, 0);
        if (!inMap(s, t.x, t.y) || isOpaque(tileAt(s, t.x, t.y))) break;
        tiles.push(t);
        const pr = propAt(s, t.x, t.y);
        if (unitAt(s, t.x, t.y) || (pr && destructible(pr))) target = true;
        if (pr && !destructible(pr)) break;
      }
      if (!target) return plainStep(ctx, dir);
      strike(ctx, dir, tiles, 1, {}, 'spear', true);
      return { used: true, moveDir: -1 };
    }
    case 'fire':
    case 'frost': {
      const hit = firstInLine(ctx, p.x, p.y, dir, 5);
      if (!hit) return plainStep(ctx, dir);
      ctx.ev.push({ t: 'shot', fx: p.x, fy: p.y, tx: hit.x, ty: hit.y, kind: it.id });
      // Preview-only geometry uses the same ray/blocking rules as this attack.
      // No extra events or effects are added to normal play.
      if (ctx.preview) {
        const tiles: number[] = [];
        for (let k = 1; k <= (it.id === 'frost' && star ? 5 : hit.k); k++) {
          const x = p.x + DX[dir] * k, y = p.y + DY[dir] * k;
          if (!inMap(s, x, y) || isOpaque(tileAt(s, x, y))) break;
          tiles.push(y * s.map.w + x);
        }
        if (it.id === 'fire' && star && hit.what === 'unit') {
          for (let d = 0; d < 4; d++) {
            const x = hit.x + DX[d], y = hit.y + DY[d];
            if (inMap(s, x, y) && !isOpaque(tileAt(s, x, y))) tiles.push(y * s.map.w + x);
          }
        }
        ctx.ev.push({ t: 'swing', id: PLAYER, dir, item: it.id, tiles });
      }
      if (it.id === 'fire') {
        if (hit.what === 'unit') {
          hitUnit(ctx, hit.u, 2, { dir, kind: 'fire', byPlayer: true, burn: 2 });
          if (star) {
            // flames leap to everything next to the target
            for (let d = 0; d < 4; d++) {
              const o = unitAt(s, hit.x + DX[d], hit.y + DY[d]);
              if (o) hitUnit(ctx, o, 0, { dir: -1, kind: 'fire', byPlayer: true, burn: 2 });
            }
          }
        } else damageProp(ctx, hit.pr, 9);
      } else {
        const victims = [];
        if (star) {
          for (let k = 1; k <= 5; k++) {
            const tx = p.x + DX[dir] * k;
            const ty = p.y + DY[dir] * k;
            if (!inMap(s, tx, ty) || isOpaque(tileAt(s, tx, ty))) break;
            const u = unitAt(s, tx, ty);
            if (u) victims.push(u);
          }
        } else if (hit.what === 'unit') victims.push(hit.u);
        for (const u of victims) hitUnit(ctx, u, 0, { dir, kind: 'frost', byPlayer: true, stun: 2, freeze: true });
        if (hit.what === 'prop') damageProp(ctx, hit.pr, 1);
      }
      it.cd = D.cooldown + 1;
      return { used: true, moveDir: -1 };
    }
    // ---------------------------------------------------------------- STEP + SELF
    case 'shield': {
      const r = stepPlayer(ctx, dir);
      if (r === 'prop') damageProp(ctx, propAt(s, p.x + DX[dir], p.y + DY[dir])!, 1);
      p.guard = dir;
      p.guardAll = star > 0; // ★: also covers both neighbouring sides
      ctx.ev.push({ t: 'status', id: PLAYER, x: p.x, y: p.y, status: 'guard' });
      if (r !== 'moved') brace(ctx, dir);
      return { used: true, moveDir: r === 'moved' ? dir : -1 };
    }
    case 'flask': {
      const missing = p.maxHp - p.hp;
      if (missing < 2 && p.hp > 1) return plainStep(ctx, dir);
      const r = stepPlayer(ctx, dir);
      if (r !== 'moved') brace(ctx, dir);
      const amt = Math.min(2, missing);
      p.hp += amt;
      it.charges--;
      ctx.ev.push({ t: 'heal', id: PLAYER, x: p.x, y: p.y, amount: amt });
      return { used: true, moveDir: r === 'moved' ? dir : -1 };
    }
    case 'bomb': {
      if (!alert) return plainStep(ctx, dir);
      const fx = p.x;
      const fy = p.y;
      const r = stepPlayer(ctx, dir);
      let bx = fx;
      let by = fy;
      if (r === 'unit') {
        // pressed into a monster: plant it under the monster instead
        bx = fx + DX[dir];
        by = fy + DY[dir];
      } else if (r !== 'moved') {
        brace(ctx, dir);
        return { used: true, moveDir: -1 };
      }
      s.bombs.push({ id: s.nextId++, x: bx, y: by, timer: 3, radius: 1, dmg: 2, shape: star ? 'square' : 'plus', owner: 0 });
      ctx.ev.push({ t: 'sfx', name: 'fuse' });
      it.cd = D.cooldown + 1;
      return { used: true, moveDir: r === 'moved' ? dir : -1 };
    }
    // ---------------------------------------------------------------- DASH
    case 'boots': {
      const fx = p.x;
      const fy = p.y;
      let k = 0;
      while (k < 3 && canEnter(s, p.x + DX[dir], p.y + DY[dir])) {
        p.x += DX[dir];
        p.y += DY[dir];
        k++;
        if (tileAt(s, p.x, p.y) === T.Stairs) break; // the dash stops ON the stairs
      }
      if (k > 0) ctx.ev.push({ t: 'move', id: PLAYER, fx, fy, tx: p.x, ty: p.y, how: 'dash' });
      const u = unitAt(s, p.x + DX[dir], p.y + DY[dir]);
      if (u) {
        ctx.ev.push({ t: 'swing', id: PLAYER, dir, item: 'hammer', tiles: [u.y * s.map.w + u.x] });
        hitUnit(ctx, u, 1, { dir, kind: 'ram', byPlayer: true, push: 1, stun: star ? 1 : 0 });
      } else {
        const pr = propAt(s, p.x + DX[dir], p.y + DY[dir]);
        if (pr && destructible(pr)) damageProp(ctx, pr, 2);
      }
      if (k === 0 && !u) {
        brace(ctx, dir);
        return { used: true, moveDir: -1 };
      }
      it.cd = D.cooldown + 1;
      return { used: true, moveDir: k > 0 ? dir : -1 };
    }
  }
  return plainStep(ctx, dir);
}

/** Would pressing this slot do its special thing right now? (dim icons otherwise) */
export function slotArmed(ctx: Ctx, dir: Dir, vis: Set<number>): boolean {
  const s = ctx.s;
  const p = s.player;
  const it = p.slots[dir];
  if (!it) return false;
  const D = ITEMS[it.id];
  if (it.cd > 0) return false;
  if (D.charges > 0 && it.charges <= 0) return false;
  if (it.id === 'flask') return p.maxHp - p.hp >= 2 || p.hp === 1;
  if (it.id === 'bomb') return isAlert(ctx, vis);
  if (it.id === 'spear') {
    for (let k = 1; k <= 2 + it.star; k++) {
      const t = rel(p, dir, k, 0);
      if (!inMap(s, t.x, t.y) || isOpaque(tileAt(s, t.x, t.y))) break;
      if (unitAt(s, t.x, t.y)) return true;
    }
    return false;
  }
  if (it.id === 'fire' || it.id === 'frost') return !!firstInLine(ctx, p.x, p.y, dir, 5);
  return true;
}

/** Sides the hero's shield covers this enemy phase. */
export function guardedSides(p: { guard: number; guardAll: boolean }): Dir[] {
  if (p.guard < 0) return [];
  const d = p.guard as Dir;
  return p.guardAll ? [d, cw(d), ccw(d)] : [d];
}
