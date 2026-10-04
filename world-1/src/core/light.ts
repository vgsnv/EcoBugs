import { finishCalculation, type Calculation } from './task.ts';
import { dishOf } from './dish.ts';
/**
 * Свет (спецификация, раздел «Свет»): общее световое поле, запертое в чашке.
 *
 * Пятна — где поле шума выше порога. Координаты поля искажает другое, медленно
 * меняющееся поле (domain warping): очертания перетекают, сливаются и
 * расходятся, каждый участок смещается в свою сторону; общего кружения нет,
 * всё поле очень медленно сносится в одну сторону. Порог — по распределению
 * в самой чашке: формы крупные и в чашку их попадает немного, поэтому порог
 * подбирается по чашке (thresholdAt) так, чтобы доля её площади под пятнами
 * была равна освещённости, — это тоже формула от шага (пересчёт раз в
 * THRESHOLD_STEP шагов, между ними — плавно). Крупность форм — «Размер пятен» × LIGHT_FORM_SCALE, темп — «Дрейф света».
 *
 * Всё — формула от номера шага: свет на любом шаге считается сразу. Шейдер
 * показа считает то же поле тем же шумом (LIGHT_FIELD_GLSL) — модель и картинка совпадают.
 */
import { LIGHT_EDGE, LIGHT_FORM_SCALE, LIGHT_TEMPO, LIGHT_WARP } from './constants.ts';
import { deriveSeed } from './prng.ts';
import type { WorldParams } from './params.ts';

const TAU = Math.PI * 2;

export interface LightMap {
  readonly width: number;
  readonly height: number;
  readonly circle: boolean;
  /** Сдвиг поля по сиду (единицы шума) и крупность форм (единиц мира на единицу шума). */
  readonly offsetX: number;
  readonly offsetY: number;
  readonly scale: number;
  /** Темп перетекания: единиц времени поля за шаг (0 — свет стоит). */
  readonly pace: number;
  /** Освещённость — доля чашки под пятнами. */
  readonly share: number;
  readonly sun: number;
  readonly background: number;
  /** Ритм солнца: размах, период (шагов) и фаза из сида. */
  readonly rhythm: { readonly amp: number; readonly period: number; readonly phase: number };
}

