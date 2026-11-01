// Procedural 16x16 pixel textures for terrain, one palette per zone.
import { Rng } from '../core/rng.ts';

export interface ZonePalette {
  floor: [string, string, string]; // base, light speck, dark speck
  slab: string; // slab seam
  corridor: [string, string];
  wallFace: [string, string, string]; // brick, brick light, mortar
  wallTop: [string, string]; // top fill, rim highlight
  accent: string; // moss / rust / brass detail on walls
  void: string;
  light: string; // torch light tint
}

export const ZONES: ZonePalette[] = [
  {
    // 1: Moss Crypt
    floor: ['#3b4740', '#46544b', '#323c37'],
    slab: '#2c3531',
    corridor: ['#343b3c', '#2b3132'],
    wallFace: ['#2d3245', '#3a4058', '#1d2030'],
    wallTop: ['#20232f', '#4d6b4f'],
    accent: '#5f8f4f',
    void: '#0d0b17',
    light: 'rgba(255, 214, 150, 0.10)',
  },
  {
    // 2: Sunken Grotto
    floor: ['#2f4651', '#395561', '#283c45'],
    slab: '#233640',
    corridor: ['#2b3d47', '#24343d'],
    wallFace: ['#1f2d4a', '#2b3d63', '#141d33'],
    wallTop: ['#162039', '#4a7fa3'],
    accent: '#5fb3c9',
    void: '#090d18',
    light: 'rgba(170, 225, 255, 0.10)',
  },
  {
    // 3: Ember Forge
    floor: ['#4a3531', '#583f39', '#3d2c29'],
    slab: '#36262a',
    corridor: ['#3f2e2d', '#352726'],
    wallFace: ['#3a2026', '#4d2a30', '#24141a'],
    wallTop: ['#24141a', '#a0552e'],
    accent: '#e0703a',
    void: '#120a0c',
    light: 'rgba(255, 170, 110, 0.12)',
  },
  {
    // 4: Clockwork Abyss
    floor: ['#383450', '#433e5e', '#2f2b44'],
    slab: '#28243b',
    corridor: ['#322e47', '#2a263c'],
    wallFace: ['#2a2440', '#383055', '#19152a'],
    wallTop: ['#19152a', '#b0915a'],
    accent: '#d6b46a',
    void: '#0a0814',
    light: 'rgba(220, 200, 255, 0.10)',
  },
];

export interface TileSet {
  floor: HTMLCanvasElement[];
  corridor: HTMLCanvasElement[];
  wallFace: HTMLCanvasElement[];
  wallTop: HTMLCanvasElement;
  pillar: HTMLCanvasElement;
  pitLip: HTMLCanvasElement;
  spikes: HTMLCanvasElement;
  grass: HTMLCanvasElement[];
  lava: HTMLCanvasElement[];
  water: HTMLCanvasElement[];
  turnstile: HTMLCanvasElement;
  stairs: HTMLCanvasElement;
}

function canvas16(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = 16;
  c.height = 16;
  const g = c.getContext('2d')!;
  return [c, g];
}

function px(g: CanvasRenderingContext2D, x: number, y: number, col: string, w = 1, h = 1): void {
  g.fillStyle = col;
  g.fillRect(x, y, w, h);
}

function paintFloor(pal: ZonePalette, seed: number): HTMLCanvasElement {
  const [c, g] = canvas16();
  const rng = new Rng(seed);
  px(g, 0, 0, pal.floor[0], 16, 16);
  // speckles
  for (let i = 0; i < 18; i++) px(g, rng.int(0, 15), rng.int(0, 15), rng.chance(0.5) ? pal.floor[1] : pal.floor[2]);
  // slab seams: a 2x2 slab grid offset per variant
  const off = rng.int(0, 1) * 8;
  for (let i = 0; i < 16; i++) {
    px(g, i, 15, pal.slab);
    px(g, 15, i, pal.slab);
    if (off) px(g, (i + off) % 16 === 0 ? 7 : -1, i, pal.slab);
  }
  // highlight top-left edge of the slab
  for (let i = 0; i < 15; i++) {
    px(g, i, 0, pal.floor[1]);
    px(g, 0, i, pal.floor[1]);
  }
  // occasional crack
  if (rng.chance(0.4)) {
    let x = rng.int(3, 12);
    let y = rng.int(3, 12);
    for (let k = 0; k < 5; k++) {
      px(g, x, y, pal.floor[2]);
      x += rng.int(-1, 1);
      y += 1;
      if (y > 14 || x < 1 || x > 14) break;
    }
  }
  return c;
}

