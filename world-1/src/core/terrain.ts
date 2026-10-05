import { dishOf } from './dish.ts';
/**
 * Местность (спецификация, раздел «Местность»): уровень — грунт плюс залежи.
 * Грунт — не минерал: его переносят течения и осыпание (mineral.ts), а
 * количество в чашке меняет только тектоника — подвижки: участки поднимаются
 * или опускаются (поровну случаев) до случайного уровня в диапазоне высот.
 * Подвижки бывают мелкие и быстрые (толчки, секунды–минуты) и крупные и
 * медленные (часы): чем крупнее, тем дольше. Сколько дна меняет уровень за
 * час — параметр; из него следует, как часто начинаются подвижки. Грунт для
 * подъёма берётся из подложки под чашкой, при опускании уходит в неё; ниже
 * стеклянного дна (грунт 0) опускаться нечему. Чего опускание не смогло
 * забрать (дно уже голое), подложка «задолжала» — это вычитается из
 * следующих подъёмов, поэтому грунта в среднем столько же, сколько было.
 *
 * Грунт живёт на сетке минерала и меняется вместе с минералом (раз в
 * MINERAL_PERIOD шагов). Карта вязкости, течения и картинка пересобираются
 * из грунта раз в TERRAIN_PERIOD шагов — по «снимку» уровня, который хранится
 * в файле мира, поэтому ход мира не зависит от того, когда что пересчитано.
 */
import {
  GROUND_FLOOR_LEVEL, GROUND_PER_LEVEL, MOVE_AREA, MOVE_BAND_WIDTH, MOVE_DURATION_SMALL, MOVE_DURATION_POWER, QUAKE_STEPS,
  TECTONIC_DEBT_SHARE,
} from './constants.ts';
import type { WorldParams } from './params.ts';
import { deriveSeed, hash3 } from './prng.ts';
import { levelsOnGrid, type ViscosityMap } from './viscosity.ts';

/** Подвижка: форма, размах (уровень; + подъём, − опускание), начало и длительность. */
export interface Movement {
  readonly n: number;
  /** Толчок — короткая подвижка (меньше QUAKE_STEPS); только для показа. */
  readonly quake: boolean;
  /** Полоса (длинная и узкая) или пятно. */
  readonly band: boolean;
  readonly x: number;
  readonly y: number;
  readonly angle: number;
  /** Пятно — радиус; полоса — половина длины. */
  readonly size: number;
  /** Полоса — полуширина. */
  readonly width: number;
  /** Площадь, см². */
  readonly area: number;
  /** Размах — считается в начале подвижки по уровню участка и диапазону высот. */
  amp: number;
  readonly start: number;
  readonly duration: number;
}

export interface TerrainState {
  /** Грунт по клеткам сетки минерала (не минерал; в единицах залежей). */
  ground: Float64Array;
  /** Залежи — осевший минерал поверх грунта; тоже поднимает уровень. */
  deposits: Float64Array;
  /** Уровень, по которому сейчас собрана карта вязкости (снимок). */
  applied: Float32Array;
  /** Идущие подвижки. */
  active: Movement[];
  /** Номер и шаг начала следующей подвижки. */
  nextMove: number;
  nextMoveStep: number;
  /** Долг подложки: грунт, который опускания не смогли забрать; гасится подъёмами. */
  debt: number;
}

const rnd = (seed: number, n: number, k: number) => hash3(seed, n, k) / 4294967296;
const span = (r: readonly [number, number], u: number) => r[0] + (r[1] - r[0]) * u;
/** Средняя площадь подвижки, см² (площади — равномерно в логарифме). */
const MEAN_AREA = (MOVE_AREA[1] - MOVE_AREA[0]) / Math.log(MOVE_AREA[1] / MOVE_AREA[0]);

