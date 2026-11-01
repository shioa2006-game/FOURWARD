// Text-mode harness so a human or an agent can PLAY FOURWARD from a terminal.
//   node tools/play.ts new <stateFile> [seed] [kit]
//   node tools/play.ts look <stateFile>
//   node tools/play.ts move <stateFile> <U|R|D|L>...   (several moves allowed, e.g. "move f.json U U R")
//   node tools/play.ts arrange <stateFile> <a> <b>      swap two slots (only right after descending)
import fs from 'node:fs';
import { newRun, act, previewAll, threatMap, visibleSet, armedSlots, revealAround } from '../src/core/engine.ts';
import { buildFloor, newItem } from '../src/core/floor.ts';
import type { ItemId } from '../src/core/types.ts';
import { T } from '../src/core/dungeon.ts';
import { ENEMIES, ITEMS, ZONE_NAMES } from '../src/core/content.ts';
import type { GameEvent, GameState } from '../src/core/types.ts';
import type { Dir } from '../src/core/geom.ts';

const [cmd, file, ...rest] = process.argv.slice(2);
if (!cmd || !file) {
  console.log('usage: node tools/play.ts new|look|move|arrange <stateFile> ...');
  process.exit(1);
}
const DIRN = ['U', 'R', 'D', 'L'];
const MON: Record<string, string> = {
  slime: 's', bat: 'b', archer: 'a', goblin: 'g', knight: 'K', ogre: 'O', beetle: 'e', golem: 'G', sentinel: 'N',
  boss_slime: 'M', boss_lancer: 'L', boss_warden: 'W',
};

