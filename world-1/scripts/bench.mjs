/**
 * Стенд замеров: как каждый параметр влияет на то, что видно в мире.
 * Параметр проходит по точкам своего диапазона (остальные — по умолчанию), каждая
 * точка — на нескольких сидах; по ходу прогона снимаются наблюдаемые величины.
 * Мир хаотичен, поэтому отклик — среднее и разброс по сидам; разброс прогонов
 * по умолчанию — собственный шум мира, с ним и сравнивается отклик. Node 24+.
 *
 * npm run bench -- [--params sun,spotSize | all] [--seeds 1,2,3] [--steps 1000000]
 *                  [--every 25000] [--jobs 4] [--out bench-results/bench.json]
 * npm run bench -- --report bench-results/bench.json [--html bench-results/bench.html]
 *   — сводка по готовому файлу; с --html — ещё и страница с графиками отклика
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Точки диапазона: края — границы ползунков панели, середина — значение по умолчанию. */
export const SWEEPS = {
  sun: [0.1, 0.3, 1, 2, 3],
  lightDrift: [0, 0.25, 1, 2.5, 5],
  sunRhythm: [0, 0.2, 0.4, 0.65, 0.9],
  sunPeriod: [10_000, 40_000, 150_000, 400_000, 1_000_000],
  backgroundLevel: [0.02, 0.1, 0.2, 0.45, 0.9],
  illumination: [0.05, 0.15, 0.3, 0.5, 0.8],
  spotSize: [15, 30, 60, 120, 200],
  baseTemperature: [0.1, 0.3, 1, 2, 3],
  spotHeat: [0, 0.5, 1, 2, 3],
  viscosityZoneSize: [30, 60, 120, 200, 300],
  landShare: [0, 0.05, 0.15, 0.3, 0.45],
  mineralStock: [0.2, 0.5, 1, 2.5, 5],
  terrainSpeed: [0, 0.25, 1, 2.5, 5],
  quakeInterval: [50_000, 150_000, 400_000, 1_000_000, 2_000_000],
};

/** Наблюдаемые величины: ключ, подпись, единица. */
export const METRICS = [
  ['lit', 'Под пятнами', '%'],
  ['spots', 'Число пятен', ''],
  ['spotDiameter', 'Поперечник пятна (по площади)', 'мм'],
  ['lightTurnover', 'Смена освещённой площади', '%/ч'],
  ['sunNow', 'Сила солнца (среднее)', ''],
  ['sunSwing', 'Размах солнца за прогон', ''],
  ['flowMean', 'Течение, среднее', 'мм/с'],
  ['flowP95', 'Течение, p95', 'мм/с'],
  ['turbidity', 'Мутность (потеря света)', '%'],
  ['temperature', 'Температура (среднее)', 'усл.'],
  ['water', 'Вода', '%'],
  ['shallows', 'Отмель', '%'],
  ['land', 'Суша', '%'],
  ['glass', 'Голое стекло', '%'],
  ['shoreChange', 'Смена градаций местности', '%/сут'],
  ['medium', 'Минерал в среде', '%'],
  ['deposits', 'Минерал в залежах', '%'],
  ['depths', 'Минерал в недрах', '%'],
  ['eruptions', 'Извержения', '1/сут'],
  ['quakes', 'Толчки', '1/сут'],
  ['moves', 'Подвижки', '1/сут'],
  ['funnels', 'Воронки (среднее число)', ''],
];

const STEPS_PER_HOUR = 36_000, STEPS_PER_DAY = 864_000;

