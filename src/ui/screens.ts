// Full-screen overlays: title, pause menu, guide, game over, victory.

import { spriteUrl } from '../render/spritecache.ts';
import type { GameState } from '../core/types.ts';
import { ENEMIES, FLOORS, ZONE_NAMES } from '../core/content.ts';

export type Kit = 'knight' | 'lancer' | 'mage';

export interface Meta {
  bestFloor: number;
  clears: number;
  runs: number;
  muted: boolean;
}

export interface ScreenHandlers {
  onNew: (kit: Kit) => void;
  onContinue: () => void;
  onRetryCheckpoint: () => void;
  onTitle: () => void;
  onResume: () => void;
  onToggleMute: () => boolean;
}

const KITS: { kit: Kit; name: string; items: (string | null)[]; unlock: number }[] = [
  { kit: 'knight', name: '剣士', items: ['sword', null, 'flask', null], unlock: 0 },
  { kit: 'lancer', name: '槍兵', items: ['spear', 'shield', 'flask', 'hammer'], unlock: 4 },
  { kit: 'mage', name: '魔術師', items: ['fire', null, 'flask', 'frost'], unlock: 7 },
];

function crossHtml(items: (string | null)[], cls = ''): string {
  const cell = (k: number) => (items[k] ? `<img src="${spriteUrl(`item_${items[k]}`, 3)}" alt="">` : '<i></i>');
  return `<div class="mini-cross ${cls}"><span class="mc0">${cell(0)}</span><span class="mc1">${cell(1)}</span><span class="mc2">${cell(2)}</span><span class="mc3">${cell(3)}</span><span class="mcc"><img src="${spriteUrl('hero', 3)}" alt=""></span></div>`;
}

export class Screens {
  root: HTMLElement;
  ov: HTMLElement;
  h: ScreenHandlers;
  open = false;
  kind = '';

  constructor(root: HTMLElement, h: ScreenHandlers) {
    this.root = root;
    this.h = h;
    this.ov = document.createElement('div');
    this.ov.className = 'overlay hidden';
    root.appendChild(this.ov);
  }

  close(): void {
    this.ov.className = 'overlay hidden';
    this.ov.innerHTML = '';
    this.open = false;
    this.kind = '';
  }

  private show(kind: string, html: string): void {
    this.ov.className = `overlay show ov-${kind}`;
    this.ov.innerHTML = html;
    this.open = true;
    this.kind = kind;
  }

  title(meta: Meta, hasSave: boolean, saveFloor: number): void {
    const kits = KITS.map((k) => {
      const locked = meta.bestFloor < k.unlock && meta.clears === 0;
      return `<button class="kit ${locked ? 'locked' : ''}" data-kit="${k.kit}" ${locked ? 'disabled' : ''}>
        ${crossHtml(k.items)}
        <span class="kit-name">${locked ? `🔒 B${k.unlock}` : k.name}</span>
      </button>`;
    }).join('');
    this.show(
      'title',
      `<div class="title-wrap">
        <div class="logo-cross">${crossHtml(['sword', 'shield', 'flask', 'axe'], 'spin')}</div>
        <h1 class="logo">FOUR<span>WARD</span></h1>
        <p class="tagline">その一歩が、武器になる。</p>
        ${hasSave ? `<button class="btn primary" data-act="continue">つづきから <small>B${saveFloor}</small></button>` : ''}
        <div class="kits">${kits}</div>
        <div class="keys"><span class="kc">↑</span><span class="kc">→</span><span class="kc">↓</span><span class="kc">←</span><span class="sep">/</span><span class="kc">W</span><span class="kc">A</span><span class="kc">S</span><span class="kc">D</span><span class="sep">/</span><span class="tap">👆</span></div>
        <div class="title-foot">
          <button class="icon-btn" data-act="mute">${meta.muted ? '🔇' : '🔊'}</button>
          <button class="icon-btn" data-act="guide">？</button>
          ${meta.clears ? `<span class="clears">★×${meta.clears}</span>` : ''}
          ${meta.bestFloor > 1 ? `<span class="best">B${meta.bestFloor}</span>` : ''}
        </div>
      </div>`,
    );
    this.ov.querySelectorAll<HTMLButtonElement>('.kit').forEach((b) =>
      b.addEventListener('click', () => {
        if (b.disabled) return;
        this.h.onNew(b.dataset.kit as Kit);
      }),
    );
    this.bindCommon(meta, hasSave, saveFloor);
  }