function load(): GameState {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function save(s: GameState): void {
  fs.writeFileSync(file, JSON.stringify(s));
}

function slotStr(s: GameState): string {
  const armed = armedSlots(s);
  return s.player.slots
    .map((it, d) => {
      if (!it) return `${DIRN[d]}:(empty)`;
      const def = ITEMS[it.id];
      let t = `${DIRN[d]}:${it.id}${it.star ? '★' : ''}`;
      if (it.cd > 0) t += `[cd${it.cd}]`;
      if (def.charges > 0) t += `[${it.charges}x]`;
      if (!armed[d]) t += '(idle)';
      return t;
    })
    .join('  ');
}

function render(s: GameState): string {
  const vis = visibleSet(s);
  const th = threatMap(s, vis);
  const w = s.map.w;
  const p = s.player;
  const R = 9;
  const lines: string[] = [];
  const legend = new Set<string>();
  for (let y = Math.max(0, p.y - R); y <= Math.min(s.map.h - 1, p.y + R); y++) {
    let row = '';
    for (let x = Math.max(0, p.x - R - 6); x <= Math.min(w - 1, p.x + R + 6); x++) {
      const i = y * w + x;
      if (!s.explored[i]) {
        row += ' ';
        continue;
      }
      const u = s.units.find((q) => q.x === x && q.y === y);
      const pr = s.props.find((q) => q.x === x && q.y === y);
      const bomb = s.bombs.find((q) => q.x === x && q.y === y);
      let ch = '';
      if (p.x === x && p.y === y) ch = '@';
      else if (u && vis.has(i)) {
        ch = MON[u.kind] ?? '?';
        legend.add(`${ch}=${u.kind}(hp${u.hp}${u.awake ? '' : ',asleep'}${u.stun ? ',stunned' + u.stun : ''}${ENEMIES[u.kind].frontShield ? ',shield faces ' + DIRN[u.facing] : ''}${u.kind === 'golem' && u.mode === 1 ? ',WINDING UP' : ''}${u.kind === 'beetle' && u.mode === 1 ? ',LIT ' + u.timer : ''}${u.kind === 'boss_lancer' && u.mode === 1 ? ',CHARGING ' + DIRN[u.aim] : ''})`);
      } else if (bomb) ch = '*';
      else if (pr) {
        ch = pr.kind === 'pedestal' ? (pr.lockRoom >= 0 ? 'Q' : 'P') : pr.kind === 'anvil' ? '&' : pr.kind === 'chest' ? (pr.used ? 'c' : 'C') : pr.kind === 'fountain' ? (pr.used ? 'f' : 'F') : pr.kind === 'barrel' ? 'X' : 'x';
        if (pr.kind === 'pedestal') legend.add(`${ch}@${pr.x},${pr.y}=${pr.item ? pr.item.id + (pr.item.star ? '★' : '') : 'empty'}${pr.lockRoom >= 0 ? ' (CAGED until its room is cleared)' : ''}`);
      } else {
        const t = s.map.tiles[i];
        const pk = s.pickups.find((q) => q.x === x && q.y === y);
        if (pk) ch = pk.kind === 'coin' ? '$' : '+';
        else if (t === T.Wall) ch = '#';
        else if (t === T.Pillar) ch = 'I';
        else if (t === T.Pit) ch = '_';
        else if (t === T.Lava) ch = '~';
        else if (t === T.Spikes) ch = '^';
        else if (t === T.Stairs) ch = '>';
        else if (t === T.Grass) ch = '"';
        else ch = s.map.room[i] >= 0 ? '.' : ',';
        if (vis.has(i)) {
          const now = th.now.get(i) ?? 0;
          const later = th.later.get(i) ?? 0;
          if (now > 0 && (ch === '.' || ch === ',' || ch === '"' || ch === '^')) ch = now >= 2 ? '!' : 'r';
          else if (later > 0 && (ch === '.' || ch === ',' || ch === '"')) ch = String(Math.min(9, later));
        }
      }
      row += ch;
    }
    lines.push(row);
  }
  const heroTh = th.now.get(p.y * w + p.x) ?? 0;
  const pv = previewAll(s);
  const pvs = pv
    .map((v) => {
      if (!v.valid) return `  ${DIRN[v.dir]}: (nothing happens, no turn)`;
      const parts: string[] = [];
      if (v.dest) parts.push(v.dest.x === p.x && v.dest.y === p.y ? 'stay' : `to ${v.dest.x},${v.dest.y}`);
      if (v.them !== 'none') parts.push(v.them === 'kill' ? `KILL x${v.killIds.length}` : v.them);
      if (v.hitIds.length && v.them !== 'kill') parts.push(`hits ${v.hitIds.length}`);
      if (v.you !== 'none') parts.push(v.you === 'death' ? 'YOU DIE' : `you take ${v.dmgTaken}`);
      if (v.heal) parts.push(`heal ${v.heal}`);
      return `  ${DIRN[v.dir]}: ${parts.join(', ')}`;
    })
    .join('\n');
  const zone = Math.floor((s.floor - 1) / 3);
  return [
    `B${s.floor} ${ZONE_NAMES[zone] ?? ''}  turn ${s.turn}  status ${s.status}  HP ${p.hp}/${p.maxHp}  coins ${p.coins}  burn ${p.burn}  stairs ${s.stairsOpen ? 'open' : 'SEALED (kill the guardian)'}`,
    `slots: ${slotStr(s)}`,
    `you stand at ${p.x},${p.y}${heroTh ? ` (currently a RED tile: ${heroTh} dmg if you stay)` : ''}`,
    'map (@ you, letters monsters, r/! = red tile 1/2+ dmg if you END your turn there, digits = blast in N turns, P pedestal, Q caged pedestal, & anvil, C chest, F fountain, x crate, X barrel, * bomb, > stairs, _ pit, ~ lava, ^ spikes, I pillar, $ coins, + heart, , corridor):',
    ...lines,
    [...legend].join('; '),
    'what each press would do this turn (exact simulation):',
    pvs,
  ].join('\n');
}

function summarize(ev: GameEvent[], s: GameState): string {
  const out: string[] = [];
  let phase = 'you';
  for (const e of ev) {
    if (e.t === 'enemyPhase') phase = 'enemies';
    if (e.t === 'damage') out.push(`${phase}: ${e.id === 0 ? 'YOU' : 'unit#' + e.id} -${e.amount} (${e.kind})`);
    if (e.t === 'death') out.push(`${phase}: ${e.id === 0 ? 'YOU DIED' : e.kind + ' died (' + e.how + ')'}`);
    if (e.t === 'block') out.push(`${phase}: ${e.id === 0 ? 'your shield' : 'unit#' + e.id + ' shield'} blocked`);
    if (e.t === 'heal') out.push(`healed ${e.amount}`);
    if (e.t === 'equip') out.push(`equipped ${e.item} on ${DIRN[e.dir]} (left ${e.old ?? 'nothing'} on the pedestal)`);
    if (e.t === 'upgrade') out.push(`upgraded ${e.item}★`);
    if (e.t === 'pickup') out.push(`picked up ${e.kind} x${e.amount}`);
    if (e.t === 'explode') out.push(`${phase}: EXPLOSION at ${e.x},${e.y}`);
    if (e.t === 'trick') out.push(`TRICK: ${e.text}`);
    if (e.t === 'status' && e.status === 'wake') out.push(`unit#${e.id} woke up`);
    if (e.t === 'status' && (e.status === 'stun' || e.status === 'freeze')) out.push(`unit#${e.id} ${e.status}`);
    if (e.t === 'brace') out.push('you braced in place (turn passed)');
    if (e.t === 'descend') out.push(`=== descended to B${e.floor} (you may now use "arrange" to swap slots for free) ===`);
    if (e.t === 'stairs') out.push('the stairs appeared!');
    if (e.t === 'prop' && e.what === 'unlock') out.push('a cage opened!');
  }
  void s;
  return out.join('\n');
}

if (cmd === 'new') {
  const seed = Number(rest[0] ?? Date.now() % 100000);
  const kit = (rest[1] ?? 'knight') as 'knight' | 'lancer' | 'mage';
  const s = newRun(seed, kit);
  const startFloor = Number(rest[2] ?? 1);
  if (startFloor > 1) {
    // jump ahead with a plausible mid-run character: guardian hearts + filled slots
    const extra: ItemId[] = ['axe', 'hammer', 'shield', 'spear', 'fire', 'bomb'];
    for (let d = 0; d < 4; d++) if (!s.player.slots[d]) s.player.slots[d] = newItem(extra[(seed + d) % extra.length]);
    s.player.maxHp = 5 + Math.floor((startFloor - 1) / 3);
    s.player.hp = s.player.maxHp;
    s.player.coins = startFloor * 2;
    buildFloor(s, startFloor);
    revealAround(s);
  }
  save(s);
  console.log(render(s));
} else if (cmd === 'look') {
  console.log(render(load()));
} else if (cmd === 'move') {
  const s = load();
  for (const m of rest) {
    const d = DIRN.indexOf(m.toUpperCase());
    if (d < 0) {
      console.log(`bad move ${m}`);
      break;
    }
    const before = s.floor;
    const r = act(s, d as Dir);
    console.log(`> ${m}${r.used ? '' : ' (nothing happened)'}`);
    const sum = summarize(r.events, s);
    if (sum) console.log(sum);
    if (s.status !== 'play' || s.floor !== before) break;
  }
  save(s);
  console.log(render(s));
} else if (cmd === 'arrange') {
  const s = load();
  const a = DIRN.indexOf((rest[0] ?? '').toUpperCase());
  const b = DIRN.indexOf((rest[1] ?? '').toUpperCase());
  if (a >= 0 && b >= 0) {
    const sl = s.player.slots;
    [sl[a], sl[b]] = [sl[b], sl[a]];
  }
  save(s);
  console.log(render(s));
}
