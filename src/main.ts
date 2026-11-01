// Bootstraps FOURWARD: wires engine <-> renderer <-> HUD <-> input, handles saves.

import { act, newRun, previewAll, threatMap, armedSlots, visibleSet, inCombat, zoneOfFloor, revealAround, SAVE_VERSION, type Preview } from './core/engine.ts';
import { buildFloor, newItem } from './core/floor.ts';
import type { ItemId } from './core/types.ts';
import type { Dir } from './core/geom.ts';
import type { GameState, Unit } from './core/types.ts';
import { randomSeed } from './core/rng.ts';
import { Renderer, type RenderModel, type ThreatCell } from './render/renderer.ts';
import { initAudio, sfx, setMuted } from './audio/sfx.ts';
import { Hud } from './ui/hud.ts';
import { Screens, type Kit, type Meta } from './ui/screens.ts';
import { installInput } from './ui/input.ts';
import { music } from './audio/music.ts';
import { zoneOf } from './core/ai.ts';
import { unitAt, propAt } from './core/world.ts';
import { nextLesson } from './ui/guidance.ts';
import { LAST_FLOOR, ITEMS } from './core/content.ts';

declare const __DEV__: boolean;

const SAVE_KEY = 'fourward.save.v' + SAVE_VERSION;
const CP_KEY = 'fourward.checkpoint.v' + SAVE_VERSION;
const META_KEY = 'fourward.meta';

const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string): void {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode etc. */
    }
  },
  del(k: string): void {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
};

function loadMeta(): Meta {
  try {
    const m = JSON.parse(store.get(META_KEY) || '{}');
    return { bestFloor: m.bestFloor || 1, clears: m.clears || 0, runs: m.runs || 0, muted: !!m.muted };
  } catch {
    return { bestFloor: 1, clears: 0, runs: 0, muted: false };
  }
}

class Game {
  canvas = document.getElementById('game') as HTMLCanvasElement;
  ui = document.getElementById('ui') as HTMLElement;
  renderer = new Renderer(this.canvas);
  hud: Hud;
  screens: Screens;
  state: GameState | null = null;
  previews: Preview[] | null = null;
  threat: Map<number, ThreatCell> = new Map();
  visible: Set<number> = new Set();
  armed: boolean[] = [true, true, true, true];
  hoverDir: Dir | -1 = -1;
  inspectId = -1;
  inspectZone: Set<number> | null = null;
  meta = loadMeta();
  endShown = false;
  lastActAt = 0;
  hpShown: number | null = null;
  undoState: string | null = null;
  previewMode = false;
  previewDir: Dir | -1 = -1;
  /** this tab's own checkpoint: storage is shared with other tabs playing other runs */
  checkpoint: string | null = null;
  lastViewport = '';
  lastViewportCheck = 0;
  seenLessons = new Set<string>((store.get('fourward.hints.v1') ?? '').split(',').filter(Boolean));