  private bindCommon(meta?: Meta, hasSave?: boolean, saveFloor?: number): void {
    this.ov.querySelectorAll<HTMLButtonElement>('[data-act]').forEach((b) =>
      b.addEventListener('click', () => {
        const a = b.dataset.act;
        if (a === 'continue') this.h.onContinue();
        else if (a === 'retry') this.h.onRetryCheckpoint();
        else if (a === 'title') this.h.onTitle();
        else if (a === 'resume') this.h.onResume();
        else if (a === 'mute') {
          const m = this.h.onToggleMute();
          b.textContent = m ? '🔇' : '🔊';
        } else if (a === 'guide') {
          const back = this.kind;
          this.guide(() => {
            if (back === 'title' && meta) this.title(meta, !!hasSave, saveFloor ?? 1);
            else this.menu(meta?.muted ?? false);
          });
        }
      }),
    );
  }

  menu(muted: boolean): void {
    this.show(
      'menu',
      `<div class="panel">
        <button class="btn primary" data-act="resume">▶</button>
        <div class="row">
          <button class="icon-btn" data-act="mute">${muted ? '🔇' : '🔊'}</button>
          <button class="icon-btn" data-act="guide">？</button>
        </div>
        <button class="btn ghost" data-act="title">タイトルへ</button>
      </div>`,
    );
    this.bindCommon({ bestFloor: 0, clears: 0, runs: 0, muted });
  }

  guide(onBack: () => void): void {
    const ic = (n: string) => `<img src="${spriteUrl(n, 3)}" alt="">`;
    this.show(
      'guide',
      `<div class="panel guide">
        <div class="g-row">
          <div class="g-cross">${crossHtml(['sword', 'shield', 'flask', 'bomb'])}</div>
          <div class="g-eq"><span class="kc">↑</span> = ${ic('item_sword')} <span class="arrow">➜</span> ${ic('hero')}${ic('ui_swing')}</div>
        </div>
        <div class="g-row"><div class="g-tile danger"><i></i></div><div class="g-txt">ここで手番を終えると攻撃される（●＝ダメージ）</div></div>
        <div class="g-row"><div class="g-tile later">2</div><div class="g-txt">数字のターン後に爆発</div></div>
        <div class="g-row">${ic('ui_skull')}<div class="g-txt">その向きで倒せる</div>${ic('ui_danger')}<div class="g-txt">ダメージを受ける</div></div>
        <div class="g-row">${ic('ui_wait')}<div class="g-txt">進めない向き＝その場で構える（1ターン待つ）</div></div>
        <div class="g-row">${ic('prop_pedestal')}<span class="arrow">◀</span>${ic('hero')}<div class="g-txt">押した向きの装備と交換</div></div>
          <div class="g-row">${ic('ui_coin')}<div class="g-txt">GOLDは金床で使う。B2・B5・B8の強化費用は4・6・8 GOLD</div></div>
          <div class="g-row">${ic('prop_anvil')}<div class="g-txt">金床へ押した向きの装備を★強化（各金床1回）。★は装備ごとの特殊効果。同じ装備を台座で重ねても強化できる</div></div>
          <div class="g-row"><div class="g-txt">◎ 先読み → 方向を選ぶ → この方向へ。水色の◇は移動先、金色の▧は攻撃・効果、橙の点線は予約爆発。被ダメージは反撃まで含む</div></div>
          <div class="g-row"><div class="g-txt">PC：Pで先読み、Shift＋方向で直接確認、Enterで実行、Escで閉じる。剣は移動→攻撃、斧は攻撃→移動。槍・杖は対象がいればその場で発動</div></div>
          <div class="g-row"><div class="g-txt">装備の数字は再使用までのターン。薬瓶はHPが2以上減るか残り1で回復し、次の階で補充。中央の自分を押すと装備説明</div></div>
        <div class="g-row">${ic('ui_stairs')}<div class="g-txt">階段で次の階へ（装備の並べ替えもここで）。B9の番人を倒せばクリア</div></div>
        <button class="btn primary" data-act="back">OK</button>
      </div>`,
    );
    this.ov.querySelector('[data-act="back"]')!.addEventListener('click', onBack);
  }

  // ---------------------------------------------------------------- between floors

  arrangeSel = -1;
  arrangeState: GameState | null = null;
  arrangeDone: (() => void) | null = null;

