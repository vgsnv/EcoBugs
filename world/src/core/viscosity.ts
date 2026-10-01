/**
 * Карта вязкости (спецификация, раздел «Вязкость»): три градации — вода, отмель,
 * суша; названия условны. Градация задаёт месту два свойства: сопротивление
 * движению (базовая вязкость × множитель градации) и долю усваиваемого света.
 *
 * Суша отделена от воды отмелью; границы плавные; доли градаций и средний
 * размер зон — параметры стартовой местности. Карта строится из сида и не
 * зависит от перегородок; дальше её меняет местность (грунт): раз в
 * TERRAIN_PERIOD шагов карта пересобирается из уровня грунта (applyLevels).
 */
import {
  DISH_HEIGHT, DISH_WIDTH,
  LIGHT_ABSORPTION, SHALLOWS_RING_MIN, VISCOSITY_BLUR, VISCOSITY_CELL, VISCOSITY_MULTIPLIERS,
} from './constants.ts';
import { periodicFbm } from './noise.ts';
import { deriveSeed } from './prng.ts';
import type { ViscosityShares, WorldParams } from './params.ts';

export const WATER = 0;
export const SHALLOWS = 1;
export const LAND = 2;
export type Gradation = typeof WATER | typeof SHALLOWS | typeof LAND;

export interface ViscosityMap {
  readonly cols: number;
  readonly rows: number;
  /** Размер ячейки, единиц мира. */
  readonly cell: number;
  /** Градация каждой ячейки (без размытия). */
  levels: Uint8Array;
  /** Плавный уровень 0…2 (0 — вода, 1 — отмель, 2 — суша) после размытия границ. */
  smooth: Float32Array;
  /** Фактические доли градаций. */
  shares: ViscosityShares;
  /** Растёт при каждой пересборке — чтобы показ знал, что пора перерисовать местность. */
  version: number;
}

/** Порог, выше которого лежит доля `share` значений. */
function thresholdForShare(sorted: Float32Array, share: number): number {
  if (share <= 0) return Infinity;
  if (share >= 1) return -Infinity;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * (1 - share))));
  return sorted[idx];
}

/** Чебышёвское расстояние (в ячейках) до ближайшей ячейки суши; BFS по 8 соседям. */
function distanceToLand(levels: Uint8Array, cols: number, rows: number): Int32Array {
  const dist = new Int32Array(cols * rows).fill(-1);
  const queue = new Int32Array(cols * rows);
  let head = 0;
  let tail = 0;
  for (let k = 0; k < levels.length; k++) {
    if (levels[k] === LAND) { dist[k] = 0; queue[tail++] = k; }
  }
  while (head < tail) {
    const k = queue[head++];
    const i = k % cols;
    const j = (k - i) / cols;
    for (let dj = -1; dj <= 1; dj++) {
      const nj = j + dj;
      if (nj < 0 || nj >= rows) continue;
      for (let di = -1; di <= 1; di++) {
        const ni = i + di;
        if (ni < 0 || ni >= cols || (di === 0 && dj === 0)) continue;
        const n = nj * cols + ni;
        if (dist[n] === -1) { dist[n] = dist[k] + 1; queue[tail++] = n; }
      }
    }
  }
  return dist;
}

/** Размытие скользящим средним по строкам и столбцам, края — по имеющимся ячейкам. */
function boxBlur(src: Float32Array, cols: number, rows: number, radius: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      let sum = 0; let n = 0;
      for (let d = -radius; d <= radius; d++) {
        const x = i + d;
        if (x >= 0 && x < cols) { sum += src[j * cols + x]; n++; }
      }
      tmp[j * cols + i] = sum / n;
    }
  }
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      let sum = 0; let n = 0;
      for (let d = -radius; d <= radius; d++) {
        const y = j + d;
        if (y >= 0 && y < rows) { sum += tmp[y * cols + i]; n++; }
      }
      out[j * cols + i] = sum / n;
    }
  }
  return out;
}