/** Форма и время подвижки номер n, начинающейся на шаге start, — из сида; размах — 0 до начала. */
export function movement(params: WorldParams, n: number, start: number, amp = 0): Movement {
  const dish = dishOf(params);
  const s = deriveSeed(params.seed, 'moves');
  const r = dish.width / 2 * Math.sqrt(rnd(s, n, 2)), angle0 = rnd(s, n, 3) * Math.PI * 2;
  const x = dish.shape === 'circle' ? dish.width / 2 + r * Math.cos(angle0) : rnd(s, n, 2) * dish.width;
  const y = dish.shape === 'circle' ? dish.height / 2 + r * Math.sin(angle0) : rnd(s, n, 3) * dish.height;
  const area = MOVE_AREA[0] * (MOVE_AREA[1] / MOVE_AREA[0]) ** rnd(s, n, 4);
  // Крупные чаще бывают полосой (хребет, пролив), мелкие — пятном.
  const band = area > 300 && rnd(s, n, 7) < 0.5;
  const angle = rnd(s, n, 8) * Math.PI;
  const width = band ? span(MOVE_BAND_WIDTH, rnd(s, n, 9)) : 0;
  const size = band ? (area * 100) / (4 * width) : Math.sqrt((area * 100) / Math.PI);
  const duration = Math.round(MOVE_DURATION_SMALL * (area / MOVE_AREA[0]) ** MOVE_DURATION_POWER * (0.7 + 0.6 * rnd(s, n, 6)));
  return { n, quake: duration < QUAKE_STEPS, band, x, y, angle, size, width, area, amp, start, duration };
}

/** Промежуток до следующей подвижки: случайный, в среднем — чтобы за час менялся заданный объём дна. */
function gap(params: WorldParams, n: number): number {
  const perStep = params.tectonicVolume / MEAN_AREA / 36_000;
  if (!(perStep > 0)) return Number.MAX_SAFE_INTEGER;
  const u = rnd(deriveSeed(params.seed, 'moves'), n, 0);
  return Math.max(1, Math.round(-Math.log(1 - u * 0.999) / perStep));
}

/**
 * Новый объём тектоники в живом мире: следующая подвижка — по новому темпу
 * (промежутки случайные и без памяти, поэтому отсчёт просто начинается заново).
 */
export function rescheduleMoves(t: TerrainState, params: WorldParams, step: number): void {
  t.nextMoveStep = Math.min(Number.MAX_SAFE_INTEGER, step + gap(params, t.nextMove));
}

/** Вес места в подвижке: 1 в середине, плавно до 0 к краю. */
export function movementWeight(m: Movement, x: number, y: number): number {
  const dx = x - m.x, dy = y - m.y;
  let d: number;
  if (m.band) {
    const c = Math.cos(m.angle), s = Math.sin(m.angle);
    const along = dx * c + dy * s, across = -dx * s + dy * c;
    const a = Math.max(0, Math.abs(along) - m.size * 0.6) / (m.size * 0.4);
    const b = Math.abs(across) / m.width;
    d = Math.hypot(a, b);
  } else {
    d = Math.hypot(dx, dy) / m.size;
  }
  if (d >= 1) return 0;
  const t = 1 - d;
  return t * t * (3 - 2 * t);
}

/** Клетки подвижки и их веса — форма не меняется, считаются один раз. */
const footprints = new WeakMap<Movement, { cells: Int32Array; weights: Float32Array; total: number }>();

function footprint(m: Movement, cols: number, rows: number, cell: number, blocked: Uint8Array): { cells: Int32Array; weights: Float32Array; total: number } {
  let f = footprints.get(m);
  if (f) return f;
  const reach = m.band ? m.size + m.width : m.size;
  const i0 = Math.max(0, Math.floor((m.x - reach) / cell)), i1 = Math.min(cols - 1, Math.floor((m.x + reach) / cell));
  const j0 = Math.max(0, Math.floor((m.y - reach) / cell)), j1 = Math.min(rows - 1, Math.floor((m.y + reach) / cell));
  const cells: number[] = [];
  const weights: number[] = [];
  let total = 0;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const k = j * cols + i;
      if (blocked[k]) continue;
      const w = movementWeight(m, (i + 0.5) * cell, (j + 0.5) * cell);
      if (w === 0) continue;
      cells.push(k);
      weights.push(w);
      total += w;
    }
  }
  f = { cells: Int32Array.from(cells), weights: Float32Array.from(weights), total };
  footprints.set(m, f);
  return f;
}

/** Сколько подвижки уже прошло к шагу t: плавно от 0 до 1. */
function progress(m: Movement, t: number): number {
  const u = Math.min(1, Math.max(0, (t - m.start) / m.duration));
  return (1 - Math.cos(Math.PI * u)) / 2;
}

