import { resistance } from './laws.ts';
import { finishCalculation, type Calculation } from './task.ts';
import { dishOf, insideDish } from './dish.ts';
/**
 * Карта вязкости (спецификация, раздел «Вязкость»): три градации — вода, отмель,
 * суша; названия условны. Градация задаёт месту два свойства: сопротивление
 * движению (базовая вязкость × множитель градации) и долю усваиваемого света.
 *
 * Стартовую карту строит генератор суши: массивы заданного числа и площади
 * с изрезанным берегом и внутренними морями, вокруг — полоса отмели заданной
 * ширины, остальное — вода. Налегающие массивы сливаются, поэтому генератор
 * не отказывает; доли градаций — следствие. Карта строится из сида и не
 * зависит от перегородок; дальше её меняет местность (грунт): раз в
 * TERRAIN_PERIOD шагов карта пересобирается из уровня грунта (applyLevels).
 */
import {
  LIGHT_ABSORPTION, SHALLOWS_RING_MIN, VISCOSITY_BLUR, VISCOSITY_CELL,
} from './constants.ts';
import { periodicFbm } from './noise.ts';
import { deriveSeed, hash3 } from './prng.ts';
import type { ViscosityShares, WorldParams } from './params.ts';

export const WATER = 0;
export const SHALLOWS = 1;
export const LAND = 2;
export type Gradation = typeof WATER | typeof SHALLOWS | typeof LAND;

export interface ViscosityMap {
  readonly active: Uint8Array;
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

/** Сколько мест пробует генератор для каждого массива суши. */
const PLACE_TRIES = 4;

/** Генератор суши (параметры — в см и см²; внутри — мм). */
function landLevels(params: WorldParams, cols: number, rows: number, cell: number, active: Uint8Array): Uint8Array {
  const dish = dishOf(params);
  const n = cols * rows;
  const levels = new Uint8Array(n);
  const s = deriveSeed(params.seed, 'land');
  const u = (a: number, b: number) => hash3(s, a, b) / 4294967296;
  // Шум изрезанности: крупность форм — от размера массива (полуострова соразмерны ему).
  const noise = periodicFbm(deriveSeed(params.seed, 'coast'), 64, 64, 4);
  const rough = params.coastRoughness;
  // Массив целиком в чаше, если влезает: иначе край чаши срезал бы заданную площадь.
  const place = (k: number, i: number, R: number): [number, number] => {
    if (dish.shape !== 'circle') {
      const mx = Math.max(0, dish.width / 2 - R), my = Math.max(0, dish.height / 2 - R);
      return [dish.width / 2 + (2 * u(k, i) - 1) * mx, dish.height / 2 + (2 * u(k, i + 1) - 1) * my];
    }
    const r = Math.max(0, dish.width / 2 - R) * Math.sqrt(u(k, i)), a = u(k, i + 1) * Math.PI * 2;
    return [dish.width / 2 + r * Math.cos(a), dish.height / 2 + r * Math.sin(a)];
  };
  /** Пятно с изрезанным краем: true там, где поле > 0. */
  const blob = (cx: number, cy: number, R: number, salt: number, skip: number, paint: (k: number) => void) => {
    const swing = rough * 0.8;
    const reach = R * (1 + swing) + cell;
    const i0 = Math.max(0, Math.floor((cx - reach) / cell)), i1 = Math.min(cols - 1, Math.ceil((cx + reach) / cell));
    const j0 = Math.max(0, Math.floor((cy - reach) / cell)), j1 = Math.min(rows - 1, Math.ceil((cy + reach) / cell));
    const ox = 7 + (salt % 13) * 3.7, oy = 5 + (salt % 11) * 4.3;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * cols + i;
      if (!active[k] || levels[k] === skip) continue;
      const x = (i + 0.5) * cell - cx, y = (j + 0.5) * cell - cy;
      // Шум в [-1, 1] со средним 0: край гуляет, площадь в среднем остаётся заданной.
      // Дальше размаха шума от кромки знак ясен и без него.
      const base = 1 - Math.hypot(x, y) / R;
      if (base > swing) { paint(k); continue; }
      if (base < -swing) continue;
      if (base + rough * 0.8 * noise(ox + (x / R) * 1.6, oy + (y / R) * 1.6) > 0) paint(k);
    }
  };
  // Массивы суши: площадь — случайная в диапазоне; налегающие сливаются.
  const masses: { x: number; y: number; R: number }[] = [];
  for (let m = 0; m < params.landCount; m++) {
    const area = (params.landAreaMin + (params.landAreaMax - params.landAreaMin) * u(m, 0)) * 100;
    const R = Math.sqrt(area / Math.PI);
    // Из нескольких мест — то, где массив меньше налегает на прежние: так крупные
    // массивы не сбиваются в кучу, а сливаются, лишь когда им тесно.
    let x = 0, y = 0, best = -Infinity;
    for (let c = 0; c < PLACE_TRIES; c++) {
      const [px, py] = place(m, 1 + 2 * c, R);
      let room = Infinity;
      for (const o of masses) room = Math.min(room, Math.hypot(px - o.x, py - o.y) - R - o.R);
      if (room > best) { best = room; x = px; y = py; }
    }
    masses.push({ x, y, R });
    blob(x, y, R, m, LAND, (k) => { levels[k] = LAND; });
  }
  // Внутренние моря — в массивах, от крупных к мелким; размер — доля площади своего массива.
  const order = masses.map((_, i) => i).sort((a, b) => masses[b].R - masses[a].R);
  for (let q = 0; q < params.seaCount && order.length > 0; q++) {
    const m = masses[order[q % order.length]];
    const R = m.R * Math.sqrt(params.seaShare * (0.7 + 0.6 * u(1000 + q, 0)));
    if (R <= cell) continue;
    // Моря одного массива расходятся по кругу, иначе ложатся друг на друга.
    const own = order[q % order.length], k = Math.floor(q / order.length);
    const count = Math.ceil((params.seaCount - (q % order.length)) / order.length);
    const a = u(2000 + own, 0) * Math.PI * 2 + (k * Math.PI * 2) / count + (u(1000 + q, 1) - 0.5) * 0.5;
    const off = (m.R - R) * (count > 1 ? 0.65 + 0.3 * u(1000 + q, 2) : 0.5 * u(1000 + q, 2));
    blob(m.x + off * Math.cos(a), m.y + off * Math.sin(a), R, 1000 + q, WATER, (k) => { if (levels[k] === LAND) levels[k] = WATER; });
  }
  // Отмель — вода ближе ширины отмели к суше (не меньше обязательного кольца).
  const shelf = Math.max(SHALLOWS_RING_MIN, Math.round((params.shelfWidth * 10) / cell));
  const dist = distanceToLand(levels, cols, rows);
  for (let k = 0; k < n; k++) if (levels[k] !== LAND && dist[k] > 0 && dist[k] <= shelf) levels[k] = SHALLOWS;
  return levels;
}

