/**
 * Снос (спецификация, раздел «Снос»): поток среды от света к тени. Где
 * светлее среднего по своему отсеку, среда выталкивается, где темнее —
 * уходит; сумма — ноль. Среда пропускает поток тем хуже, чем выше её
 * сопротивление движению (проводимость = 1 ÷ множитель градации), перегородки
 * не пропускают вовсе. Поток сохраняется: в узком месте течение быстрее,
 * потоки складываются, острова обтекаются. Дрейфующие пятна увлекают среду за
 * собой — отсюда круговороты. Смещение за шаг — плотность потока.
 *
 * Расчёт: давление p из баланса потоков в каждой клетке — Σ проводимость
 * грани × (p − p соседа + увлечение вдоль грани) = источник. Решается
 * сопряжёнными градиентами с многосеточным ускорением (см. solve), всегда с
 * нуля — поэтому снос — функция номера шага. Поле
 * пересчитывается раз в DRIFT_PERIOD шагов, между пересчётами — плавный
 * переход.
 */
import { finishCalculation, type Calculation } from './task.ts';
import { DRIFT_CELL, DRIFT_DRAG, DRIFT_MAX, DRIFT_PERIOD, DRIFT_SPEED, LIGHT_DRIFT_SPEED } from './constants.ts';
import { lightBackground, rasterizeSpotIntensityTask, sunAt, type LightMap } from './light.ts';
import type { WorldParams } from './params.ts';
import { cellInsideDish } from './dish.ts';
import { isBlocked, type PartitionLayout } from './partitions.ts';
import { multiplierForLevel, smoothLevelAt, type ViscosityMap } from './viscosity.ts';

/** Течения в один момент: вектор сноса в центре каждой клетки. */
export interface DriftField {
  readonly cols: number;
  readonly rows: number;
  readonly cell: number;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
}

interface Sources {
  readonly params: WorldParams;
  readonly light: LightMap;
  readonly viscosity: ViscosityMap;
  readonly partitions: PartitionLayout;
}

/**
 * Уровень сетки для решения: проводимость граней (вправо, вниз и те же грани
 * со стороны соседа), сумма граней клетки и обратная к ней (0 — клетка вне
 * потока: преграда или без соседей). Векторы на уровне — с рамкой в строку
 * сверху и снизу (клетка k хранится в k + cols), чтобы соседи читались без
 * проверок: у краёв и преград проводимость грани — 0.
 */
export interface Level {
  readonly cols: number;
  readonly rows: number;
  readonly east: Float64Array;
  readonly south: Float64Array;
  readonly west: Float64Array;
  readonly north: Float64Array;
  readonly diag: Float64Array;
  readonly inverse: Float64Array;
}

/** Уровни не меняются до пересборки местности; источники меняются со светом. */
const fineLevels = new WeakMap<Float64Array, Level>();
const coarseLevels = new WeakMap<Level, Level>();

/** Неизменное на сетке течений: преграды, проводимость, отсек каждой клетки (−1 — преграда). */
interface Ground {
  readonly blocked: Uint8Array;
  readonly cond: Float64Array;
  readonly region: Int32Array;
  readonly regions: number;
}

function* groundOf(world: Sources, cols: number, rows: number, cell: number): Calculation<Ground> {
  const n = cols * rows;
  const blocked = new Uint8Array(n);
  const cond = new Float64Array(n);
  for (let j = 0; j < rows; j++) {
    if ((j & 3) === 0) yield;
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      const x = (i + 0.5) * cell, y = (j + 0.5) * cell;
      blocked[k] = !cellInsideDish(world.partitions.dish, i * cell, j * cell, cell) || isBlocked(world.partitions, x, y) ? 1 : 0;
      cond[k] = blocked[k] ? 0 : 1 / multiplierForLevel(smoothLevelAt(world.viscosity, x, y));
    }
  }
  // Отсеки — связные части без преград: в каждом свой баланс света и тени.
  const region = new Int32Array(n).fill(-1);
  let regions = 0;
  const stack: number[] = [];
  for (let k0 = 0; k0 < n; k0++) {
    if ((k0 & 2047) === 0) yield;
    if (blocked[k0] || region[k0] >= 0) continue;
    region[k0] = regions;
    stack.push(k0);
    let visited = 0;
    while (stack.length > 0) {
      if ((visited++ & 2047) === 0) yield;
      const k = stack.pop()!;
      const i = k % cols, j = (k - i) / cols;
      for (const m of [i > 0 ? k - 1 : -1, i < cols - 1 ? k + 1 : -1, j > 0 ? k - cols : -1, j < rows - 1 ? k + cols : -1]) {
        if (m >= 0 && !blocked[m] && region[m] < 0) { region[m] = regions; stack.push(m); }
      }
    }
    regions++;
  }
  return { blocked, cond, region, regions };
}

