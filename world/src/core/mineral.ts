/**
 * Минерал (спецификация, раздел «Минерал»): постоянное количество, переходит
 * между средой, телами, останками, недрами и грунтом. Здесь — среда и недра
 * (тел и останков пока нет; грунт — в terrain.ts): растворённый минерал на
 * сетке, снос несёт его, избыток намывается в грунт, вулканы редко и
 * нерегулярно выбрасывают минерал из недр — по одному за раз, каждое
 * извержение длится своё время и выбрасывает своё количество.
 *
 * Это состояние мира: обновляется раз в MINERAL_PERIOD шагов на фиксированных
 * шагах, поэтому ход мира не зависит от скорости показа. Перенос сносом
 * сохраняет количество: минерал клетки делится между клетками вокруг точки
 * назначения; в перегородки не попадает.
 */
import {
  DISH_HEIGHT, DISH_WIDTH, ERUPTION_DURATION, ERUPTION_RADIUS, ERUPTION_SHARE,
  MAX_ACTIVE_ERUPTIONS, MINERAL_CELL, MINERAL_PERIOD, MINERAL_SETTLE, MINERAL_LAYER, TURBIDITY, EROSION, EROSION_THRESHOLD, GROUND_PER_LEVEL, RUNOFF, WEATHERING,
  DEPOSIT_SINK, DEPOSIT_DISSOLVE, ERUPTION_MAX, ERUPTION_PRESSURE, ERUPTION_DURATION_SCALE, GENESIS_SPEEDUP,
  VOLCANO_MIN_GAP, VOLCANO_POWER,
} from './constants.ts';
import type { Drift } from './drift.ts';
import { sunAt, type LightMap } from './light.ts';
import { moveGround, type TerrainState } from './terrain.ts';
import type { WorldParams } from './params.ts';
import { freeRegions, isBlocked, type PartitionLayout } from './partitions.ts';
import { Rng, deriveSeed, hash3 } from './prng.ts';