export function createViscosityMap(params: WorldParams): ViscosityMap {
  const cell = VISCOSITY_CELL;
  const cols = Math.ceil(DISH_WIDTH / cell);
  const rows = Math.ceil(DISH_HEIGHT / cell);
  const n = cols * rows;

  // Плавное поле с масштабом «размера зон»: одна ячейка решётки шума ≈ две зоны.
  const cellsX = Math.max(1, Math.round(DISH_WIDTH / (params.viscosityZoneSize * 2)));
  const cellsY = Math.max(1, Math.round(DISH_HEIGHT / (params.viscosityZoneSize * 2)));
  const noise = periodicFbm(deriveSeed(params.seed, 'viscosity'), cellsX, cellsY, 4);
  const field = new Float32Array(n);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      field[j * cols + i] = noise(((i + 0.5) * cell / DISH_WIDTH) * cellsX, ((j + 0.5) * cell / DISH_HEIGHT) * cellsY);
    }
  }
  const sorted = Float32Array.from(field).sort();
  const { land, shallows } = params.viscosityShares;

  // 1. Суша — самые высокие места поля.
  const levels = new Uint8Array(n);
  const landThr = thresholdForShare(sorted, land);
  for (let k = 0; k < n; k++) if (field[k] >= landThr) levels[k] = LAND;

  // 2. Обязательное кольцо отмели вокруг суши: вода и суша не граничат напрямую.
  const dist = distanceToLand(levels, cols, rows);
  const ring = (k: number) => levels[k] !== LAND && dist[k] > 0 && dist[k] <= SHALLOWS_RING_MIN;

  // 3. Остальная отмель — следующие по высоте места; порог подбирается так,
  //    чтобы кольцо вместе с ними дало нужную долю.
  const target = Math.round(n * shallows);
  let lo = -2;
  let hi = landThr === Infinity ? 2 : landThr;
  const countShallows = (thr: number) => {
    let c = 0;
    for (let k = 0; k < n; k++) if (levels[k] !== LAND && (ring(k) || field[k] >= thr)) c++;
    return c;
  };
  if (shallows <= 0) {
    lo = hi = Infinity;
  } else {
    for (let it = 0; it < 40; it++) {
      const mid = (lo + hi) / 2;
      if (countShallows(mid) > target) lo = mid; else hi = mid;
    }
  }
  const shallowThr = hi;
  for (let k = 0; k < n; k++) {
    if (levels[k] !== LAND && (ring(k) || field[k] >= shallowThr)) levels[k] = SHALLOWS;
  }

  // 4. Плавные границы.
  const raw = new Float32Array(n);
  for (let k = 0; k < n; k++) raw[k] = levels[k];
  const smooth = boxBlur(boxBlur(raw, cols, rows, VISCOSITY_BLUR), cols, rows, VISCOSITY_BLUR);

  const counts = [0, 0, 0];
  for (let k = 0; k < n; k++) counts[levels[k]]++;
  return {
    cols, rows, cell, levels, smooth,
    shares: { water: counts[0] / n, shallows: counts[1] / n, land: counts[2] / n },
    version: 0,
  };
}

/**
 * Пересобрать карту из уровня местности на грубой сетке (cols × rows, ячейка
 * `cell`): билинейно на сетку карты; градация — по порогам 0,5 и 1,5. Уровень
 * непрерывен, поэтому между водой и сушей всегда проходит отмель.
 */
