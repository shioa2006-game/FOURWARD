// Print generated floors as ASCII for eyeballing:  node tools/mapdump.ts [seed] [arena]
import { generateFloor, T, validateFloor } from '../src/core/dungeon.ts';

const seed = Number(process.argv[2] ?? 1);
const arena = process.argv[3] === 'arena';
const map = generateFloor(seed, {
  w: 44, h: 30, minLeaf: 9, maxDepth: 4, extraLoops: 2, arena,
  features: { pillars: 0.5, pits: 0.3, spikes: 0.3, grass: 0.3, turnstile: 0.1 },
});
const ch: Record<number, string> = {
  [T.Wall]: '#', [T.Floor]: '.', [T.Pillar]: 'O', [T.Pit]: ' ', [T.Spikes]: '^', [T.Grass]: '"',
  [T.Lava]: '~', [T.Turnstile]: '@', [T.Water]: '=', [T.Stairs]: '>',
};
const doors = new Set(map.doors);
let out = '';
for (let y = 0; y < map.h; y++) {
  let row = '';
  for (let x = 0; x < map.w; x++) {
    const i = y * map.w + x;
    if (i === map.start) row += 'S';
    else if (arena && i === map.stairs) row += 'X';
    else if (doors.has(i)) row += '+';
    else if (map.tiles[i] === T.Floor && map.room[i] < 0) row += ',';
    else row += ch[map.tiles[i]] ?? '?';
  }
  out += row + '\n';
}
console.log(out);
console.log('rooms', map.rooms.length, 'attempts', map.attempts, JSON.stringify(validateFloor(map)));
