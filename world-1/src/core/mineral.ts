/**
 * Минерал (спецификация, раздел «Минерал»): постоянное количество, переходит
 * между средой, телами, останками, недрами и залежами. Здесь — среда, залежи и
 * недра (тел и останков пока нет): растворённый минерал на сетке, снос несёт
 * его, избыток оседает в залежи, вулканы редко и
 * нерегулярно выбрасывают минерал из недр — по одному за раз, каждое
 * извержение длится своё время и выбрасывает своё количество.
 *
 * Это состояние мира: обновляется раз в MINERAL_PERIOD шагов на фиксированных
 * шагах, поэтому ход мира не зависит от скорости показа. Перенос сносом
 * сохраняет количество: минерал клетки делится между клетками вокруг точки
 * назначения; в перегородки не попадает.
 */
import { finishCalculation, type Calculation } from './task.ts';
import {
  ERUPTION_DURATION, ERUPTION_RADIUS, ERUPTION_RADIUS_MIN, ERUPTION_SHARE, ERUPTION_BURST, ERUPTION_TAIL_AREA, ERUPTION_BURSTS_MAX, BURST_WIDTH, BURST_FROM, THROW_RAYS, THROW_SAMPLES, MINERAL_SPREAD,
  MINERAL_CELL, MINERAL_PERIOD, MINERAL_SETTLE, MINERAL_SINK_SETTLE, MINERAL_LAYER, MINERAL_MOBILITY, TRANSPORT_SUBSTEPS, DRIFT_REFERENCE, TURBIDITY, EROSION, EROSION_THRESHOLD, GROUND_PER_LEVEL, RUNOFF, SAND_RATE, SAND_THRESHOLD, SAND_TOP, SAND_UNDER, SLUMP_RATE, SLUMP_SLOPE,
  FUNNEL_DEPOSIT, FUNNEL_SHAPE, FUNNEL_MIN_CELLS, FUNNEL_HOLE_SHARE, FUNNEL_RAMP, FUNNEL_REACH, FUNNEL_DRAW, FUNNEL_LIFT, FUNNEL_SINK, DEPOSIT_DISSOLVE, ERUPTION_MAX, ERUPTION_PRESSURE, ERUPTION_DURATION_SCALE, GENESIS_SPEEDUP,
  VOLCANO_MIN_GAP, VOLCANO_POWER, VOLCANO_BIRTH, VOLCANO_MATURE, VOLCANO_EXTINCT_CHANCE, VOLCANO_WAKE_CHANCE, VOLCANO_DORMANT_LIFE, VOLCANO_FADE, VOLCANO_DEPOSIT_AVOID,
} from './constants.ts';
import type { Drift } from './drift.ts';
import { sunAt, type LightMap } from './light.ts';
import { moveGround, type TerrainState } from './terrain.ts';
import type { WorldParams } from './params.ts';
import { cellInsideDish, dishOf } from './dish.ts';
import { freeRegions, isBlocked, type PartitionLayout } from './partitions.ts';
import { Rng, deriveSeed, hash3 } from './prng.ts';
import { multiplierForLevel } from './viscosity.ts';
import { pushFieldTask, type PushField } from './push.ts';
import { phase } from './profile.ts';

/**
 * Стадия вулкана: готовится к выбросу (родился или проснулся), извергается,
 * спит (может проснуться снова), потух (тускнеет и исчезает).
 */
export type VolcanoStage = 'preparing' | 'erupting' | 'dormant' | 'extinct';
export const VOLCANO_STAGES: readonly VolcanoStage[] = ['preparing', 'erupting', 'dormant', 'extinct'];

export interface Volcano {
  /** Номер рождения — постоянный, чтобы показ узнавал вулкан. */
  readonly id: number;
  readonly x: number;
  readonly y: number;
  /** Мощность — случайная при рождении: множитель доли выброса. */
  readonly power: number;
  stage: VolcanoStage;
  /**
   * С какого шага идёт стадия и до какого: подготовка — до созревания,
   * сон — до потухания, потух — до исчезновения; у извержения — begin/until.
   */
  stageAt: number;
  stageUntil: number;
  /** Готовится впервые (только родился), а не проснулся. */
  fresh: boolean;
  /** Радиус выброса идущего (или последнего) извержения — в «вязком» расстоянии (см. viscousDistances). */
  radius: number;
  /** Сколько раз извергался (включая идущее). */
  k: number;
  /** Идущее извержение: с какого и до какого шага; сколько выбросит всего и сколько ещё осталось. */
  begin: number;
  until: number;
  total: number;
  left: number;
  /** Выброс за шаг сейчас — для показа. */
  rate: number;
}

/**
 * Воронка — отверстие в недра в плоскости дна там, где скопилось
 * сверхплотное. Место и форма — с рождения; сила медленно растёт (сгущается)
 * и спадает (тает).
 */
export interface Funnel {
  /** Номер рождения — постоянный, чтобы показ узнавал воронку. */
  readonly id: number;
  /** Ядро — самая густая клетка скопления при рождении; ареол — радиус от ядра. */
  readonly x: number;
  readonly y: number;
  readonly reach: number;
  /** Клетки отверстия. */
  readonly cells: Int32Array;
  /** Сила 0…1; сгущается (в ареоле есть сверхплотное) или тает. */
  strength: number;
  forming: boolean;
}

/** Числа воронки — для файла мира и контрольной суммы. */
export function funnelNumbers(f: Funnel): number[] {
  return [f.id, f.x, f.y, f.reach, f.strength, f.forming ? 1 : 0, ...f.cells];
}