export interface Volcano {
  readonly x: number;
  readonly y: number;
  /** Отсек (связная свободная часть чашки), в котором стоит вулкан. */
  readonly region: number;
  /** Мощность — постоянная, из сида: множитель доли выброса. */
  readonly power: number;
  /** Клетки круга выброса (в своём отсеке) и их доли; сумма долей — 1. */
  readonly cells: Int32Array;
  readonly weights: Float64Array;
  /** Сколько раз извергался (включая идущее). */
  k: number;
  /** Идёт ли извержение; с какого и до какого шага; сколько выбросит всего и сколько ещё осталось. */
  active: boolean;
  begin: number;
  until: number;
  total: number;
  left: number;
  /** Выброс за шаг сейчас — для показа. */
  rate: number;
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
  readonly volcanoes: readonly Volcano[];
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

/** Насколько далеко (клеток) от преграды проверять путь переноса: дальше, чем течение уносит за обновление. */
const NEAR_WALL = 6;

function nearWalls(blocked: Uint8Array): Uint8Array {
  const out = new Uint8Array(blocked.length);
  for (let j = 0; j < ROWS; j++) {
    for (let i = 0; i < COLS; i++) {
      let near = 0;
      for (let dj = -NEAR_WALL; dj <= NEAR_WALL && !near; dj++) {
        for (let di = -NEAR_WALL; di <= NEAR_WALL; di++) {
          const a = i + di, b = j + dj;
          if (a < 0 || b < 0 || a >= COLS || b >= ROWS || blocked[b * COLS + a]) { near = 1; break; }
        }
      }
      out[j * COLS + i] = near;
    }
  }
  return out;
}

const COLS = Math.ceil(DISH_WIDTH / MINERAL_CELL);
const ROWS = Math.ceil(DISH_HEIGHT / MINERAL_CELL);

export function createMineral(params: WorldParams, partitions: PartitionLayout): MineralState {
  const cell = MINERAL_CELL;
  const n = COLS * ROWS;
  const blocked = new Uint8Array(n);
  const region = new Int32Array(n).fill(-1);
  const { labels } = freeRegions(partitions);
  let freeCells = 0;
  for (let j = 0; j < ROWS; j++) {
    for (let i = 0; i < COLS; i++) {
      const k = j * COLS + i;
      const x = (i + 0.5) * cell, y = (j + 0.5) * cell;
      if (isBlocked(partitions, x, y)) { blocked[k] = 1; continue; }
      region[k] = labels[Math.floor(y / partitions.cell) * partitions.cols + Math.floor(x / partitions.cell)];
      freeCells++;
    }
  }
  const freeArea = freeCells * cell * cell;
  const total = params.mineralStock * freeArea;

  // При сотворении весь минерал (кроме грунта) — в недрах: вода чистая,
  // минерал приходит в среду только извержениями.
  const field = new Float64Array(n);

  const volcanoes = placeVolcanoes(params, blocked, region);
  const threshold = total * ERUPTION_PRESSURE * (0.5 + hash3(deriveSeed(params.seed, 'eruptions'), -1, 4) / 4294967296);
  return { cols: COLS, rows: ROWS, cell, field, depths: total, threshold, eruptions: 0, genesis: true, volcanoes, version: 0, blocked, nearWall: nearWalls(blocked), region, freeArea };
}

/** Вулканы: хотя бы один в каждом отсеке, остальные — где угодно; не теснее VOLCANO_MIN_GAP, если есть место. */
function placeVolcanoes(params: WorldParams, blocked: Uint8Array, region: Int32Array): Volcano[] {
  const rng = new Rng(deriveSeed(params.seed, 'volcanoes'));
  const regions = Math.max(0, ...region) + 1;
  const count = Math.max(params.volcanoCount, regions);
  const out: Volcano[] = [];
  const tooClose = (x: number, y: number) => out.some((v) => Math.hypot(v.x - x, v.y - y) < VOLCANO_MIN_GAP);
  const pick = (want: number | null): [number, number, number] => {
    let fallback: [number, number, number] | null = null;
    for (let tries = 0; tries < 5000; tries++) {
      const k = rng.int(COLS * ROWS);
      if (blocked[k] || (want !== null && region[k] !== want)) continue;
      const i = k % COLS, j = (k - i) / COLS;
      const x = (i + 0.5) * MINERAL_CELL, y = (j + 0.5) * MINERAL_CELL;
      fallback ??= [x, y, region[k]];
      if (!tooClose(x, y)) return [x, y, region[k]];
    }
    if (fallback) return fallback;
    // Отсек слишком мал для случайной выборки — берём первую его клетку.
    const k = region.findIndex((r) => want === null || r === want);
    const i = k % COLS, j = (k - i) / COLS;
    return [(i + 0.5) * MINERAL_CELL, (j + 0.5) * MINERAL_CELL, region[k]];
  };
  for (let v = 0; v < count; v++) {
    const [x, y, r] = pick(v < regions ? v : null);
    const power = VOLCANO_POWER[0] + (VOLCANO_POWER[1] - VOLCANO_POWER[0]) * rng.next();
    const { cells, weights } = ventCells(x, y, r, blocked, region);
    out.push({ x, y, region: r, power, cells, weights, k: 0, active: false, begin: 0, until: 0, total: 0, left: 0, rate: 0 });
  }
  return out;
}

/**
 * Обновление минерала за промежуток (step − MINERAL_PERIOD, step]: снос,
 * осаждение, наступившие извержения — в порядке шага мира.
 */
export function updateMineral(m: MineralState, params: WorldParams, drift: Drift, partitions: PartitionLayout, terrain: TerrainState, light: LightMap, step: number): void {
  const { cols, rows, cell, blocked } = m;
  const P = MINERAL_PERIOD;
  const tMid = step - P / 2;
  const src = m.field;
  const dst = new Float64Array(src.length);
  // Сетки минерала и течений совпадают — снос клетки берётся прямо из узлов поля.
  const { a: fa, b: fb, u: fu } = drift.nodes(tMid);
  const sameGrid = fa.cols === cols && fa.rows === rows;
  const v: [number, number] = [0, 0];
  /** Сила течения в клетке — для намыва и размыва. */
  const speed = new Float32Array(src.length);

  // 1. Снос: перенос с сохранением количества.
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      if (blocked[k]) continue;
      const x = (i + 0.5) * cell, y = (j + 0.5) * cell;
      if (sameGrid) {
        v[0] = fa.vx[k] + (fb.vx[k] - fa.vx[k]) * fu;
        v[1] = fa.vy[k] + (fb.vy[k] - fa.vy[k]) * fu;
      } else {
        drift.at(x, y, tMid, v);
      }
      speed[k] = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
      const amount = src[k];
      if (amount === 0) continue;
      let dx = v[0] * P, dy = v[1] * P;
      if (dx === 0 && dy === 0) { dst[k] += amount; continue; }
      // Слоистость: уносится не больше слоя, толщина которого растёт с силой
      // течения; остальное лежит на месте и смывается в следующие разы.
      const layer = MINERAL_LAYER * speed[k] * P * cell * cell;
      const moved = Math.min(amount, layer);
      dst[k] += amount - moved;
      // Не перескакивать перегородки: рядом с ними идём по пути и
      // останавливаемся перед преградой (вдали от перегородок путь свободен).
      if (m.nearWall[k] || speed[k] * P > NEAR_WALL * cell) {
        const probes = Math.ceil((speed[k] * P) / (cell * 0.5));
        let f = 1;
        for (let p = 1; p <= probes; p++) {
          const t = p / probes;
          if (isBlocked(partitions, x + dx * t, y + dy * t)) { f = (p - 1) / probes; break; }
        }
        dx *= f; dy *= f;
      }
      // Точка назначения → доли четырёх соседних клеток; в занятые — не кладём.
      const fx = (x + dx) / cell - 0.5, fy = (y + dy) / cell - 0.5;
      const i0 = Math.floor(fx), j0 = Math.floor(fy);
      const u = fx - i0, w = fy - j0;
      // Четыре клетки вокруг точки назначения (без временных функций — это горячий цикл).
      let kept = 0;
      const inX0 = i0 >= 0 && i0 < cols, inX1 = i0 + 1 >= 0 && i0 + 1 < cols;
      const inY0 = j0 >= 0 && j0 < rows, inY1 = j0 + 1 >= 0 && j0 + 1 < rows;
      const s00 = (1 - u) * (1 - w), s10 = u * (1 - w), s01 = (1 - u) * w, s11 = u * w;
      const c00 = j0 * cols + i0;
      if (s00 > 0) { if (inX0 && inY0 && !blocked[c00]) dst[c00] += moved * s00; else kept += s00; }
      if (s10 > 0) { if (inX1 && inY0 && !blocked[c00 + 1]) dst[c00 + 1] += moved * s10; else kept += s10; }
      if (s01 > 0) { if (inX0 && inY1 && !blocked[c00 + cols]) dst[c00 + cols] += moved * s01; else kept += s01; }
      if (s11 > 0) { if (inX1 && inY1 && !blocked[c00 + cols + 1]) dst[c00 + cols + 1] += moved * s11; else kept += s11; }
      dst[k] += moved * kept;
    }
  }

  // 2. Местность и залежи.
  const sMax = params.driftStrength * sunAt(light, tMid);
  const settle = (1 - (1 - MINERAL_SETTLE) ** P) * params.terrainSpeed;
  const dissolve = (1 - (1 - DEPOSIT_DISSOLVE) ** P) * params.terrainSpeed;
  const area = cell * cell;
  const perLvl = GROUND_PER_LEVEL * area;
  const dep = terrain.deposits;
  const gr = terrain.ground;
  for (let k = 0; k < dst.length; k++) {
    if (blocked[k]) continue;
    const calm = sMax > 0 ? 1 - Math.min(1, speed[k] / sMax) : 1;
    // Оседание в залежи: весь растворённый минерал понемногу, тем больше, чем
    // слабее течение; не выше верха отмели (плавно затихает от 1,2 к 1,4).
    const lvl = (gr[k] + dep[k]) / perLvl;
    const room = Math.min(1, Math.max(0, (1.4 - lvl) / 0.2));
    const settled = dst[k] * settle * calm * calm * room;
    // Размыв: заметное течение срывает сначала залежи, потом коренной грунт.
    const over = speed[k] - EROSION_THRESHOLD * sMax;
    let erode = over > 0 ? EROSION * over * P * area * params.terrainSpeed : 0;
    const fromDep = Math.min(dep[k], erode);
    const fromGround = Math.min(gr[k], erode - fromDep);
    erode = fromDep + fromGround;
    // Залежи понемногу растворяются обратно — на месте.
    const dissolved = (dep[k] - fromDep) * dissolve;
    dst[k] += erode - settled + dissolved;
    dep[k] += settled - fromDep - dissolved;
    gr[k] -= fromGround;
  }
  m.field = dst;

  // Выветривание склонов: грунт выше середины отмели переходит в среду —
  // тем быстрее, чем круче склон; ровная середина суши устойчива.
  const top = (k: number) => gr[k] + dep[k];
  for (let k = 0; k < dst.length; k++) {
    const above = top(k) - perLvl;
    if (above <= 0 || blocked[k]) continue;
    const i = k % cols, j = (k - i) / cols;
    let slope = 0;
    if (i > 0 && !blocked[k - 1]) slope = Math.max(slope, top(k) - top(k - 1));
    if (i < cols - 1 && !blocked[k + 1]) slope = Math.max(slope, top(k) - top(k + 1));
    if (j > 0 && !blocked[k - cols]) slope = Math.max(slope, top(k) - top(k - cols));
    if (j < rows - 1 && !blocked[k + cols]) slope = Math.max(slope, top(k) - top(k + cols));
    if (slope <= 0) continue;
    const w = above * Math.min(1, WEATHERING * (slope / perLvl) * P * params.terrainSpeed);
    const fromDep = Math.min(dep[k], w);
    dep[k] -= fromDep;
    gr[k] -= w - fromDep;
    m.field[k] += w;
  }

  // Стекание: растворённый минерал стекает к соседям ниже — с суши к воде.
  m.field = runoff(m.field, gr, dep, blocked, cols, rows, perLvl, P);

  // Залежи в глубокой воде (ниже середины уровня воды) понемногу затягиваются
  // в недра — чем глубже, тем заметнее; на мелководье и отмели остаются.
  const sink = (1 - (1 - DEPOSIT_SINK) ** P) * params.terrainSpeed;
  let sunk = 0;
  for (let k = 0; k < dep.length; k++) {
    if (dep[k] === 0) continue;
    const deep = Math.max(0, 1 - (gr[k] + dep[k]) / perLvl / 0.5);
    if (deep === 0) continue;
    const g = dep[k] * sink * deep;
    dep[k] -= g;
    sunk += g;
  }
  m.depths += sunk;

  // Подвижки и толчки: подъём — из опускающегося соседа и недр, опускание
  // топит залежи в недра.
  m.depths += moveGround(terrain, params, m.depths, step - P, step, cols, rows, cell, blocked);

  // 3. Извержения — от давления недр: идущее выбрасывает свою долю (разгорается
  // и затихает); когда недр накопилось больше порога и никто не извергается,
  // начинается новое — тем сильнее и дольше, чем больше накопилось.
  const timing = deriveSeed(params.seed, 'eruptions');
  for (const vol of m.volcanoes) {
    if (!vol.active) continue;
    const d = vol.until - vol.begin;
    const due = vol.total * (eruptionProfile((step - vol.begin) / d) - eruptionProfile((step - P - vol.begin) / d));
    const out = step >= vol.until ? vol.left : Math.min(vol.left, Math.max(0, due));
    release(m, vol, out);
    vol.left -= out;
    vol.rate = out / P;
    if (step >= vol.until) {
      vol.active = false;
      vol.left = 0;
      vol.rate = 0;
    }
  }
  if (m.depths < m.threshold) m.genesis = false;
  if (m.depths >= m.threshold && m.volcanoes.filter((v) => v.active).length < MAX_ACTIVE_ERUPTIONS) {
    const n = m.eruptions;
    const u = (k: number) => hash3(timing, n, k) / 4294967296;
    // Какой вулкан — случай, сильные чаще.
    const powers = m.volcanoes.map((v) => (v.active ? 0 : v.power));
    let pick = u(1) * powers.reduce((a, b) => a + b, 0);
    let index = powers.findIndex((pw) => (pick -= pw) < 0);
    if (index < 0) index = powers.findIndex((pw) => pw > 0);
    const vol = m.volcanoes[index];
    const logSpan = (r: readonly [number, number], t: number) => r[0] * (r[1] / r[0]) ** t;
    const stock = params.mineralStock * m.freeArea;
    // Доля недр, но не больше предела: при полных недрах выходит серия извержений, а не одно.
    const amount = Math.min(ERUPTION_MAX * stock, m.depths * Math.min(0.95, logSpan(ERUPTION_SHARE, u(2)) * vol.power));
    // В стартовой серии извержения идут в GENESIS_SPEEDUP раз быстрее.
    const duration = Math.round(Math.min(ERUPTION_DURATION[1], Math.max(ERUPTION_DURATION[0],
      ERUPTION_DURATION_SCALE * Math.sqrt(amount / stock) * (0.6 + u(3)))) / (m.genesis ? GENESIS_SPEEDUP : 1));
    m.depths -= amount;
    vol.active = true;
    vol.begin = step;
    vol.until = step + duration;
    vol.total = amount;
    vol.left = amount;
    vol.rate = 0;
    vol.k++;
    m.eruptions++;
    // Следующий порог — случайно вокруг среднего.
    m.threshold = stock * ERUPTION_PRESSURE * (0.5 + u(4));
  }
  m.version++;
}

