/**
 * Карта света (спецификация, раздел «Свет»): светлые пятна на тёмном фоне.
 *
 * Реализация: пятно — группа мягких эллипсов с минимальным размером, поэтому
 * пятно не исчезает. Эллипсы вытянуты, медленно вращаются, край у них волнистый. Свет пятен в точке — максимум по
 * эллипсам, поэтому яркость не складывается. Эллипсы группы колеблются
 * относительно центра пятна — пятно вытягивается, делится и сливается обратно;
 * у каждого пятна свой медленный дрейф — разные пятна встречаются и сливаются.
 * Карта больше чашки, координаты по модулю её размера — края сомкнуты.
 *
 * Всё движение — формулы от номера шага: свет на любом шаге считается сразу.
 */
import {
  DISH_HEIGHT, DISH_WIDTH,
  LIGHT_DRIFT_SPEED, LIGHT_MAP_SCALE, LIGHT_TURN_PERIOD, SPOT_ASPECT_MAX, SPOT_EDGE, SPOT_EDGE_WAVE, SPOT_MAX_BLOBS, SPOT_SPIN_PERIOD,
  SPOT_MIN_RADIUS, SPOT_OWN_DRIFT, SPOT_SIZE_MAX, SPOT_SIZE_MIN, SPOT_SIZE_SPREAD,
  SPOT_WOBBLE_PERIOD, SPOT_WOBBLE_REACH,
} from './constants.ts';
import { Rng, deriveSeed } from './prng.ts';
import type { WorldParams } from './params.ts';

const TAU = Math.PI * 2;
const GOLDEN = 1.6180339887;