function paintCorridor(pal: ZonePalette, seed: number): HTMLCanvasElement {
  const [c, g] = canvas16();
  const rng = new Rng(seed);
  px(g, 0, 0, pal.corridor[0], 16, 16);
  for (let i = 0; i < 26; i++) px(g, rng.int(0, 15), rng.int(0, 15), pal.corridor[1]);
  for (let i = 0; i < 6; i++) px(g, rng.int(0, 15), rng.int(0, 15), pal.floor[1]);
  return c;
}

function paintWallFace(pal: ZonePalette, seed: number): HTMLCanvasElement {
  const [c, g] = canvas16();
  const rng = new Rng(seed);
  px(g, 0, 0, pal.wallFace[2], 16, 16);
  // bricks: rows of height 4 (with 1px mortar), staggered
  for (let row = 0; row < 4; row++) {
    const y = row * 4;
    const stagger = row % 2 ? 4 : 0;
    for (let bx = -8 + stagger; bx < 16; bx += 8) {
      const x0 = Math.max(0, bx);
      const x1 = Math.min(16, bx + 7);
      if (x1 <= x0) continue;
      px(g, x0, y, pal.wallFace[0], x1 - x0, 3);
      px(g, x0, y, pal.wallFace[1], x1 - x0, 1);
      if (rng.chance(0.25)) px(g, x0 + rng.int(0, Math.max(0, x1 - x0 - 2)), y + 1, pal.wallFace[2], 2, 1);
    }
  }
  // darken toward the floor (ambient occlusion)
  g.fillStyle = 'rgba(0,0,0,0.28)';
  g.fillRect(0, 12, 16, 4);
  // moss / rust drips from the top
  for (let i = 0; i < 3; i++) {
    if (!rng.chance(0.55)) continue;
    const x = rng.int(0, 15);
    const len = rng.int(1, 4);
    px(g, x, 0, pal.accent, 1, len);
  }
  return c;
}

function paintWallTop(pal: ZonePalette): HTMLCanvasElement {
  const [c, g] = canvas16();
  px(g, 0, 0, pal.wallTop[0], 16, 16);
  g.fillStyle = 'rgba(255,255,255,0.03)';
  for (let i = 0; i < 16; i += 4) g.fillRect(i, 0, 2, 16);
  return c;
}

function paintPillar(pal: ZonePalette): HTMLCanvasElement {
  const [c, g] = canvas16();
  // base shadow
  px(g, 3, 13, 'rgba(0,0,0,0.35)', 11, 2);
  // column body
  px(g, 4, 3, pal.wallFace[2], 9, 11);
  px(g, 5, 3, pal.wallFace[0], 7, 10);
  px(g, 5, 3, pal.wallFace[1], 2, 10);
  px(g, 10, 3, pal.wallFace[2], 1, 10);
  // capital and base
  px(g, 3, 1, pal.wallFace[2], 11, 3);
  px(g, 4, 1, pal.wallTop[1], 9, 1);
  px(g, 4, 2, pal.wallFace[1], 9, 1);
  px(g, 3, 12, pal.wallFace[2], 11, 2);
  px(g, 4, 12, pal.wallFace[0], 9, 1);
  // moss
  px(g, 6, 4, pal.accent, 1, 2);
  return c;
}

function paintPitLip(pal: ZonePalette): HTMLCanvasElement {
  const [c, g] = canvas16();
  px(g, 0, 0, '#05040a', 16, 16);
  px(g, 0, 0, pal.wallFace[2], 16, 3);
  px(g, 0, 0, pal.floor[2], 16, 1);
  g.fillStyle = 'rgba(80,60,120,0.12)';
  g.fillRect(2, 8, 12, 6);
  return c;
}

function paintSpikes(): HTMLCanvasElement {
  const [c, g] = canvas16();
  const spike = (x: number, y: number) => {
    px(g, x, y + 3, '#140f1f', 3, 1);
    px(g, x + 1, y, '#f7f3ea', 1, 1);
    px(g, x + 1, y + 1, '#b7bcc7', 1, 2);
    px(g, x, y + 2, '#727a8a', 1, 1);
    px(g, x + 2, y + 2, '#454b5c', 1, 1);
  };
  px(g, 1, 1, 'rgba(20,15,31,0.45)', 14, 14);
  spike(2, 2);
  spike(9, 3);
  spike(5, 8);
  spike(11, 10);
  spike(2, 11);
  return c;
}

