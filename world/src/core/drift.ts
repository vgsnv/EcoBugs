/**
 * Снос (спецификация, раздел «Снос»): течения начинаются на краю пятен света
 * с силой, ослабленной средой в месте старта, и идут наружу, по самой дешёвой
 * дороге; по пути тратят силу пропорционально сопротивлению движению; кончаются, где сила иссякла или встретились течения
 * от разных пятен. Смещение за шаг равно силе течения в точке.
 *
 * Расчёт — «расстояние с ценой» от краёв пятен на грубой сетке (Дейкстра),
 * перегородки непроходимы. Направление — прочь от пятна вдоль этого поля.
 * Поле пересчитывается раз в DRIFT_PERIOD шагов, между пересчётами — плавный
 * переход, поэтому снос — функция номера шага.
 */
import { DISH_HEIGHT, DISH_WIDTH, DRIFT_CELL, DRIFT_DECAY, DRIFT_PERIOD, DRIFT_SOURCE } from './constants.ts';
import { rasterizeSpotIntensity, sunAt, type LightMap } from './light.ts';
import type { WorldParams } from './params.ts';
import { isBlocked, type PartitionLayout } from './partitions.ts';
import { resistanceAt, type ViscosityMap } from './viscosity.ts';

/** Течения в один момент: вектор сноса в центре каждой клетки. */
export interface DriftField {
  readonly cols: number;
  readonly rows: number;
  readonly cell: number;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
}

interface Sources {
  readonly params: WorldParams;
  readonly light: LightMap;
  readonly viscosity: ViscosityMap;
  readonly partitions: PartitionLayout;
}

/** Минимальная двоичная куча по стоимости (индексы клеток). */
class Heap {
  private keys = new Float64Array(1024);
  private vals = new Int32Array(1024);
  size = 0;

  push(key: number, val: number): void {
    if (this.size === this.keys.length) {
      const k = new Float64Array(this.size * 2); k.set(this.keys); this.keys = k;
      const v = new Int32Array(this.size * 2); v.set(this.vals); this.vals = v;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= key) break;
      this.keys[i] = this.keys[p];
      this.vals[i] = this.vals[p];
      i = p;
    }
    this.keys[i] = key;
    this.vals[i] = val;
  }

  /** Снять минимум; возвращает индекс клетки, стоимость — в `lastKey`. */
  pop(): number {
    const top = this.vals[0];
    this.lastKey = this.keys[0];
    const key = this.keys[--this.size];
    const val = this.vals[this.size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.keys[c + 1] < this.keys[c]) c++;
      if (this.keys[c] >= key) break;
      this.keys[i] = this.keys[c];
      this.vals[i] = this.vals[c];
      i = c;
    }
    this.keys[i] = key;
    this.vals[i] = val;
    return top;
  }

  lastKey = 0;
}

const NEIGHBORS: readonly [number, number, number][] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

/** Неизменное на сетке течений: преграды и сопротивление движению. */
interface Ground {
  readonly blocked: Uint8Array;
  readonly resistance: Float32Array;
}

function groundOf(world: Sources, cols: number, rows: number, cell: number): Ground {
  const blocked = new Uint8Array(cols * rows);
  const resistance = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      const x = (i + 0.5) * cell;
      const y = (j + 0.5) * cell;
      blocked[k] = isBlocked(world.partitions, x, y) ? 1 : 0;
      resistance[k] = resistanceAt(world.params, world.viscosity, x, y);
    }
  }
  return { blocked, resistance };
}

const COLS = Math.ceil(DISH_WIDTH / DRIFT_CELL);
const ROWS = Math.ceil(DISH_HEIGHT / DRIFT_CELL);