interface Blob {
  /** Базовый радиус (средний; полуоси — radius·√aspect и radius/√aspect). */
  radius: number;
  /** Вытянутость: отношение полуосей, ≥ 1. */
  aspect: number;
  /** Поворот эллипса: начальный угол и угловая скорость. */
  a0: number; wa: number;
  /** Волны края: две гармоники по углу (3 и 5 горбов) — амплитуда, фаза, скорость смены. */
  e3: number; p3: number; w3: number;
  e5: number; p5: number; w5: number;
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
  /** Ритм солнца: размах, период (шагов) и фаза из сида. */
  readonly rhythm: { readonly amp: number; readonly period: number; readonly phase: number };
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
    const wave3 = SPOT_EDGE_WAVE * rng.range(0.3, 0.7);
    blobs.push({
      radius: radius * (j === 0 ? 1 : rng.range(0.5, 0.9)),
      aspect: rng.range(1, SPOT_ASPECT_MAX),
      a0: rng.range(0, TAU), wa: (TAU / (SPOT_SPIN_PERIOD * rng.range(0.6, 1.6))) * (rng.next() < 0.5 ? -1 : 1),
      e3: wave3, p3: rng.range(0, TAU), w3: w() * 0.5,
      e5: SPOT_EDGE_WAVE - wave3, p5: rng.range(0, TAU), w5: w() * 0.7,
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

/** Наибольшая полуось эллипса в шаге t. */
function blobMajor(b: Blob, t: number): number {
  return blobRadius(b, t) * Math.sqrt(b.aspect);
}

/** Радиус, дальше которого эллипс заведомо не светит (с волнами и краем). */
function blobReach(b: Blob, t: number): number {
  return blobMajor(b, t) * (1 + SPOT_EDGE_WAVE) * (1 + SPOT_EDGE);
}

/**
 * Свет эллипса в точке, заданной смещением (dx, dy) от его центра: 1 внутри,
 * плавно до 0 на краю. Край волнистый: граница по углу — 1 ± волны.
 */
function blobIntensity(b: Blob, dx: number, dy: number, t: number): number {
  const r = blobRadius(b, t);
  const k = Math.sqrt(b.aspect);
  const angle = b.a0 + b.wa * t;
  const c = Math.cos(angle);
  const sn = Math.sin(angle);
  const u = (dx * c + dy * sn) / (r * k);
  const v = (-dx * sn + dy * c) * k / r;
  const phi = Math.atan2(v, u);
  const bound = 1 + b.e3 * Math.sin(3 * phi + b.p3 + b.w3 * t) + b.e5 * Math.sin(5 * phi + b.p5 + b.w5 * t);
  return falloff(Math.hypot(u, v), bound);
}

/** Центры эллипсов пятна на карте в шаге t (без общего сдвига карты). */
function blobCenter(s: Spot, b: Blob, t: number, mapW: number, mapH: number): [number, number] {
  return [
    wrap(s.x0 + s.vx * t + b.ax * Math.sin(b.wx * t + b.px), mapW),
    wrap(s.y0 + s.vy * t + b.ay * Math.sin(b.wy * t + b.py), mapH),
  ];
}

/** Доля карты, занятая пятнами в шаге t — оценка по сетке. */
/**
 * Доля карты под пятнами в момент t — по сетке `cells × cells`. Каждый эллипс
 * обновляет только клетки в своей окрестности, поэтому пятна можно добавлять
 * порциями без пересчёта всей карты.
 */
class CoverageGrid {
  private readonly field: Float32Array;
  private readonly cw: number;
  private readonly ch: number;
  private lit = 0;
  private readonly cells: number;
  private readonly mapW: number;
  private readonly mapH: number;
  private readonly t: number;

  constructor(mapW: number, mapH: number, t: number, cells = 128) {
    this.cells = cells;
    this.mapW = mapW;
    this.mapH = mapH;
    this.t = t;
    this.field = new Float32Array(cells * cells);
    this.cw = mapW / cells;
    this.ch = mapH / cells;
  }

  add(spot: Spot): void {
    const { cells, cw, ch, t, field } = this;
    for (const b of spot.blobs) {
      const [cx, cy] = blobCenter(spot, b, t, this.mapW, this.mapH);
      const reach = blobReach(b, t);
      const i0 = Math.floor((cx - reach) / cw), i1 = Math.ceil((cx + reach) / cw);
      const j0 = Math.floor((cy - reach) / ch), j1 = Math.ceil((cy + reach) / ch);
      for (let jj = j0; jj <= Math.min(j1, j0 + cells - 1); jj++) {
        const j = wrap(jj, cells);
        const dy = wrapDelta((j + 0.5) * ch - cy, this.mapH);
        for (let ii = i0; ii <= Math.min(i1, i0 + cells - 1); ii++) {
          const i = wrap(ii, cells);
          const k = j * cells + i;
          if (field[k] >= 0.5) continue;
          const v = blobIntensity(b, wrapDelta((i + 0.5) * cw - cx, this.mapW), dy, t);
          if (v > field[k]) {
            field[k] = v;
            if (v >= 0.5) this.lit++;
          }
        }
      }
    }
  }

  get share(): number {
    return this.lit / (this.cells * this.cells);
  }
}

function coverage(spots: readonly Spot[], mapW: number, mapH: number, t: number): number {
  const grid = new CoverageGrid(mapW, mapH, t);
  for (const s of spots) grid.add(s);
  return grid.share;
}

function spotIntensityOnMap(spots: readonly Spot[], x: number, y: number, t: number, mapW: number, mapH: number): number {
  let best = 0;
  for (const s of spots) {
    for (const b of s.blobs) {
      const [cx, cy] = blobCenter(s, b, t, mapW, mapH);
      const dx = wrapDelta(x - cx, mapW);
      const dy = wrapDelta(y - cy, mapH);
      const reach = blobReach(b, t);
      if (Math.abs(dx) > reach || Math.abs(dy) > reach) continue;
      const v = blobIntensity(b, dx, dy, t);
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
  const mapW = DISH_WIDTH * LIGHT_MAP_SCALE;
  const mapH = DISH_HEIGHT * LIGHT_MAP_SCALE;

  // Пятна добавляются, пока доля карты под пятнами не достигнет освещённости.
  const spots: Spot[] = [];
  const meanArea = Math.PI * params.spotSize * params.spotSize;
  const batch = Math.max(1, Math.round((mapW * mapH * params.illumination) / meanArea / 4));
  const grid = new CoverageGrid(mapW, mapH, 0);
  for (let guard = 0; guard < 200; guard++) {
    for (let k = 0; k < batch; k++) {
      const spot = makeSpot(rng, mapW, mapH, params.spotSize);
      spots.push(spot);
      grid.add(spot);
    }
    if (grid.share >= params.illumination) break;
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
    rhythm: { amp: params.sunRhythm, period: params.sunPeriod, phase: (deriveSeed(params.seed, 'sun') / 4294967296) * TAU },
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
      const reach = blobReach(b, t);
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
              const v = blobIntensity(b, (i + 0.5) * cell - cx, py, t);
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

/**
 * Текущий размер каждого пятна — наименьшая возможная полуось его крупнейшего
 * эллипса с учётом волн края. Для проверки «пятно не исчезает».
 */
export function spotSizes(map: LightMap, t: number): number[] {
  return map.spots.map((s) => Math.max(...s.blobs.map((b) => (blobRadius(b, t) / Math.sqrt(b.aspect)) * (1 - b.e3 - b.e5))));
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

/**
 * Контуры пятен для векторной отрисовки: для каждого эллипса (и его копий у
 * сомкнутых краёв карты), видимого в чашке, — замкнутый многоугольник в
 * координатах чашки, плоским массивом [x0, y0, x1, y1, …]. Контур проходит
 * по середине размытого края; мягкость края отрисовка добавляет размытием.
 */
export function spotOutlines(map: LightMap, t: number, dishW: number, dishH: number, segments = 48): Float64Array[] {
  const [ox, oy] = lightOffset(map, t);
  const W = map.mapWidth;
  const H = map.mapHeight;
  const out: Float64Array[] = [];
  const middle = 1 + SPOT_EDGE / 2;
  for (const s of map.spots) {
    for (const b of s.blobs) {
      const [mx, my] = blobCenter(s, b, t, W, H);
      const reach = blobReach(b, t);
      const cx0 = wrap(mx + ox, W);
      const cy0 = wrap(my + oy, H);
      const r = blobRadius(b, t);
      const k = Math.sqrt(b.aspect);
      const angle = b.a0 + b.wa * t;
      const c = Math.cos(angle);
      const sn = Math.sin(angle);
      for (const cx of [cx0, cx0 - W]) {
        if (cx + reach < 0 || cx - reach > dishW) continue;
        for (const cy of [cy0, cy0 - H]) {
          if (cy + reach < 0 || cy - reach > dishH) continue;
          const poly = new Float64Array(segments * 2);
          for (let i = 0; i < segments; i++) {
            const phi = (i / segments) * TAU;
            const bound = (1 + b.e3 * Math.sin(3 * phi + b.p3 + b.w3 * t) + b.e5 * Math.sin(5 * phi + b.p5 + b.w5 * t)) * middle;
            // Точка в нормированных осях эллипса → повернуть и растянуть в мир.
            const u = bound * Math.cos(phi) * r * k;
            const v = (bound * Math.sin(phi) * r) / k;
            poly[i * 2] = cx + u * c - v * sn;
            poly[i * 2 + 1] = cy + u * sn + v * c;
          }
          out.push(poly);
        }
      }
    }
  }
  return out;
}

/**
 * Точки на внешнем краю пятен (где свет пятна сошёл до фона) — отсюда
 * начинаются течения. У каждого эллипса пятна их постоянное число, примерно
 * через `spacing` единиц по краю, и они движутся вместе с пятном, поэтому
 * порядок точек от шага к шагу сохраняется. Плоский массив x, y, … в
 * координатах чашки, с копиями у сомкнутых краёв.
 */
export function spotAnchors(map: LightMap, t: number, dishW: number, dishH: number, spacing: number): Float64Array {
  const [ox, oy] = lightOffset(map, t);
  const W = map.mapWidth;
  const H = map.mapHeight;
  const out: number[] = [];
  const outer = 1 + SPOT_EDGE;
  for (const s of map.spots) {
    for (const b of s.blobs) {
      const [mx, my] = blobCenter(s, b, t, W, H);
      const reach = blobReach(b, t);
      const cx0 = wrap(mx + ox, W);
      const cy0 = wrap(my + oy, H);
      const r = blobRadius(b, t);
      const k = Math.sqrt(b.aspect);
      const angle = b.a0 + b.wa * t;
      const c = Math.cos(angle);
      const sn = Math.sin(angle);
      // Число точек — от базового размера эллипса, а не от текущего: не меняется со временем.
      const count = Math.max(3, Math.round((TAU * b.radius * outer) / spacing));
      for (const cx of [cx0, cx0 - W]) {
        if (cx + reach < 0 || cx - reach > dishW) continue;
        for (const cy of [cy0, cy0 - H]) {
          if (cy + reach < 0 || cy - reach > dishH) continue;
          for (let i = 0; i < count; i++) {
            const phi = (i / count) * TAU;
            const bound = (1 + b.e3 * Math.sin(3 * phi + b.p3 + b.w3 * t) + b.e5 * Math.sin(5 * phi + b.p5 + b.w5 * t)) * outer;
            const u = bound * Math.cos(phi) * r * k;
            const v = (bound * Math.sin(phi) * r) / k;
            out.push(cx + u * c - v * sn, cy + u * sn + v * c);
          }
        }
      }
    }
  }
  return Float64Array.from(out);
}