/**
 * Стекание за обновление: из каждой клетки к четырём соседям ниже уходит доля
 * минерала, пропорциональная перепаду поверхности (вместе — не больше
 * половины). Поверхность — грунт плюс лежащий на нём растворённый минерал:
 * большая куча сама создаёт уклон и расползается, ровный фон стоит.
 * Количество сохраняется; в перегородки не стекает.
 */
function runoff(field: Float64Array, ground: Float64Array, deposits: Float64Array, blocked: Uint8Array, cols: number, rows: number, perLevel: number, P: number): Float64Array {
  const out = Float64Array.from(field);
  const surf = (n: number) => (ground[n] + deposits[n] + field[n]) / perLevel;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      const a = field[k];
      if (a === 0 || blocked[k]) continue;
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
  return out;
}

/** Доля извержения, вышедшая к доле его времени u ∈ [0, 1]: профиль sin² — плавный подъём и спад. */
function eruptionProfile(u: number): number {
  const t = Math.min(1, Math.max(0, u));
  return t - Math.sin(2 * Math.PI * t) / (2 * Math.PI);
}

/** Круг выброса вокруг вулкана — только в своём отсеке; гуще у вулкана. */
function ventCells(x: number, y: number, region: number, blocked: Uint8Array, regions: Int32Array): { cells: Int32Array; weights: Float64Array } {
  const r = ERUPTION_RADIUS;
  const cells: number[] = [];
  const weights: number[] = [];
  let wsum = 0;
  const i0 = Math.max(0, Math.floor((x - r) / MINERAL_CELL)), i1 = Math.min(COLS - 1, Math.floor((x + r) / MINERAL_CELL));
  const j0 = Math.max(0, Math.floor((y - r) / MINERAL_CELL)), j1 = Math.min(ROWS - 1, Math.floor((y + r) / MINERAL_CELL));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const k = j * COLS + i;
      if (blocked[k] || regions[k] !== region) continue;
      const d = Math.hypot((i + 0.5) * MINERAL_CELL - x, (j + 0.5) * MINERAL_CELL - y);
      if (d > r) continue;
      const w = 1 - (d / r) ** 2;
      cells.push(k);
      weights.push(w);
      wsum += w;
    }
  }
  return { cells: Int32Array.from(cells), weights: Float64Array.from(weights, (w) => w / wsum) };
}

/** Выбросить `amount` минерала в круг вулкана. */
function release(m: MineralState, vol: Volcano, amount: number): void {
  for (let n = 0; n < vol.cells.length; n++) m.field[vol.cells[n]] += amount * vol.weights[n];
}

/** Минерал, взятый из недр идущими извержениями, но ещё не вышедший, — «в пути»; входит в общий запас. */
export function mineralInEruptions(m: MineralState): number {
  return m.volcanoes.reduce((a, v) => a + (v.active ? v.left : 0), 0);
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

