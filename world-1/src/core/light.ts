import { finishCalculation, type Calculation } from './task.ts';
import { dishOf } from './dish.ts';
/**
 * Свет (спецификация, раздел «Свет»): светлые пятна на тёмном фоне, запертые в чашке.
 *
 * Пятно — мягкий эллипс постоянного размера, вытянутости и поворота. Его
 * середина ходит по чашке: по каждой оси — «пила» со скруглёнными зубцами
 * (asin(k·sin τ)), поэтому пятно летит почти по прямой и у стенки плавно
 * разворачивается, а всю чашку обходит равномерно. В круглой чашке путь
 * из квадрата плавно отображается в круг. Свет пятен в точке — максимум по
 * пятнам: перекрывающиеся пятна свет не складывают.
 *
 * Всё движение — формулы от номера шага: свет на любом шаге считается сразу.
 */
import {
  LIGHT_DRIFT_SPEED, SPOT_ASPECT_MAX, SPOT_EDGE, SPOT_SIZE_MAX, SPOT_SIZE_MIN, SPOT_SIZE_SPREAD, SPOT_SPEED_RANGE, SPOT_TURN,
} from './constants.ts';
import { Rng, deriveSeed } from './prng.ts';
import type { WorldParams } from './params.ts';

const TAU = Math.PI * 2;
const TURN_NORM = Math.asin(SPOT_TURN);
/** Моменты, по которым при сотворении подбирается число пятен (средняя освещённость). */
const COVERAGE_TIMES = [0, 150_000, 300_000, 450_000, 600_000, 750_000];
/** Шаг (в шагах модели) для скорости пятна разностью положений. */
const VELOCITY_STEP = 25;

interface Spot {
  /** Полуоси (вдоль и поперёк) и поворот — постоянные. */
  ru: number; rv: number;
  c: number; sn: number;
  /** Путь: частоты и фазы «пилы» по осям (в долях оборота за шаг и радианах). */
  wx: number; px: number;
  wy: number; py: number;
  /** Ход середины по осям: от центра чашки на ± эти величины (в круге — доли радиуса, см. pathPoint). */
  hx: number; hy: number;
}

export interface LightMap {
  readonly width: number;
  readonly height: number;
  readonly circle: boolean;
  readonly spots: readonly Spot[];
  readonly sun: number;
  readonly background: number;
  /** Ритм солнца: размах, период (шагов) и фаза из сида. */
  readonly rhythm: { readonly amp: number; readonly period: number; readonly phase: number };
}

function sampleRadius(rng: Rng, mean: number): number {
  // Логнормальное: мелких много, крупных мало.
  const u1 = Math.max(rng.next(), 1e-12);
  const u2 = rng.next();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(TAU * u2);
  const k = Math.exp(SPOT_SIZE_SPREAD * z - (SPOT_SIZE_SPREAD * SPOT_SIZE_SPREAD) / 2);
  return mean * Math.min(SPOT_SIZE_MAX, Math.max(SPOT_SIZE_MIN, k));
}

/** «Пила» со скруглёнными зубцами: −1…1, почти прямой ход и плавный разворот. */
function saw(tau: number): number {
  return Math.asin(SPOT_TURN * Math.sin(tau)) / TURN_NORM;
}

function makeSpot(rng: Rng, width: number, height: number, circle: boolean, meanRadius: number, drift: number): Spot {
  const r = sampleRadius(rng, meanRadius);
  const aspect = rng.range(1, SPOT_ASPECT_MAX);
  const k = Math.sqrt(aspect);
  const angle = rng.range(0, Math.PI);
  // Середина не ближе к стенке, чем размер пятна (но не больше 40% чашки).
  const margin = Math.min(r, 0.4 * Math.min(width, height));
  const hx = circle ? width / 2 - margin : width / 2 - margin;
  const hy = circle ? hx : height / 2 - margin;
  // Скорость и её направление; ход по каждой оси — не медленнее четверти скорости.
  const speed = LIGHT_DRIFT_SPEED * drift * rng.range(SPOT_SPEED_RANGE[0], SPOT_SPEED_RANGE[1]);
  const heading = rng.range(0, TAU);
  const sx = speed * Math.max(0.25, Math.abs(Math.cos(heading)));
  const sy = speed * Math.max(0.25, Math.abs(Math.sin(heading)));
  // На прямом участке saw' = k / asin(k) · ω: ω подобрана под скорость хода.
  const omega = (s: number, h: number) => (h > 0 ? (s * TURN_NORM) / (SPOT_TURN * h) : 0);
  return {
    ru: r * k, rv: r / k, c: Math.cos(angle), sn: Math.sin(angle),
    wx: omega(sx, hx), px: rng.range(0, TAU), wy: omega(sy, hy), py: rng.range(0, TAU), hx, hy,
  };
}

