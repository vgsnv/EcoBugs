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
 * грани × (p − p соседа + увлечение вдоль грани) = источник. Решается каскадом от грубой сетки к
 * тонкой (Гаусс — Зейдель с верхней релаксацией), всегда с одного и того же
 * начального приближения — поэтому снос — функция номера шага. Поле
 * пересчитывается раз в DRIFT_PERIOD шагов, между пересчётами — плавный
 * переход.
 */
import { DRIFT_CELL, DRIFT_DRAG, DRIFT_MAX, DRIFT_PERIOD, DRIFT_SPEED, LIGHT_DRIFT_SPEED } from './constants.ts';
import { lightDriftVelocity, rasterizeSpotIntensity, sunAt, type LightMap } from './light.ts';
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

/** Один уровень сетки для решения: проводимость клеток, проводимость граней (вправо и вниз), источник. */
interface Level {
  readonly cols: number;
  readonly rows: number;
  readonly cond: Float64Array;
  readonly east: Float64Array;
  readonly south: Float64Array;
  readonly source: Float64Array;
  readonly west: Float64Array;
  readonly north: Float64Array;
  readonly inverse: Float64Array;
}

/** Коэффициенты не меняются до пересборки местности; источники меняются со светом. */
const geometries = new WeakMap<Float64Array, Omit<Level, 'source'>>();
const coarseConditions = new WeakMap<Float64Array, Float64Array>();

/** Неизменное на сетке течений: преграды, проводимость, отсек каждой клетки (−1 — преграда). */
interface Ground {
  readonly blocked: Uint8Array;
  readonly cond: Float64Array;
  readonly region: Int32Array;
  readonly regions: number;
}

function groundOf(world: Sources, cols: number, rows: number, cell: number): Ground {
  const n = cols * rows;
  const blocked = new Uint8Array(n);
  const cond = new Float64Array(n);
  for (let j = 0; j < rows; j++) {
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
    if (blocked[k0] || region[k0] >= 0) continue;
    region[k0] = regions;
    stack.push(k0);
    while (stack.length > 0) {
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

function levelOf(cols: number, rows: number, cond: Float64Array, source: Float64Array): Level {
  const cached = geometries.get(cond);
  if (cached) return { ...cached, source };
  const east = new Float64Array(cols * rows);
  const south = new Float64Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      if (i < cols - 1) east[k] = face(cond[k], cond[k + 1]);
      if (j < rows - 1) south[k] = face(cond[k], cond[k + cols]);
    }
  }
  const n = cols * rows;
  const west = new Float64Array(n), north = new Float64Array(n), inverse = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    west[k] = k % cols > 0 ? east[k - 1] : 0;
    north[k] = k >= cols ? south[k - cols] : 0;
    const sum = west[k] + east[k] + north[k] + south[k];
    inverse[k] = sum > 0 ? 1 / sum : 0;
  }
  const geometry = { cols, rows, cond, east, south, west, north, inverse };
  geometries.set(cond, geometry);
  return { ...geometry, source };
}

/** Вдвое грубее: проводимость — средняя по четырём клеткам, источник — сумма. */
function coarsen(l: Level): Level {
  const cols = Math.ceil(l.cols / 2), rows = Math.ceil(l.rows / 2);
  let cond = coarseConditions.get(l.cond);
  if (!cond) {
    cond = new Float64Array(cols * rows);
    for (let j = 0; j < l.rows; j++) for (let i = 0; i < l.cols; i++) {
      cond[(j >> 1) * cols + (i >> 1)] += l.cond[j * l.cols + i] / 4;
    }
    coarseConditions.set(l.cond, cond);
  }
  const source = new Float64Array(cols * rows);
  for (let j = 0; j < l.rows; j++) {
    for (let i = 0; i < l.cols; i++) {
      const k = j * l.cols + i, c = (j >> 1) * cols + (i >> 1);
      source[c] += l.source[k];
    }
  }
  return levelOf(cols, rows, cond, source);
}

/**
 * Итерации Гаусса — Зейделя с верхней релаксацией. Давление `p` — с рамкой в
 * строку сверху и снизу (индекс клетки + cols), чтобы соседи читались без
 * проверок: у краёв и преград коэффициент грани — 0.
 */
function relax(l: Level, p: Float64Array, iterations: number): void {
  const { cols, rows, east: ce, south: cs, source, west: cw, north: cn, inverse: inv } = l;
  const n = cols * rows;
  for (let it = 0; it < iterations; it++) {
    for (let k = 0; k < n; k++) {
      if (inv[k] === 0) continue;
      const q = k + cols;
      const target = (source[k] + cw[k] * p[q - 1] + ce[k] * p[q + 1] + cn[k] * p[q - cols] + cs[k] * p[q + cols]) * inv[k];
      p[q] += DRIFT_OMEGA * (target - p[q]);
    }
  }
}

