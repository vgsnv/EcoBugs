/**
 * Свет и то, что от него зависит, на долгом прогоне: доля чашки под
 * пятнами, течения (средняя и 95-й процентиль скорости, вихрь — средний
 * модуль ротора), минерал по состояниям, извержения, местность. Для сравнения
 * до и после правок карты света. Node 24+.
 * npm run light -- [--steps 1000000] [--every 50000] [--seeds 1,2,3]
 */
import {
  createWorld, makeParams, stepWorld, flowAt, dishCoverage, isBlocked, insideDish, GROUND_PER_LEVEL,
  mineralInMedium, mineralInDeposits, mineralInEruptions, millimetresPerSecond,
} from '../src/core/index.ts';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
};
const steps = Number(option('--steps', 1_000_000));
const every = Number(option('--every', 50_000));
const seeds = option('--seeds', '1,2,3').split(',').map(Number);
const scenario = (seed) => (seed === 1 ? { seed } : seed === 2 ? { seed, shape: 'circle', aspectRatio: 1 } : { seed, shape: 'rectangle', aspectRatio: 16 / 9 });
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const fmt = (v, d = 2) => v.toFixed(d);

for (const seed of seeds) {
  const w = createWorld(makeParams(scenario(seed)));
  const { width, height } = w.dish;
  const lit = [], speedMean = [], speedP95 = [], curl = [], medium = [], deposits = [], depths = [];
  const total = () => w.mineral.depths + mineralInMedium(w.mineral) + mineralInDeposits(w.terrain) + mineralInEruptions(w.mineral);
  const start = performance.now();
  for (let t = every; t <= steps; t += every) {
    while (w.step < t) stepWorld(w);
    lit.push(dishCoverage(w.light, width, height, w.step));
    // Течения на сетке 40 × 30 (без стен и вне чашки); ротор — по соседним узлам.
    const nx = 40, ny = 30, hx = width / nx, hy = height / ny;
    const vx = new Float64Array(nx * ny).fill(NaN), vy = new Float64Array(nx * ny).fill(NaN);
    const speeds = [];
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const x = (i + 0.5) * hx, y = (j + 0.5) * hy;
      if (!insideDish(w.dish, x, y) || isBlocked(w.partitions, x, y)) continue;
      const [fx, fy] = flowAt(w, x, y);
      vx[j * nx + i] = fx; vy[j * nx + i] = fy;
      speeds.push(millimetresPerSecond(Math.hypot(fx, fy)));
    }
    speeds.sort((a, b) => a - b);
    speedMean.push(mean(speeds));
    speedP95.push(speeds[Math.floor(speeds.length * 0.95)]);
    const curls = [];
    for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
      const k = j * nx + i;
      const c = (vy[k + 1] - vy[k - 1]) / (2 * hx) - (vx[k + nx] - vx[k - nx]) / (2 * hy);
      if (Number.isFinite(c)) curls.push(Math.abs(c));
    }
    curl.push(mean(curls) * 1e4);
    const all = total();
    medium.push(mineralInMedium(w.mineral) / all);
    deposits.push(mineralInDeposits(w.terrain) / all);
    depths.push(w.mineral.depths / all);
  }
  const m = w.mineral, per = GROUND_PER_LEVEL * m.cell * m.cell;
  let free = 0, land = 0, shallow = 0, glass = 0;
  for (let k = 0; k < m.field.length; k++) {
    if (m.blocked[k]) continue;
    free++;
    const L = (w.terrain.ground[k] + w.terrain.deposits[k]) / per;
    if (L < 0.02) glass++;
    if (L >= 1.5) land++; else if (L >= 0.8) shallow++;
  }
  const range = (a) => `${fmt(mean(a))} [${fmt(Math.min(...a))}…${fmt(Math.max(...a))}]`;
  console.log(`\nсид ${seed}, ${steps / 1e6} млн шагов, ${((performance.now() - start) / 1000).toFixed(0)} с:`);
  console.log(`  под пятнами      ${range(lit.map((v) => v * 100))} %`);
  console.log(`  течение, мм/с    среднее ${range(speedMean)}  p95 ${range(speedP95)}`);
  console.log(`  вихрь (×1e-4)    ${range(curl)}`);
  console.log(`  минерал, %       среда ${range(medium.map((v) => v * 100))}  залежи ${range(deposits.map((v) => v * 100))}  недра ${range(depths.map((v) => v * 100))}`);
  console.log(`  извержений ${m.eruptions}, воронок сейчас ${m.funnels.length}`);
  console.log(`  в конце: суша ${fmt(100 * land / free, 1)}%, отмель ${fmt(100 * shallow / free, 1)}%, стекло ${fmt(100 * glass / free, 1)}%`);
}