/** Проводимость грани между клетками — среднее гармоническое (0, если хоть одна — преграда). */
const face = (a: number, b: number) => (a > 0 && b > 0 ? (2 * a * b) / (a + b) : 0);

function levelFromFaces(cols: number, rows: number, east: Float64Array, south: Float64Array): Level {
  const n = cols * rows;
  const west = new Float64Array(n), north = new Float64Array(n), diag = new Float64Array(n), inverse = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    west[k] = k % cols > 0 ? east[k - 1] : 0;
    north[k] = k >= cols ? south[k - cols] : 0;
    diag[k] = west[k] + east[k] + north[k] + south[k];
    inverse[k] = diag[k] > 0 ? 1 / diag[k] : 0;
  }
  return { cols, rows, east, south, west, north, diag, inverse };
}

function levelOf(cols: number, rows: number, cond: Float64Array): Level {
  let level = fineLevels.get(cond);
  if (!level) {
    const east = new Float64Array(cols * rows), south = new Float64Array(cols * rows);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i;
        if (i < cols - 1) east[k] = face(cond[k], cond[k + 1]);
        if (j < rows - 1) south[k] = face(cond[k], cond[k + cols]);
      }
    }
    level = levelFromFaces(cols, rows, east, south);
    fineLevels.set(cond, level);
  }
  return level;
}

/**
 * Вдвое грубее — по граням, а не по клеткам: грань грубой клетки — половина
 * суммы двух тонких граней на её границе. Перегородка, закрывающая границу,
 * остаётся закрытой и на грубой сетке (усреднение клеток делало её проницаемой).
 */
function coarsen(l: Level): Level {
  let c = coarseLevels.get(l);
  if (!c) {
    const cols = Math.ceil(l.cols / 2), rows = Math.ceil(l.rows / 2);
    const east = new Float64Array(cols * rows), south = new Float64Array(cols * rows);
    for (let j = 0; j < l.rows; j++) {
      for (let i = 0; i < l.cols; i++) {
        const k = j * l.cols + i, K = (j >> 1) * cols + (i >> 1);
        if ((i & 1) && (i >> 1) < cols - 1) east[K] += l.east[k] / 2;
        if ((j & 1) && (j >> 1) < rows - 1) south[K] += l.south[k] / 2;
      }
    }
    c = levelFromFaces(cols, rows, east, south);
    coarseLevels.set(l, c);
  }
  return c;
}

const vector = (l: Level) => new Float64Array((l.rows + 2) * l.cols);

/** y = A·x: для каждой клетки Σ проводимость грани × (x − x соседа). */
function apply(l: Level, x: Float64Array, y: Float64Array): void {
  const { cols, east, south, west, north, diag } = l;
  for (let k = 0, n = cols * l.rows; k < n; k++) {
    const q = k + cols;
    y[q] = diag[k] === 0 ? 0 : diag[k] * x[q] - west[k] * x[q - 1] - east[k] * x[q + 1] - north[k] * x[q - cols] - south[k] * x[q + cols];
  }
}

/** Проход Гаусса — Зейделя по A·x = b: вперёд или назад (пара проходов симметрична — нужно для сопряжённых градиентов). */
function sweep(l: Level, x: Float64Array, b: Float64Array, forward: boolean): void {
  const { cols, east, south, west, north, inverse } = l, n = cols * l.rows;
  for (let s = 0; s < n; s++) {
    const k = forward ? s : n - 1 - s;
    if (inverse[k] === 0) continue;
    const q = k + cols;
    x[q] = (b[q] + west[k] * x[q - 1] + east[k] * x[q + 1] + north[k] * x[q - cols] + south[k] * x[q + cols]) * inverse[k];
  }
}

/** Рабочие векторы уровня: приближение, правая часть, невязка. */
interface Work { readonly x: Float64Array; readonly b: Float64Array; readonly r: Float64Array }

/**
 * Многосеточный V-цикл: сгладить, невязку — на вдвое более грубую сетку
 * (сумма по четырём клеткам), решить там так же, поправку — обратно
 * (каждой из четырёх клеток), сгладить в обратном порядке. На самой грубой
 * сетке — просто много проходов. Начинает с нуля: результат зависит только от b.
 */
