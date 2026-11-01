import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateFloor, validateFloor, bfs, isWalkable, T, type GenOptions } from '../src/core/dungeon.ts';

const CONFIGS: Record<string, GenOptions> = {
  small: { w: 40, h: 28, minLeaf: 9, maxDepth: 4, extraLoops: 1, features: { pillars: 0.5, spikes: 0.2 } },
  pits: { w: 44, h: 30, minLeaf: 9, maxDepth: 4, extraLoops: 2, features: { pillars: 0.5, pits: 0.5, grass: 0.4, spikes: 0.3 } },
  lava: { w: 46, h: 30, minLeaf: 9, maxDepth: 4, extraLoops: 2, features: { pillars: 0.4, lava: 0.6, spikes: 0.4 } },
  arena: { w: 44, h: 30, minLeaf: 9, maxDepth: 4, extraLoops: 1, arena: true, features: { pillars: 0.5, pits: 0.3 } },
};

for (const [name, opt] of Object.entries(CONFIGS)) {
  test(`BSP floors are valid and connected (${name})`, () => {
    let fallbacks = 0;
    let totalRooms = 0;
    const N = 600;
    for (let seed = 1; seed <= N; seed++) {
      const map = generateFloor(seed * 7919, opt);
      const v = validateFloor(map);
      assert.ok(v.ok, `seed ${seed}: ${v.problems.join(', ')}`);
      if (map.attempts < 0) fallbacks++;
      totalRooms += map.rooms.length;
      // stairs reachable from start (the core guarantee)
      const d = bfs(map.tiles, map.w, map.h, map.start, isWalkable);
      assert.ok(d[map.stairs] > 0, `seed ${seed}: stairs unreachable`);
      // start and stairs are in different rooms and reasonably far apart
      assert.notEqual(map.startRoom, map.stairsRoom);
      // every walkable tile has at least one walkable neighbour (no isolated cells)
      for (let i = 0; i < map.w * map.h; i++) {
        if (!isWalkable(map.tiles[i])) continue;
        const nb = [i - 1, i + 1, i - map.w, i + map.w].filter((n) => isWalkable(map.tiles[n]));
        assert.ok(nb.length > 0, `seed ${seed}: isolated tile ${i}`);
      }
      // stairs tile type: arena floors keep it hidden
      if (opt.arena) assert.equal(map.tiles[map.stairs], T.Floor);
      else assert.equal(map.tiles[map.stairs], T.Stairs);
    }
    assert.ok(fallbacks / N < 0.01, `too many fallbacks: ${fallbacks}`);
    assert.ok(totalRooms / N >= 4, `too few rooms on average: ${totalRooms / N}`);
  });
}

test('generation is deterministic for a seed', () => {
  const a = generateFloor(12345, CONFIGS.pits);
  const b = generateFloor(12345, CONFIGS.pits);
  assert.deepEqual(a.tiles, b.tiles);
  assert.equal(a.start, b.start);
  assert.equal(a.stairs, b.stairs);
});
