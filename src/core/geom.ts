// Directions, vectors and grid helpers.
// Direction order is clockwise so that rotating the loadout is (d + 1) % 4.

export type Dir = 0 | 1 | 2 | 3;
export const UP: Dir = 0;
export const RIGHT: Dir = 1;
export const DOWN: Dir = 2;
export const LEFT: Dir = 3;
export const DIRS: readonly Dir[] = [UP, RIGHT, DOWN, LEFT];

export const DX: readonly number[] = [0, 1, 0, -1];
export const DY: readonly number[] = [-1, 0, 1, 0];

export interface Vec {
  x: number;
  y: number;
}

export function cw(d: Dir): Dir {
  return ((d + 1) % 4) as Dir;
}
export function ccw(d: Dir): Dir {
  return ((d + 3) % 4) as Dir;
}
export function opposite(d: Dir): Dir {
  return ((d + 2) % 4) as Dir;
}

export function step(p: Vec, d: Dir, n = 1): Vec {
  return { x: p.x + DX[d] * n, y: p.y + DY[d] * n };
}

/**
 * Offset relative to a facing direction: `fwd` tiles forward, `side` tiles to the
 * right-hand side (negative = left-hand side).
 */
export function rel(p: Vec, d: Dir, fwd: number, side: number): Vec {
  const r = cw(d);
  return { x: p.x + DX[d] * fwd + DX[r] * side, y: p.y + DY[d] * fwd + DY[r] * side };
}

export function eq(a: Vec, b: Vec): boolean {
  return a.x === b.x && a.y === b.y;
}

export function manhattan(a: Vec, b: Vec): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function chebyshev(a: Vec, b: Vec): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/** Direction from a to b if they share a row/column (and are distinct), else -1. */
export function dirTo(a: Vec, b: Vec): Dir | -1 {
  if (a.x === b.x && a.y !== b.y) return b.y < a.y ? UP : DOWN;
  if (a.y === b.y && a.x !== b.x) return b.x > a.x ? RIGHT : LEFT;
  return -1;
}

/** Direction from a toward b along the dominant axis (ties prefer vertical). */
export function roughDirTo(a: Vec, b: Vec): Dir {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? RIGHT : LEFT;
  return dy > 0 ? DOWN : UP;
}

export const DIR_NAMES = ['up', 'right', 'down', 'left'] as const;