if (isMainThread) await main();
else await work();

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
  if (args.includes('--report')) {
    const data = JSON.parse(readFileSync(resolve(option('--report')), 'utf8'));
    if (args.includes('--html')) {
      const { renderHtml } = await import('./bench-html.mjs');
      writeFileSync(resolve(option('--html')), renderHtml(data, summarize(data), METRICS));
    } else report(data);
    return;
  }
  const list = option('--params', 'all');
  const params = list === 'all' ? Object.keys(SWEEPS) : list.split(',');
  for (const p of params) if (!SWEEPS[p]) throw Error(`Неизвестный параметр: ${p}. Есть: ${Object.keys(SWEEPS).join(', ')}`);
  const seeds = option('--seeds', '1,2,3').split(',').map(Number);
  const steps = Number(option('--steps', 1_000_000));
  const every = Number(option('--every', 25_000));
  const jobsCount = Number(option('--jobs', Math.max(1, Math.min(4, availableParallelism() - 1))));
  const out = resolve(option('--out', 'bench-results/bench.json'));

  // Прогоны по умолчанию общие для всех параметров — считаем их один раз.
  const defaults = await defaultValues();
  const runs = new Map();
  const key = (param, value, seed) => (value === defaults[param] ? `default/${seed}` : `${param}=${value}/${seed}`);
  for (const seed of seeds) runs.set(`default/${seed}`, { param: null, value: null, seed });
  for (const param of params) for (const value of SWEEPS[param]) for (const seed of seeds) {
    const k = key(param, value, seed);
    if (!runs.has(k)) runs.set(k, { param, value, seed });
  }
  const queue = [...runs.entries()];
  const results = {};
  const started = performance.now();
  let done = 0;
  console.error(`Прогонов: ${queue.length}, по ${steps} шагов, потоков: ${jobsCount}`);
  await Promise.all(Array.from({ length: jobsCount }, () => new Promise((finish, fail) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { steps, every } });
    const next = () => {
      const entry = queue.shift();
      if (!entry) { worker.terminate().then(() => finish()); return; }
      worker.postMessage(entry);
    };
    worker.on('message', ([k, result]) => {
      results[k] = result;
      done++;
      const eta = ((performance.now() - started) / done) * (runs.size - done) / 1000 / 60;
      console.error(`${done}/${runs.size} ${k} ${result.error ? `— ошибка: ${result.error}` : ''} (осталось ≈ ${eta.toFixed(0)} мин)`);
      save();
      next();
    });
    worker.on('error', fail);
    next();
  })));
  function save() {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ steps, every, seeds, params, defaults, sweeps: Object.fromEntries(params.map((p) => [p, SWEEPS[p]])), runs: results }, null, 1));
  }
  save();
  console.error(`Готово за ${((performance.now() - started) / 60000).toFixed(1)} мин: ${out}`);
  const data = JSON.parse(readFileSync(out, 'utf8'));
  const { renderHtml } = await import('./bench-html.mjs');
  writeFileSync(out.replace(/\.json$/, '') + '.html', renderHtml(data, summarize(data), METRICS));
  report(data);
}

async function defaultValues() {
  const { DEFAULT_PARAMS } = await import('../src/core/index.ts');
  return { ...DEFAULT_PARAMS, landShare: DEFAULT_PARAMS.viscosityShares.land };
}

/** Параметры прогона: доля суши меняется за счёт воды, отмель остаётся прежней. */
function overrides(core, param, value, seed) {
  if (param === null) return { seed };
  if (param === 'landShare') {
    const s = core.DEFAULT_PARAMS.viscosityShares;
    return { seed, viscosityShares: { land: value, shallows: s.shallows, water: 1 - value - s.shallows } };
  }
  return { seed, [param]: value };
}

async function work() {
  const core = await import('../src/core/index.ts');
  const { steps, every } = workerData;
  parentPort.on('message', ([k, { param, value, seed }]) => {
    let result;
    try { result = measure(core, core.createWorld(core.makeParams(overrides(core, param, value, seed))), steps, every); }
    catch (error) { result = { error: String(error.message ?? error).split('\n')[0] }; }
    parentPort.postMessage([k, result]);
  });
}

