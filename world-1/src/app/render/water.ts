/**
 * Вода: рябь, переносимая течениями (на освещённой воде), пена у берега там,
 * где течение бьёт в сушу, и блёстки кристаллов залежей в пятнах света.
 * Здесь — данные для шейдера полей (течения в виде, маска пены) и блёстки.
 */
import { DRIFT_REFERENCE, MINERAL_LAYER, MINERAL_MOBILITY, MINERAL_PERIOD, hash3, multiplierForLevel, periodicFbm, sunAt, type World } from '../../core/index.ts';
import type { GlowSink } from './field.ts';
import type { Frame } from './frame.ts';
import { smoothstep } from './palette.ts';
import { AVERAGE_FROM, AVERAGE_FULL, AVERAGE_SECONDS, TRAILS_FROM, TRAILS_FULL } from './trails.ts';

/** Что показывает взвесь: течение воды или перенос минерала. */
export type StreamView = 'water' | 'mineral';

/** Поле течений для взвеси на сетке минерала: по 4 числа на клетку — скорость (x, y, единиц мира в секунду модели) и сила 0…1; номер версии. */
export interface StreamField {
  readonly data: Float32Array;
  readonly cols: number;
  readonly rows: number;
  readonly step: number;
  readonly version: number;
}

/** Блёстки кристаллов: с какой густоты залежей, скорость мерцания, порог вспышки (доля времени ярко — малая). */
const SPARKLE_DEPOSIT = 2;
const SPARKLE_SPEED = 1.3;
const SPARKLE_THRESHOLD = 0.965;
/**
 * Взвесь движется по времени модели, но не быстрее RIPPLE_MAX_RATE ×
 * реального: на ускорении за частицами тянутся следы.
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
  /** Часы ряби (секунды модели, с ограничением скорости) и по каким кадрам они шли. */
  private rippleClock = 0;
  private rippleFlowStep: number | null = null;
  private rippleAnimTime = 0;
  /** Скорость показа — секунд модели за секунду наблюдения, сглаженная (на паузе не меняется). */
  private pace = 1;
  /**
   * Течение и перенос минерала по клеткам: мгновенные и скользящее среднее
   * за AVERAGE_SECONDS реального времени (по 4 числа: x, y воды, сила воды,
   * сила переноса минерала); поле для взвеси и когда оно обновлено.
   */
  private now = new Float32Array(0);
  private mean = new Float32Array(0);
  private stream = new Float32Array(0);
  private streamVersion = 0;
  private streamTime: number | null = null;
  /** Мерило переноса минерала: сильный перенос в этой чашке (95-й процентиль), сглаженный. */
  private mineralRef = 0;

  resetFlow(): void {
    this.rippleFlowStep = null;
  }

  /**
   * Часы показа течений этого кадра (взвесь): шаги течений → секунды модели,
   * но не быстрее RIPPLE_MAX_RATE × реального времени. Заодно оценивает
   * скорость показа (для смены вида). Возвращает, сколько секунд модели
   * прошло с прошлого кадра по этим часам. Вызывать раз в кадр.
   */
  clock(frame: Frame): number {
    const before = this.rippleClock;
    if (this.rippleFlowStep === null || frame.flowStep < this.rippleFlowStep) {
      this.rippleClock = frame.flowStep / 10;
      this.rippleFlowStep = frame.flowStep;
      this.rippleAnimTime = frame.animTime;
      return 0;
    } else {
      const model = (frame.flowStep - this.rippleFlowStep) / 10;
      const real = Math.max(0, frame.animTime - this.rippleAnimTime);
      this.rippleClock += Math.min(model, real * RIPPLE_MAX_RATE);
      // Сглаживание за ~0,5 с: смена вида течений при смене скорости — плавная.
      if (real > 0) this.pace += (model / real - this.pace) * Math.min(1, real * 2);
    }
    this.rippleFlowStep = frame.flowStep;
    this.rippleAnimTime = frame.animTime;
    return this.rippleClock - before;
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


  /** Доля усреднённого течения для взвеси: 0 до ×AVERAGE_FROM, 1 от ×AVERAGE_FULL. */
  averageMix(): number {
    const x = Math.log(Math.max(1e-6, this.pace) / AVERAGE_FROM) / Math.log(AVERAGE_FULL / AVERAGE_FROM);
    return smoothstep(0, 1, x);
  }

  /**
   * Поле течений для взвеси на сетке минерала. Вода — скорость течения (свет +
   * вулканы и воронки); минерал — его поток: плотность × скорость × доля,
   * которую течение уносит (тоньше слой в вязком, как у зёрен). Сила — по
   * логарифму от мерила `ref`. С ростом скорости показа мгновенное поле
   * сменяется скользящим средним (`averageMix`): направление устойчивое.
   */
  streamField(frame: Frame, view: StreamView, ref: number): StreamField {
    const w = frame.world;
    const m = w.mineral;
    const n = m.cols * m.rows;
    if (this.now.length !== n * 4) {
      this.now = new Float32Array(n * 4); this.mean = new Float32Array(n * 4); this.stream = new Float32Array(n * 4);
      this.streamTime = null;
    }
    const { a, b, u } = w.drift.nodes(w.step);
    const same = a.cols === m.cols && a.rows === m.rows;
    const push = m.flow;
    const perMean = m.cell * m.cell * w.params.mineralStock;
    const layer = MINERAL_LAYER * MINERAL_MOBILITY * MINERAL_PERIOD * m.cell * m.cell;
    const level = w.terrain.applied;
    const strength = (x: number) => Math.min(1, Math.log(1 + 4 * x / ref) / Math.log(9));
    const now = this.now;
    for (let k = 0; k < n; k++) {
      const o = k * 4;
      if (!same || m.blocked[k]) { now[o] = now[o + 1] = now[o + 2] = now[o + 3] = 0; continue; }
      // Снос за шаг → единиц мира в секунду модели.
      const vx = a.vx[k] + (b.vx[k] - a.vx[k]) * u + (push ? push.vx[k] : 0);
      const vy = a.vy[k] + (b.vy[k] - a.vy[k]) * u + (push ? push.vy[k] : 0);
      const step = Math.sqrt(vx * vx + vy * vy);
      const amount = m.field[k];
      const mob = multiplierForLevel(level[k]);
      const share = amount > 0 ? Math.min(1, (layer * step) / (mob * mob) / amount) : 0;
      now[o] = vx * 10; now[o + 1] = vy * 10;
      now[o + 2] = step * 10;
      now[o + 3] = (amount / perMean) * share * step * 10;
    }
    // Скользящее среднее по реальному времени (на паузе стоит); первый раз — сразу текущее.
    const dt = this.streamTime === null ? Infinity : Math.max(0, frame.animTime - this.streamTime);
    this.streamTime = frame.animTime;
    const k = 1 - Math.exp(-dt / AVERAGE_SECONDS);
    const mean = this.mean;
    for (let i = 0; i < mean.length; i++) mean[i] += (now[i] - mean[i]) * k;
    // Перенос минерала мерится своим мерилом: минерала в среде бывает мало, и мерило
    // течения воды сделало бы его почти невидимым. Берётся сильный перенос в этой чашке.
    if (view === 'mineral') {
      const sample: number[] = [];
      for (let c = 0; c < n; c += 7) if (mean[c * 4 + 3] > 0) sample.push(mean[c * 4 + 3]);
      sample.sort((x, y) => x - y);
      const high = sample.length ? sample[Math.floor(sample.length * 0.95)] : 0;
      this.mineralRef = this.mineralRef > 0 ? this.mineralRef + (high - this.mineralRef) * k : high;
    }
    const mineralRef = Math.max(this.mineralRef, ref * 1e-4);
    const strengthMineral = (x: number) => Math.min(1, Math.log(1 + 4 * x / mineralRef) / Math.log(9));
    // Поле для взвеси: мгновенное или среднее; у минерала направление — по его потоку.
    const avg = this.averageMix();
    const out = this.stream;
    for (let c = 0; c < n; c++) {
      const o = c * 4;
      const nx = now[o], ny = now[o + 1], mx = mean[o], my = mean[o + 1];
      out[o] = nx + (mx - nx) * avg;
      out[o + 1] = ny + (my - ny) * avg;
      const sn = view === 'water' ? now[o + 2] : now[o + 3];
      const sm = view === 'water' ? mean[o + 2] : mean[o + 3];
      out[o + 2] = (view === 'water' ? strength : strengthMineral)(sn + (sm - sn) * avg);
      out[o + 3] = 0;
    }
    this.streamVersion++;
    return { data: out, cols: m.cols, rows: m.rows, step: m.cell, version: this.streamVersion };
  }

  /** Длина следов взвеси: 0 до ×TRAILS_FROM, 1 от ×TRAILS_FULL, между — по логарифму скорости показа. */
  trailMix(): number {
    const x = Math.log(Math.max(1e-6, this.pace) / TRAILS_FROM) / Math.log(TRAILS_FULL / TRAILS_FROM);
    return smoothstep(0, 1, x);
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