  constructor() {
    this.hud = new Hud(this.ui, {
      onDir: (d, rep) => this.onDir(d, rep),
      canRepeat: () => this.canRepeat(),
      onHover: (d) => this.setHover(d),
      onMenu: () => this.openMenu(),
      onHub: () => this.toggleLoadoutCards(),
      onRewind: () => this.rewind(),
      onPreview: () => this.setPreviewMode(!this.previewMode),
      onConfirm: () => this.confirmPreview(),
      onDismissLesson: () => { this.dismissLesson(); this.updateLesson(); },
    });
    this.screens = new Screens(this.ui, {
      onNew: (kit) => this.startNew(kit),
      onContinue: () => this.continueRun(),
      onReset: () => {
        store.del(SAVE_KEY);
        store.del(CP_KEY);
        this.checkpoint = null;
        this.toTitle();
      },
      onRetryCheckpoint: () => this.retryCheckpoint(),
      onTitle: () => this.toTitle(),
      onResume: () => this.screens.close(),
      onToggleMute: () => {
        this.meta.muted = !this.meta.muted;
        setMuted(this.meta.muted);
        this.saveMeta();
        return this.meta.muted;
      },
    });
    setMuted(this.meta.muted);
    installInput(this.canvas, {
      onDir: (d, rep) => this.onDir(d, rep),
      onTapTile: (x, y) => this.onTap(x, y),
      onKey: (k) => this.onKey(k),
      canRepeat: () => this.canRepeat(),
      onPreview: (d) => { this.setPreviewMode(true); this.selectPreview(d); },
    });
    const unlockAudio = () => {
      initAudio();
      music.start();
    };
    window.addEventListener('pointerdown', unlockAudio, { capture: true });
    window.addEventListener('keydown', unlockAudio, { capture: true });
    window.addEventListener('resize', () => this.layout());
    window.addEventListener('orientationchange', () => setTimeout(() => this.layout(), 200));
    // iOS Safari (esp. 26's floating toolbar) can leave fixed content under the browser
    // chrome or scrolled off the top: follow the visible area instead.
    window.visualViewport?.addEventListener('resize', () => this.layout());
    window.visualViewport?.addEventListener('scroll', () => this.layout());
    window.addEventListener('scroll', () => this.unscroll());
    window.addEventListener('pageshow', () => this.layout());
    document.addEventListener('visibilitychange', () => this.layout());
    this.renderer.onDamageShown = (ev) => {
      if (ev.id === 0 && this.state) {
        this.hpShown = null;
        this.hud.update(this.state, this.previews, this.armed);
      }
    };
    this.layout();
    this.toTitle();
    requestAnimationFrame((t) => this.frame(t));
    if (__DEV__) (window as any).__game = this;
    (window as any).__FOURWARD__ = this.testApi();
  }

  /** The page itself never scrolls; undo any scroll the browser does on its own. */
  unscroll(): void {
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
    if (document.body.scrollTop || document.body.scrollLeft) document.body.scrollTop = document.body.scrollLeft = 0;
  }

  /** Visible-area geometry, as a string so the frame loop can spot changes cheaply. */
  viewportSig(): string {
    const vv = window.visualViewport;
    const de = document.documentElement;
    return vv ? `${vv.width},${vv.height},${vv.offsetTop},${vv.offsetLeft},${vv.scale}` : `${de.clientWidth},${de.clientHeight}`;
  }

  /** Pin #app to the area the player can actually see (visualViewport), not the layout viewport. */
  fitViewport(): void {
    const app = document.getElementById('app') as HTMLElement;
    const vv = window.visualViewport;
    this.unscroll();
    this.lastViewport = this.viewportSig();
    // When the player pinch-zooms, keep the normal layout rather than chasing the zoom.
    const use = vv && Math.abs(vv.scale - 1) < 0.01;
    const w = use ? vv.width : document.documentElement.clientWidth;
    const h = use ? vv.height : document.documentElement.clientHeight;
    app.style.top = `${use ? vv.offsetTop : 0}px`;
    app.style.left = `${use ? vv.offsetLeft : 0}px`;
    app.style.width = `${w}px`;
    app.style.height = `${h}px`;
    document.documentElement.style.setProperty('--vh', `${h / 100}px`);
    document.documentElement.style.setProperty('--vw', `${w / 100}px`);
  }

  layout(): void {
    this.fitViewport();
    this.renderer.setInsets(this.hud.topInset(), this.hud.padInset(), 0, this.hud.rightInset());
    this.ui.style.setProperty('--hud-bottom', `${this.hud.topInset()}px`);
  }

  saveMeta(): void {
    store.set(META_KEY, JSON.stringify(this.meta));
  }

  // ---------------------------------------------------------------- flow

  toTitle(): void {
    const raw = store.get(SAVE_KEY);
    let saveFloor = 1;
    let hasSave = false;
    if (raw) {
      try {
        const s = JSON.parse(raw) as GameState;
        if (s.status === 'play') {
          hasSave = true;
          saveFloor = s.floor;
        }
      } catch {
        /* corrupted save */
      }
    }
    this.state = null;
    this.hud.setVisible(false);
    this.screens.title(this.meta, hasSave, saveFloor);
  }