  /** Free rearrangement on the stairs + a teaser of what waits below. */
  arrange(s: GameState, onDone: () => void): void {
    this.arrangeState = s;
    this.arrangeDone = onDone;
    this.arrangeSel = -1;
    const zone = Math.floor((s.floor - 1) / 3);
    const pool = FLOORS[s.floor - 1]?.pool ?? [];
    const boss = FLOORS[s.floor - 1]?.boss;
    const foes = boss ? [boss] : [...pool].sort((a, b) => b[1] - a[1]).slice(0, 4).map((p) => p[0]);
    const foeHtml = foes.map((k) => `<img src="${spriteUrl(k, 3)}" alt="">`).join('');
    this.show(
      'arrange',
      `<div class="panel arrange">
        <div class="ar-head"><b>B${s.floor}</b><span class="z${zone}">${ZONE_NAMES[zone]}</span></div>
        <div class="ar-foes ${boss ? 'boss' : ''}">${foeHtml}</div>
        <div class="ar-cross"></div>
        <div class="ar-hint"><span class="kc">▲</span><span class="arrow">⇄</span><span class="kc">▶</span></div>
        <button class="btn primary" data-act="go">▼ 降りる</button>
      </div>`,
    );
    this.renderArrange();
    this.ov.querySelector('[data-act="go"]')!.addEventListener('click', () => this.finishArrange());
  }

  renderArrange(): void {
    const s = this.arrangeState;
    if (!s) return;
    const box = this.ov.querySelector('.ar-cross') as HTMLElement;
    if (!box) return;
    box.innerHTML = '';
    for (let d = 0; d < 4; d++) {
      const it = s.player.slots[d];
      const b = document.createElement('button');
      b.className = `ar-slot ar${d} ${this.arrangeSel === d ? 'sel' : ''} ${it ? '' : 'empty'}`;
      b.innerHTML = it ? `<img src="${spriteUrl(`item_${it.id}`, 4)}" alt="">${it.star ? '<i>★</i>' : ''}` : '';
      b.addEventListener('click', () => this.arrangeKey(d as 0 | 1 | 2 | 3));
      box.appendChild(b);
    }
    const c = document.createElement('div');
    c.className = 'ar-hero';
    c.innerHTML = `<img src="${spriteUrl('hero', 4)}" alt="">`;
    box.appendChild(c);
  }

  /** Pick a slot, then another: they swap. */
  arrangeKey(d: 0 | 1 | 2 | 3): void {
    const s = this.arrangeState;
    if (!s) return;
    if (this.arrangeSel < 0) this.arrangeSel = d;
    else if (this.arrangeSel === d) this.arrangeSel = -1;
    else {
      const sl = s.player.slots;
      const a = this.arrangeSel;
      [sl[a], sl[d]] = [sl[d], sl[a]];
      this.arrangeSel = -1;
    }
    this.renderArrange();
  }

  finishArrange(): void {
    const done = this.arrangeDone;
    this.arrangeState = null;
    this.arrangeDone = null;
    this.close();
    done?.();
  }

  gameOver(s: GameState, canRetry: boolean): void {
    const killer = Object.values(ENEMIES).find((e) => e.name === s.killedBy);
    const killerIcon = killer ? `<img class="killer" src="${spriteUrl(killer.kind, 4)}" alt="">` : '';
    this.show(
      'over',
      `<div class="panel">
        <h2 class="over-title">力尽きた…</h2>
        <div class="stats">
          <div><b>B${s.floor}</b></div>
          <div>${killerIcon}</div>
          <div>${crossHtml(s.player.slots.map((it) => (it ? it.id : null)))}</div>
        </div>
        <div class="stats2"><span>☠ ${s.stats.kills}</span><span>⏱ ${s.stats.turns}</span></div>
        ${canRetry ? `<button class="btn primary" data-act="retry">B${s.checkpointFloor} から再挑戦</button>` : ''}
        <button class="btn ${canRetry ? 'ghost' : 'primary'}" data-act="title">タイトルへ</button>
      </div>`,
    );
    this.bindCommon();
  }

  victory(s: GameState): void {
    this.show(
      'win',
      `<div class="panel">
        <h2 class="win-title">踏破！</h2>
        <p class="win-sub">四方の番人は倒れた。</p>
        <div class="stats">
          <div>${crossHtml(s.player.slots.map((it) => (it ? it.id : null)))}</div>
        </div>
        <div class="stats2"><span>☠ ${s.stats.kills}</span><span>⏱ ${s.stats.turns}</span><span>↺ ${s.stats.retries}</span></div>
        <button class="btn primary" data-act="title">タイトルへ</button>
      </div>`,
    );
    this.bindCommon();
  }
}
