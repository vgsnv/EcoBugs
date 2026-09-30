/**
 * Минерал (спецификация, раздел «Минерал»): постоянное количество, переходит
 * между средой, телами, останками и недрами. Здесь — среда и недра (тел и
 * останков пока нет): растворённый минерал на сетке, снос несёт его,
 * осаждение уводит в недра, вулканы редко и нерегулярно выбрасывают его обратно.
 *
 * Это состояние мира: обновляется раз в MINERAL_PERIOD шагов на фиксированных
 * шагах, поэтому ход мира не зависит от скорости показа. Перенос сносом
 * сохраняет количество: минерал клетки делится между клетками вокруг точки
 * назначения; в перегородки не попадает.
 */
import {
  DISH_HEIGHT, DISH_WIDTH, ERUPTION_RADIUS, ERUPTION_SHARE, ERUPTION_SPREAD,
  MINERAL_CELL, MINERAL_PERIOD, MINERAL_SETTLE, MINERAL_START_DEPTHS, VOLCANO_MIN_GAP,
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
  /** Номер следующего извержения и шаг, на котором оно наступит. */
  k: number;
  next: number;
}

export interface Eruption {
  readonly volcano: number;
  readonly step: number;
  readonly amount: number;
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
  /** Последние извержения — для показа. */
  readonly recent: Eruption[];
  /** Растёт при каждом обновлении — чтобы показ знал, что пора перерисовать. */
  version: number;
  /** Неизменное: занятые клетки и отсек клетки (-1 — занята). */
  readonly blocked: Uint8Array;
  readonly region: Int32Array;
  /** Сколько свободной площади — для пересчёта количества в плотность. */
  readonly freeArea: number;
}

const RECENT = 32;
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
  return { cols: COLS, rows: ROWS, cell, field, depths: total * MINERAL_START_DEPTHS, volcanoes, recent: [], version: 0, blocked, region, freeArea };
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
    out.push({ x, y, region: r, k: 1, next: Math.max(1, first) });
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
        dst[b * cols + a] += amount * share;
      }
      dst[k] += amount * kept;
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

  // 3. Извержения, наступившие в этом промежутке.
  const timing = deriveSeed(params.seed, 'eruptions');
  m.volcanoes.forEach((vol, index) => {
    while (vol.next <= step) {
      erupt(m, index);
      vol.next += interval(timing, params.eruptionInterval, index, vol.k);
      vol.k++;
    }
  });
  m.version++;
}

/** Вулкан выбрасывает долю недр в круг вокруг себя — только в своём отсеке. */
function erupt(m: MineralState, index: number): void {
  const vol = m.volcanoes[index];
  const amount = m.depths * ERUPTION_SHARE;
  const { cols, rows, cell } = m;
  const r = ERUPTION_RADIUS;
  const cells: number[] = [];
  const weights: number[] = [];
  let wsum = 0;
  const i0 = Math.max(0, Math.floor((vol.x - r) / cell)), i1 = Math.min(cols - 1, Math.floor((vol.x + r) / cell));
  const j0 = Math.max(0, Math.floor((vol.y - r) / cell)), j1 = Math.min(rows - 1, Math.floor((vol.y + r) / cell));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const k = j * cols + i;
      if (m.blocked[k] || m.region[k] !== vol.region) continue;
      const d = Math.hypot((i + 0.5) * cell - vol.x, (j + 0.5) * cell - vol.y);
      if (d > r) continue;
      // Гуще у вулкана, реже к краю круга.
      const w = 1 - (d / r) ** 2;
      cells.push(k);
      weights.push(w);
      wsum += w;
    }
  }
  if (wsum === 0) return;
  for (let n = 0; n < cells.length; n++) m.field[cells[n]] += (amount * weights[n]) / wsum;
  m.depths -= amount;
  m.recent.push({ volcano: index, step: vol.next, amount });
  if (m.recent.length > RECENT) m.recent.shift();
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
