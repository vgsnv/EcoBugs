/**
 * Минерал (спецификация, раздел «Минерал»): постоянное количество, переходит
 * между средой, телами, останками и недрами. Здесь — среда и недра (тел и
 * останков пока нет): растворённый минерал на сетке, снос несёт его,
 * осаждение уводит в недра, вулканы редко и нерегулярно выбрасывают его
 * обратно — по одному за раз, каждое извержение длится своё время и выбрасывает
 * своё количество.
 *
 * Это состояние мира: обновляется раз в MINERAL_PERIOD шагов на фиксированных
 * шагах, поэтому ход мира не зависит от скорости показа. Перенос сносом
 * сохраняет количество: минерал клетки делится между клетками вокруг точки
 * назначения; в перегородки не попадает.
 */
import {
  DISH_HEIGHT, DISH_WIDTH, ERUPTION_DURATION, ERUPTION_RADIUS, ERUPTION_SHARE, ERUPTION_SPREAD,
  MAX_ACTIVE_ERUPTIONS, MINERAL_CELL, MINERAL_PERIOD, MINERAL_SETTLE, MINERAL_START_DEPTHS, MINERAL_LAYER, TURBIDITY,
  VOLCANO_MIN_GAP, VOLCANO_POWER,
} from './constants.ts';
import type { Drift } from './drift.ts';
import { periodicFbm } from './noise.ts';
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
  /** Номер следующего извержения и шаг, с которого оно может начаться (если никто не мешает). */
  k: number;
  next: number;
  /** Идёт ли извержение; до какого шага; сколько минерала за шаг и сколько ещё осталось выбросить. */
  active: boolean;
  until: number;
  rate: number;
  left: number;
}

export interface MineralState {
  readonly cols: number;
  readonly rows: number;
  readonly cell: number;
  /** Растворённый минерал в клетке (количество, не плотность). */
  field: Float64Array;
  /** Минерал в недрах. */
  depths: number;
  readonly volcanoes: readonly Volcano[];
  /** Растёт при каждом обновлении — чтобы показ знал, что пора перерисовать. */
  version: number;
  /** Неизменное: занятые клетки и отсек клетки (-1 — занята). */
  readonly blocked: Uint8Array;
  readonly region: Int32Array;
  /** Сколько свободной площади — для пересчёта количества в плотность. */
  readonly freeArea: number;
}

const COLS = Math.ceil(DISH_WIDTH / MINERAL_CELL);
const ROWS = Math.ceil(DISH_HEIGHT / MINERAL_CELL);

/** Промежуток до извержения k вулкана v. */
function interval(seed: number, mean: number, v: number, k: number): number {
  const u = hash3(seed, v, k) / 4294967296;
  return Math.max(1, Math.round(mean * (ERUPTION_SPREAD[0] + (ERUPTION_SPREAD[1] - ERUPTION_SPREAD[0]) * u)));
}

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

  // Стартовое распределение — случайное из сида: пятнистое поле.
  const noise = periodicFbm(deriveSeed(params.seed, 'mineral'), 8, 6, 3);
  const field = new Float64Array(n);
  let sum = 0;
  for (let j = 0; j < ROWS; j++) {
    for (let i = 0; i < COLS; i++) {
      const k = j * COLS + i;
      if (blocked[k]) continue;
      const v = Math.max(0, noise(((i + 0.5) / COLS) * 8, ((j + 0.5) / ROWS) * 6) + 0.55) ** 2;
      field[k] = v;
      sum += v;
    }
  }
  const scale = sum > 0 ? (total * (1 - MINERAL_START_DEPTHS)) / sum : 0;
  for (let k = 0; k < n; k++) field[k] *= scale;

  const volcanoes = placeVolcanoes(params, blocked, region);
  return { cols: COLS, rows: ROWS, cell, field, depths: total * MINERAL_START_DEPTHS, volcanoes, version: 0, blocked, region, freeArea };
}

/** Вулканы: хотя бы один в каждом отсеке, остальные — где угодно; не теснее VOLCANO_MIN_GAP, если есть место. */
function placeVolcanoes(params: WorldParams, blocked: Uint8Array, region: Int32Array): Volcano[] {
  const rng = new Rng(deriveSeed(params.seed, 'volcanoes'));
  const regions = Math.max(0, ...region) + 1;
  const count = Math.max(params.volcanoCount, regions);
  const timing = deriveSeed(params.seed, 'eruptions');
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
    // Первое извержение — в случайной фазе, чтобы вулканы не начинали разом.
    const first = Math.round(interval(timing, params.eruptionInterval, v, 0) * (hash3(timing, v, 0, 1) / 4294967296));
    const power = VOLCANO_POWER[0] + (VOLCANO_POWER[1] - VOLCANO_POWER[0]) * rng.next();
    const { cells, weights } = ventCells(x, y, r, blocked, region);
    out.push({ x, y, region: r, power, cells, weights, k: 1, next: Math.max(1, first), active: false, until: 0, rate: 0, left: 0 });
  }
  return out;
}

/**
 * Обновление минерала за промежуток (step − MINERAL_PERIOD, step]: снос,
 * осаждение, наступившие извержения — в порядке шага мира.
 */
