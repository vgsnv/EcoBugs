/**
 * Вода: рябь, переносимая течениями (на освещённой воде), пена у берега там,
 * где течение бьёт в сушу, и блёстки кристаллов залежей в пятнах света.
 */
import { DRIFT_REFERENCE, flowAt, hash3, insideDish, isBlocked, periodicFbm, sunAt, type World } from '../../core/index.ts';
import { WaterFlowShader } from '../water-flow-shader.ts';
import type { Frame } from './frame.ts';
import { smoothstep } from './palette.ts';

/** Блики на освещённой воде: сила, размер узора ряби в единицах мира, скорость, единиц в секунду. */
const GLINT_ALPHA = 0.15;
const GLINT_LAYERS = [
  { size: 130, vx: 5, vy: 2.5 },
  { size: 210, vx: -3.5, vy: 4 },
] as const;
/** Блёстки кристаллов: с какой густоты залежей, скорость мерцания, порог вспышки (доля времени ярко — малая). */
const SPARKLE_DEPOSIT = 2;
const SPARKLE_SPEED = 1.3;
const SPARKLE_THRESHOLD = 0.965;
/** Пена у берега: насколько видна, фактура (размер ряби, единиц мира), ровная часть, пересчёт маски не чаще, мс. */
const FOAM_ALPHA = 0.4;
const FOAM_RIPPLE_SIZE = 60;
const FOAM_BASE = 0.35;
const FOAM_REBUILD_MS = 300;

/** Бесшовная текстура ряби: тонкая светлая сетка там, где шум близок к нулю. */
let rippleTexture: HTMLCanvasElement | null = null;
function ripple(): HTMLCanvasElement {
  if (rippleTexture) return rippleTexture;
  const size = 256;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const tctx = c.getContext('2d')!;
  const img = tctx.createImageData(size, size);
  // Сумма двух шумов со сдвигом: у одного шума нули в узлах решётки дают
  // заметную сетку, у суммы — нет.
  const a = periodicFbm(0x51f7, 4, 4, 2);
  const b = periodicFbm(0x9e37, 4, 4, 2);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = (i / size) * 4, w = (j / size) * 4;
      const n = a(u, w) + b(u + 0.37, w + 0.61);
      const v = Math.max(0, 1 - Math.abs(n) * 6) ** 3;
      const k = (j * size + i) * 4;
      img.data[k] = 255;
      img.data[k + 1] = 250;
      img.data[k + 2] = 230;
      img.data[k + 3] = v * 255;
    }
  }
  tctx.putImageData(img, 0, 0);
  rippleTexture = c;
  return c;
}

export class WaterLayer {
  /** Рабочий слой бликов, пены и блёсток — того же размера, что маска пятен. */
  private readonly glint = document.createElement('canvas');
  private readonly gctx: CanvasRenderingContext2D;
  private readonly ripplePattern: CanvasPattern;
  private readonly waterFlow = new WaterFlowShader(ripple());
  /** Блёстки (x, y, фаза), маска пены и когда она построена. */
  private sparkles = new Float32Array(0);
  private readonly foamCanvas = document.createElement('canvas');
  private foamBuiltAt = 0;
  private foamStep = -1;

  constructor() {
    this.gctx = this.glint.getContext('2d')!;
    this.ripplePattern = this.gctx.createPattern(ripple(), 'repeat')!;
  }

  resetFlow(): void {
    this.waterFlow.reset();
  }

  resetFoam(): void {
    this.foamStep = -1;
  }

  resize(width: number, height: number): void {
    this.glint.width = width;
    this.glint.height = height;
  }

  /** Точки блёсток: на плотных залежах неглубоко — по нескольку на клетку, место и фаза из хеша. */
  buildSparkles(world: World, drawnLevel: Float32Array, drawnDeposit: Float32Array): void {
    const m = world.mineral;
    const out: number[] = [];
    const seed = world.params.seed ^ 0x51a4c;
    for (let k = 0; k < drawnDeposit.length; k++) {
      const d = drawnDeposit[k];
      const L = drawnLevel[k];
      if (d < SPARKLE_DEPOSIT || L < 0.35 || L > 1.6 || m.blocked[k]) continue;
      const count = Math.min(4, Math.floor(d / SPARKLE_DEPOSIT));
      const i = k % m.cols, j = (k - i) / m.cols;
      for (let c = 0; c < count; c++) {
        const h1 = hash3(seed, k, c, 1) / 4294967296, h2 = hash3(seed, k, c, 2) / 4294967296, h3 = hash3(seed, k, c, 3) / 4294967296;
        out.push((i + h1) * m.cell, (j + h2) * m.cell, h3 * Math.PI * 2 * 7);
      }
    }
    this.sparkles = Float32Array.from(out);
  }

