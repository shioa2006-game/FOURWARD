// DOM HUD: hearts / floor / coins bar, the cross pad (which IS the loadout display),
// info cards, the floor banner. Everything is icon-first; text is kept to numbers
// and a few short names.

import type { Dir } from '../core/geom.ts';
import type { GameState, Unit } from '../core/types.ts';
import { ITEMS, ENEMIES, ZONE_NAMES } from '../core/content.ts';
import type { Preview } from '../core/engine.ts';
import { spriteUrl } from '../render/spritecache.ts';
import { drawDiagram } from './diagram.ts';
import { GOLD_HELP, STAR_HELP, ITEM_RULES, anvilText, previewText, type Lesson } from './guidance.ts';
import type { Prop } from '../core/types.ts';

export interface HudHandlers {
  onDir: (d: Dir, repeat: boolean) => void;
  canRepeat: () => boolean;
  onHover: (d: Dir | -1) => void;
  onMenu: () => void;
  onHub: () => void;
  onRewind: () => void;
  onPreview: () => void;
  onConfirm: () => void;
  onDismissLesson: () => void;
}

const ARROWS = ['▲', '▶', '▼', '◀'];
const THEM_ICON: Record<string, string> = {
  kill: 'ui_skull',
  hit: 'ui_swing',
  heal: 'ui_heart',
  swap: 'ui_swap',
  stairs: 'ui_stairs',
  upgrade: 'ui_upgrade',
  brace: 'ui_wait',
  chest: 'ui_coin',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}

export class Hud {
  root: HTMLElement;
  top: HTMLElement;
  hearts: HTMLElement;
  floorEl: HTMLElement;
  coinsEl: HTMLElement;
  rewindBtn!: HTMLButtonElement;
  pad: HTMLElement;
  buttons: HTMLButtonElement[] = [];
  hub: HTMLButtonElement;
  card: HTMLElement;
  banner: HTMLElement;
  previewBtn: HTMLButtonElement;
  previewPanel: HTMLElement;
  lesson: HTMLElement;
  lessonId = '';
  h: HudHandlers;
  shownHp = -1;
  cardTimer = 0;
  hoverDir: Dir | -1 = -1;
  lastSig = '';

  constructor(root: HTMLElement, h: HudHandlers) {
    this.root = root;
    this.h = h;
    this.top = el('div', 'hud-top', root);
    this.hearts = el('div', 'hearts', this.top);
    const mid = el('div', 'hud-mid', this.top);
    this.floorEl = el('div', 'floorbadge', mid);
    const right = el('div', 'hud-right', this.top);
    this.coinsEl = el('button', 'coins', right);
    this.coinsEl.setAttribute('aria-label', 'GOLDの使い方');
    this.coinsEl.addEventListener('click', () => {
      if (this.previewBtn.getAttribute('aria-pressed') === 'true') this.h.onPreview();
      this.showNote('GOLD と ★強化', `${GOLD_HELP}\n${STAR_HELP}`);
    });
    this.rewindBtn = el('button', 'rewind-btn', right);
    this.rewindBtn.setAttribute('aria-label', 'rewind');
    this.rewindBtn.innerHTML = '<span>↶</span><b></b>';
    this.rewindBtn.addEventListener('click', () => h.onRewind());
    const menu = el('button', 'menu-btn', right);
    menu.setAttribute('aria-label', 'menu');
    menu.innerHTML = '<span></span><span></span><span></span>';
    menu.addEventListener('click', () => h.onMenu());

    this.pad = el('div', 'pad', root);
    for (let d = 0; d < 4; d++) {
      const b = el('button', `pb pb${d}`, this.pad);
      b.dataset.dir = String(d);
      b.setAttribute('aria-label', ['上', '右', '下', '左'][d]);
      b.innerHTML = `<span class="arrow">${ARROWS[d]}</span><img class="icon" alt=""><span class="cd"></span><span class="pips"></span><span class="star">★</span><span class="badge you"><img alt=""><b></b></span><img class="badge them" alt="">`;
      this.bindButton(b, d as Dir);
      this.buttons.push(b);
    }
    this.hub = el('button', 'hub', this.pad);
    this.hub.innerHTML = `<img class="hero" alt="">`;
    this.hub.addEventListener('click', () => h.onHub());
    this.hub.setAttribute('aria-label', '装備の説明');
    this.previewBtn = el('button', 'preview-toggle', this.pad);
    this.previewBtn.textContent = '◎ 先読み';
    this.previewBtn.setAttribute('aria-pressed', 'false');
    this.previewBtn.addEventListener('click', () => h.onPreview());

    this.card = el('div', 'card hidden', root);
    this.banner = el('div', 'banner hidden', root);
    this.previewPanel = el('section', 'preview-panel hidden', root);
    this.previewPanel.setAttribute('aria-label', '行動の先読み');
    this.lesson = el('aside', 'lesson hidden', root);
  }

