// Synthesized sound effects (WebAudio, no asset files).
// Every sound is a tiny recipe of oscillators / filtered noise with short envelopes.

type Wave = OscillatorType;

let ac: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;
let muted = false;
let lastPlay: Record<string, number> = {};

export function initAudio(): void {
  if (ac) {
    if (ac.state === 'suspended') void ac.resume();
    return;
  }
  const Ctor: typeof AudioContext | undefined =
    (globalThis as any).AudioContext || (globalThis as any).webkitAudioContext;
  if (!Ctor) return;
  try {
    ac = new Ctor();
  } catch {
    ac = null;
    return;
  }
  master = ac.createGain();
  master.gain.value = muted ? 0 : 0.42;
  const comp = ac.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 4;
  master.connect(comp);
  comp.connect(ac.destination);
  const len = Math.floor(ac.sampleRate * 1.0);
  noiseBuf = ac.createBuffer(1, len, ac.sampleRate);
  const data = noiseBuf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
}

/** Shared context + a quieter bus for the music module. */
let musicGain: GainNode | null = null;
export function audioCtx(): AudioContext | null {
  return ac;
}
export function musicBus(): GainNode | null {
  if (!ac || !master) return null;
  if (!musicGain) {
    musicGain = ac.createGain();
    musicGain.gain.value = 0.55;
    musicGain.connect(master);
  }
  return musicGain;
}

export function setMuted(m: boolean): void {
  muted = m;
  if (master && ac) master.gain.setTargetAtTime(m ? 0 : 0.42, ac.currentTime, 0.02);
}
export function isMuted(): boolean {
  return muted;
}

function now(): number {
  return ac ? ac.currentTime : 0;
}

interface ToneOpt {
  type?: Wave;
  vol?: number;
  attack?: number;
  slideTo?: number;
  delay?: number;
  lowpass?: number;
}

function tone(freq: number, dur: number, o: ToneOpt = {}): void {
  if (!ac || !master) return;
  const t0 = now() + (o.delay ?? 0);
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(freq, t0);
  if (o.slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.slideTo), t0 + dur);
  const vol = o.vol ?? 0.3;
  const a = o.attack ?? 0.004;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  let node: AudioNode = osc;
  if (o.lowpass) {
    const f = ac.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = o.lowpass;
    osc.connect(f);
    node = f;
  }
  node.connect(g);
  g.connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

interface NoiseOpt {
  vol?: number;
  type?: BiquadFilterType;
  freq?: number;
  freqTo?: number;
  q?: number;
  delay?: number;
  attack?: number;
}

function noise(dur: number, o: NoiseOpt = {}): void {
  if (!ac || !master || !noiseBuf) return;
  const t0 = now() + (o.delay ?? 0);
  const src = ac.createBufferSource();
  src.buffer = noiseBuf;
  src.playbackRate.value = 0.8 + Math.random() * 0.4;
  const f = ac.createBiquadFilter();
  f.type = o.type ?? 'bandpass';
  f.frequency.setValueAtTime(o.freq ?? 1200, t0);
  if (o.freqTo) f.frequency.exponentialRampToValueAtTime(o.freqTo, t0 + dur);
  f.Q.value = o.q ?? 1;
  const g = ac.createGain();
  const vol = o.vol ?? 0.3;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + (o.attack ?? 0.004));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f);
  f.connect(g);
  g.connect(master);
  src.start(t0, Math.random() * 0.5);
  src.stop(t0 + dur + 0.02);
}

const jitter = (f: number, amt = 0.06) => f * (1 + (Math.random() * 2 - 1) * amt);