/** Воронка из чисел funnelNumbers; null — числа негодные. */
export function funnelFromNumbers(m: MineralState, n: unknown): Funnel | null {
  if (!Array.isArray(n) || n.length < 7 || !n.every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
  const [id, x, y, reach, strength, forming, ...cells] = n as number[];
  if (!Number.isSafeInteger(id) || reach <= 0 || strength < 0 || strength > 1 || (forming !== 0 && forming !== 1)) return null;
  if (!cells.every((k) => Number.isInteger(k) && k >= 0 && k < m.field.length && !m.blocked[k])) return null;
  return { id, x, y, reach, cells: Int32Array.from(cells), strength, forming: forming === 1 };
}

/** Числа вулкана — для файла мира и контрольной суммы (без клеток круга — они выводятся). */
export function volcanoNumbers(v: Volcano): number[] {
  return [v.id, v.x, v.y, v.power, VOLCANO_STAGES.indexOf(v.stage), v.stageAt, v.stageUntil, v.fresh ? 1 : 0, v.k, v.begin, v.until, v.total, v.left, v.rate];
}

/** Вулкан из чисел volcanoNumbers; null — числа негодные. */
export function volcanoFromNumbers(m: MineralState, params: WorldParams, n: unknown): Volcano | null {
  if (!Array.isArray(n) || n.length !== 14 || !n.every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
  const [id, x, y, power, stage, stageAt, stageUntil, fresh, k, begin, until, total, left, rate] = n as number[];
  if (!Number.isSafeInteger(id) || !Number.isInteger(stage) || stage < 0 || stage > 3 || (fresh !== 0 && fresh !== 1) || !Number.isSafeInteger(k)) return null;
  if (x < 0 || y < 0 || x >= dishOf(params).width || y >= dishOf(params).height || power <= 0 || total < 0 || left < 0) return null;
  const v: Volcano = { id, x, y, power, stage: VOLCANO_STAGES[stage], stageAt, stageUntil, fresh: fresh === 1, radius: 0, k, begin, until, total, left, rate };
  // Радиус выброса не хранится — выводится из объёма идущего извержения.
  if (v.stage === 'erupting') v.radius = eruptionRadius(m, params, v.total);
  return v;
}

export interface MineralState {
  readonly cols: number;
  readonly rows: number;
  readonly cell: number;
  /** Растворённый минерал в клетке (количество, не плотность). */
  field: Float64Array;
  /** Минерал в недрах. */
  depths: number;
  /** Порог давления недр: когда недр больше — начинается извержение; и сколько извержений было. */
  threshold: number;
  eruptions: number;
  /** Идёт стартовая серия извержений: с сотворения, пока давление недр впервые не упадёт ниже порога. */
  genesis: boolean;
  /** Живые вулканы (и потухшие, пока не исчезли); сколько раз выбирали следующий вулкан — счётчик случайности. */
  volcanoes: Volcano[];
  births: number;
  /** Воронки; сколько их родилось — счётчик номеров. */
  funnels: Funnel[];
  funnelBirths: number;
  /**
   * Течения от вулканов и воронок (из жерла и в воронку) на сетке минерала —
   * складываются с течениями от света; пересчитываются при каждом обновлении
   * по текущему состоянию (не хранятся). null — нет.
   */
  flow: { vx: Float32Array; vy: Float32Array } | null;
  /** Растёт при каждом обновлении — чтобы показ знал, что пора перерисовать. */
  version: number;
  /** Неизменное: занятые клетки и отсек клетки (-1 — занята). */
  readonly blocked: Uint8Array;
  /** Клетки не дальше NEAR_WALL клеток от перегородки или стенки — там перенос проверяет путь. */
  readonly nearWall: Uint8Array;
  readonly region: Int32Array;
  /** Сколько свободной площади — для пересчёта количества в плотность. */
  readonly freeArea: number;
}

/** Реальные переносы последнего обновления; только для показа, не входят в файл и хеш. */
export interface MineralProcesses {
  step: number;
  vx: Float32Array;
  vy: Float32Array;
  erosion: Float32Array;
  settling: Float32Array;
  sinking: Float32Array;
}

export function mineralProcesses(m: MineralState): MineralProcesses {
  return workspace(m).processes;
}

/** Рабочая память не входит в состояние и файл мира. */
/** Накопленные наблюдаемые потоки; не входят в состояние, хеш или сохранение. */
export interface MineralExchanges { emitted: number; funnelSunk: number }
export function mineralExchanges(m: MineralState): MineralExchanges { return workspace(m).exchanges; }

/**
 * Изменения грунта от течений и осыпания, накопленные с прошлого запроса —
 * только для показа (не состояние, не хеш, не файл): сколько грунта течения
 * подняли с клетки (`lift`), насколько грунт клетки изменили они (`net`) и
 * тектоника (`tectonic`), за `steps` шагов.
 */
export interface GroundChanges { lift: Float32Array; net: Float32Array; tectonic: Float32Array; steps: number }
/** Забрать накопленные изменения грунта (копии) и начать копить заново. */
export function takeGroundChanges(m: MineralState): GroundChanges {
  const g = workspace(m).groundChanges;
  const out = { lift: g.lift.slice(), net: g.net.slice(), tectonic: g.tectonic.slice(), steps: g.steps };
  g.lift.fill(0); g.net.fill(0); g.tectonic.fill(0); g.steps = 0;
  return out;
}

interface MineralWork {
  exchanges: MineralExchanges;
  dst: Float64Array;
  runoff: Float64Array;
  spread: Float64Array;
  speed: Float32Array;
  flowX: Float32Array;
  flowY: Float32Array;
  tvx: Float32Array;
  tvy: Float32Array;
  pushX: Float32Array;
  pushY: Float32Array;
  holes: Uint8Array;
  seen: Uint8Array;
  /** Грунт после переноса и осыпания (считается от снимка). */
  ground: Float64Array;
  groundChanges: GroundChanges;
  processes: MineralProcesses;
}
const workspaces = new WeakMap<MineralState, MineralWork>();
const mobilities = new WeakMap<Float32Array, Float64Array>();
const basins = new WeakMap<Funnel, Int32Array>();

function workspace(m: MineralState): MineralWork {
  let work = workspaces.get(m);
  if (!work) {
    const n = m.field.length;
    work = {
      exchanges: { emitted: 0, funnelSunk: 0 },
      dst: new Float64Array(n), runoff: new Float64Array(n), spread: new Float64Array(n),
      speed: new Float32Array(n), flowX: new Float32Array(n), flowY: new Float32Array(n),
      tvx: new Float32Array(n), tvy: new Float32Array(n), pushX: new Float32Array(n), pushY: new Float32Array(n),
      holes: new Uint8Array(n), seen: new Uint8Array(n), ground: new Float64Array(n),
      groundChanges: { lift: new Float32Array(n), net: new Float32Array(n), tectonic: new Float32Array(n), steps: 0 },
      processes: { step: 0, vx: new Float32Array(n), vy: new Float32Array(n),
        erosion: new Float32Array(n), settling: new Float32Array(n), sinking: new Float32Array(n) },
    };
    workspaces.set(m, work);
  }
  return work;
}

function mobilityFor(level: Float32Array): Float64Array {
  let result = mobilities.get(level);
  if (!result) {
    result = Float64Array.from(level, multiplierForLevel);
    mobilities.set(level, result);
  }
  return result;
}

/** Насколько далеко (клеток) от преграды проверять путь переноса: дальше, чем течение уносит за обновление. */
const NEAR_WALL = 6;

function nearWalls(blocked: Uint8Array, cols: number, rows: number): Uint8Array {
  const out = new Uint8Array(blocked.length);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      let near = 0;
      for (let dj = -NEAR_WALL; dj <= NEAR_WALL && !near; dj++) {
        for (let di = -NEAR_WALL; di <= NEAR_WALL; di++) {
          const a = i + di, b = j + dj;
          if (a < 0 || b < 0 || a >= cols || b >= rows || blocked[b * cols + a]) { near = 1; break; }
        }
      }
      out[j * cols + i] = near;
    }
  }
  return out;
}

export function createMineral(params: WorldParams, partitions: PartitionLayout): MineralState {
  const cell = MINERAL_CELL;
  const cols = Math.ceil(partitions.dish.width / cell), rows = Math.ceil(partitions.dish.height / cell);
  const n = cols * rows;
  const blocked = new Uint8Array(n);
  const region = new Int32Array(n).fill(-1);
  const { labels } = freeRegions(partitions);
  let freeCells = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      const x = (i + 0.5) * cell, y = (j + 0.5) * cell;
      if (!cellInsideDish(partitions.dish, i * cell, j * cell, cell) || isBlocked(partitions, x, y)) { blocked[k] = 1; continue; }
      region[k] = labels[Math.floor(y / partitions.cell) * partitions.cols + Math.floor(x / partitions.cell)];
      freeCells++;
    }
  }
  const freeArea = freeCells * cell * cell;
  const total = params.mineralStock * freeArea;

  // При сотворении весь минерал (кроме грунта) — в недрах: вода чистая,
  // минерал приходит в среду только извержениями.
  const field = new Float64Array(n);

  const threshold = total * ERUPTION_PRESSURE * (0.5 + hash3(deriveSeed(params.seed, 'eruptions'), -1, 4) / 4294967296);
  return { cols: cols, rows: rows, cell, field, depths: total, threshold, eruptions: 0, genesis: true, volcanoes: [], births: 0, funnels: [], funnelBirths: 0, flow: null, version: 0, blocked, nearWall: nearWalls(blocked, cols, rows), region, freeArea };
}

/**
 * Обновление минерала за промежуток (step − MINERAL_PERIOD, step]: снос,
 * осаждение, наступившие извержения — в порядке шага мира.
 */
export function updateMineral(m: MineralState, params: WorldParams, drift: Drift, partitions: PartitionLayout, terrain: TerrainState, light: LightMap, step: number): void {
  finishCalculation(updateMineralTask(m, params, drift, partitions, terrain, light, step));
}