function* vcycle(levels: readonly Level[], work: readonly Work[], d: number): Calculation {
  const l = levels[d], { x, b, r } = work[d];
  x.fill(0);
  if (d === levels.length - 1) {
    for (let s = 0; s < DRIFT_COARSEST_SWEEPS; s++) { sweep(l, x, b, true); sweep(l, x, b, false); }
    return;
  }
  sweep(l, x, b, true);
  yield;
  apply(l, x, r);
  const c = levels[d + 1], cb = work[d + 1].b;
  cb.fill(0);
  for (let j = 0; j < l.rows; j++) {
    for (let i = 0; i < l.cols; i++) {
      const q = (j + 1) * l.cols + i;
      cb[((j >> 1) + 1) * c.cols + (i >> 1)] += b[q] - r[q];
    }
  }
  yield* vcycle(levels, work, d + 1);
  const cx = work[d + 1].x;
  for (let j = 0; j < l.rows; j++) {
    for (let i = 0; i < l.cols; i++) {
      if (l.inverse[j * l.cols + i] !== 0) x[(j + 1) * l.cols + i] += cx[((j >> 1) + 1) * c.cols + (i >> 1)];
    }
  }
  sweep(l, x, b, false);
  yield;
}

const dot = (a: Float64Array, b: Float64Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

/**
 * Давление p из A·p = источник: сопряжённые градиенты, каждый шаг ускорен
 * V-циклом. Останавливается, когда невязка падает до DRIFT_TOLERANCE от
 * начальной. Всегда с нуля — поэтому снос — функция номера шага. Давление — с рамкой.
 */
function* solve(fine: Level, source: Float64Array): Calculation<Float64Array> {
  const levels = [fine];
  while (levels[levels.length - 1].cols > DRIFT_COARSEST) levels.push(coarsen(levels[levels.length - 1]));
  const work = levels.map((l) => ({ x: vector(l), b: vector(l), r: vector(l) }));
  const { cols } = fine, n = cols * fine.rows;
  const p = vector(fine), r = vector(fine), d = vector(fine), q = vector(fine);
  for (let k = 0; k < n; k++) if (fine.inverse[k] !== 0) r[k + cols] = source[k];
  const stop = DRIFT_TOLERANCE * Math.sqrt(dot(r, r));
  const precondition = function* (): Calculation<Float64Array> {
    work[0].b.set(r);
    yield* vcycle(levels, work, 0);
    return work[0].x;
  };
  let z = yield* precondition();
  d.set(z);
  let rz = dot(r, z);
  let it = 0;
  for (; it < DRIFT_MAX_ITERATIONS && Math.sqrt(dot(r, r)) > stop; it++) {
    apply(fine, d, q);
    const a = rz / dot(d, q);
    for (let i = 0; i < p.length; i++) { p[i] += a * d[i]; r[i] -= a * q[i]; }
    z = yield* precondition();
    const next = dot(r, z), beta = next / rz;
    rz = next;
    for (let i = 0; i < d.length; i++) d[i] = z[i] + beta * d[i];
    yield;
  }
  lastIterations = it;
  return p.subarray(cols, cols + n);
}

/**
 * Самая грубая сетка — не шире стольких клеток, проходов на ней; допуск по
 * невязке (скорость течений отличается от точного решения меньше чем на 0,5%)
 * и предел шагов на случай, если сходимость не наступит.
 */
export const DRIFT_COARSEST = 26;
export const DRIFT_COARSEST_SWEEPS = 40;
export const DRIFT_TOLERANCE = 0.01;
export const DRIFT_MAX_ITERATIONS = 60;
let lastIterations = 0;

/** Система давления течений: уровень с гранями, источник и увлечение на гранях. */
export interface DriftSystem {
  readonly cols: number;
  readonly rows: number;
  readonly cell: number;
  readonly fine: Level;
  readonly source: Float64Array;
  readonly fEast: Float64Array;
  readonly fSouth: Float64Array;
  readonly response: number;
}

/** Для замеров: система давления в шаге t (null — солнца нет). */
export function driftSystem(world: Sources, t: number): DriftSystem | null {
  return finishCalculation((function* () {
    const cols = Math.ceil(world.partitions.dish.width / DRIFT_CELL), rows = Math.ceil(world.partitions.dish.height / DRIFT_CELL);
    return yield* driftSystemTask(world, t, yield* groundOf(world, cols, rows, DRIFT_CELL));
  })());
}

/** Для замеров: давление решателем ядра и число шагов сопряжённых градиентов. */
export function solveDriftSystem(sys: DriftSystem): { p: Float64Array; iterations: number } {
  const p = finishCalculation(solve(sys.fine, sys.source));
  return { p: Float64Array.from(p), iterations: lastIterations };
}

/** Для замеров: уровни многосеточного решателя, от тонкого к самому грубому. */
export function driftLevels(fine: Level): Level[] {
  const levels = [fine];
  while (levels[levels.length - 1].cols > DRIFT_COARSEST) levels.push(coarsen(levels[levels.length - 1]));
  return levels;
}

/** Течения в шаге t. */
export function computeDriftField(world: Sources, t: number, ground?: Ground): DriftField {
  return finishCalculation(computeDriftFieldTask(world, t, ground));
}

function* computeDriftFieldTask(world: Sources, t: number, ground?: Ground): Calculation<DriftField> {
  const cell = DRIFT_CELL, cols = Math.ceil(world.partitions.dish.width / cell), rows = Math.ceil(world.partitions.dish.height / cell), n = cols * rows;
  ground ??= yield* groundOf(world, cols, rows, cell);
  const vx = new Float32Array(n);
  const vy = new Float32Array(n);
  const sys = yield* driftSystemTask(world, t, ground);
  if (!sys) return { cols, rows, cell, vx, vy };
  const { fine, source, fEast, fSouth, response } = sys;
  const { east, south } = fine;
  const { blocked } = ground;
  const p = yield* solve(fine, source);
  // Плотность потока в клетке — среднее потоков через её грани (давление + увлечение).
  for (let j = 0; j < rows; j++) {
    if ((j & 3) === 0) yield;
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      if (blocked[k]) continue;
      const fw = i > 0 ? east[k - 1] * (p[k - 1] - p[k] + fEast[k - 1]) : 0;
      const fe = i < cols - 1 ? east[k] * (p[k] - p[k + 1] + fEast[k]) : 0;
      const fn = j > 0 ? south[k - cols] * (p[k - cols] - p[k] + fSouth[k - cols]) : 0;
      const fs = j < rows - 1 ? south[k] * (p[k] - p[k + cols] + fSouth[k]) : 0;
      let x = response * (fw + fe) / 2, y = response * (fn + fs) / 2;
      const v = Math.hypot(x, y);
      if (v > DRIFT_MAX) { x *= DRIFT_MAX / v; y *= DRIFT_MAX / v; }
      vx[k] = x;
      vy[k] = y;
    }
  }
  return { cols, rows, cell, vx, vy };
}

