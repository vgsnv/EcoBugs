/**
 * Карта света (спецификация, раздел «Свет»): светлые пятна на тёмном фоне.
 *
 * Реализация: пятно — группа мягких эллипсов (здесь — кругов) с минимальным
 * радиусом, поэтому пятно не исчезает. Свет пятен в точке — максимум по
 * эллипсам, поэтому яркость не складывается. Эллипсы группы колеблются
 * относительно центра пятна — пятно вытягивается, делится и сливается обратно;
 * у каждого пятна свой медленный дрейф — разные пятна встречаются и сливаются.
 * Карта больше чашки, координаты по модулю её размера — края сомкнуты.
 *
 * Всё движение — формулы от номера шага: свет на любом шаге считается сразу.
 */
import {
  LIGHT_DRIFT_SPEED, LIGHT_MAP_SCALE, LIGHT_TURN_PERIOD, SPOT_EDGE, SPOT_MAX_BLOBS,
  SPOT_MIN_RADIUS, SPOT_OWN_DRIFT, SPOT_SIZE_MAX, SPOT_SIZE_MIN, SPOT_SIZE_SPREAD,
  SPOT_WOBBLE_PERIOD, SPOT_WOBBLE_REACH,
} from './constants.ts';
import { Rng, deriveSeed } from './prng.ts';
import type { WorldParams } from './params.ts';

const TAU = Math.PI * 2;
const GOLDEN = 1.6180339887;

interface Blob {
  /** Базовый радиус. */
  radius: number;
  /** Колебание смещения от центра пятна по x и y: амплитуда, частота, фаза. */
  ax: number; wx: number; px: number;
  ay: number; wy: number; py: number;
  /** Колебание радиуса: частота и фаза (амплитуда фиксирована константами). */
  wr: number; pr: number;
}

interface Spot {
  /** Положение центра на карте в шаге 0. */
  x0: number; y0: number;
  /** Собственный дрейф пятна, единиц за шаг. */
  vx: number; vy: number;
  blobs: Blob[];
}

/** Гармоника общего сдвига карты: направление поворачивается с частотой w. */
interface DriftHarmonic {
  speed: number; w: number; phase: number;
}

export interface LightMap {
  /** Размер карты (больше чашки). */
  readonly mapWidth: number;
  readonly mapHeight: number;
  readonly spots: readonly Spot[];
  readonly drift: readonly DriftHarmonic[];
  readonly sun: number;
  readonly background: number;
}

/** Круглая дистанция на сомкнутой оси: результат в [-size/2, size/2). */
function wrapDelta(d: number, size: number): number {
  d %= size;
  if (d < -size / 2) d += size;
  else if (d >= size / 2) d -= size;
  return d;
}

function wrap(v: number, size: number): number {
  return ((v % size) + size) % size;
}

function sampleRadius(rng: Rng, mean: number): number {
  // Логнормальное: мелких много, крупных мало.
  const u1 = Math.max(rng.next(), 1e-12);
  const u2 = rng.next();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(TAU * u2);
  const k = Math.exp(SPOT_SIZE_SPREAD * z - (SPOT_SIZE_SPREAD * SPOT_SIZE_SPREAD) / 2);
  return mean * Math.min(SPOT_SIZE_MAX, Math.max(SPOT_SIZE_MIN, k));
}

function makeSpot(rng: Rng, mapW: number, mapH: number, meanRadius: number): Spot {
  const radius = sampleRadius(rng, meanRadius);
  const blobCount = 1 + rng.int(SPOT_MAX_BLOBS);
  const blobs: Blob[] = [];
  for (let j = 0; j < blobCount; j++) {
    const reach = j === 0 ? 0.3 : SPOT_WOBBLE_REACH;
    const w = () => TAU / (SPOT_WOBBLE_PERIOD * rng.range(0.6, 1.6));
    blobs.push({
      radius: radius * (j === 0 ? 1 : rng.range(0.5, 0.9)),
      ax: radius * reach * rng.range(0.3, 1), wx: w(), px: rng.range(0, TAU),
      ay: radius * reach * rng.range(0.3, 1), wy: w(), py: rng.range(0, TAU),
      wr: w(), pr: rng.range(0, TAU),
    });
  }
  const angle = rng.range(0, TAU);
  const speed = LIGHT_DRIFT_SPEED * SPOT_OWN_DRIFT * rng.range(0.3, 1);
  return {
    x0: rng.range(0, mapW), y0: rng.range(0, mapH),
    vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
    blobs,
  };
}