/** Середина пятна в шаге t, в координатах чашки. */
function pathPoint(map: LightMap, s: Spot, t: number): [number, number] {
  const u = saw(s.wx * t + s.px), v = saw(s.wy * t + s.py);
  if (!map.circle) return [map.width / 2 + s.hx * u, map.height / 2 + s.hy * v];
  // Квадрат → круг: плавное отображение, стороны квадрата ложатся на окружность.
  return [map.width / 2 + s.hx * u * Math.sqrt(1 - (v * v) / 2), map.height / 2 + s.hy * v * Math.sqrt(1 - (u * u) / 2)];
}

/** Скорость пятна в шаге t, единиц мира за шаг. */
function pathVelocity(map: LightMap, s: Spot, t: number): [number, number] {
  const [ax, ay] = pathPoint(map, s, t - VELOCITY_STEP), [bx, by] = pathPoint(map, s, t + VELOCITY_STEP);
  return [(bx - ax) / (2 * VELOCITY_STEP), (by - ay) / (2 * VELOCITY_STEP)];
}

/** Докуда пятно заведомо не светит — от середины. */
function spotReach(s: Spot): number {
  return Math.max(s.ru, s.rv) * (1 + SPOT_EDGE);
}

/** Свет пятна в точке со смещением (dx, dy) от его середины: 1 внутри, плавно до 0 на краю. */
function spotLight(s: Spot, dx: number, dy: number): number {
  const u = (dx * s.c + dy * s.sn) / s.ru;
  const v = (-dx * s.sn + dy * s.c) / s.rv;
  const d2 = u * u + v * v;
  if (d2 <= 1) return 1;
  const outer = 1 + SPOT_EDGE;
  if (d2 >= outer * outer) return 0;
  const w = 1 - (Math.sqrt(d2) - 1) / SPOT_EDGE;
  return w * w * (3 - 2 * w);
}

export function createLightMap(params: WorldParams): LightMap {
  const { width, height, shape } = dishOf(params);
  const circle = shape === 'circle';
  const rng = new Rng(deriveSeed(params.seed, 'light'));
  const base = {
    width, height, circle, sun: params.sun, background: params.backgroundLevel,
    rhythm: { amp: params.sunRhythm, period: params.sunPeriod, phase: (deriveSeed(params.seed, 'sun') / 4294967296) * TAU },
  };
  // Пятна добавляются, пока средняя доля чашки под ними (по нескольким
  // моментам на протяжении обхода чашки) не достигнет освещённости.
  const spots: Spot[] = [];
  const map: LightMap = { ...base, spots };
  const cell = 8, cols = Math.ceil(width / cell), rows = Math.ceil(height / cell);
  const fields = COVERAGE_TIMES.map(() => new Float32Array(cols * rows));
  let inside = 0, lit = 0;
  const free = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const x = (i + 0.5) * cell - width / 2, y = (j + 0.5) * cell - height / 2;
    if (!circle || x * x + y * y <= (width / 2) * (width / 2)) { free[j * cols + i] = 1; inside++; }
  }
  const target = params.illumination * inside * COVERAGE_TIMES.length;
  let before = 0;
  for (let guard = 0; guard < 400 && lit < target; guard++) {
    const s = makeSpot(rng, width, height, circle, params.spotSize, params.lightDrift);
    spots.push(s);
    before = lit;
    COVERAGE_TIMES.forEach((t, n) => { lit += addSpot(fields[n], free, map, s, t, cols, rows, cell); });
  }
  // Последнее (возможно, крупное) пятно оставить, только если с ним ближе к цели.
  if (spots.length > 1 && lit - target > target - before) spots.pop();
  return map;
}

