// Keyboard + swipe/tap input. The on-screen cross pad lives in hud.ts and calls the
// same `onDir` handler. Holding a direction auto-repeats only while it is safe
// (the controller decides via `canRepeat`).

import type { Dir } from '../core/geom.ts';

export interface InputHandlers {
  onDir: (d: Dir, repeat: boolean) => void;
  onTapTile: (clientX: number, clientY: number) => void;
  onKey: (key: string) => void;
  canRepeat: () => boolean;
  onPreview: (d: Dir) => void;
}

const KEYMAP: Record<string, Dir> = {
  ArrowUp: 0,
  KeyW: 0,
  Numpad8: 0,
  ArrowRight: 1,
  KeyD: 1,
  Numpad6: 1,
  ArrowDown: 2,
  KeyS: 2,
  Numpad2: 2,
  ArrowLeft: 3,
  KeyA: 3,
  Numpad4: 3,
};

export function installInput(canvas: HTMLCanvasElement, h: InputHandlers): void {
  let lastRepeat = 0;
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const d = KEYMAP[e.code];
      if (d !== undefined) {
        e.preventDefault();
        if (document.activeElement instanceof HTMLButtonElement) document.activeElement.blur();
        if (e.shiftKey) { if (!e.repeat) h.onPreview(d); return; }
        if (e.repeat) {
          const t = performance.now();
          if (!h.canRepeat() || t - lastRepeat < 110) return;
          lastRepeat = t;
          h.onDir(d, true);
        } else {
          lastRepeat = performance.now();
          h.onDir(d, false);
        }
        return;
      }
      if (e.repeat) return;
      // Let focused buttons receive their native Enter/Space click, once.
      if ((e.code === 'Enter' || e.code === 'Space') && e.target instanceof HTMLButtonElement) return;
      if (['Enter', 'Space', 'Backspace'].includes(e.code)) e.preventDefault();
      h.onKey(e.code);
    },
    { passive: false },
  );

  // swipe / tap on the map
  let sx = 0;
  let sy = 0;
  let st = 0;
  let active = -1;
  canvas.addEventListener('pointerdown', (e) => {
    active = e.pointerId;
    sx = e.clientX;
    sy = e.clientY;
    st = performance.now();
  });
  canvas.addEventListener('pointerup', (e) => {
    if (e.pointerId !== active) return;
    active = -1;
    const dx = e.clientX - sx;
    const dy = e.clientY - sy;
    const dist = Math.hypot(dx, dy);
    const dt = performance.now() - st;
    if (dist > 28 && dt < 600) {
      const d: Dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : dy > 0 ? 2 : 0;
      h.onDir(d, false);
    } else if (dist < 12) {
      h.onTapTile(e.clientX, e.clientY);
    }
  });
  canvas.addEventListener('pointercancel', () => (active = -1));
  // stop iOS double-tap zoom / long-press menus on the game surface
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('gesturestart', (e) => e.preventDefault() as unknown as void);
}