/** Радиус эллипса в шаге t: колеблется, но не меньше минимума. */
function blobRadius(b: Blob, t: number): number {
  const k = 1 - (1 - SPOT_MIN_RADIUS) * 0.5 * (1 - Math.sin(b.wr * t + b.pr));
  return b.radius * k;
}

/** Мягкий край: 1 внутри радиуса, плавно до 0 на ширине края. */
function falloff(dist: number, radius: number): number {
  const edge = radius * SPOT_EDGE;
  if (dist <= radius) return 1;
  if (dist >= radius + edge) return 0;
  const u = 1 - (dist - radius) / edge;
  return u * u * (3 - 2 * u);
}

/** Центры эллипсов пятна на карте в шаге t (без общего сдвига карты). */
function blobCenter(s: Spot, b: Blob, t: number, mapW: number, mapH: number): [number, number] {
  return [
    wrap(s.x0 + s.vx * t + b.ax * Math.sin(b.wx * t + b.px), mapW),
    wrap(s.y0 + s.vy * t + b.ay * Math.sin(b.wy * t + b.py), mapH),
  ];
}

/** Доля карты, занятая пятнами в шаге t — оценка по сетке. */
function coverage(spots: readonly Spot[], mapW: number, mapH: number, t: number, cells = 64): number {
  let lit = 0;
  const cw = mapW / cells;
  const ch = mapH / cells;
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      if (spotIntensityOnMap(spots, (i + 0.5) * cw, (j + 0.5) * ch, t, mapW, mapH) >= 0.5) lit++;
    }
  }
  return lit / (cells * cells);
}

function spotIntensityOnMap(spots: readonly Spot[], x: number, y: number, t: number, mapW: number, mapH: number): number {
  let best = 0;
  for (const s of spots) {
    for (const b of s.blobs) {
      const [cx, cy] = blobCenter(s, b, t, mapW, mapH);
      const r = blobRadius(b, t);
      const dx = wrapDelta(x - cx, mapW);
      const dy = wrapDelta(y - cy, mapH);
      const reach = r * (1 + SPOT_EDGE);
      if (Math.abs(dx) > reach || Math.abs(dy) > reach) continue;
      const v = falloff(Math.hypot(dx, dy), r);
      if (v > best) {
        best = v;
        if (best === 1) return 1;
      }
    }
  }
  return best;
}

export function createLightMap(params: WorldParams): LightMap {
  const rng = new Rng(deriveSeed(params.seed, 'light'));
  const mapW = params.width * LIGHT_MAP_SCALE;
  const mapH = params.height * LIGHT_MAP_SCALE;

  // Пятна добавляются, пока доля карты под пятнами не достигнет освещённости.
  const spots: Spot[] = [];
  const meanArea = Math.PI * params.spotSize * params.spotSize;
  const batch = Math.max(1, Math.round((mapW * mapH * params.illumination) / meanArea / 4));
  for (let guard = 0; guard < 200; guard++) {
    for (let k = 0; k < batch; k++) spots.push(makeSpot(rng, mapW, mapH, params.spotSize));
    if (coverage(spots, mapW, mapH, 0) >= params.illumination) break;
  }

  const drift: DriftHarmonic[] = [];
  const w1 = TAU / LIGHT_TURN_PERIOD;
  drift.push({ speed: LIGHT_DRIFT_SPEED * 0.8, w: w1 * rng.range(0.8, 1.2), phase: rng.range(0, TAU) });
  drift.push({ speed: LIGHT_DRIFT_SPEED * 0.4, w: -w1 * GOLDEN * rng.range(0.8, 1.2), phase: rng.range(0, TAU) });

  return {
    mapWidth: mapW,
    mapHeight: mapH,
    spots,
    drift,
    sun: params.sun,
    background: params.backgroundLevel,
  };
}

/**
 * Общий сдвиг карты в шаге t. Скорость — сумма вращающихся векторов, поэтому
 * направление плавно меняется; сдвиг — точный интеграл скорости.
 */
export function lightOffset(map: LightMap, t: number): [number, number] {
  let ox = 0;
  let oy = 0;
  for (const h of map.drift) {
    ox += (h.speed / h.w) * (Math.sin(h.phase + h.w * t) - Math.sin(h.phase));
    oy += (h.speed / h.w) * (Math.cos(h.phase) - Math.cos(h.phase + h.w * t));
  }
  return [ox, oy];
}

