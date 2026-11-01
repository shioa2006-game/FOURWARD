// Canvas renderer: cached pixel-art tile layer, soft fog, animated units driven by
// engine events, attack effects, particles, floating numbers, threat overlays.

import { T, isWalkable, type FloorMap } from '../core/dungeon.ts';
import { DX, DY, type Dir } from '../core/geom.ts';
import type { GameEvent, GameState, Unit } from '../core/types.ts';
import { getTileSet, ZONES, type TileSet } from './tiles.ts';
import { sprite, spriteFlash, spriteTint, hasSprite } from './spritecache.ts';
import { Particles, clamp01, easeOutCubic, easeOutBack, type Effect, type FloatText } from './fx.ts';
import { PAL } from './palette.ts';
import { WARDEN_CROSS } from '../core/content.ts';

export interface ThreatCell {
  now: number; // damage that lands if you END your turn here (0 = safe)
  later: number; // turns until a delayed blast (0 = none)
}

export interface DirBadge {
  kind: 'kill' | 'hit' | 'danger' | 'heal' | 'swap' | 'stairs' | 'upgrade' | 'blocked' | 'guard' | 'none';
}

export interface DirPreview {
  dir: Dir;
  valid: boolean;
  dest: { x: number; y: number } | null;
  actionDest: { x: number; y: number } | null;
  path: number[];
  delayedTiles: number[];
  hitIds: number[];
  killIds: number[];
  dmgTaken: number;
  badge: DirBadge['kind'];
  tiles: number[]; // affected tiles (for the hover diagram on the map)
}

export interface RenderModel {
  state: GameState;
  zone: number;
  visible: Set<number>;
  threat: Map<number, ThreatCell>;
  previews: DirPreview[] | null;
  hoverDir: Dir | -1;
  previewFocus: boolean;
  inspectZone: Set<number> | null;
  inspectId: number;
  unitSprite: (u: Unit) => string;
  itemSprite: (id: string) => string;
  slotReady: (dir: Dir) => boolean;
}

interface VisualEnt {
  id: number;
  ox: number; // current offset (tiles) applied to the logical position
  oy: number;
  sx: number; // tween start offset
  sy: number;
  t0: number;
  dur: number;
  arc: number; // jump height for leaps
  flashUntil: number;
  squashT: number;
  lungeDir: number;
  lungeT: number;
}

interface Ghost {
  x: number;
  y: number;
  sprite: string;
  t0: number;
  how: string;
  boss: boolean;
}

interface Scheduled {
  at: number;
  fn: () => void;
}

const PLAYER_ID = 0;

