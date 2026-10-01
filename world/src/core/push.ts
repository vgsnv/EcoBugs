/**
 * Толчок и тяга (спецификация, раздел «Снос»): извергающийся вулкан толкает
 * среду от жерла, воронка тянет к отверстию. Это не новая среда, а толчок:
 * он передаётся по среде и гаснет от трения — тем быстрее, чем вязче среда;
 * перегородки и стенки не пропускают.
 *
 * Расчёт — «единичное» течение источника: давление p из баланса в каждой
 * клетке Σ проводимость грани × (p − p соседа) + трение × p = источник
 * (проводимость = 1 ÷ множитель вязкости, трение = множитель ÷ PUSH_LENGTH²
 * в клетках, — дальность в воде PUSH_LENGTH клеток, на отмели втрое, на суше
 * вдевятеро короче). Источник — 1 (площадь за шаг), поровну по клеткам
 * `seeds`. Течение в шаг — сила × единичное: форма не меняется, только сила.
 * Считается только в окне вокруг источника (дальше толчок погас), всегда с
 * одного начального приближения, и кешируется по местности — загрузка точна.
 */
import { PUSH_ITERATIONS, PUSH_LENGTH, PUSH_WINDOW } from './constants.ts';
import { multiplierForLevel } from './viscosity.ts';

/** Единичное течение: скорость (единиц за шаг на единицу силы) на сетке минерала, ненулевая в окне. */
export interface PushField {
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  /** Окно, где течение посчитано (клетки, включительно). */
  readonly i0: number;
  readonly i1: number;
  readonly j0: number;
  readonly j1: number;
}

interface Grid {
  readonly cols: number;
  readonly rows: number;
  readonly cell: number;
  readonly blocked: Uint8Array;
}

/** Кеш по местности (массив уровней заменяется целиком при пересборке) и по ключу источника. */
const cache = new WeakMap<Float32Array, Map<string, PushField>>();

/** Единичное течение от источника в клетках `seeds` (−1 — сток: то же с обратным знаком делает вызывающий). */
export function pushField(grid: Grid, level: Float32Array, key: string, seeds: readonly number[]): PushField {
  let byLevel = cache.get(level);
  if (!byLevel) { byLevel = new Map(); cache.set(level, byLevel); }
  const hit = byLevel.get(key);
  if (hit) return hit;
  const field = solve(grid, level, seeds);
  byLevel.set(key, field);
  return field;
}

function solve(grid: Grid, level: Float32Array, seeds: readonly number[]): PushField {
  const { cols, rows, cell, blocked } = grid;
  // Окно: вокруг источника на PUSH_WINDOW дальностей в воде.
  let si0 = cols, si1 = 0, sj0 = rows, sj1 = 0;
  for (const k of seeds) {
    const i = k % cols, j = (k - i) / cols;
    si0 = Math.min(si0, i); si1 = Math.max(si1, i); sj0 = Math.min(sj0, j); sj1 = Math.max(sj1, j);
  }
  const pad = Math.ceil(PUSH_LENGTH * PUSH_WINDOW);
  const i0 = Math.max(0, si0 - pad), i1 = Math.min(cols - 1, si1 + pad);
  const j0 = Math.max(0, sj0 - pad), j1 = Math.min(rows - 1, sj1 + pad);
  const w = i1 - i0 + 1, h = j1 - j0 + 1;
  const n = w * h;
  // Локальная сетка окна: проводимость, трение, источник.
  const cond = new Float64Array(n), damp = new Float64Array(n), src = new Float64Array(n);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = (j + j0) * cols + (i + i0), q = j * w + i;
      if (blocked[k]) continue;
      const mult = multiplierForLevel(level[k]);
      cond[q] = 1 / mult;
      damp[q] = mult / (PUSH_LENGTH * PUSH_LENGTH);
    }
  }
  const share = 1 / seeds.length;
  for (const k of seeds) {
    const i = k % cols, j = (k - i) / cols;
    src[(j - j0) * w + (i - i0)] += share;
  }
  const face = (a: number, b: number) => (a > 0 && b > 0 ? (2 * a * b) / (a + b) : 0);
  const ce = new Float64Array(n), cs = new Float64Array(n);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const q = j * w + i;
      if (i < w - 1) ce[q] = face(cond[q], cond[q + 1]);
      if (j < h - 1) cs[q] = face(cond[q], cond[q + w]);
    }
  }
  // Гаусс — Зейдель с верхней релаксацией; трение делает задачу устойчивой без баланса.
  const p = new Float64Array(n);
  for (let it = 0; it < PUSH_ITERATIONS; it++) {
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const q = j * w + i;
        if (cond[q] === 0) continue;
        const cw = i > 0 ? ce[q - 1] : 0, cE = ce[q], cn = j > 0 ? cs[q - w] : 0, cS = cs[q];
        const sum = cw + cE + cn + cS + damp[q];
        let acc = src[q];
        if (cw) acc += cw * p[q - 1];
        if (cE) acc += cE * p[q + 1];
        if (cn) acc += cn * p[q - w];
        if (cS) acc += cS * p[q + w];
        p[q] += 1.6 * (acc / sum - p[q]);
      }
    }
  }
  // Скорость клетки — среднее потоков через её грани ÷ ширина грани.
  const vx = new Float32Array(cols * rows), vy = new Float32Array(cols * rows);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const q = j * w + i;
      if (cond[q] === 0) continue;
      const fw = i > 0 ? ce[q - 1] * (p[q - 1] - p[q]) : 0;
      const fe = i < w - 1 ? ce[q] * (p[q] - p[q + 1]) : 0;
      const fn = j > 0 ? cs[q - w] * (p[q - w] - p[q]) : 0;
      const fs = j < h - 1 ? cs[q] * (p[q] - p[q + w]) : 0;
      const k = (j + j0) * cols + (i + i0);
      vx[k] = (fw + fe) / 2 / cell;
      vy[k] = (fn + fs) / 2 / cell;
    }
  }
  return { vx, vy, i0, i1, j0, j1 };
}