/** Скорость сдвига карты в шаге t (вектор, единиц за шаг). */
export function lightDriftVelocity(map: LightMap, t: number): [number, number] {
  let vx = 0;
  let vy = 0;
  for (const h of map.drift) {
    vx += h.speed * Math.cos(h.phase + h.w * t);
    vy += h.speed * Math.sin(h.phase + h.w * t);
  }
  return [vx, vy];
}

/** Интенсивность пятен в точке карты (0 — фон, 1 — пятно). */
export function spotIntensityAtMap(map: LightMap, mx: number, my: number, t: number): number {
  return spotIntensityOnMap(map.spots, wrap(mx, map.mapWidth), wrap(my, map.mapHeight), t, map.mapWidth, map.mapHeight);
}

/** Интенсивность пятен в точке чашки (0 — фон, 1 — пятно). */
export function spotIntensityAt(map: LightMap, x: number, y: number, t: number): number {
  const [ox, oy] = lightOffset(map, t);
  return spotIntensityAtMap(map, x - ox, y - oy, t);
}

/** Свет в точке чашки: фон, свет пятна или переход между ними. */
export function lightFromIntensity(map: LightMap, intensity: number): number {
  return map.sun * (map.background + (1 - map.background) * intensity);
}

export function lightAt(map: LightMap, x: number, y: number, t: number): number {
  return lightFromIntensity(map, spotIntensityAt(map, x, y, t));
}

/**
 * Интенсивность пятен на сетке чашки: `cols × rows` ячеек размером `cell`.
 * Растеризует каждый эллипс только в его окрестности — быстро для отрисовки.
 */
export function rasterizeSpotIntensity(map: LightMap, t: number, cols: number, rows: number, cell: number, out?: Float32Array): Float32Array {
  const field = out && out.length === cols * rows ? out : new Float32Array(cols * rows);
  field.fill(0);
  const [ox, oy] = lightOffset(map, t);
  const W = map.mapWidth;
  const H = map.mapHeight;
  const dishW = cols * cell;
  const dishH = rows * cell;
  for (const s of map.spots) {
    for (const b of s.blobs) {
      const [mx, my] = blobCenter(s, b, t, W, H);
      const r = blobRadius(b, t);
      const reach = r * (1 + SPOT_EDGE);
      // Положение центра в координатах чашки — ближайшая копия на сомкнутой карте.
      const cx0 = wrap(mx + ox, W);
      const cy0 = wrap(my + oy, H);
      for (const cx of [cx0, cx0 - W]) {
        if (cx + reach < 0 || cx - reach > dishW) continue;
        for (const cy of [cy0, cy0 - H]) {
          if (cy + reach < 0 || cy - reach > dishH) continue;
          const i0 = Math.max(0, Math.floor((cx - reach) / cell));
          const i1 = Math.min(cols - 1, Math.floor((cx + reach) / cell));
          const j0 = Math.max(0, Math.floor((cy - reach) / cell));
          const j1 = Math.min(rows - 1, Math.floor((cy + reach) / cell));
          for (let j = j0; j <= j1; j++) {
            const py = (j + 0.5) * cell - cy;
            for (let i = i0; i <= i1; i++) {
              const v = falloff(Math.hypot((i + 0.5) * cell - cx, py), r);
              const k = j * cols + i;
              if (v > field[k]) field[k] = v;
            }
          }
        }
      }
    }
  }
  return field;
}

/** Текущий размер каждого пятна (наибольший радиус его эллипсов) — для проверки «пятно не исчезает». */
export function spotSizes(map: LightMap, t: number): number[] {
  return map.spots.map((s) => Math.max(...s.blobs.map((b) => blobRadius(b, t))));
}

/** Доля чашки под пятнами в шаге t — оценка по сетке. */
export function dishCoverage(map: LightMap, width: number, height: number, t: number, cell = 8): number {
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const f = rasterizeSpotIntensity(map, t, cols, rows, cell);
  let lit = 0;
  for (const v of f) if (v >= 0.5) lit++;
  return lit / f.length;
}

/** Доля всей карты под пятнами в шаге t. */
export function mapCoverage(map: LightMap, t: number): number {
  return coverage(map.spots, map.mapWidth, map.mapHeight, t);
}
