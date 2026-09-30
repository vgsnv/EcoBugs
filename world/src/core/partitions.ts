/**
 * Перегородки (спецификация, раздел «Перегородки»): неподвижные тонкие изогнутые
 * стенки внутри чашки. Планировка — одна из готовых заготовок; при создании мира
 * не генерируется. Заготовка — данные: перегородки как плавные сплайны по
 * контрольным точкам в долях размера чашки. Точка может ссылаться на место
 * другой перегородки — так перегородка «упирается» в неё.
 */
import { PARTITION_CELL, PARTITION_SAMPLES, PARTITION_THICKNESS } from './constants.ts';
import type { LayoutId } from './params.ts';

/** Контрольная точка: доли ширины и высоты чашки или место на другой перегородке. */
export type ControlPoint = readonly [number, number] | { readonly on: number; readonly t: number };

export interface LayoutPreset {
  readonly id: LayoutId;
  readonly name: string;
  /** Сколько замкнутых частей образует планировка (1 — чашка не разделена). */
  readonly regions: number;
  readonly partitions: readonly (readonly ControlPoint[])[];
}

/** Готовые заготовки. Порядок перегородок важен: ссылка — только на предыдущие. */
export const LAYOUT_PRESETS: Readonly<Record<LayoutId, LayoutPreset>> = {
  open: { id: 'open', name: 'Открытая чашка', regions: 1, partitions: [] },
  lagoons: {
    id: 'lagoons',
    name: 'Лагуны',
    regions: 1,
    partitions: [
      [[0, 0.3], [0.12, 0.33], [0.2, 0.24], [0.2, 0.08]],
      [[0.55, 1], [0.55, 0.82], [0.65, 0.74], [0.75, 0.8], [0.77, 0.92]],
      [[1, 0.33], [0.88, 0.31], [0.83, 0.42], [0.86, 0.54], [0.93, 0.57]],
    ],
  },
  corridors: {
    id: 'corridors',
    name: 'Коридоры',
    regions: 1,
    partitions: [
      [[0.33, 0], [0.3, 0.35], [0.36, 0.6], [0.33, 0.9]],
      [[0.67, 1], [0.7, 0.65], [0.63, 0.4], [0.67, 0.1]],
    ],
  },
  compartments: {
    id: 'compartments',
    name: 'Отсеки',
    regions: 3,
    partitions: [
      [[0.3, 0], [0.26, 0.35], [0.34, 0.7], [0.3, 1]],
      [[1, 0.3], [0.8, 0.27], [0.6, 0.37], { on: 0, t: 0.4 }],
    ],
  },
  mixed: {
    id: 'mixed',
    name: 'Отсеки с коридором и лагунами',
    regions: 2,
    partitions: [
      [[0, 0.45], [0.35, 0.5], [0.65, 0.4], [1, 0.48]],
      [[0.5, 0], [0.47, 0.18], [0.5, 0.32]],
      [[0.25, 1], [0.25, 0.8], [0.35, 0.72], [0.45, 0.78], [0.47, 0.9]],
      [[1, 0.8], [0.86, 0.78], [0.8, 0.86], [0.83, 0.94]],
    ],
  },
};

/** Перегородка в единицах мира: ломаная по сплайну. */
export interface Partition {
  readonly points: readonly (readonly [number, number])[];
  /** Прикреплён ли конец к стенке или другой перегородке (начало, конец). */
  readonly attached: readonly [boolean, boolean];
}

export interface PartitionLayout {
  readonly preset: LayoutPreset;
  readonly partitions: readonly Partition[];
  readonly thickness: number;
  /** Растр: 1 — ячейка занята перегородкой. */
  readonly cols: number;
  readonly rows: number;
  readonly cell: number;
  readonly blocked: Uint8Array;
}

