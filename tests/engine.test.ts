import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, act, threatMap, visibleSet, previewDir } from '../src/core/engine.ts';
import { T } from '../src/core/dungeon.ts';
import { makeUnit } from '../src/core/ai.ts';
import { newItem } from '../src/core/floor.ts';
import { Rng } from '../src/core/rng.ts';
import type { Dir } from '../src/core/geom.ts';
import type { GameState, ItemId, Prop } from '../src/core/types.ts';
import { anvilText, previewText, nextLesson } from '../src/ui/guidance.ts';

const UP: Dir = 0;
const RIGHT: Dir = 1;
const DOWN: Dir = 2;
const LEFT: Dir = 3;

const KIND: Record<string, string> = { S: 'slime', B: 'bat', A: 'archer', K: 'knight', G: 'golem', E: 'beetle', N: 'sentinel', O: 'ogre', g: 'goblin' };

/**
 * Build a one-room scenario from ASCII. '#' wall, '.' floor, 'I' pillar, '_' pit,
 * '>' stairs, '@' hero, letters = monsters (awake), 'P' pedestal.
 */
function scene(rows: string[], slots: (ItemId | null)[] = ['sword', null, null, null]): GameState {
  const s = newRun(1);
  const h = rows.length;
  const w = rows[0].length;
  const tiles: number[] = [];
  const room: number[] = [];
  s.units = [];
  s.props = [];
  s.pickups = [];
  s.bombs = [];
  s.fires = [];
  let stairs = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const ch = rows[y][x];
      const i = y * w + x;
      let t: number = T.Floor;
      if (ch === '#') t = T.Wall;
      else if (ch === 'I') t = T.Pillar;
      else if (ch === '_') t = T.Pit;
      else if (ch === '>') {
        t = T.Stairs;
        stairs = i;
      }
      tiles.push(t);
      room.push(t === T.Wall ? -1 : 0);
      if (ch === '@') {
        s.player.x = x;
        s.player.y = y;
      } else if (KIND[ch]) {
        const u = makeUnit(s, KIND[ch], x, y);
        u.awake = true;
        u.home = 0;
        s.units.push(u);
      } else if (ch === 'P') {
        s.props.push({ id: s.nextId++, kind: 'pedestal', x, y, item: null, price: 0, hp: 0, used: false, lockRoom: -1 });
      }
    }
  s.map = {
    w,
    h,
    tiles,
    room,
    rooms: [{ id: 0, x: 1, y: 1, w: w - 2, h: h - 2, tags: [] }],
    doors: [],
    start: s.player.y * w + s.player.x,
    stairs: stairs >= 0 ? stairs : w + 1,
    startRoom: 0,
    stairsRoom: 0,
    attempts: 1,
  };
  s.explored = tiles.map(() => 1);
  s.stairsOpen = true;
  s.bossId = 0;
  s.player.slots = slots.map((id) => (id ? newItem(id) : null));
  s.player.hp = s.player.maxHp = 5;
  return s;
}

const unit = (s: GameState, kind: string) => s.units.find((u) => u.kind === kind);

test('sword lunges: steps, then strikes the tile ahead', () => {
  const s = scene(['#######', '#.....#', '#.S...#', '#.....#', '#.@...#', '#######'], ['sword', null, null, null]);
  act(s, UP);
  assert.deepEqual([s.player.x, s.player.y], [2, 3]);
  assert.equal(unit(s, 'slime'), undefined, 'slime (2hp) killed by a 2-damage lunge');
});

test('pressing into a wall braces: the turn passes, the hero stays', () => {
  const s = scene(['#####', '#@..#', '#...#', '#####']);
  const t0 = s.turn;
  const r = act(s, UP);
  assert.equal(r.used, true);
  assert.equal(s.turn, t0 + 1);
  assert.deepEqual([s.player.x, s.player.y], [1, 1]);
  assert.ok(r.events.some((e) => e.t === 'brace'));
});

test('pedestal: the side you bump from is the slot it fills; old item stays', () => {
  const s = scene(['#######', '#.....#', '#.@P..#', '#.....#', '#######'], ['sword', 'axe', null, null]);
  (s.props[0] as Prop).item = newItem('spear');
  act(s, RIGHT);
  assert.equal(s.player.slots[RIGHT]?.id, 'spear');
  assert.equal(s.props[0].item?.id, 'axe');
  assert.deepEqual([s.player.x, s.player.y], [2, 2], 'swapping does not move you');
});

