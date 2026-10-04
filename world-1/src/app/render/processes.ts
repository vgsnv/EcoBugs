/** «Процессы»: цвет — реальные обмены за последний промежуток; стрелки — использованная сумма течений. */
import { DRIFT_REFERENCE, type MineralProcesses } from '../../core/index.ts';
import type { Frame } from './frame.ts';
import { traceDish } from './palette.ts';

export class ProcessesLayer {
  private readonly canvas = document.createElement('canvas');
  private drawn: MineralProcesses | null = null;

  reset(): void {
    this.drawn = null;
  }

  draw(frame: Frame, d: MineralProcesses | null): void {
    if (!d) return;
    const { ctx, camera, world } = frame;
    const m = world.mineral;
    ctx.save();
    ctx.beginPath(); traceDish(ctx, world.dish); ctx.clip();
    if (this.drawn !== d) {
      this.drawn = d;
      const c = this.canvas;
      if (c.width !== m.cols || c.height !== m.rows) { c.width = m.cols; c.height = m.rows; }
      const dc = c.getContext('2d')!;
      const image = dc.createImageData(m.cols, m.rows);
      const reference = world.params.mineralStock * m.cell * m.cell;
      for (let k = 0; k < m.field.length; k++) {
        const e = d.erosion[k], s = d.settling[k], n = d.sinking[k];
        const total = e + s + n;
        if (total <= 0) continue;
        const o = k * 4;
        image.data[o] = (232 * e + 50 * s + 194 * n) / total;
        image.data[o + 1] = (133 * e + 201 * s + 123 * n) / total;
        image.data[o + 2] = (54 * e + 149 * s + 255 * n) / total;
        image.data[o + 3] = 210 * Math.min(1, Math.log1p(total / reference * 100) / Math.log(11));
      }
      dc.putImageData(image, 0, 0);
    }
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.canvas, 0, 0, m.cols * m.cell, m.rows * m.cell);
    // Сетка стрелок редкая и сохраняет читаемость при любом масштабе.
    const stride = Math.max(1, Math.ceil(camera.px(42) / m.cell));
    const [x0, y0, x1, y1] = camera.visible();
    const imin = Math.max(0, Math.floor(x0 / m.cell / stride) * stride);
    const jmin = Math.max(0, Math.floor(y0 / m.cell / stride) * stride);
    ctx.lineWidth = camera.px(1.3);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    for (let j = jmin; j < Math.min(m.rows, Math.ceil(y1 / m.cell)); j += stride) {
      for (let i = imin; i < Math.min(m.cols, Math.ceil(x1 / m.cell)); i += stride) {
        const k = j * m.cols + i;
        const speed = Math.hypot(d.vx[k], d.vy[k]);
        if (m.blocked[k] || speed < 1e-5) continue;
        const ux = d.vx[k] / speed, uy = d.vy[k] / speed;
        const length = camera.px(7 + 17 * speed / (speed + DRIFT_REFERENCE));
        const x = (i + 0.5) * m.cell, y = (j + 0.5) * m.cell;
        const ex = x + ux * length / 2, ey = y + uy * length / 2, head = camera.px(4);
        ctx.moveTo(x - ux * length / 2, y - uy * length / 2); ctx.lineTo(ex, ey);
        ctx.moveTo(ex - ux * head - uy * head * 0.6, ey - uy * head + ux * head * 0.6);
        ctx.lineTo(ex, ey);
        ctx.lineTo(ex - ux * head + uy * head * 0.6, ey - uy * head - ux * head * 0.6);
      }
    }
    ctx.stroke(); ctx.restore();
  }
}