/** Катмулл–Ром через точки; концы продолжаются по направлению крайнего участка. */
function spline(points: readonly (readonly [number, number])[], samples: number): [number, number][] {
  if (points.length < 2) return points.map((p) => [p[0], p[1]]);
  const ext = [
    [2 * points[0][0] - points[1][0], 2 * points[0][1] - points[1][1]],
    ...points,
    [2 * points[points.length - 1][0] - points[points.length - 2][0], 2 * points[points.length - 1][1] - points[points.length - 2][1]],
  ];
  const out: [number, number][] = [];
  for (let s = 1; s < ext.length - 2; s++) {
    const [p0, p1, p2, p3] = [ext[s - 1], ext[s], ext[s + 1], ext[s + 2]];
    for (let k = 0; k < samples; k++) {
      const t = k / samples;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  const last = points[points.length - 1];
  out.push([last[0], last[1]]);
  return out;
}

/** Точка на ломаной по доле её длины. */
export function pointAlong(points: readonly (readonly [number, number])[], t: number): [number, number] {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  let target = total * Math.min(1, Math.max(0, t));
  for (let i = 1; i < points.length; i++) {
    const len = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    if (target <= len || i === points.length - 1) {
      const u = len > 0 ? Math.min(1, target / len) : 0;
      return [points[i - 1][0] + (points[i][0] - points[i - 1][0]) * u, points[i - 1][1] + (points[i][1] - points[i - 1][1]) * u];
    }
    target -= len;
  }
  return [points[0][0], points[0][1]];
}

function onWall(p: readonly [number, number], width: number, height: number): boolean {
  const eps = 1e-6;
  return p[0] <= eps || p[1] <= eps || p[0] >= width - eps || p[1] >= height - eps;
}

/** Расстояние от точки до отрезка. */
export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const u = len2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + dx * u), py - (ay + dy * u));
}

export function buildLayout(id: LayoutId, width: number, height: number): PartitionLayout {
  const preset = LAYOUT_PRESETS[id];
  const partitions: Partition[] = [];
  for (const controls of preset.partitions) {
    const resolved: [number, number][] = [];
    const refs: boolean[] = [];
    for (const c of controls) {
      if (Array.isArray(c)) {
        const [u, v] = c as readonly [number, number];
        resolved.push([u * width, v * height]);
        refs.push(false);
      } else {
        const ref = c as { on: number; t: number };
        if (ref.on >= partitions.length) throw new Error(`Заготовка ${id}: ссылка на ещё не построенную перегородку ${ref.on}`);
        resolved.push(pointAlong(partitions[ref.on].points, ref.t));
        refs.push(true);
      }
    }
    const points = spline(resolved, PARTITION_SAMPLES);
    const first = resolved[0];
    const last = resolved[resolved.length - 1];
    partitions.push({
      points,
      attached: [refs[0] || onWall(first, width, height), refs[refs.length - 1] || onWall(last, width, height)],
    });
  }

  const cell = PARTITION_CELL;
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const blocked = new Uint8Array(cols * rows);
  const reach = PARTITION_THICKNESS / 2 + cell * Math.SQRT1_2;
  for (const part of partitions) {
    for (let s = 1; s < part.points.length; s++) {
      const [ax, ay] = part.points[s - 1];
      const [bx, by] = part.points[s];
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach) / cell));
      const i1 = Math.min(cols - 1, Math.floor((Math.max(ax, bx) + reach) / cell));
      const j0 = Math.max(0, Math.floor((Math.min(ay, by) - reach) / cell));
      const j1 = Math.min(rows - 1, Math.floor((Math.max(ay, by) + reach) / cell));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          if (distToSegment((i + 0.5) * cell, (j + 0.5) * cell, ax, ay, bx, by) <= reach) blocked[j * cols + i] = 1;
        }
      }
    }
  }
  return { preset, partitions, thickness: PARTITION_THICKNESS, cols, rows, cell, blocked };
}

/**
 * Связные свободные части чашки (4-соседство по растру). Возвращает метку части
 * для каждой ячейки (-1 — перегородка) и размеры частей.
 */
export function freeRegions(layout: PartitionLayout): { labels: Int32Array; sizes: number[] } {
  const { cols, rows, blocked } = layout;
  const labels = new Int32Array(cols * rows).fill(-1);
  const sizes: number[] = [];
  const stack = new Int32Array(cols * rows);
  for (let start = 0; start < labels.length; start++) {
    if (blocked[start] || labels[start] !== -1) continue;
    const label = sizes.length;
    let top = 0;
    let size = 0;
    stack[top++] = start;
    labels[start] = label;
    while (top > 0) {
      const k = stack[--top];
      size++;
      const i = k % cols;
      const j = (k - i) / cols;
      const push = (n: number) => { if (!blocked[n] && labels[n] === -1) { labels[n] = label; stack[top++] = n; } };
      if (i > 0) push(k - 1);
      if (i < cols - 1) push(k + 1);
      if (j > 0) push(k - cols);
      if (j < rows - 1) push(k + cols);
    }
    sizes.push(size);
  }
  return { labels, sizes };
}

/** Занята ли точка чашки перегородкой (по растру). */
export function isBlocked(layout: PartitionLayout, x: number, y: number): boolean {
  const i = Math.floor(x / layout.cell);
  const j = Math.floor(y / layout.cell);
  if (i < 0 || j < 0 || i >= layout.cols || j >= layout.rows) return true;
  return layout.blocked[j * layout.cols + i] === 1;
}
