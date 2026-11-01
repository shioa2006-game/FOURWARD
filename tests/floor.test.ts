import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newRun } from '../src/core/engine.ts';
import { buildFloor } from '../src/core/floor.ts';
import { FLOORS, LAST_FLOOR } from '../src/core/content.ts';
import { T, isWalkable, isFlyable } from '../src/core/dungeon.ts';
import type { GameState } from '../src/core/types.ts';

function reach(s: GameState): Int32Array {
  const { w, h, tiles } = s.map;
  const blocked = new Set(s.props.map((p) => p.y * w + p.x));
  const dist = new Int32Array(w * h).fill(-1);
  const from = s.player.y * w + s.player.x;
  dist[from] = 0;
  const q = [from];
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
      if (dist[ni] >= 0 || blocked.has(ni) || !isWalkable(tiles[ni])) continue;
      dist[ni] = dist[i] + 1;
      q.push(ni);
    }
  }
  return dist;
}

test('every floor of every run is populated validly', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const s = newRun(seed * 13 + 1);
    for (let f = 1; f <= LAST_FLOOR; f++) {
      if (f > 1) buildFloor(s, f);
      const spec = FLOORS[f - 1];
      const w = s.map.w;
      const tag = `seed ${seed} B${f}`;
      const d = reach(s);
      assert.ok(d[s.map.stairs] > 0, `${tag}: stairs unreachable with props in place`);
      for (const pr of s.props) {
        const sides = [
          [0, -1],
          [1, 0],
          [0, 1],
          [-1, 0],
        ].filter(([dx, dy]) => d[(pr.y + dy) * w + pr.x + dx] >= 0).length;
        assert.ok(sides >= 1, `${tag}: ${pr.kind} cannot be touched`);
        if (pr.kind === 'pedestal' && pr.item) assert.ok(sides >= 3, `${tag}: pedestal reachable from only ${sides} sides`);
        if (pr.lockRoom >= 0) assert.ok(s.units.some((u) => u.home === pr.lockRoom), `${tag}: cage with no guards`);
      }
      const occupied = new Set<number>();
      for (const u of s.units) {
        const i = u.y * w + u.x;
        assert.ok(!occupied.has(i), `${tag}: stacked units`);
        occupied.add(i);
        const t = s.map.tiles[i];
        assert.ok(u.kind === 'bat' ? isFlyable(t) : isWalkable(t), `${tag}: ${u.kind} on tile ${t}`);
        assert.ok(t !== T.Stairs, `${tag}: unit on stairs`);
        assert.ok(!s.props.some((p) => p.x === u.x && p.y === u.y), `${tag}: unit on a prop`);
        assert.ok(Math.abs(u.x - s.player.x) + Math.abs(u.y - s.player.y) >= 4 || u.boss, `${tag}: ${u.kind} spawned next to the hero`);
      }
      if (spec.boss) {
        const b = s.units.find((u) => u.kind === spec.boss);
        assert.ok(b, `${tag}: guardian missing`);
        assert.equal(s.map.tiles[b!.y * w + b!.x], T.Floor, `${tag}: guardian not on plain floor`);
        assert.equal(s.stairsOpen, false);
        assert.ok(s.props.some((p) => p.kind === 'pedestal' && p.item && ['sword', 'hammer', 'axe', 'spear'].includes(p.item.id)), `${tag}: no weapon pedestal on a guardian floor`);
      }
      assert.ok(s.units.length >= (spec.boss ? 1 : 2), `${tag}: too few monsters (${s.units.length})`);
    }
  }
});