test('a duplicate merges into a ★ upgrade and empties the pedestal', () => {
  const s = scene(['#######', '#.....#', '#.@P..#', '#.....#', '#######'], ['sword', 'axe', null, null]);
  (s.props[0] as Prop).item = newItem('axe');
  act(s, RIGHT);
  assert.equal(s.player.slots[RIGHT]?.id, 'axe');
  assert.equal(s.player.slots[RIGHT]?.star, 1);
  assert.equal(s.props[0].item, null);
});

test('spear holds: with a target in reach it pokes without moving', () => {
  const s = scene(['########', '#......#', '#@.S...#', '#......#', '########'], [null, 'spear', null, null]);
  act(s, RIGHT);
  assert.deepEqual([s.player.x, s.player.y], [1, 2]);
  assert.equal(unit(s, 'slime')!.hp, 1);
});

test('spear with nothing in reach is a plain step', () => {
  const s = scene(['########', '#......#', '#@.....#', '#......#', '########'], [null, 'spear', null, null]);
  act(s, RIGHT);
  assert.deepEqual([s.player.x, s.player.y], [2, 2]);
});

test('axe sweeps the front row (diagonals included) before stepping', () => {
  const s = scene(['#######', '#.....#', '#..B..#', '#.@...#', '#######'], ['axe', null, null, null]);
  act(s, UP);
  assert.equal(unit(s, 'bat'), undefined, 'diagonal bat cut down by the sweep');
});

test('hammer knocks a monster into a pit (and goes on cooldown)', () => {
  const s = scene(['########', '#......#', '#@S_...#', '#......#', '########'], [null, 'hammer', null, null]);
  const r = act(s, RIGHT);
  assert.equal(unit(s, 'slime'), undefined);
  assert.ok(r.events.some((e) => e.t === 'death' && e.how === 'fall'));
  assert.ok(r.events.some((e) => e.t === 'trick'), 'a fall kill is called out');
  assert.ok((s.player.slots[RIGHT]?.cd ?? 0) > 0);
});

test('the hero cannot be knocked into a pit: it acts as a wall', () => {
  const s = scene(['#######', '#.....#', '#_@O..#', '#.....#', '#######'], [null, null, null, null]);
  s.player.hp = 5;
  act(s, UP); // ogre adjacent on the right attacks and shoves left toward the pit
  assert.notEqual(s.map.tiles[s.player.y * s.map.w + s.player.x], T.Pit);
  assert.ok(s.status === 'play');
});

test('shield knight: a frontal blow is blocked and drives it back; a lowered shield lets blows through', () => {
  const s = scene(['#########', '#.......#', '#.@K....#', '#.......#', '#########'], [null, 'sword', null, null]);
  const k = unit(s, 'knight')!;
  k.facing = LEFT; // facing the hero
  const r = act(s, RIGHT); // bump-attack its front
  assert.equal(k.hp, 3, 'front shield blocks the damage');
  assert.ok(r.events.some((e) => e.t === 'block' && e.id === k.id));
  assert.ok(r.events.some((e) => e.t === 'move' && e.id === k.id && e.how === 'push'), 'recoils one tile');
  // pinned against a wall, the recoil becomes slam damage
  const s3 = scene(['######', '#....#', '#.@K##', '#....#', '######'], [null, 'sword', null, null]);
  const k3 = unit(s3, 'knight')!;
  k3.facing = LEFT;
  act(s3, RIGHT);
  assert.equal(k3.hp, 2, 'slammed into the wall behind it');
  // right after it swings, its shield is lowered
  const s2 = scene(['#########', '#.......#', '#.@K....#', '#.......#', '#########'], [null, 'sword', null, null]);
  const k2 = unit(s2, 'knight')!;
  k2.facing = LEFT;
  k2.mode = 1;
  act(s2, RIGHT);
  assert.ok(!s2.units.includes(k2) || k2.hp === 1, 'shield down: the sword bites');
});

test('golem winds up first: the 3x3 turns red, stepping out avoids the slam', () => {
  const s = scene(['#########', '#.......#', '#.......#', '#...G...#', '#.......#', '#...@...#', '#.......#', '#########'], [null, null, null, null]);
  act(s, UP); // hero steps next to the golem
  const g = unit(s, 'golem')!;
  assert.equal(g.mode, 1, 'golem raised its fists');
  const th = threatMap(s);
  assert.ok((th.now.get(s.player.y * s.map.w + s.player.x) ?? 0) >= 2, 'hero tile is red (2 dmg)');
  const hp = s.player.hp;
  act(s, DOWN); // step out of the 3x3
  assert.equal(s.player.hp, hp, 'no damage after stepping out');
});

