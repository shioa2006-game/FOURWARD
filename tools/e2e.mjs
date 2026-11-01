// End-to-end test in a real browser (Chrome via playwright-core) against the built
// single-file game, opened from file:// exactly like a player double-clicking it.
//   node tools/build.mjs && node tools/e2e.mjs [outDir]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.argv[2] ?? path.join(root, 'test-artifacts');
fs.mkdirSync(outDir, { recursive: true });
const url = pathToFileURL(path.join(root, 'dist/index.html')).href;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      /* try next */
    }
  }
  return chromium.launch({ headless: true });
}

const browser = await launch();

async function session(label, contextOpts) {
  const ctx = await browser.newContext(contextOpts);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(url);
  await page.waitForFunction(() => !!window.__FOURWARD__);
  return { ctx, page, errors, label };
}

// ------------------------------------------------------------------ desktop
{
  const { ctx, page, errors } = await session('desktop', { viewport: { width: 1280, height: 800 } });
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => !!window.__FOURWARD__);
  check('desktop: title screen shown', (await page.evaluate(() => window.__FOURWARD__.screen())) === 'title');
  await page.screenshot({ path: path.join(outDir, 'desktop-title.png') });

  await page.click('.kit:not(.locked)');
  await sleep(300);
  check('desktop: run starts from the kit button', (await page.evaluate(() => window.__FOURWARD__.screen())) === 'game');

  const before = await page.evaluate(() => ({ ...window.__FOURWARD__.state().player, turn: window.__FOURWARD__.state().turn }));
  for (const key of ['ArrowLeft', 'KeyA', 'ArrowDown', 'KeyS', 'ArrowRight', 'KeyD', 'ArrowUp', 'KeyW']) {
    await page.keyboard.press(key);
    await sleep(60);
  }
  const after = await page.evaluate(() => ({ turn: window.__FOURWARD__.state().turn }));
  check('desktop: arrow keys and WASD both act', after.turn - before.turn >= 6, `turns ${before.turn} -> ${after.turn}`);
  await page.screenshot({ path: path.join(outDir, 'desktop-play.png') });

  // one rewind per floor
  const tA = await page.evaluate(() => window.__FOURWARD__.state().turn);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('KeyZ');
  const tB = await page.evaluate(() => ({ turn: window.__FOURWARD__.state().turn, left: window.__FOURWARD__.state().rewinds }));
  check('desktop: Z rewinds the last action once per floor', tB.turn === tA && tB.left === 0, JSON.stringify({ tA, ...tB }));

  // walk to the stairs (god mode so random monsters cannot end the test)
  await page.evaluate(() => { window.__FOURWARD__.godMode(); window.__FOURWARD__.clearMonsters(); });
  let arranged = false;
  for (let i = 0; i < 400; i++) {
    const scr = await page.evaluate(() => window.__FOURWARD__.screen());
    if (scr === 'arrange') {
      arranged = true;
      break;
    }
    const d = await page.evaluate(() => window.__FOURWARD__.stepToStairs());
    if (d < 0) break;
    await page.evaluate((dd) => window.__FOURWARD__.press(dd), d);
  }
  if (!arranged) {
    const dbg = await page.evaluate(() => {
      const s = window.__FOURWARD__.state();
      const w = s.map.w;
      return {
        seed: s.seed, floor: s.floor, turn: s.turn, status: s.status, screen: window.__FOURWARD__.screen(),
        pos: [s.player.x, s.player.y], stairs: [s.map.stairs % w, Math.floor(s.map.stairs / w)], stairsOpen: s.stairsOpen,
        next: window.__FOURWARD__.stepToStairs(), slots: s.player.slots.map((x) => x && x.id),
        near: s.units.filter((u) => Math.abs(u.x - s.player.x) + Math.abs(u.y - s.player.y) <= 3).map((u) => `${u.kind}@${u.x},${u.y}`),
      };
    });
    console.log('STAIRS-DEBUG', JSON.stringify(dbg));
  }
  check('desktop: reaching the stairs opens the between-floor screen', arranged);
  await sleep(450);
  await page.screenshot({ path: path.join(outDir, 'desktop-arrange.png') });
  if (arranged) {
    const slotsBefore = await page.evaluate(() => window.__FOURWARD__.state().player.slots.map((s) => (s ? s.id : null)));
    await page.click('.ar-slot.ar0');
    await page.click('.ar-slot.ar2');
    const slotsAfter = await page.evaluate(() => window.__FOURWARD__.state().player.slots.map((s) => (s ? s.id : null)));
    check('desktop: tapping two slots swaps them', slotsBefore[0] === slotsAfter[2] && slotsBefore[2] === slotsAfter[0], JSON.stringify(slotsAfter));
    await page.keyboard.press('Enter');
    await sleep(200);
    const f = await page.evaluate(() => ({ floor: window.__FOURWARD__.state().floor, scr: window.__FOURWARD__.screen() }));
    check('desktop: Enter departs to B2', f.floor === 2 && f.scr === 'game', JSON.stringify(f));
  }

  // save & continue
  await page.reload();
  await page.waitForFunction(() => !!window.__FOURWARD__);
  const hasContinue = await page.locator('[data-act="continue"]').count();
  check('desktop: reload offers つづきから', hasContinue === 1);
  if (hasContinue) {
    await page.click('[data-act="continue"]');
    await sleep(200);
    const fl = await page.evaluate(() => window.__FOURWARD__.state().floor);
    check('desktop: continue restores the floor', fl === 2, `floor ${fl}`);
  }

  // pause menu + guide
  await page.keyboard.press('Escape');
  await sleep(100);
  check('desktop: Esc opens the menu', (await page.evaluate(() => window.__FOURWARD__.screen())) === 'menu');
  await page.click('[data-act="guide"]');
  await sleep(450);
  await page.screenshot({ path: path.join(outDir, 'desktop-guide.png') });
  check('desktop: guide opens', (await page.evaluate(() => window.__FOURWARD__.screen())) === 'guide');
  await page.click('[data-act="back"]');
  await page.click('[data-act="resume"]');

  // game over + retry from checkpoint
  await page.evaluate(() => window.__FOURWARD__.forceDeath());
  await sleep(1400);
  check('desktop: death shows the game-over screen', (await page.evaluate(() => window.__FOURWARD__.screen())) === 'over');
  await page.screenshot({ path: path.join(outDir, 'desktop-gameover.png') });
  const retry = await page.locator('[data-act="retry"]').count();
  check('desktop: game over offers a checkpoint retry', retry === 1);
  if (retry) {
    await page.click('[data-act="retry"]');
    await sleep(200);
    const st = await page.evaluate(() => ({ status: window.__FOURWARD__.state().status, hp: window.__FOURWARD__.state().player.hp, max: window.__FOURWARD__.state().player.maxHp }));
    check('desktop: retry restarts alive with full hearts', st.status === 'play' && st.hp === st.max, JSON.stringify(st));
  }

  // victory screen
  await page.evaluate(() => window.__FOURWARD__.forceWin());
  await sleep(1200);
  check('desktop: victory screen', (await page.evaluate(() => window.__FOURWARD__.screen())) === 'win');
  await page.screenshot({ path: path.join(outDir, 'desktop-victory.png') });

  check('desktop: no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// ------------------------------------------------------------------ phone (touch)
for (const vp of [
  { name: 'phone-portrait', viewport: { width: 390, height: 844 } },
  { name: 'phone-small', viewport: { width: 360, height: 640 } },
  { name: 'phone-landscape', viewport: { width: 844, height: 390 } },
]) {
  const { ctx, page, errors } = await session(vp.name, { viewport: vp.viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => !!window.__FOURWARD__);
  await page.screenshot({ path: path.join(outDir, `${vp.name}-title.png`) });
  const kit = page.locator('.kit:not(.locked)').first();
  await kit.tap();
  await sleep(300);
  check(`${vp.name}: tap starts a run`, (await page.evaluate(() => window.__FOURWARD__.screen())) === 'game');

  // the cross pad must be fully on screen and finger-sized
  const pads = await page.evaluate(() =>
    [...document.querySelectorAll('.pb')].map((b) => {
      const r = b.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }),
  );
  const W = vp.viewport.width;
  const H = vp.viewport.height;
  const inside = pads.every((r) => r.x >= 0 && r.y >= 0 && r.x + r.w <= W + 0.5 && r.y + r.h <= H + 0.5);
  const big = pads.every((r) => r.w >= 44 && r.h >= 44);
  check(`${vp.name}: pad buttons on screen`, inside, JSON.stringify(pads.map((r) => [Math.round(r.x), Math.round(r.y)])));
  check(`${vp.name}: pad buttons >= 44px`, big, JSON.stringify(pads.map((r) => Math.round(r.w))));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1 || document.documentElement.scrollHeight > window.innerHeight + 1);
  check(`${vp.name}: no page overflow`, !overflow);

  const t0 = await page.evaluate(() => window.__FOURWARD__.state().turn);
  for (const sel of ['.pb3', '.pb2', '.pb1', '.pb0', '.pb3']) {
    await page.locator(sel).tap();
    await sleep(80);
  }
  const t1 = await page.evaluate(() => window.__FOURWARD__.state().turn);
  check(`${vp.name}: tapping the cross pad acts`, t1 - t0 >= 4, `turns ${t0} -> ${t1}`);

  // swipe on the map
  const tSw = await page.evaluate(() => window.__FOURWARD__.state().turn);
  const cx = W / 2;
  const cy = H * 0.3;
  await page.evaluate(
    ([x, y]) => {
      const c = document.getElementById('game');
      const fire = (type, px, py) => c.dispatchEvent(new PointerEvent(type, { clientX: px, clientY: py, pointerId: 7, pointerType: 'touch', bubbles: true }));
      fire('pointerdown', x, y);
      fire('pointerup', x + 70, y);
    },
    [cx, cy],
  );
  await sleep(100);
  const tSw2 = await page.evaluate(() => window.__FOURWARD__.state().turn);
  check(`${vp.name}: swipe on the map acts`, tSw2 > tSw, `turns ${tSw} -> ${tSw2}`);
  await page.screenshot({ path: path.join(outDir, `${vp.name}-play.png`) });

  // HUD must not collide with the pad
  const hud = await page.evaluate(() => {
    const t = document.querySelector('.hud-top').getBoundingClientRect();
    const p = document.querySelector('.pad').getBoundingClientRect();
    return { topBottom: t.bottom, padTop: p.top, padLeft: p.left };
  });
  check(`${vp.name}: HUD and pad do not overlap`, hud.topBottom < hud.padTop || hud.padLeft > W * 0.5, JSON.stringify(hud));
  check(`${vp.name}: no console errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
fs.writeFileSync(path.join(outDir, 'e2e-results.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
