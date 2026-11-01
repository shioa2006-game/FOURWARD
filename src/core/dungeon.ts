// BSP dungeon generation (Mystery-Dungeon style rooms + corridors).
//
// 1. Recursively split the map rectangle (Binary Space Partitioning).
// 2. Put one room inside every leaf (with margins so rooms never touch).
// 3. Walk the BSP tree bottom-up and connect the two subtrees of every node with a
//    corridor (A* through solid rock that never hugs a room wall) -> spanning tree.
// 4. Add a few extra corridors to create loops.
// 5. Choose start/stairs rooms far apart, then decorate rooms with zone features
//    (pillars, pits, spikes, ...) while keeping every room internally connected.
// 6. Validate: everything walkable is reachable from the start, stairs included.
//    On failure retry with a new sub-seed; a hand-made fallback layout is last resort.

import { Rng, hashSeed } from './rng.ts';

export const T = {
  Wall: 0,
  Floor: 1,
  Pillar: 2,
  Pit: 3,
  Spikes: 4,
  Grass: 5,
  Lava: 6,
  Turnstile: 7,
  Water: 8,
  Stairs: 9,
} as const;
export type TileId = (typeof T)[keyof typeof T];

/** Ground units can stand here. */
export function isWalkable(t: number): boolean {
  return t === T.Floor || t === T.Spikes || t === T.Grass || t === T.Turnstile || t === T.Water || t === T.Stairs;
}
/** Flying units can additionally cross pits and lava. */
export function isFlyable(t: number): boolean {
  return isWalkable(t) || t === T.Pit || t === T.Lava;
}
/** Blocks projectiles and line of sight. */
export function isOpaque(t: number): boolean {
  return t === T.Wall || t === T.Pillar;
}
/** Units pushed onto this tile fall / burn to death. */
export function isDeadly(t: number): boolean {
  return t === T.Pit || t === T.Lava;
}

export interface Room {
  id: number;
  x: number; // interior top-left
  y: number;
  w: number; // interior size
  h: number;
  tags: string[];
}

export interface FloorMap {
  w: number;
  h: number;
  tiles: number[];
  room: number[]; // room id per tile, -1 = corridor / rock
  rooms: Room[];
  doors: number[]; // corridor tiles that touch a room interior
  start: number; // tile index
  stairs: number; // tile index (on boss floors the tile stays Floor until revealed)
  startRoom: number;
  stairsRoom: number;
  attempts: number;
}

export type FeatureKind = 'pillars' | 'pits' | 'spikes' | 'grass' | 'lava' | 'turnstile' | 'water';

export interface GenOptions {
  w: number;
  h: number;
  minLeaf: number;
  maxDepth: number;
  extraLoops: number;
  /** probability (0..1) that a room receives each feature */
  features: Partial<Record<FeatureKind, number>>;
  /** guardian / boss floor: one big arena room holds the (hidden) stairs */
  arena?: boolean;
  /** corridor grain: 'h' favours vertical cuts (rooms side by side, horizontal corridors), 'v' the opposite */
  grain?: 'h' | 'v';
}

interface Node {
  x: number;
  y: number;
  w: number;
  h: number;
  a?: Node;
  b?: Node;
  vertical?: boolean;
  cut?: number;
  room?: Room;
  noSplit?: boolean;
}

// margins between a leaf edge and its room interior: left/top 1, right/bottom 2.
// The asymmetric margin guarantees a free corridor lane along every BSP cut.
const ML = 1;
const MR = 2;

export function generateFloor(seed: number, opt: GenOptions): FloorMap {
  for (let attempt = 0; attempt < 40; attempt++) {
    const rng = new Rng(hashSeed(seed, attempt, 0x5eed));
    const map = tryGenerate(rng, opt);
    if (map && validateFloor(map).ok) {
      map.attempts = attempt + 1;
      return map;
    }
  }
  const fb = fallbackFloor(opt);
  fb.attempts = -1;
  return fb;
}

// ---------------------------------------------------------------------------