  bindButton(b: HTMLButtonElement, d: Dir): void {
    let holdTimer = 0;
    let repeatTimer = 0;
    const stop = () => {
      clearTimeout(holdTimer);
      clearInterval(repeatTimer);
      holdTimer = 0;
      repeatTimer = 0;
      b.classList.remove('down');
    };
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      b.setPointerCapture?.(e.pointerId);
      b.classList.add('down');
      this.h.onDir(d, false);
      holdTimer = window.setTimeout(() => {
        repeatTimer = window.setInterval(() => {
          if (this.h.canRepeat()) this.h.onDir(d, true);
          else stop();
        }, 150);
      }, 380);
    });
    b.addEventListener('pointerup', stop);
    b.addEventListener('pointercancel', stop);
    b.addEventListener('lostpointercapture', stop);
    b.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'mouse') {
        this.hoverDir = d;
        this.h.onHover(d);
      }
    });
    b.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse') {
        this.hoverDir = -1;
        this.h.onHover(-1);
        this.hideCard();
      }
    });
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    // Pointer input acts on press; keyboard-generated clicks act once here.
    b.addEventListener('click', (e) => { if (e.detail === 0) this.h.onDir(d, false); });
  }

  /** Height of the pad region (CSS px) so the map can keep the hero above it. */
  padInset(): number {
    const r = this.pad.getBoundingClientRect();
    const box = this.root.getBoundingClientRect();
    const portrait = box.height > box.width;
    const top = !this.previewPanel.classList.contains('hidden') ? Math.min(r.top, this.previewPanel.getBoundingClientRect().top) : r.top;
    return portrait ? Math.max(0, box.bottom - top) : 0;
  }
  topInset(): number {
    return this.top.getBoundingClientRect().bottom - this.root.getBoundingClientRect().top;
  }
  rightInset(): number {
    const box = this.root.getBoundingClientRect();
    if (box.width <= box.height || this.previewPanel.classList.contains('hidden')) return 0;
    return Math.max(0, box.right - this.previewPanel.getBoundingClientRect().left + 12);
  }

  update(s: GameState, previews: Preview[] | null, armed: boolean[], hpShown: number | null = null): void {
    const p = s.player;
    const hp = hpShown ?? p.hp;
    // hearts
    const hpSig = `${hp}/${p.maxHp}`;
    if (this.hearts.dataset.sig !== hpSig) {
      const prev = this.shownHp;
      this.hearts.dataset.sig = hpSig;
      this.hearts.innerHTML = '';
      for (let k = 0; k < p.maxHp; k++) {
        const im = el('img', k < hp ? 'heart' : 'heart empty', this.hearts);
        im.src = spriteUrl(k < hp ? 'ui_heart' : 'ui_heart_empty', 3);
        if (prev >= 0 && k >= hp && k < prev) im.classList.add('lost');
        if (prev >= 0 && k < hp && k >= prev) im.classList.add('gained');
      }
      this.shownHp = hp;
    }
    const zone = Math.floor((s.floor - 1) / 3);
    const fSig = `${s.floor}`;
    if (this.floorEl.dataset.sig !== fSig) {
      this.floorEl.dataset.sig = fSig;
      this.floorEl.innerHTML = `<span class="zdot z${zone}"></span><b>B${s.floor}</b>`;
    }
    const cSig = `${p.coins}`;
    if (this.coinsEl.dataset.sig !== cSig) {
      const bump = this.coinsEl.dataset.sig !== undefined;
      this.coinsEl.dataset.sig = cSig;
      this.coinsEl.innerHTML = `<img src="${spriteUrl('ui_coin', 3)}" alt=""><b>${p.coins}</b><small>GOLD ?</small>`;
      if (bump) {
        this.coinsEl.classList.remove('pop');
        void this.coinsEl.offsetWidth;
        this.coinsEl.classList.add('pop');
      }
    }
    // pad
    for (let d = 0; d < 4; d++) {
      const b = this.buttons[d];
      const it = p.slots[d];
      const icon = b.querySelector('.icon') as HTMLImageElement;
      const cd = b.querySelector('.cd') as HTMLElement;
      const pips = b.querySelector('.pips') as HTMLElement;
      const you = b.querySelector('.badge.you') as HTMLElement;
      const them = b.querySelector('.badge.them') as HTMLImageElement;
      const sig = it ? `${it.id}:${it.star}` : 'empty';
      if (b.dataset.sig !== sig) {
        b.dataset.sig = sig;
        if (it) {
          icon.src = spriteUrl(`item_${it.id}`, 4);
          icon.style.visibility = 'visible';
          b.style.setProperty('--accent', ITEMS[it.id].color);
          b.classList.remove('empty');
        } else {
          icon.style.visibility = 'hidden';
          b.style.setProperty('--accent', '#5a5470');
          b.classList.add('empty');
        }
        b.classList.toggle('starred', !!it && it.star > 0);
        b.classList.remove('swapped');
        void b.offsetWidth;
        b.classList.add('swapped');
      }
      b.classList.toggle('cooling', !!it && it.cd > 0);
      b.classList.toggle('unarmed', !!it && !armed[d]);
      cd.textContent = it && it.cd > 0 ? String(it.cd) : '';
      const charges = it && ITEMS[it.id].charges > 0 ? it.charges : -1;
      pips.innerHTML = charges >= 0 ? Array.from({ length: Math.max(charges, 0) }, () => '<i></i>').join('') + (charges === 0 ? '<i class="none"></i>' : '') : '';
      const pv = previews ? previews[d] : null;
      // top-left: what happens to YOU, top-right: what happens to THEM / the world
      const yk = pv ? pv.you : 'none';
      if (pv && yk !== 'none') {
        (you.querySelector('img') as HTMLImageElement).src = spriteUrl(yk === 'death' ? 'ui_skull' : 'ui_danger', 3);
        (you.querySelector('b') as HTMLElement).textContent = yk === 'death' ? '' : `-${pv.dmgTaken}`;
        you.className = `badge you b-${yk}`;
        you.style.display = 'flex';
      } else you.style.display = 'none';
      const tk = pv ? pv.them : 'none';
      const ti = THEM_ICON[tk];
      if (ti) {
        them.src = spriteUrl(ti, 3);
        them.className = `badge them b-${tk}`;
        them.style.display = 'block';
      } else them.style.display = 'none';
      b.classList.toggle('blocked', !!pv && !pv.valid);
    }
    const heroImg = this.hub.querySelector('.hero') as HTMLImageElement;
    if (!heroImg.src) heroImg.src = spriteUrl('hero', 4);
  }

  setRewind(left: number, ready: boolean): void {
    (this.rewindBtn.querySelector('b') as HTMLElement).textContent = String(left);
    this.rewindBtn.classList.toggle('off', left <= 0 || !ready);
  }

  flashButton(d: Dir): void {
    const b = this.buttons[d];
    b.classList.remove('fire');
    void b.offsetWidth;
    b.classList.add('fire');
  }

  shakeButton(d: Dir): void {
    const b = this.buttons[d];
    b.classList.remove('nope');
    void b.offsetWidth;
    b.classList.add('nope');
  }

  showItemCard(s: GameState, d: Dir, autoHideMs = 0): void {
    const it = s.player.slots[d];
    if (!it) {
      this.hideCard();
      return;
    }
    const def = ITEMS[it.id];
    this.card.innerHTML = '';
    this.card.className = 'card';
    const head = el('div', 'card-head', this.card);
    const im = el('img', 'card-icon', head);
    im.src = spriteUrl(`item_${it.id}`, 4);
    const nm = el('div', 'card-name', head);
    nm.innerHTML = `<span class="dirtag">${ARROWS[d]}</span>${def.name}${it.star ? '<span class="st">★</span>' : ''}`;
    const tags = el('div', 'card-tags', head);
    if (def.cooldown) tags.innerHTML += `<span class="tag cd-tag">⟳${def.cooldown}</span>`;
    if (def.charges) tags.innerHTML += `<span class="tag ch-tag">${'●'.repeat(Math.max(0, it.charges))}</span>`;
    if (def.dmg > 0) tags.innerHTML += `<span class="tag dmg-tag">⚔${def.dmg}</span>`;
    const cv = el('canvas', 'diagram', this.card);
    cv.width = 7 * 22;
    cv.height = 7 * 22;
    drawDiagram(cv, it.id, d, it.star);
    el('div', 'card-copy', this.card).textContent = ITEM_RULES[it.id];
    if (it.cd) el('div', 'card-copy', this.card).textContent = `再使用まであと${it.cd}ターン。待機中は移動だけ。`;
    const up = el('div', 'card-star', this.card);
    up.textContent = `★${it.star ? ' 強化済み：' : ' 強化すると：'}${def.starNote}`;
    clearTimeout(this.cardTimer);
    if (autoHideMs) this.cardTimer = window.setTimeout(() => this.hideCard(), autoHideMs);
  }

  showUnitCard(u: Unit, autoHideMs = 0): void {
    const d = ENEMIES[u.kind];
    this.card.innerHTML = '';
    this.card.className = 'card unit-card';
    const head = el('div', 'card-head', this.card);
    const im = el('img', 'card-icon', head);
    im.src = spriteUrl(u.kind, 4);
    const nm = el('div', 'card-name', head);
    nm.textContent = d.name;
    const hp = el('div', 'card-hp', this.card);
    hp.innerHTML = Array.from({ length: u.maxHp }, (_, k) => `<i class="${k < u.hp ? 'on' : ''}"></i>`).join('');
    const tags = el('div', 'card-tags', this.card);
    tags.innerHTML = `<span class="tag dmg-tag">⚔${d.dmg}</span>` + (d.frontShield ? `<img src="${spriteUrl('item_shield', 2)}" class="mini" alt="">` : '') + (d.flying ? '<span class="tag">⇡</span>' : '') + (d.slow ? '<span class="tag">◔</span>' : '');
    clearTimeout(this.cardTimer);
    if (autoHideMs) this.cardTimer = window.setTimeout(() => this.hideCard(), autoHideMs);
  }

  showPedestalCard(itemId: string, autoHideMs = 0): void {
    const def = ITEMS[itemId as keyof typeof ITEMS];
    if (!def) return;
    this.card.innerHTML = '';
    this.card.className = 'card';
    const head = el('div', 'card-head', this.card);
    const im = el('img', 'card-icon', head);
    im.src = spriteUrl(`item_${itemId}`, 4);
    const nm = el('div', 'card-name', head);
    nm.textContent = def.name;
    const cv = el('canvas', 'diagram', this.card);
    cv.width = 7 * 22;
    cv.height = 7 * 22;
    drawDiagram(cv, def.id, 0, 0);
    el('div', 'card-copy', this.card).textContent = '台座へ押した方向の装備と交換。同じ装備なら★強化。';
    el('div', 'card-star', this.card).textContent = `★ ${def.starNote}`;
    clearTimeout(this.cardTimer);
    if (autoHideMs) this.cardTimer = window.setTimeout(() => this.hideCard(), autoHideMs);
  }

  hideCard(): void {
    clearTimeout(this.cardTimer);
    this.card.classList.add('hidden');
  }

  showNote(title: string, text: string): void {
    this.hideCard();
    this.card.className = 'card note-card';
    this.card.replaceChildren();
    el('strong', '', this.card).textContent = title;
    el('div', 'card-copy', this.card).textContent = text;
    const close = el('button', 'note-close', this.card);
    close.textContent = '閉じる';
    close.addEventListener('click', () => this.hideCard());
  }

  showAnvil(s: GameState, pr: Prop, dir?: Dir): void {
    this.showNote('金床 · ★強化', anvilText(s, pr, dir));
  }

  setPreview(active: boolean, s?: GameState, pv?: Preview): void {
    this.previewBtn.classList.toggle('active', active);
    this.previewBtn.setAttribute('aria-pressed', String(active));
    this.previewPanel.classList.toggle('hidden', !active);
    this.buttons.forEach((b, d) => b.classList.toggle('selected', active && pv?.dir === d));
    if (!active) return;
    this.hideCard();
    this.previewPanel.replaceChildren();
    el('strong', '', this.previewPanel).textContent = pv ? `${ARROWS[pv.dir]} この方向の1ターン` : '先読み · 方向を選ぼう';
    const copy = el('div', 'preview-copy', this.previewPanel);
    copy.textContent = s && pv ? previewText(s, pv) : '十字ボタン／矢印キーで比較。まだ行動しません。';
    const it = s && pv ? s.player.slots[pv.dir] : null;
    if (it?.star) el('div', 'card-star', this.previewPanel).textContent = `★ ${ITEMS[it.id].starNote}`;
    const legend = el('div', 'preview-legend', this.previewPanel);
    legend.innerHTML = '<span class="move-key">◇ 移動先</span><span class="attack-key">▧ 攻撃・効果</span>';
    if (pv?.delayedTiles.length) legend.innerHTML += '<span class="delay-key">┄ 予約爆発</span>';
    if (pv?.valid) {
      const outcome = el('div', 'preview-outcome', this.previewPanel);
      outcome.classList.toggle('danger', pv.dmgTaken > 0);
      outcome.textContent = pv.you === 'death' ? '☠ この行動で倒れます' : `被ダメージ ${pv.dmgTaken}${pv.heal ? ` ／ 回復 +${pv.heal}` : ''}${pv.killIds.length ? ` ／ 撃破 ${pv.killIds.length}` : ''}`;
      if (pv.dest && pv.actionDest && (pv.dest.x !== pv.actionDest.x || pv.dest.y !== pv.actionDest.y)) {
        el('div', 'preview-copy', this.previewPanel).textContent = '赤い点線は、敵の押し出し等を受けた後の位置。';
      }
    }
    const row = el('div', 'preview-actions', this.previewPanel);
    const cancel = el('button', '', row);
    cancel.textContent = '閉じる';
    cancel.addEventListener('click', () => this.h.onPreview());
    const confirm = el('button', 'confirm-preview', row);
    confirm.textContent = 'この方向へ';
    confirm.disabled = !pv?.valid;
    confirm.addEventListener('click', () => this.h.onConfirm());
  }

  showLesson(lesson: Lesson | null): void {
    if (this.lessonId === (lesson?.id ?? '')) return;
    this.lessonId = lesson?.id ?? '';
    this.lesson.classList.toggle('hidden', !lesson);
    this.lesson.replaceChildren();
    if (!lesson) return;
    el('strong', '', this.lesson).textContent = lesson.title;
    el('div', '', this.lesson).textContent = lesson.text;
    const b = el('button', '', this.lesson);
    b.textContent = '×';
    b.setAttribute('aria-label', 'ヒントを閉じる');
    b.addEventListener('click', () => this.h.onDismissLesson());
  }

  showBanner(floor: number, boss: boolean): void {
    const zone = Math.floor((floor - 1) / 3);
    this.banner.innerHTML = `<div class="b-floor">B${floor}</div><div class="b-zone z${zone}">${ZONE_NAMES[zone]}</div>${boss ? '<div class="b-boss">☠</div>' : ''}`;
    this.banner.className = 'banner show';
    clearTimeout((this.banner as any)._t);
    (this.banner as any)._t = window.setTimeout(() => (this.banner.className = 'banner hidden'), 2200);
  }

  setVisible(v: boolean): void {
    this.top.style.display = v ? '' : 'none';
    this.pad.style.display = v ? '' : 'none';
    if (!v) this.hideCard();
    if (!v) { this.setPreview(false); this.showLesson(null); }
  }
}
