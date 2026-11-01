// One shared palette for all pixel art: every sprite uses these single-character keys,
// which keeps the whole game visually coherent.
export const PAL: Record<string, string> = {
  '.': '', // transparent
  k: '#140f1f', // outline (near black, violet tint)
  K: '#2b2238', // dark shade
  w: '#f7f3ea', // white
  g: '#b7bcc7', // light grey / steel
  G: '#727a8a', // grey
  H: '#454b5c', // dark grey
  r: '#ef4a5a', // red
  R: '#9c2742', // dark red
  o: '#f7973c', // orange
  O: '#b8562a', // dark orange / rust
  y: '#ffd35c', // yellow / gold
  Y: '#c48a23', // dark gold
  l: '#a6e05a', // lime
  e: '#4caf50', // green
  E: '#246b45', // dark green
  c: '#6fe2f0', // cyan
  C: '#2fa3c4', // teal
  b: '#4c86f0', // blue
  B: '#2c3f96', // navy
  p: '#c27bf0', // purple
  P: '#7340b0', // dark purple
  m: '#ff8fc6', // pink
  M: '#c2477e', // magenta
  n: '#b07a4f', // brown
  N: '#6e452d', // dark brown
  s: '#f6c9a0', // skin
  S: '#c98e6b', // skin shade
  t: '#d9f3ff', // ice highlight
  u: '#8fb8ff', // pale blue
  v: '#5a3d7a', // violet shadow
  z: '#ffe9a8', // pale yellow highlight
};
