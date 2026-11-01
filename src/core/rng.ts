// Seeded, serializable RNG (mulberry32). All game randomness goes through this
// so that a run is fully reproducible from its seed (saves, replays, tests).

export class Rng {
  s: number;

  constructor(seed: number) {
    this.s = seed | 0;
  }

  /** float in [0, 1) */
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** integer in [lo, hi] (inclusive) */
  int(lo: number, hi: number): number {
    if (hi < lo) return lo;
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  /** pick from [value, weight] pairs; weights <= 0 are ignored */
  weighted<T>(pairs: readonly (readonly [T, number])[]): T {
    let total = 0;
    for (const [, w] of pairs) if (w > 0) total += w;
    let r = this.next() * total;
    for (const [v, w] of pairs) {
      if (w <= 0) continue;
      r -= w;
      if (r < 0) return v;
    }
    return pairs[pairs.length - 1][0];
  }
}

/** Mix several integers into one 32-bit seed (for per-floor / per-attempt sub-seeds). */
export function hashSeed(...parts: number[]): number {
  let h = 0x811c9dc5 | 0;
  for (const p of parts) {
    h ^= p | 0;
    h = Math.imul(h, 0x01000193);
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995);
    h ^= h >>> 15;
  }
  return h | 0;
}

export function randomSeed(): number {
  return (Math.random() * 0x7fffffff) | 0;
}