  /** Блики: две сдвигающиеся ряби, оставленные только на воде и в пятнах света. */
  drawGlints(frame: Frame, spots: HTMLCanvasElement, waterMask: HTMLCanvasElement, showProcesses: boolean): void {
    const { ctx, canvas, camera, world: w, animTime: time, flowStep, lit } = frame;
    const g = this.gctx;
    const [x0, y0, x1, y1] = camera.visible();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, this.glint.width, this.glint.height);
    const velocity: [number, number] = [0, 0];
    const shader = !showProcesses && this.waterFlow.draw(this.glint.width, this.glint.height, [x0, y0, x1, y1], flowStep, w.step, w.mineral.cell,
      (x, y, out, k) => {
        const allowed = insideDish(w.dish, x, y) && !isBlocked(w.partitions, x, y);
        flowAt(w, x, y, velocity);
        out[k] = allowed ? velocity[0] * 10 : 0; out[k + 1] = allowed ? velocity[1] * 10 : 0;
      });
    const renderer = shader ? 'webgl' : 'canvas2d';
    if (canvas.dataset.flowRenderer !== renderer) canvas.dataset.flowRenderer = renderer;
    if (shader) {
      g.drawImage(this.waterFlow.canvas, 0, 0, this.glint.width, this.glint.height);
    } else {
      g.setTransform(...camera.viewOn(this.glint));
      GLINT_LAYERS.forEach((layer, n) => {
        const k = layer.size / 256;
        const t = showProcesses ? time : 0;
        this.ripplePattern.setTransform(new DOMMatrix([k, 0, 0, k, layer.vx * t, layer.vy * t]));
        g.fillStyle = this.ripplePattern;
        g.globalCompositeOperation = n === 0 ? 'source-over' : 'lighter';
        g.fillRect(x0, y0, x1 - x0, y1 - y0);
      });
    }
    g.setTransform(...camera.viewOn(this.glint));
    g.globalCompositeOperation = 'destination-in';
    g.imageSmoothingEnabled = true;
    g.drawImage(waterMask, 0, 0, w.dish.width, w.dish.height);
    g.setTransform(1, 0, 0, 1, 0, 0);
    if (!shader) g.drawImage(spots, 0, 0);
    g.globalCompositeOperation = 'source-over';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = (shader ? 0.5 : GLINT_ALPHA) * Math.min(1, lit);
    ctx.drawImage(this.glint, 0, 0, canvas.width, canvas.height);
  }

  /**
   * Блёстки кристаллов залежей: точки на плотных неглубоких залежах коротко
   * вспыхивают каждая в своё время; видны только в пятнах света.
   */
  drawSparkles(frame: Frame, spots: HTMLCanvasElement): void {
    const pts = this.sparkles;
    if (pts.length === 0) return;
    const { ctx, canvas, camera, animTime: time, lit, detail } = frame;
    const g = this.gctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, this.glint.width, this.glint.height);
    g.setTransform(...camera.viewOn(this.glint));
    const [x0, y0, x1, y1] = camera.visible();
    const buckets = [new Path2D(), new Path2D(), new Path2D()];
    for (let n = 0; n < pts.length; n += 3) {
      const x = pts[n], y = pts[n + 1];
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      const tw = Math.sin(time * SPARKLE_SPEED + pts[n + 2]);
      if (tw < SPARKLE_THRESHOLD) continue;
      const b = (tw - SPARKLE_THRESHOLD) / (1 - SPARKLE_THRESHOLD);
      const r = camera.px(0.8 + 2.2 * b);
      const p = buckets[Math.min(2, Math.floor(b * 3))];
      // Четырёхлучевая звёздочка.
      p.moveTo(x - r, y);
      p.lineTo(x, y - r * 0.3);
      p.lineTo(x + r, y);
      p.lineTo(x, y + r * 0.3);
      p.closePath();
      p.moveTo(x, y - r);
      p.lineTo(x + r * 0.3, y);
      p.lineTo(x, y + r);
      p.lineTo(x - r * 0.3, y);
      p.closePath();
    }
    buckets.forEach((p, i) => {
      g.fillStyle = `rgba(245, 230, 255, ${(0.35 + 0.3 * i).toFixed(2)})`;
      g.fill(p);
    });
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(spots, 0, 0);
    g.globalCompositeOperation = 'source-over';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = Math.min(1, lit) * (0.15 + 0.85 * detail);
    ctx.drawImage(this.glint, 0, 0, canvas.width, canvas.height);
  }

  /**
   * Пена у берега: на мелководье у суши, где течение направлено в берег, —
   * гуще при сильном потоке. Маска строится по полю течений, фактура — бегущая рябь.
   */
  drawFoam(frame: Frame): void {
    const { ctx, canvas, camera, world, animTime: time } = frame;
    const now = performance.now();
    if (now - this.foamBuiltAt >= FOAM_REBUILD_MS || this.foamStep < 0) {
      this.foamBuiltAt = now;
      this.foamStep = world.step;
      this.buildFoam(world);
    }
    const g = this.gctx;
    const view = camera.viewOn(this.glint);
    const [x0, y0, x1, y1] = camera.visible();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, this.glint.width, this.glint.height);
    g.setTransform(...view);
    const k = FOAM_RIPPLE_SIZE / 256;
    this.ripplePattern.setTransform(new DOMMatrix([k, 0, 0, k, -time * 6, time * 3]));
    g.fillStyle = this.ripplePattern;
    g.fillRect(x0, y0, x1 - x0, y1 - y0);
    g.globalAlpha = FOAM_BASE;
    g.fillStyle = 'rgba(255, 255, 255, 1)';
    g.fillRect(x0, y0, x1 - x0, y1 - y0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'destination-in';
    g.imageSmoothingEnabled = true;
    g.drawImage(this.foamCanvas, 0, 0, world.dish.width, world.dish.height);
    g.globalCompositeOperation = 'source-over';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = FOAM_ALPHA;
    ctx.drawImage(this.glint, 0, 0, canvas.width, canvas.height);
  }

  private buildFoam(w: World): void {
    const m = w.mineral;
    const c = this.foamCanvas;
    if (c.width !== m.cols) { c.width = m.cols; c.height = m.rows; }
    const fctx = c.getContext('2d')!;
    const img = fctx.createImageData(m.cols, m.rows);
    const { a, b, u } = w.drift.nodes(w.step);
    const same = a.cols === m.cols && a.rows === m.rows;
    const level = w.terrain.applied;
    const sMax = Math.max(1e-9, DRIFT_REFERENCE * sunAt(w.light, w.step));
    for (let j = 1; j < m.rows - 1; j++) {
      for (let i = 1; i < m.cols - 1; i++) {
        const k = j * m.cols + i;
        if (!same || m.blocked[k]) continue;
        const L = level[k];
        const shore = smoothstep(0.7, 1.2, L) * (1 - smoothstep(1.45, 1.7, L));
        if (shore === 0) continue;
        const vx = a.vx[k] + (b.vx[k] - a.vx[k]) * u, vy = a.vy[k] + (b.vy[k] - a.vy[k]) * u;
        const sp = Math.sqrt(vx * vx + vy * vy);
        if (sp === 0) continue;
        // Вверх по склону — к суше.
        const gx = (level[k + 1] - level[k - 1]) / 2, gy = (level[k + m.cols] - level[k - m.cols]) / 2;
        const gl = Math.sqrt(gx * gx + gy * gy);
        if (gl === 0) continue;
        const toward = Math.max(0, (vx * gx + vy * gy) / (sp * gl));
        // Только заметный поток, бьющий почти прямо в берег.
        const f = smoothstep(0.25, 0.8, sp / sMax) * toward * toward * shore;
        img.data[k * 4] = img.data[k * 4 + 1] = img.data[k * 4 + 2] = 255;
        img.data[k * 4 + 3] = Math.min(255, f * 255 * 1.6);
      }
    }
    fctx.putImageData(img, 0, 0);
  }
}