  startNew(kit: Kit): void {
    initAudio();
    sfx('equip');
    const s = newRun(randomSeed(), kit);
    s.stats.startTime = Date.now();
    this.meta.runs++;
    this.saveMeta();
    this.setCheckpoint(s);
    this.begin(s);
  }

  continueRun(): void {
    const raw = store.get(SAVE_KEY);
    if (!raw) return this.toTitle();
    try {
      const s = JSON.parse(raw) as GameState;
      this.begin(s);
    } catch {
      store.del(SAVE_KEY);
      this.toTitle();
    }
  }

  setCheckpoint(s: GameState): void {
    this.checkpoint = JSON.stringify(s);
    store.set(CP_KEY, this.checkpoint);
  }

  /** The checkpoint of `run` — never another run's (another tab may have saved its own). */
  findCheckpoint(run: GameState | null): GameState | null {
    if (!run) return null;
    for (const raw of [this.checkpoint, store.get(CP_KEY)]) {
      if (!raw) continue;
      try {
        const cp = JSON.parse(raw) as GameState;
        if (cp.seed === run.seed && cp.floor === run.checkpointFloor) return cp;
      } catch {
        /* corrupted */
      }
    }
    return null;
  }

  retryCheckpoint(): void {
    const s = this.findCheckpoint(this.state);
    if (!s) return this.toTitle();
    s.player.hp = s.player.maxHp;
    for (const it of s.player.slots) if (it && it.id === 'flask') it.charges = ITEMS.flask.charges + it.star;
    const prev = this.state;
    s.stats.retries = (prev?.stats.retries ?? s.stats.retries) + 1;
    s.stats.kills = prev?.stats.kills ?? s.stats.kills;
    s.stats.turns = prev?.stats.turns ?? s.stats.turns;
    this.setCheckpoint(s);
    this.begin(s);
  }

  begin(s: GameState): void {
    this.setPreviewMode(false);
    this.state = s;
    this.hpShown = null;
    this.undoState = null;
    if (s.rewinds === undefined) s.rewinds = 1;
    this.endShown = false;
    this.screens.close();
    this.renderer.resetFloor();
    this.hud.setVisible(true);
    this.layout();
    this.refresh();
    this.save();
    this.hud.showBanner(s.floor, s.bossId > 0);
    sfx('stairs');
    // first steps of a fresh run: the cross pad breathes until the first press
    this.hud.pad.classList.toggle('hint', s.floor === 1 && s.turn === 0);
  }

  save(): void {
    if (!this.state) return;
    if (this.state.status === 'play') store.set(SAVE_KEY, JSON.stringify(this.state));
    else store.del(SAVE_KEY);
  }

  openMenu(): void {
    if (!this.state || this.screens.open) return;
    this.setPreviewMode(false);
    this.hud.hideCard();
    this.screens.menu(this.meta.muted);
  }

  // ---------------------------------------------------------------- input

  canRepeat(): boolean {
    return !this.previewMode && !!this.state && this.state.status === 'play' && !inCombat(this.state) && !this.screens.open;
  }

  onKey(code: string): void {
    if (this.previewMode && !this.screens.open && (code === 'Enter' || code === 'Space')) { this.confirmPreview(); return; }
    if (code === 'KeyP' && !this.screens.open) { this.setPreviewMode(!this.previewMode); return; }
    if (code === 'Escape') {
      if (this.previewMode) { this.setPreviewMode(false); return; }
      if (this.screens.open && this.screens.kind === 'menu') this.screens.close();
      else if (this.state && !this.screens.open) this.openMenu();
    } else if ((code === 'KeyZ' || code === 'Backspace') && !this.screens.open) {
      this.rewind();
    } else if (code === 'KeyM') {
      this.meta.muted = !this.meta.muted;
      setMuted(this.meta.muted);
      this.saveMeta();
    } else if ((code === 'Enter' || code === 'Space') && this.screens.open) {
      if (this.screens.kind === 'arrange') {
        this.screens.finishArrange();
        return;
      }
      const b = this.screens.ov.querySelector<HTMLButtonElement>('.btn.primary, .kit:not(.locked)');
      b?.click();
    }
  }

