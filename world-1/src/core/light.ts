import { finishCalculation, type Calculation } from './task.ts';
import { dishOf } from './dish.ts';
/**
 * Свет (спецификация, раздел «Свет»): отдельные пятна на фоне тени.
 *
 * Пятно — объект со своим местом, площадью и формой края; площадь постоянна,
 * край медленно «дышит». Все пятна плывут общим дрейфом по замкнутой плоскости
 * размером с чашу (ушедшее за край входит с другой стороны) и проходят друг
 * сквозь друга: их вклады складываются. Направление дрейфа время от времени
 * меняется на случайное, поворот плавный. Свет места — свет в тени плюс вклад
 * пятен, в лм/см², умноженный на ритм солнца.
 *
 * Пятна, сдвиг дрейфа и фаза ритма — состояние мира: advanceLight двигает их
 * по шагам (живая смена законов продолжает от текущего, без скачков), запросы
 * на шаг t чуть впереди состояния продолжают дрейф и ритм от него. Шейдер
 * показа считает то же поле (LIGHT_FIELD_GLSL) по тем же пятнам.
 */
import {
  DRIFT_TURN_STEPS, LIGHT_REFERENCE, MAX_SPOTS, SPOT_EDGE, SPOT_REACH,
} from './constants.ts';
import { deriveSeed, hash3 } from './prng.ts';
import type { RhythmShape, WorldParams } from './params.ts';
import { stepsFromSeconds } from './units.ts';

const TAU = Math.PI * 2;
/** Гармоники края пятна: 2-я…5-я. */
const HARMONICS = 4;

/** Пятно света: центр, радиус круга той же площади (мм), форма края. */
export interface Spot {
  x: number;
  y: number;
  r: number;
  /** Размах гармоник края (доля радиуса), начальные фазы и темп «дыхания» каждой. */
  amps: number[];
  phases: number[];
  rates: number[];
}

/** Законы света — из параметров; меняются в живом мире. */
export interface LightLaws {
  /** Свет в пятне и в тени, лм/см². */
  spot: number;
  shadow: number;
  rhythmAmp: number;
  /** Период ритма, шагов. */
  rhythmPeriod: number;
  rhythmShape: RhythmShape;
  rhythmTransition: number;
  rhythmRise: number;
  /** Скорость дрейфа, мм за шаг (0 — свет стоит); средний промежуток смены направления, шагов (0 — не меняется). */
  speed: number;
  turnEvery: number;
  /** Полный цикл «дыхания» края пятна, шагов. */
  breath: number;
}

export interface LightMap {
  readonly width: number;
  readonly height: number;
  readonly circle: boolean;
  readonly seed: number;
  laws: LightLaws;
  spots: Spot[];
  /** Шаг, к которому приведено состояние. */
  step: number;
  /** Накопленный сдвиг дрейфа, мм. */
  offsetX: number;
  offsetY: number;
  /** Направление дрейфа сейчас; идущий поворот (откуда, куда, начало; turnStart < 0 — не поворачивает). */
  angle: number;
  turnFrom: number;
  turnTo: number;
  turnStart: number;
  /** Когда начнётся следующий поворот и сколько их было. */
  nextTurn: number;
  turns: number;
  /** Фаза ритма солнца и «дыхания» края пятен, радиан: копятся по шагам, поэтому смена периода не даёт скачка. */
  rhythmPhase: number;
  breathPhase: number;
}

const unit = (seed: number, a: number, b: number) => hash3(seed, a, b) / 4294967296;

export function lightLaws(params: WorldParams, width: number): LightLaws {
  const hours = (h: number) => stepsFromSeconds(h * 3600);
  return {
    spot: params.lightShadow + params.lightExtra,
    shadow: params.lightShadow,
    rhythmAmp: params.sunRhythm,
    rhythmPeriod: params.sunPeriod,
    rhythmShape: params.rhythmShape,
    rhythmTransition: params.rhythmTransition,
    rhythmRise: params.rhythmRise,
    speed: params.driftCross > 0 ? width / hours(params.driftCross) : 0,
    turnEvery: params.driftTurn > 0 ? hours(params.driftTurn) : 0,
    breath: hours(params.spotBreath),
  };
}

/** Пятна генератора: число и площадь (см²) — из параметров, места и формы — из сида. */
function createSpots(params: WorldParams, width: number, height: number): Spot[] {
  const s = deriveSeed(params.seed, 'spots');
  const spots: Spot[] = [];
  for (let n = 0; n < params.spotCount; n++) {
    const area = (params.spotAreaMin + (params.spotAreaMax - params.spotAreaMin) * unit(s, n, 0)) * 100; // см² → мм²
    const amps: number[] = [], phases: number[] = [], rates: number[] = [];
    for (let h = 0; h < HARMONICS; h++) {
      amps.push(((0.4 + 0.6 * unit(s, n, 10 + h)) / (h + 2)) * params.spotWobble);
      phases.push(unit(s, n, 20 + h) * TAU);
      rates.push((unit(s, n, 30 + h) < 0.5 ? -1 : 1) * (0.5 + unit(s, n, 40 + h)));
    }
    spots.push({ x: unit(s, n, 1) * width, y: unit(s, n, 2) * height, r: Math.sqrt(area / Math.PI), amps, phases, rates });
  }
  return spots;
}

