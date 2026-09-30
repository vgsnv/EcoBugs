/**
 * Перегородки (спецификация, раздел «Перегородки»): неподвижные тонкие стенки
 * внутри чашки — ломаные из горизонтальных и вертикальных отрезков, стыкующихся
 * под прямым углом. Планировка — одна из готовых заготовок; при создании мира
 * не генерируется. Заготовка — данные: вершины ломаных в долях размера чашки.
 * Конец перегородки прикреплён, если лежит на стенке или на другой перегородке.
 */
import { PARTITION_CELL, PARTITION_THICKNESS } from './constants.ts';
import type { LayoutId } from './params.ts';

/** Вершина ломаной в долях ширины и высоты чашки. */
export type Vertex = readonly [number, number];

export interface LayoutPreset {
  readonly id: LayoutId;
  readonly name: string;
  /** Сколько замкнутых частей образует планировка (1 — чашка не разделена). */
  readonly regions: number;
  readonly partitions: readonly (readonly Vertex[])[];
}

/** Готовые заготовки. Соседние вершины совпадают по x или по y. */
export const LAYOUT_PRESETS: Readonly<Record<LayoutId, LayoutPreset>> = {
  open: { id: 'open', name: 'Открытая чашка', regions: 1, partitions: [] },
  lagoons: {
    id: 'lagoons',
    name: 'Лагуны',
    regions: 1,
    partitions: [
      [[0, 0.3], [0.18, 0.3], [0.18, 0.08]],
      [[0.55, 1], [0.55, 0.78], [0.75, 0.78], [0.75, 0.92]],
      [[1, 0.35], [0.84, 0.35], [0.84, 0.55], [0.93, 0.55]],
    ],
  },
  corridors: {
    id: 'corridors',
    name: 'Коридоры',
    regions: 1,
    partitions: [
      [[0.33, 0], [0.33, 0.45], [0.28, 0.45], [0.28, 0.9]],
      [[0.67, 1], [0.67, 0.55], [0.72, 0.55], [0.72, 0.1]],
    ],
  },
  compartments: {
    id: 'compartments',
    name: 'Отсеки',
    regions: 3,
    partitions: [
      [[0.3, 0], [0.3, 0.5], [0.26, 0.5], [0.26, 1]],
      [[1, 0.3], [0.6, 0.3], [0.6, 0.4], [0.3, 0.4]],
    ],
  },
  mixed: {
    id: 'mixed',
    name: 'Отсеки с коридором и лагунами',
    regions: 2,
    partitions: [
      [[0, 0.45], [0.5, 0.45], [0.5, 0.5], [1, 0.5]],
      [[0.4, 0], [0.4, 0.33]],
      [[0.25, 1], [0.25, 0.78], [0.45, 0.78], [0.45, 0.9]],
      [[1, 0.8], [0.82, 0.8], [0.82, 0.93]],
    ],
  },
};

/** Перегородка в единицах мира: вершины ломаной. */
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

const EPS = 1e-6;

/** Расстояние от точки до отрезка. */
export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const u = len2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + dx * u), py - (ay + dy * u));
}

function onWall(p: readonly [number, number], width: number, height: number): boolean {
  return p[0] <= EPS || p[1] <= EPS || p[0] >= width - EPS || p[1] >= height - EPS;
}

function onPolyline(p: readonly [number, number], points: readonly (readonly [number, number])[]): boolean {
  for (let s = 1; s < points.length; s++) {
    if (distToSegment(p[0], p[1], points[s - 1][0], points[s - 1][1], points[s][0], points[s][1]) <= EPS) return true;
  }
  return false;
}

/** Точки вдоль ломаной с шагом не больше `step` — для проверок и растеризации. */
export function densify(points: readonly (readonly [number, number])[], step: number): [number, number][] {
  const out: [number, number][] = [];
  for (let s = 1; s < points.length; s++) {
    const [ax, ay] = points[s - 1];
    const [bx, by] = points[s];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  if (points.length > 0) out.push([points[points.length - 1][0], points[points.length - 1][1]]);
  return out;
}

export function buildLayout(id: LayoutId, width: number, height: number): PartitionLayout {
  const preset = LAYOUT_PRESETS[id];
  // Вершины выравниваются по сетке растра (стенки чашки — точно по краю):
  // тогда растр перегородок совпадает с их геометрией без зазоров.
  const cell = PARTITION_CELL;
  const snap = (f: number, size: number) => (f <= 0 ? 0 : f >= 1 ? size : Math.min(size, Math.round((f * size) / cell) * cell));
  const polylines = preset.partitions.map((verts) => verts.map(([u, v]) => [snap(u, width), snap(v, height)] as [number, number]));
  polylines.forEach((pts, pi) => {
    for (let s = 1; s < pts.length; s++) {
      const horizontal = Math.abs(pts[s][1] - pts[s - 1][1]) <= EPS;
      const vertical = Math.abs(pts[s][0] - pts[s - 1][0]) <= EPS;
      if (horizontal === vertical) throw new Error(`Заготовка ${id}: отрезок ${s} перегородки ${pi} не горизонтальный и не вертикальный`);
    }
  });
  const partitions: Partition[] = polylines.map((pts, pi) => {
    const others = polylines.filter((_, k) => k !== pi);
    const attachedEnd = (p: readonly [number, number]) => onWall(p, width, height) || others.some((o) => onPolyline(p, o));
    return { points: pts, attached: [attachedEnd(pts[0]), attachedEnd(pts[pts.length - 1])] };
  });

  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const blocked = new Uint8Array(cols * rows);
  const reach = PARTITION_THICKNESS / 2;
  for (const part of partitions) {
    for (let s = 1; s < part.points.length; s++) {
      // Отрезок с квадратными концами: прямоугольник толщиной `thickness`.
      const [ax, ay] = part.points[s - 1];
      const [bx, by] = part.points[s];
      const x0 = Math.min(ax, bx) - reach;
      const x1 = Math.max(ax, bx) + reach;
      const y0 = Math.min(ay, by) - reach;
      const y1 = Math.max(ay, by) + reach;
      const i0 = Math.max(0, Math.floor(x0 / cell));
      const i1 = Math.min(cols - 1, Math.ceil(x1 / cell) - 1);
      const j0 = Math.max(0, Math.floor(y0 / cell));
      const j1 = Math.min(rows - 1, Math.ceil(y1 / cell) - 1);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) blocked[j * cols + i] = 1;
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

/** Занята ли точка чашки перегородкой (по растру); за пределами чашки — стена. */
export function isBlocked(layout: PartitionLayout, x: number, y: number): boolean {
  const i = Math.floor(x / layout.cell);
  const j = Math.floor(y / layout.cell);
  if (i < 0 || j < 0 || i >= layout.cols || j >= layout.rows) return true;
  return layout.blocked[j * layout.cols + i] === 1;
}
