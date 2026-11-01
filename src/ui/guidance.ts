// Short, contextual copy shared by the HUD and testable without a browser.
import type { Dir } from '../core/geom.ts';
import { DX, DY } from '../core/geom.ts';
import type { GameState, ItemId, Prop } from '../core/types.ts';
import type { Preview } from '../core/engine.ts';
import { ITEMS } from '../core/content.ts';

export const ITEM_RULES: Record<ItemId, string> = {
  sword: '1歩進んで、その先1マスを攻撃。敵や壁で止まっても攻撃。',
  axe: '正面と斜め前2マス（横並び3マス）を攻撃してから、1歩進む。',
  hammer: '1歩進んで攻撃。敵を2マス押し、衝突や穴を狙える。',
  spear: '射程内に敵・壊せる物があれば、動かず攻撃。なければ1歩。',
  fire: '5マス以内の対象へ、動かず炎を放つ。対象がなければ1歩。',
  frost: '5マス以内の対象へ、動かず氷を放つ。対象がなければ1歩。',
  shield: '1歩進み、押した方向からの被ダメージを1減らす。爆発は防げない。',
  flask: '1歩進みHPを2回復。HPが2以上減った時か、残り1で使用。各階2回（★で3回）、階ごとに補充。',
  boots: '最大3マス進み、正面の敵に体当たり。',
  bomb: '敵が見えている時、移動前の足元に爆弾。敵へ押すと敵の足元に設置。',
};

export const GOLD_HELP = 'GOLDは金床で装備を★強化するためのお金。金床はB2・B5・B8にあり、費用は4・6・8 GOLD。各金床は1回限り。';
export const STAR_HELP = '★は装備ごとの特殊効果。金床に向かって押した方向の装備が強化されます。同じ装備を台座で重ねても★に。';

export function anvilText(s: GameState, pr: Prop, dir?: Dir): string {
  if (pr.used) return '使用済みの金床です（1か所につき1回）。';
  const cost = `費用 ${pr.price} GOLD ／ 所持 ${s.player.coins}`;
  if (dir === undefined) return `${cost}。強化したい装備の方向から金床へ押す。★強化は1段階。`;
  const it = s.player.slots[dir];
  if (!it) return `${cost}。この方向には装備がありません。`;
  if (it.star) return `${ITEMS[it.id].name}は★強化済みです。別の方向から試そう。`;
  if (s.player.coins < pr.price) return `${cost}。あと${pr.price - s.player.coins} GOLD必要です。`;
  return `${cost} → ${ITEMS[it.id].name}★：${ITEMS[it.id].starNote}。金床は使い切り。`;
}

export function previewText(s: GameState, pv: Preview): string {
  const d = pv.dir;
  const pr = s.props.find((p) => p.x === s.player.x + DX[d] && p.y === s.player.y + DY[d]);
  if (pr?.kind === 'anvil') return anvilText(s, pr, d);
  if (!pv.valid) return 'この方向には行動できません。ターンは進みません。';
  if (pv.them === 'swap') return `この方向の装備と交換。${pr?.item && s.player.slots[d]?.id === pr.item.id && !s.player.slots[d]?.star ? '同じ装備なので★強化。' : '元の装備は台座に残ります。'}`;
  if (pv.them === 'stairs') return '次の階へ。階段では4方向の装備を自由に並べ替えられます。';
  if (pv.them === 'chest') return pr?.kind === 'fountain' ? '泉でHPと薬瓶を補充。' : '宝箱からGOLDを入手。';
  const it = s.player.slots[d];
  const move = pv.path.length ? `${pv.path.length}マス移動` : 'その場で行動';
  if (it?.cd) return `${move}。再使用まであと${it.cd}ターン：今回は装備が発動しません。`;
  if (it && ITEMS[it.id].charges && it.charges <= 0) return `${move}。薬瓶は使い切り。次の階で補充。`;
  if (pv.delayedTiles.length) return `${move}＋爆弾設置。橙の点線は遅れて爆発する範囲（自分も被弾）。`;
  if (pv.heal) return `${move}＋HP ${pv.heal}回復。`;
  if (pv.tiles.length) return `${move}＋${it ? ITEMS[it.id].name : ''}の効果。${it ? ITEM_RULES[it.id] : ''}`;
  if (it?.id === 'shield') return `${move}＋${it.star ? '三方向' : '押した方向'}を防御。`;
  return `${move}。${it ? ITEM_RULES[it.id] : '空の方向は移動だけ。'}`;
}

export interface Lesson { id: string; title: string; text: string }
export function nextLesson(s: GameState, visible: Set<number>, seen: Set<string>): Lesson | null {
  const choices: (Lesson & { when: boolean })[] = [
    { id: 'move', when: s.floor === 1 && s.turn === 0, title: 'その一歩が、武器になる。', text: '矢印／WASD／十字ボタンで移動＋その方向の装備を発動。入力するまで敵も動きません。' },
    { id: 'look', when: s.floor === 1 && s.turn > 0, title: 'まずは「先読み」で比べよう', text: '先読み → 方向を選ぶと、移動先と攻撃範囲が表示されます。「この方向へ」で実行。確認中はターンが進みません。' },
    { id: 'danger', when: s.units.some((u) => u.awake && visible.has(u.y * s.map.w + u.x)), title: '赤い床は、敵の攻撃予告', text: '先読みの「被ダメージ」で反撃まで確認。壁に向かって押しても1ターン使うので注意。↶で各階1回だけ戻せます。' },
    { id: 'knight', when: s.units.some((u) => u.kind === 'knight' && u.awake && visible.has(u.y * s.map.w + u.x)), title: '盾騎士は、歩いた向きに盾を構える', text: '正面の攻撃は防がれ押し返される。横へ回り込むと、追ってきた騎士の側面が空く。攻撃した直後も盾が下がる。' },
    { id: 'anvil', when: s.props.some((p) => p.kind === 'anvil' && !p.used && visible.has(p.y * s.map.w + p.x)), title: '金床でGOLDを★に変える', text: '強化したい装備の方向から金床へ押すと、強化される装備が表示されます。もう一度押すと確定。1か所につき1回。' },
    { id: 'gold', when: s.player.coins > 0, title: '拾ったGOLDは、次の金床へ', text: 'B2・B5・B8の金床で★強化に使えます。右上のGOLDを押すと、使い方をいつでも確認できます。' },
    { id: 'pedestal', when: s.props.some((p) => p.kind === 'pedestal' && p.item && visible.has(p.y * s.map.w + p.x)), title: '近づく方向も、装備選び', text: '台座へ押した方向の装備と交換。元の装備は台座に残り、同じ装備なら★強化。自由な並べ替えは階段で。' },
  ];
  return choices.find((c) => c.when && !seen.has(c.id)) ?? null;
}
