// Builds a floor: BSP map + props, items, enemies, boss. Guarantees reachability of
// the stairs and of every pedestal even after blocking props are placed.

import { T, generateFloor, isWalkable, bfs } from './dungeon.ts';
import { Rng, hashSeed } from './rng.ts';
import { FLOORS, ITEMS, ENEMIES, ALL_ITEMS } from './content.ts';
import type { GameState, ItemId, ItemInst, Prop, PropKind } from './types.ts';
import { makeUnit } from './ai.ts';

export function newItem(id: ItemId, star = 0): ItemInst {
  return { id, star, cd: 0, charges: ITEMS[id].charges + (id === 'flask' ? star : 0) };
}

export function buildFloor(s: GameState, floorNum: number): void {
  const spec = FLOORS[Math.min(FLOORS.length, floorNum) - 1];
  const map = generateFloor(hashSeed(s.seed, floorNum, 0xf100), spec.gen);
  const rng = new Rng(hashSeed(s.seed, floorNum, 0xbeef));
  s.map = map;
  s.floor = floorNum;
  s.explored = new Array(map.w * map.h).fill(0);
  s.stairsOpen = !spec.boss;
  s.units = [];
  s.props = [];
  s.pickups = [];
  s.bombs = [];
  s.fires = [];
  s.bossId = 0;
  const p = s.player;
  p.x = map.start % map.w;
  p.y = Math.floor(map.start / map.w);
  p.guard = -1;
  p.guardAll = false;
  p.burn = 0;
  for (const it of p.slots) {
    if (!it) continue;
    it.cd = 0;
    if (ITEMS[it.id].charges > 0) it.charges = ITEMS[it.id].charges + (it.id === 'flask' ? it.star : 0);
  }

  const w = map.w;
  const doorSet = new Set(map.doors);
  const nearDoor = (x: number, y: number) => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (doorSet.has((y + dy) * w + x + dx)) return true;
    return false;
  };
  const reserved = new Set<number>();
  for (const c of [map.start, map.stairs]) {
    const cx = c % w;
    const cy = Math.floor(c / w);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) reserved.add((cy + dy) * w + cx + dx);
  }
  const occupied = new Set<number>();
  const roomTiles = (roomId: number, interiorOnly: boolean): number[] => {
    const r = map.rooms[roomId];
    const out: number[] = [];
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++) {
        const i = y * w + x;
        if (map.tiles[i] !== T.Floor && map.tiles[i] !== T.Grass) continue;
        if (reserved.has(i) || occupied.has(i)) continue;
        if (nearDoor(x, y)) continue;
        if (interiorOnly && (x === r.x || y === r.y || x === r.x + r.w - 1 || y === r.y + r.h - 1) && r.w > 3 && r.h > 3) continue;
        out.push(i);
      }
    return out;
  };

  const reachableOK = (): boolean => {
    const blocked = new Set(s.props.map((q) => q.y * w + q.x));
    const dist = bfs(map.tiles, w, map.h, map.start, () => true);
    void dist;
    const d = bfsBlocked(map.tiles, w, map.h, map.start, blocked);
    if (d[map.stairs] < 0) return false;
    for (const dd of map.doors) if (d[dd] < 0) return false;
    // every prop must be touchable from at least one reachable side
    for (const q of s.props) {
      const ok = [
        [0, -1],
        [1, 0],
        [0, 1],
        [-1, 0],
      ].some(([dx, dy]) => {
        const ni = (q.y + dy) * w + q.x + dx;
        return d[ni] >= 0;
      });
      if (!ok) return false;
    }
    return true;
  };

  const openAround = (i: number): boolean => {
    const x = i % w;
    const y = Math.floor(i / w);
    for (const [dx, dy] of [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ]) {
      const ni = (y + dy) * w + x + dx;
      if (!isWalkable(map.tiles[ni]) || occupied.has(ni) || s.props.some((q) => q.y * w + q.x === ni)) return false;
    }
    return true;
  };
  const openCount = (i: number): number => {
    const x = i % w;
    const y = Math.floor(i / w);
    let n = 0;
    for (const [dx, dy] of [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ]) {
      const ni = (y + dy) * w + x + dx;
      if (isWalkable(map.tiles[ni]) && !occupied.has(ni) && !s.props.some((q) => q.y * w + q.x === ni)) n++;
    }
    return n;
  };
  const placeProp = (kind: PropKind, roomIds: number[], extra: Partial<Prop> = {}, interior = true, at: number[] | null = null): Prop | null => {
    const ids = rng.shuffle([...roomIds]);
    for (const rid of at ? [-1] : ids) {
      let cands = at ?? rng.shuffle(roomTiles(rid, interior));
      // pedestals / anvils want to be bumpable from every side (so any slot can take
      // the item); accept 3 open sides in cramped rooms
      if (kind === 'pedestal' || kind === 'anvil') {
        const four = cands.filter(openAround);
        cands = four.length ? four : cands.filter((i) => openCount(i) >= 3);
      }
      // never crowd an existing pedestal / anvil: every side of it must stay bumpable
      cands = cands.filter((i) => {
        const x = i % w;
        const y = Math.floor(i / w);
        return !s.props.some((q) => (q.kind === 'pedestal' || q.kind === 'anvil') && Math.abs(q.x - x) + Math.abs(q.y - y) === 1);
      });
      for (const i of cands.slice(0, 8)) {
        if (at && (occupied.has(i) || reserved.has(i) && i !== at[0])) continue;
        const prop: Prop = { id: s.nextId++, kind, x: i % w, y: Math.floor(i / w), item: null, price: 0, hp: kind === 'barrel' || kind === 'crate' ? 1 : 0, used: false, lockRoom: -1, ...extra };
        s.props.push(prop);
        if (reachableOK()) {
          occupied.add(i);
          return prop;
        }
        s.props.pop();
      }
    }
    return null;
  };

  const roomIds = map.rooms.map((r) => r.id);
  const nonStart = roomIds.filter((id) => id !== map.startRoom);
  const arenaId = map.rooms.findIndex((r) => r.tags.includes('arena'));
  const normalRooms = nonStart.filter((id) => id !== arenaId);

  // --- items on pedestals
  const owned = new Set(p.slots.filter(Boolean).map((it) => it!.id));
  const ZONE_WEIGHTS: Record<ItemId, number>[] = [
    { sword: 2, spear: 4, axe: 4, hammer: 2, fire: 2, frost: 1, shield: 4, flask: 1, boots: 1, bomb: 1 },
    { sword: 2, spear: 3, axe: 2, hammer: 4, fire: 2, frost: 3, shield: 3, flask: 1, boots: 4, bomb: 2 },
    { sword: 2, spear: 2, axe: 2, hammer: 3, fire: 4, frost: 3, shield: 2, flask: 1, boots: 2, bomb: 4 },
  ];
  const pickItem = (): ItemId => {
    const wz = ZONE_WEIGHTS[spec.zone] ?? ZONE_WEIGHTS[0];
    const pairs: [ItemId, number][] = ALL_ITEMS.map((id) => {
      let wgt = wz[id] ?? 1;
      if (owned.has(id)) wgt *= 0.45; // duplicates still appear: they merge into ★
      if (id === 'flask' && owned.has('flask')) wgt = 0.6;
      return [id, wgt];
    });
    return rng.weighted(pairs);
  };
  const pedestalRooms = normalRooms.length ? normalRooms : nonStart;
  const chosen: ItemId[] = [];
  if (floorNum === 1) {
    // tutorial pedestal: a few steps to the RIGHT of the start, so the natural bump
    // fills the empty Right slot and the swap rule is learnt in the first 5 seconds
    const first = rng.pick(['spear', 'axe'] as ItemId[]);
    const sx = map.start % w;
    const sy = Math.floor(map.start / w);
    const spots: number[] = [];
    for (const dx of [3, 2, 4, -3, -2]) spots.push(sy * w + sx + dx);
    let placed: Prop | null = null;
    for (const i of spots) {
      if (map.room[i] !== map.startRoom || map.tiles[i] !== T.Floor) continue;
      placed = placeProp('pedestal', [map.startRoom], { item: newItem(first) }, false, [i]);
      if (placed) break;
    }
    if (!placed) placed = placeProp('pedestal', [map.startRoom], { item: newItem(first) }, false);
    if (!placed) {
      // cramped start room: use the room closest to the start instead
      const near = [...nonStart].sort((a, b) => {
        const ra = map.rooms[a];
        const rb = map.rooms[b];
        return Math.abs(ra.x - sx) + Math.abs(ra.y - sy) - (Math.abs(rb.x - sx) + Math.abs(rb.y - sy));
      });
      for (const rid of near) {
        placed = placeProp('pedestal', [rid], { item: newItem(first) });
        if (placed) break;
      }
    }
    chosen.push('shield');
  } else if (spec.boss) {
    // guardians must always be beatable: a weapon waits in the antechamber
    const owned2 = p.slots.filter(Boolean).map((it) => it!.id);
    const weapons = (['sword', 'hammer', 'axe', 'spear'] as ItemId[]).filter((id) => !owned2.includes(id));
    const wpn = newItem(weapons.length ? rng.pick(weapons) : 'sword');
    if (!placeProp('pedestal', [map.startRoom], { item: wpn }, false)) placeProp('pedestal', normalRooms.length ? normalRooms : nonStart, { item: wpn }, false);
  } else {
    for (let k = 0; k < spec.pedestals; k++) {
      let id = pickItem();
      for (let tries = 0; tries < 5 && chosen.includes(id); tries++) id = pickItem();
      chosen.push(id);
    }
  }
  // on normal floors from B2 the last item is a CAGE reward, placed after the monsters
  const cageItem: ItemId | null = floorNum > 1 && !spec.boss && chosen.length > 1 ? chosen.pop()! : null;
  for (const id of chosen) placeProp('pedestal', pedestalRooms, { item: newItem(id) });

  // --- anvil / fountain / chests
  if (spec.anvil) placeProp('anvil', normalRooms.length ? normalRooms : nonStart, { price: 4 + spec.zone * 2 });
  if (spec.fountain) placeProp('fountain', [map.startRoom]);
  for (let k = 0; k < spec.chests; k++) placeProp('chest', normalRooms.length ? normalRooms : nonStart);
  // destructibles: crates early, explosive barrels in the forge
  const breakables = spec.zone === 2 ? rng.int(3, 5) : rng.int(1, 3);
  for (let k = 0; k < breakables; k++) placeProp(spec.zone === 2 ? 'barrel' : spec.zone === 1 && rng.chance(0.4) ? 'barrel' : 'crate', normalRooms.length ? normalRooms : nonStart, {}, false);

  // --- boss
  if (spec.boss && arenaId >= 0) {
    const r = map.rooms[arenaId];
    // nearest plain floor tile to the arena's upper middle (never a pit, pillar or prop)
    const wantX = r.x + (r.w >> 1);
    const wantY = r.y + Math.max(1, (r.h >> 1) - 2);
    let bx = wantX;
    let by = wantY;
    let bestD = 1e9;
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++) {
        const i = y * w + x;
        if (map.tiles[i] !== T.Floor || occupied.has(i) || i === map.stairs) continue;
        if (s.props.some((q) => q.x === x && q.y === y)) continue;
        const dd = Math.abs(x - wantX) + Math.abs(y - wantY);
        if (dd < bestD) {
          bestD = dd;
          bx = x;
          by = y;
        }
      }
    const b = makeUnit(s, spec.boss, bx, by);
    if (spec.boss === 'boss_warden') b.mode = 0;
    s.units.push(b);
    s.bossId = b.id;
    occupied.add(by * w + bx);
  }

  // --- enemies by threat budget
  let budget = spec.budget;
  const roomLoad = new Map<number, number>();
  const spawnRooms = (spec.boss ? nonStart.filter((id) => id !== map.startRoom) : normalRooms.length ? normalRooms : nonStart).filter((id) => id !== map.startRoom);
  let guard = 0;
  const startX = p.x;
  const startY = p.y;
  while (budget > 0 && guard++ < 60 && spawnRooms.length) {
    const kind = rng.weighted(spec.pool);
    const cost = ENEMIES[kind].threat;
    if (cost > budget + 1) continue;
    const rid = rng.pick(spawnRooms);
    const r = map.rooms[rid];
    const cap = Math.max(1, Math.floor((r.w * r.h) / 10));
    if ((roomLoad.get(rid) ?? 0) >= cap) continue;
    const cands = roomTiles(rid, false).filter((i) => {
      const x = i % w;
      const y = Math.floor(i / w);
      return Math.abs(x - startX) + Math.abs(y - startY) >= 7 && !s.units.some((u) => Math.abs(u.x - x) + Math.abs(u.y - y) < 2);
    });
    if (!cands.length) continue;
    const i = rng.pick(cands);
    const u = makeUnit(s, kind, i % w, Math.floor(i / w));
    u.facing = rng.int(0, 3) as 0 | 1 | 2 | 3;
    u.home = rid;
    if (kind === 'sentinel') u.awake = false;
    s.units.push(u);
    occupied.add(i);
    roomLoad.set(rid, (roomLoad.get(rid) ?? 0) + 1);
    budget -= cost;
  }
  // cage: the pedestal opens only when every monster living in its room is dead,
  // so the best loot is a reason to fight instead of sneaking to the stairs
  if (cageItem) {
    const byRoom = new Map<number, number>();
    for (const u of s.units) if (u.home >= 0) byRoom.set(u.home, (byRoom.get(u.home) ?? 0) + 1);
    const rooms = [...byRoom.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([r]) => r);
    let placed: Prop | null = null;
    for (const rid of rooms) {
      placed = placeProp('pedestal', [rid], { item: newItem(cageItem), lockRoom: rid });
      if (placed) break;
    }
    if (!placed) placeProp('pedestal', pedestalRooms, { item: newItem(cageItem) });
  }
  // a few wanderers patrol from the start (deeper zones)
  const sleepers = s.units.filter((u) => !u.boss && u.kind !== 'sentinel');
  rng.shuffle(sleepers);
  for (let k = 0; k < Math.min(spec.wanderers, sleepers.length); k++) sleepers[k].awake = true;

  // --- coins scattered in rooms
  const coinPiles = rng.int(2, 4);
  for (let k = 0; k < coinPiles; k++) {
    const rid = rng.pick(nonStart.length ? nonStart : roomIds);
    const cands = roomTiles(rid, false);
    if (!cands.length) continue;
    const i = rng.pick(cands);
    s.pickups.push({ id: s.nextId++, kind: 'coin', x: i % w, y: Math.floor(i / w), amount: rng.int(1, 2) });
    occupied.add(i);
  }

  void isWalkable;
}

function bfsBlocked(tiles: number[], w: number, h: number, from: number, blocked: Set<number>): Int32Array {
  const dist = new Int32Array(w * h).fill(-1);
  dist[from] = 0;
  const q = [from];
  for (let qi = 0; qi < q.length; qi++) {
    const i = q[qi];
    const x = i % w;
    const y = Math.floor(i / w);
    const nb = [y > 0 ? i - w : -1, x < w - 1 ? i + 1 : -1, y < h - 1 ? i + w : -1, x > 0 ? i - 1 : -1];
    for (const ni of nb) {
      if (ni < 0 || dist[ni] >= 0) continue;
      if (!isWalkable(tiles[ni]) || blocked.has(ni)) continue;
      dist[ni] = dist[i] + 1;
      q.push(ni);
    }
  }
  return dist;
}