/** Горячая арифметика отдельно от планировщика: обычная функция оптимизируется JIT. */
function transportRange(m: MineralState, src: Float64Array, dst: Float64Array, holes: Uint8Array, mobility: Float64Array, tvx: Float32Array, tvy: Float32Array, P: number, first: number, last: number): void {
  const { cols, rows, cell, blocked } = m;
  const inv = 1 / cell, width = cols * cell, height = rows * cell;
  for (let k = first; k < last; k++) {
    if (blocked[k]) continue;
    const amount = src[k];
    if (amount === 0) continue;
    if (holes[k]) { dst[k] += amount; continue; }
    const flow = Math.sqrt(tvx[k] * tvx[k] + tvy[k] * tvy[k]);
    if (flow === 0) { dst[k] += amount; continue; }
    // Слоистость: уносится не больше слоя; толщина растёт с силой течения и
    // падает с вязкостью: в воде уносится почти всё, на суше — почти ничего.
    const mob = mobility[k];
    const layer = (MINERAL_LAYER * MINERAL_MOBILITY * flow * P * cell * cell) / (mob * mob);
    const moved = Math.min(amount, layer);
    dst[k] += amount - moved;
    const i = k % cols, j = (k - i) / cols;
    let x = (i + 0.5) * cell, y = (j + 0.5) * cell;
    // Медленное течение за обновление сдвигает меньше клетки — хватит одного шага; быстрое — шажками по клетке.
    const subs = Math.min(TRANSPORT_SUBSTEPS, Math.max(1, Math.ceil((flow * P) / cell)));
    const dt = P / subs;
    if (subs === 1) {
      // Старт точно в центре клетки: билинейное чтение даёт её собственный узел.
      const nx = x + tvx[k] * dt, ny = y + tvy[k] * dt;
      if (nx >= 0 && ny >= 0 && nx < cols * cell && ny < rows * cell
        && !blocked[Math.floor(ny / cell) * cols + Math.floor(nx / cell)]) {
        x = nx; y = ny;
        const target = Math.floor(y / cell) * cols + Math.floor(x / cell);
        if (holes[target]) { dst[target] += moved; continue; }
      }
      spill(dst, blocked, cols, rows, cell, x, y, moved, k);
      continue;
    }
    for (let q = 0; q < subs; q++) {
      // Течение в точке — билинейно по клеткам. Координаты неотрицательны: `| 0` вместо floor.
      let fx = x * inv - 0.5, fy = y * inv - 0.5;
      fx = fx < 0 ? 0 : fx > cols - 1 ? cols - 1 : fx;
      fy = fy < 0 ? 0 : fy > rows - 1 ? rows - 1 : fy;
      const a0 = fx | 0, b0 = fy | 0;
      const u = fx - a0, w = fy - b0;
      const c00 = b0 * cols + a0, c10 = a0 + 1 < cols ? c00 + 1 : c00, c01 = b0 + 1 < rows ? c00 + cols : c00, c11 = c01 + (c10 - c00);
      const vx = (tvx[c00] * (1 - u) + tvx[c10] * u) * (1 - w) + (tvx[c01] * (1 - u) + tvx[c11] * u) * w;
      const vy = (tvy[c00] * (1 - u) + tvy[c10] * u) * (1 - w) + (tvy[c01] * (1 - u) + tvy[c11] * u) * w;
      const nx = x + vx * dt, ny = y + vy * dt;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) break;
      const c = ((ny * inv) | 0) * cols + ((nx * inv) | 0);
      if (blocked[c]) break;
      x = nx; y = ny;
      if (holes[c]) break;
    }
    const target = Math.floor(y / cell) * cols + Math.floor(x / cell);
    if (holes[target]) dst[target] += moved;
    else spill(dst, blocked, cols, rows, cell, x, y, moved, k);
  }
}

function settleRange(m: MineralState, params: WorldParams, terrain: TerrainState, work: MineralWork, dst: Float64Array, sMax: number, settle: number, dissolve: number, perLvl: number, P: number, first: number, last: number): void {
  const { cols, rows, cell, blocked } = m;
  const { speed, flowX, flowY, processes } = work;
  const area = cell * cell, gr = terrain.ground, dep = terrain.deposits;
  for (let k = first; k < last; k++) {
    if (blocked[k]) continue;
    const calm = sMax > 0 ? 1 - Math.min(1, speed[k] / sMax) : 1;
    // Оседание в залежи: весь растворённый минерал понемногу, тем больше, чем
    // слабее течение; не выше верха отмели (плавно затихает от 1,2 к 1,4).
    const lvl = (gr[k] + dep[k]) / perLvl;
    const room = Math.min(1, Math.max(0, (1.4 - lvl) / 0.2));
    // Где поток сходится и уходит (в тени), принесённый им минерал оседает —
    // тем больше, чем сильнее схождение.
    const i = k % cols, j = (k - i) / cols;
    const div = ((i < cols - 1 && !blocked[k + 1] ? flowX[k + 1] : flowX[k]) - (i > 0 && !blocked[k - 1] ? flowX[k - 1] : flowX[k])
      + (j < rows - 1 && !blocked[k + cols] ? flowY[k + cols] : flowY[k]) - (j > 0 && !blocked[k - cols] ? flowY[k - cols] : flowY[k])) / (2 * cell);
    const sink = Math.min(0.9, Math.max(0, -div) * MINERAL_SINK_SETTLE * P * params.terrainSpeed);
    const settled = dst[k] * (1 - (1 - settle * calm * calm) * (1 - sink)) * room;
    // Размыв: заметное течение срывает залежи обратно в среду (грунт под ними
    // не растворяется — его переносит moveSand).
    const over = speed[k] - EROSION_THRESHOLD * sMax;
    const erode = Math.min(dep[k], over > 0 ? EROSION * over * P * area * params.terrainSpeed : 0);
    // Залежи понемногу растворяются обратно — на месте.
    const dissolved = (dep[k] - erode) * dissolve;
    dst[k] += erode - settled + dissolved;
    dep[k] += settled - erode - dissolved;
    processes.erosion[k] = erode;
    processes.settling[k] = settled;
  }
}

/**
 * Перенос грунта за обновление (строки first…last): течение сильнее порога
 * размыва сдвигает грунт к соседям вниз по течению — доли по составляющим
 * скорости. Количество сохраняется: всё считается от снимка `gr`, изменения
 * копятся в `out`. Не кладёт в перегородки, за край, в клетки выше верха
 * отмели; под залежами толще SAND_UNDER грунт не трогает (сначала размываются они).
 */
function sandRows(m: MineralState, params: WorldParams, terrain: TerrainState, work: MineralWork, sMax: number, perLvl: number, out: Float64Array, first: number, last: number): void {
  const { cols, rows, blocked } = m;
  const { speed, flowX, flowY } = work;
  const lift = work.groundChanges.lift;
  const gr = terrain.ground, dep = terrain.deposits;
  const open = (n: number) => !blocked[n] && (gr[n] + dep[n]) / perLvl < SAND_TOP;
  if (!(sMax > 0)) return;
  for (let j = first; j < last; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      if (blocked[k] || gr[k] <= 0 || dep[k] > SAND_UNDER * perLvl || !open(k)) continue;
      const over = (speed[k] - SAND_THRESHOLD * sMax) / sMax;
      if (!(over > 0)) continue;
      const vx = flowX[k], vy = flowY[k];
      const ax = Math.abs(vx), ay = Math.abs(vy), sum = ax + ay;
      if (sum === 0) continue;
      const amount = Math.min(gr[k], SAND_RATE * over * perLvl * params.terrainSpeed);
      const tx = vx > 0 ? (i < cols - 1 ? k + 1 : -1) : (i > 0 ? k - 1 : -1);
      const ty = vy > 0 ? (j < rows - 1 ? k + cols : -1) : (j > 0 ? k - cols : -1);
      if (tx >= 0 && ax > 0 && open(tx)) { const a = amount * ax / sum; out[k] -= a; out[tx] += a; lift[k] += a; }
      if (ty >= 0 && ay > 0 && open(ty)) { const a = amount * ay / sum; out[k] -= a; out[ty] += a; lift[k] += a; }
    }
  }
}

/**
 * Осыпание за обновление (строки first…last): склон круче SLUMP_SLOPE
 * осыпается — грунт сползает к нижним соседям, SLUMP_RATE от превышения,
 * поровну по превышению; ровная середина суши стоит. От снимка, в `out`.
 */
function slumpRows(m: MineralState, params: WorldParams, terrain: TerrainState, perLvl: number, out: Float64Array, first: number, last: number): void {
  const { cols, rows, blocked } = m;
  const gr = terrain.ground, dep = terrain.deposits;
  const h = (n: number) => (gr[n] + dep[n]) / perLvl;
  const rate = SLUMP_RATE * params.terrainSpeed;
  for (let j = first; j < last; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      if (blocked[k] || gr[k] <= 0) continue;
      const hk = h(k);
      const dl = i > 0 && !blocked[k - 1] ? Math.max(0, hk - h(k - 1) - SLUMP_SLOPE) : 0;
      const dr = i < cols - 1 && !blocked[k + 1] ? Math.max(0, hk - h(k + 1) - SLUMP_SLOPE) : 0;
      const du = j > 0 && !blocked[k - cols] ? Math.max(0, hk - h(k - cols) - SLUMP_SLOPE) : 0;
      const dd = j < rows - 1 && !blocked[k + cols] ? Math.max(0, hk - h(k + cols) - SLUMP_SLOPE) : 0;
      const total = dl + dr + du + dd;
      if (total === 0) continue;
      // Не больше четверти превышения: осыпание не перекидывает склон в обратный.
      const moved = Math.min(gr[k], rate * total * perLvl, 0.25 * total * perLvl);
      const f = moved / total;
      out[k] -= moved;
      if (dl > 0) out[k - 1] += f * dl;
      if (dr > 0) out[k + 1] += f * dr;
      if (du > 0) out[k - cols] += f * du;
      if (dd > 0) out[k + cols] += f * dd;
    }
  }
}