/** Нанести пятно на сетку (максимумом); вернуть, сколько свободных клеток впервые стало светлыми. */
function addSpot(field: Float32Array, free: Uint8Array, map: LightMap, s: Spot, t: number, cols: number, rows: number, cell: number): number {
  const [cx, cy] = pathPoint(map, s, t);
  const reach = spotReach(s);
  let added = 0;
  const i0 = Math.max(0, Math.floor((cx - reach) / cell)), i1 = Math.min(cols - 1, Math.floor((cx + reach) / cell));
  const j0 = Math.max(0, Math.floor((cy - reach) / cell)), j1 = Math.min(rows - 1, Math.floor((cy + reach) / cell));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const k = j * cols + i;
      const v = spotLight(s, (i + 0.5) * cell - cx, (j + 0.5) * cell - cy);
      if (v <= field[k]) continue;
      if (free[k] && field[k] < 0.5 && v >= 0.5) added++;
      field[k] = v;
    }
  }
  return added;
}

/** Интенсивность пятен в точке чашки (0 — фон, 1 — пятно). */
export function spotIntensityAt(map: LightMap, x: number, y: number, t: number): number {
  let best = 0;
  for (const s of map.spots) {
    const [cx, cy] = pathPoint(map, s, t);
    const dx = x - cx, dy = y - cy, reach = spotReach(s);
    if (Math.abs(dx) > reach || Math.abs(dy) > reach) continue;
    const v = spotLight(s, dx, dy);
    if (v > best) {
      best = v;
      if (best === 1) return 1;
    }
  }
  return best;
}

/** Интенсивность пятен сразу во многих точках (x, y подряд в `points`) — середины пятен считаются один раз. */
export function spotIntensityAtPoints(map: LightMap, points: Float64Array, t: number, out: Float32Array): Float32Array {
  out.fill(0);
  for (const s of map.spots) {
    const [cx, cy] = pathPoint(map, s, t);
    const reach = spotReach(s);
    for (let i = 0; i < out.length; i++) {
      if (out[i] === 1) continue;
      const dx = points[2 * i] - cx, dy = points[2 * i + 1] - cy;
      if (Math.abs(dx) > reach || Math.abs(dy) > reach) continue;
      const v = spotLight(s, dx, dy);
      if (v > out[i]) out[i] = v;
    }
  }
  return out;
}

/** Множитель ритма солнца в шаге t: плавная волна вокруг 1. */
export function sunRhythmAt(map: LightMap, t: number): number {
  const r = map.rhythm;
  return 1 + r.amp * Math.sin((TAU * t) / r.period + r.phase);
}

/** Сила солнца в шаге t: параметр «Солнце» × ритм. */
export function sunAt(map: LightMap, t: number): number {
  return map.sun * sunRhythmAt(map, t);
}

/** Свет в точке чашки: фон, свет пятна или переход между ними — при солнце шага t. */
export function lightFromIntensity(map: LightMap, intensity: number, t: number): number {
  return sunAt(map, t) * (map.background + (1 - map.background) * intensity);
}

export function lightAt(map: LightMap, x: number, y: number, t: number): number {
  return lightFromIntensity(map, spotIntensityAt(map, x, y, t), t);
}

/** Скорость пятен в клетках: у каждой — скорость того пятна, что светит в ней ярче всех (для увлечения). */
export interface SpotVelocity {
  readonly vx: Float32Array;
  readonly vy: Float32Array;
}

/**
 * Интенсивность пятен на сетке чашки: `cols × rows` ячеек размером `cell`.
 * Растеризует каждое пятно только в его окрестности. С `velocity` — ещё и
 * скорость самого яркого в клетке пятна.
 */
export function rasterizeSpotIntensity(map: LightMap, t: number, cols: number, rows: number, cell: number, out?: Float32Array, velocity?: SpotVelocity): Float32Array {
  return finishCalculation(rasterizeSpotIntensityTask(map, t, cols, rows, cell, out, velocity));
}

