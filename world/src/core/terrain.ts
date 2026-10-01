/**
 * Местность (спецификация, раздел «Местность»): уровень местности — толщина
 * грунта, а грунт — минерал. Намыв (растворённый минерал оседает в грунт, тем
 * сильнее, чем слабее течение), размыв (течение срывает грунт обратно в
 * среду), подвижки (участки медленно поднимаются — из недр — или опускаются —
 * в недра) и толчки (короткие резкие подвижки).
 *
 * Грунт живёт на сетке минерала и меняется вместе с минералом (раз в
 * MINERAL_PERIOD шагов). Карта вязкости, течения и картинка пересобираются
 * из грунта раз в TERRAIN_PERIOD шагов — по «снимку» уровня, который хранится
 * в файле мира, поэтому ход мира не зависит от того, когда что пересчитано.
 */
import {
  DISH_HEIGHT, DISH_WIDTH, GROUND_PER_LEVEL, MOVE_AMPLITUDE, MOVE_BAND_LENGTH, MOVE_BAND_WIDTH,
  MOVE_DURATION, MOVE_GAP, MOVE_SPOT_RADIUS, QUAKE_AMPLITUDE, QUAKE_DURATION, QUAKE_RADIUS,
} from './constants.ts';
import type { WorldParams } from './params.ts';
import { deriveSeed, hash3 } from './prng.ts';
import { levelsOnGrid, type ViscosityMap } from './viscosity.ts';

/** Подвижка или толчок: форма, размах (уровень; + подъём, − опускание), начало и длительность. */
export interface Movement {
  readonly n: number;
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
  readonly amp: number;
  readonly start: number;
  readonly duration: number;
  /**
   * Парный участок той же формы рядом (только у подвижек): когда основной
   * поднимается, парный опускается на столько же, и наоборот; null — у толчков.
   */
  readonly pair: Movement | null;
}

export interface TerrainState {
  /** Коренной грунт по клеткам сетки минерала. */
  ground: Float64Array;
  /** Залежи — осевший минерал поверх грунта; тоже поднимает уровень. */
  deposits: Float64Array;
  /** Уровень, по которому сейчас собрана карта вязкости (снимок). */
  applied: Float32Array;
  /** Идущие подвижки и толчки. */
  active: Movement[];
  /** Номер и шаг начала следующей подвижки и следующего толчка. */
  nextMove: number;
  nextMoveStep: number;
  nextQuake: number;
  nextQuakeStep: number;
}

const rnd = (seed: number, n: number, k: number) => hash3(seed, n, k) / 4294967296;
const span = (r: readonly [number, number], u: number) => r[0] + (r[1] - r[0]) * u;

/** Подвижка (quake = false) или толчок номер n, начинающийся на шаге start, — целиком из сида. */
export function movement(seed: number, quake: boolean, n: number, start: number): Movement {
  const s = deriveSeed(seed, quake ? 'quakes' : 'moves');
  const sign = rnd(s, n, 1) < 0.5 ? -1 : 1;
  const x = rnd(s, n, 2) * DISH_WIDTH;
  const y = rnd(s, n, 3) * DISH_HEIGHT;
  if (quake) {
    return {
      n, quake, band: false, x, y, angle: 0, size: span(QUAKE_RADIUS, rnd(s, n, 4)), width: 0,
      amp: sign * span(QUAKE_AMPLITUDE, rnd(s, n, 5)), start, duration: Math.round(span(QUAKE_DURATION, rnd(s, n, 6))), pair: null,
    };
  }
  const band = rnd(s, n, 7) < 0.5;
  const angle = rnd(s, n, 8) * Math.PI;
  const size = band ? span(MOVE_BAND_LENGTH, rnd(s, n, 4)) / 2 : span(MOVE_SPOT_RADIUS, rnd(s, n, 4));
  const width = band ? span(MOVE_BAND_WIDTH, rnd(s, n, 9)) : 0;
  const amp = sign * span(MOVE_AMPLITUDE, rnd(s, n, 5));
  const duration = Math.round(span(MOVE_DURATION, rnd(s, n, 6)));
  // Парный участок: у полосы — параллельная полоса сбоку, у пятна — пятно рядом.
  const dir = band ? angle + Math.PI / 2 : rnd(s, n, 10) * 2 * Math.PI;
  const dist = band ? width * 2.6 : size * 1.7;
  const pair: Movement = {
    n, quake, band, x: x + Math.cos(dir) * dist, y: y + Math.sin(dir) * dist, angle, size, width, amp: -amp, start, duration, pair: null,
  };
  return { n, quake, band, x, y, angle, size, width, amp, start, duration, pair };
}