function tryGenerate(rng: Rng, opt: GenOptions): FloorMap | null {
  const { w, h } = opt;
  const tiles = new Array<number>(w * h).fill(T.Wall);
  const roomOf = new Array<number>(w * h).fill(-1);
  const rooms: Room[] = [];

  const root: Node = { x: 1, y: 1, w: w - 2, h: h - 2 };
  if (opt.arena) {
    // reserve the right part of the map as a single arena leaf
    const cut = root.x + Math.floor(root.w * 0.56);
    root.vertical = true;
    root.cut = cut;
    root.a = { x: root.x, y: root.y, w: cut - root.x, h: root.h };
    root.b = { x: cut, y: root.y, w: root.x + root.w - cut, h: root.h, noSplit: true };
    split(root.a, 1, rng, opt);
  } else {
    split(root, 0, rng, opt);
  }

  // rooms in leaves
  const leaves: Node[] = [];
  collectLeaves(root, leaves);
  for (const leaf of leaves) {
    const maxW = leaf.w - ML - MR;
    const maxH = leaf.h - ML - MR;
    if (maxW < 3 || maxH < 3) continue;
    const isArena = !!leaf.noSplit && !!opt.arena;
    let rw: number, rh: number;
    if (isArena) {
      // a readable arena: big, but small enough to fit on screen
      rw = Math.max(3, Math.min(maxW, 13));
      rh = Math.max(3, Math.min(maxH, 11));
    } else {
      rw = rng.int(Math.min(maxW, Math.max(4, Math.ceil(maxW * 0.5))), maxW);
      rh = rng.int(Math.min(maxH, Math.max(4, Math.ceil(maxH * 0.5))), maxH);
    }
    const rx = rng.int(leaf.x + ML, leaf.x + leaf.w - MR - rw);
    const ry = rng.int(leaf.y + ML, leaf.y + leaf.h - MR - rh);
    const room: Room = { id: rooms.length, x: rx, y: ry, w: rw, h: rh, tags: isArena ? ['arena'] : [] };
    rooms.push(room);
    leaf.room = room;
    for (let yy = ry; yy < ry + rh; yy++)
      for (let xx = rx; xx < rx + rw; xx++) {
        tiles[yy * w + xx] = T.Floor;
        roomOf[yy * w + xx] = room.id;
      }
  }
  if (rooms.length < 2) return null;

  const ctx: CarveCtx = { w, h, tiles, roomOf, rooms, doors: new Set<number>(), rng, links: new Set<string>() };

  // spanning tree over the BSP
  const candidates: [Room, Room][] = [];
  if (!connectTree(root, ctx, candidates)) return null;

  // extra loops (skip the arena so it keeps a single entrance)
  let loops = opt.extraLoops;
  rng.shuffle(candidates);
  for (const [ra, rb] of candidates) {
    if (loops <= 0) break;
    if (ra.tags.includes('arena') || rb.tags.includes('arena')) continue;
    const key = linkKey(ra, rb);
    if (ctx.links.has(key)) continue;
    if (carveBetween(ra, rb, ctx)) loops--;
  }

  // doors = corridor tiles orthogonally adjacent to a room interior
  const doors: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (tiles[i] !== T.Floor || roomOf[i] !== -1) continue;
    const x = i % w;
    const y = (i / w) | 0;
    if (adjRoom(x, y, ctx) >= 0) doors.push(i);
  }

  // start & stairs rooms: far apart in walking distance
  const centers = rooms.map((r) => idxOf(w, r.x + (r.w >> 1), r.y + (r.h >> 1)));
  let startRoom: number;
  let stairsRoom: number;
  if (opt.arena) {
    stairsRoom = rooms.findIndex((r) => r.tags.includes('arena'));
    if (stairsRoom < 0) return null;
    const d = bfs(tiles, w, h, centers[stairsRoom], isWalkable);
    let best = -1;
    let bestD = -1;
    for (const r of rooms) {
      if (r.id === stairsRoom) continue;
      const dd = d[centers[r.id]];
      if (dd > bestD) {
        bestD = dd;
        best = r.id;
      }
    }
    if (best < 0) return null;
    startRoom = best;
  } else {
    startRoom = rng.int(0, rooms.length - 1);
    const d = bfs(tiles, w, h, centers[startRoom], isWalkable);
    const order = rooms
      .filter((r) => r.id !== startRoom && d[centers[r.id]] >= 0)
      .sort((p, q) => d[centers[q.id]] - d[centers[p.id]]);
    if (order.length === 0) return null;
    // one of the two farthest rooms
    stairsRoom = order[Math.min(order.length - 1, rng.int(0, 1))].id;
  }
  rooms[startRoom].tags.push('start');
  rooms[stairsRoom].tags.push('stairs');

  const doorSet = new Set(doors);
  const sr = rooms[startRoom];
  const start = idxOf(w, sr.x + (sr.w >> 1), sr.y + (sr.h >> 1));
  const st = rooms[stairsRoom];
  let stairs: number;
  if (opt.arena) {
    stairs = idxOf(w, st.x + (st.w >> 1), st.y + (st.h >> 1));
  } else {
    const cands: number[] = [];
    for (let yy = st.y; yy < st.y + st.h; yy++)
      for (let xx = st.x; xx < st.x + st.w; xx++) {
        if (nearDoor(xx, yy, w, doorSet)) continue;
        cands.push(idxOf(w, xx, yy));
      }
    stairs = cands.length ? rng.pick(cands) : idxOf(w, st.x + (st.w >> 1), st.y + (st.h >> 1));
    tiles[stairs] = T.Stairs;
  }

  const map: FloorMap = { w, h, tiles, room: roomOf, rooms, doors, start, stairs, startRoom, stairsRoom, attempts: 0 };

  // decorate
  for (const r of rooms) decorateRoom(map, r, rng, opt, doorSet);
  return map;
}