/** Промежуток до следующего поворота — случайный, в среднем turnEvery. */
function turnGap(map: LightMap): number {
  const u = unit(deriveSeed(map.seed, 'drift-turns'), map.turns, 0);
  return Math.max(1, Math.round(-Math.log(1 - u * 0.999) * map.laws.turnEvery));
}

export function createLightMap(params: WorldParams): LightMap {
  const { width, height, shape } = dishOf(params);
  const seed = params.seed;
  const angle = unit(deriveSeed(seed, 'drift'), 0, 0) * TAU;
  const map: LightMap = {
    width, height, circle: shape === 'circle', seed,
    laws: lightLaws(params, width),
    spots: createSpots(params, width, height),
    step: 0, offsetX: 0, offsetY: 0,
    angle, turnFrom: angle, turnTo: angle, turnStart: -1, nextTurn: 0, turns: 0,
    rhythmPhase: unit(deriveSeed(seed, 'sun'), 0, 0) * TAU,
    breathPhase: 0,
  };
  map.nextTurn = map.laws.turnEvery > 0 ? turnGap(map) : Number.POSITIVE_INFINITY;
  return map;
}

/** Новые законы света в живом мире: действуют с текущего шага, состояние продолжается. */
export function setLightLaws(map: LightMap, params: WorldParams): void {
  const had = map.laws.turnEvery;
  map.laws = lightLaws(params, map.width);
  if (map.laws.turnEvery !== had) map.nextTurn = map.laws.turnEvery > 0 ? map.step + turnGap(map) : Number.POSITIVE_INFINITY;
}

const smooth = (u: number) => u * u * (3 - 2 * u);
const wrapAngle = (a: number) => a - TAU * Math.round(a / TAU);

/** Довести состояние света до шага `step`: дрейф, повороты, фаза ритма. */
export function advanceLight(map: LightMap, step: number): void {
  const L = map.laws;
  const dPhase = TAU / L.rhythmPeriod, dBreath = TAU / L.breath;
  while (map.step < step) {
    const t = ++map.step;
    if (t >= map.nextTurn) {
      map.turnFrom = map.angle;
      map.turnTo = unit(deriveSeed(map.seed, 'drift-turns'), map.turns, 1) * TAU;
      map.turnStart = t;
      map.turns++;
      map.nextTurn = L.turnEvery > 0 ? t + turnGap(map) : Number.POSITIVE_INFINITY;
    }
    if (map.turnStart >= 0) {
      const u = Math.min(1, (t - map.turnStart) / DRIFT_TURN_STEPS);
      map.angle = map.turnFrom + wrapAngle(map.turnTo - map.turnFrom) * smooth(u);
      if (u >= 1) map.turnStart = -1;
    }
    map.offsetX += L.speed * Math.cos(map.angle);
    map.offsetY += L.speed * Math.sin(map.angle);
    map.rhythmPhase = (map.rhythmPhase + dPhase) % TAU;
    // Без заворота по 2π: темпы гармоник дробные, заворот сдвинул бы форму края.
    map.breathPhase += dBreath;
  }
}

/** Сдвиг дрейфа в шаге t: от состояния, впереди — продолжая нынешнее направление. */
function offsetAt(map: LightMap, t: number): [number, number] {
  const dt = t - map.step;
  return [map.offsetX + map.laws.speed * Math.cos(map.angle) * dt, map.offsetY + map.laws.speed * Math.sin(map.angle) * dt];
}

/** Форма волны ритма: −1…1 по фазе. */
function rhythmWave(L: LightLaws, phase: number): number {
  if (L.rhythmShape === 'daynight') {
    // Плато дня и ночи, переход занимает долю периода rhythmTransition.
    const edge = Math.sin(Math.PI * Math.min(0.5, Math.max(0.01, L.rhythmTransition)));
    return Math.max(-1, Math.min(1, Math.sin(phase) / edge));
  }
  if (L.rhythmShape === 'skewed') {
    // Рост занимает долю периода rhythmRise, спад — остальное.
    const u = ((phase / TAU) % 1 + 1) % 1, rise = Math.min(0.95, Math.max(0.05, L.rhythmRise));
    return u < rise ? -Math.cos((Math.PI * u) / rise) : Math.cos((Math.PI * (u - rise)) / (1 - rise));
  }
  return Math.sin(phase);
}