function runoffRows(field: Float64Array, ground: Float64Array, deposits: Float64Array, blocked: Uint8Array, holes: Uint8Array, cols: number, rows: number, perLevel: number, P: number, out: Float64Array, first: number, last: number): void {
  const surf = (n: number) => (ground[n] + deposits[n] + field[n]) / perLevel;
  for (let j = first; j < last; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      const a = field[k];
      if (a === 0 || blocked[k] || holes[k]) continue;
      const h = (ground[k] + deposits[k] + a) / perLevel;
      // Перепады к четырём соседям (без временных массивов — горячий цикл).
      const dl = i > 0 && !blocked[k - 1] ? Math.max(0, h - surf(k - 1)) : 0;
      const dr = i < cols - 1 && !blocked[k + 1] ? Math.max(0, h - surf(k + 1)) : 0;
      const du = j > 0 && !blocked[k - cols] ? Math.max(0, h - surf(k - cols)) : 0;
      const dd = j < rows - 1 && !blocked[k + cols] ? Math.max(0, h - surf(k + cols)) : 0;
      const total = dl + dr + du + dd;
      if (total === 0) continue;
      const moved = a * Math.min(0.5, RUNOFF * P * total);
      const f = moved / total;
      out[k] -= moved;
      if (dl > 0) out[k - 1] += f * dl;
      if (dr > 0) out[k + 1] += f * dr;
      if (du > 0) out[k - cols] += f * du;
      if (dd > 0) out[k + cols] += f * dd;
    }
  }
}

function spreadRows(field: Float64Array, mobility: Float64Array, blocked: Uint8Array, holes: Uint8Array, cols: number, rows: number, rate: number, flow: Float64Array, first: number, last: number): void {
  for (let j = first; j < last; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      if (blocked[k]) continue;
      const mk = mobility[k];
      // Только вправо и вниз — каждая пара один раз.
      if (i < cols - 1 && !blocked[k + 1]) {
        const raw = (rate * 2 * (field[k] - field[k + 1])) / (mk + mobility[k + 1]);
        const f = (raw > 0 ? holes[k] : holes[k + 1]) ? 0 : raw;
        flow[k] -= f;
        flow[k + 1] += f;
      }
      if (j < rows - 1 && !blocked[k + cols]) {
        const raw = (rate * 2 * (field[k] - field[k + cols])) / (mk + mobility[k + cols]);
        const f = (raw > 0 ? holes[k] : holes[k + cols]) ? 0 : raw;
        flow[k] -= f;
        flow[k + cols] += f;
      }
    }
  }
}

export function* updateMineralTask(m: MineralState, params: WorldParams, drift: Drift, partitions: PartitionLayout, terrain: TerrainState, light: LightMap, step: number): Calculation {
  const { cols, rows, cell, blocked } = m;
  const P = MINERAL_PERIOD;
  const tMid = step - P / 2;
  const src = m.field;
  const work = workspace(m);
  const dst = work.dst;
  const processes = work.processes;
  processes.step = step;
  processes.erosion.fill(0); processes.settling.fill(0); processes.sinking.fill(0);
  dst.fill(0);
  const mobility = mobilityFor(terrain.applied);
  // Сетки минерала и течений совпадают — снос клетки берётся прямо из узлов поля.
  phase('течения от света');
  const { a: fa, b: fb, u: fu } = (yield* drift.nodesTask(tMid));
  const sameGrid = fa.cols === cols && fa.rows === rows;
  const v: [number, number] = [0, 0];
  /** Сила течения и снос в клетке — для намыва, размыва и оседания там, куда уходит поток. */
  const { speed, flowX, flowY } = work;

  // Источник запускается до расчёта переноса: первый залп входит в этот интервал.
  phase('вулканы и воронки');
  startEruptions(m, params, terrain, step);
  // Воронки и течения от вулканов и воронок — по состоянию на начало промежутка.
  yield* updateFunnels(m, params, terrain, P);
  phase('течения вулканов и воронок');
  m.flow = yield* pushFlow(m, params, terrain, step - P, step);

  // Сумма течений (свет + вулканы и воронки) по клеткам — для переноса шажками.
  phase('сумма течений');
  const n = cols * rows;
  const { tvx, tvy } = work;
  const pvx = m.flow?.vx, pvy = m.flow?.vy;
  for (let j = 0; j < rows; j++) {
    yield;
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      if (blocked[k]) continue;
      if (sameGrid) {
        v[0] = fa.vx[k] + (fb.vx[k] - fa.vx[k]) * fu;
        v[1] = fa.vy[k] + (fb.vy[k] - fa.vy[k]) * fu;
      } else {
        drift.at((i + 0.5) * cell, (j + 0.5) * cell, tMid, v);
      }
      const x = v[0] + (pvx ? pvx[k] : 0), y = v[1] + (pvy ? pvy[k] : 0);
      tvx[k] = x; tvy[k] = y;
      speed[k] = Math.sqrt(x * x + y * y);
      flowX[k] = x; flowY[k] = y;
    }
  }
  processes.vx.set(tvx); processes.vy.set(tvy);
  // Отверстия воронок: сквозь них ничего не проходит — попавшее остаётся.
  const holes = work.holes;
  holes.fill(0);
  for (const f of m.funnels) for (const k of f.cells) holes[k] = 1;

  phase('перенос');
  // 1. Снос: перенос с сохранением количества — по линиям суммы течений
  // шажками не длиннее клетки (быстрое течение не перепрыгивает острова).
  for (let first = 0; first < n; first += 256) {
    yield;
    transportRange(m, src, dst, holes, mobility, tvx, tvy, P, first, Math.min(n, first + 256));
  }

  phase('растекание');
  // 1б. Растекание: от густого к редкому, медленнее там, где вязкость выше.
  yield* spread(dst, mobility, blocked, holes, cols, rows, MINERAL_SPREAD, work.spread);

  // 2. Местность и залежи.
  phase('оседание и размыв');
  const sMax = DRIFT_REFERENCE * sunAt(light, tMid);
  const settle = (1 - (1 - MINERAL_SETTLE) ** P) * params.terrainSpeed;
  const dissolve = (1 - (1 - DEPOSIT_DISSOLVE) ** P) * params.terrainSpeed;
  const area = cell * cell;
  const perLvl = GROUND_PER_LEVEL * area;
  const dep = terrain.deposits;
  const gr = terrain.ground;
  for (let first = 0; first < n; first += 512) {
    yield;
    settleRange(m, params, terrain, work, dst, sMax, settle, dissolve, perLvl, P, first, Math.min(n, first + 512));
  }
  m.field = dst;

  phase('перенос и осыпание грунта');
  // Грунт: течение переносит его вниз по течению, крутые склоны осыпаются.
  // Каждый проход — от снимка, с сохранением количества.
  const sand = work.ground;
  sand.set(gr);
  for (let first = 0; first < rows; first += 8) {
    yield;
    sandRows(m, params, terrain, work, sMax, perLvl, sand, first, Math.min(rows, first + 8));
  }
  const shown = work.groundChanges;
  for (let k = 0; k < n; k++) shown.net[k] += sand[k] - gr[k];
  gr.set(sand);
  for (let first = 0; first < rows; first += 8) {
    yield;
    slumpRows(m, params, terrain, perLvl, sand, first, Math.min(rows, first + 8));
  }
  for (let k = 0; k < n; k++) shown.net[k] += sand[k] - gr[k];
  shown.steps += P;
  gr.set(sand);

  phase('стекание');
  // Стекание: растворённый минерал стекает к соседям ниже — с суши к воде.
  m.field = yield* runoff(m.field, gr, dep, blocked, holes, cols, rows, perLvl, P, work.runoff);

  phase('воронки, подвижки, извержения');
  // Воронки: что дошло до отверстия, уходит в недра; залежи в отверстии поднимаются (см. sinkFunnel).
  for (const f of m.funnels) {
    const sunk = sinkFunnel(m, params, terrain, f, P);
    m.depths += sunk;
    work.exchanges.funnelSunk += sunk;
  }

  // Подвижки и толчки: грунт из подложки и в неё; опускание топит залежи в недра.
  // Для показа — что изменила тектоника (буфер грунта здесь свободен).
  work.ground.set(gr);
  m.depths += moveGround(terrain, params, step - P, step, cols, rows, cell, blocked);
  const tect = work.groundChanges.tectonic;
  for (let k = 0; k < n; k++) tect[k] += gr[k] - work.ground[k];

  // 3. Выход вещества активных извержений за весь промежуток.
  for (const vol of m.volcanoes) {
    if (vol.stage !== 'erupting') continue;
    const d = vol.until - vol.begin;
    const u0 = (step - P - vol.begin) / d, u1 = (step - vol.begin) / d;
    // Залпы бросают вещество (см. throwMass), истечение выходит в жерло, и
    // течения уносят его; толчок залпов и истечения — течение (см. pushFlow).
    const bursts = eruptionBursts(params, vol);
    const a0 = Math.max(0, u0);
    const out = step >= vol.until ? vol.left : Math.min(vol.left, Math.max(0, vol.total * (eruptionProfile(bursts, u1) - eruptionProfile(bursts, a0))));
    const thrown = Math.min(out, vol.total * Math.max(0, burstProfile(bursts, u1) - burstProfile(bursts, a0)));
    // Каждый залп — со своей дальностью (по силе); вещество делится по залпам, вышедшим в этом промежутке.
    let left = thrown;
    for (const b of bursts) {
      const part = vol.total * ERUPTION_BURST * b.share * (ease((u1 - b.at) / BURST_WIDTH) - ease((a0 - b.at) / BURST_WIDTH));
      if (part <= 0) continue;
      const g = Math.min(left, part);
      yield* throwMass(m, terrain, partitions, vol, g, vol.radius * Math.sqrt(b.share / bursts[0].share));
      left -= g;
    }
    const mouth = mouthCells(m, terrain, vol);
    for (let q = 0; q < mouth.length; q++) m.field[mouth[q]] += (out - thrown + left) / mouth.length;
    work.exchanges.emitted += out;
    vol.left -= out;
    vol.rate = out / P;
    if (step >= vol.until) {
      vol.left = 0;
      vol.rate = 0;
      // Потух или уснул — случай.
      const fate = (k: number) => hash3(deriveSeed(params.seed, 'volcano-fate'), vol.id * 1000 + vol.k, k) / 4294967296;
      if (fate(1) < VOLCANO_EXTINCT_CHANCE) extinguish(vol, params, step);
      else {
        vol.stage = 'dormant';
        vol.stageAt = step;
        vol.stageUntil = step + Math.round(lerp(VOLCANO_DORMANT_LIFE, fate(2)));
      }
    }
  }
  m.version++;
  phase(null);
}

