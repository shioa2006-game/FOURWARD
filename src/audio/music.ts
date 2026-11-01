// Small generative ambient score: a slow pad chord loop per zone, sparse plucks, a
// bass note per bar, and a soft pulse that fades in while monsters are awake.

import { audioCtx, musicBus } from './sfx.ts';

const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

// chord roots (MIDI) and qualities per zone: crypt (A minor), grotto (D minor), forge (E phrygian)
const PROGRESSIONS: [number, number[]][][] = [
  [
    [57, [0, 3, 7]],
    [53, [0, 4, 7]],
    [48, [0, 4, 7]],
    [55, [0, 4, 7]],
  ],
  [
    [50, [0, 3, 7]],
    [46, [0, 4, 7]],
    [53, [0, 4, 7]],
    [48, [0, 4, 7]],
  ],
  [
    [52, [0, 3, 7]],
    [53, [0, 4, 7]],
    [52, [0, 3, 7]],
    [50, [0, 4, 7]],
  ],
];

const BEAT = 0.9; // seconds (≈ 66 bpm)

class Music {
  zone = 0;
  intensity = 0; // 0 calm .. 1 combat
  boss = false;
  running = false;
  nextBeat = 0;
  beat = 0;
  timer = 0;
  seed = 1;

  rand(): number {
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    return this.seed / 0x7fffffff;
  }

  start(): void {
    const ac = audioCtx();
    if (!ac || this.running) return;
    this.running = true;
    this.nextBeat = ac.currentTime + 0.2;
    this.timer = window.setInterval(() => this.tick(), 200);
  }

  stop(): void {
    this.running = false;
    clearInterval(this.timer);
  }

  setScene(zone: number, boss: boolean): void {
    this.zone = Math.max(0, Math.min(PROGRESSIONS.length - 1, zone));
    this.boss = boss;
  }

  tick(): void {
    const ac = audioCtx();
    const bus = musicBus();
    if (!ac || !bus || !this.running) return;
    while (this.nextBeat < ac.currentTime + 0.8) {
      this.playBeat(ac, bus, this.nextBeat, this.beat);
      this.beat++;
      this.nextBeat += this.boss ? BEAT * 0.75 : BEAT;
    }
  }

  voice(ac: AudioContext, bus: AudioNode, t: number, freq: number, dur: number, type: OscillatorType, vol: number, attack: number, lp: number): void {
    const o = ac.createOscillator();
    const g = ac.createGain();
    const f = ac.createBiquadFilter();
    o.type = type;
    o.frequency.value = freq;
    f.type = 'lowpass';
    f.frequency.value = lp;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f);
    f.connect(g);
    g.connect(bus);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  playBeat(ac: AudioContext, bus: AudioNode, t: number, beat: number): void {
    const prog = PROGRESSIONS[this.zone];
    const bar = Math.floor(beat / 4) % prog.length;
    const [root, q] = prog[bar];
    const inBar = beat % 4;
    if (inBar === 0) {
      // pad chord (two slightly detuned voices per note)
      for (const iv of q) {
        const f = midi(root + iv);
        this.voice(ac, bus, t, f, BEAT * 4.2, 'triangle', 0.018, 1.2, 900);
        this.voice(ac, bus, t, f * 1.004, BEAT * 4.2, 'sine', 0.014, 1.4, 1200);
      }
      // bass
      this.voice(ac, bus, t, midi(root - 12), BEAT * 3, 'sine', 0.05, 0.08, 400);
    }
    // sparse plucks from the chord, an octave up
    if (this.rand() < 0.45) {
      const iv = q[Math.floor(this.rand() * q.length)] + (this.rand() < 0.3 ? 12 : 0);
      this.voice(ac, bus, t + (this.rand() < 0.5 ? 0 : BEAT / 2), midi(root + 12 + iv), 1.1, 'sine', 0.022, 0.01, 2400);
    }
    // combat pulse
    if (this.intensity > 0.05) {
      const v = 0.05 * this.intensity;
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.frequency.setValueAtTime(110, t);
      o.frequency.exponentialRampToValueAtTime(45, t + 0.18);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(v, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      o.connect(g);
      g.connect(bus);
      o.start(t);
      o.stop(t + 0.3);
      if (this.boss && inBar % 2 === 1) this.voice(ac, bus, t, midi(root - 24 + 12), 0.25, 'sawtooth', 0.02 * this.intensity, 0.01, 500);
    }
  }
}

export const music = new Music();