/** Течения в шаге t. */
export function computeDriftField(world: Sources, t: number, ground: Ground = groundOf(world, COLS, ROWS, DRIFT_CELL)): DriftField {
  const cell = DRIFT_CELL;
  const cols = COLS;
  const rows = ROWS;
  const n = cols * rows;
  // Запас силы на старте пропорционален силе солнца: ярче — течения сильнее и длиннее.
  const budget = world.params.driftStrength * sunAt(world.light, t);
  const vx = new Float32Array(n);
  const vy = new Float32Array(n);
  if (budget <= 0) return { cols, rows, cell, vx, vy };

  const intensity = rasterizeSpotIntensity(world.light, t, cols, rows, cell);
  const { blocked, resistance } = ground;

  // Потраченная сила: на краях пятен — сколько отняла среда на старте, дальше
  // растёт по пути; Infinity — не дошло.
  const spent = new Float32Array(n).fill(Infinity);
  const source = new Uint8Array(n);
  const baseViscosity = world.params.baseViscosity;
  const heap = new Heap();
  for (let k = 0; k < n; k++) {
    if (!blocked[k] && intensity[k] >= DRIFT_SOURCE) {
      // На старте течение тоже ослаблено средой: сила = сила сноса / множитель
      // градации (вода — полная, отмель — втрое, суша — вдевятеро слабее).
      source[k] = 1;
      spent[k] = budget * (1 - baseViscosity / resistance[k]);
      heap.push(spent[k], k);
    }
  }
  while (heap.size > 0) {
    const k = heap.pop();
    const cost = heap.lastKey;
    if (cost > spent[k] || cost >= budget) continue;
    const i = k % cols;
    const j = (k - i) / cols;
    for (const [di, dj, len] of NEIGHBORS) {
      const a = i + di, b = j + dj;
      if (a < 0 || b < 0 || a >= cols || b >= rows) continue;
      const m = b * cols + a;
      if (blocked[m]) continue;
      // По диагонали — только если не срезаем угол преграды.
      if (di !== 0 && dj !== 0 && (blocked[j * cols + a] || blocked[b * cols + i])) continue;
      const next = cost + DRIFT_DECAY * len * cell * 0.5 * (resistance[k] + resistance[m]);
      if (next < spent[m]) {
        spent[m] = next;
        heap.push(next, m);
      }
    }
  }

  // Вектор: направление — прочь от пятна (по росту потраченной силы), величина —
  // оставшаяся сила. Где встречаются течения, рост с разных сторон гасит друг
  // друга — там течение кончается.
  const reached = (k: number) => !blocked[k] && spent[k] < budget;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      if (!reached(k) || source[k]) continue;
      const here = spent[k];
      const side = (m: number, ok: boolean) => (ok && reached(m) ? spent[m] - here : 0);
      // Разности в обе стороны: наружу — положительные, к пятну — отрицательные.
      const ex = side(k + 1, i < cols - 1) - side(k - 1, i > 0);
      const ey = side(k + cols, j < rows - 1) - side(k - cols, j > 0);
      const g = Math.hypot(ex, ey);
      if (g === 0) continue;
      // Ожидаемый рост за две клетки при здешнем сопротивлении: на гребне, где
      // встречаются течения, разность мала, и сила гаснет.
      const expected = 2 * DRIFT_DECAY * cell * resistance[k];
      const coherence = Math.min(1, g / expected);
      const s = (budget - here) * coherence;
      vx[k] = (ex / g) * s;
      vy[k] = (ey / g) * s;
    }
  }
  return { cols, rows, cell, vx, vy };
}

/**
 * Снос во времени: поля в узлах через DRIFT_PERIOD шагов, между ними —
 * линейный переход. Держит два последних узла.
 */
export class Drift {
  private readonly world: Sources;
  private readonly cache = new Map<number, DriftField>();
  private ground: Ground | null = null;

  constructor(world: Sources) {
    this.world = world;
  }

  private node(k: number): DriftField {
    let f = this.cache.get(k);
    if (!f) {
      this.ground ??= groundOf(this.world, COLS, ROWS, DRIFT_CELL);
      f = computeDriftField(this.world, k * DRIFT_PERIOD, this.ground);
      this.cache.set(k, f);
      while (this.cache.size > 3) this.cache.delete(this.cache.keys().next().value!);
    }
    return f;
  }

  /** Поля в двух узлах вокруг шага t и доля пути между ними — для обхода клеток без интерполяции по точке. */
  nodes(t: number): { a: DriftField; b: DriftField; u: number } {
    const k = Math.floor(t / DRIFT_PERIOD);
    return { a: this.node(k), b: this.node(k + 1), u: t / DRIFT_PERIOD - k };
  }

  /** Снос в точке (x, y) в шаге t: смещение за шаг, единиц мира. */
  at(x: number, y: number, t: number, out: [number, number] = [0, 0]): [number, number] {
    const k = Math.floor(t / DRIFT_PERIOD);
    const u = t / DRIFT_PERIOD - k;
    const a = this.node(k);
    const b = this.node(k + 1);
    const [ax, ay] = sample(a, x, y);
    const [bx, by] = sample(b, x, y);
    out[0] = ax + (bx - ax) * u;
    out[1] = ay + (by - ay) * u;
    return out;
  }
}

/** Билинейное чтение поля. */
function sample(f: DriftField, x: number, y: number): [number, number] {
  const fx = Math.min(f.cols - 1, Math.max(0, x / f.cell - 0.5));
  const fy = Math.min(f.rows - 1, Math.max(0, y / f.cell - 0.5));
  const i0 = Math.floor(fx), j0 = Math.floor(fy);
  const i1 = Math.min(f.cols - 1, i0 + 1), j1 = Math.min(f.rows - 1, j0 + 1);
  const u = fx - i0, v = fy - j0;
  const k00 = j0 * f.cols + i0, k10 = j0 * f.cols + i1, k01 = j1 * f.cols + i0, k11 = j1 * f.cols + i1;
  const lerp2 = (arr: Float32Array) => {
    const a = arr[k00] + (arr[k10] - arr[k00]) * u;
    const b = arr[k01] + (arr[k11] - arr[k01]) * u;
    return a + (b - a) * v;
  };
  return [lerp2(f.vx), lerp2(f.vy)];
}