  setHover(d: Dir | -1): void {
    if (this.previewMode || this.screens.open) return;
    this.hoverDir = d;
    if (d >= 0 && this.state) this.hud.showItemCard(this.state, d as Dir);
  }

  /** direction of an anvil upgrade waiting for its confirming second press (-1: none) */
  anvilArmed: Dir | -1 = -1;

  onDir(d: Dir, repeat: boolean, confirmed = false): void {
    const s = this.state;
    if (this.screens.open && this.screens.kind === 'arrange') {
      if (!repeat) {
        this.screens.arrangeKey(d);
        sfx('click');
      }
      return;
    }
    if (!s || this.screens.open) return;
    if (s.status !== 'play') return;
    if (this.previewMode) { if (!repeat) this.selectPreview(d); return; }
    // An upgrade spends GOLD for good: the first press only shows what would be upgraded.
    const pr = propAt(s, s.player.x + [0, 1, 0, -1][d], s.player.y + [-1, 0, 1, 0][d]);
    const it = s.player.slots[d];
    const upgrade = pr?.kind === 'anvil' && !pr.used && !!it && !it.star && s.player.coins >= (pr.price ?? 0);
    if (upgrade && !confirmed && this.anvilArmed !== d) {
      if (!repeat) {
        this.anvilArmed = d;
        this.hud.showAnvil(s, pr, d, true);
        sfx('click');
      }
      return;
    }
    this.anvilArmed = -1;
    this.dismissLesson();
    this.hud.hideCard();
    initAudio();
    if (this.renderer.isBusy()) this.renderer.flush();
    this.inspectId = -1;
    this.inspectZone = null;
    const floorBefore = s.floor;
    const hpBefore = s.player.hp;
    const snapshot = JSON.stringify(s);
    const r = act(s, d);
    if (!r.used) {
      this.renderer.playEvents(r.events, s, (u) => this.unitSprite(u), sfx);
      this.hud.shakeButton(d);
      if (!repeat) {
        const pr = propAt(s, s.player.x + [0, 1, 0, -1][d], s.player.y + [-1, 0, 1, 0][d]);
        if (pr?.kind === 'anvil') this.hud.showAnvil(s, pr, d);
        else this.hud.hideCard();
      }
      return;
    }
    this.lastActAt = performance.now();
    this.undoState = snapshot;
    this.hpShown = r.events.some((e) => e.t === 'damage' && e.id === 0) ? hpBefore : null;
    this.hud.flashButton(d);
    this.hud.pad.classList.remove('hint');
    // phones: a short buzz when you get hurt
    if (r.events.some((e) => e.t === 'damage' && e.id === 0)) {
      try {
        navigator.vibrate?.(45);
      } catch {
        /* not supported */
      }
    }
    if (r.descended || s.floor !== floorBefore) {
      this.renderer.resetFloor();
      this.hpShown = null;
      this.undoState = null;
      s.rewinds = 1;
      sfx('stairs');
      if (s.floor > this.meta.bestFloor) {
        this.meta.bestFloor = s.floor;
        this.saveMeta();
      }
      if (zoneOfFloor(s.floor) !== zoneOfFloor(floorBefore)) this.setCheckpoint(s);
      // on the stairs: free rearrangement + a look at what waits below
      this.screens.arrange(s, () => {
        this.refresh();
        this.save();
        this.hud.showBanner(s.floor, s.bossId > 0);
      });
    } else {
      this.renderer.playEvents(r.events, s, (u) => this.unitSprite(u), sfx);
      const eq = r.events.find((e) => e.t === 'equip' || e.t === 'upgrade');
      if (eq && (eq.t === 'equip' || eq.t === 'upgrade')) this.hud.showItemCard(s, eq.dir, 3400);
      if (r.events.some((e) => e.t === 'rotate')) this.hud.root.classList.add('rotating');
      setTimeout(() => this.hud.root.classList.remove('rotating'), 400);
    }
    this.refresh();
    this.save();
    if (s.status !== 'play') this.onEnd();
  }