export function* rasterizeSpotIntensityTask(map: LightMap, t: number, cols: number, rows: number, cell: number, out?: Float32Array, velocity?: SpotVelocity): Calculation<Float32Array> {
  const field = out && out.length === cols * rows ? out : new Float32Array(cols * rows);
  field.fill(0);
  if (velocity) { velocity.vx.fill(0); velocity.vy.fill(0); }
  for (const s of map.spots) {
    yield;
    const [cx, cy] = pathPoint(map, s, t);
    const [svx, svy] = velocity ? pathVelocity(map, s, t) : [0, 0];
    const reach = spotReach(s);
    const i0 = Math.max(0, Math.floor((cx - reach) / cell)), i1 = Math.min(cols - 1, Math.floor((cx + reach) / cell));
    const j0 = Math.max(0, Math.floor((cy - reach) / cell)), j1 = Math.min(rows - 1, Math.floor((cy + reach) / cell));
    for (let j = j0; j <= j1; j++) {
      const py = (j + 0.5) * cell - cy;
      for (let i = i0; i <= i1; i++) {
        const v = spotLight(s, (i + 0.5) * cell - cx, py);
        const k = j * cols + i;
        if (v > field[k]) {
          field[k] = v;
          if (velocity) { velocity.vx[k] = svx; velocity.vy[k] = svy; }
        }
      }
    }
  }
  return field;
}

/** Доля чашки под пятнами в шаге t — оценка по сетке. */
export function dishCoverage(map: LightMap, width: number, height: number, t: number, cell = 8): number {
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const f = rasterizeSpotIntensity(map, t, cols, rows, cell);
  let lit = 0, inside = 0;
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const x = (i + 0.5) * cell - width / 2, y = (j + 0.5) * cell - height / 2;
    if (map.circle && x * x + y * y > (width / 2) * (width / 2)) continue;
    inside++;
    if (f[j * cols + i] >= 0.5) lit++;
  }
  return lit / inside;
}

/** Средняя скорость пятен в шаге t (для подписи в сводке), единиц за шаг. */
export function meanSpotSpeed(map: LightMap, t: number): number {
  if (map.spots.length === 0) return 0;
  let sum = 0;
  for (const s of map.spots) sum += Math.hypot(...pathVelocity(map, s, t));
  return sum / map.spots.length;
}

/**
 * Контуры пятен для векторной отрисовки: для каждого пятна — замкнутый
 * многоугольник по середине размытого края, в координатах чашки, плоским
 * массивом [x0, y0, x1, y1, …].
 */
export function spotOutlines(map: LightMap, t: number, _dishW: number, _dishH: number, segments = 48): Float64Array[] {
  const middle = 1 + SPOT_EDGE / 2;
  return map.spots.map((s) => {
    const [cx, cy] = pathPoint(map, s, t);
    const poly = new Float64Array(segments * 2);
    for (let i = 0; i < segments; i++) {
      const phi = (i / segments) * TAU;
      const u = middle * Math.cos(phi) * s.ru, v = middle * Math.sin(phi) * s.rv;
      poly[i * 2] = cx + u * s.c - v * s.sn;
      poly[i * 2 + 1] = cy + u * s.sn + v * s.c;
    }
    return poly;
  });
}

/** Чисел на пятно в `spotShapes`. */
export const SPOT_SHAPE_SIZE = 8;

/**
 * Пятна параметрами — для отрисовки на GPU: по SPOT_SHAPE_SIZE чисел на
 * пятно: середина x, y; докуда заведомо не светит; полуоси; cos и sin
 * поворота; середина края (множитель границы).
 */
export function spotShapes(map: LightMap, t: number, _dishW: number, _dishH: number): Float32Array {
  const out = new Float32Array(map.spots.length * SPOT_SHAPE_SIZE);
  const middle = 1 + SPOT_EDGE / 2;
  map.spots.forEach((s, n) => {
    const [cx, cy] = pathPoint(map, s, t);
    out.set([cx, cy, spotReach(s), s.ru, s.rv, s.c, s.sn, middle], n * SPOT_SHAPE_SIZE);
  });
  return out;
}