/* Шум — тот же, что в LIGHT_FIELD_GLSL: целочисленный хеш, значения в узлах, сглаживание пятой степени. */
function mixh(x: number): number {
  x = (x + 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}
function h2(x: number, y: number, s: number): number {
  return mixh((Math.imul(x, 0x27d4eb2d) ^ mixh((Math.imul(y, 0x165667b1) ^ s) >>> 0)) >>> 0) / 4294967296;
}
const fade = (f: number) => f * f * f * (f * (f * 6 - 15) + 10);
function vnoise(x: number, y: number, s: number): number {
  const i = Math.floor(x), j = Math.floor(y), fx = fade(x - i), fy = fade(y - j);
  const a = h2(i, j, s), b = h2(i + 1, j, s), c = h2(i, j + 1, s), d = h2(i + 1, j + 1, s);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}
function fbm(x: number, y: number, s: number): number {
  return 0.55 * vnoise(x, y, s) + 0.3 * vnoise(x * 2.03 + 17.1, y * 2.03 + 17.1, s + 1) + 0.15 * vnoise(x * 4.1 - 9.3, y * 4.1 - 9.3, s + 2);
}

/** Смещение координат поля в точке шума (x, y) во время s: искажение плюс общий медленный снос. */
function displacement(x: number, y: number, s: number, out: [number, number]): void {
  const qx = fbm(x * 0.7 + s * 0.6, y * 0.7 - s * 0.35, 20) - 0.5;
  const qy = fbm(x * 0.7 + 5.2 - s * 0.45, y * 0.7 + 1.3 + s * 0.55, 30) - 0.5;
  out[0] = LIGHT_WARP * qx - s * 0.2;
  out[1] = LIGHT_WARP * qy + s * 0.15;
}

const scratch: [number, number] = [0, 0];

/** Значение поля в точке мира (x, y) во время поля s. */
function fieldAt(map: LightMap, x: number, y: number, s: number): number {
  const px = x / map.scale + map.offsetX, py = y / map.scale + map.offsetY;
  displacement(px, py, s, scratch);
  return fbm(px + scratch[0], py + scratch[1], 60);
}

/** Свет пятен по значению поля: 0 — фон, 1 — пятно; край — плавный. */
function lightOfField(threshold: number, f: number): number {
  const lo = threshold - LIGHT_EDGE, hi = threshold + LIGHT_EDGE;
  const u = Math.min(1, Math.max(0, (f - lo) / (hi - lo)));
  return u * u * (3 - 2 * u);
}

/** Порог пересчитывается раз в столько шагов поля; сетка выборки по чашке. */
const THRESHOLD_STEP = 4000;
const SAMPLE_COLS = 48;
const SAMPLE_ROWS = 36;
const thresholds = new WeakMap<LightMap, Map<number, number>>();

/** Порог, при котором под пятнами доля освещённости чашки, в узле времени `key` (× THRESHOLD_STEP шагов). */
function thresholdKey(map: LightMap, key: number): number {
  let cache = thresholds.get(map);
  if (!cache) { cache = new Map(); thresholds.set(map, cache); }
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const s = key * THRESHOLD_STEP * map.pace;
  const values: number[] = [];
  for (let j = 0; j < SAMPLE_ROWS; j++) for (let i = 0; i < SAMPLE_COLS; i++) {
    const x = ((i + 0.5) / SAMPLE_COLS) * map.width, y = ((j + 0.5) / SAMPLE_ROWS) * map.height;
    if (map.circle && (x - map.width / 2) ** 2 + (y - map.height / 2) ** 2 > (map.width / 2) ** 2) continue;
    values.push(fieldAt(map, x, y, s));
  }
  values.sort((a, b) => a - b);
  const at = Math.min(values.length - 1, Math.max(0, Math.floor((1 - map.share) * values.length)));
  const value = values[at];
  if (cache.size > 64) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
  return value;
}

/** Порог в шаге t — плавно между узлами времени. */
export function thresholdAt(map: LightMap, t: number): number {
  if (map.pace === 0) return thresholdKey(map, 0);
  const u = t / THRESHOLD_STEP, k = Math.floor(u);
  const a = thresholdKey(map, k), b = thresholdKey(map, k + 1);
  return a + (b - a) * (u - k);
}

export function createLightMap(params: WorldParams): LightMap {
  const { width, height, shape } = dishOf(params);
  const h = deriveSeed(params.seed, 'light');
  return {
    width, height, circle: shape === 'circle',
    // Сдвиг по сиду — большой и положительный: координаты шума не уходят в минус.
    offsetX: 500 + (h % 100000) / 100, offsetY: 500 + (Math.floor(h / 100000) % 100000) / 100,
    scale: params.spotSize * LIGHT_FORM_SCALE,
    pace: params.lightDrift / LIGHT_TEMPO,
    share: params.illumination,
    sun: params.sun, background: params.backgroundLevel,
    rhythm: { amp: params.sunRhythm, period: params.sunPeriod, phase: (deriveSeed(params.seed, 'sun') / 4294967296) * TAU },
  };
}

/** Время поля в шаге t. */
export function lightTime(map: LightMap, t: number): number {
  return t * map.pace;
}

/** Интенсивность пятен в точке чашки (0 — фон, 1 — пятно). */
export function spotIntensityAt(map: LightMap, x: number, y: number, t: number): number {
  return lightOfField(thresholdAt(map, t), fieldAt(map, x, y, lightTime(map, t)));
}

/** Интенсивность пятен сразу во многих точках (x, y подряд в `points`). */
export function spotIntensityAtPoints(map: LightMap, points: Float64Array, t: number, out: Float32Array): Float32Array {
  const s = lightTime(map, t), th = thresholdAt(map, t);
  for (let i = 0; i < out.length; i++) out[i] = lightOfField(th, fieldAt(map, points[2 * i], points[2 * i + 1], s));
  return out;
}

/**
 * Скорость перетекания в точке, единиц мира за шаг: куда смещаются очертания
 * поля — против изменения смещения координат.
 */
function flowVelocity(map: LightMap, x: number, y: number, s: number, out: [number, number]): void {
  if (map.pace === 0) { out[0] = 0; out[1] = 0; return; }
  const px = x / map.scale + map.offsetX, py = y / map.scale + map.offsetY;
  const ds = 0.01;
  displacement(px, py, s + ds, scratch);
  const ax = scratch[0], ay = scratch[1];
  displacement(px, py, s - ds, scratch);
  const k = -map.scale * map.pace / (2 * ds);
  out[0] = (ax - scratch[0]) * k;
  out[1] = (ay - scratch[1]) * k;
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

/** Скорость перетекания света в клетках (для увлечения). */
export interface SpotVelocity {
  readonly vx: Float32Array;
  readonly vy: Float32Array;
}

/**
 * Интенсивность пятен на сетке чашки: `cols × rows` ячеек размером `cell`
 * (по центрам). С `velocity` — ещё и скорость перетекания там, где светло.
 */
export function rasterizeSpotIntensity(map: LightMap, t: number, cols: number, rows: number, cell: number, out?: Float32Array, velocity?: SpotVelocity): Float32Array {
  return finishCalculation(rasterizeSpotIntensityTask(map, t, cols, rows, cell, out, velocity));
}

export function* rasterizeSpotIntensityTask(map: LightMap, t: number, cols: number, rows: number, cell: number, out?: Float32Array, velocity?: SpotVelocity): Calculation<Float32Array> {
  const field = out && out.length === cols * rows ? out : new Float32Array(cols * rows);
  const s = lightTime(map, t), th = thresholdAt(map, t);
  const v: [number, number] = [0, 0];
  for (let j = 0; j < rows; j++) {
    if ((j & 3) === 0) yield;
    for (let i = 0; i < cols; i++) {
      const x = (i + 0.5) * cell, y = (j + 0.5) * cell, k = j * cols + i;
      const light = lightOfField(th, fieldAt(map, x, y, s));
      field[k] = light;
      if (!velocity) continue;
      if (light > 0) flowVelocity(map, x, y, s, v); else { v[0] = 0; v[1] = 0; }
      velocity.vx[k] = v[0]; velocity.vy[k] = v[1];
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

/** Средняя скорость перетекания там, где светло (для подписи в сводке), единиц за шаг. */
export function meanSpotSpeed(map: LightMap, t: number): number {
  const s = lightTime(map, t), th = thresholdAt(map, t);
  const v: [number, number] = [0, 0];
  let sum = 0, weight = 0;
  for (let j = 0; j < 12; j++) for (let i = 0; i < 16; i++) {
    const x = ((i + 0.5) / 16) * map.width, y = ((j + 0.5) / 12) * map.height;
    const light = lightOfField(th, fieldAt(map, x, y, s));
    if (light <= 0) continue;
    flowVelocity(map, x, y, s, v);
    sum += Math.hypot(v[0], v[1]) * light; weight += light;
  }
  return weight > 0 ? sum / weight : 0;
}

/** Параметры поля для шейдера (LIGHT_FIELD_GLSL) в шаге t. */
export function lightFieldUniforms(map: LightMap, t: number): { offset: [number, number]; scale: number; time: number; threshold: number; edge: number } {
  return { offset: [map.offsetX, map.offsetY], scale: map.scale, time: lightTime(map, t), threshold: thresholdAt(map, t), edge: LIGHT_EDGE };
}

/**
 * То же поле в GLSL (для маски света на GPU): `lightField(w)` — 0…1 в точке мира.
 * Униформы: u_lightOffset, u_lightScale, u_lightTime, u_lightThreshold, u_lightEdge.
 */
export const LIGHT_FIELD_GLSL = `
uniform vec2 u_lightOffset;
uniform float u_lightScale;
uniform float u_lightTime;
uniform float u_lightThreshold;
uniform float u_lightEdge;
uint lightMix(uint x) { x += 0x9e3779b9u; x = (x ^ (x >> 16u)) * 0x85ebca6bu; x = (x ^ (x >> 13u)) * 0xc2b2ae35u; return x ^ (x >> 16u); }
float lightHash(ivec2 p, int s) { return float(lightMix(uint(p.x) * 0x27d4eb2du ^ lightMix(uint(p.y) * 0x165667b1u ^ uint(s)))) / 4294967296.; }
float lightNoise(vec2 p, int s) {
  ivec2 i = ivec2(floor(p)); vec2 f = fract(p); f = f * f * f * (f * (f * 6. - 15.) + 10.);
  return mix(mix(lightHash(i, s), lightHash(i + ivec2(1, 0), s), f.x), mix(lightHash(i + ivec2(0, 1), s), lightHash(i + ivec2(1, 1), s), f.x), f.y);
}
float lightFbm(vec2 p, int s) { return .55 * lightNoise(p, s) + .3 * lightNoise(p * 2.03 + 17.1, s + 1) + .15 * lightNoise(p * 4.1 - 9.3, s + 2); }
float lightField(vec2 w) {
  vec2 p = w / u_lightScale + u_lightOffset;
  float s = u_lightTime;
  vec2 q = vec2(lightFbm(p * .7 + vec2(s * .6, -s * .35), 20), lightFbm(p * .7 + vec2(5.2 - s * .45, 1.3 + s * .55), 30)) - .5;
  float f = lightFbm(p + ${LIGHT_WARP.toFixed(3)} * q + vec2(-s * .2, s * .15), 60);
  return smoothstep(u_lightThreshold - u_lightEdge, u_lightThreshold + u_lightEdge, f);
}`;