const RECIPES: Record<string, () => void> = {
  step: () => noise(0.05, { freq: jitter(500, 0.2), q: 2, vol: 0.12, type: 'lowpass' }),
  bump: () => {
    tone(90, 0.08, { type: 'square', vol: 0.08, lowpass: 400 });
  },
  swing: () => noise(0.12, { freq: 2600, freqTo: 900, q: 1.5, vol: 0.18 }),
  thrust: () => noise(0.1, { freq: 3500, freqTo: 1600, q: 3, vol: 0.16 }),
  hit: () => {
    noise(0.09, { freq: jitter(900), q: 1, vol: 0.35, type: 'lowpass' });
    tone(jitter(160), 0.1, { type: 'square', vol: 0.12, slideTo: 70, lowpass: 900 });
  },
  heavy: () => {
    noise(0.2, { freq: 500, freqTo: 120, q: 0.8, vol: 0.45, type: 'lowpass' });
    tone(110, 0.22, { type: 'sine', vol: 0.4, slideTo: 40 });
  },
  kill: () => {
    noise(0.12, { freq: 1500, freqTo: 300, q: 1, vol: 0.25 });
    tone(jitter(660, 0.03), 0.09, { type: 'triangle', vol: 0.16, delay: 0.03 });
    tone(jitter(990, 0.03), 0.14, { type: 'triangle', vol: 0.14, delay: 0.08 });
  },
  hurt: () => {
    tone(220, 0.22, { type: 'sawtooth', vol: 0.16, slideTo: 90, lowpass: 1200 });
    noise(0.15, { freq: 400, q: 0.7, vol: 0.25, type: 'lowpass' });
  },
  block: () => {
    tone(jitter(1400), 0.16, { type: 'square', vol: 0.07, lowpass: 3000 });
    tone(jitter(2100), 0.12, { type: 'triangle', vol: 0.08 });
    noise(0.05, { freq: 4000, q: 2, vol: 0.12 });
  },
  heal: () => {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.18, { type: 'sine', vol: 0.12, delay: i * 0.05 }));
  },
  coin: () => {
    tone(1318, 0.07, { type: 'square', vol: 0.06, lowpass: 5000 });
    tone(1760, 0.16, { type: 'square', vol: 0.06, delay: 0.06, lowpass: 5000 });
  },
  equip: () => {
    tone(392, 0.08, { type: 'triangle', vol: 0.15 });
    tone(587, 0.08, { type: 'triangle', vol: 0.15, delay: 0.06 });
    tone(784, 0.16, { type: 'triangle', vol: 0.15, delay: 0.12 });
  },
  upgrade: () => {
    [523, 784, 1047, 1568].forEach((f, i) => tone(f, 0.22, { type: 'triangle', vol: 0.13, delay: i * 0.07 }));
    noise(0.4, { freq: 6000, q: 4, vol: 0.05, delay: 0.1 });
  },
  arrow: () => {
    noise(0.14, { freq: 5000, freqTo: 2000, q: 6, vol: 0.12 });
    tone(880, 0.05, { type: 'triangle', vol: 0.06 });
  },
  fire: () => {
    noise(0.35, { freq: 300, freqTo: 1600, q: 0.8, vol: 0.3, type: 'lowpass', attack: 0.04 });
  },
  boom: () => {
    noise(0.55, { freq: 900, freqTo: 60, q: 0.7, vol: 0.6, type: 'lowpass' });
    tone(70, 0.5, { type: 'sine', vol: 0.5, slideTo: 30 });
  },
  frost: () => {
    [1568, 2093, 2637].forEach((f, i) => tone(f, 0.25, { type: 'sine', vol: 0.06, delay: i * 0.04 }));
    noise(0.25, { freq: 7000, q: 5, vol: 0.06 });
  },
  zap: () => {
    for (let i = 0; i < 4; i++) tone(jitter(300 + i * 220, 0.2), 0.05, { type: 'sawtooth', vol: 0.07, delay: i * 0.025, lowpass: 4000 });
    noise(0.18, { freq: 3000, q: 1, vol: 0.18 });
  },
  dash: () => noise(0.18, { freq: 800, freqTo: 3500, q: 1.2, vol: 0.18 }),
  hook: () => {
    tone(600, 0.12, { type: 'square', vol: 0.05, slideTo: 1400, lowpass: 3000 });
    noise(0.1, { freq: 3000, q: 3, vol: 0.08 });
  },
  rotate: () => {
    tone(330, 0.12, { type: 'triangle', vol: 0.14, slideTo: 660 });
    tone(495, 0.14, { type: 'triangle', vol: 0.1, delay: 0.07, slideTo: 990 });
  },
  fuse: () => noise(0.25, { freq: 6000, q: 8, vol: 0.06 }),
  wake: () => tone(880, 0.08, { type: 'square', vol: 0.05, lowpass: 2500 }),
  stairs: () => {
    [784, 659, 523, 392, 330].forEach((f, i) => tone(f, 0.2, { type: 'triangle', vol: 0.12, delay: i * 0.07 }));
  },
  door: () => tone(180, 0.15, { type: 'sine', vol: 0.15, slideTo: 260 }),
  click: () => tone(1200, 0.03, { type: 'square', vol: 0.04, lowpass: 4000 }),
  deny: () => {
    tone(200, 0.07, { type: 'square', vol: 0.06, lowpass: 900 });
    tone(150, 0.1, { type: 'square', vol: 0.06, delay: 0.07, lowpass: 900 });
  },
  death: () => {
    [392, 330, 262, 196].forEach((f, i) => tone(f, 0.35, { type: 'triangle', vol: 0.14, delay: i * 0.16 }));
  },
  victory: () => {
    [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) =>
      tone(f, 0.3, { type: 'triangle', vol: 0.13, delay: i * 0.11 }),
    );
  },
  boss: () => {
    tone(55, 1.2, { type: 'sawtooth', vol: 0.18, lowpass: 300 });
    tone(82, 1.2, { type: 'sawtooth', vol: 0.12, lowpass: 300, delay: 0.1 });
  },
  shatter: () => {
    noise(0.3, { freq: 5000, freqTo: 1500, q: 2, vol: 0.2 });
    [2637, 3136].forEach((f, i) => tone(f, 0.1, { type: 'triangle', vol: 0.05, delay: i * 0.03 }));
  },
  fall: () => tone(600, 0.45, { type: 'sine', vol: 0.15, slideTo: 80 }),
};

export function sfx(name: string): void {
  if (!ac || muted) return;
  const recipe = RECIPES[name];
  if (!recipe) return;
  // de-duplicate the same sound in the same frame
  const t = performance.now();
  if (lastPlay[name] && t - lastPlay[name] < 30) return;
  lastPlay[name] = t;
  try {
    recipe();
  } catch {
    /* audio is best-effort */
  }
}

export function resetAudioThrottle(): void {
  lastPlay = {};
}
