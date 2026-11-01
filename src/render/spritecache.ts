// Converts SPRITES text definitions into canvases (normal, white flash, tinted).
import { PAL } from './palette.ts';
import { SPRITES } from './sprites.ts';

const normal = new Map<string, HTMLCanvasElement>();
const flash = new Map<string, HTMLCanvasElement>();
const tinted = new Map<string, HTMLCanvasElement>();
const dataUrls = new Map<string, string>();

function build(name: string, override?: (ch: string) => string | null): HTMLCanvasElement {
  const def = SPRITES[name] ?? SPRITES['missing'];
  const c = document.createElement('canvas');
  c.width = 16;
  c.height = 16;
  const g = c.getContext('2d')!;
  if (!def) {
    // placeholder: a coloured blob so missing art is obvious but not invisible
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    g.fillStyle = PAL.k;
    g.fillRect(3, 3, 10, 10);
    g.fillStyle = `hsl(${h % 360}, 70%, 60%)`;
    g.fillRect(4, 4, 8, 8);
    return c;
  }
  def.rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === '.' || ch === ' ') continue;
      const col = override ? override(ch) : PAL[ch];
      if (!col) continue;
      g.fillStyle = col;
      g.fillRect(x, y, 1, 1);
    }
  });
  return c;
}

export function hasSprite(name: string): boolean {
  return !!SPRITES[name];
}

export function sprite(name: string): HTMLCanvasElement {
  let c = normal.get(name);
  if (!c) {
    c = build(name);
    normal.set(name, c);
  }
  return c;
}

/** White silhouette (hit flash). */
export function spriteFlash(name: string): HTMLCanvasElement {
  let c = flash.get(name);
  if (!c) {
    c = build(name, (ch) => (ch === 'k' ? '#ffffff' : '#ffffff'));
    flash.set(name, c);
  }
  return c;
}

/** Recoloured silhouette, e.g. frozen (ice) or ghost previews. */
export function spriteTint(name: string, color: string, keepOutline = true): HTMLCanvasElement {
  const key = `${name}|${color}|${keepOutline}`;
  let c = tinted.get(key);
  if (!c) {
    c = build(name, (ch) => (keepOutline && ch === 'k' ? PAL.k : color));
    tinted.set(key, c);
  }
  return c;
}

/** PNG data URL scaled up crisply (for DOM <img> icons). */
export function spriteUrl(name: string, scale = 4): string {
  const key = `${name}@${scale}`;
  let u = dataUrls.get(key);
  if (u) return u;
  const src = sprite(name);
  const c = document.createElement('canvas');
  c.width = 16 * scale;
  c.height = 16 * scale;
  const g = c.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  g.drawImage(src, 0, 0, c.width, c.height);
  u = c.toDataURL('image/png');
  dataUrls.set(key, u);
  return u;
}