function paintGrass(pal: ZonePalette, seed: number): HTMLCanvasElement {
  const [c, g] = canvas16();
  const rng = new Rng(seed);
  const greens = ['#4caf50', '#a6e05a', '#246b45'];
  for (let i = 0; i < 7; i++) {
    const x = rng.int(1, 13);
    const y = rng.int(4, 14);
    px(g, x, y, greens[2], 1, 2);
    px(g, x + 1, y - 2, greens[0], 1, 4);
    px(g, x + 2, y - 1, greens[1], 1, 2);
  }
  void pal;
  return c;
}

function paintLava(frame: number): HTMLCanvasElement {
  const [c, g] = canvas16();
  const rng = new Rng(77 + frame);
  px(g, 0, 0, '#b8312a', 16, 16);
  for (let i = 0; i < 30; i++) px(g, rng.int(0, 15), rng.int(0, 15), rng.chance(0.5) ? '#f7973c' : '#d2452f', rng.int(1, 3), 1);
  for (let i = 0; i < 3; i++) {
    const x = rng.int(1, 13);
    const y = rng.int(1, 13);
    px(g, x, y, '#ffd35c', 2, 2);
    px(g, x, y, '#ffe9a8');
  }
  return c;
}

function paintWater(frame: number): HTMLCanvasElement {
  const [c, g] = canvas16();
  px(g, 0, 0, '#2c5f8f', 16, 16);
  for (let y = 0; y < 16; y += 4) {
    const off = (y / 4 + frame) % 2 ? 2 : 6;
    px(g, off, y + 1, '#6fb5e0', 4, 1);
    px(g, (off + 8) % 16, y + 3, '#4a8fc4', 3, 1);
  }
  return c;
}

function paintTurnstile(): HTMLCanvasElement {
  const [c, g] = canvas16();
  // ring
  g.strokeStyle = '#d6b46a';
  g.lineWidth = 1;
  px(g, 5, 2, '#d6b46a', 6, 1);
  px(g, 5, 13, '#d6b46a', 6, 1);
  px(g, 2, 5, '#d6b46a', 1, 6);
  px(g, 13, 5, '#d6b46a', 1, 6);
  px(g, 3, 3, '#d6b46a', 2, 2);
  px(g, 11, 11, '#d6b46a', 2, 2);
  px(g, 11, 3, '#8a6d34', 2, 2);
  px(g, 3, 11, '#8a6d34', 2, 2);
  // arrow heads (clockwise)
  px(g, 11, 1, '#ffd35c', 1, 3);
  px(g, 12, 2, '#ffd35c');
  px(g, 4, 12, '#ffd35c', 1, 3);
  px(g, 3, 13, '#ffd35c');
  px(g, 7, 7, '#ffd35c', 2, 2);
  return c;
}

function paintStairs(pal: ZonePalette): HTMLCanvasElement {
  const [c, g] = canvas16();
  px(g, 0, 0, '#05040a', 16, 16);
  const steps = 4;
  for (let i = 0; i < steps; i++) {
    const y = 2 + i * 3;
    const inset = i * 1;
    px(g, 1 + inset, y, pal.floor[1], 14 - inset * 2, 2);
    px(g, 1 + inset, y + 2, pal.wallFace[2], 14 - inset * 2, 1);
  }
  px(g, 0, 0, pal.wallFace[1], 16, 1);
  px(g, 0, 0, pal.wallFace[1], 1, 16);
  px(g, 15, 0, pal.wallFace[2], 1, 16);
  return c;
}

const cache = new Map<number, TileSet>();

export function getTileSet(zone: number): TileSet {
  const z = Math.max(0, Math.min(ZONES.length - 1, zone));
  const hit = cache.get(z);
  if (hit) return hit;
  const pal = ZONES[z];
  const ts: TileSet = {
    floor: [0, 1, 2, 3].map((i) => paintFloor(pal, 100 + i + z * 17)),
    corridor: [0, 1].map((i) => paintCorridor(pal, 200 + i + z * 17)),
    wallFace: [0, 1].map((i) => paintWallFace(pal, 300 + i + z * 17)),
    wallTop: paintWallTop(pal),
    pillar: paintPillar(pal),
    pitLip: paintPitLip(pal),
    spikes: paintSpikes(),
    grass: [0, 1].map((i) => paintGrass(pal, 400 + i)),
    lava: [0, 1, 2].map((i) => paintLava(i)),
    water: [0, 1].map((i) => paintWater(i)),
    turnstile: paintTurnstile(),
    stairs: paintStairs(pal),
  };
  cache.set(z, ts);
  return ts;
}