function split(n: Node, depth: number, rng: Rng, opt: GenOptions): void {
  if (n.noSplit || depth >= opt.maxDepth) return;
  const canV = n.w >= opt.minLeaf * 2;
  const canH = n.h >= opt.minLeaf * 2;
  if (!canV && !canH) return;
  // occasionally keep a big leaf -> a large hall
  if (depth >= 2 && rng.chance(0.14)) return;
  let vertical: boolean;
  if (canV && canH) {
    // grain biases the cut orientation so a floor leans toward one corridor axis
    const bias = opt.grain === 'h' ? 0.75 : opt.grain === 'v' ? 0.25 : 0.5;
    if (n.w > n.h * 1.6) vertical = true;
    else if (n.h > n.w * 1.6) vertical = false;
    else vertical = rng.chance(bias);
  } else vertical = canV;
  if (vertical) {
    const cut = rng.int(n.x + opt.minLeaf, n.x + n.w - opt.minLeaf);
    n.a = { x: n.x, y: n.y, w: cut - n.x, h: n.h };
    n.b = { x: cut, y: n.y, w: n.x + n.w - cut, h: n.h };
    n.cut = cut;
  } else {
    const cut = rng.int(n.y + opt.minLeaf, n.y + n.h - opt.minLeaf);
    n.a = { x: n.x, y: n.y, w: n.w, h: cut - n.y };
    n.b = { x: n.x, y: cut, w: n.w, h: n.y + n.h - cut };
    n.cut = cut;
  }
  n.vertical = vertical;
  split(n.a, depth + 1, rng, opt);
  split(n.b, depth + 1, rng, opt);
}

function collectLeaves(n: Node, out: Node[]): void {
  if (!n.a || !n.b) {
    out.push(n);
    return;
  }
  collectLeaves(n.a, out);
  collectLeaves(n.b, out);
}

function roomsUnder(n: Node, out: Room[]): Room[] {
  if (!n.a || !n.b) {
    if (n.room) out.push(n.room);
    return out;
  }
  roomsUnder(n.a, out);
  roomsUnder(n.b, out);
  return out;
}

