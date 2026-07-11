/**
 * Пространственная сетка (spatial hash) для поиска ближайшей еды (см. PLAN.md §3, п.5).
 * Без неё поиск соседей O(n²) и потолок в пару сотен существ.
 *
 * Мир тороидальный: сетка заворачивается по обеим осям, и дистанции считаются
 * с учётом кратчайшего пути через край.
 *
 * Детерминизм: порядок обхода ячеек и элементов внутри фиксирован (индексы —
 * упорядоченные массивы), поэтому при равных дистанциях выбор `nearest` стабилен.
 */
export class SpatialGrid {
  private readonly cols: number;
  private readonly rows: number;
  private readonly cell: number;
  private readonly w: number;
  private readonly h: number;
  private readonly cells: number[][];

  constructor(width: number, height: number, cell: number) {
    this.w = width;
    this.h = height;
    this.cell = cell;
    this.cols = Math.max(1, Math.ceil(width / cell));
    this.rows = Math.max(1, Math.ceil(height / cell));
    this.cells = Array.from({ length: this.cols * this.rows }, () => [] as number[]);
  }

  private idx(x: number, y: number): number {
    let cx = Math.floor(x / this.cell) % this.cols;
    let cy = Math.floor(y / this.cell) % this.rows;
    if (cx < 0) cx += this.cols;
    if (cy < 0) cy += this.rows;
    return cy * this.cols + cx;
  }

  clear(): void {
    for (const c of this.cells) c.length = 0;
  }

  insert(i: number, x: number, y: number): void {
    this.cells[this.idx(x, y)].push(i);
  }

  /**
   * Индекс ближайшей точки (из параллельных массивов xs/ys) в радиусе `radius`,
   * либо -1. Дистанция тороидальная. Обходим кольцо ячеек вокруг (x,y).
   */
  nearest(
    x: number,
    y: number,
    radius: number,
    xs: Float32Array,
    ys: Float32Array,
  ): number {
    const reach = Math.ceil(radius / this.cell);
    let cx = Math.floor(x / this.cell) % this.cols;
    let cy = Math.floor(y / this.cell) % this.rows;
    if (cx < 0) cx += this.cols;
    if (cy < 0) cy += this.rows;

    let best = -1;
    let bd2 = radius * radius;
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        let gx = (cx + dx) % this.cols;
        let gy = (cy + dy) % this.rows;
        if (gx < 0) gx += this.cols;
        if (gy < 0) gy += this.rows;
        const bucket = this.cells[gy * this.cols + gx];
        for (const j of bucket) {
          let ex = Math.abs(x - xs[j]);
          let ey = Math.abs(y - ys[j]);
          if (ex > this.w * 0.5) ex = this.w - ex;
          if (ey > this.h * 0.5) ey = this.h - ey;
          const d2 = ex * ex + ey * ey;
          if (d2 < bd2) {
            bd2 = d2;
            best = j;
          }
        }
      }
    }
    return best;
  }
}
