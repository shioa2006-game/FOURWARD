// Auto-generated, text-free item diagrams: a tiny grid showing where you step and
// which tiles get hit, drawn in the slot's real direction.

import { ITEMS } from '../core/content.ts';
import type { ItemId } from '../core/types.ts';
import type { Dir } from '../core/geom.ts';
import { sprite } from '../render/spritecache.ts';

const N = 7; // grid size
const MID = 3;

/** rotate a [fwd, side] offset (fwd = the slot's direction) into grid coordinates */
function toGrid(fwd: number, side: number, d: Dir, ox: number, oy: number): [number, number] {
  const v: [number, number][] = [
    [side, -fwd],
    [fwd, side],
    [-side, fwd],
    [-fwd, -side],
  ];
  const [dx, dy] = v[d];
  return [ox + dx, oy + dy];
}

export function drawDiagram(c: HTMLCanvasElement, id: ItemId, d: Dir, star: number): void {
  const def = ITEMS[id];
  const cell = Math.floor(c.width / N);
  const g = c.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  g.clearRect(0, 0, c.width, c.height);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      g.fillStyle = (x + y) % 2 ? '#2a2638' : '#24212f';
      g.fillRect(x * cell, y * cell, cell - 1, cell - 1);
    }
  const mark = (x: number, y: number, col: string, inset = 0.14) => {
    if (x < 0 || y < 0 || x >= N || y >= N) return;
    g.fillStyle = col;
    g.fillRect(x * cell + cell * inset, y * cell + cell * inset, cell * (1 - inset * 2), cell * (1 - inset * 2));
  };
  const arrow = (x0: number, y0: number, x1: number, y1: number, col: string, dashed = false) => {
    g.strokeStyle = col;
    g.lineWidth = Math.max(2, cell / 6);
    g.lineCap = 'round';
    if (dashed) g.setLineDash([cell / 5, cell / 6]);
    const ax = x0 * cell + cell / 2;
    const ay = y0 * cell + cell / 2;
    const bx = x1 * cell + cell / 2;
    const by = y1 * cell + cell / 2;
    g.beginPath();
    g.moveTo(ax, ay);
    g.lineTo(bx, by);
    g.stroke();
    g.setLineDash([]);
    const ang = Math.atan2(by - ay, bx - ax);
    g.beginPath();
    g.moveTo(bx, by);
    g.lineTo(bx - Math.cos(ang - 0.6) * cell * 0.35, by - Math.sin(ang - 0.6) * cell * 0.35);
    g.moveTo(bx, by);
    g.lineTo(bx - Math.cos(ang + 0.6) * cell * 0.35, by - Math.sin(ang + 0.6) * cell * 0.35);
    g.stroke();
  };
  const hero = (x: number, y: number, alpha = 1) => {
    g.globalAlpha = alpha;
    g.drawImage(sprite('hero'), x * cell, y * cell, cell, cell);
    g.globalAlpha = 1;
  };
  const icon = (name: string, x: number, y: number, s = 0.7) => {
    g.drawImage(sprite(name), x * cell + (cell * (1 - s)) / 2, y * cell + (cell * (1 - s)) / 2, cell * s, cell * s);
  };
  const red = def.kind === 'magic' ? def.color : '#ef4a5a';
  const [sx, sy] = [MID, MID];

  switch (def.timing) {
    case 'lunge': {
      const [ex, ey] = toGrid(1, 0, d, sx, sy);
      hero(sx, sy, 0.35);
      arrow(sx, sy, ex, ey, '#ffe9a8');
      const [hx, hy] = toGrid(2, 0, d, sx, sy);
      mark(hx, hy, red);
      if (def.diagram.push) {
        const [px, py] = toGrid(2 + def.diagram.push, 0, d, sx, sy);
        arrow(hx, hy, px, py, '#f7973c');
      }
      hero(ex, ey);
      break;
    }
    case 'sweep': {
      const hits: [number, number][] = [
        [1, -1],
        [1, 0],
        [1, 1],
      ];
      if (star) hits.push([0, -1], [0, 1]);
      for (const [f, s2] of hits) {
        const [x, y] = toGrid(f, s2, d, sx, sy);
        mark(x, y, red);
      }
      const [ex, ey] = toGrid(1, 0, d, sx, sy);
      hero(sx, sy);
      arrow(sx, sy, ex, ey, '#ffe9a8', true);
      break;
    }
    case 'hold': {
      const reach = id === 'spear' ? 2 + star : 5;
      for (let k = 1; k <= Math.min(reach, 3); k++) {
        const [x, y] = toGrid(k, 0, d, sx, sy);
        if (id === 'spear') mark(x, y, red);
        else {
          g.fillStyle = red;
          g.globalAlpha = 1 - (k - 1) * 0.25;
          g.beginPath();
          g.arc(x * cell + cell / 2, y * cell + cell / 2, cell * 0.2, 0, Math.PI * 2);
          g.fill();
          g.globalAlpha = 1;
        }
      }
      hero(sx, sy);
      // stays put: a small anchor under the hero
      g.fillStyle = '#ffe9a8';
      g.fillRect(sx * cell + cell * 0.3, sy * cell + cell * 0.88, cell * 0.4, cell * 0.08);
      break;
    }
    case 'step': {
      const [ex, ey] = toGrid(1, 0, d, sx, sy);
      hero(sx, sy, 0.35);
      arrow(sx, sy, ex, ey, '#ffe9a8');
      hero(ex, ey);
      if (def.diagram.self === 'guard') {
        const [gx, gy] = toGrid(2, 0, d, sx, sy);
        icon('item_shield', gx, gy);
        if (star) {
          const [ax, ay] = toGrid(1, -1, d, sx, sy);
          const [bx, by] = toGrid(1, 1, d, sx, sy);
          icon('item_shield', ax, ay, 0.5);
          icon('item_shield', bx, by, 0.5);
        }
      } else if (def.diagram.self === 'heal') icon('ui_heart', ex, ey - (d === 0 ? 1 : 0) + (d === 2 ? -1 : 0) || ey - 1, 0.6);
      else if (def.diagram.self === 'bomb') {
        for (let dd = 0; dd < 4; dd++) {
          const [x, y] = toGrid(1, 0, dd as Dir, sx, sy);
          if (x === ex && y === ey) continue;
          mark(x, y, 'rgba(247,151,60,0.45)', 0.2);
        }
        if (star)
          for (const [f, s2] of [
            [1, 1],
            [1, -1],
            [-1, 1],
            [-1, -1],
          ] as [number, number][]) {
            const [x, y] = toGrid(f, s2, d, sx, sy);
            mark(x, y, 'rgba(247,151,60,0.45)', 0.2);
          }
        icon('fx_bomb', sx, sy, 0.8);
      }
      break;
    }
    case 'dash': {
      const [ex, ey] = toGrid(3, 0, d, sx, sy);
      hero(sx, sy, 0.35);
      arrow(sx, sy, ex, ey, '#ffe9a8');
      hero(ex, ey);
      const [hx, hy] = toGrid(4, 0, d, sx, sy);
      mark(hx, hy, red);
      break;
    }
  }
  // cooldown marker
  if (def.cooldown) {
    g.fillStyle = 'rgba(111, 226, 240, 0.9)';
    g.font = `bold ${Math.round(cell * 0.6)}px system-ui`;
    g.textAlign = 'right';
    g.textBaseline = 'top';
    g.fillText(`⟳${def.cooldown}`, c.width - 4, 3);
  }
}