  onTap(cx: number, cy: number): void {
    const s = this.state;
    if (!s || this.screens.open) return;
    const t = this.renderer.screenToTile(cx, cy);
    this.setPreviewMode(false);
    const vis = this.visible;
    const i = t.y * s.map.w + t.x;
    const u = unitAt(s, t.x, t.y);
    if (u && vis.has(i)) {
      this.inspectId = u.id;
      this.inspectZone = new Set(zoneOf(s, u));
      this.hud.showUnitCard(u);
      return;
    }
    const pr = propAt(s, t.x, t.y);
    if (pr?.kind === 'anvil' && s.explored[i]) {
      this.setPreviewMode(false);
      this.hud.showAnvil(s, pr);
      return;
    }
    if (pr && pr.kind === 'pedestal' && pr.item && s.explored[i]) {
      this.hud.showPedestalCard(pr.item.id);
      return;
    }
    // tapping the hero shows the loadout
    if (t.x === s.player.x && t.y === s.player.y) {
      this.toggleLoadoutCards();
      return;
    }
    this.inspectId = -1;
    this.inspectZone = null;
    this.hud.hideCard();
  }

  /** Undo the last action (once per floor). Not available after death. */
  rewind(): void {
    this.setPreviewMode(false);
    const s = this.state;
    if (!s || this.screens.open || !this.undoState || s.status !== 'play' || (s.rewinds ?? 0) <= 0) {
      sfx('deny');
      return;
    }
    const prev = JSON.parse(this.undoState) as GameState;
    prev.rewinds = (s.rewinds ?? 1) - 1;
    this.undoState = null;
    this.state = prev;
    this.renderer.flush();
    this.renderer.resetFloor();
    this.hpShown = null;
    this.refresh();
    this.save();
    sfx('rotate');
  }

  loadoutIdx = 0;
  toggleLoadoutCards(): void {
    if (!this.state) return;
    this.setPreviewMode(false);
    // cycle through the 4 slots' cards
    for (let k = 0; k < 4; k++) {
      const d = ((this.loadoutIdx + k) % 4) as Dir;
      if (this.state.player.slots[d]) {
        this.hud.showItemCard(this.state, d);
        this.loadoutIdx = (d + 1) % 4;
        return;
      }
    }
  }

  onEnd(): void {
    const s = this.state!;
    if (this.endShown) return;
    this.endShown = true;
    if (s.status === 'won') {
      this.meta.clears++;
      this.meta.bestFloor = Math.max(this.meta.bestFloor, LAST_FLOOR);
      this.saveMeta();
      store.del(SAVE_KEY);
      setTimeout(() => {
        sfx('victory');
        this.hud.setVisible(false);
        this.screens.victory(s);
      }, 900);
    } else {
      store.del(SAVE_KEY);
      setTimeout(() => {
        sfx('death');
        this.hud.setVisible(false);
        this.screens.gameOver(s, !!this.findCheckpoint(s));
      }, 1100);
    }
  }

  // ---------------------------------------------------------------- per-turn derived data

  setPreviewMode(active: boolean): void {
    if (active && (!this.state || this.state.status !== 'play' || this.screens.open)) return;
    this.previewMode = active;
    this.previewDir = -1;
    this.hoverDir = -1;
    this.hud.setPreview(active);
    this.hud.hideCard();
    this.hud.lesson.classList.toggle('preview-hidden', active);
    this.layout();
  }

  selectPreview(d: Dir): void {
    if (!this.state || !this.previews || !this.previewMode) return;
    this.previewDir = d;
    this.hoverDir = d;
    this.hud.setPreview(true, this.state, this.previews[d]);
    this.layout();
  }

  confirmPreview(): void {
    const d = this.previewDir;
    if (!this.previewMode || d < 0 || !this.previews?.[d]?.valid) return;
    this.setPreviewMode(false);
    this.onDir(d as Dir, false, true);
  }

