// Curated screenshots of representative scenes (for the test report / visual review).
//   node tools/build.mjs && node tools/shots.mjs [outDir]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.argv[2] ?? path.join(root, 'test-artifacts');
fs.mkdirSync(outDir, { recursive: true });
const url = pathToFileURL(path.join(root, 'dist/index.html')).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser;
for (const channel of ['chrome', 'msedge']) {
  try {
    browser = await chromium.launch({ channel, headless: true });
    break;
  } catch {
    /* next */
  }
}
browser ??= await chromium.launch({ headless: true });

const SCENES = [
  { name: 'zone1-slimes', floor: 2, seed: 4, kind: 'slime' },
  { name: 'zone1-archer', floor: 2, seed: 9, kind: 'archer' },
  { name: 'zone2-knight', floor: 4, seed: 1, kind: 'knight' },
  { name: 'zone2-goblin', floor: 5, seed: 3, kind: 'goblin' },
  { name: 'zone3-golem', floor: 7, seed: 5, kind: 'golem' },
  { name: 'zone3-sentinel', floor: 8, seed: 6, kind: 'sentinel' },
  { name: 'boss-slime', floor: 3, seed: 2, kind: 'boss_slime' },
  { name: 'boss-lancer', floor: 6, seed: 2, kind: 'boss_lancer' },
  { name: 'boss-warden', floor: 9, seed: 3, kind: 'boss_warden' },
];

for (const vp of [
  { tag: 'pc', viewport: { width: 1280, height: 800 }, mobile: false },
  { tag: 'phone', viewport: { width: 390, height: 844 }, mobile: true },
]) {
  const ctx = await browser.newContext({ viewport: vp.viewport, hasTouch: vp.mobile, isMobile: vp.mobile, deviceScaleFactor: vp.mobile ? 2 : 1 });
  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForFunction(() => !!window.__FOURWARD__);
  for (const sc of SCENES) {
    await page.evaluate(({ floor, seed }) => window.__FOURWARD__.startAt(floor, seed), sc);
    await sleep(2400); // let the floor banner fade
    const ok = await page.evaluate((k) => window.__FOURWARD__.peek(k), sc.kind);
    await sleep(500);
    const file = path.join(outDir, `scene-${vp.tag}-${sc.name}.png`);
    await page.screenshot({ path: file });
    console.log(`${ok ? 'ok ' : 'n/a'} ${path.basename(file)}`);
  }
  await ctx.close();
}
await browser.close();