/** Множитель ритма солнца в шаге t: вокруг 1, от (1 − размах) до (1 + размах). */
export function sunRhythmAt(map: LightMap, t: number): number {
  const L = map.laws;
  return 1 + L.rhythmAmp * rhythmWave(L, map.rhythmPhase + (TAU * (t - map.step)) / L.rhythmPeriod);
}

/**
 * Сила солнца в шаге t — свет в пятне с ритмом относительно обычного
 * (LIGHT_REFERENCE): мерило для течений, размыва и показа.
 */
export function sunAt(map: LightMap, t: number): number {
  return (map.laws.spot / LIGHT_REFERENCE) * sunRhythmAt(map, t);
}

/** Свет в тени как доля света в пятне. */
export function lightBackground(map: LightMap): number {
  return map.laws.spot > 0 ? Math.min(1, map.laws.shadow / map.laws.spot) : 1;
}

/** Свет места по вкладу пятен (0 — тень, 1 — пятно, больше — перекрытие), в долях обычного света. */
export function lightFromIntensity(map: LightMap, intensity: number, t: number): number {
  const bg = lightBackground(map);
  return sunAt(map, t) * (bg + (1 - bg) * intensity);
}

/** Вклад одного пятна в точке на расстоянии (dx, dy) от центра, в шаге t. */
/** Фаза «дыхания» края в шаге t: от состояния, впереди — с нынешним периодом. */
function breathAt(map: LightMap, t: number): number {
  return map.breathPhase + (TAU * (t - map.step)) / map.laws.breath;
}

/** Вклад одного пятна в точке на расстоянии (dx, dy) от центра при фазе дыхания w. */
function spotProfile(s: Spot, dx: number, dy: number, w: number): number {
  const d = Math.hypot(dx, dy);
  const e = SPOT_EDGE * s.r;
  if (d > s.r * SPOT_REACH + e) return 0;
  const theta = Math.atan2(dy, dx);
  let rr = 1, sq = 0;
  for (let h = 0; h < HARMONICS; h++) {
    rr += s.amps[h] * Math.cos((h + 2) * theta + s.phases[h] + s.rates[h] * w);
    sq += s.amps[h] * s.amps[h];
  }
  // Нормировка держит площадь пятна постоянной при любой форме края.
  const edge = (s.r * rr) / Math.sqrt(1 + sq / 2);
  const u = (edge + e / 2 - d) / e;
  return u <= 0 ? 0 : u >= 1 ? 1 : smooth(u);
}

const wrap = (d: number, L: number) => d - L * Math.round(d / L);

/** Вклад пятен в точке чашки (0 — тень, 1 — пятно; в перекрытии больше 1). */
export function spotIntensityAt(map: LightMap, x: number, y: number, t: number): number {
  const [ox, oy] = offsetAt(map, t);
  let sum = 0;
  const w = breathAt(map, t);
  for (const s of map.spots) sum += spotProfile(s, wrap(x - s.x - ox, map.width), wrap(y - s.y - oy, map.height), w);
  return sum;
}

/** Вклад пятен сразу во многих точках (x, y подряд в `points`). */
export function spotIntensityAtPoints(map: LightMap, points: Float64Array, t: number, out: Float32Array): Float32Array {
  for (let i = 0; i < out.length; i++) out[i] = spotIntensityAt(map, points[2 * i], points[2 * i + 1], t);
  return out;
}

export function lightAt(map: LightMap, x: number, y: number, t: number): number {
  return lightFromIntensity(map, spotIntensityAt(map, x, y, t), t);
}

/** Скорость дрейфа пятен в клетках (для увлечения среды). */
export interface SpotVelocity {
  readonly vx: Float32Array;
  readonly vy: Float32Array;
}

/**
 * Вклад пятен на сетке чашки: `cols × rows` ячеек размером `cell` (по центрам).
 * С `velocity` — ещё и скорость дрейфа там, где светло.
 */
export function rasterizeSpotIntensity(map: LightMap, t: number, cols: number, rows: number, cell: number, out?: Float32Array, velocity?: SpotVelocity): Float32Array {
  return finishCalculation(rasterizeSpotIntensityTask(map, t, cols, rows, cell, out, velocity));
}

