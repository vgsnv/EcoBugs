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
  DISH_HEIGHT, DISH_WIDTH, ERUPTION_DURATION, ERUPTION_RADIUS, ERUPTION_RADIUS_MIN, ERUPTION_SHARE, ERUPTION_BURST, ERUPTION_FRONT, ERUPTION_TAIL_AREA, BLAST_FADE, MINERAL_SPREAD,
  MINERAL_CELL, MINERAL_PERIOD, MINERAL_SETTLE, MINERAL_SINK_SETTLE, MINERAL_SEEP, MINERAL_LAYER, MINERAL_MOBILITY, DRIFT_REFERENCE, TURBIDITY, EROSION, EROSION_THRESHOLD, GROUND_PER_LEVEL, RUNOFF, WEATHERING,
  DEPOSIT_SINK, DEPOSIT_DISSOLVE, ERUPTION_MAX, ERUPTION_PRESSURE, ERUPTION_DURATION_SCALE, GENESIS_SPEEDUP,
  VOLCANO_MIN_GAP, VOLCANO_POWER, VOLCANO_BIRTH, VOLCANO_MATURE, VOLCANO_EXTINCT_CHANCE, VOLCANO_WAKE_CHANCE, VOLCANO_DORMANT_LIFE, VOLCANO_FADE, VOLCANO_DEPOSIT_AVOID,
} from './constants.ts';
import type { Drift } from './drift.ts';
import { sunAt, type LightMap } from './light.ts';
import { moveGround, type TerrainState } from './terrain.ts';
import type { WorldParams } from './params.ts';
import { freeRegions, isBlocked, type PartitionLayout } from './partitions.ts';
import { Rng, deriveSeed, hash3 } from './prng.ts';
import { multiplierForLevel } from './viscosity.ts';

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

/** Числа вулкана — для файла мира и контрольной суммы (без клеток круга — они выводятся). */
export function volcanoNumbers(v: Volcano): number[] {
  return [v.id, v.x, v.y, v.power, VOLCANO_STAGES.indexOf(v.stage), v.stageAt, v.stageUntil, v.fresh ? 1 : 0, v.k, v.begin, v.until, v.total, v.left, v.rate];
}

