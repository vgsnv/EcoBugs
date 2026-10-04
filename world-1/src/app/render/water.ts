/**
 * Вода: рябь, переносимая течениями (на освещённой воде), пена у берега там,
 * где течение бьёт в сушу, и блёстки кристаллов залежей в пятнах света.
 * Здесь — данные для шейдера полей (течения в виде, маска пены) и блёстки.
 */
import { DRIFT_REFERENCE, flowAt, hash3, insideDish, isBlocked, periodicFbm, sunAt, type World } from '../../core/index.ts';
import type { GlowSink } from './field.ts';
import type { Frame } from './frame.ts';
import { smoothstep } from './palette.ts';

/** Блёстки кристаллов: с какой густоты залежей, скорость мерцания, порог вспышки (доля времени ярко — малая). */
const SPARKLE_DEPOSIT = 2;
const SPARKLE_SPEED = 1.3;
const SPARKLE_THRESHOLD = 0.965;
/**
 * Рябь сменяет узор по времени модели, но не быстрее RIPPLE_MAX_RATE ×
 * реального: иначе на ускорении узор мелькает (на ×100 — десятки раз в секунду).
 */
const RIPPLE_MAX_RATE = 3;
/** Пересчёт маски пены не чаще, мс (её вид — фактура 60 единиц, ровная часть 0,35, сила 0,4 — в шейдере полей). */
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
  /** Узор ряби — общий для течений, пены и равномерной ряби. */
  readonly ripple = ripple();
  /** Блёстки (x, y, фаза), маска пены и когда она построена. */
  private sparkles = new Float32Array(0);
  private readonly foamCanvas = document.createElement('canvas');
  private foamBuiltAt = 0;
  private foamStep = -1;
  private foamVersion = 0;
  /** Скорость течений в видимой части для ряби: выборка по сетке вида, закодированная в байты. */
  private flowKey = '';
  private flowStep = -1;
  private flowBuiltAt = -Infinity;
  private flowVersion = 0;
  private flowScale = 1;
  private flowBytes = new Uint8Array(0);
  private flowSamples = new Float32Array(0);
  private flowGrid: { cols: number; rows: number; bounds: number[] } = { cols: 0, rows: 0, bounds: [0, 0, 1, 1] };
  /** Часы ряби (секунды модели, с ограничением скорости) и по каким кадрам они шли. */
  private rippleClock = 0;
  private rippleFlowStep: number | null = null;
  private rippleAnimTime = 0;

  resetFlow(): void {
    this.flowKey = ''; this.flowStep = -1; this.flowBuiltAt = -Infinity;
    this.rippleFlowStep = null;
  }

  /** Часы ряби этого кадра: шаги течений → секунды модели, но не быстрее RIPPLE_MAX_RATE × реального времени. */
  rippleTime(frame: Frame): number {
    if (this.rippleFlowStep === null || frame.flowStep < this.rippleFlowStep) {
      this.rippleClock = frame.flowStep / 10;
    } else {
      const model = (frame.flowStep - this.rippleFlowStep) / 10;
      const real = Math.max(0, frame.animTime - this.rippleAnimTime);
      this.rippleClock += Math.min(model, real * RIPPLE_MAX_RATE);
    }
    this.rippleFlowStep = frame.flowStep;
    this.rippleAnimTime = frame.animTime;
    return this.rippleClock;
  }

  resetFoam(): void {
    this.foamStep = -1;
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

  /**
   * Течения для ряби в видимой части: сетка вида не крупнее 128 × 128, на
   * воде; пересобирается при смене вида или (не чаще раза в 100 мс) шага.
   * Скорость ×10 кодируется двумя байтами на ось относительно наибольшей.
   */
  flow(frame: Frame): { data: Uint8Array; cols: number; rows: number; bounds: readonly number[]; scale: number; version: number } {
    const { camera, world: w } = frame;
    const bounds = camera.visible();
    const cell = w.mineral.cell;
    const cols = Math.max(2, Math.min(128, Math.ceil((bounds[2] - bounds[0]) / cell)));
    const rows = Math.max(2, Math.min(128, Math.ceil((bounds[3] - bounds[1]) / cell)));
    const key = `${bounds.join(':')}:${cols}:${rows}`;
    const now = performance.now();
    if (key !== this.flowKey || (w.step !== this.flowStep && now - this.flowBuiltAt >= 100)) {
      this.flowKey = key; this.flowStep = w.step; this.flowBuiltAt = now;
      this.flowVersion++;
      this.flowGrid = { cols, rows, bounds };
      if (this.flowBytes.length !== cols * rows * 4) { this.flowBytes = new Uint8Array(cols * rows * 4); this.flowSamples = new Float32Array(cols * rows * 2); }
      const velocity: [number, number] = [0, 0];
      let max = 0.1;
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        const wx = bounds[0] + (bounds[2] - bounds[0]) * (x + .5) / cols;
        const wy = bounds[1] + (bounds[3] - bounds[1]) * (y + .5) / rows;
        const k = (y * cols + x) * 2;
        const allowed = insideDish(w.dish, wx, wy) && !isBlocked(w.partitions, wx, wy);
        flowAt(w, wx, wy, velocity);
        this.flowSamples[k] = allowed ? velocity[0] * 10 : 0; this.flowSamples[k + 1] = allowed ? velocity[1] * 10 : 0;
        max = Math.max(max, Math.abs(this.flowSamples[k]), Math.abs(this.flowSamples[k + 1]));
      }
      this.flowScale = max;
      for (let k = 0, q = 0; k < this.flowBytes.length; k += 4, q += 2) {
        const vx = Math.round(this.flowSamples[q] / max * 32767 + 32768);
        const vy = Math.round(this.flowSamples[q + 1] / max * 32767 + 32768);
        this.flowBytes[k] = vx >> 8; this.flowBytes[k + 1] = vx & 255;
        this.flowBytes[k + 2] = vy >> 8; this.flowBytes[k + 3] = vy & 255;
      }
    }
    return { data: this.flowBytes, ...this.flowGrid, scale: this.flowScale, version: this.flowVersion };
  }

  /**
   * Блёстки кристаллов залежей: точки на плотных неглубоких залежах коротко
   * вспыхивают каждая в своё время; видны только в пятнах света.
   */
  drawSparkles(frame: Frame, sink: GlowSink): void {
    const pts = this.sparkles;
    if (pts.length === 0) return;
    const { camera, animTime: time, lit, detail } = frame;
    const strength = Math.min(1, lit) * (0.15 + 0.85 * detail);
    const [x0, y0, x1, y1] = camera.visible();
    for (let n = 0; n < pts.length; n += 3) {
      const x = pts[n], y = pts[n + 1];
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      const tw = Math.sin(time * SPARKLE_SPEED + pts[n + 2]);
      if (tw < SPARKLE_THRESHOLD) continue;
      const b = (tw - SPARKLE_THRESHOLD) / (1 - SPARKLE_THRESHOLD);
      // Четырёхлучевая звёздочка; три ступени яркости.
      sink.star(x, y, camera.px(0.8 + 2.2 * b), (0.35 + 0.3 * Math.min(2, Math.floor(b * 3))) * strength);
    }
  }

  /**
   * Пена у берега: на мелководье у суши, где течение направлено в берег, —
   * гуще при сильном потоке. Маска строится по полю течений, фактура — бегущая рябь (в шейдере).
   */
  foam(world: World): { canvas: HTMLCanvasElement; version: number } {
    const now = performance.now();
    if (now - this.foamBuiltAt >= FOAM_REBUILD_MS || this.foamStep < 0) {
      this.foamBuiltAt = now;
      this.foamStep = world.step;
      this.foamVersion++;
      this.buildFoam(world);
    }
    return { canvas: this.foamCanvas, version: this.foamVersion };
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
