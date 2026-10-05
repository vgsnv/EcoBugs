/**
 * «Процессы»: цвет — реальные обмены за последний промежуток: у минерала —
 * размыв и прирост залежей и уход в недра (последнее обновление), у грунта —
 * намыв и размыв течениями и тектонический подъём и опускание (уровня за
 * шаг, скользящее среднее — render/ground.ts). Стрелки — использованная сумма течений; где
 * течения несут грунт, стрелки песочные и толще. Идущие подвижки подписаны
 * «поднимается» или «опускается» (их кромку рисует шейдер полей).
 */
import { DRIFT_REFERENCE, MINERAL_PERIOD, SAND_RATE, type MineralProcesses, type Movement } from '../../core/index.ts';
import type { Frame } from './frame.ts';
import { traceDish, type Rgb } from './palette.ts';

/** Цвета процессов (они же — в легенде панели). */
export const PROCESS_COLORS = {
  erosion: [232, 133, 54] as Rgb,
  settling: [50, 201, 149] as Rgb,
  sinking: [194, 123, 255] as Rgb,
  sandIn: [236, 210, 112] as Rgb,
  sandOut: [168, 92, 64] as Rgb,
  rise: [255, 92, 92] as Rgb,
  sink: [74, 136, 255] as Rgb,
} as const;

/** Данные грунта для карты процессов (render/ground.ts). */
export interface GroundProcesses {
  readonly rates: { readonly sand: Float32Array; readonly tectonic: Float32Array; readonly version: number };
  readonly lift: (x: number, y: number) => number;
  readonly movements: readonly Movement[];
}

/** С какой силы переноса стрелка песочная. */
const SAND_ARROW = 0.25;

export class ProcessesLayer {
  private readonly canvas = document.createElement('canvas');
  private drawn: MineralProcesses | null = null;
  private drawnGround = -1;

  reset(): void {
    this.drawn = null;
    this.drawnGround = -1;
  }

  draw(frame: Frame, d: MineralProcesses | null, ground: GroundProcesses): void {
    if (!d) return;
    const { ctx, camera, world } = frame;
    const m = world.mineral;
    ctx.save();
    ctx.beginPath(); traceDish(ctx, world.dish); ctx.clip();
    if (this.drawn !== d || this.drawnGround !== ground.rates.version) {
      this.drawn = d;
      this.drawnGround = ground.rates.version;
      const c = this.canvas;
      if (c.width !== m.cols || c.height !== m.rows) { c.width = m.cols; c.height = m.rows; }
      const dc = c.getContext('2d')!;
      const image = dc.createImageData(m.cols, m.rows);
      const reference = world.params.mineralStock * m.cell * m.cell;
      // Мерило грунта: десятая доля уровня за шаг при сильном переносе (подвижка — несколько мерил).
      const groundRef = 0.1 * SAND_RATE / MINERAL_PERIOD;
      const { sand, tectonic } = ground.rates;
      const C = PROCESS_COLORS;
      let weight = 0, r = 0, g = 0, b = 0;
      const add = (w: number, col: Rgb) => { weight += w; r += w * col[0]; g += w * col[1]; b += w * col[2]; };
      for (let k = 0; k < m.field.length; k++) {
        if (m.blocked[k]) continue;
        // Минерал — в долях запаса, грунт — в долях мерила; цвет — смесь по весам, яркость — по сумме.
        weight = r = g = b = 0;
        const scale = 100 / reference;
        if (d.erosion[k] > 0) add(d.erosion[k] * scale, C.erosion);
        if (d.settling[k] > 0) add(d.settling[k] * scale, C.settling);
        if (d.sinking[k] > 0) add(d.sinking[k] * scale, C.sinking);
        const sv = sand.length ? sand[k] / groundRef : 0, tv = tectonic.length ? tectonic[k] / groundRef : 0;
        if (sv !== 0) add(Math.abs(sv), sv > 0 ? C.sandIn : C.sandOut);
        if (tv !== 0) add(Math.abs(tv), tv > 0 ? C.rise : C.sink);
        if (weight <= 0) continue;
        const o = k * 4;
        image.data[o] = r / weight;
        image.data[o + 1] = g / weight;
        image.data[o + 2] = b / weight;
        image.data[o + 3] = 210 * Math.min(1, Math.log1p(weight) / Math.log(11));
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
    const water = new Path2D(), sandy = new Path2D();
    for (let j = jmin; j < Math.min(m.rows, Math.ceil(y1 / m.cell)); j += stride) {
      for (let i = imin; i < Math.min(m.cols, Math.ceil(x1 / m.cell)); i += stride) {
        const k = j * m.cols + i;
        const speed = Math.hypot(d.vx[k], d.vy[k]);
        if (m.blocked[k] || speed < 1e-5) continue;
        const ux = d.vx[k] / speed, uy = d.vy[k] / speed;
        const length = camera.px(7 + 17 * speed / (speed + DRIFT_REFERENCE));
        const x = (i + 0.5) * m.cell, y = (j + 0.5) * m.cell;
        const ex = x + ux * length / 2, ey = y + uy * length / 2, head = camera.px(4);
        const path = ground.lift(x, y) > SAND_ARROW ? sandy : water;
        path.moveTo(x - ux * length / 2, y - uy * length / 2); path.lineTo(ex, ey);
        path.moveTo(ex - ux * head - uy * head * 0.6, ey - uy * head + ux * head * 0.6);
        path.lineTo(ex, ey);
        path.lineTo(ex - ux * head + uy * head * 0.6, ey - uy * head - ux * head * 0.6);
      }
    }
    ctx.lineWidth = camera.px(1.3);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.stroke(water);
    ctx.lineWidth = camera.px(2);
    ctx.strokeStyle = 'rgba(244, 214, 128, 0.95)';
    ctx.stroke(sandy);
    // Подписи идущих подвижек — в середине участка.
    ctx.font = `600 ${camera.px(12)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (const mv of ground.movements) {
      const label = mv.amp > 0 ? 'поднимается ↑' : 'опускается ↓';
      const col = mv.amp > 0 ? PROCESS_COLORS.rise : PROCESS_COLORS.sink;
      ctx.lineWidth = camera.px(3);
      ctx.strokeStyle = 'rgba(12, 28, 40, 0.8)';
      ctx.strokeText(label, mv.x, mv.y);
      ctx.fillStyle = `rgb(${Math.min(255, col[0] + 60)}, ${Math.min(255, col[1] + 60)}, ${Math.min(255, col[2] + 60)})`;
      ctx.fillText(label, mv.x, mv.y);
    }
    ctx.restore();
  }
}