/** Запуск и завершение подготовки — по давлению в начале обновления среды. */
function startEruptions(m: MineralState, params: WorldParams, terrain: TerrainState, step: number): void {
  const P = MINERAL_PERIOD;
  const timing = deriveSeed(params.seed, 'eruptions');
  if (m.depths < m.threshold) m.genesis = false;
  for (const v of m.volcanoes) if (v.stage === 'dormant' && step >= v.stageUntil) extinguish(v, params, step);
  m.volcanoes = m.volcanoes.filter((v) => !(v.stage === 'extinct' && step >= v.stageUntil));
  if (m.depths >= VOLCANO_BIRTH * m.threshold && !m.volcanoes.some((v) => v.stage === 'preparing' || v.stage === 'erupting')) {
    prepareVolcano(m, params, terrain, step);
  }
  const ready = m.volcanoes.find((v) => v.stage === 'preparing' && step >= v.stageUntil);
  if (ready && m.depths >= m.threshold) {
    const n = m.eruptions;
    const u = (k: number) => hash3(timing, n, k) / 4294967296;
    const vol = ready;
    const logSpan = (r: readonly [number, number], t: number) => r[0] * (r[1] / r[0]) ** t;
    const stock = params.mineralStock * m.freeArea;
    // Доля недр, но не больше предела: при полных недрах выходит серия извержений, а не одно.
    const amount = Math.min(ERUPTION_MAX * stock, m.depths * Math.min(0.95, logSpan(ERUPTION_SHARE, u(2)) * vol.power));
    // В стартовой серии извержения идут в GENESIS_SPEEDUP раз быстрее.
    const duration = Math.max(1, Math.round(Math.min(ERUPTION_DURATION[1], Math.max(ERUPTION_DURATION[0],
      ERUPTION_DURATION_SCALE * Math.sqrt(amount / stock) * (0.6 + u(3)))) / (m.genesis ? GENESIS_SPEEDUP : 1)));
    m.depths -= amount;
    vol.radius = eruptionRadius(m, params, amount);
    vol.stage = 'erupting';
    vol.begin = Math.max(step - P, vol.stageUntil);
    vol.until = vol.begin + duration;
    vol.stageAt = vol.begin;
    vol.stageUntil = vol.until;
    vol.total = amount;
    vol.left = amount;
    vol.rate = 0;
    vol.k++;
    m.eruptions++;
    // Следующий порог — случайно вокруг среднего.
    m.threshold = stock * ERUPTION_PRESSURE * (0.5 + u(4));
  }
}

/**
 * Стекание за обновление: из каждой клетки к четырём соседям ниже уходит доля
 * минерала, пропорциональная перепаду поверхности (вместе — не больше
 * половины). Поверхность — грунт плюс лежащий на нём растворённый минерал:
 * большая куча сама создаёт уклон и расползается, ровный фон стоит.
 * Количество сохраняется; в перегородки не стекает.
 */
function* runoff(field: Float64Array, ground: Float64Array, deposits: Float64Array, blocked: Uint8Array, holes: Uint8Array, cols: number, rows: number, perLevel: number, P: number, out: Float64Array): Calculation<Float64Array> {
  out.set(field);
  for (let first = 0; first < rows; first += 4) {
    yield;
    runoffRows(field, ground, deposits, blocked, holes, cols, rows, perLevel, P, out, first, Math.min(rows, first + 4));
  }
  return out;
}

const lerp = (r: readonly [number, number], t: number) => r[0] + (r[1] - r[0]) * t;

/** Вулкан потух: тускнеет и через случайный срок исчезает. */
function extinguish(v: Volcano, params: WorldParams, step: number): void {
  v.stage = 'extinct';
  v.stageAt = step;
  v.stageUntil = step + Math.round(lerp(VOLCANO_FADE, hash3(deriveSeed(params.seed, 'volcano-fade'), v.id, v.k) / 4294967296));
}

/**
 * Следующий вулкан начинает готовиться: с шансом VOLCANO_WAKE_CHANCE
 * просыпается спящий (сильные чаще), иначе рождается новый — в случайном
 * месте, но подальше от залежей: чем гуще залежи, тем реже.
 */
function prepareVolcano(m: MineralState, params: WorldParams, terrain: TerrainState, step: number): void {
  const n = m.births++;
  const seed = deriveSeed(params.seed, 'volcano-births');
  const u = (k: number) => hash3(seed, n, k) / 4294967296;
  const mature = Math.max(1, Math.round(VOLCANO_MATURE / (m.genesis ? GENESIS_SPEEDUP : 1)));
  const sleeping = m.volcanoes.filter((v) => v.stage === 'dormant');
  if (sleeping.length > 0 && u(1) < VOLCANO_WAKE_CHANCE) {
    let pick = u(2) * sleeping.reduce((a, v) => a + v.power, 0);
    const v = sleeping.find((s) => (pick -= s.power) < 0) ?? sleeping[sleeping.length - 1];
    v.stage = 'preparing';
    v.stageAt = step;
    v.stageUntil = step + mature;
    v.fresh = false;
    return;
  }
  const rng = new Rng(hash3(seed, n, 3));
  const area = m.cell * m.cell;
  const perMean = area * params.mineralStock;
  const living = m.volcanoes.filter((v) => v.stage !== 'extinct');
  let spot = -1;
  for (let tries = 0; tries < 4000 && spot < 0; tries++) {
    const k = rng.int(m.cols * m.rows);
    if (m.blocked[k]) continue;
    const i = k % m.cols, j = (k - i) / m.cols;
    const x = (i + 0.5) * m.cell, y = (j + 0.5) * m.cell;
    // Не теснее VOLCANO_MIN_GAP к живым вулканам, пока есть из чего выбирать.
    if (tries < 3000 && living.some((v) => Math.hypot(v.x - x, v.y - y) < VOLCANO_MIN_GAP)) continue;
    if (rng.next() < Math.exp(-terrain.deposits[k] / perMean / VOLCANO_DEPOSIT_AVOID)) spot = k;
  }
  if (spot < 0) spot = m.blocked.indexOf(0);
  const i = spot % m.cols, j = (spot - i) / m.cols;
  m.volcanoes.push({
    id: n, x: (i + 0.5) * m.cell, y: (j + 0.5) * m.cell, power: lerp(VOLCANO_POWER, u(4)),
    stage: 'preparing', stageAt: step, stageUntil: step + mature, fresh: true,
    radius: 0, k: 0, begin: 0, until: 0, total: 0, left: 0, rate: 0,
  });
}