  dismissLesson(): void {
    if (this.hud.lessonId) this.seenLessons.add(this.hud.lessonId);
    store.set('fourward.hints.v1', [...this.seenLessons].join(','));
    this.hud.showLesson(null);
  }

  updateLesson(): void {
    if (this.state?.status === 'play') this.hud.showLesson(nextLesson(this.state, this.visible, this.seenLessons));
  }

  refresh(): void {
    const s = this.state;
    if (!s) return;
    this.visible = visibleSet(s);
    const t = threatMap(s, this.visible);
    const m = new Map<number, ThreatCell>();
    for (const [i, dmg] of t.now) m.set(i, { now: dmg, later: 0 });
    for (const [i, turns] of t.later) if (!m.has(i)) m.set(i, { now: 0, later: turns });
    this.threat = m;
    this.previews = s.status === 'play' ? previewAll(s) : null;
    this.armed = armedSlots(s);
    this.canvas.setAttribute('aria-label', `ダンジョン B${s.floor}・${s.turn}ターン・HP ${s.player.hp}/${s.player.maxHp}`);
    this.hud.update(s, this.previews, this.armed, this.hpShown);
    this.hud.setRewind(s.rewinds ?? 0, !!this.undoState && s.status === 'play');
    this.updateLesson();
    this.layout();
    music.setScene(zoneOfFloor(s.floor), s.bossId > 0);
    music.intensity = s.status === 'play' && inCombat(s) ? 1 : 0;
  }

  unitSprite(u: Unit): string {
    if (u.kind === 'beetle' && u.mode === 1) return 'beetle_lit';
    return u.kind;
  }

  frame(t: number): void {
    // iOS Safari (26) does not always fire visualViewport events when its toolbar
    // changes, which left the HUD above the screen: poll as a backstop.
    if (t - this.lastViewportCheck > 250) {
      this.lastViewportCheck = t;
      if (this.viewportSig() !== this.lastViewport || window.scrollY || document.body.scrollTop) this.layout();
    }
    const s = this.state;
    let model: RenderModel | null = null;
    if (s) {
      model = {
        state: s,
        zone: zoneOfFloor(s.floor),
        visible: this.visible,
        threat: this.threat,
        previews: this.previews,
        hoverDir: this.hoverDir,
        previewFocus: this.previewMode,
        inspectZone: this.inspectZone,
        inspectId: this.inspectId,
        unitSprite: (u) => this.unitSprite(u),
        itemSprite: (id) => `item_${id}`,
        slotReady: (d) => this.armed[d],
      };
    }
    this.renderer.frame(t, model);
    requestAnimationFrame((tt) => this.frame(tt));
  }

  // ---------------------------------------------------------------- automation hooks (E2E tests)