export function createTerrain(params: WorldParams, viscosity: ViscosityMap, cols: number, rows: number, cell: number, blocked: Uint8Array): TerrainState {
  const applied = levelsOnGrid(viscosity, cols, rows, cell);
  const ground = new Float64Array(cols * rows);
  const area = cell * cell;
  // Под водой — тонкий слой грунта: голого стекла при сотворении нет.
  for (let k = 0; k < ground.length; k++) {
    if (blocked[k]) continue;
    applied[k] = Math.max(applied[k], GROUND_FLOOR_LEVEL);
    ground[k] = applied[k] * GROUND_PER_LEVEL * area;
  }
  return {
    ground, deposits: new Float64Array(ground.length), applied, active: [],
    // Первая подвижка — раньше обычного промежутка: мир не стоит долго без тектоники.
    nextMove: 0, nextMoveStep: Math.min(Number.MAX_SAFE_INTEGER, Math.round(gap(params, 0) * 0.3)), debt: 0,
  };
}

/**
 * Подвижки и толчки за промежуток (from, to]: начать наступившие, сдвинуть
 * грунт на прирост их хода, закончить завершившиеся. Подъём добавляет грунт
 * из подложки, опускание убирает его в подложку (не ниже стеклянного дна) и
 * топит залежи опускающегося участка в недра — в той же доле.
 * Возвращает, сколько минерала ушло в недра (утонувшие залежи).
 */
export function moveGround(
  t: TerrainState, params: WorldParams, from: number, to: number,
  cols: number, rows: number, cell: number, blocked: Uint8Array,
): number {
  const scale = GROUND_PER_LEVEL * cell * cell;
  while (t.nextMoveStep <= to) {
    const m = movement(params, t.nextMove, t.nextMoveStep);
    // Размах — от нынешнего уровня участка до случайного уровня в диапазоне высот: поровну подъёмов и опусканий.
    const f = footprint(m, cols, rows, cell, blocked);
    let level = 0;
    for (let n = 0; n < f.cells.length; n++) level += (t.ground[f.cells[n]] + t.deposits[f.cells[n]]) * f.weights[n];
    level = f.total > 0 ? level / f.total / scale : 0;
    const s = deriveSeed(params.seed, 'moves'), u = rnd(s, m.n, 5);
    const target = rnd(s, m.n, 1) < 0.5
      ? level + u * Math.max(0, params.heightMax - level)
      : level - u * Math.max(0, level - params.heightMin);
    m.amp = target - level;
    t.active.push(m);
    t.nextMove++;
    t.nextMoveStep = Math.min(Number.MAX_SAFE_INTEGER, t.nextMoveStep + gap(params, t.nextMove));
  }
  let drowned = 0;
  for (const m of t.active) {
    let step = (progress(m, to) - progress(m, from)) * m.amp * scale;
    if (step === 0) continue;
    const f = footprint(m, cols, rows, cell, blocked);
    if (step > 0) {
      // Подъём сначала гасит долг подложки — не больше половины своего грунта.
      const pay = Math.min(t.debt, step * f.total * TECTONIC_DEBT_SHARE);
      t.debt -= pay;
      step -= pay / f.total;
      for (let n = 0; n < f.cells.length; n++) t.ground[f.cells[n]] += step * f.weights[n];
      continue;
    }
    for (let n = 0; n < f.cells.length; n++) {
      const k = f.cells[n];
      const change = -step * f.weights[n];
      const before = t.ground[k];
      const take = Math.min(before, change);
      t.ground[k] -= take;
      t.debt += change - take;
      if (before > 0 && t.deposits[k] > 0) {
        const drown = t.deposits[k] * (take / before);
        t.deposits[k] -= drown;
        drowned += drown;
      }
    }
  }
  t.active = t.active.filter((m) => m.start + m.duration > to);
  return drowned;
}

/** Снимок уровня из грунта (для пересборки карты вязкости). */
export function levelFromGround(t: TerrainState, cell: number): Float32Array {
  const per = GROUND_PER_LEVEL * cell * cell;
  const out = new Float32Array(t.ground.length);
  for (let k = 0; k < out.length; k++) out[k] = (t.ground[k] + t.deposits[k]) / per;
  return out;
}

/** Грунт в чашке — всего (не минерал). */
export function groundTotal(t: TerrainState): number {
  let s = 0;
  for (let k = 0; k < t.ground.length; k++) s += t.ground[k];
  return s;
}

/** Минерал в залежах — всего. */
export function mineralInDeposits(t: TerrainState): number {
  let s = 0;
  for (let k = 0; k < t.deposits.length; k++) s += t.deposits[k];
  return s;
}