/**
 * Темп извержения — серия залпов и истечение. Залпы (доля ERUPTION_BURST) —
 * короткие и сильные: толкают среду и бросают вещество. Истечение — всё
 * извержение, слабея (темп ∝ 1 − u): вещество выходит в жерло, течения тянут его реками.
 */
const ease = (t: number) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 2;

/** Залп: когда (доля времени извержения) и какая доля всех залпов. */
export interface Burst {
  readonly at: number;
  readonly share: number;
}

/**
 * Залпы извержения — из сида, вулкана и номера извержения (не хранятся):
 * сколько — случай от 1 до ERUPTION_BURSTS_MAX; первый — в начале и самый
 * сильный, каждый следующий вдвое слабее, в случайный момент.
 */
export function eruptionBursts(params: WorldParams, vol: Volcano): Burst[] {
  const h = (k: number) => hash3(deriveSeed(params.seed, 'eruption-bursts'), vol.id * 1000 + vol.k, k) / 4294967296;
  const n = 1 + Math.floor(h(0) * ERUPTION_BURSTS_MAX);
  const at = [0];
  for (let q = 1; q < n; q++) at.push(BURST_FROM + (1 - BURST_FROM - BURST_WIDTH) * h(q));
  at.sort((a, b) => a - b);
  const weights = at.map((_, q) => 0.5 ** q);
  const sum = weights.reduce((a, b) => a + b, 0);
  return at.map((t, q) => ({ at: t, share: weights[q] / sum }));
}

/** Доля извержения, вышедшая залпами к доле времени u. */
export function burstProfile(bursts: readonly Burst[], u: number): number {
  let s = 0;
  for (const b of bursts) s += b.share * ease((u - b.at) / BURST_WIDTH);
  return ERUPTION_BURST * s;
}

/** Доля извержения, вышедшая истечением к доле времени u: слабеет к концу (темп ∝ 1 − u). */
export function tailProfile(u: number): number {
  return (1 - ERUPTION_BURST) * ease(u);
}

/** Доля извержения, вышедшая к доле его времени u ∈ [0, 1]. */
export function eruptionProfile(bursts: readonly Burst[], u: number): number {
  return burstProfile(bursts, u) + tailProfile(u);
}

/**
 * Толчок вулкана — сила (площадь за шаг): залпы толкают среду на круг радиуса
 * выброса (каждый — по своей доле), истечение — на круг ERUPTION_TAIL_AREA
 * радиуса за всё извержение. В доле времени u.
 */
export function ventPush(params: WorldParams, vol: Volcano, u: number): number {
  const bursts = eruptionBursts(params, vol);
  const d = Math.max(1, vol.until - vol.begin);
  const e = 0.002;
  const area = (x: number) => Math.PI * vol.radius * vol.radius * (burstProfile(bursts, x) / ERUPTION_BURST)
    + Math.PI * (vol.radius * ERUPTION_TAIL_AREA) ** 2 * (tailProfile(x) / (1 - ERUPTION_BURST));
  return Math.max(0, (area(Math.min(1, u + e)) - area(Math.max(0, u - e))) / (2 * e * d));
}

/** Средняя сила толчка за интервал: интеграл всех залпов, включая короткие между выборками. */
export function ventPushAverage(params: WorldParams, vol: Volcano, from: number, to: number): number {
  if (to <= from) return 0;
  const duration = Math.max(1, vol.until - vol.begin);
  const bursts = eruptionBursts(params, vol);
  const area = (step: number) => {
    const u = Math.min(1, Math.max(0, (step - vol.begin) / duration));
    return Math.PI * vol.radius ** 2 * burstProfile(bursts, u) / ERUPTION_BURST
      + Math.PI * (vol.radius * ERUPTION_TAIL_AREA) ** 2 * tailProfile(u) / (1 - ERUPTION_BURST);
  };
  return Math.max(0, (area(to) - area(from)) / (to - from));
}

/** Темп выброса в доле времени u относительно наибольшего (у первого залпа), 0…1 — для показа. */
export function eruptionRate(params: WorldParams, vol: Volcano, u: number): number {
  const bursts = eruptionBursts(params, vol);
  const e = 0.002;
  const rate = (x: number) => (eruptionProfile(bursts, Math.min(1, x + e)) - eruptionProfile(bursts, Math.max(0, x - e))) / (2 * e);
  return Math.min(1, rate(u) / rate(BURST_WIDTH * 0.25));
}

/** Радиус выброса извержения объёма `total`: растёт как √ от доли предела. */
export function eruptionRadius(m: MineralState, params: WorldParams, total: number): number {
  const limit = ERUPTION_MAX * params.mineralStock * m.freeArea;
  return ERUPTION_RADIUS * Math.max(ERUPTION_RADIUS_MIN, Math.sqrt(Math.min(1, total / Math.max(1e-12, limit))));
}

/**
 * «Вязкое» расстояние от точки по сетке минерала: путь по соседним клеткам,
 * каждая клетка стоит тем дороже, чем выше её вязкость (вода ×1, отмель ×3,
 * суша ×9); перегородки и стенки непроходимы — их можно только обойти.
 * Клетки не дальше `limit` и их расстояния.
 */
export function viscousDistances(m: MineralState, terrain: TerrainState, x: number, y: number, limit: number): { cells: Int32Array; dists: Float64Array } {
  const start = Math.min(m.rows - 1, Math.floor(y / m.cell)) * m.cols + Math.min(m.cols - 1, Math.floor(x / m.cell));
  return viscousDistancesFrom(m, terrain, [start], limit);
}

/** То же, от целой формы: расстояние до ближайшей из клеток `seeds` (у них — 0). */
export function viscousDistancesFrom(m: MineralState, terrain: TerrainState, seeds: readonly number[], limit: number): { cells: Int32Array; dists: Float64Array } {
  const { cols, rows, cell, blocked } = m;
  const dist = new Map<number, number>(seeds.map((k) => [k, 0]));
  const done = new Set<number>();
  // Двоичная куча по расстоянию.
  const heap: number[] = [...seeds];
  const key = (k: number) => dist.get(k)!;
  const push = (k: number) => {
    heap.push(k);
    for (let i = heap.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (key(heap[p]) <= key(heap[i])) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let s = i;
        if (l < heap.length && key(heap[l]) < key(heap[s])) s = l;
        if (r < heap.length && key(heap[r]) < key(heap[s])) s = r;
        if (s === i) break;
        [heap[s], heap[i]] = [heap[i], heap[s]];
        i = s;
      }
    }
    return top;
  };
  const cost = (k: number) => multiplierForLevel(terrain.applied[k]);
  const cells: number[] = [];
  const dists: number[] = [];
  while (heap.length > 0) {
    const k = pop();
    if (done.has(k)) continue;
    done.add(k);
    const d = dist.get(k)!;
    cells.push(k);
    dists.push(d);
    const i = k % cols, j = (k - i) / cols;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (di === 0 && dj === 0) continue;
        const a = i + di, b = j + dj;
        if (a < 0 || b < 0 || a >= cols || b >= rows) continue;
        const n = b * cols + a;
        if (blocked[n] || done.has(n)) continue;
        // По диагонали — только если не срезаем угол преграды.
        if (di !== 0 && dj !== 0 && (blocked[j * cols + a] || blocked[b * cols + i])) continue;
        const nd = d + cell * Math.hypot(di, dj) * (cost(k) + cost(n)) / 2;
        if (nd > limit) continue;
        if (nd < (dist.get(n) ?? Infinity)) {
          dist.set(n, nd);
          push(n);
        }
      }
    }
  }
  return { cells: Int32Array.from(cells), dists: Float64Array.from(dists) };
}

