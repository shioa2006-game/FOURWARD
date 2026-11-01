// Particles, floating numbers and short-lived attack effects. All positions are in
// tile units (floating point); the renderer converts to pixels.

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number; // ms remaining
  max: number;
  color: string;
  size: number; // in tile units
  grav: number;
  drag: number;
  square: boolean;
}

export interface FloatText {
  x: number;
  y: number;
  text: string;
  color: string;
  t0: number;
  dur: number;
  big: boolean;
}

export type EffectKind =
  | 'slash'
  | 'thrust'
  | 'cleave'
  | 'smash'
  | 'stab'
  | 'projectile'
  | 'beam'
  | 'explosion'
  | 'ring'
  | 'guard'
  | 'heal'
  | 'lightning'
  | 'chain'
  | 'shockwave'
  | 'flash';

export interface Effect {
  kind: EffectKind;
  t0: number; // start time (ms, renderer clock)
  dur: number;
  x: number; // origin (tile units, centre)
  y: number;
  tx: number; // target (tile units) for projectiles / beams
  ty: number;
  dir: number; // facing for slashes
  color: string;
  tiles: { x: number; y: number }[];
  size: number;
  sprite?: string;
}

export class Particles {
  list: Particle[] = [];

  burst(x: number, y: number, n: number, color: string | string[], speed = 4, life = 420, size = 0.09, grav = 6): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.35 + Math.random() * 0.75);
      this.list.push({
        x,
        y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s - speed * 0.25,
        life: life * (0.6 + Math.random() * 0.6),
        max: life,
        color: Array.isArray(color) ? color[(Math.random() * color.length) | 0] : color,
        size: size * (0.7 + Math.random() * 0.6),
        grav,
        drag: 2.2,
        square: true,
      });
    }
  }

  spray(x: number, y: number, dx: number, dy: number, n: number, color: string | string[], speed = 5, life = 360): void {
    for (let i = 0; i < n; i++) {
      const spread = (Math.random() - 0.5) * 1.2;
      const s = speed * (0.5 + Math.random() * 0.8);
      const vx = dx * s + -dy * spread * s * 0.6;
      const vy = dy * s + dx * spread * s * 0.6;
      this.list.push({
        x,
        y,
        vx,
        vy,
        life: life * (0.6 + Math.random() * 0.6),
        max: life,
        color: Array.isArray(color) ? color[(Math.random() * color.length) | 0] : color,
        size: 0.07 + Math.random() * 0.06,
        grav: 4,
        drag: 3,
        square: true,
      });
    }
  }

  rise(x: number, y: number, n: number, color: string | string[], life = 700): void {
    for (let i = 0; i < n; i++) {
      this.list.push({
        x: x + (Math.random() - 0.5) * 0.7,
        y: y + (Math.random() - 0.2) * 0.5,
        vx: (Math.random() - 0.5) * 0.4,
        vy: -1.2 - Math.random() * 1.2,
        life: life * (0.6 + Math.random() * 0.6),
        max: life,
        color: Array.isArray(color) ? color[(Math.random() * color.length) | 0] : color,
        size: 0.06 + Math.random() * 0.05,
        grav: 0,
        drag: 0.5,
        square: true,
      });
    }
  }

  update(dt: number): void {
    const s = dt / 1000;
    let w = 0;
    for (const p of this.list) {
      p.life -= dt;
      if (p.life <= 0) continue;
      p.vx *= Math.max(0, 1 - p.drag * s);
      p.vy *= Math.max(0, 1 - p.drag * s);
      p.vy += p.grav * s;
      p.x += p.vx * s;
      p.y += p.vy * s;
      this.list[w++] = p;
    }
    this.list.length = w;
  }
}

export function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}
export function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}
export function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}
export function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}