export class Renderer {
  canvas: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
  dpr = 1;
  W = 0;
  H = 0;
  ts = 48;
  baseTs = 48;
  insets = { top: 0, bottom: 0, left: 0, right: 0 };
  camX = 0;
  camY = 0;
  camInit = false;
  clock = 0;
  lastFrame = 0;
  hitStopUntil = 0;
  shakePow = 0;
  shakeUntil = 0;
  vis = new Map<number, VisualEnt>();
  ghosts: Ghost[] = [];
  effects: Effect[] = [];
  particles = new Particles();
  texts: FloatText[] = [];
  queue: Scheduled[] = [];
  mapCanvas: HTMLCanvasElement | null = null;
  mapKey = '';
  mapExplored: Uint8Array | null = null;
  fogCanvas: HTMLCanvasElement;
  tileset: TileSet | null = null;
  zone = 0;
  busyUntil = 0;
  onDamageShown: ((ev: Extract<GameEvent, { t: 'damage' }>) => void) | null = null;
  playerDead = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d', { alpha: false })!;
    this.fogCanvas = document.createElement('canvas');
    this.resize();
  }

  setInsets(top: number, bottom: number, left = 0, right = 0): void {
    this.insets = { top, bottom, left, right };
    this.resize();
  }

  resize(): void {
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    this.dpr = dpr;
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.W = w;
    this.H = h;
    const vw = w - (this.insets.left + this.insets.right) * dpr;
    const vh = h - (this.insets.top + this.insets.bottom) * dpr;
    // One rule for every shape: at least 12 columns and 9.5 rows of map. (A separate
    // portrait rule zoomed tall phones in so far that rooms no longer fit.)
    let ts = Math.min(vw / 12, vh / 9.5);
    const scale = ts / 16;
    ts = scale < 6 ? Math.max(2, Math.floor(scale)) * 16 : Math.floor(ts);
    this.ts = Math.max(32, ts);
    this.baseTs = this.ts;
  }

  /** Centre of the map view region in device pixels. */
  viewCenter(): [number, number] {
    const d = this.dpr;
    const cx = (this.insets.left * d + (this.W - this.insets.right * d)) / 2;
    const cy = (this.insets.top * d + (this.H - this.insets.bottom * d)) / 2;
    return [cx, cy];
  }

  /** Convert client (CSS px) coordinates to a tile position. */
  screenToTile(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const px = (clientX - rect.left) * this.dpr;
    const py = (clientY - rect.top) * this.dpr;
    const [cx, cy] = this.viewCenter();
    const x = Math.floor((px - cx) / this.ts + this.camX + 0.5);
    const y = Math.floor((py - cy) / this.ts + this.camY + 0.5);
    return { x, y };
  }

  isBusy(): boolean {
    return this.clock < this.busyUntil || this.queue.length > 0;
  }

  // -------------------------------------------------------------------------
  // events -> animations

  ent(id: number): VisualEnt {
    let v = this.vis.get(id);
    if (!v) {
      v = { id, ox: 0, oy: 0, sx: 0, sy: 0, t0: 0, dur: 0, arc: 0, flashUntil: 0, squashT: -1e9, lungeDir: -1, lungeT: -1e9 };
      this.vis.set(id, v);
    }
    return v;
  }

  /** Snap every running animation to its end (new input arrived). */
  flush(): void {
    const q = this.queue;
    this.queue = [];
    q.sort((a, b) => a.at - b.at);
    for (const s of q) s.fn();
    for (const v of this.vis.values()) {
      v.ox = 0;
      v.oy = 0;
      v.dur = 0;
      v.arc = 0;
    }
    this.busyUntil = this.clock;
  }

  schedule(delay: number, fn: () => void): void {
    if (delay <= 0) fn();
    else this.queue.push({ at: this.clock + delay, fn });
  }

  playEvents(events: GameEvent[], state: GameState, unitSprite: (u: Unit) => string, sfx: (n: string) => void): void {
    // Phase timing: player action at 0ms, enemy phase after a short beat.
    const PHASE = 105;
    let phaseStart = 0;
    let t = 0;
    const kindOf = new Map<number, string>();
    for (const u of state.units) kindOf.set(u.id, unitSprite(u));
    for (const ev of events) {
      switch (ev.t) {
        case 'enemyPhase':
          phaseStart += PHASE;
          t = phaseStart;
          break;
        case 'move': {
          const v = this.ent(ev.id);
          // logical position is already the destination: start offset at (from - to)
          const startOff = { x: ev.fx - ev.tx + v.ox, y: ev.fy - ev.ty + v.oy };
          v.ox = startOff.x;
          v.oy = startOff.y;
          const dur = ev.how === 'dash' || ev.how === 'hook' ? 120 : ev.how === 'push' || ev.how === 'pull' ? 110 : ev.how === 'leap' ? 170 : 85;
          const at = t;
          this.schedule(at, () => {
            v.sx = v.ox;
            v.sy = v.oy;
            v.t0 = this.clock;
            v.dur = dur;
            v.arc = ev.how === 'leap' ? 0.6 : ev.how === 'step' ? 0.08 : 0;
            if (ev.how === 'dash' || ev.how === 'hook') this.trail(ev.fx, ev.fy, ev.tx, ev.ty);
            if (ev.id === PLAYER_ID) sfx(ev.how === 'dash' ? 'dash' : ev.how === 'hook' ? 'hook' : 'step');
          });
          this.busyUntil = Math.max(this.busyUntil, this.clock + at + dur);
          break;
        }
        case 'swing': {
          const at = t;
          this.schedule(at, () => this.swingFx(ev, sfx));
          const v = this.ent(ev.id);
          this.schedule(at, () => {
            v.lungeDir = ev.dir;
            v.lungeT = this.clock;
          });
          t += 25;
          break;
        }
        case 'shot': {
          const at = t;
          const dist = Math.abs(ev.tx - ev.fx) + Math.abs(ev.ty - ev.fy);
          const dur = Math.min(220, 50 + dist * 28);
          this.schedule(at, () => {
            this.effects.push(this.mkEffect('projectile', ev.fx, ev.fy, ev.tx, ev.ty, dur, ev.kind));
            sfx(ev.kind === 'arrow' ? 'arrow' : ev.kind === 'fire' ? 'fire' : ev.kind === 'frost' ? 'frost' : ev.kind === 'hook' ? 'hook' : 'arrow');
          });
          t += dur;
          break;
        }
        case 'beam': {
          const at = t;
          this.schedule(at, () => {
            const e = this.mkEffect('beam', 0, 0, 0, 0, 260, ev.kind);
            e.tiles = ev.tiles.map((i) => ({ x: i % state.map.w, y: Math.floor(i / state.map.w) }));
            this.effects.push(e);
            sfx(ev.kind === 'thunder' ? 'zap' : 'fire');
          });
          t += 60;
          break;
        }
        case 'damage': {
          const at = t + 20;
          this.schedule(at, () => {
            const v = this.ent(ev.id);
            v.flashUntil = this.clock + 110;
            v.squashT = this.clock;
            const big = ev.amount >= 3;
            this.texts.push({ x: ev.x, y: ev.y - 0.2, text: String(ev.amount), color: ev.id === PLAYER_ID ? '#ff5b6e' : '#fff3c4', t0: this.clock, dur: 750, big });
            this.particles.burst(ev.x, ev.y, 6 + ev.amount * 3, ev.id === PLAYER_ID ? ['#ff5b6e', '#9c2742'] : ['#ffffff', '#ffd35c', '#ef4a5a'], 4.5, 380);
            this.hitStopUntil = this.clock + (big ? 70 : 40);
            this.shake(ev.id === PLAYER_ID ? 7 : big ? 6 : 3, 160);
            sfx(ev.id === PLAYER_ID ? 'hurt' : big ? 'heavy' : 'hit');
            if (this.onDamageShown) this.onDamageShown(ev);
          });
          t += 10;
          break;
        }
        case 'block': {
          const at = t + 20;
          this.schedule(at, () => {
            const e = this.mkEffect('guard', ev.x, ev.y, ev.x, ev.y, 300, '#ffd35c');
            e.dir = ev.dir;
            this.effects.push(e);
            this.particles.spray(ev.x + (ev.dir >= 0 ? DX[ev.dir] * 0.45 : 0), ev.y + (ev.dir >= 0 ? DY[ev.dir] * 0.45 : 0), ev.dir >= 0 ? DX[ev.dir] : 0, ev.dir >= 0 ? DY[ev.dir] : -1, 8, ['#ffd35c', '#ffffff'], 4);
            sfx('block');
          });
          break;
        }
        case 'heal': {
          this.schedule(t, () => {
            this.particles.rise(ev.x, ev.y, 12, ['#a6e05a', '#ffffff', '#ff8fc6']);
            this.texts.push({ x: ev.x, y: ev.y - 0.3, text: `+${ev.amount}`, color: '#a6e05a', t0: this.clock, dur: 800, big: false });
            this.effects.push(this.mkEffect('heal', ev.x, ev.y, ev.x, ev.y, 450, '#a6e05a'));
            sfx('heal');
          });
          break;
        }
        case 'death': {
          const at = t + 60;
          const spr = kindOf.get(ev.id) ?? (ev.kind || 'slime');
          this.schedule(at, () => {
            this.ghosts.push({ x: ev.x, y: ev.y, sprite: spr, t0: this.clock, how: ev.how, boss: ev.kind.startsWith('boss') });
            this.particles.burst(ev.x, ev.y, 18, ['#ffffff', '#ffd35c', '#c27bf0', '#6fe2f0'], 5.5, 520, 0.1);
            this.effects.push(this.mkEffect('ring', ev.x, ev.y, ev.x, ev.y, 320, '#ffffff'));
            sfx(ev.how === 'fall' ? 'fall' : 'kill');
            if (ev.id === PLAYER_ID) this.playerDead = true;
          });
          t += 20;
          break;
        }
        case 'explode': {
          const at = t;
          this.schedule(at, () => {
            const e = this.mkEffect('explosion', ev.x, ev.y, ev.x, ev.y, 420, '#f7973c');
            e.tiles = ev.tiles.map((i) => ({ x: i % state.map.w, y: Math.floor(i / state.map.w) }));
            this.effects.push(e);
            for (const tt of e.tiles) this.particles.burst(tt.x, tt.y, 5, ['#ffd35c', '#f7973c', '#ef4a5a', '#454b5c'], 4, 500, 0.12, 2);
            this.shake(10, 260);
            this.hitStopUntil = this.clock + 60;
            sfx('boom');
          });
          t += 40;
          break;
        }
        case 'status': {
          this.schedule(t, () => {
            if (ev.status === 'freeze') {
              this.particles.burst(ev.x, ev.y, 10, ['#d9f3ff', '#6fe2f0'], 3, 500);
              sfx('frost');
            } else if (ev.status === 'stun') {
              this.particles.burst(ev.x, ev.y - 0.3, 6, ['#ffd35c', '#ffffff'], 2.5, 400);
            } else if (ev.status === 'burn') {
              this.particles.rise(ev.x, ev.y, 8, ['#f7973c', '#ffd35c', '#ef4a5a']);
            } else if (ev.status === 'wake') {
              this.texts.push({ x: ev.x, y: ev.y - 0.55, text: '!', color: '#ffd35c', t0: this.clock, dur: 600, big: true });
              sfx('wake');
            } else if (ev.status === 'rotate') {
              this.effects.push(this.mkEffect('ring', ev.x, ev.y, ev.x, ev.y, 420, '#d6b46a'));
              sfx('rotate');
            }
          });
          break;
        }
        case 'pickup': {
          this.schedule(t, () => {
            const col = ev.kind === 'coin' ? '#ffd35c' : ev.kind === 'heart' ? '#ff8fc6' : '#6fe2f0';
            this.particles.rise(ev.x, ev.y, 8, [col, '#ffffff'], 500);
            this.texts.push({ x: ev.x, y: ev.y - 0.4, text: ev.kind === 'coin' ? `+${ev.amount}` : ev.kind === 'heart' ? `+${ev.amount}` : '+', color: col, t0: this.clock, dur: 700, big: false });
            sfx(ev.kind === 'coin' ? 'coin' : 'heal');
          });
          break;
        }
        case 'equip':
          this.schedule(t, () => sfx('equip'));
          break;
        case 'upgrade':
          this.schedule(t, () => sfx('upgrade'));
          break;
        case 'rotate':
          this.schedule(t, () => sfx('rotate'));
          break;
        case 'spawn':
          this.schedule(t, () => {
            this.particles.burst(ev.x, ev.y, 10, ['#c27bf0', '#ffffff'], 3, 400);
            const v = this.ent(ev.id);
            v.squashT = this.clock;
          });
          break;
        case 'stairs':
          this.schedule(t, () => {
            this.particles.rise(ev.x, ev.y, 24, ['#ffd35c', '#ffffff', '#6fe2f0'], 900);
            this.effects.push(this.mkEffect('ring', ev.x, ev.y, ev.x, ev.y, 600, '#ffd35c'));
            sfx('door');
          });
          break;
        case 'prop':
          this.schedule(t, () => {
            if (ev.what === 'break') this.particles.burst(ev.x, ev.y, 12, ['#b07a4f', '#6e452d', '#f7973c'], 4, 420);
            if (ev.what === 'unlock') {
              this.particles.burst(ev.x, ev.y - 0.2, 22, ['#ffd35c', '#ffffff', '#b7bcc7'], 4, 600);
              this.effects.push(this.mkEffect('ring', ev.x, ev.y - 0.2, ev.x, ev.y, 520, '#ffd35c'));
              sfx('upgrade');
            }
            if (ev.what === 'open') {
              this.particles.rise(ev.x, ev.y, 10, ['#ffd35c', '#ffffff']);
              sfx('coin');
            }
          });
          break;
        case 'shake':
          this.schedule(t, () => this.shake(ev.power, 200));
          break;
        case 'sfx':
          this.schedule(t, () => sfx(ev.name));
          break;
        case 'text':
          this.schedule(t, () => this.texts.push({ x: ev.x, y: ev.y, text: ev.text, color: ev.color, t0: this.clock, dur: 900, big: false }));
          break;
        case 'trick':
          // a named combo: big golden callout over the hero
          this.schedule(t + 120, () => {
            this.texts.push({ x: ev.x, y: ev.y - 1.1, text: ev.text, color: '#ffd35c', t0: this.clock, dur: 1300, big: true });
            this.particles.burst(ev.x, ev.y - 1.1, 16, ['#ffd35c', '#ffe9a8', '#ffffff'], 3.5, 600, 0.08, 1);
            sfx('upgrade');
          });
          break;
        case 'bump':
          this.schedule(0, () => {
            const v = this.ent(PLAYER_ID);
            v.lungeDir = ev.dir;
            v.lungeT = this.clock - 40;
            sfx('bump');
          });
          break;
        case 'brace':
          // planted feet: the turn passes without moving
          this.schedule(t, () => {
            const v = this.ent(PLAYER_ID);
            v.lungeDir = ev.dir;
            v.lungeT = this.clock - 30;
            v.squashT = this.clock;
            const st = this.lastState;
            if (st) this.particles.spray(st.player.x, st.player.y + 0.35, -DX[ev.dir] * 0.5, -0.4, 6, ['#b7bcc7', '#727a8a'], 2.2, 300);
            sfx('bump');
          });
          break;
        case 'descend':
          this.schedule(t, () => sfx('stairs'));
          break;
      }
    }
    this.busyUntil = Math.max(this.busyUntil, this.clock + t + 60);
  }

  mkEffect(kind: Effect['kind'], x: number, y: number, tx: number, ty: number, dur: number, color: string): Effect {
    return { kind, t0: this.clock, dur, x, y, tx, ty, dir: 0, color, tiles: [], size: 1 };
  }

  trail(fx: number, fy: number, tx: number, ty: number): void {
    const n = Math.abs(tx - fx) + Math.abs(ty - fy);
    for (let k = 0; k <= n; k++) {
      const x = fx + ((tx - fx) * k) / Math.max(1, n);
      const y = fy + ((ty - fy) * k) / Math.max(1, n);
      this.particles.burst(x, y, 3, ['#ffffff', '#6fe2f0'], 1.5, 300, 0.08, 0);
    }
  }

  swingFx(ev: Extract<GameEvent, { t: 'swing' }>, sfx: (n: string) => void): void {
    const st = this.lastState;
    if (!st) return;
    const w = st.map.w;
    const tiles = ev.tiles.map((i) => ({ x: i % w, y: Math.floor(i / w) }));
    const owner = ev.id === PLAYER_ID ? st.player : st.units.find((u) => u.id === ev.id);
    const ox = owner ? owner.x : tiles[0]?.x ?? 0;
    const oy = owner ? owner.y : tiles[0]?.y ?? 0;
    const map: Record<string, Effect['kind']> = {
      sword: 'slash',
      dagger: 'stab',
      spear: 'thrust',
      axe: 'cleave',
      hammer: 'smash',
      thunder: 'lightning',
      enemy: 'slash',
      shield: 'guard',
    };
    const kind = map[ev.item] ?? 'slash';
    const e = this.mkEffect(kind, ox, oy, ox + DX[ev.dir], oy + DY[ev.dir], kind === 'smash' ? 260 : 200, ev.item === 'enemy' ? '#ef4a5a' : '#ffffff');
    e.dir = ev.dir;
    e.tiles = tiles;
    this.effects.push(e);
    if (ev.item === 'enemy') sfx('swing');
    else if (kind === 'thrust' || kind === 'stab') sfx('thrust');
    else if (kind === 'lightning') sfx('zap');
    else if (kind !== 'guard') sfx('swing');
  }

  shake(power: number, dur: number): void {
    this.shakePow = Math.max(this.shakePow * (this.clock < this.shakeUntil ? 1 : 0), power);
    this.shakeUntil = this.clock + dur;
  }

  // -------------------------------------------------------------------------
  // drawing

  lastState: GameState | null = null;

  frame(now: number, model: RenderModel | null): void {
    const dtRaw = this.lastFrame ? Math.min(50, now - this.lastFrame) : 16;
    this.lastFrame = now;
    const stopped = this.clock < this.hitStopUntil;
    const dt = stopped ? dtRaw * 0.15 : dtRaw;
    this.clock += dt;
    // run scheduled callbacks
    if (this.queue.length) {
      const due = this.queue.filter((s) => s.at <= this.clock);
      if (due.length) {
        this.queue = this.queue.filter((s) => s.at > this.clock);
        due.sort((a, b) => a.at - b.at);
        for (const s of due) s.fn();
      }
    }
    // tweens
    for (const v of this.vis.values()) {
      if (v.dur > 0) {
        const k = clamp01((this.clock - v.t0) / v.dur);
        const e = easeOutCubic(k);
        v.ox = v.sx * (1 - e);
        v.oy = v.sy * (1 - e);
        if (k >= 1) {
          v.dur = 0;
          v.ox = 0;
          v.oy = 0;
        }
      }
    }
    this.particles.update(dt);

    const g = this.g;
    g.imageSmoothingEnabled = false;
    if (!model) {
      g.fillStyle = '#0d0b17';
      g.fillRect(0, 0, this.W, this.H);
      return;
    }
    const st = model.state;
    this.lastState = st;
    if (this.zone !== model.zone || !this.tileset) {
      this.zone = model.zone;
      this.tileset = getTileSet(model.zone);
      this.mapKey = '';
    }
    const pal = ZONES[Math.min(ZONES.length - 1, model.zone)];
    g.fillStyle = pal.void;
    g.fillRect(0, 0, this.W, this.H);

    // camera
    const pv = this.ent(PLAYER_ID);
    let targetX = st.player.x + pv.ox;
    let targetY = st.player.y + pv.oy;
    this.ts = this.baseTs;
    const forecast = model.previewFocus && model.hoverDir >= 0 ? model.previews?.[model.hoverDir] : null;
    if (forecast?.valid) {
      // Frame the hero AND the forecast, even on small portrait screens.
      const cells = [st.player.y * st.map.w + st.player.x, ...forecast.path, ...forecast.tiles, ...forecast.delayedTiles].filter((i) => model.visible.has(i));
      if (forecast.dest && model.visible.has(forecast.dest.y * st.map.w + forecast.dest.x)) cells.push(forecast.dest.y * st.map.w + forecast.dest.x);
      const xs = cells.map((i) => i % st.map.w), ys = cells.map((i) => Math.floor(i / st.map.w));
      const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
      targetX = (minX + maxX) / 2;
      targetY = (minY + maxY) / 2;
      const vw = this.W - (this.insets.left + this.insets.right) * this.dpr;
      const vh = this.H - (this.insets.top + this.insets.bottom) * this.dpr;
      this.ts = Math.max(16 * this.dpr, Math.min(this.baseTs, Math.floor(vw / (maxX - minX + 2)), Math.floor(vh / (maxY - minY + 2))));
    }
    if (!this.camInit) {
      this.camX = targetX;
      this.camY = targetY;
      this.camInit = true;
    } else {
      const k = 1 - Math.pow(0.0001, dtRaw / 1000);
      this.camX += (targetX - this.camX) * k;
      this.camY += (targetY - this.camY) * k;
    }
    let shx = 0;
    let shy = 0;
    if (this.clock < this.shakeUntil) {
      const p = this.shakePow * this.dpr * ((this.shakeUntil - this.clock) / 260);
      shx = (Math.random() - 0.5) * p;
      shy = (Math.random() - 0.5) * p;
    }
    const ts = this.ts;
    const [vcx, vcy] = this.viewCenter();
    const ox = Math.round(vcx - (this.camX + 0.5) * ts + shx);
    const oy = Math.round(vcy - (this.camY + 0.5) * ts + shy);
    const toPx = (x: number) => ox + x * ts;
    const toPy = (y: number) => oy + y * ts;

    this.ensureMapCanvas(st.map, st.explored);
    // static tiles
    if (this.mapCanvas) g.drawImage(this.mapCanvas, 0, 0, st.map.w * 16, st.map.h * 16, ox, oy, st.map.w * ts, st.map.h * ts);
    this.drawAnimatedTiles(st, model, toPx, toPy);

    // threat overlay
    this.drawThreat(st, model, toPx, toPy);

    // fires, bombs, pickups, props
    this.drawWorldObjects(st, model, toPx, toPy);

    // units (sorted by y), player
    this.drawUnits(st, model, toPx, toPy);

    // fog of war on top of the world
    this.drawFog(st, model, ox, oy);

    // previews (above fog so they are readable)
    this.drawPreview(st, model, toPx, toPy);

    // effects / particles / texts
    this.drawEffects(toPx, toPy);
    this.drawParticles(toPx, toPy);
    this.drawTexts(toPx, toPy);

    // vignette
    const grd = g.createRadialGradient(vcx, vcy, Math.min(this.W, this.H) * 0.35, vcx, vcy, Math.max(this.W, this.H) * 0.75);
    grd.addColorStop(0, 'rgba(0,0,0,0)');
    grd.addColorStop(1, 'rgba(0,0,0,0.55)');
    g.fillStyle = grd;
    g.fillRect(0, 0, this.W, this.H);

    this.drawOffscreen(st, model, toPx, toPy);
    this.drawMinimap(st, model);
  }

  /** Awake monsters outside the view get a red arrow on the screen edge. */
  drawOffscreen(st: GameState, model: RenderModel, toPx: (x: number) => number, toPy: (y: number) => number): void {
    const g = this.g;
    const ts = this.ts;
    const d = this.dpr;
    const left = this.insets.left * d + 14 * d;
    const right = this.W - this.insets.right * d - 14 * d;
    const top = this.insets.top * d + 14 * d;
    const bottom = this.H - this.insets.bottom * d - 14 * d;
    const [vcx, vcy] = this.viewCenter();
    for (const u of st.units) {
      if (!u.awake || !model.visible.has(u.y * st.map.w + u.x)) continue;
      const ux = toPx(u.x) + ts / 2;
      const uy = toPy(u.y) + ts / 2;
      if (ux >= left && ux <= right && uy >= top && uy <= bottom) continue;
      const ang = Math.atan2(uy - vcy, ux - vcx);
      // clamp the ray from the centre to the view rectangle
      const kx = Math.cos(ang) > 0 ? (right - vcx) / Math.cos(ang) : (left - vcx) / Math.cos(ang);
      const ky = Math.sin(ang) > 0 ? (bottom - vcy) / Math.sin(ang) : (top - vcy) / Math.sin(ang);
      const k = Math.min(Math.abs(kx), Math.abs(ky));
      const ax = vcx + Math.cos(ang) * k;
      const ay = vcy + Math.sin(ang) * k;
      const r = 13 * d;
      g.save();
      g.translate(ax, ay);
      g.fillStyle = 'rgba(10, 8, 20, 0.75)';
      g.beginPath();
      g.arc(0, 0, r, 0, Math.PI * 2);
      g.fill();
      g.drawImage(sprite(model.unitSprite(u)), -r * 0.75, -r * 0.75, r * 1.5, r * 1.5);
      g.rotate(ang);
      g.fillStyle = '#ef4a5a';
      g.beginPath();
      g.moveTo(r + 7 * d, 0);
      g.lineTo(r, -5 * d);
      g.lineTo(r, 5 * d);
      g.closePath();
      g.fill();
      g.restore();
    }
  }

  /** Tiny explored-map overview in the top-right corner. */
  drawMinimap(st: GameState, model: RenderModel): void {
    const g = this.g;
    const map = st.map;
    const d = this.dpr;
    const cell = Math.max(2, Math.round(2.6 * d));
    const mw = map.w * cell;
    const mh = map.h * cell;
    const x0 = this.W - mw - 12 * d;
    const y0 = this.insets.top * d + 6 * d;
    g.fillStyle = 'rgba(10, 8, 20, 0.55)';
    g.fillRect(x0 - 4 * d, y0 - 4 * d, mw + 8 * d, mh + 8 * d);
    for (let i = 0; i < map.tiles.length; i++) {
      if (!st.explored[i]) continue;
      const t = map.tiles[i];
      if (t === T.Wall) continue;
      const x = i % map.w;
      const y = Math.floor(i / map.w);
      g.fillStyle = t === T.Stairs ? '#ffd35c' : t === T.Pit || t === T.Lava ? '#1a1526' : t === T.Pillar ? '#3a3450' : map.room[i] >= 0 ? '#5d5678' : '#45405c';
      g.fillRect(x0 + x * cell, y0 + y * cell, cell, cell);
    }
    for (const pr of st.props) {
      if (!st.explored[pr.y * map.w + pr.x]) continue;
      if (pr.kind !== 'pedestal' && pr.kind !== 'anvil' && pr.kind !== 'chest' && pr.kind !== 'fountain') continue;
      if ((pr.kind === 'chest' || pr.kind === 'fountain') && pr.used) continue;
      g.fillStyle = pr.kind === 'pedestal' ? (pr.item ? (pr.lockRoom >= 0 ? '#9a93b8' : '#6fe2f0') : '#45405c') : pr.kind === 'anvil' ? '#f7973c' : '#c48a23';
      g.fillRect(x0 + pr.x * cell - cell * 0.25, y0 + pr.y * cell - cell * 0.25, cell * 1.5, cell * 1.5);
    }
    for (const u of st.units) {
      if (!model.visible.has(u.y * map.w + u.x)) continue;
      g.fillStyle = u.awake ? '#ef4a5a' : '#9c2742';
      g.fillRect(x0 + u.x * cell, y0 + u.y * cell, cell, cell);
    }
    if (Math.floor(this.clock / 300) % 2 === 0 || true) {
      g.fillStyle = '#ffffff';
      g.fillRect(x0 + st.player.x * cell - cell * 0.25, y0 + st.player.y * cell - cell * 0.25, cell * 1.5, cell * 1.5);
    }
  }

  ensureMapCanvas(map: FloorMap, explored: number[]): void {
    const key = `${map.w}x${map.h}:${map.start}:${map.stairs}:${this.zone}`;
    if (!this.mapCanvas || this.mapKey !== key) {
      this.mapCanvas = document.createElement('canvas');
      this.mapCanvas.width = map.w * 16;
      this.mapCanvas.height = map.h * 16;
      this.mapKey = key;
      this.mapExplored = new Uint8Array(map.w * map.h);
      this.tilesSig = map.tiles.slice();
      const g = this.mapCanvas.getContext('2d')!;
      g.fillStyle = ZONES[this.zone].void;
      g.fillRect(0, 0, this.mapCanvas.width, this.mapCanvas.height);
    }
    const g = this.mapCanvas.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    const ex = this.mapExplored!;
    const dirty = new Set<number>();
    for (let i = 0; i < explored.length; i++) {
      if (explored[i] && !ex[i]) {
        ex[i] = 1;
        dirty.add(i);
      }
      if (this.tilesSig && this.tilesSig[i] !== map.tiles[i]) {
        this.tilesSig[i] = map.tiles[i];
        if (ex[i]) dirty.add(i);
      }
    }
    if (dirty.size === 0) return;
    // a newly explored tile changes how its neighbours' walls look
    const expanded = new Set<number>();
    for (const i of dirty) {
      const x = i % map.w;
      const y = Math.floor(i / map.w);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= map.w || ny >= map.h) continue;
          const ni = ny * map.w + nx;
          if (ex[ni]) expanded.add(ni);
        }
    }
    for (const i of expanded) this.paintTile(g, map, i);
  }

  tilesSig: number[] | null = null;

  paintTile(g: CanvasRenderingContext2D, map: FloorMap, i: number): void {
    const ts = this.tileset!;
    const pal = ZONES[this.zone];
    const x = i % map.w;
    const y = Math.floor(i / map.w);
    const px = x * 16;
    const py = y * 16;
    const t = map.tiles[i];
    const h = ((x * 73856093) ^ (y * 19349663)) >>> 0;
    g.fillStyle = pal.void;
    g.fillRect(px, py, 16, 16);
    const below = y + 1 < map.h ? map.tiles[i + map.w] : T.Wall;
    const floorTex = map.room[i] >= 0 ? ts.floor[h % ts.floor.length] : ts.corridor[h % ts.corridor.length];
    switch (t) {
      case T.Wall: {
        if (isWalkable(below) || below === T.Pit || below === T.Lava || below === T.Pillar) {
          g.drawImage(ts.wallFace[h % ts.wallFace.length], px, py);
          // cap highlight
          g.fillStyle = pal.wallTop[1];
          g.fillRect(px, py, 16, 1);
        } else {
          let near = false;
          for (let dy = -1; dy <= 1 && !near; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx;
              const ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= map.w || ny >= map.h) continue;
              if (map.tiles[ny * map.w + nx] !== T.Wall) {
                near = true;
                break;
              }
            }
          if (near) {
            g.drawImage(ts.wallTop, px, py);
            // rim on edges facing open space
            g.fillStyle = pal.wallTop[1];
            const open = (nx: number, ny: number) => nx >= 0 && ny >= 0 && nx < map.w && ny < map.h && map.tiles[ny * map.w + nx] !== T.Wall;
            if (open(x - 1, y)) g.fillRect(px, py, 1, 16);
            if (open(x + 1, y)) g.fillRect(px + 15, py, 1, 16);
            if (open(x, y - 1)) g.fillRect(px, py, 16, 1);
          }
        }
        break;
      }
      case T.Pillar:
        g.drawImage(floorTex, px, py);
        g.drawImage(ts.pillar, px, py);
        break;
      case T.Pit: {
        const above = y > 0 ? map.tiles[i - map.w] : T.Wall;
        if (above !== T.Pit) g.drawImage(ts.pitLip, px, py);
        else {
          g.fillStyle = '#05040a';
          g.fillRect(px, py, 16, 16);
        }
        break;
      }
      case T.Spikes:
        g.drawImage(floorTex, px, py);
        g.drawImage(ts.spikes, px, py);
        break;
      case T.Grass:
        g.drawImage(floorTex, px, py);
        g.drawImage(ts.grass[h % ts.grass.length], px, py);
        break;
      case T.Turnstile:
        g.drawImage(floorTex, px, py);
        break;
      case T.Stairs:
        g.drawImage(ts.stairs, px, py);
        break;
      case T.Lava:
      case T.Water:
        g.fillStyle = t === T.Lava ? '#b8312a' : '#2c5f8f';
        g.fillRect(px, py, 16, 16);
        break;
      default:
        g.drawImage(floorTex, px, py);
    }
  }

  drawAnimatedTiles(st: GameState, model: RenderModel, toPx: (x: number) => number, toPy: (y: number) => number): void {
    const g = this.g;
    const ts = this.ts;
    const set = this.tileset!;
    const map = st.map;
    const [x0, y0, x1, y1] = this.viewRange(map);
    const frame = Math.floor(this.clock / 420);
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const i = y * map.w + x;
        if (!st.explored[i]) continue;
        const t = map.tiles[i];
        if (t === T.Lava) g.drawImage(set.lava[(frame + x + y) % set.lava.length], toPx(x), toPy(y), ts, ts);
        else if (t === T.Water) g.drawImage(set.water[(frame + x) % set.water.length], toPx(x), toPy(y), ts, ts);
        else if (t === T.Turnstile) {
          g.save();
          g.translate(toPx(x) + ts / 2, toPy(y) + ts / 2);
          g.rotate((this.clock / 1400) * Math.PI);
          g.drawImage(set.turnstile, -ts / 2, -ts / 2, ts, ts);
          g.restore();
        } else if (t === T.Stairs && model.visible.has(i)) {
          const a = 0.18 + 0.12 * Math.sin(this.clock / 300);
          g.fillStyle = `rgba(255, 211, 92, ${a})`;
          g.fillRect(toPx(x), toPy(y), ts, ts);
        }
      }
  }

  viewRange(map: FloorMap): [number, number, number, number] {
    const ts = this.ts;
    const [vcx, vcy] = this.viewCenter();
    const halfW = Math.ceil(Math.max(vcx, this.W - vcx) / ts) + 2;
    const halfH = Math.ceil(Math.max(vcy, this.H - vcy) / ts) + 2;
    const cx = Math.round(this.camX);
    const cy = Math.round(this.camY);
    return [Math.max(0, cx - halfW), Math.max(0, cy - halfH), Math.min(map.w - 1, cx + halfW), Math.min(map.h - 1, cy + halfH)];
  }

  drawThreat(st: GameState, model: RenderModel, toPx: (x: number) => number, toPy: (y: number) => number): void {
    const g = this.g;
    const ts = this.ts;
    const w = st.map.w;
    const pulse = 0.5 + 0.5 * Math.sin(this.clock / 260);
    for (const [i, cell] of model.threat) {
      if (!model.visible.has(i)) continue;
      const x = i % w;
      const y = Math.floor(i / w);
      const px = toPx(x);
      const py = toPy(y);
      if (cell.now > 0) {
        g.fillStyle = `rgba(239, 74, 90, ${0.2 + 0.08 * pulse})`;
        g.fillRect(px, py, ts, ts);
        g.strokeStyle = `rgba(255, 120, 130, ${0.55 + 0.3 * pulse})`;
        g.lineWidth = Math.max(2, ts / 24);
        const m = ts * 0.1;
        g.strokeRect(px + m, py + m, ts - m * 2, ts - m * 2);
        // damage pips: one per heart this tile would cost you
        const n = Math.min(4, cell.now);
        const pip = Math.max(3, ts * 0.09);
        for (let k = 0; k < n; k++) {
          const qx = px + ts * 0.16 + k * (pip + 2);
          const qy = py + ts * 0.16;
          g.fillStyle = 'rgba(20, 8, 14, 0.85)';
          g.fillRect(qx - 1, qy - 1, pip + 2, pip + 2);
          g.fillStyle = '#ff6b7a';
          g.fillRect(qx, qy, pip, pip);
        }
      } else if (cell.later > 0) {
        g.fillStyle = `rgba(247, 151, 60, ${0.14 + 0.06 * pulse})`;
        g.fillRect(px, py, ts, ts);
        g.strokeStyle = 'rgba(247, 151, 60, 0.6)';
        g.lineWidth = Math.max(1, ts / 32);
        g.setLineDash([ts / 8, ts / 10]);
        g.strokeRect(px + ts * 0.12, py + ts * 0.12, ts * 0.76, ts * 0.76);
        g.setLineDash([]);
        this.pipText(String(cell.later), px + ts / 2, py + ts / 2, ts * 0.32, 'rgba(255, 220, 180, 0.95)');
      }
    }
    if (model.inspectZone) {
      g.strokeStyle = `rgba(255,255,255,${0.5 + 0.4 * pulse})`;
      g.lineWidth = Math.max(2, ts / 20);
      for (const i of model.inspectZone) {
        const x = i % w;
        const y = Math.floor(i / w);
        g.strokeRect(toPx(x) + 3, toPy(y) + 3, ts - 6, ts - 6);
      }
    }
  }

  pipText(text: string, x: number, y: number, size: number, color: string): void {
    const g = this.g;
    g.font = `900 ${Math.round(size)}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = Math.max(2, size / 5);
    g.strokeStyle = 'rgba(10,8,20,0.9)';
    g.strokeText(text, x, y);
    g.fillStyle = color;
    g.fillText(text, x, y);
  }

  drawWorldObjects(st: GameState, model: RenderModel, toPx: (x: number) => number, toPy: (y: number) => number): void {
    const g = this.g;
    const ts = this.ts;
    const w = st.map.w;
    const bob = Math.sin(this.clock / 300);
    // fires
    for (const f of st.fires) {
      if (!model.visible.has(f.y * w + f.x)) continue;
      const s = sprite('fx_fire');
      const fl = Math.sin(this.clock / 90 + f.x) * ts * 0.04;
      g.drawImage(s, toPx(f.x), toPy(f.y) - fl, ts, ts);
    }
    // pickups
    for (const p of st.pickups) {
      const i = p.y * w + p.x;
      if (!st.explored[i]) continue;
      const name = p.kind === 'coin' ? 'pickup_coin' : p.kind === 'heart' ? 'pickup_heart' : 'pickup_key';
      const yb = bob * ts * 0.05;
      this.shadow(toPx(p.x) + ts / 2, toPy(p.y) + ts * 0.82, ts * 0.22);
      g.drawImage(sprite(name), toPx(p.x) + ts * 0.15, toPy(p.y) + ts * 0.1 + yb, ts * 0.7, ts * 0.7);
    }
    // props
    for (const pr of st.props) {
      const i = pr.y * w + pr.x;
      if (!st.explored[i]) continue;
      const px = toPx(pr.x);
      const py = toPy(pr.y);
      const spr = `prop_${pr.kind}${pr.kind === 'chest' && pr.used ? '_open' : ''}${pr.kind === 'fountain' && pr.used ? '_dry' : ''}`;
      if (hasSprite(spr)) g.drawImage(sprite(spr), px, py, ts, ts);
      if (pr.kind === 'pedestal' && pr.item) {
        const fy = Math.sin(this.clock / 380 + pr.x) * ts * 0.06;
        // glow
        const grd = g.createRadialGradient(px + ts / 2, py + ts * 0.3, 0, px + ts / 2, py + ts * 0.3, ts * 0.55);
        grd.addColorStop(0, 'rgba(255, 233, 168, 0.35)');
        grd.addColorStop(1, 'rgba(255, 233, 168, 0)');
        g.fillStyle = grd;
        g.fillRect(px - ts * 0.1, py - ts * 0.3, ts * 1.2, ts * 1.2);
        g.drawImage(sprite(model.itemSprite(pr.item.id)), px + ts * 0.18, py - ts * 0.28 + fy, ts * 0.64, ts * 0.64);
        if (pr.item.star > 0) this.pipText('★', px + ts * 0.82, py - ts * 0.2 + fy, ts * 0.26, '#ffd35c');
        if (pr.lockRoom >= 0) {
          // cage bars: opens when the room is cleared
          g.fillStyle = 'rgba(20, 15, 31, 0.35)';
          g.fillRect(px + ts * 0.1, py - ts * 0.34, ts * 0.8, ts * 0.86);
          for (let k = 0; k < 4; k++) {
            const bx = px + ts * (0.16 + k * 0.22);
            g.fillStyle = '#140f1f';
            g.fillRect(bx - 1, py - ts * 0.36, ts * 0.08 + 2, ts * 0.9);
            g.fillStyle = '#b7bcc7';
            g.fillRect(bx, py - ts * 0.35, ts * 0.06, ts * 0.88);
          }
          g.fillStyle = '#727a8a';
          g.fillRect(px + ts * 0.1, py - ts * 0.38, ts * 0.8, ts * 0.06);
          g.fillRect(px + ts * 0.1, py + ts * 0.46, ts * 0.8, ts * 0.06);
        }
        if (pr.price > 0) {
          this.pipText(`${pr.price}`, px + ts / 2, py + ts * 0.98, ts * 0.26, '#ffd35c');
        }
      }
      if (pr.kind === 'anvil' && !pr.used && pr.price > 0) this.pipText(`${pr.price}`, px + ts / 2, py + ts * 0.98, ts * 0.26, '#ffd35c');
    }
    // bombs
    for (const b of st.bombs) {
      const i = b.y * w + b.x;
      if (!model.visible.has(i)) continue;
      const px = toPx(b.x);
      const py = toPy(b.y);
      const sc = 1 + (b.timer <= 1 ? 0.08 * Math.sin(this.clock / 50) : 0.03 * Math.sin(this.clock / 120));
      const s = ts * 0.75 * sc;
      g.drawImage(sprite('fx_bomb'), px + (ts - s) / 2, py + (ts - s) / 2 + ts * 0.05, s, s);
      if (Math.random() < 0.3) this.particles.burst(b.x + 0.62, b.y + 0.18, 1, ['#ffd35c', '#f7973c'], 1.5, 250, 0.06, -1);
    }
  }

  shadow(cx: number, cy: number, r: number): void {
    const g = this.g;
    g.fillStyle = 'rgba(0,0,0,0.32)';
    g.beginPath();
    g.ellipse(cx, cy, r, r * 0.38, 0, 0, Math.PI * 2);
    g.fill();
  }

  drawUnits(st: GameState, model: RenderModel, toPx: (x: number) => number, toPy: (y: number) => number): void {
    const g = this.g;
    const ts = this.ts;
    const w = st.map.w;
    type Item = { y: number; draw: () => void };
    const items: Item[] = [];
    for (const u of st.units) {
      const i = u.y * w + u.x;
      if (!model.visible.has(i)) continue;
      const v = this.ent(u.id);
      items.push({ y: u.y + v.oy, draw: () => this.drawUnit(u, v, model, toPx, toPy) });
    }
    // ghosts (dying)
    this.ghosts = this.ghosts.filter((gh) => this.clock - gh.t0 < 420);
    for (const gh of this.ghosts) {
      items.push({
        y: gh.y,
        draw: () => {
          const k = clamp01((this.clock - gh.t0) / 420);
          const size = ts * (gh.boss ? 1.8 : 1) * (gh.how === 'fall' ? 1 - k : 1 + k * 0.4);
          g.globalAlpha = 1 - k;
          const spr = k < 0.25 ? spriteFlash(gh.sprite) : sprite(gh.sprite);
          g.drawImage(spr, toPx(gh.x) + (ts - size) / 2, toPy(gh.y) + (ts - size) / 2 - (gh.how === 'fall' ? 0 : k * ts * 0.2), size, size);
          g.globalAlpha = 1;
        },
      });
    }
    // player
    if (st.status !== 'dead' || this.clock % 200 < 100) {
      const v = this.ent(PLAYER_ID);
      items.push({ y: st.player.y + v.oy + 0.01, draw: () => this.drawPlayer(st, v, model, toPx, toPy) });
    }
    items.sort((a, b) => a.y - b.y);
    for (const it of items) it.draw();
  }

  lunge(v: VisualEnt): [number, number] {
    const k = (this.clock - v.lungeT) / 150;
    if (k < 0 || k > 1 || v.lungeDir < 0) return [0, 0];
    const a = Math.sin(k * Math.PI) * 0.22;
    return [DX[v.lungeDir] * a, DY[v.lungeDir] * a];
  }

  drawUnit(u: Unit, v: VisualEnt, model: RenderModel, toPx: (x: number) => number, toPy: (y: number) => number): void {
    const g = this.g;
    const ts = this.ts;
    const name = model.unitSprite(u);
    const [lx, ly] = this.lunge(v);
    const arcK = v.dur > 0 ? clamp01((this.clock - v.t0) / v.dur) : 1;
    const hop = v.arc > 0 ? Math.sin(arcK * Math.PI) * v.arc : 0;
    const scale = u.boss ? 1.75 : u.elite ? 1.15 : 1;
    const size = ts * scale;
    const cx = toPx(u.x + v.ox + lx) + ts / 2;
    const cy = toPy(u.y + v.oy + ly) + ts / 2;
    const idle = u.awake && u.stun <= 0 ? Math.sin(this.clock / 220 + u.id) * 0.04 : 0;
    const sq = clamp01((this.clock - v.squashT) / 220);
    const squash = sq < 1 ? Math.sin(sq * Math.PI) * 0.18 : 0;
    const sw = size * (1 + squash + idle * 0.5);
    const sh = size * (1 - squash * 0.8 - idle * 0.5);
    this.shadow(cx, cy + ts * 0.36 + (u.boss ? ts * 0.3 : 0), ts * 0.3 * scale);
    const bx = cx - sw / 2;
    const by = cy + size / 2 - sh - hop * ts - (u.boss ? size * 0.2 : 0);
    let spr = sprite(name);
    if (this.clock < v.flashUntil) spr = spriteFlash(name);
    else if (u.frozen && u.stun > 0) spr = spriteTint(name, '#8fd8f0');
    g.save();
    if (u.facing === 3 && !u.boss) {
      g.translate(bx + sw, by);
      g.scale(-1, 1);
      g.drawImage(spr, 0, 0, sw, sh);
    } else g.drawImage(spr, bx, by, sw, sh);
    g.restore();
    // facing shield marker: shield-bearers show which side is armoured
    const ucx = toPx(u.x + v.ox) + ts / 2;
    const ucy = toPy(u.y + v.oy) + ts / 2;
    if ((u.kind === 'knight' || u.kind === 'boss_lancer') && u.stun <= 0 && !(u.kind === 'knight' && u.mode === 1)) {
      const off = u.boss ? 0.78 : 0.48;
      const s2 = ts * (u.boss ? 0.5 : 0.36);
      g.drawImage(sprite('item_shield'), ucx + DX[u.facing] * ts * off - s2 / 2, ucy + DY[u.facing] * ts * off - s2 / 2, s2, s2);
    }
    if (u.kind === 'boss_warden') this.drawWardenCross(u, ucx, ucy);
    // status
    const top = by - ts * 0.05;
    if (!u.awake) this.pipText('z', cx + ts * 0.3, top + Math.sin(this.clock / 400) * ts * 0.05, ts * 0.28, '#b7bcc7');
    else if (u.stun > 0) {
      for (let k = 0; k < 3; k++) {
        const a = this.clock / 300 + (k * Math.PI * 2) / 3;
        g.fillStyle = u.frozen ? '#d9f3ff' : '#ffd35c';
        g.fillRect(cx + Math.cos(a) * ts * 0.25 - ts * 0.04, top + Math.sin(a) * ts * 0.07, ts * 0.08, ts * 0.08);
      }
    }
    if (u.burn > 0) {
      const s = sprite('fx_fire');
      g.globalAlpha = 0.85;
      g.drawImage(s, cx - ts * 0.25, cy - ts * 0.15 - Math.sin(this.clock / 80) * ts * 0.03, ts * 0.5, ts * 0.5);
      g.globalAlpha = 1;
    }
    // HP pips
    if (u.awake || u.hp < u.maxHp) this.hpPips(cx, by + sh + ts * 0.06 - (u.boss ? 0 : ts * 0.02), u.hp, u.maxHp, u.boss);
  }

  /** The Warden carries a cross like the hero: weapon icons on 3 sides, a glowing core on the 4th. */
  drawWardenCross(u: Unit, cx: number, cy: number): void {
    const g = this.g;
    const ts = this.ts;
    for (let side = 0; side < 4; side++) {
      const item = WARDEN_CROSS[(side - u.mode + 4) % 4];
      const ix = cx + DX[side] * ts * 1.05;
      const iy = cy + DY[side] * ts * 1.05;
      const s = ts * (item === 'core' ? 0.62 : 0.5);
      g.fillStyle = item === 'core' ? `rgba(194, 123, 240, ${0.35 + 0.2 * Math.sin(this.clock / 160)})` : 'rgba(10, 8, 20, 0.6)';
      g.beginPath();
      g.arc(ix, iy, s * 0.6, 0, Math.PI * 2);
      g.fill();
      g.drawImage(sprite(item === 'core' ? 'ui_core' : `item_${item}`), ix - s / 2, iy - s / 2, s, s);
    }
  }

  hpPips(cx: number, y: number, hp: number, max: number, boss: boolean): void {
    const g = this.g;
    const ts = this.ts;
    if (boss || max > 8) {
      const w = ts * (boss ? 1.6 : 0.9);
      const h = Math.max(4, ts * 0.09);
      g.fillStyle = 'rgba(10,8,20,0.85)';
      g.fillRect(cx - w / 2 - 2, y - 2, w + 4, h + 4);
      g.fillStyle = '#4a1d2a';
      g.fillRect(cx - w / 2, y, w, h);
      g.fillStyle = '#ef4a5a';
      g.fillRect(cx - w / 2, y, (w * Math.max(0, hp)) / max, h);
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.fillRect(cx - w / 2, y, (w * Math.max(0, hp)) / max, Math.max(1, h / 3));
      return;
    }
    const pip = Math.max(4, Math.round(ts * 0.11));
    const gap = Math.max(1, Math.round(ts * 0.03));
    const total = max * pip + (max - 1) * gap;
    let x = Math.round(cx - total / 2);
    for (let k = 0; k < max; k++) {
      g.fillStyle = 'rgba(10,8,20,0.9)';
      g.fillRect(x - 1, y - 1, pip + 2, pip + 2);
      g.fillStyle = k < hp ? '#ef4a5a' : '#3a2433';
      g.fillRect(x, y, pip, pip);
      if (k < hp) {
        g.fillStyle = '#ff9aa5';
        g.fillRect(x, y, pip, Math.max(1, pip / 3));
      }
      x += pip + gap;
    }
  }

  drawPlayer(st: GameState, v: VisualEnt, model: RenderModel, toPx: (x: number) => number, toPy: (y: number) => number): void {
    const g = this.g;
    const ts = this.ts;
    const p = st.player;
    const [lx, ly] = this.lunge(v);
    const arcK = v.dur > 0 ? clamp01((this.clock - v.t0) / v.dur) : 1;
    const hop = v.arc > 0 ? Math.sin(arcK * Math.PI) * v.arc : 0;
    const cx = toPx(p.x + v.ox + lx) + ts / 2;
    const cy = toPy(p.y + v.oy + ly) + ts / 2;
    // torch light
    const lg = g.createRadialGradient(cx, cy, ts * 0.2, cx, cy, ts * 3.2);
    lg.addColorStop(0, ZONES[this.zone].light.replace(/[\d.]+\)$/, '0.16)'));
    lg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = lg;
    g.fillRect(cx - ts * 3.2, cy - ts * 3.2, ts * 6.4, ts * 6.4);
    this.shadow(cx, cy + ts * 0.36, ts * 0.3);
    // loadout halo: 4 item icons at the hero's sides
    const breathe = Math.sin(this.clock / 500) * 0.015;
    for (let d = 0; d < 4; d++) {
      const it = p.slots[d];
      const hd = 0.66 + breathe;
      const ix = cx + DX[d] * ts * hd;
      const iy = cy + DY[d] * ts * hd;
      const s = ts * (model.hoverDir === d ? 0.5 : 0.4);
      // socket
      g.fillStyle = model.hoverDir === d ? 'rgba(255, 233, 168, 0.35)' : 'rgba(10, 8, 20, 0.55)';
      g.beginPath();
      g.arc(ix, iy, s * 0.62, 0, Math.PI * 2);
      g.fill();
      if (it) {
        g.globalAlpha = model.slotReady(d as Dir) ? 1 : 0.35;
        g.drawImage(sprite(model.itemSprite(it.id)), ix - s / 2, iy - s / 2, s, s);
        g.globalAlpha = 1;
      } else {
        g.fillStyle = 'rgba(255,255,255,0.25)';
        g.fillRect(ix - s * 0.08, iy - s * 0.08, s * 0.16, s * 0.16);
      }
    }
    // hero sprite
    const sq = clamp01((this.clock - v.squashT) / 220);
    const squash = sq < 1 ? Math.sin(sq * Math.PI) * 0.15 : 0;
    const idle = Math.sin(this.clock / 260) * 0.025;
    const sw = ts * (1 + squash);
    const sh = ts * (1 - squash * 0.8 - idle);
    const spr = this.clock < v.flashUntil ? spriteFlash('hero') : sprite('hero');
    g.drawImage(spr, cx - sw / 2, cy + ts / 2 - sh - hop * ts, sw, sh);
    // guard aura
    if (p.guard >= 0 || p.guardAll) {
      g.strokeStyle = 'rgba(255, 211, 92, 0.85)';
      g.lineWidth = Math.max(2, ts / 16);
      g.beginPath();
      if (p.guardAll) g.arc(cx, cy, ts * 0.55, 0, Math.PI * 2);
      else {
        const a = [-Math.PI / 2, 0, Math.PI / 2, Math.PI][p.guard];
        g.arc(cx, cy, ts * 0.55, a - 0.9, a + 0.9);
      }
      g.stroke();
    }
  }

  drawFog(st: GameState, model: RenderModel, ox: number, oy: number): void {
    const map = st.map;
    const fc = this.fogCanvas;
    if (fc.width !== map.w || fc.height !== map.h) {
      fc.width = map.w;
      fc.height = map.h;
    }
    const fg = fc.getContext('2d')!;
    const img = fg.createImageData(map.w, map.h);
    const voidCol = ZONES[this.zone].void;
    const vr = parseInt(voidCol.slice(1, 3), 16);
    const vg = parseInt(voidCol.slice(3, 5), 16);
    const vb = parseInt(voidCol.slice(5, 7), 16);
    for (let i = 0; i < map.w * map.h; i++) {
      const o = i * 4;
      img.data[o] = vr;
      img.data[o + 1] = vg;
      img.data[o + 2] = vb;
      img.data[o + 3] = model.visible.has(i) ? 0 : st.explored[i] ? 150 : 255;
    }
    fg.putImageData(img, 0, 0);
    const g = this.g;
    g.save();
    g.imageSmoothingEnabled = true;
    g.drawImage(fc, 0, 0, map.w, map.h, ox, oy, map.w * this.ts, map.h * this.ts);
    g.restore();
    g.imageSmoothingEnabled = false;
  }

  drawPreview(st: GameState, model: RenderModel, toPx: (x: number) => number, toPy: (y: number) => number): void {
    if (!model.previews) return;
    const g = this.g;
    const ts = this.ts;
    const w = st.map.w;
    const pulse = 0.5 + 0.5 * Math.sin(this.clock / 180);
    // reticles on enemies each direction would hit / kill
    for (const pv of model.previews) {
      if (!pv.valid) continue;
      const hovered = model.hoverDir === pv.dir;
      for (const id of pv.hitIds) {
        const u = st.units.find((uu) => uu.id === id);
        if (!u || !model.visible.has(u.y * w + u.x)) continue;
        const kill = pv.killIds.includes(id);
        const cx = toPx(u.x) + ts / 2;
        const cy = toPy(u.y) + ts / 2;
        const r = ts * (0.44 + (hovered ? 0.04 * pulse : 0));
        g.strokeStyle = kill ? `rgba(255, 211, 92, ${0.7 + 0.3 * pulse})` : `rgba(255,255,255,${hovered ? 0.85 : 0.45})`;
        g.lineWidth = Math.max(2, ts / 18);
        const seg = ts * 0.16;
        for (const [sx, sy] of [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ]) {
          g.beginPath();
          g.moveTo(cx + sx * r, cy + sy * (r - seg));
          g.lineTo(cx + sx * r, cy + sy * r);
          g.lineTo(cx + sx * (r - seg), cy + sy * r);
          g.stroke();
        }
        // small direction arrow showing which key does it
        const ax = cx - DX[pv.dir] * ts * 0.5;
        const ay = cy - DY[pv.dir] * ts * 0.5;
        if (kill) g.drawImage(sprite('ui_skull'), cx - ts * 0.16, cy - ts * 0.78, ts * 0.32, ts * 0.32);
        void ax;
        void ay;
      }
      if (hovered) {
        for (const i of pv.tiles) {
          if (!model.visible.has(i)) continue;
          const x = i % w;
          const y = Math.floor(i / w);
          g.fillStyle = 'rgba(255, 211, 92, 0.27)';
          g.fillRect(toPx(x) + 2, toPy(y) + 2, ts - 4, ts - 4);
          g.strokeStyle = '#ffd35c';
          g.lineWidth = 1;
          g.strokeRect(toPx(x) + 3, toPy(y) + 3, ts - 6, ts - 6);
          // Corner hatching distinguishes effects from movement without color alone.
          g.beginPath();
          g.moveTo(toPx(x) + 4, toPy(y) + ts * .4);
          g.lineTo(toPx(x) + ts * .4, toPy(y) + 4);
          g.stroke();
        }
        for (const i of pv.delayedTiles) {
          if (!model.visible.has(i)) continue;
          g.strokeStyle = '#f7973c';
          g.lineWidth = 2;
          g.setLineDash([4, 4]);
          g.strokeRect(toPx(i % w) + 5, toPy(Math.floor(i / w)) + 5, ts - 10, ts - 10);
          g.setLineDash([]);
        }
        for (const i of pv.path) {
          if (!model.visible.has(i)) continue;
          const cx = toPx(i % w) + ts / 2, cy = toPy(Math.floor(i / w)) + ts / 2;
          const dx = DX[pv.dir], dy = DY[pv.dir];
          g.strokeStyle = '#6fe2f0';
          g.lineWidth = Math.max(2, ts / 16);
          g.beginPath();
          g.moveTo(cx - dx * ts * .3, cy - dy * ts * .3);
          g.lineTo(cx + dx * ts * .2, cy + dy * ts * .2);
          g.moveTo(cx - dy * ts * .13, cy + dx * ts * .13);
          g.lineTo(cx + dx * ts * .2, cy + dy * ts * .2);
          g.lineTo(cx + dy * ts * .13, cy - dx * ts * .13);
          g.stroke();
        }
        if (pv.actionDest && model.visible.has(pv.actionDest.y * w + pv.actionDest.x)) {
          const x = toPx(pv.actionDest.x), y = toPy(pv.actionDest.y);
          g.strokeStyle = '#6fe2f0';
          g.lineWidth = Math.max(2, ts / 16);
          g.beginPath();
          g.moveTo(x + ts / 2, y + 2);
          g.lineTo(x + ts - 2, y + ts / 2);
          g.lineTo(x + ts / 2, y + ts - 2);
          g.lineTo(x + 2, y + ts / 2);
          g.closePath();
          g.stroke();
        }
        if (pv.dest && pv.actionDest && (pv.dest.x !== pv.actionDest.x || pv.dest.y !== pv.actionDest.y) && model.visible.has(pv.dest.y * w + pv.dest.x)) {
          g.strokeStyle = '#ff5b6e';
          g.lineWidth = Math.max(2, ts / 16);
          g.setLineDash([ts / 8, ts / 12]);
          g.strokeRect(toPx(pv.dest.x) + 4, toPy(pv.dest.y) + 4, ts - 8, ts - 8);
          g.setLineDash([]);
        }
      }
    }
  }

  drawEffects(toPx: (x: number) => number, toPy: (y: number) => number): void {
    const g = this.g;
    const ts = this.ts;
    this.effects = this.effects.filter((e) => this.clock - e.t0 < e.dur);
    for (const e of this.effects) {
      const k = clamp01((this.clock - e.t0) / e.dur);
      const cx = toPx(e.x) + ts / 2;
      const cy = toPy(e.y) + ts / 2;
      switch (e.kind) {
        case 'slash':
        case 'stab':
        case 'cleave': {
          for (const t of e.tiles.length ? e.tiles : [{ x: e.tx, y: e.ty }]) {
            const tx = toPx(t.x) + ts / 2;
            const ty = toPy(t.y) + ts / 2;
            const base = [-Math.PI / 2, 0, Math.PI / 2, Math.PI][e.dir];
            const sweep = e.kind === 'cleave' ? 1.6 : e.kind === 'stab' ? 0.5 : 1.2;
            const a0 = base - sweep + k * sweep * 2 - 0.4;
            g.strokeStyle = e.color === '#ffffff' ? `rgba(255,255,255,${1 - k})` : `rgba(239,74,90,${1 - k})`;
            g.lineWidth = ts * (0.16 * (1 - k) + 0.03);
            g.lineCap = 'round';
            g.beginPath();
            g.arc(tx - DX[e.dir] * ts * 0.35, ty - DY[e.dir] * ts * 0.35, ts * 0.55, a0, a0 + 0.9);
            g.stroke();
            if (e.kind === 'stab') {
              g.fillStyle = `rgba(255,255,255,${1 - k})`;
              g.fillRect(tx - ts * 0.08, ty - ts * 0.08, ts * 0.16, ts * 0.16);
            }
          }
          break;
        }
        case 'thrust': {
          for (const t of e.tiles) {
            const tx = toPx(t.x) + ts / 2;
            const ty = toPy(t.y) + ts / 2;
            const len = ts * 0.5 * (1 - Math.abs(0.5 - k) * 2) + ts * 0.15;
            g.strokeStyle = `rgba(255,255,255,${1 - k})`;
            g.lineWidth = ts * 0.1;
            g.lineCap = 'round';
            g.beginPath();
            g.moveTo(tx - DX[e.dir] * len, ty - DY[e.dir] * len);
            g.lineTo(tx + DX[e.dir] * len, ty + DY[e.dir] * len);
            g.stroke();
          }
          break;
        }
        case 'smash': {
          for (const t of e.tiles) {
            const tx = toPx(t.x) + ts / 2;
            const ty = toPy(t.y) + ts / 2;
            g.strokeStyle = `rgba(255, 233, 168, ${1 - k})`;
            g.lineWidth = ts * 0.12 * (1 - k);
            g.beginPath();
            g.arc(tx, ty, ts * (0.2 + k * 0.6), 0, Math.PI * 2);
            g.stroke();
          }
          break;
        }
        case 'projectile': {
          const x = toPx(e.x + (e.tx - e.x) * k) + ts / 2;
          const y = toPy(e.y + (e.ty - e.y) * k) + ts / 2;
          const col = e.color === 'fire' ? '#f7973c' : e.color === 'frost' ? '#6fe2f0' : e.color === 'hook' ? '#b7bcc7' : e.color === 'enemy' ? '#ef4a5a' : '#ffffff';
          if (e.color === 'hook') {
            g.strokeStyle = '#b7bcc7';
            g.lineWidth = ts * 0.05;
            g.beginPath();
            g.moveTo(toPx(e.x) + ts / 2, toPy(e.y) + ts / 2);
            g.lineTo(x, y);
            g.stroke();
          }
          g.fillStyle = col;
          const r = e.color === 'fire' ? ts * 0.18 : ts * 0.1;
          g.beginPath();
          g.arc(x, y, r, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = 'rgba(255,255,255,0.8)';
          g.beginPath();
          g.arc(x, y, r * 0.45, 0, Math.PI * 2);
          g.fill();
          if (e.color === 'fire') this.particles.burst(e.x + (e.tx - e.x) * k + 0.5 - 0.5, e.y + (e.ty - e.y) * k, 1, ['#ffd35c', '#f7973c'], 1, 250, 0.08, -2);
          break;
        }
        case 'beam':
        case 'lightning': {
          for (const t of e.tiles) {
            const tx = toPx(t.x);
            const ty = toPy(t.y);
            g.fillStyle = e.color === 'fire' ? `rgba(247,151,60,${0.7 * (1 - k)})` : `rgba(255, 245, 160, ${0.75 * (1 - k)})`;
            g.fillRect(tx + ts * 0.15, ty + ts * 0.15, ts * 0.7, ts * 0.7);
            if (e.kind === 'lightning' || e.color === 'thunder') {
              g.strokeStyle = `rgba(255,255,255,${1 - k})`;
              g.lineWidth = Math.max(2, ts / 20);
              g.beginPath();
              g.moveTo(tx + ts * 0.5, ty);
              g.lineTo(tx + ts * (0.3 + Math.random() * 0.4), ty + ts * 0.5);
              g.lineTo(tx + ts * 0.5, ty + ts);
              g.stroke();
            }
          }
          break;
        }
        case 'explosion': {
          for (const t of e.tiles) {
            const tx = toPx(t.x) + ts / 2;
            const ty = toPy(t.y) + ts / 2;
            const r = ts * (0.3 + 0.35 * easeOutCubic(k));
            g.fillStyle = `rgba(255, ${Math.round(220 - 140 * k)}, 80, ${0.85 * (1 - k)})`;
            g.beginPath();
            g.arc(tx, ty, r, 0, Math.PI * 2);
            g.fill();
          }
          break;
        }
        case 'ring': {
          g.strokeStyle = e.color;
          g.globalAlpha = 1 - k;
          g.lineWidth = Math.max(2, ts * 0.08 * (1 - k));
          g.beginPath();
          g.arc(cx, cy, ts * (0.2 + easeOutBack(k) * 0.55), 0, Math.PI * 2);
          g.stroke();
          g.globalAlpha = 1;
          break;
        }
        case 'guard': {
          g.strokeStyle = `rgba(255, 211, 92, ${1 - k})`;
          g.lineWidth = Math.max(3, ts * 0.1);
          g.beginPath();
          if (e.dir >= 0) {
            const a = [-Math.PI / 2, 0, Math.PI / 2, Math.PI][e.dir];
            g.arc(cx, cy, ts * (0.5 + k * 0.15), a - 0.9, a + 0.9);
          } else g.arc(cx, cy, ts * (0.5 + k * 0.15), 0, Math.PI * 2);
          g.stroke();
          break;
        }
        case 'heal': {
          g.strokeStyle = `rgba(166, 224, 90, ${1 - k})`;
          g.lineWidth = Math.max(2, ts * 0.06);
          g.beginPath();
          g.arc(cx, cy, ts * (0.3 + k * 0.5), 0, Math.PI * 2);
          g.stroke();
          break;
        }
        default:
          break;
      }
    }
  }

  drawParticles(toPx: (x: number) => number, toPy: (y: number) => number): void {
    const g = this.g;
    const ts = this.ts;
    for (const p of this.particles.list) {
      const a = Math.min(1, p.life / (p.max * 0.5));
      g.globalAlpha = a;
      g.fillStyle = p.color;
      const s = Math.max(2, p.size * ts);
      g.fillRect(toPx(p.x) + ts / 2 - s / 2, toPy(p.y) + ts / 2 - s / 2, s, s);
    }
    g.globalAlpha = 1;
  }

  drawTexts(toPx: (x: number) => number, toPy: (y: number) => number): void {
    const ts = this.ts;
    this.texts = this.texts.filter((t) => this.clock - t.t0 < t.dur);
    for (const t of this.texts) {
      const k = clamp01((this.clock - t.t0) / t.dur);
      const rise = easeOutCubic(Math.min(1, k * 2)) * 0.45;
      const pop = k < 0.15 ? 1 + (0.15 - k) * 3 : 1;
      this.g.globalAlpha = k > 0.7 ? (1 - k) / 0.3 : 1;
      this.pipText(t.text, toPx(t.x) + ts / 2, toPy(t.y - rise) + ts / 2, ts * (t.big ? 0.5 : 0.36) * pop, t.color);
      this.g.globalAlpha = 1;
    }
  }

  /** Reset per-floor visual state. */
  resetFloor(): void {
    this.vis.clear();
    this.ghosts = [];
    this.effects = [];
    this.texts = [];
    this.queue = [];
    this.particles.list = [];
    this.camInit = false;
    this.mapKey = '';
    this.playerDead = false;
  }
}

export const PAL_REF = PAL;