/**
 * Бросок вещества залпом: от жерла по лучам, почти по прямой; у каждой
 * порции свой запас дальности (до `range`, гуще у жерла). Полёт тратит запас
 * тем быстрее, чем вязче то, над чем летит (× множитель вязкости); где запас
 * кончился — порция падает. Перегородки и стенки не перелетает.
 */
/** Геометрия залпа зависит от снимка местности, жерла и дальности; масса её не меняет. */
const throwMaps = new WeakMap<Float32Array, Map<string, Float64Array>>();
const mouths = new WeakMap<Float32Array, Map<string, Int32Array>>();

function mouthCells(m: MineralState, terrain: TerrainState, vol: Volcano): Int32Array {
  let maps = mouths.get(terrain.applied);
  if (!maps) { maps = new Map(); mouths.set(terrain.applied, maps); }
  const key = `${vol.x}:${vol.y}`;
  let cells = maps.get(key);
  if (!cells) { cells = viscousDistances(m, terrain, vol.x, vol.y, m.cell * 1.5).cells; maps.set(key, cells); }
  return cells;
}

function* throwMass(m: MineralState, terrain: TerrainState, partitions: PartitionLayout, vol: Volcano, amount: number, range: number): Calculation {
  if (amount <= 0) return;
  let maps = throwMaps.get(terrain.applied);
  if (!maps) { maps = new Map(); throwMaps.set(terrain.applied, maps); }
  const key = `${vol.x}:${vol.y}:${range}`;
  let points = maps.get(key);
  if (!points) { points = yield* throwLandings(m, terrain, partitions, vol, range); maps.set(key, points); }
  const weights: number[] = [];
  let wsum = 0;
  for (let q = 0; q < THROW_SAMPLES; q++) { const w = 1 - (q + 0.5) / THROW_SAMPLES; weights.push(w); wsum += w; }
  const home = Math.floor(vol.y / m.cell) * m.cols + Math.floor(vol.x / m.cell);
  for (let r = 0; r < THROW_RAYS; r++) for (let q = 0; q < THROW_SAMPLES; q++) {
    const o = (r * THROW_SAMPLES + q) * 2;
    spill(m.field, m.blocked, m.cols, m.rows, m.cell, points[o], points[o + 1], (amount * weights[q]) / wsum / THROW_RAYS, home);
  }
}

function* throwLandings(m: MineralState, terrain: TerrainState, partitions: PartitionLayout, vol: Volcano, range: number): Calculation<Float64Array> {
  const { cols, rows, cell } = m;
  const rays = THROW_RAYS, samples = THROW_SAMPLES;
  // Доли запасов: линейно спадают к краю — гуще у жерла.
  const landings = new Float64Array(rays * samples * 2);
  const step = cell * 0.5;
  for (let r = 0; r < rays; r++) {
    yield;
    const a = ((r + 0.5) / rays) * Math.PI * 2;
    const dx = Math.cos(a), dy = Math.sin(a);
    let x = vol.x, y = vol.y, spent = 0;
    let q = 0;
    let landX = x, landY = y;
    // Идём по лучу; порции падают, когда их запас исчерпан.
    while (q < samples) {
      const budget = (range * (q + 0.5)) / samples;
      if (spent >= budget) {
        landings[(r * samples + q) * 2] = landX; landings[(r * samples + q) * 2 + 1] = landY;
        q++;
        continue;
      }
      const nx = x + dx * step, ny = y + dy * step;
      if (nx < 0 || ny < 0 || nx >= cols * cell || ny >= rows * cell || isBlocked(partitions, nx, ny)) {
        // Преграда — все оставшиеся порции падают перед ней.
        for (; q < samples; q++) { landings[(r * samples + q) * 2] = landX; landings[(r * samples + q) * 2 + 1] = landY; }
        break;
      }
      const k = Math.floor(ny / cell) * cols + Math.floor(nx / cell);
      spent += step * multiplierForLevel(terrain.applied[k]);
      x = nx; y = ny;
      landX = x; landY = y;
    }
  }
  return landings;
}
/** Положить `mass` в точку (x, y): доли четырёх соседних клеток, в занятые — не кладём (остаток — в `home`). */
function spill(out: Float64Array, blocked: Uint8Array, cols: number, rows: number, cell: number, x: number, y: number, mass: number, home: number): void {
  const fx = x / cell - 0.5, fy = y / cell - 0.5;
  const i0 = Math.floor(fx), j0 = Math.floor(fy);
  const u = fx - i0, w = fy - j0;
  // Обычный случай — все четыре соседа внутри и свободны: без проверок по одному.
  const k = j0 * cols + i0;
  if (i0 >= 0 && j0 >= 0 && i0 + 1 < cols && j0 + 1 < rows
    && !blocked[k] && !blocked[k + 1] && !blocked[k + cols] && !blocked[k + cols + 1]) {
    out[k] += mass * (1 - u) * (1 - w);
    out[k + 1] += mass * u * (1 - w);
    out[k + cols] += mass * (1 - u) * w;
    out[k + cols + 1] += mass * u * w;
    return;
  }
  let kept = 0;
  kept += spillPart(out, blocked, cols, rows, i0, j0, (1 - u) * (1 - w), mass);
  kept += spillPart(out, blocked, cols, rows, i0 + 1, j0, u * (1 - w), mass);
  kept += spillPart(out, blocked, cols, rows, i0, j0 + 1, (1 - u) * w, mass);
  kept += spillPart(out, blocked, cols, rows, i0 + 1, j0 + 1, u * w, mass);
  out[home] += mass * kept;
}

/** Возвращает долю, остановленную стенкой, без замыкания на каждую клетку. */
function spillPart(out: Float64Array, blocked: Uint8Array, cols: number, rows: number, i: number, j: number, share: number, mass: number): number {
  if (share <= 0) return 0;
  if (i < 0 || j < 0 || i >= cols || j >= rows || blocked[j * cols + i]) return share;
  out[j * cols + i] += mass * share;
  return 0;
}

/** Клетки ареола воронки — свободные клетки не дальше её радиуса от ядра. */
function basinCells(m: MineralState, f: Funnel): Int32Array {
  const cached = basins.get(f);
  if (cached) return cached;
  const { cols, rows, cell, blocked } = m;
  const ci = Math.floor(f.x / cell), cj = Math.floor(f.y / cell), r = Math.ceil(f.reach / cell);
  const out: number[] = [];
  for (let j = Math.max(0, cj - r); j <= Math.min(rows - 1, cj + r); j++) {
    for (let i = Math.max(0, ci - r); i <= Math.min(cols - 1, ci + r); i++) {
      const k = j * cols + i;
      if (!blocked[k] && Math.hypot(i - ci, j - cj) * cell <= f.reach) out.push(k);
    }
  }
  const cells = Int32Array.from(out);
  basins.set(f, cells);
  return cells;
}

/**
 * Воронки за обновление. Жизнь: если в ареоле есть сверхплотное (залежи
 * не меньше, чем у ядра при рождении, — FUNNEL_DEPOSIT средних) — сгущается, иначе тает (FUNNEL_RAMP шагов от
 * нуля до полной силы); растаяла — исчезает. Рождение: связное место, где
 * залежей не меньше FUNNEL_SHAPE средних, с ядром не меньше FUNNEL_DEPOSIT,
 * не меньше FUNNEL_MIN_CELLS клеток, — если его ядро не в ареоле живой
 * воронки (сначала самые массивные). Ареол — радиус скопления + FUNNEL_REACH;
 * отверстие — FUNNEL_HOLE_SHARE скопления вокруг самой густой клетки.
 */
