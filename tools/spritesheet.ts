// Render the pixel-art sprite definitions to a PNG for visual review.
//   node tools/spritesheet.ts [nameFilter] [scale] [out.png]
// Each sprite is drawn on a dark dungeon-floor swatch; names are printed in grid order.
import zlib from 'node:zlib';
import fs from 'node:fs';
import { PAL } from '../src/render/palette.ts';
import { SPRITES } from '../src/render/sprites.ts';

const filter = process.argv[2] && process.argv[2] !== '*' ? new RegExp(process.argv[2]) : null;
const scale = Number(process.argv[3] ?? 6);
const out = process.argv[4] ?? 'sprites.png';

const names = Object.keys(SPRITES).filter((n) => !filter || filter.test(n));
const cols = Math.min(8, Math.max(1, names.length));
const rows = Math.ceil(names.length / cols);
const cell = 16 * scale + 8;
const W = cols * cell;
const H = rows * cell;
const img = Buffer.alloc(W * H * 4);

function hex(c: string): [number, number, number] {
  const v = parseInt(c.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
function put(x: number, y: number, rgb: [number, number, number]) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const o = (y * W + x) * 4;
  img[o] = rgb[0];
  img[o + 1] = rgb[1];
  img[o + 2] = rgb[2];
  img[o + 3] = 255;
}
// background
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) put(x, y, [13, 11, 23]);

names.forEach((name, k) => {
  const def = SPRITES[name];
  const cx = (k % cols) * cell + 4;
  const cy = Math.floor(k / cols) * cell + 4;
  // floor swatch (checker of two floor tones)
  for (let y = 0; y < 16 * scale; y++)
    for (let x = 0; x < 16 * scale; x++) {
      const chk = (Math.floor(x / (8 * scale)) + Math.floor(y / (8 * scale))) % 2;
      put(cx + x, cy + y, chk ? [58, 66, 64] : [66, 76, 72]);
    }
  def.rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === '.' || ch === ' ') continue;
      const col = PAL[ch];
      if (!col) {
        console.warn(`unknown palette key '${ch}' in ${name} row ${y}`);
        continue;
      }
      const rgb = hex(col);
      for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) put(cx + x * scale + sx, cy + y * scale + sy, rgb);
    }
  });
});

// --- minimal PNG encoder
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0;
  img.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(out, png);
console.log(`${out}: ${names.length} sprites (${cols}x${rows})`);
names.forEach((n, k) => console.log(`${String(k).padStart(2)}  r${Math.floor(k / cols)} c${k % cols}  ${n}`));
// sanity: every row is 16 wide, 16 rows
for (const n of names) {
  const d = SPRITES[n];
  if (d.rows.length !== 16 || d.rows.some((r) => r.length !== 16)) console.warn(`size problem in ${n}`);
}