/** Промежуток до начала следующей подвижки или толчка номер n. */
function gap(seed: number, quake: boolean, n: number, quakeInterval: number): number {
  const s = deriveSeed(seed, quake ? 'quakes' : 'moves');
  const u = rnd(s, n, 0);
  return Math.max(1, Math.round(quake ? quakeInterval * (0.4 + 1.2 * u) : span(MOVE_GAP, u)));
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
  for (let k = 0; k < ground.length; k++) if (!blocked[k]) ground[k] = applied[k] * GROUND_PER_LEVEL * area;
  const q = params.quakeInterval;
  return {
    ground, deposits: new Float64Array(ground.length), applied, active: [],
    // Первая подвижка — раньше обычного промежутка: мир не стоит долго без тектоники.
    nextMove: 0, nextMoveStep: Math.round(gap(params.seed, false, 0, q) * 0.3),
    nextQuake: 0, nextQuakeStep: gap(params.seed, true, 0, q),
  };
}

/**
 * Подвижки и толчки за промежуток (from, to]: начать наступившие, сдвинуть
 * грунт на прирост их хода, закончить завершившиеся. Подъём берёт минерал из
 * недр (не больше, чем там есть), опускание отдаёт грунт в недра.
 * Возвращает изменение недр.
 */
export function moveGround(
  t: TerrainState, params: WorldParams, depths: number, from: number, to: number,
  cols: number, rows: number, cell: number, blocked: Uint8Array,
): number {
  const seed = params.seed;
  while (t.nextMoveStep <= to) {
    t.active.push(movement(seed, false, t.nextMove, t.nextMoveStep));
    t.nextMove++;
    t.nextMoveStep += gap(seed, false, t.nextMove, params.quakeInterval);
  }
  while (t.nextQuakeStep <= to) {
    t.active.push(movement(seed, true, t.nextQuake, t.nextQuakeStep));
    t.nextQuake++;
    t.nextQuakeStep += gap(seed, true, t.nextQuake, params.quakeInterval);
  }
  const area = cell * cell;
  const scale = params.terrainSpeed * GROUND_PER_LEVEL * area;
  let delta = 0;
  for (const m of t.active) {
    const step = (progress(m, to) - progress(m, from)) * m.amp * scale;
    if (step === 0) continue;
    // Опускается участок с отрицательным размахом, поднимается — с положительным.
    const rise = step > 0 ? m : m.pair;
    const sink = step > 0 ? m.pair : m;
    const size = Math.abs(step);
    // 1. Опускание: грунт уходит из опускающегося участка (не ниже дна).
    let released = 0;
    if (sink) {
      const f = footprint(sink, cols, rows, cell, blocked);
      for (let n = 0; n < f.cells.length; n++) {
        const k = f.cells[n];
        const before = t.ground[k];
        const take = Math.min(before, size * f.weights[n]);
        t.ground[k] -= take;
        released += take;
        // Залежи опускающегося участка тонут в недра — в той же доле.
        if (before > 0 && t.deposits[k] > 0) {
          const drown = t.deposits[k] * (take / before);
          t.deposits[k] -= drown;
          delta += drown;
        }
      }
    }
    // 2. Подъём: из опустившегося рядом; недостающее — из недр (сколько есть);
    // лишнее (если поднимать нечего) — в недра.
    if (rise) {
      const f = footprint(rise, cols, rows, cell, blocked);
      const need = size * f.total;
      const fromDepths = need > released ? Math.min(Math.max(0, depths + delta), need - released) : 0;
      const supply = Math.min(need, released) + fromDepths;
      delta += released - Math.min(need, released) - fromDepths;
      for (let n = 0; n < f.cells.length; n++) t.ground[f.cells[n]] += f.total > 0 ? (supply * f.weights[n]) / f.total : 0;
    } else {
      delta += released;
    }
  }
  t.active = t.active.filter((m) => m.start + m.duration > to);
  return delta;
}

/** Снимок уровня из грунта (для пересборки карты вязкости). */
export function levelFromGround(t: TerrainState, cell: number): Float32Array {
  const per = GROUND_PER_LEVEL * cell * cell;
  const out = new Float32Array(t.ground.length);
  for (let k = 0; k < out.length; k++) out[k] = (t.ground[k] + t.deposits[k]) / per;
  return out;
}

/** Минерал в коренном грунте — всего. */
export function mineralInGround(t: TerrainState): number {
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