function* updateFunnels(m: MineralState, params: WorldParams, terrain: TerrainState, P: number): Calculation {
  const { cols, rows, cell, blocked } = m;
  const area = cell * cell;
  const core = FUNNEL_DEPOSIT * params.mineralStock * area;
  const limit = FUNNEL_SHAPE * params.mineralStock * area;
  const dep = terrain.deposits;
  const ramp = (P / FUNNEL_RAMP) * params.terrainSpeed;
  for (const f of m.funnels) {
    f.forming = basinCells(m, f).some((k) => dep[k] > core);
    f.strength = Math.max(0, Math.min(1, f.strength + (f.forming ? ramp : -ramp)));
  }
  m.funnels = m.funnels.filter((f) => f.forming || f.strength > 0);
  // Рождение новых.
  const seen = workspace(m).seen;
  seen.fill(0);
  const inside = (k: number) => !blocked[k] && dep[k] >= limit;
  const candidates: { best: number; members: number[]; mass: number }[] = [];
  const stack: number[] = [];
  for (let k0 = 0; k0 < dep.length; k0++) {
    if ((k0 & 255) === 0) yield;
    if (seen[k0] || !inside(k0)) continue;
    seen[k0] = 1;
    stack.push(k0);
    const members: number[] = [];
    let mass = 0, best = k0;
    let visited = 0;
    while (stack.length > 0) {
      if ((visited++ & 255) === 0) yield;
      const k = stack.pop()!;
      members.push(k);
      mass += dep[k];
      if (dep[k] > dep[best] || (dep[k] === dep[best] && k < best)) best = k;
      const i = k % cols, j = (k - i) / cols;
      const next = [i > 0 ? k - 1 : -1, i < cols - 1 ? k + 1 : -1, j > 0 ? k - cols : -1, j < rows - 1 ? k + cols : -1];
      for (const n of next) if (n >= 0 && !seen[n] && inside(n)) { seen[n] = 1; stack.push(n); }
    }
    if (members.length < FUNNEL_MIN_CELLS || dep[best] < core) continue;
    candidates.push({ best, members, mass });
  }
  candidates.sort((a, b) => b.mass - a.mass || a.best - b.best);
  for (const c of candidates) {
    const i = c.best % cols, j = (c.best - i) / cols;
    const x = (i + 0.5) * cell, y = (j + 0.5) * cell;
    const halo = Math.sqrt((c.members.length * area) / Math.PI) + FUNNEL_REACH;
    if (m.funnels.some((f) => Math.hypot(f.x - x, f.y - y) < Math.max(halo, f.reach))) continue;
    // Отверстие растёт от самой густой клетки по самым густым соседям до доли скопления.
    const want = Math.max(1, Math.round(c.members.length * FUNNEL_HOLE_SHARE));
    const member = new Set(c.members);
    const hole = new Set<number>([c.best]);
    const edge = new Set<number>();
    const grow = (k: number) => {
      const a = k % cols, b = (k - a) / cols;
      for (const n of [a > 0 ? k - 1 : -1, a < cols - 1 ? k + 1 : -1, b > 0 ? k - cols : -1, b < rows - 1 ? k + cols : -1]) {
        if (n >= 0 && member.has(n) && !hole.has(n)) edge.add(n);
      }
    };
    grow(c.best);
    while (hole.size < want && edge.size > 0) {
      let pick = -1;
      for (const n of edge) if (pick < 0 || dep[n] > dep[pick] || (dep[n] === dep[pick] && n < pick)) pick = n;
      edge.delete(pick);
      hole.add(pick);
      grow(pick);
    }
    m.funnels.push({ id: m.funnelBirths++, x, y, reach: halo, cells: Int32Array.from([...hole].sort((a, b) => a - b)), strength: 0, forming: true });
  }
}

function* pushFlow(m: MineralState, params: WorldParams, terrain: TerrainState, from: number, to: number): Calculation<{ vx: Float32Array; vy: Float32Array } | null> {
  const erupting = m.volcanoes.filter((v) => v.stage === 'erupting');
  if (erupting.length === 0 && m.funnels.length === 0) return null;
  const { pushX: vx, pushY: vy } = workspace(m);
  vx.fill(0); vy.fill(0);
  const add = (f: PushField, s: number) => {
    for (let j = f.j0; j <= f.j1; j++) {
      let q = (j - f.j0) * f.cols;
      for (let k = j * m.cols + f.i0, end = j * m.cols + f.i1; k <= end; k++, q++) {
        vx[k] += s * f.vx[q];
        vy[k] += s * f.vy[q];
      }
    }
  };
  for (const vol of erupting) {
    const q = ventPushAverage(params, vol, from, to);
    if (q <= 0) continue;
    const vent = Math.floor(vol.y / m.cell) * m.cols + Math.floor(vol.x / m.cell);
    add(yield* pushFieldTask(m, terrain.applied, `v${vent}`, [vent]), q);
  }
  // Тяга воронки — сила × единичное течение её отверстия (место и форма постоянны — кеш по номеру).
  for (const f of m.funnels) {
    if (f.strength <= 0) continue;
    add(yield* pushFieldTask(m, terrain.applied, `f${f.id}`, f.cells), -FUNNEL_DRAW * params.terrainSpeed * Math.PI * f.reach * f.reach * f.strength);
  }
  return { vx, vy };
}

/**
 * Воронка забирает только сверхплотное — избыток сверх FUNNEL_SHAPE средних:
 * залежи ареола поднимаются в среду (FUNNEL_LIFT за шаг), растворённое в
 * отверстии уходит в недра (FUNNEL_SINK за шаг); всё — с силой воронки.
 * Возвращает, сколько ушло в недра.
 */
function sinkFunnel(m: MineralState, params: WorldParams, terrain: TerrainState, f: Funnel, P: number): number {
  if (f.strength <= 0) return 0;
  const limit = FUNNEL_SHAPE * params.mineralStock * m.cell * m.cell;
  const lift = (1 - (1 - FUNNEL_LIFT) ** P) * params.terrainSpeed * f.strength;
  const take = (1 - (1 - FUNNEL_SINK) ** P) * params.terrainSpeed * f.strength;
  const dep = terrain.deposits;
  for (const k of basinCells(m, f)) {
    const g = Math.max(0, dep[k] - limit) * lift;
    dep[k] -= g;
    m.field[k] += g;
  }
  let sunk = 0;
  for (const k of f.cells) {
    const g = Math.max(0, m.field[k] - limit) * take;
    sunk += g;
    m.field[k] -= g;
    workspace(m).processes.sinking[k] += g;
  }
  return sunk;
}

/**
 * Растекание за обновление: между соседними клетками переходит доля разницы,
 * тем меньше, чем выше вязкость обеих (в воде — `rate`); через перегородки нет.
 * Количество сохраняется.
 */
function* spread(field: Float64Array, mobility: Float64Array, blocked: Uint8Array, holes: Uint8Array, cols: number, rows: number, rate: number, flow: Float64Array): Calculation {
  flow.fill(0);
  for (let first = 0; first < rows; first += 4) {
    yield;
    spreadRows(field, mobility, blocked, holes, cols, rows, rate, flow, first, Math.min(rows, first + 4));
  }
  for (let k = 0; k < field.length; k++) field[k] += flow[k];
}

/** Минерал, взятый из недр идущими извержениями, но ещё не вышедший, — «в пути»; входит в общий запас. */
export function mineralInEruptions(m: MineralState): number {
  return m.volcanoes.reduce((a, v) => a + (v.stage === 'erupting' ? v.left : 0), 0);
}

/** Растворённый минерал в среде — всего. */
export function mineralInMedium(m: MineralState): number {
  let s = 0;
  for (let k = 0; k < m.field.length; k++) s += m.field[k];
  return s;
}

/** Плотность растворённого минерала в точке относительно средней по запасу (1 — как в среднем). */
export function mineralDensityAt(m: MineralState, stock: number, x: number, y: number): number {
  const i = Math.min(m.cols - 1, Math.max(0, Math.floor(x / m.cell)));
  const j = Math.min(m.rows - 1, Math.max(0, Math.floor(y / m.cell)));
  return m.field[j * m.cols + i] / (m.cell * m.cell) / stock;
}

/** Плотность растворённого минерала в точке (количество на единицу площади), билинейно по клеткам. */
export function mineralDensity(m: MineralState, x: number, y: number): number {
  const fx = Math.min(m.cols - 1, Math.max(0, x / m.cell - 0.5));
  const fy = Math.min(m.rows - 1, Math.max(0, y / m.cell - 0.5));
  const i0 = Math.floor(fx), j0 = Math.floor(fy);
  const i1 = Math.min(m.cols - 1, i0 + 1), j1 = Math.min(m.rows - 1, j0 + 1);
  const u = fx - i0, v = fy - j0;
  const f = m.field;
  const a = f[j0 * m.cols + i0] + (f[j0 * m.cols + i1] - f[j0 * m.cols + i0]) * u;
  const b = f[j1 * m.cols + i0] + (f[j1 * m.cols + i1] - f[j1 * m.cols + i0]) * u;
  return (a + (b - a) * v) / (m.cell * m.cell);
}

/** Мутность: доля света, проходящая сквозь растворённый минерал (0, 1]. */
export function transparencyForDensity(density: number): number {
  return 1 / (1 + TURBIDITY * density);
}

export function transparencyAt(m: MineralState, x: number, y: number): number {
  return transparencyForDensity(mineralDensity(m, x, y));
}