export function applyLevels(map: ViscosityMap, level: Float32Array, cols: number, rows: number, cell: number): void {
  const n = map.cols * map.rows;
  const counts = [0, 0, 0];
  for (let j = 0; j < map.rows; j++) {
    const fy = Math.min(rows - 1, Math.max(0, ((j + 0.5) * map.cell) / cell - 0.5));
    const j0 = Math.floor(fy), j1 = Math.min(rows - 1, j0 + 1), v = fy - j0;
    for (let i = 0; i < map.cols; i++) {
      const fx = Math.min(cols - 1, Math.max(0, ((i + 0.5) * map.cell) / cell - 0.5));
      const i0 = Math.floor(fx), i1 = Math.min(cols - 1, i0 + 1), u = fx - i0;
      const a = level[j0 * cols + i0] + (level[j0 * cols + i1] - level[j0 * cols + i0]) * u;
      const b = level[j1 * cols + i0] + (level[j1 * cols + i1] - level[j1 * cols + i0]) * u;
      const L = a + (b - a) * v;
      const k = j * map.cols + i;
      map.smooth[k] = L;
      const g = L < 0.5 ? WATER : L < 1.5 ? SHALLOWS : LAND;
      map.levels[k] = g;
      counts[g]++;
    }
  }
  map.shares = { water: counts[0] / n, shallows: counts[1] / n, land: counts[2] / n };
  map.version++;
}

/** Уровень местности на грубой сетке — среднее плавного уровня карты по ячейке. */
export function levelsOnGrid(map: ViscosityMap, cols: number, rows: number, cell: number): Float32Array {
  const out = new Float32Array(cols * rows);
  const sub = 4;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      let s = 0;
      for (let b = 0; b < sub; b++) for (let a = 0; a < sub; a++) s += smoothLevelAt(map, (i + (a + 0.5) / sub) * cell, (j + (b + 0.5) / sub) * cell);
      out[j * cols + i] = s / (sub * sub);
    }
  }
  return out;
}

/** Значение свойства по плавному уровню: линейно между градациями. */
function interpolate(values: readonly [number, number, number], level: number): number {
  const l = Math.min(2, Math.max(0, level));
  return l <= 1 ? values[0] + (values[1] - values[0]) * l : values[1] + (values[2] - values[1]) * (l - 1);
}

/** Плавный уровень в точке чашки — билинейно по ячейкам. */
export function smoothLevelAt(map: ViscosityMap, x: number, y: number): number {
  const fx = Math.min(map.cols - 1, Math.max(0, x / map.cell - 0.5));
  const fy = Math.min(map.rows - 1, Math.max(0, y / map.cell - 0.5));
  const i0 = Math.floor(fx);
  const j0 = Math.floor(fy);
  const i1 = Math.min(map.cols - 1, i0 + 1);
  const j1 = Math.min(map.rows - 1, j0 + 1);
  const u = fx - i0;
  const v = fy - j0;
  const s = map.smooth;
  const a = s[j0 * map.cols + i0] + (s[j0 * map.cols + i1] - s[j0 * map.cols + i0]) * u;
  const b = s[j1 * map.cols + i0] + (s[j1 * map.cols + i1] - s[j1 * map.cols + i0]) * u;
  return a + (b - a) * v;
}

/** Градация в точке чашки (без размытия). */
export function gradationAt(map: ViscosityMap, x: number, y: number): Gradation {
  const i = Math.min(map.cols - 1, Math.max(0, Math.floor(x / map.cell)));
  const j = Math.min(map.rows - 1, Math.max(0, Math.floor(y / map.cell)));
  return map.levels[j * map.cols + i] as Gradation;
}

/** Сопротивление движению в точке: множитель градации (постоянные мира), плавно на стыках. */
export function resistanceAt(map: ViscosityMap, x: number, y: number): number {
  return interpolate(VISCOSITY_MULTIPLIERS, smoothLevelAt(map, x, y));
}

/** Доля усваиваемого света в точке. */
export function absorptionAt(map: ViscosityMap, x: number, y: number): number {
  return interpolate(LIGHT_ABSORPTION, smoothLevelAt(map, x, y));
}

export const multiplierForLevel = (level: number) => interpolate(VISCOSITY_MULTIPLIERS, level);
export const absorptionForLevel = (level: number) => interpolate(LIGHT_ABSORPTION, level);