test('beetle killed by hand leaves a lit fuse (one turn to step away)', () => {
  const s = scene(['#######', '#.....#', '#.E...#', '#.@...#', '#.....#', '#######'], ['sword', null, null, null]);
  act(s, UP);
  assert.equal(unit(s, 'beetle'), undefined);
  assert.equal(s.bombs.length, 1);
  const hp = s.player.hp;
  act(s, DOWN);
  act(s, DOWN);
  assert.equal(s.player.hp, hp, 'stepped out in time');
});

test('cage pedestal opens once every monster of its room is dead', () => {
  const s = scene(['#########', '#.......#', '#.@S..P.#', '#.......#', '#########'], [null, 'sword', null, null]);
  const pr = s.props[0];
  pr.item = newItem('fire');
  pr.lockRoom = 0;
  act(s, RIGHT);
  assert.equal(unit(s, 'slime'), undefined);
  assert.equal(pr.lockRoom, -1);
});

test('stairs: stepping onto them descends and heals 1', () => {
  const s = scene(['######', '#@>..#', '######'], [null, null, null, null]);
  s.player.hp = 3;
  const r = act(s, RIGHT);
  assert.equal(r.descended, true);
  assert.equal(s.floor, 2);
  assert.equal(s.player.hp, 4);
});

test('previews are faithful: predicted damage equals what really happens', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const s = newRun(seed * 101);
    const rng = new Rng(seed);
    for (let t = 0; t < 120 && s.status === 'play'; t++) {
      const d = rng.int(0, 3) as Dir;
      const pv = previewDir(s, d);
      const hp0 = s.player.hp;
      const floor0 = s.floor;
      act(s, d);
      if (s.floor !== floor0) break;
      const real = Math.max(0, hp0 - s.player.hp + pv.heal);
      assert.equal(real, (s.status as string) === 'dead' ? Math.max(real, pv.dmgTaken) : pv.dmgTaken, `seed ${seed} turn ${t}`);
    }
  }
});

test('no unannounced damage: safe-looking moves never hurt', () => {
  let checked = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const s = newRun(seed * 7 + 3);
    const rng = new Rng(seed);
    for (let t = 0; t < 250 && s.status === 'play'; t++) {
      const floor0 = s.floor;
      const vis = visibleSet(s);
      const th = threatMap(s, vis);
      const d = rng.int(0, 3) as Dir;
      const pv = previewDir(s, d);
      const hp0 = s.player.hp;
      const burning = s.player.burn > 0;
      const r = act(s, d);
      if (s.floor !== floor0 || !r.used) continue;
      const enemyIdx = r.events.findIndex((e) => e.t === 'enemyPhase');
      const heroEv = enemyIdx >= 0 ? r.events.slice(0, enemyIdx) : r.events;
      const touched = heroEv.some((e) => (e.t === 'damage' || e.t === 'block' || e.t === 'move' || e.t === 'death') && e.id !== 0);
      const dest = s.player.y * s.map.w + s.player.x;
      const onSpikes = s.map.tiles[dest] === T.Spikes;
      if (touched || burning || onSpikes || pv.heal > 0) continue;
      if ((th.now.get(dest) ?? 0) > 0) continue;
      checked++;
      assert.ok(s.player.hp >= hp0, `seed ${seed} turn ${t}: took ${hp0 - s.player.hp} damage on a tile that was not red`);
    }
  }
  assert.ok(checked > 500, `property exercised (${checked} safe moves checked)`);
});

test('preview separates sword destination from its post-step attack; empty attacks are visible', () => {
  const s = scene(['#######', '#.....#', '#.....#', '#.@...#', '#######']);
  const before = JSON.stringify(s);
  const p = previewDir(s, UP);
  assert.deepEqual(p.actionDest, { x: 2, y: 2 });
  assert.deepEqual(p.path, [16]);
  assert.deepEqual(p.tiles, [9]);
  assert.equal(JSON.stringify(s), before, 'preview must not mutate state, RNG, gear or turn');
  act(s, UP);
  assert.deepEqual(p.dest, { x: s.player.x, y: s.player.y });
});

test('axe preview keeps the pre-step sweep and star side tiles', () => {
  const s = scene(['#######', '#.....#', '#.....#', '#.@...#', '#######'], ['axe', null, null, null]);
  s.player.slots[UP]!.star = 1;
  const p = previewDir(s, UP);
  assert.deepEqual(p.actionDest, { x: 2, y: 2 });
  assert.deepEqual([...p.tiles].sort((a,b) => a-b), [15,16,17,22,24]);
});