/** Источник давления и увлечение на гранях в шаге t; null — солнца нет, течений нет. */
function* driftSystemTask(world: Sources, t: number, ground: Ground): Calculation<DriftSystem | null> {
  const cell = DRIFT_CELL, cols = Math.ceil(world.partitions.dish.width / cell), rows = Math.ceil(world.partitions.dish.height / cell), n = cols * rows;
  const sun = sunAt(world.light, t);
  // Отклик среды на свет — для знатоков: множитель к обычному.
  const response = DRIFT_SPEED * world.params.driftResponse;
  if (sun <= 0) return null;
  // Свет места: фон + пятна; источник — отклонение от среднего по отсеку.
  const bg = lightBackground(world.light);
  const spotV = { vx: new Float32Array(n), vy: new Float32Array(n) };
  const intensity = yield* rasterizeSpotIntensityTask(world.light, t, cols, rows, cell, undefined, spotV);
  const { blocked, cond, region, regions } = ground;
  const sum = new Float64Array(regions), count = new Float64Array(regions);
  const light = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    if ((k & 2047) === 0) yield;
    if (blocked[k]) continue;
    light[k] = sun * (bg + (1 - bg) * intensity[k]);
    sum[region[k]] += light[k];
    count[region[k]]++;
  }
  // Увлечение: движущиеся пятна тянут среду за собой — каждое по своему
  // направлению, тем сильнее, чем ярче место и быстрее пятно (на гранях — среднее).
  const fx = new Float64Array(n), fy = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    if ((k & 2047) === 0) yield;
    if (blocked[k]) continue;
    const pull = DRIFT_DRAG * sun * intensity[k] / LIGHT_DRIFT_SPEED;
    fx[k] = pull * spotV.vx[k];
    fy[k] = pull * spotV.vy[k];
  }
  const fine = levelOf(cols, rows, cond);
  const { east, south } = fine;
  const fEast = new Float64Array(n), fSouth = new Float64Array(n);
  for (let j = 0; j < rows; j++) {
    if ((j & 3) === 0) yield;
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      if (east[k]) fEast[k] = (fx[k] + fx[k + 1]) / 2;
      if (south[k]) fSouth[k] = (fy[k] + fy[k + cols]) / 2;
    }
  }
  // Источник: отклонение света от среднего по отсеку, минус то, что
  // увлечение само выносит из клетки, — баланс потоков сохраняется.
  const source = new Float64Array(n);
  for (let j = 0; j < rows; j++) {
    if ((j & 3) === 0) yield;
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      if (blocked[k]) continue;
      let s = light[k] - sum[region[k]] / count[region[k]];
      s -= east[k] * fEast[k] + south[k] * fSouth[k];
      if (i > 0) s += east[k - 1] * fEast[k - 1];
      if (j > 0) s += south[k - cols] * fSouth[k - cols];
      source[k] = s;
    }
  }
  return { cols, rows, cell, fine, source, fEast, fSouth, response };
}