/** Один прогон: ряды наблюдаемых величин по снимкам каждые `every` шагов. */
function measure(core, w, steps, every) {
  const { width, height } = w.dish;
  const cell = 10, cols = Math.ceil(width / cell), rows = Math.ceil(height / cell);
  const inside = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const x = (i + 0.5) * cell, y = (j + 0.5) * cell;
    inside[j * cols + i] = core.insideDish(w.dish, x, y) && !core.isBlocked(w.partitions, x, y) ? 1 : 0;
  }
  let insideCount = 0;
  for (const v of inside) insideCount += v;
  const series = Object.fromEntries(METRICS.map(([k]) => [k, []]));
  const push = (k, v) => series[k].push(v);
  let prevLit = null, prevLevels = null, prev = { step: 0, eruptions: 0, quakes: 0, moves: 0 };
  const total = () => w.mineral.depths + core.mineralInMedium(w.mineral) + core.mineralInDeposits(w.terrain) + core.mineralInEruptions(w.mineral);
  const sunMin = [Infinity], sunMax = [-Infinity];
  const started = performance.now();

  for (let t = every; t <= steps; t += every) {
    while (w.step < t) {
      core.stepWorld(w);
      // Ритм солнца бывает короче окна снимков — ловим размах по каждой тысяче шагов.
      if (w.step % 1000 === 0) {
        const s = core.sunAt(w.light, w.step);
        sunMin[0] = Math.min(sunMin[0], s); sunMax[0] = Math.max(sunMax[0], s);
      }
    }
    const dt = w.step - prev.step;

    // Свет: доля под пятнами, пятна как связные области, смена освещённой площади.
    const intensity = core.rasterizeSpotIntensity(w.light, w.step, cols, rows, cell);
    const lit = new Uint8Array(cols * rows);
    let litCount = 0, tempSum = 0;
    for (let k = 0; k < lit.length; k++) {
      if (!inside[k]) continue;
      lit[k] = intensity[k] >= 0.5 ? 1 : 0;
      litCount += lit[k];
      tempSum += core.temperatureFromIntensity(w.params, intensity[k]);
    }
    push('lit', 100 * litCount / insideCount);
    push('temperature', tempSum / insideCount);
    const areas = components(lit, cols, rows).filter((a) => a >= 4);
    push('spots', areas.length);
    const areaSum = areas.reduce((s, a) => s + a, 0);
    push('spotDiameter', areaSum ? areas.reduce((s, a) => s + a * 2 * Math.sqrt(a * cell * cell / Math.PI), 0) / areaSum : 0);
    if (prevLit) {
      let flips = 0;
      for (let k = 0; k < lit.length; k++) flips += lit[k] ^ prevLit[k];
      push('lightTurnover', litCount ? 100 * (flips / 2 / litCount) * (STEPS_PER_HOUR / dt) : 0);
    }
    prevLit = lit;
    push('sunNow', core.sunAt(w.light, w.step));

    // Течения на сетке 40 × 30, как в сводке мира.
    const speeds = [];
    let clear = 0, clearN = 0;
    for (let j = 0; j < 30; j++) for (let i = 0; i < 40; i++) {
      const x = (i + 0.5) * width / 40, y = (j + 0.5) * height / 30;
      if (!core.insideDish(w.dish, x, y) || core.isBlocked(w.partitions, x, y)) continue;
      const [fx, fy] = core.flowAt(w, x, y);
      speeds.push(core.millimetresPerSecond(Math.hypot(fx, fy)));
      clear += core.transparencyAt(w.mineral, x, y); clearN++;
    }
    speeds.sort((a, b) => a - b);
    push('flowMean', speeds.reduce((s, v) => s + v, 0) / speeds.length);
    push('flowP95', speeds[Math.floor(speeds.length * 0.95)]);
    push('turbidity', 100 * (1 - clear / clearN));

    // Местность: доли градаций, голое стекло, смена градаций.
    const v = w.viscosity;
    push('water', 100 * v.shares.water); push('shallows', 100 * v.shares.shallows); push('land', 100 * v.shares.land);
    if (prevLevels) {
      let changed = 0, active = 0;
      for (let k = 0; k < v.levels.length; k++) if (v.active[k]) { active++; if (v.levels[k] !== prevLevels[k]) changed++; }
      push('shoreChange', 100 * (changed / active) * (STEPS_PER_DAY / dt));
    }
    prevLevels = v.levels.slice();
    const m = w.mineral, per = core.GROUND_PER_LEVEL * m.cell * m.cell;
    let free = 0, glass = 0;
    for (let k = 0; k < m.field.length; k++) {
      if (m.blocked[k]) continue;
      free++;
      if ((w.terrain.ground[k] + w.terrain.deposits[k]) / per < 0.02) glass++;
    }
    push('glass', 100 * glass / free);

    // Минерал и события.
    const all = total();
    push('medium', 100 * core.mineralInMedium(m) / all);
    push('deposits', 100 * core.mineralInDeposits(w.terrain) / all);
    push('depths', 100 * m.depths / all);
    push('eruptions', (m.eruptions - prev.eruptions) * STEPS_PER_DAY / dt);
    push('quakes', (w.terrain.nextQuake - prev.quakes) * STEPS_PER_DAY / dt);
    push('moves', (w.terrain.nextMove - prev.moves) * STEPS_PER_DAY / dt);
    push('funnels', m.funnels.length);
    prev = { step: w.step, eruptions: m.eruptions, quakes: w.terrain.nextQuake, moves: w.terrain.nextMove };
  }
  series.sunSwing = [sunMax[0] - sunMin[0]];
  return { series, seconds: (performance.now() - started) / 1000 };
}