export function updateMineral(m: MineralState, params: WorldParams, drift: Drift, partitions: PartitionLayout, step: number): void {
  const { cols, rows, cell, blocked } = m;
  const P = MINERAL_PERIOD;
  const tMid = step - P / 2;
  const src = m.field;
  const dst = new Float64Array(src.length);
  // Сетки минерала и течений совпадают — снос клетки берётся прямо из узлов поля.
  const { a: fa, b: fb, u: fu } = drift.nodes(tMid);
  const sameGrid = fa.cols === cols && fa.rows === rows;
  const v: [number, number] = [0, 0];

  // 1. Снос: перенос с сохранением количества.
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      const amount = src[k];
      if (amount === 0 || blocked[k]) continue;
      const x = (i + 0.5) * cell, y = (j + 0.5) * cell;
      if (sameGrid) {
        v[0] = fa.vx[k] + (fb.vx[k] - fa.vx[k]) * fu;
        v[1] = fa.vy[k] + (fb.vy[k] - fa.vy[k]) * fu;
      } else {
        drift.at(x, y, tMid, v);
      }
      let dx = v[0] * P, dy = v[1] * P;
      if (dx === 0 && dy === 0) { dst[k] += amount; continue; }
      // Слоистость: уносится не больше слоя, толщина которого растёт с силой
      // течения; остальное лежит на месте и смывается в следующие разы.
      const layer = MINERAL_LAYER * Math.hypot(v[0], v[1]) * P * cell * cell;
      const moved = Math.min(amount, layer);
      dst[k] += amount - moved;
      // Не перескакивать перегородки: идём по пути и останавливаемся перед преградой.
      const len = Math.hypot(dx, dy);
      const probes = Math.ceil(len / (cell * 0.5));
      let f = 1;
      for (let p = 1; p <= probes; p++) {
        const t = p / probes;
        if (isBlocked(partitions, x + dx * t, y + dy * t)) { f = (p - 1) / probes; break; }
      }
      dx *= f; dy *= f;
      // Точка назначения → доли четырёх соседних клеток; в занятые — не кладём.
      const fx = (x + dx) / cell - 0.5, fy = (y + dy) / cell - 0.5;
      const i0 = Math.floor(fx), j0 = Math.floor(fy);
      const u = fx - i0, w = fy - j0;
      const parts: [number, number, number][] = [[i0, j0, (1 - u) * (1 - w)], [i0 + 1, j0, u * (1 - w)], [i0, j0 + 1, (1 - u) * w], [i0 + 1, j0 + 1, u * w]];
      let kept = 0;
      for (const [a, b, share] of parts) {
        if (share === 0) continue;
        if (a < 0 || b < 0 || a >= cols || b >= rows || blocked[b * cols + a]) { kept += share; continue; }
        dst[b * cols + a] += moved * share;
      }
      dst[k] += moved * kept;
    }
  }

  // 2. Осаждение: доля уходит в недра — больше оттуда, где больше.
  const keep = (1 - MINERAL_SETTLE) ** P;
  let settled = 0;
  for (let k = 0; k < dst.length; k++) {
    const a = dst[k];
    if (a === 0) continue;
    const s = a * (1 - keep);
    dst[k] = a - s;
    settled += s;
  }
  m.depths += settled;
  m.field = dst;

  // 3. Извержения: идущие выбрасывают свою долю за промежуток; кончились —
  // назначается следующее. Затем, если есть место, начинаются дождавшиеся
  // своей очереди — по порядку, кто дольше ждёт.
  const timing = deriveSeed(params.seed, 'eruptions');
  m.volcanoes.forEach((vol, index) => {
    if (!vol.active) return;
    const out = step >= vol.until ? vol.left : Math.min(vol.left, vol.rate * P);
    release(m, vol, out);
    vol.left -= out;
    if (step >= vol.until) {
      vol.active = false;
      vol.left = 0;
      vol.next = vol.until + interval(timing, params.eruptionInterval, index, vol.k);
    }
  });
  for (;;) {
    if (m.volcanoes.filter((v) => v.active).length >= MAX_ACTIVE_ERUPTIONS) break;
    let pick = -1;
    m.volcanoes.forEach((v, i) => {
      if (!v.active && v.next <= step && (pick < 0 || v.next < m.volcanoes[pick].next)) pick = i;
    });
    if (pick < 0) break;
    const vol = m.volcanoes[pick];
    const u1 = hash3(timing, pick, vol.k, 2) / 4294967296;
    const u2 = hash3(timing, pick, vol.k, 3) / 4294967296;
    const share = Math.min(0.9, (ERUPTION_SHARE[0] + (ERUPTION_SHARE[1] - ERUPTION_SHARE[0]) * u1) * vol.power);
    const duration = Math.round(ERUPTION_DURATION[0] + (ERUPTION_DURATION[1] - ERUPTION_DURATION[0]) * u2);
    // Выбрасывается доля недр на момент начала; из недр забирается сразу —
    // минерал «в пути» до выхода, общее количество не меняется.
    const amount = m.depths * share;
    m.depths -= amount;
    vol.active = true;
    vol.until = step + duration;
    vol.left = amount;
    vol.rate = amount / duration;
    vol.k++;
  }
  m.version++;
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