/**
 * Снос во времени: поля в узлах через DRIFT_PERIOD шагов, между ними —
 * линейный переход. Держит два последних узла.
 */
export class Drift {
  private readonly world: Sources;
  private readonly cache = new Map<number, DriftField>();
  private ground: Ground | null = null;

  constructor(world: Sources) {
    this.world = world;
  }

  private node(k: number): DriftField {
    const cached = this.cache.get(k);
    if (cached) return cached;
    return finishCalculation(this.nodeTask(k));
  }

  private *nodeTask(k: number): Calculation<DriftField> {
    let f = this.cache.get(k);
    if (!f) {
      this.ground ??= yield* groundOf(this.world, Math.ceil(this.world.partitions.dish.width / DRIFT_CELL), Math.ceil(this.world.partitions.dish.height / DRIFT_CELL), DRIFT_CELL);
      f = yield* computeDriftFieldTask(this.world, k * DRIFT_PERIOD, this.ground);
      this.cache.set(k, f);
      while (this.cache.size > 3) this.cache.delete(this.cache.keys().next().value!);
    }
    return f;
  }

  /** Местность изменилась: забыть поля и неизменное (сопротивление), пересчитать заново. */
  reset(): void {
    this.cache.clear();
    this.ground = null;
  }

  /** Поля для показа пришли из Worker; на главном потоке решать давление не нужно. */
  acceptNodes(t: number, a: DriftField, b: DriftField): void {
    this.cache.clear();
    const k = Math.floor(t / DRIFT_PERIOD);
    this.cache.set(k, a);
    this.cache.set(k + 1, b);
  }

  /** Поля в двух узлах вокруг шага t и доля пути между ними — для обхода клеток без интерполяции по точке. */
  nodes(t: number): { a: DriftField; b: DriftField; u: number } {
    const k = Math.floor(t / DRIFT_PERIOD);
    const a = this.cache.get(k), b = this.cache.get(k + 1);
    if (a && b) return { a, b, u: t / DRIFT_PERIOD - k };
    return finishCalculation(this.nodesTask(t));
  }

  *nodesTask(t: number): Calculation<{ a: DriftField; b: DriftField; u: number }> {
    const k = Math.floor(t / DRIFT_PERIOD);
    const a = yield* this.nodeTask(k);
    const b = yield* this.nodeTask(k + 1);
    return { a, b, u: t / DRIFT_PERIOD - k };
  }

  /** Снос в точке (x, y) в шаге t: смещение за шаг, единиц мира. */
  at(x: number, y: number, t: number, out: [number, number] = [0, 0]): [number, number] {
    const k = Math.floor(t / DRIFT_PERIOD);
    const u = t / DRIFT_PERIOD - k;
    const a = this.node(k);
    const b = this.node(k + 1);
    const [ax, ay] = sample(a, x, y);
    const [bx, by] = sample(b, x, y);
    out[0] = ax + (bx - ax) * u;
    out[1] = ay + (by - ay) * u;
    return out;
  }
}

/** Билинейное чтение поля. */
function sample(f: DriftField, x: number, y: number): [number, number] {
  const fx = Math.min(f.cols - 1, Math.max(0, x / f.cell - 0.5));
  const fy = Math.min(f.rows - 1, Math.max(0, y / f.cell - 0.5));
  const i0 = Math.floor(fx), j0 = Math.floor(fy);
  const i1 = Math.min(f.cols - 1, i0 + 1), j1 = Math.min(f.rows - 1, j0 + 1);
  const u = fx - i0, v = fy - j0;
  const k00 = j0 * f.cols + i0, k10 = j0 * f.cols + i1, k01 = j1 * f.cols + i0, k11 = j1 * f.cols + i1;
  const lerp2 = (arr: Float32Array) => {
    const a = arr[k00] + (arr[k10] - arr[k00]) * u;
    const b = arr[k01] + (arr[k11] - arr[k01]) * u;
    return a + (b - a) * v;
  };
  return [lerp2(f.vx), lerp2(f.vy)];
}