test('magic preview shows the ray, holds its position, and respects walls and cooldown', () => {
  const s = scene(['########', '#@..S..#', '########'], [null, 'fire', null, null]);
  const p = previewDir(s, RIGHT);
  assert.deepEqual(p.actionDest, { x: 1, y: 1 });
  assert.deepEqual(p.path, []);
  assert.deepEqual(p.tiles, [10, 11, 12]);
  s.player.slots[RIGHT]!.cd = 2;
  const cooling = previewDir(s, RIGHT);
  assert.deepEqual(cooling.tiles, []);
  assert.deepEqual(cooling.actionDest, { x: 2, y: 1 });
  assert.match(previewText(s, cooling), /あと2ターン/);
  s.player.slots[RIGHT]!.cd = 0;
  s.map.tiles[11] = T.Wall;
  assert.deepEqual(previewDir(s, RIGHT).tiles, []);
});

test('star frost preview pierces enemies but ends at the wall', () => {
  const s = scene(['#########', '#@.S.S#.#', '#########'], [null, 'frost', null, null]);
  s.player.slots[RIGHT]!.star = 1;
  const p = previewDir(s, RIGHT);
  assert.deepEqual(p.tiles, [11,12,13,14]);
  assert.equal(p.hitIds.length, 2);
  assert.deepEqual(p.path, []);
});

test('dash preview includes every traversed tile and stops at obstacles', () => {
  const s = scene(['########', '#@...I.#', '########'], [null, 'boots', null, null]);
  const p = previewDir(s, RIGHT);
  assert.deepEqual(p.path, [10,11,12]);
  assert.deepEqual(p.actionDest, { x: 4, y: 1 });
});

test('bomb preview distinguishes a delayed blast from an immediate attack', () => {
  const s = scene(['#######', '#.....#', '#.@...#', '#...S.#', '#######'], [null, 'bomb', null, null]);
  const before = JSON.stringify(s);
  const p = previewDir(s, RIGHT);
  assert.deepEqual(p.tiles, []);
  assert.equal(p.delayedTiles.length, 5);
  assert.ok(p.delayedTiles.includes(16));
  assert.equal(JSON.stringify(s), before);
  s.player.slots[RIGHT]!.star = 1;
  assert.equal(previewDir(s, RIGHT).delayedTiles.length, 9);
});

test('anvil guidance explains cost, insufficiency, empty/used/starred states and exact benefit', () => {
  const s = scene(['#####', '#.P.#', '#.@.#', '#####']);
  const pr = s.props[0];
  pr.kind = 'anvil'; pr.price = 4;
  s.player.coins = 1;
  assert.match(previewText(s, previewDir(s, UP)), /あと3 GOLD/);
  assert.equal(previewDir(s, UP).valid, false);
  s.player.coins = 4;
  assert.match(previewText(s, previewDir(s, UP)), /剣★：倒すと連続行動/);
  const turn = s.turn;
  previewDir(s, UP);
  assert.equal(s.turn, turn);
  assert.equal(s.player.coins, 4);
  act(s, UP);
  assert.equal(s.player.coins, 0);
  assert.equal(s.player.slots[UP]!.star, 1);
  assert.match(anvilText(s, pr, UP), /使用済み/);
  pr.used = false;
  assert.match(anvilText(s, pr, UP), /強化済み/);
  s.player.slots[UP] = null;
  assert.match(anvilText(s, pr, UP), /装備がありません/);
});

test('first-time lessons progress, can be dismissed and only reveal visible discoveries', () => {
  const s = scene(['#####', '#.P.#', '#.@.#', '#####']);
  s.props[0].item = newItem('sword');
  const seen = new Set<string>();
  assert.equal(nextLesson(s, new Set(), seen)?.id, 'move');
  seen.add('move'); s.turn = 1;
  assert.equal(nextLesson(s, new Set(), seen)?.id, 'look');
  seen.add('look');
  assert.equal(nextLesson(s, new Set(), seen), null);
  assert.equal(nextLesson(s, new Set([7]), seen)?.id, 'pedestal');
  seen.add('pedestal'); s.player.coins = 1;
  assert.equal(nextLesson(s, new Set([7]), seen)?.id, 'gold');
  seen.add('gold');
  assert.equal(nextLesson(s, new Set([7]), seen), null);
});