/** Площади связных областей (4-связность), в клетках. */
function components(mask, cols, rows) {
  const seen = new Uint8Array(mask.length), stack = new Int32Array(mask.length), areas = [];
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || seen[s]) continue;
    let top = 0, area = 0;
    stack[top++] = s; seen[s] = 1;
    while (top) {
      const k = stack[--top], i = k % cols, j = (k - i) / cols;
      area++;
      for (const n of [i > 0 ? k - 1 : -1, i < cols - 1 ? k + 1 : -1, j > 0 ? k - cols : -1, j < rows - 1 ? k + cols : -1]) {
        if (n >= 0 && mask[n] && !seen[n]) { seen[n] = 1; stack[top++] = n; }
      }
    }
    areas.push(area);
  }
  return areas;
}

/**
 * Сводка: для каждого параметра и величины — среднее по второй половине прогона
 * (установившийся мир), затем среднее и разброс по сидам. «Отклик» — размах
 * средних по диапазону параметра в долях шума (разброса прогонов по умолчанию).
 */
export function summarize(data) {
  const late = (a) => { const s = a.slice(Math.floor(a.length / 2)); return s.reduce((x, y) => x + y, 0) / s.length; };
  const stats = (values) => {
    const ok = values.filter(Number.isFinite);
    if (!ok.length) return null;
    const mean = ok.reduce((s, v) => s + v, 0) / ok.length;
    const sd = Math.sqrt(ok.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, ok.length - 1));
    return { mean, sd, n: ok.length };
  };
  const point = (param, value) => {
    const isDefault = value === data.defaults[param];
    const runs = data.seeds.map((seed) => data.runs[isDefault ? `default/${seed}` : `${param}=${value}/${seed}`]).filter(Boolean);
    const errors = runs.filter((r) => r.error).map((r) => r.error);
    const metrics = Object.fromEntries(METRICS.map(([k]) => [k, stats(runs.filter((r) => !r.error).map((r) => late(r.series[k])))]));
    return { value, isDefault, errors, metrics };
  };
  const noise = point(null, null);
  const defaultsNoise = Object.fromEntries(METRICS.map(([k]) => [k, stats(data.seeds.map((seed) => data.runs[`default/${seed}`]).filter((r) => r && !r.error).map((r) => late(r.series[k])))]));
  return Object.fromEntries(data.params.map((param) => {
    const points = data.sweeps[param].map((value) => point(param, value));
    const response = Object.fromEntries(METRICS.map(([k]) => {
      const means = points.map((p) => p.metrics[k]?.mean).filter(Number.isFinite);
      const span = means.length ? Math.max(...means) - Math.min(...means) : 0;
      const sd = defaultsNoise[k]?.sd ?? 0;
      return [k, { span, noise: sd, ratio: sd > 1e-12 ? span / sd : span > 1e-9 ? Infinity : 0 }];
    }));
    return [param, { points, response }];
  }));
}

function report(data) {
  const summary = summarize(data);
  const f = (v) => (v === undefined || v === null || !Number.isFinite(v) ? '—' : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));
  for (const [param, { points, response }] of Object.entries(summary)) {
    console.log(`\n=== ${param} ===`);
    console.log(['величина'.padEnd(34), ...points.map((p) => `${p.value}${p.isDefault ? '*' : ''}`.padStart(14)), 'отклик/шум'.padStart(12)].join(''));
    for (const [k, label, unit] of METRICS) {
      const row = points.map((p) => (p.errors.length && !p.metrics[k] ? 'ошибка' : `${f(p.metrics[k]?.mean)}±${f(p.metrics[k]?.sd)}`).padStart(14));
      const r = response[k].ratio;
      console.log([`${label}${unit ? `, ${unit}` : ''}`.padEnd(34), ...row, (r === Infinity ? '∞' : f(r)).padStart(12)].join(''));
    }
    for (const p of points) if (p.errors.length) console.log(`  ${p.value}: ${p.errors[0]}`);
  }
}