/** Вулкан из чисел volcanoNumbers; null — числа негодные. */
export function volcanoFromNumbers(m: MineralState, params: WorldParams, n: unknown): Volcano | null {
  if (!Array.isArray(n) || n.length !== 14 || !n.every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
  const [id, x, y, power, stage, stageAt, stageUntil, fresh, k, begin, until, total, left, rate] = n as number[];
  if (!Number.isSafeInteger(id) || !Number.isInteger(stage) || stage < 0 || stage > 3 || (fresh !== 0 && fresh !== 1) || !Number.isSafeInteger(k)) return null;
  if (x < 0 || y < 0 || x > DISH_WIDTH || y > DISH_HEIGHT || power <= 0 || total < 0 || left < 0) return null;
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

  const threshold = total * ERUPTION_PRESSURE * (0.5 + hash3(deriveSeed(params.seed, 'eruptions'), -1, 4) / 4294967296);
  return { cols: COLS, rows: ROWS, cell, field, depths: total, threshold, eruptions: 0, genesis: true, volcanoes: [], births: 0, version: 0, blocked, nearWall: nearWalls(blocked), region, freeArea };
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
  /** Сила течения и снос в клетке — для намыва, размыва и оседания там, куда уходит поток. */
  const speed = new Float32Array(src.length);
  const flowX = new Float32Array(src.length), flowY = new Float32Array(src.length);

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
      flowX[k] = v[0];
      flowY[k] = v[1];
      const amount = src[k];
      if (amount === 0) continue;
      const flow = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
      let dx = v[0] * P, dy = v[1] * P;
      if (dx === 0 && dy === 0) { dst[k] += amount; continue; }
      // Слоистость: уносится не больше слоя, толщина которого растёт с силой
      // течения; остальное лежит на месте и смывается в следующие разы.
      // Толщина слоя растёт с силой течения и падает с вязкостью: в воде
      // уносится почти всё, на отмели — тонкий слой, на суше — почти ничего.
      const mob = multiplierForLevel(terrain.applied[k]);
      const layer = (MINERAL_LAYER * MINERAL_MOBILITY * flow * P * cell * cell) / (mob * mob);
      const moved = Math.min(amount, layer);
      dst[k] += amount - moved;
      // Не перескакивать перегородки: рядом с ними идём по пути и
      // останавливаемся перед преградой (вдали от перегородок путь свободен).
      if (m.nearWall[k] || flow * P > NEAR_WALL * cell) {
        const probes = Math.ceil((flow * P) / (cell * 0.5));
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

  // 1б. Растекание: от густого к редкому, медленнее там, где вязкость выше.
  spread(dst, terrain.applied, blocked, cols, rows, MINERAL_SPREAD);

  // 2. Местность и залежи.
  const sMax = DRIFT_REFERENCE * sunAt(light, tMid);
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
    // Где поток сходится и уходит (в тени), принесённый им минерал оседает —
    // тем больше, чем сильнее схождение.
    const i = k % cols, j = (k - i) / cols;
    const ux = (n: number) => (blocked[n] ? flowX[k] : flowX[n]), uy = (n: number) => (blocked[n] ? flowY[k] : flowY[n]);
    const div = ((i < cols - 1 ? ux(k + 1) : flowX[k]) - (i > 0 ? ux(k - 1) : flowX[k])
      + (j < rows - 1 ? uy(k + cols) : flowY[k]) - (j > 0 ? uy(k - cols) : flowY[k])) / (2 * cell);
    const sink = Math.min(0.9, Math.max(0, -div) * MINERAL_SINK_SETTLE * P * params.terrainSpeed);
    const settled = dst[k] * (1 - (1 - settle * calm * calm) * (1 - sink)) * room;
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

  // Просачивание: растворённый минерал, застрявший в вязком (отмель, суша),
  // понемногу уходит в недра — тем быстрее, чем выше вязкость; в воде — нет.
  const seep = (1 - (1 - MINERAL_SEEP) ** P) * params.terrainSpeed;
  let seeped = 0;
  for (let k = 0; k < m.field.length; k++) {
    if (blocked[k] || m.field[k] === 0) continue;
    const thick = (multiplierForLevel(terrain.applied[k]) - 1) / 8;
    if (thick <= 0) continue;
    const g = m.field[k] * seep * thick;
    m.field[k] -= g;
    seeped += g;
  }
  m.depths += seeped;

  // Подвижки и толчки: подъём — из опускающегося соседа и недр, опускание
  // топит залежи в недра.
  m.depths += moveGround(terrain, params, m.depths, step - P, step, cols, rows, cell, blocked);

  // 3. Вулканы и извержения — от давления недр. Когда давление доходит до
  // доли порога и никто не готовится и не извергается, следующий вулкан
  // начинает готовиться: просыпается спящий или рождается новый. Созревший
  // извергается, как только давление дошло до порога, — тем сильнее и дольше,
  // чем больше накопилось; начинается с начала промежутка, поэтому первый
  // выброс выходит сразу. Извержение выбрасывает больше всего в начале, дальше
  // всё меньше и всё ближе к вулкану. После — случай: потух или уснул.
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
  for (const vol of m.volcanoes) {
    if (vol.stage !== 'erupting') continue;
    const d = vol.until - vol.begin;
    const u0 = (step - P - vol.begin) / d, u1 = (step - vol.begin) / d;
    // Жерло впрыскивает в среду объём: всё вокруг расталкивается наружу
    // (импульс), а вышедшее вещество заполняет новый объём у жерла (см. blast).
    const out = step >= vol.until ? vol.left : Math.min(vol.left, Math.max(0, vol.total * (eruptionProfile(u1) - eruptionProfile(u0))));
    blast(m, terrain, partitions, vol, injectedArea(vol, Math.max(0, u0)), injectedArea(vol, u1), out);
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
 * Темп извержения — залп и хвост. Залп (доля ERUPTION_BURST) выходит за
 * первые ERUPTION_FRONT времени — темп и скорость выброса в начале велики,
 * масса летит далеко. Хвост выходит всё извержение, слабея (темп ∝ 1 − u), —
 * скорость выброса мала, масса остаётся у жерла, и течения тянут её шлейфами.
 */
const ease = (t: number) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 2;
function burstProfile(u: number): number {
  return ERUPTION_BURST * ease(u / ERUPTION_FRONT);
}
function tailProfile(u: number): number {
  return (1 - ERUPTION_BURST) * ease(u);
}

/** Доля извержения, вышедшая к доле его времени u ∈ [0, 1]. */
export function eruptionProfile(u: number): number {
  return burstProfile(u) + tailProfile(u);
}

/** Темп выброса в доле времени u относительно начального, 0…1 — для показа. */
export function eruptionRate(u: number): number {
  const t = Math.min(1, Math.max(0, u));
  const burst = t < ERUPTION_FRONT ? (ERUPTION_BURST * 2 * (1 - t / ERUPTION_FRONT)) / ERUPTION_FRONT : 0;
  const tail = (1 - ERUPTION_BURST) * 2 * (1 - t);
  return (burst + tail) / ((ERUPTION_BURST * 2) / ERUPTION_FRONT + (1 - ERUPTION_BURST) * 2);
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
  const { cols, rows, cell, blocked } = m;
  const start = Math.min(rows - 1, Math.floor(y / cell)) * cols + Math.min(cols - 1, Math.floor(x / cell));
  const dist = new Map<number, number>([[start, 0]]);
  const done = new Set<number>();
  // Двоичная куча по расстоянию.
  const heap: number[] = [start];
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
 * Сколько объёма (площади) жерло впрыснуло в среду к доле времени u: залп —
 * круг радиуса выброса за первые ERUPTION_FRONT времени (это и есть волна),
 * хвост — круг ERUPTION_TAIL_AREA радиуса за остальное время. Площади
 * складываются: к концу среда вокруг расступилась на √(залп + хвост).
 */
export function injectedArea(vol: Volcano, u: number): number {
  const burst = Math.PI * vol.radius * vol.radius;
  const tail = Math.PI * (vol.radius * ERUPTION_TAIL_AREA) ** 2;
  return burst * (burstProfile(u) / ERUPTION_BURST) + tail * (tailProfile(u) / (1 - ERUPTION_BURST));
}

/** Докуда (вязкое расстояние, по воде) расступилась среда вокруг жерла к шагу t — край впрыснутого объёма. */
export function blastReach(vol: Volcano, t: number): number {
  const u = Math.min(1, Math.max(0, (t - vol.begin) / Math.max(1, vol.until - vol.begin)));
  return Math.sqrt(injectedArea(vol, u) / Math.PI);
}

/**
 * Импульс извержения за обновление: жерло впрыскивает площадь A1 − A0, и всё,
 * что лежало на вязком расстоянии d, сдвигается наружу до √(d² + (A1 − A0)/π)
 * — вокруг стало больше места, среда расступается; в вязком сдвиг меньше
 * (÷ множитель вязкости), за краем радиуса выброса затухает; направление — по
 * росту вязкого расстояния (огибает перегородки), сквозь преграды не идёт.
 * Сдвигается весь минерал на пути. Вышедшее вещество `amount` ложится ровно в
 * новый объём у жерла. Количество сохраняется.
 */
function blast(m: MineralState, terrain: TerrainState, partitions: PartitionLayout, vol: Volcano, a0: number, a1: number, amount: number): void {
  const { cols, rows, cell, blocked } = m;
  const added = Math.max(0, a1 - a0);
  const field = viscousDistances(m, terrain, vol.x, vol.y, vol.radius * BLAST_FADE);
  if (added > 0) {
    const dist = new Map<number, number>();
    for (let q = 0; q < field.cells.length; q++) dist.set(field.cells[q], field.dists[q]);
    const moved = new Float64Array(m.field.length);
    for (let q = 0; q < field.cells.length; q++) {
      const k = field.cells[q], d = field.dists[q];
      const mass = m.field[k];
      if (mass === 0) continue;
      const i = k % cols, j = (k - i) / cols;
      // Направление — к соседям дальше от жерла; у самого жерла — от его центра.
      let gx = 0, gy = 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if ((di === 0 && dj === 0) || i + di < 0 || j + dj < 0 || i + di >= cols || j + dj >= rows) continue;
          const dn = dist.get((j + dj) * cols + i + di);
          if (dn === undefined || dn <= d) continue;
          const len = Math.hypot(di, dj);
          gx += ((dn - d) * di) / len;
          gy += ((dn - d) * dj) / len;
        }
      }
      const g = Math.hypot(gx, gy);
      if (g === 0) continue;
      const fade = Math.max(0, Math.min(1, (vol.radius * BLAST_FADE - d) / (vol.radius * (BLAST_FADE - 1))));
      let shift = ((Math.sqrt(d * d + added / Math.PI) - d) * fade) / multiplierForLevel(terrain.applied[k]);
      if (shift <= 0) continue;
      const x = (i + 0.5) * cell, y = (j + 0.5) * cell;
      let dx = (gx / g) * shift, dy = (gy / g) * shift;
      // Сквозь преграды — нет: останавливаемся перед первой на пути.
      const probes = Math.ceil(shift / (cell * 0.5));
      for (let p = 1; p <= probes; p++) {
        if (isBlocked(partitions, x + (dx * p) / probes, y + (dy * p) / probes)) { shift = (shift * (p - 1)) / probes; break; }
      }
      dx = (gx / g) * shift;
      dy = (gy / g) * shift;
      m.field[k] = 0;
      spill(moved, blocked, cols, rows, cell, x + dx, y + dy, mass, k);
    }
    for (let k = 0; k < moved.length; k++) m.field[k] += moved[k];
  }
  // Вышедшее вещество — в новый объём у жерла: круг площади (A1 − A0), всё
  // прежнее уже сдвинуто наружу (не меньше клетки жерла).
  if (amount > 0) {
    const reach = Math.max(cell * 0.75, Math.sqrt(added / Math.PI));
    let n = 0;
    for (let q = 0; q < field.cells.length; q++) if (field.dists[q] <= reach) n++;
    for (let q = 0; q < field.cells.length; q++) if (field.dists[q] <= reach) m.field[field.cells[q]] += amount / n;
  }
}

/** Положить `mass` в точку (x, y): доли четырёх соседних клеток, в занятые — не кладём (остаток — в `home`). */
function spill(out: Float64Array, blocked: Uint8Array, cols: number, rows: number, cell: number, x: number, y: number, mass: number, home: number): void {
  const fx = x / cell - 0.5, fy = y / cell - 0.5;
  const i0 = Math.floor(fx), j0 = Math.floor(fy);
  const u = fx - i0, w = fy - j0;
  let kept = 0;
  const put = (i: number, j: number, s: number) => {
    if (s <= 0) return;
    if (i < 0 || j < 0 || i >= cols || j >= rows || blocked[j * cols + i]) { kept += s; return; }
    out[j * cols + i] += mass * s;
  };
  put(i0, j0, (1 - u) * (1 - w));
  put(i0 + 1, j0, u * (1 - w));
  put(i0, j0 + 1, (1 - u) * w);
  put(i0 + 1, j0 + 1, u * w);
  out[home] += mass * kept;
}

/**
 * Растекание за обновление: между соседними клетками переходит доля разницы,
 * тем меньше, чем выше вязкость обеих (в воде — `rate`); через перегородки нет.
 * Количество сохраняется.
 */
function spread(field: Float64Array, level: Float32Array, blocked: Uint8Array, cols: number, rows: number, rate: number): void {
  const flow = new Float64Array(field.length);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      if (blocked[k]) continue;
      const mk = multiplierForLevel(level[k]);
      // Только вправо и вниз — каждая пара один раз.
      if (i < cols - 1 && !blocked[k + 1]) {
        const f = (rate * 2 * (field[k] - field[k + 1])) / (mk + multiplierForLevel(level[k + 1]));
        flow[k] -= f;
        flow[k + 1] += f;
      }
      if (j < rows - 1 && !blocked[k + cols]) {
        const f = (rate * 2 * (field[k] - field[k + cols])) / (mk + multiplierForLevel(level[k + cols]));
        flow[k] -= f;
        flow[k + cols] += f;
      }
    }
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