/** Стартовая карта: генератор суши, затем плавные границы. */
export function createViscosityMap(params: WorldParams): ViscosityMap {
  const dish = dishOf(params);
  const cell = VISCOSITY_CELL;
  const cols = Math.ceil(dish.width / cell);
  const rows = Math.ceil(dish.height / cell);
  const n = cols * rows;
  const active = new Uint8Array(n);
  for (let k = 0; k < n; k++) active[k] = insideDish(dish, (k % cols + 0.5) * cell, (Math.floor(k / cols) + 0.5) * cell) ? 1 : 0;
  const levels = landLevels(params, cols, rows, cell, active);
  const raw = new Float32Array(n);
  for (let k = 0; k < n; k++) raw[k] = levels[k];
  const smooth = boxBlur(boxBlur(raw, cols, rows, VISCOSITY_BLUR), cols, rows, VISCOSITY_BLUR);
  const counts = [0, 0, 0];
  let activeCount = 0;
  for (let k = 0; k < n; k++) if (active[k]) { counts[levels[k]]++; activeCount++; }
  return {
    active, cols, rows, cell, levels, smooth,
    shares: { water: counts[0] / activeCount, shallows: counts[1] / activeCount, land: counts[2] / activeCount },
    version: 0,
  };
}

/**
 * Пересобрать карту из уровня местности на грубой сетке (cols × rows, ячейка
 * `cell`): билинейно на сетку карты; градация — по порогам 0,5 и 1,5. Уровень
 * непрерывен, поэтому между водой и сушей всегда проходит отмель.
 */
export function applyLevels(map: ViscosityMap, level: Float32Array, cols: number, rows: number, cell: number): void {
  finishCalculation(applyLevelsTask(map, level, cols, rows, cell));
}

export function* applyLevelsTask(map: ViscosityMap, level: Float32Array, cols: number, rows: number, cell: number): Calculation {
  const n = map.active.reduce((a, b) => a + b, 0);
  const counts = [0, 0, 0];
  for (let j = 0; j < map.rows; j++) {
    if ((j & 3) === 0) yield;
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
      if (map.active[k]) counts[g]++;
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

/** Сопротивление движению в точке: множитель градации (законы среды), плавно на стыках. */
export function resistanceAt(map: ViscosityMap, x: number, y: number): number {
  return interpolate(resistance, smoothLevelAt(map, x, y));
}

/** Доля усваиваемого света в точке. */
export function absorptionAt(map: ViscosityMap, x: number, y: number): number {
  return interpolate(LIGHT_ABSORPTION, smoothLevelAt(map, x, y));
}

export const multiplierForLevel = (level: number) => interpolate(resistance, level);
export const absorptionForLevel = (level: number) => interpolate(LIGHT_ABSORPTION, level);