  testApi() {
    return {
      state: () => this.state,
      press: (d: Dir) => this.onDir(d, false),
      newRun: (seed: number, kit: Kit = 'knight') => {
        const s = newRun(seed, kit);
        this.setCheckpoint(s);
        this.begin(s);
      },
      busy: () => this.renderer.isBusy(),
      screen: () => (this.screens.open ? this.screens.kind : 'game'),
      /** test hooks: jump straight to the end screens */
      forceDeath: () => {
        if (!this.state) return;
        this.state.player.hp = 0;
        this.state.status = 'dead';
        this.state.killedBy = 'スライム';
        this.onEnd();
      },
      forceWin: () => {
        if (!this.state) return;
        this.state.status = 'won';
        this.onEnd();
      },
      /** next single step along the shortest walkable path to the stairs (-1 if none) */
      stepToStairs: (): number => {
        const s = this.state;
        if (!s) return -1;
        const w = s.map.w;
        const goal = s.map.stairs;
        const dist = new Int32Array(w * s.map.h).fill(-1);
        const blocked = new Set(s.props.map((q) => q.y * w + q.x));
        dist[goal] = 0;
        const q = [goal];
        for (let qi = 0; qi < q.length; qi++) {
          const i = q[qi];
          const x = i % w;
          const y = Math.floor(i / w);
          for (const [dx, dy] of [
            [0, -1],
            [1, 0],
            [0, 1],
            [-1, 0],
          ]) {
            const ni = (y + dy) * w + x + dx;
            const t = s.map.tiles[ni];
            if (dist[ni] >= 0 || blocked.has(ni) || !(t === 1 || t === 4 || t === 5 || t === 7 || t === 8 || t === 9)) continue;
            dist[ni] = dist[i] + 1;
            q.push(ni);
          }
        }
        let best = -1;
        let bd = 1e9;
        const DXs = [0, 1, 0, -1];
        const DYs = [-1, 0, 1, 0];
        for (let d = 0; d < 4; d++) {
          const ni = (s.player.y + DYs[d]) * w + s.player.x + DXs[d];
          if (dist[ni] >= 0 && dist[ni] < bd) {
            bd = dist[ni];
            best = d;
          }
        }
        // A monster in the way on a slot that cannot hurt it would make us brace forever:
        // strike it from a weapon side if one is aligned, otherwise sidestep.
        const blocker = (d: number) => unitAt(s, s.player.x + DXs[d], s.player.y + DYs[d]);
        const weapon = (d: number) => ['sword', 'axe', 'hammer', 'spear', 'fire', 'frost', 'boots'].includes(s.player.slots[d]?.id ?? '');
        if (best >= 0 && blocker(best) && !weapon(best)) {
          for (let d = 0; d < 4; d++) if (blocker(d) && weapon(d)) return d;
          let alt = -1;
          let ad = 1e9;
          for (let d = 0; d < 4; d++) {
            const ni = (s.player.y + DYs[d]) * w + s.player.x + DXs[d];
            if (d !== best && dist[ni] >= 0 && !blocker(d) && dist[ni] < ad) {
              ad = dist[ni];
              alt = d;
            }
          }
          if (alt >= 0) return alt;
        }
        return best;
      },
      /** jump to a floor with a plausible mid-run loadout (testing / review) */
      startAt: (floor: number, seed = 1) => {
        const s = newRun(seed, 'knight');
        const extra: ItemId[] = ['axe', 'hammer', 'shield', 'spear', 'fire', 'bomb'];
        for (let d = 0; d < 4; d++) if (!s.player.slots[d]) s.player.slots[d] = newItem(extra[(seed + d) % extra.length]);
        s.player.maxHp = 5 + Math.floor((floor - 1) / 3);
        s.player.hp = s.player.maxHp;
        if (floor > 1) {
          buildFloor(s, floor);
          revealAround(s);
        }
        this.setCheckpoint(s);
        this.begin(s);
      },
      /** move the hero to a free tile a few steps from the first monster of `kind` (screenshots / review) */
      peek: (kind: string): boolean => {
        const s = this.state;
        if (!s) return false;
        const u = s.units.find((q) => q.kind === kind);
        if (!u) return false;
        const w = s.map.w;
        for (const [dx, dy] of [
          [0, 3],
          [3, 0],
          [0, -3],
          [-3, 0],
          [2, 2],
          [-2, 2],
          [2, -2],
          [-2, -2],
          [0, 2],
          [2, 0],
        ]) {
          const x = u.x + dx;
          const y = u.y + dy;
          if (x < 0 || y < 0 || x >= w || y >= s.map.h) continue;
          if (s.map.tiles[y * w + x] !== 1 || s.units.some((q) => q.x === x && q.y === y) || s.props.some((q) => q.x === x && q.y === y)) continue;
          s.player.x = x;
          s.player.y = y;
          for (const q of s.units) if (Math.abs(q.x - x) + Math.abs(q.y - y) <= 8) q.awake = true;
          revealAround(s);
          this.renderer.resetFloor();
          this.refresh();
          return true;
        }
        return false;
      },
      /** remove every non-guardian monster (flow tests that only need to walk) */
      clearMonsters: () => {
        if (!this.state) return;
        this.state.units = this.state.units.filter((u) => u.boss);
        this.refresh();
      },
      godMode: () => {
        if (!this.state) return;
        this.state.player.maxHp = 99;
        this.state.player.hp = 99;
      },
    };
  }
}

new Game();
