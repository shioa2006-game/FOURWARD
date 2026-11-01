// Visibility (Mystery-Dungeon style): inside a room you see the whole room and its
// walls/doors; in a corridor you see your neighbours plus straight lines down the
// corridor. Enemies outside the visible set never threaten you (fairness rule).

import { isOpaque, type FloorMap } from './dungeon.ts';

export function computeVisible(map: FloorMap, px: number, py: number, corridorRange = 6): Set<number> {
  const { w, h, tiles } = map;
  const vis = new Set<number>();
  const pi = py * w + px;
  const add = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    vis.add(y * w + x);
  };
  // rooms touched by the player tile (inside, or standing in a doorway)
  const roomIds = new Set<number>();
  if (map.room[pi] >= 0) roomIds.add(map.room[pi]);
  else {
    for (const [dx, dy] of [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ]) {
      const nx = px + dx;
      const ny = py + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const r = map.room[ny * w + nx];
      if (r >= 0) roomIds.add(r);
    }
  }
  for (const id of roomIds) {
    const r = map.rooms[id];
    for (let y = r.y - 1; y <= r.y + r.h; y++) for (let x = r.x - 1; x <= r.x + r.w; x++) add(x, y);
  }
  // immediate surroundings
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) add(px + dx, py + dy);
  // straight lines (corridors and doorways)
  for (const [dx, dy] of [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ]) {
    for (let k = 1; k <= corridorRange; k++) {
      const x = px + dx * k;
      const y = py + dy * k;
      if (x < 0 || y < 0 || x >= w || y >= h) break;
      add(x, y);
      // reveal the walls beside the corridor line too
      add(x + dy, y + dx);
      add(x - dy, y - dx);
      if (isOpaque(tiles[y * w + x])) break;
    }
  }
  return vis;
}

/** Clear straight line between two tiles in the same row/column (endpoints excluded). */
export function clearLine(map: FloorMap, ax: number, ay: number, bx: number, by: number, blocked?: (i: number) => boolean): boolean {
  if (ax !== bx && ay !== by) return false;
  const dx = Math.sign(bx - ax);
  const dy = Math.sign(by - ay);
  let x = ax + dx;
  let y = ay + dy;
  while (x !== bx || y !== by) {
    const i = y * map.w + x;
    if (isOpaque(map.tiles[i])) return false;
    if (blocked && blocked(i)) return false;
    x += dx;
    y += dy;
  }
  return true;
}