export function* rasterizeSpotIntensityTask(map: LightMap, t: number, cols: number, rows: number, cell: number, out?: Float32Array, velocity?: SpotVelocity): Calculation<Float32Array> {
  const field = out && out.length === cols * rows ? out : new Float32Array(cols * rows);
  field.fill(0);
  const [ox, oy] = offsetAt(map, t);
  const { width: W, height: H } = map;
  const w = breathAt(map, t);
  for (const s of map.spots) {
    yield;
    // Обходим только рамку пятна; на замкнутой плоскости рамка может переходить край.
    const reach = s.r * SPOT_REACH + SPOT_EDGE * s.r;
    const cx = ((s.x + ox) % W + W) % W, cy = ((s.y + oy) % H + H) % H;
    const i0 = Math.floor((cx - reach) / cell), i1 = Math.ceil((cx + reach) / cell);
    const j0 = Math.floor((cy - reach) / cell), j1 = Math.ceil((cy + reach) / cell);
    const seen = i1 - i0 >= cols || j1 - j0 >= rows ? new Uint8Array(cols * rows) : null;
    for (let j = j0; j <= j1; j++) {
      const py = (j + 0.5) * cell, jj = ((Math.floor(wrapCoord(py, H) / cell)) % rows + rows) % rows;
      for (let i = i0; i <= i1; i++) {
        const px = (i + 0.5) * cell, ii = ((Math.floor(wrapCoord(px, W) / cell)) % cols + cols) % cols;
        const k = jj * cols + ii;
        if (seen) { if (seen[k]) continue; seen[k] = 1; }
        const v = spotProfile(s, wrap(px - cx, W), wrap(py - cy, H), w);
        if (v > 0) field[k] += v;
      }
    }
  }
  if (velocity) {
    const sx = map.laws.speed * Math.cos(map.angle), sy = map.laws.speed * Math.sin(map.angle);
    for (let k = 0; k < field.length; k++) {
      const lit = field[k] > 0;
      velocity.vx[k] = lit ? sx : 0;
      velocity.vy[k] = lit ? sy : 0;
    }
  }
  return field;
}

const wrapCoord = (v: number, L: number) => ((v % L) + L) % L;

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

/** Скорость дрейфа пятен, мм за шаг (для подписи в сводке). */
export function meanSpotSpeed(map: LightMap, _t: number): number {
  return map.spots.length > 0 ? map.laws.speed : 0;
}

/** Пятна для шейдера (LIGHT_FIELD_GLSL) в шаге t: центр со сдвигом, радиус, гармоники края с фазой. */
export function lightFieldUniforms(map: LightMap, t: number): { plane: [number, number]; count: number; spots: Float32Array; amps: Float32Array; phases: Float32Array } {
  const n = Math.min(MAX_SPOTS, map.spots.length);
  const spots = new Float32Array(MAX_SPOTS * 4), amps = new Float32Array(MAX_SPOTS * 4), phases = new Float32Array(MAX_SPOTS * 4);
  const [ox, oy] = offsetAt(map, t);
  const w = breathAt(map, t);
  for (let i = 0; i < n; i++) {
    const s = map.spots[i];
    let sq = 0;
    for (let h = 0; h < HARMONICS; h++) {
      amps[4 * i + h] = s.amps[h];
      phases[4 * i + h] = ((s.phases[h] + s.rates[h] * w) % TAU + TAU) % TAU;
      sq += s.amps[h] * s.amps[h];
    }
    spots[4 * i] = wrapCoord(s.x + ox, map.width);
    spots[4 * i + 1] = wrapCoord(s.y + oy, map.height);
    spots[4 * i + 2] = s.r;
    spots[4 * i + 3] = 1 / Math.sqrt(1 + sq / 2);
  }
  return { plane: [map.width, map.height], count: n, spots, amps, phases };
}

/**
 * То же поле в GLSL (для маски света на GPU): `lightField(w)` — вклад пятен в
 * точке мира (больше 1 в перекрытии). Униформы: u_lightPlane, u_spotCount,
 * u_spots[i] = (x, y, радиус, нормировка), u_spotAmps[i], u_spotPhases[i].
 */
export const LIGHT_FIELD_GLSL = `
#define MAX_SPOTS ${MAX_SPOTS}
uniform vec2 u_lightPlane;
uniform int u_spotCount;
uniform vec4 u_spots[MAX_SPOTS];
uniform vec4 u_spotAmps[MAX_SPOTS];
uniform vec4 u_spotPhases[MAX_SPOTS];
float lightField(vec2 w) {
  float sum = 0.;
  for (int i = 0; i < MAX_SPOTS; i++) {
    if (i >= u_spotCount) break;
    vec4 s = u_spots[i];
    vec2 d = w - s.xy;
    d -= u_lightPlane * floor(d / u_lightPlane + .5);
    float r = length(d), e = ${SPOT_EDGE.toFixed(3)} * s.z;
    if (r > s.z * ${SPOT_REACH.toFixed(3)} + e) continue;
    float th = atan(d.y, d.x);
    vec4 a = u_spotAmps[i], p = u_spotPhases[i];
    float rr = 1. + a.x * cos(2. * th + p.x) + a.y * cos(3. * th + p.y) + a.z * cos(4. * th + p.z) + a.w * cos(5. * th + p.w);
    float edge = s.z * rr * s.w;
    sum += smoothstep(0., 1., (edge + e * .5 - r) / e);
  }
  return sum;
}`;