interface CarveCtx {
  w: number;
  h: number;
  tiles: number[];
  roomOf: number[];
  rooms: Room[];
  doors: Set<number>;
  rng: Rng;
  links: Set<string>;
}

function linkKey(a: Room, b: Room): string {
  return a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`;
}

function connectTree(n: Node, ctx: CarveCtx, candidates: [Room, Room][]): boolean {
  if (!n.a || !n.b) return true;
  if (!connectTree(n.a, ctx, candidates) || !connectTree(n.b, ctx, candidates)) return false;
  const ra = roomsUnder(n.a, []);
  const rb = roomsUnder(n.b, []);
  if (ra.length === 0 || rb.length === 0) return ra.length + rb.length > 0;
  // rank pairs by the gap between them
  const pairs: { a: Room; b: Room; cost: number }[] = [];
  for (const a of ra)
    for (const b of rb) {
      pairs.push({ a, b, cost: roomGap(a, b) + ctx.rng.next() * 0.5 });
    }
  pairs.sort((p, q) => p.cost - q.cost);
  for (let i = 1; i < Math.min(pairs.length, 4); i++) candidates.push([pairs[i].a, pairs[i].b]);
  for (const p of pairs.slice(0, 6)) {
    if (carveBetween(p.a, p.b, ctx)) return true;
  }
  return false;
}

function roomGap(a: Room, b: Room): number {
  const gx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w));
  const gy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h));
  return gx + gy + (gx > 0 && gy > 0 ? 6 : 0);
}

/** Which side of room `a` faces room `b`: 0 up, 1 right, 2 down, 3 left. */
function facingSide(a: Room, b: Room): number {
  const ax = a.x + a.w / 2;
  const ay = a.y + a.h / 2;
  const bx = b.x + b.w / 2;
  const by = b.y + b.h / 2;
  const gx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w));
  const gy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h));
  if (gx >= gy) return bx > ax ? 1 : 3;
  return by > ay ? 2 : 0;
}

/** Candidate door tiles (on the wall ring, never at corners) on a side of a room. */
function doorCandidates(r: Room, side: number, w: number): number[] {
  const out: number[] = [];
  if (side === 0 || side === 2) {
    const y = side === 0 ? r.y - 1 : r.y + r.h;
    for (let x = r.x; x < r.x + r.w; x++) out.push(y * w + x);
  } else {
    const x = side === 3 ? r.x - 1 : r.x + r.w;
    for (let y = r.y; y < r.y + r.h; y++) out.push(y * w + x);
  }
  return out;
}

function adjRoom(x: number, y: number, ctx: { w: number; h: number; roomOf: number[] }): number {
  const { w, h, roomOf } = ctx;
  if (x > 0 && roomOf[y * w + x - 1] >= 0) return roomOf[y * w + x - 1];
  if (x < w - 1 && roomOf[y * w + x + 1] >= 0) return roomOf[y * w + x + 1];
  if (y > 0 && roomOf[(y - 1) * w + x] >= 0) return roomOf[(y - 1) * w + x];
  if (y < h - 1 && roomOf[(y + 1) * w + x] >= 0) return roomOf[(y + 1) * w + x];
  return -1;
}

/** true if tile is within 1 (8-neighbourhood) of any room interior */
function nearAnyRoom(x: number, y: number, ctx: CarveCtx): boolean {
  const { w, h, roomOf } = ctx;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx;
      const yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      if (roomOf[yy * w + xx] >= 0) return true;
    }
  return false;
}

function carveBetween(a: Room, b: Room, ctx: CarveCtx): boolean {
  const { w, rng } = ctx;
  const sa = facingSide(a, b);
  const sb = facingSide(b, a);
  const da = pickDoor(a, sa, ctx);
  const db = pickDoor(b, sb, ctx);
  if (da < 0 || db < 0) return false;
  const path = routeCorridor(da, db, ctx);
  if (!path) return false;
  for (const i of path) {
    if (ctx.roomOf[i] >= 0) continue;
    ctx.tiles[i] = T.Floor;
  }
  ctx.doors.add(da);
  ctx.doors.add(db);
  ctx.links.add(linkKey(a, b));
  void rng;
  void w;
  return true;
}

function pickDoor(r: Room, side: number, ctx: CarveCtx): number {
  const { w, h, rng } = ctx;
  const cands = doorCandidates(r, side, w).filter((i) => {
    const x = i % w;
    const y = (i / w) | 0;
    return x > 0 && y > 0 && x < w - 1 && y < h - 1;
  });
  if (cands.length === 0) return -1;
  // reuse an existing door on this side sometimes (fewer entrances = more chokepoints)
  const existing = cands.filter((i) => ctx.doors.has(i));
  if (existing.length && rng.chance(0.6)) return rng.pick(existing);
  // avoid putting a new door right next to an existing one
  const fresh = cands.filter((i) => {
    for (const d of ctx.doors) {
      const dx = Math.abs((d % w) - (i % w));
      const dy = Math.abs(((d / w) | 0) - ((i / w) | 0));
      if (dx + dy === 1) return false;
    }
    return true;
  });
  // prefer tiles away from the room corners
  const pool = fresh.length ? fresh : cands;
  if (pool.length > 2) {
    const inner = pool.slice(1, -1);
    return rng.pick(inner);
  }
  return rng.pick(pool);
}

/**
 * Dijkstra over rock with a turn penalty. Corridors may reuse other corridors but
 * never pass along a room's wall ring (except at the two doors).
 */
function routeCorridor(from: number, to: number, ctx: CarveCtx): number[] | null {
  const { w, h, tiles, roomOf } = ctx;
  const N = w * h;
  const INF = 1e9;
  const dist = new Float64Array(N * 4).fill(INF);
  const prev = new Int32Array(N * 4).fill(-1);
  const dxs = [0, 1, 0, -1];
  const dys = [-1, 0, 1, 0];
  // simple binary heap
  const heap: number[] = [];
  const hk: number[] = [];
  const push = (s: number, k: number) => {
    heap.push(s);
    hk.push(k);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hk[p] <= hk[i]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      [hk[p], hk[i]] = [hk[i], hk[p]];
      i = p;
    }
  };
  const pop = (): number => {
    const top = heap[0];
    const ls = heap.pop()!;
    const lk = hk.pop()!;
    if (heap.length) {
      heap[0] = ls;
      hk[0] = lk;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && hk[l] < hk[m]) m = l;
        if (r < heap.length && hk[r] < hk[m]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        [hk[m], hk[i]] = [hk[i], hk[m]];
        i = m;
      }
    }
    return top;
  };
  const passCost = (i: number): number => {
    if (i === to) return 1;
    if (roomOf[i] >= 0) return INF;
    const x = i % w;
    const y = (i / w) | 0;
    if (x <= 0 || y <= 0 || x >= w - 1 || y >= h - 1) return INF;
    if (tiles[i] === T.Floor) return 1; // existing corridor
    if (ctx.doors.has(i)) return INF;
    if (nearAnyRoom(x, y, ctx)) return INF;
    return 3;
  };
  for (let d = 0; d < 4; d++) {
    dist[from * 4 + d] = 0;
    push(from * 4 + d, 0);
  }
  while (heap.length) {
    const s = pop();
    const i = s >> 2;
    const d = s & 3;
    const cur = dist[s];
    if (i === to) {
      const path: number[] = [];
      let k = s;
      while (k >= 0) {
        path.push(k >> 2);
        k = prev[k];
      }
      return path.reverse();
    }
    const x = i % w;
    const y = (i / w) | 0;
    for (let nd = 0; nd < 4; nd++) {
      const nx = x + dxs[nd];
      const ny = y + dys[nd];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      const c = passCost(ni);
      if (c >= INF) continue;
      const turn = nd !== d && i !== from ? 2 : 0;
      const nk = cur + c + turn;
      const ns = ni * 4 + nd;
      if (nk < dist[ns]) {
        dist[ns] = nk;
        prev[ns] = s;
        push(ns, nk);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// decoration

function nearDoor(x: number, y: number, w: number, doors: Set<number>): boolean {
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      if (doors.has((y + dy) * w + (x + dx))) return true;
    }
  return false;
}

function decorateRoom(map: FloorMap, r: Room, rng: Rng, opt: GenOptions, doors: Set<number>): void {
  const f = opt.features;
  const isStart = r.id === map.startRoom;
  const isStairs = r.id === map.stairsRoom;
  const isArena = r.tags.includes('arena');
  // keep a clear ring around start and stairs
  const reserved = new Set<number>();
  for (const c of [map.start, map.stairs]) {
    const cx = c % map.w;
    const cy = (c / map.w) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) reserved.add((cy + dy) * map.w + cx + dx);
  }
  const free = (x: number, y: number): boolean => {
    if (x < r.x || y < r.y || x >= r.x + r.w || y >= r.y + r.h) return false;
    const i = y * map.w + x;
    if (map.tiles[i] !== T.Floor) return false;
    if (reserved.has(i)) return false;
    if (nearDoor(x, y, map.w, doors)) return false;
    return true;
  };

  const tryBlocking = (cells: [number, number][], tile: number): boolean => {
    if (cells.length === 0) return false;
    for (const [x, y] of cells) if (!free(x, y)) return false;
    const saved = cells.map(([x, y]) => map.tiles[y * map.w + x]);
    for (const [x, y] of cells) map.tiles[y * map.w + x] = tile;
    if (roomConnected(map, r)) return true;
    cells.forEach(([x, y], k) => (map.tiles[y * map.w + x] = saved[k]));
    return false;
  };

  const big = r.w >= 5 && r.h >= 5;

  if (big && f.pillars && rng.chance(isArena ? 0.85 : f.pillars)) {
    const patterns: [number, number][][] = [];
    // inset corners
    patterns.push([
      [r.x + 1, r.y + 1],
      [r.x + r.w - 2, r.y + 1],
      [r.x + 1, r.y + r.h - 2],
      [r.x + r.w - 2, r.y + r.h - 2],
    ]);
    // center block
    const cx = r.x + (r.w >> 1);
    const cy = r.y + (r.h >> 1);
    if (!isStart && !isStairs) {
      if (r.w >= 7 && r.h >= 7)
        patterns.push([
          [cx - 1, cy - 1],
          [cx, cy - 1],
          [cx - 1, cy],
          [cx, cy],
        ]);
      else patterns.push([[cx, cy]]);
    }
    // colonnade
    if (r.w >= 7) {
      const col: [number, number][] = [];
      for (let x = r.x + 1; x < r.x + r.w - 1; x += 2) {
        col.push([x, r.y + 1]);
        col.push([x, r.y + r.h - 2]);
      }
      patterns.push(col);
    }
    // scattered
    const sc: [number, number][] = [];
    for (let k = 0; k < 3; k++) sc.push([rng.int(r.x + 1, r.x + r.w - 2), rng.int(r.y + 1, r.y + r.h - 2)]);
    patterns.push(sc);
    rng.shuffle(patterns);
    for (const p of patterns) {
      const uniq = dedupe(p);
      if (tryBlocking(uniq, T.Pillar)) break;
    }
  }

  const chasm = (tile: number) => {
    if (!(r.w >= 6 && r.h >= 5) && !(r.w >= 5 && r.h >= 6)) return;
    const pw = rng.int(1, Math.max(1, Math.min(3, r.w - 4)));
    const ph = rng.int(1, Math.max(1, Math.min(3, r.h - 4)));
    for (let k = 0; k < 6; k++) {
      const px = rng.int(r.x + 1, r.x + r.w - 1 - pw);
      const py = rng.int(r.y + 1, r.y + r.h - 1 - ph);
      const cells: [number, number][] = [];
      for (let y = py; y < py + ph; y++) for (let x = px; x < px + pw; x++) cells.push([x, y]);
      if (tryBlocking(cells, tile)) return;
    }
  };
  if (!isStart && f.pits && rng.chance(f.pits)) chasm(T.Pit);
  if (!isStart && f.lava && rng.chance(f.lava)) chasm(T.Lava);

  const scatter = (tile: number, n: number) => {
    for (let k = 0; k < n * 4 && n > 0; k++) {
      const x = rng.int(r.x, r.x + r.w - 1);
      const y = rng.int(r.y, r.y + r.h - 1);
      if (!free(x, y)) continue;
      map.tiles[y * map.w + x] = tile;
      n--;
    }
  };
  const blob = (tile: number, n: number) => {
    let x = rng.int(r.x, r.x + r.w - 1);
    let y = rng.int(r.y, r.y + r.h - 1);
    for (let k = 0; k < n * 6 && n > 0; k++) {
      if (free(x, y)) {
        map.tiles[y * map.w + x] = tile;
        n--;
      }
      const d = rng.int(0, 3);
      x = Math.min(r.x + r.w - 1, Math.max(r.x, x + [0, 1, 0, -1][d]));
      y = Math.min(r.y + r.h - 1, Math.max(r.y, y + [-1, 0, 1, 0][d]));
    }
  };
  if (!isStart && f.spikes && rng.chance(f.spikes)) scatter(T.Spikes, rng.int(2, 4));
  if (f.grass && rng.chance(f.grass)) blob(T.Grass, rng.int(5, 12));
  if (f.water && rng.chance(f.water)) blob(T.Water, rng.int(4, 9));
  if (!isStart && f.turnstile && rng.chance(f.turnstile)) scatter(T.Turnstile, rng.int(1, 2));
}

function dedupe(cells: [number, number][]): [number, number][] {
  const seen = new Set<string>();
  const out: [number, number][] = [];
  for (const c of cells) {
    const k = `${c[0]},${c[1]}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

/** Are all walkable interior tiles of the room (plus its doors) one component? */
function roomConnected(map: FloorMap, r: Room): boolean {
  const { w, tiles } = map;
  const inRoomOrDoor = (x: number, y: number): boolean => {
    const i = y * w + x;
    if (x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h) return isWalkable(tiles[i]);
    return false;
  };
  let seed = -1;
  let count = 0;
  for (let y = r.y; y < r.y + r.h; y++)
    for (let x = r.x; x < r.x + r.w; x++)
      if (inRoomOrDoor(x, y)) {
        count++;
        if (seed < 0) seed = y * w + x;
      }
  if (seed < 0) return false;
  const seen = new Set<number>([seed]);
  const stack = [seed];
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    const y = (i / w) | 0;
    for (const [dx, dy] of [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ]) {
      const nx = x + dx;
      const ny = y + dy;
      const ni = ny * w + nx;
      if (seen.has(ni)) continue;
      if (!inRoomOrDoor(nx, ny)) continue;
      seen.add(ni);
      stack.push(ni);
    }
  }
  if (seen.size !== count) return false;
  // every door tile next to this room must touch a walkable interior tile
  for (const d of map.doors) {
    const x = d % w;
    const y = (d / w) | 0;
    let touches = false;
    let adjacentToRoom = false;
    for (const [dx, dy] of [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= r.x && ny >= r.y && nx < r.x + r.w && ny < r.y + r.h) {
        adjacentToRoom = true;
        if (isWalkable(tiles[ny * w + nx])) touches = true;
      }
    }
    if (adjacentToRoom && !touches) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// validation & utilities

export function idxOf(w: number, x: number, y: number): number {
  return y * w + x;
}

/** BFS distance map from `from` over tiles accepted by `pass`; -1 = unreachable. */
export function bfs(tiles: number[], w: number, h: number, from: number, pass: (t: number) => boolean): Int32Array {
  const dist = new Int32Array(w * h).fill(-1);
  if (from < 0 || from >= w * h) return dist;
  dist[from] = 0;
  const q: number[] = [from];
  for (let qi = 0; qi < q.length; qi++) {
    const i = q[qi];
    const x = i % w;
    const y = (i / w) | 0;
    const nb = [y > 0 ? i - w : -1, x < w - 1 ? i + 1 : -1, y < h - 1 ? i + w : -1, x > 0 ? i - 1 : -1];
    for (const ni of nb) {
      if (ni < 0 || dist[ni] >= 0) continue;
      if (!pass(tiles[ni])) continue;
      dist[ni] = dist[i] + 1;
      q.push(ni);
    }
  }
  return dist;
}

export interface Validation {
  ok: boolean;
  problems: string[];
}

export function validateFloor(map: FloorMap): Validation {
  const problems: string[] = [];
  const { w, h, tiles } = map;
  if (map.startRoom === map.stairsRoom) problems.push('start and stairs share a room');
  if (!isWalkable(tiles[map.start])) problems.push('start not walkable');
  // stairs tile may still be Floor (boss floors) — both count as walkable
  if (!isWalkable(tiles[map.stairs])) problems.push('stairs not walkable');
  const dist = bfs(tiles, w, h, map.start, isWalkable);
  if (dist[map.stairs] < 0) problems.push('stairs unreachable');
  let unreachable = 0;
  for (let i = 0; i < w * h; i++) {
    if (!isWalkable(tiles[i])) continue;
    if (dist[i] < 0) unreachable++;
    // border must stay solid
    const x = i % w;
    const y = (i / w) | 0;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) problems.push('walkable border tile');
  }
  if (unreachable > 0) problems.push(`${unreachable} unreachable walkable tiles`);
  for (const r of map.rooms) {
    const c = idxOf(w, r.x + (r.w >> 1), r.y + (r.h >> 1));
    let any = false;
    for (let y = r.y; y < r.y + r.h && !any; y++)
      for (let x = r.x; x < r.x + r.w; x++)
        if (dist[idxOf(w, x, y)] >= 0) {
          any = true;
          break;
        }
    if (!any) problems.push(`room ${r.id} unreachable (center ${c})`);
  }
  return { ok: problems.length === 0, problems };
}

/** Last-resort layout: three rooms in a row joined by straight corridors. */
function fallbackFloor(opt: GenOptions): FloorMap {
  const w = Math.max(30, opt.w);
  const h = Math.max(15, opt.h);
  const tiles = new Array<number>(w * h).fill(T.Wall);
  const roomOf = new Array<number>(w * h).fill(-1);
  const rooms: Room[] = [];
  const cy = h >> 1;
  const rw = Math.floor((w - 8) / 3) - 2;
  for (let k = 0; k < 3; k++) {
    const rx = 2 + k * (rw + 3);
    const room: Room = { id: k, x: rx, y: cy - 3, w: rw, h: 7, tags: [] };
    rooms.push(room);
    for (let y = room.y; y < room.y + room.h; y++)
      for (let x = room.x; x < room.x + room.w; x++) {
        tiles[y * w + x] = T.Floor;
        roomOf[y * w + x] = k;
      }
  }
  const doors: number[] = [];
  for (let k = 0; k < 2; k++) {
    const a = rooms[k];
    const b = rooms[k + 1];
    for (let x = a.x + a.w; x < b.x; x++) {
      tiles[cy * w + x] = T.Floor;
      if (x === a.x + a.w || x === b.x - 1) doors.push(cy * w + x);
    }
  }
  if (opt.arena) rooms[2].tags.push('arena');
  rooms[0].tags.push('start');
  rooms[2].tags.push('stairs');
  const start = cy * w + rooms[0].x + 1;
  const stairs = cy * w + rooms[2].x + (rooms[2].w >> 1);
  if (!opt.arena) tiles[stairs] = T.Stairs;
  return { w, h, tiles, room: roomOf, rooms, doors, start, stairs, startRoom: 0, stairsRoom: 2, attempts: -1 };
}
