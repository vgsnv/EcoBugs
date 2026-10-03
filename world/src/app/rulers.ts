import type { Dish } from '../core/index.ts';
import { formatLength } from './units.ts';

/** Удобные деления 1–2–5, расстояние между подписями не меньше 90 CSS px. */
export function rulerStep(cssPixelsPerUnit: number): number {
  const wanted = 90 / cssPixelsPerUnit;
  const order = 10 ** Math.floor(Math.log10(wanted));
  return [1, 2, 5, 10].find(n => n * order >= wanted)! * order;
}
export function rulerTicks(from: number, to: number, limit: number, step: number): number[] {
  const first = Math.max(0, Math.ceil(from / step));
  const last = Math.floor(Math.min(limit, to) / step + 1e-9);
  return Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => (first + i) * step);
}

/** Полосы с подписями вне карты; пути сетки и полосы кешируются до изменения камеры. */
export class CoordinateRulers {
  private readonly horizontal = document.createElement('canvas');
  private readonly vertical = document.createElement('canvas');
  private key = '';
  private major = new Path2D();
  private minor = new Path2D();
  enabled = false;

  private readonly canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.horizontal.className = 'ruler ruler-x';
    this.vertical.className = 'ruler ruler-y';
    this.horizontal.setAttribute('aria-label', 'Координата X, слева направо');
    this.vertical.setAttribute('aria-label', 'Координата Y, сверху вниз');
    this.horizontal.hidden = this.vertical.hidden = true;
    canvas.parentElement!.append(this.horizontal, this.vertical);
  }

  toggle(enabled: boolean): void {
    this.enabled = enabled;
    this.horizontal.hidden = this.vertical.hidden = !enabled;
    this.canvas.parentElement!.classList.toggle('rulers-on', enabled);
    this.key = '';
  }

  draw(ctx: CanvasRenderingContext2D, dish: Dish, zoom: number, cx: number, cy: number, dpr: number): void {
    if (!this.enabled) return;
    const width = this.canvas.width, height = this.canvas.height;
    const x0 = cx - width / zoom / 2, y0 = cy - height / zoom / 2;
    const x1 = x0 + width / zoom, y1 = y0 + height / zoom;
    const step = rulerStep(zoom / dpr);
    const key = `${width}:${height}:${zoom}:${cx}:${cy}:${dpr}:${dish.width}:${dish.height}`;
    if (key !== this.key) {
      this.key = key;
      this.major = new Path2D(); this.minor = new Path2D();
      const lines = (path: Path2D, stride: number) => {
        for (const x of rulerTicks(x0, x1, dish.width, stride)) { path.moveTo(x, Math.max(0, y0)); path.lineTo(x, Math.min(dish.height, y1)); }
        for (const y of rulerTicks(y0, y1, dish.height, stride)) { path.moveTo(Math.max(0, x0), y); path.lineTo(Math.min(dish.width, x1), y); }
      };
      lines(this.minor, step / 5); lines(this.major, step);
      this.drawScale(this.horizontal, false, x0, x1, dish.width, step, zoom, dpr);
      this.drawScale(this.vertical, true, y0, y1, dish.height, step, zoom, dpr);
    }
    ctx.save();
    ctx.setTransform(zoom, 0, 0, zoom, width / 2 - cx * zoom, height / 2 - cy * zoom);
    ctx.beginPath();
    if (dish.shape === 'circle') ctx.arc(dish.width / 2, dish.height / 2, dish.width / 2, 0, Math.PI * 2);
    else ctx.rect(0, 0, dish.width, dish.height);
    ctx.clip();
    ctx.lineWidth = dpr / zoom;
    ctx.strokeStyle = 'rgba(225,240,255,.15)'; ctx.stroke(this.minor);
    ctx.strokeStyle = 'rgba(235,245,255,.42)'; ctx.stroke(this.major);
    ctx.restore();
  }

  private drawScale(canvas: HTMLCanvasElement, vertical: boolean, from: number, to: number, limit: number, step: number, zoom: number, dpr: number): void {
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    const width = canvas.width / dpr, height = canvas.height / dpr;
    ctx.fillStyle = '#f3f5f8'; ctx.fillRect(0, 0, width, height);
    ctx.font = '10px system-ui, sans-serif'; ctx.fillStyle = '#59636e';
    ctx.strokeStyle = '#a4b2c3'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (const value of rulerTicks(from, to, limit, step / 5)) {
      const at = (value - from) * zoom / dpr;
      const major = Math.abs(value / step - Math.round(value / step)) < 1e-7;
      const length = major ? 7 : 3;
      if (vertical) { ctx.moveTo(width, at); ctx.lineTo(width - length, at); }
      else { ctx.moveTo(at, 0); ctx.lineTo(at, length); }
    }
    ctx.stroke();
    for (const value of rulerTicks(from, to, limit, step)) {
      const at = (value - from) * zoom / dpr;
      const text = formatLength(value);
      const half = ctx.measureText(text).width / 2 + 2;
      const span = vertical ? height : width;
      // У края подпись сдвигается внутрь полосы; риска остаётся на своей координате.
      const labelAt = Math.max(half, Math.min(span - half, at));
      ctx.save();
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      if (vertical) { ctx.translate(10, labelAt); ctx.rotate(-Math.PI / 2); ctx.fillText(text, 0, 0); }
      else ctx.fillText(text, labelAt, 16);
      ctx.restore();
    }
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(vertical ? 'Y' : 'X', 2, 2);
  }
}
