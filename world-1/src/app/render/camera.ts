/** Камера: центр вида в единицах мира и масштаб — пикселей устройства на единицу мира. */
import type { World } from '../../core/index.ts';

/** Воздух вокруг чашки, чтобы её тень оставалась видимой в режиме «вся чашка». */
export const TABLE_INSET = 16;
/** Наибольшее приближение — пикселей экрана (CSS) на единицу мира. */
const MAX_ZOOM_CSS = 24;

export type Transform = [number, number, number, number, number, number];

export class Camera {
  cx = 0;
  cy = 0;
  zoom = 1;
  /** Вид «вся чашка»: при изменении размера окна остаётся вписанным. */
  fitted = true;
  private width = 1;
  private height = 1;
  /** Запас сдвига за край чашки при приближении, пикселей экрана (CSS) — под миникарту. */
  margin = 0;
  /** Толщина стены вокруг чашки, единиц мира. */
  private wall = 0;
  private readonly canvas: HTMLCanvasElement;
  private readonly zoomChanged: (relative: number) => void;

  constructor(canvas: HTMLCanvasElement, zoomChanged: (relative: number) => void) {
    this.canvas = canvas;
    this.zoomChanged = zoomChanged;
  }

  /** Потолок плотности пикселей отрисовки: по умолчанию 1 — рисовать в CSS-пикселях и на экранах Retina (вдвое меньше точек по оси, видеокарте легче, расчёт идёт быстрее). `?dpr=2` — родная плотность. */
  static maxDpr = 1;

  get dpr(): number {
    return Math.min(Camera.maxDpr, window.devicePixelRatio || 1);
  }

  setWorld(world: World): void {
    this.width = world.dish.width;
    this.height = world.dish.height;
    this.wall = world.partitions.thickness;
  }

  /** Масштаб, при котором чашка со стенкой целиком вписана в холст. */
  fitZoom(): number {
    return Math.min(Math.max(1, this.canvas.width - 2 * TABLE_INSET * this.dpr) / (this.width + 2 * this.wall), Math.max(1, this.canvas.height - 2 * TABLE_INSET * this.dpr) / (this.height + 2 * this.wall));
  }

  /** Установить вид: масштаб в допустимых пределах, чашка не уезжает из кадра. */
  setView(zoom: number, cx: number, cy: number): void {
    const min = this.fitZoom();
    const max = Math.max(min, MAX_ZOOM_CSS * this.dpr);
    this.zoom = Math.min(max, Math.max(min, zoom));
    this.fitted = this.zoom <= min * 1.0001;
    const clampAxis = (c: number, size: number, view: number) => {
      const half = view / this.zoom / 2;
      const inset = (TABLE_INSET + (this.fitted ? 0 : this.margin)) * this.dpr / this.zoom;
      const lo = -this.wall - inset + half, hi = size + this.wall + inset - half;
      return lo > hi ? size / 2 : Math.min(hi, Math.max(lo, c));
    };
    this.cx = clampAxis(cx, this.width, this.canvas.width);
    this.cy = clampAxis(cy, this.height, this.canvas.height);
    this.zoomChanged(this.zoom / min);
  }

  /** Показать чашку целиком по центру области карты. */
  fit(): void {
    this.setView(0, this.width / 2, this.height / 2);
  }

  /** Приблизить (factor > 1) или отдалить так, чтобы точка экрана осталась на месте; без точки — центр. */
  zoomBy(factor: number, clientX?: number, clientY?: number): void {
    const rect = this.canvas.getBoundingClientRect();
    const sx = clientX === undefined ? this.canvas.width / 2 : (clientX - rect.left) * this.dpr;
    const sy = clientY === undefined ? this.canvas.height / 2 : (clientY - rect.top) * this.dpr;
    const [wx, wy] = this.screenToWorld(sx, sy);
    const z = Math.min(Math.max(this.fitZoom(), MAX_ZOOM_CSS * this.dpr), Math.max(this.fitZoom(), this.zoom * factor));
    this.setView(z, wx - (sx - this.canvas.width / 2) / z, wy - (sy - this.canvas.height / 2) / z);
  }

  /** Сдвинуть вид на столько пикселей экрана (CSS). */
  panBy(dx: number, dy: number): void {
    this.setView(this.zoom, this.cx - (dx * this.dpr) / this.zoom, this.cy - (dy * this.dpr) / this.zoom);
  }

  screenToWorld(sx: number, sy: number): [number, number] {
    return [this.cx + (sx - this.canvas.width / 2) / this.zoom, this.cy + (sy - this.canvas.height / 2) / this.zoom];
  }

  /** Точка окна → координаты мира (без проверки, внутри ли чашки). */
  clientToWorld(clientX: number, clientY: number): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    return this.screenToWorld((clientX - rect.left) * this.dpr, (clientY - rect.top) * this.dpr);
  }

  /** Видимая часть мира: [x0, y0, x1, y1]. */
  visible(): [number, number, number, number] {
    const [x0, y0] = this.screenToWorld(0, 0);
    const [x1, y1] = this.screenToWorld(this.canvas.width, this.canvas.height);
    return [x0, y0, x1, y1];
  }

  /** Перенос мира на экран: ctx.setTransform с этими числами. */
  view(): Transform {
    const z = this.zoom;
    return [z, 0, 0, z, this.canvas.width / 2 - this.cx * z, this.canvas.height / 2 - this.cy * z];
  }

  /** Перенос мира на вспомогательный холст другого разрешения, покрывающий тот же экран. */
  viewOn(target: HTMLCanvasElement): Transform {
    const [a, b, c, d, e, f] = this.view();
    const sx = target.width / this.canvas.width, sy = target.height / this.canvas.height;
    return [a * sx, b * sy, c * sx, d * sy, e * sx, f * sy];
  }

  /** Экранные пиксели (CSS) → единицы мира (для толщины линий). */
  px(n: number): number {
    return (n * this.dpr) / this.zoom;
  }
}
