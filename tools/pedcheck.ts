// How often does each floor get its pedestals? (placement robustness check)
import { newRun } from '../src/core/engine.ts';
import { buildFloor } from '../src/core/floor.ts';
const counts: Record<number, number[]> = {};
for (let seed = 1; seed <= 300; seed++) {
  const s = newRun(seed * 31);
  for (let f = 1; f <= 9; f++) {
    if (f > 1) buildFloor(s, f);
    const n = s.props.filter((p) => p.kind === 'pedestal').length;
    (counts[f] ??= []).push(n);
  }
}
for (const [f, arr] of Object.entries(counts)) {
  const hist: Record<number, number> = {};
  for (const n of arr) hist[n] = (hist[n] ?? 0) + 1;
  console.log(`B${f}`, JSON.stringify(hist));
}