test('collecting a heart does not mask predicted incoming damage', () => {
  const s = scene(['######', '#.@..#', '#....#', '######'], [null, null, null, null]);
  s.map.tiles[14] = T.Spikes;
  s.player.hp = 2;
  s.pickups.push({ id: s.nextId++, kind: 'heart', x: 2, y: 2, amount: 1 });
  const p = previewDir(s, DOWN);
  assert.equal(p.heal, 1);
  assert.equal(p.dmgTaken, 1);
  assert.equal(p.you, 'hurt');
  act(s, DOWN);
  assert.equal(s.player.hp, 2, 'one healing and one damage cancel out, but damage must be shown');
});

test('flask heals twice per floor (★ three times)', () => {
  const s = scene(['#######', '#.....#', '#..@..#', '#.....#', '#.....#', '#######'], [null, null, 'flask', null]);
  assert.equal(s.player.slots[DOWN]?.charges, 2);
  s.player.hp = 1;
  act(s, DOWN);
  act(s, UP);
  s.player.hp = 1;
  act(s, DOWN);
  assert.equal(s.player.slots[DOWN]?.charges, 0);
  assert.equal(s.player.hp, 3);
  assert.equal(newItem('flask', 1).charges, 3);
});

test('clearing a room leaves a heart; not while its monsters remain', () => {
  const s = scene(['#########', '#.......#', '#.S.....#', '#.@.....#', '#.......#', '#.....S.#', '#.......#', '#.......#', '#########'], ['sword', null, null, null]);
  const r1 = act(s, UP);
  assert.ok(!r1.events.some((e) => e.t === 'text' && e.text === '制圧！'), 'one monster still lives in the room');
  const other = unit(s, 'slime')!;
  s.units = s.units.filter((u) => u === other);
  s.player.x = other.x;
  s.player.y = other.y + 2;
  const r2 = act(s, UP);
  assert.equal(unit(s, 'slime'), undefined);
  assert.ok(r2.events.some((e) => e.t === 'text' && e.text === '制圧！'));
  assert.ok(s.pickups.some((p) => p.kind === 'heart'));
});

test('a room cleared by a fall still drops its heart on solid ground', () => {
  const s = scene(['########', '#......#', '#@S_...#', '#......#', '########'], [null, 'hammer', null, null]);
  act(s, RIGHT);
  const heart = s.pickups.find((p) => p.kind === 'heart');
  assert.ok(heart);
  assert.notEqual(s.map.tiles[heart!.y * s.map.w + heart!.x], T.Pit);
});

test('knight below a hero pinned to the wall: sidestep, it follows your footsteps and bares its flank', () => {
  // the reported situation: wall above, knight right below facing up
  const s = scene(['#########', '#...@...#', '#...K...#', '#.......#', '#.......#', '#########'], ['spear', 'axe', 'sword', 'hammer']);
  s.player.slots[UP]!.star = 1;
  s.player.slots[LEFT]!.star = 1;
  const k = unit(s, 'knight')!;
  k.facing = UP;
  // a frontal sword blow is still blocked
  const r0 = act(s, DOWN);
  assert.ok(r0.events.some((e) => e.t === 'block' && e.id === k.id));
  assert.equal(k.hp, 3);
  // step aside: the knight walks into the tile the hero left, shield the way it walked
  act(s, RIGHT);
  assert.deepEqual([k.x, k.y], [s.player.x - 1, s.player.y], 'knight is now on the left side');
  assert.equal(k.facing, UP, 'its shield faces the wall, not the hero');
  const hp = k.hp;
  act(s, LEFT);
  assert.ok(!s.units.includes(k) || k.hp < hp, 'the hammer lands on its flank');
});

test('a chaser below an unarmed side follows your footsteps, so you can swing it round to the sword', () => {
  // the play-test lock: wall above, slime right below, only the sword (up) can hit it
  const s = scene(['#########', '#...@...#', '#...S...#', '#.......#', '#.......#', '#########'], ['sword', null, 'flask', null]);
  const sl = unit(s, 'slime')!;
  s.player.hp = s.player.maxHp;
  act(s, LEFT);
  assert.deepEqual([sl.x, sl.y], [s.player.x + 1, s.player.y], 'it takes the tile the hero left (right side)');
  assert.equal(s.player.hp, s.player.maxHp, 'stepping away is still safe');
  act(s, DOWN);
  assert.deepEqual([sl.x, sl.y], [s.player.x, s.player.y - 1], 'stepping down brings it above the hero');
  assert.equal(s.player.hp, s.player.maxHp);
  act(s, UP);
  assert.ok(!s.units.includes(sl), 'the sword finishes it');
});