/** Решение каскадом: точно на самой грубой сетке, дальше — перенос на вдвое более тонкую и сглаживание. Давление — с рамкой (см. relax). */
function solve(fine: Level): Float64Array {
  const levels = [fine];
  while (levels[levels.length - 1].cols > DRIFT_COARSEST) levels.push(coarsen(levels[levels.length - 1]));
  const last = levels[levels.length - 1];
  let p = new Float64Array((last.rows + 2) * last.cols + 2);
  relax(last, p, DRIFT_COARSE_ITERATIONS);
  for (let d = levels.length - 2; d >= 0; d--) {
    const l = levels[d], c = levels[d + 1];
    const q = new Float64Array((l.rows + 2) * l.cols + 2);
    for (let j = 0; j < l.rows; j++) for (let i = 0; i < l.cols; i++) q[(j + 1) * l.cols + i] = p[((j >> 1) + 1) * c.cols + (i >> 1)];
    relax(l, q, DRIFT_FINE_ITERATIONS);
    p = q;
  }
  return p.subarray(fine.cols, fine.cols + fine.cols * fine.rows);
}

/** Самая грубая сетка — не шире стольких клеток; итераций на ней и на каждом более тонком уровне; релаксация. */
const DRIFT_COARSEST = 26;
const DRIFT_COARSE_ITERATIONS = 600;
const DRIFT_FINE_ITERATIONS = 30;
const DRIFT_OMEGA = 1.7;

/** Течения в шаге t. */
export function computeDriftField(world: Sources, t: number, ground?: Ground): DriftField {
  const cell = DRIFT_CELL, cols = Math.ceil(world.partitions.dish.width / cell), rows = Math.ceil(world.partitions.dish.height / cell), n = cols * rows;
  ground ??= groundOf(world, cols, rows, cell);
  const vx = new Float32Array(n);
  const vy = new Float32Array(n);
  const sun = sunAt(world.light, t);
  if (sun <= 0) return { cols, rows, cell, vx, vy };
  // Свет места: фон + пятна; источник — отклонение от среднего по отсеку.
  const bg = world.params.backgroundLevel;
  const intensity = rasterizeSpotIntensity(world.light, t, cols, rows, cell);
  const { blocked, cond, region, regions } = ground;
  const sum = new Float64Array(regions), count = new Float64Array(regions);
  const light = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    if (blocked[k]) continue;
    light[k] = sun * (bg + (1 - bg) * intensity[k]);
    sum[region[k]] += light[k];
    count[region[k]]++;
  }
  // Увлечение: дрейфующие пятна тянут среду за собой — сила по направлению
  // дрейфа света, тем больше, чем ярче место и быстрее дрейф (на гранях — среднее).
  const [dvx, dvy] = lightDriftVelocity(world.light, t);
  const fx = new Float64Array(n), fy = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    if (blocked[k]) continue;
    const pull = DRIFT_DRAG * sun * intensity[k] / LIGHT_DRIFT_SPEED;
    fx[k] = pull * dvx;
    fy[k] = pull * dvy;
  }
  const level0 = levelOf(cols, rows, cond, new Float64Array(n));
  const { east, south } = level0;
  const fEast = new Float64Array(n), fSouth = new Float64Array(n);
  for (let j = 0; j < rows; j++) {
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
  const p = solve(levelOf(cols, rows, cond, source));
  // Плотность потока в клетке — среднее потоков через её грани (давление + увлечение).
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      if (blocked[k]) continue;
      const fw = i > 0 ? east[k - 1] * (p[k - 1] - p[k] + fEast[k - 1]) : 0;
      const fe = i < cols - 1 ? east[k] * (p[k] - p[k + 1] + fEast[k]) : 0;
      const fn = j > 0 ? south[k - cols] * (p[k - cols] - p[k] + fSouth[k - cols]) : 0;
      const fs = j < rows - 1 ? south[k] * (p[k] - p[k + cols] + fSouth[k]) : 0;
      let x = DRIFT_SPEED * (fw + fe) / 2, y = DRIFT_SPEED * (fn + fs) / 2;
      const v = Math.hypot(x, y);
      if (v > DRIFT_MAX) { x *= DRIFT_MAX / v; y *= DRIFT_MAX / v; }
      vx[k] = x;
      vy[k] = y;
    }
  }
  return { cols, rows, cell, vx, vy };
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
    let f = this.cache.get(k);
    if (!f) {
      this.ground ??= groundOf(this.world, Math.ceil(this.world.partitions.dish.width / DRIFT_CELL), Math.ceil(this.world.partitions.dish.height / DRIFT_CELL), DRIFT_CELL);
      f = computeDriftField(this.world, k * DRIFT_PERIOD, this.ground);
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
    return { a: this.node(k), b: this.node(k + 1), u: t / DRIFT_PERIOD - k };
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
