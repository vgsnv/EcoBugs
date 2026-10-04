/**
 * Долгий прогон местности без браузера: как меняются доли воды, отмели, суши
 * и голого стекла, сколько островов, сколько грунта (меняет только тектоника),
 * сохраняется ли минерал, и сколько стоит перенос грунта. Node 24+.
 * npm run landscape -- [--steps 2000000] [--every 200000] [--seeds 1,3]
 */
import {
  createWorld, makeParams, stepWorld, setPhaseHook, GROUND_PER_LEVEL, MINERAL_PERIOD,
  mineralInMedium, mineralInDeposits, mineralInEruptions, groundTotal,
} from '../src/core/index.ts';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
};
const steps = Number(option('--steps', 2_000_000));
const every = Number(option('--every', 200_000));
const seeds = option('--seeds', '1,3').split(',').map(Number);
const scenario = (seed) => (seed === 1 ? { seed } : seed === 2 ? { seed, shape: 'circle', aspectRatio: 1 } : { seed, shape: 'rectangle', aspectRatio: 16 / 9 });

/** Острова — связные куски суши (уровень ≥ 1,5) не меньше 4 клеток. */
function islands(level, blocked, cols, rows) {
  const seen = new Uint8Array(level.length);
  let count = 0;
  const stack = [];
  for (let k0 = 0; k0 < level.length; k0++) {
    if (seen[k0] || blocked[k0] || level[k0] < 1.5) continue;
    seen[k0] = 1; stack.push(k0);
    let size = 0;
    while (stack.length) {
      const k = stack.pop(); size++;
      const i = k % cols, j = (k - i) / cols;
      for (const n of [i > 0 ? k - 1 : -1, i < cols - 1 ? k + 1 : -1, j > 0 ? k - cols : -1, j < rows - 1 ? k + cols : -1]) {
        if (n >= 0 && !seen[n] && !blocked[n] && level[n] >= 1.5) { seen[n] = 1; stack.push(n); }
      }
    }
    if (size >= 4) count++;
  }
  return count;
}

let sandMs = 0, allMs = 0, current = null, since = 0;
setPhaseHook((name) => {
  const now = performance.now();
  if (current === 'перенос и осыпание грунта') sandMs += now - since;
  current = name; since = now;
});

for (const seed of seeds) {
  const w = createWorld(makeParams(scenario(seed)));
  const m = w.mineral;
  const per = GROUND_PER_LEVEL * m.cell * m.cell;
  const mineral = () => m.depths + mineralInMedium(m) + mineralInDeposits(w.terrain) + mineralInEruptions(m);
  const mineral0 = mineral(), ground0 = groundTotal(w.terrain);
  console.log(`\nсид ${seed}:`);
  console.log('    шаг   вода  отмель  суша  стекло  островов   грунт   минерал (погрешность)');
  for (let t = 0; t <= steps; t += every) {
    const start = performance.now();
    while (w.step < t) stepWorld(w);
    allMs += performance.now() - start;
    let water = 0, shallow = 0, land = 0, glass = 0, free = 0;
    const level = new Float32Array(m.field.length);
    for (let k = 0; k < level.length; k++) {
      if (m.blocked[k]) continue;
      free++;
      const L = level[k] = (w.terrain.ground[k] + w.terrain.deposits[k]) / per;
      if (L < 0.02) glass++;
      if (L < 0.8) water++; else if (L < 1.5) shallow++; else land++;
    }
    const pct = (x) => `${(100 * x / free).toFixed(0).padStart(4)}%`;
    console.log(`${String(t / 1000).padStart(6)}k ${pct(water)} ${pct(shallow)} ${pct(land)} ${pct(glass)}  ${String(islands(level, m.blocked, m.cols, m.rows)).padStart(6)}  ${(100 * groundTotal(w.terrain) / ground0).toFixed(1).padStart(6)}%  ${((mineral() - mineral0) / mineral0).toExponential(1)}`);
  }
}
const updates = seeds.length * steps / MINERAL_PERIOD;
console.log(`\nПеренос и осыпание грунта: ${(sandMs / updates).toFixed(3)} мс на обновление минерала, ${(100 * sandMs / allMs).toFixed(1)}% времени физики.`);
