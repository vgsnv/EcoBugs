/**
 * Отрисовка мира на векторном холсте в разрешении экрана — как освещённая
 * местность. Вязкость — сама местность: вода синяя, суша тёмный камень,
 * отмель — камень под тонким слоем воды, переходы плавные (строится один раз
 * на мир и размер). Свет освещает её пятнами: вне пятен тень, нагрев теплит
 * освещённые места. Вокруг — стеклянная стена чашки, перегородки тем же стеклом.
 */
import { hash3, periodicFbm, smoothLevelAt, spotOutlines, SPOT_EDGE, type World } from '../core/index.ts';

/** Стекло стен и перегородок: полупрозрачная заливка, светлая кромка, лёгкая тень. */
const GLASS_FILL = 'rgba(205, 230, 255, 0.5)';
const GLASS_GLOSS_FROM = 'rgba(205, 228, 245, 0.85)';
const GLASS_GLOSS_TO = 'rgba(150, 190, 222, 0.45)';
const GLASS_EDGE = 'rgba(255, 255, 255, 0.9)';
const GLASS_SHADOW = 'rgba(30, 55, 80, 0.65)';

export type Rgb = readonly [number, number, number];

/** Вода: глубокая и над отмелью. */
export const DEEP_WATER: Rgb = [34, 96, 178];
export const SHALLOW_WATER: Rgb = [84, 144, 210];
/** Камень суши: средняя яркость, разброс пятнами и зерном, трещины. */
const STONE_BASE = 40;
const STONE_MOTTLE = 18;
const STONE_GRAIN = 8;
const STONE_CRACK = 16;
/** Размер плит камня между трещинами, единиц мира. */
const STONE_SLAB = 14;
/** Камень под водой светлее: вода его подсвечивает. */
const STONE_UNDERWATER_LIFT = 45;
/** Насколько вода над отмелью прозрачна (0 — не видно камня, 1 — только камень). */
const SHALLOWS_CLARITY = 0.6;
/** Образцы для легенды. */
export const STONE_SAMPLE: Rgb = [STONE_BASE, STONE_BASE, STONE_BASE + 4];
export const SHALLOWS_SAMPLE: Rgb = mix(lift(STONE_SAMPLE, STONE_UNDERWATER_LIFT), SHALLOW_WATER, 1 - SHALLOWS_CLARITY);

/** Тень умножается на местность: темнее и холоднее. */
export const SHADE_COLOR: Rgb = [140, 150, 185];
/** Солнечный оттенок освещённых мест. */
export const SUN_COLOR: Rgb = [255, 232, 185];
/** Сила солнечного оттенка при солнце 1 и добавка от нагрева (при нагреве 2). */
const SUN_WARMTH = 0.2;
const HEAT_WARMTH = 0.35;
/** Лёгкое высветление освещённых мест, чтобы свет читался и на тёмном камне. */
const SUN_GLOW = 0.07;
/** Высветление освещённых мест при солнце ярче 1. */
const GLARE_STRENGTH = 0.55;

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
function lift(c: Rgb, d: number): Rgb {
  return [c[0] + d, c[1] + d, c[2] + d];
}
/**
 * Трещины между плитами камня: расстояние до ближайшей границы ячеек Вороного
 * (F2 − F1). Точки ячеек считаются один раз; координаты — в размерах плиты.
 */
function cellEdges(seed: number, cols: number, rows: number): (x: number, y: number) => number {
  const pts = new Float32Array((cols + 2) * (rows + 2) * 2);
  for (let j = -1; j <= rows; j++) {
    for (let i = -1; i <= cols; i++) {
      const h = hash3(seed, i, j);
      const k = ((j + 1) * (cols + 2) + i + 1) * 2;
      pts[k] = i + (h & 0xffff) / 65536;
      pts[k + 1] = j + (h >>> 16) / 65536;
    }
  }
  return (x, y) => {
    const cx = Math.floor(x), cy = Math.floor(y);
    let f1 = Infinity, f2 = Infinity;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const k = ((cy + dy + 1) * (cols + 2) + cx + dx + 1) * 2;
        const ex = pts[k] - x, ey = pts[k + 1] - y;
        const d = ex * ex + ey * ey;
        if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
      }
    }
    return Math.sqrt(f2) - Math.sqrt(f1);
  };
}

/** Поле, посчитанное на сетке с шагом `step` и читаемое билинейно — дёшево для попиксельного прохода. */
function gridField(width: number, height: number, step: number, f: (x: number, y: number) => number): (x: number, y: number) => number {
  const cols = Math.ceil(width / step) + 2;
  const rows = Math.ceil(height / step) + 2;
  const v = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) v[j * cols + i] = f(i * step, j * step);
  return (x, y) => {
    const fx = x / step, fy = y / step;
    const i = Math.min(cols - 2, Math.floor(fx)), j = Math.min(rows - 2, Math.floor(fy));
    const u = fx - i, t = fy - j, k = j * cols + i;
    const a = v[k] + (v[k + 1] - v[k]) * u;
    const b = v[k + cols] + (v[k + cols + 1] - v[k + cols]) * u;
    return a + (b - a) * t;
  };
}

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
/** Плавная ступенька от a до b. */
const smoothstep = (a: number, b: number, t: number) => { const u = clamp01((t - a) / (b - a)); return u * u * (3 - 2 * u); };

/** Свет → 0…1: экспоненциальное насыщение, одинаковое для всех миров. */
export function lightTone(light: number): number {
  return 1 - Math.exp(-1.1 * light);
}

const rgb = (c: Rgb, alpha = 1) => `rgba(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}, ${alpha})`;

export class WorldRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  /** Подложка вязкости в пикселях экрана. */
  private readonly terrain = document.createElement('canvas');
  /** Маска пятен света одним цветом. */
  private readonly spots = document.createElement('canvas');
  private readonly sctx: CanvasRenderingContext2D;
  /** Слой тени с «дырами» пятен — накладывается умножением. */
  private readonly shade = document.createElement('canvas');
  private readonly hctx: CanvasRenderingContext2D;
  private world!: World;
  /** Толщина стены вокруг чашки, единиц мира — как у перегородок. */
  private wall = 0;
  /** Пикселей холста на единицу мира. */
  private scale = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.sctx = this.spots.getContext('2d')!;
    this.hctx = this.shade.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement ?? canvas);
  }

  setWorld(world: World): void {
    this.world = world;
    this.wall = world.partitions.thickness;
    this.resize(true);
  }

  /** Подогнать разрешение холста под его размер на экране и плотность пикселей. */
  private resize(force = false): void {
    if (!this.world) return;
    const { width, height } = this.world.params;
    const totalW = width + 2 * this.wall;
    const totalH = height + 2 * this.wall;
    // Вписать чашку в свободное место по ширине и по высоте.
    const box = this.canvas.parentElement ?? this.canvas;
    const fit = Math.min((box.clientWidth || totalW) / totalW, (box.clientHeight || totalH) / totalH);
    const scale = fit * (window.devicePixelRatio || 1);
    this.canvas.style.width = `${Math.floor(totalW * fit)}px`;
    this.canvas.style.height = `${Math.floor(totalH * fit)}px`;
    if (!force && Math.abs(scale - this.scale) < 1e-3) return;
    this.scale = scale;
    this.canvas.width = Math.round(totalW * scale);
    this.canvas.height = Math.round(totalH * scale);
    this.spots.width = Math.round(width * scale);
    this.spots.height = Math.round(height * scale);
    this.shade.width = this.spots.width;
    this.shade.height = this.spots.height;
    this.buildTerrain();
  }

  private buildTerrain(): void {
    const { width, height, seed } = this.world.params;
    const tw = Math.round(width * this.scale);
    const th = Math.round(height * this.scale);
    this.terrain.width = tw;
    this.terrain.height = th;
    const tctx = this.terrain.getContext('2d')!;
    const img = tctx.createImageData(tw, th);
    // Фактура камня в единицах мира — узор только для глаза, на модель не влияет.
    const fbm = periodicFbm(seed ^ 0x51a7e, Math.ceil(width / 40), Math.ceil(height / 40), 4);
    const mottle = gridField(width, height, 2, (x, y) => fbm(x / 40, y / 40));
    const grain = gridField(width, height, 1.25, (x, y) => hash3(seed ^ 0x6a41, Math.round(x * 0.8), Math.round(y * 0.8)) / 2147483648 - 1);
    const edge = cellEdges(seed ^ 0xc4ac, Math.ceil(width / STONE_SLAB), Math.ceil(height / STONE_SLAB));
    for (let j = 0; j < th; j++) {
      const y = (j + 0.5) / this.scale;
      for (let i = 0; i < tw; i++) {
        const x = (i + 0.5) / this.scale;
        const L = smoothLevelAt(this.world.viscosity, x, y);
        const crack = 1 - smoothstep(0.02, 0.07, edge(x / STONE_SLAB, y / STONE_SLAB));
        const v = STONE_BASE + STONE_MOTTLE * mottle(x, y) + STONE_GRAIN * grain(x, y) - STONE_CRACK * crack;
        // Вода мелеет к отмели и сходит на нет к суше; камень под ней светлее.
        const shallow = smoothstep(0.2, 1.3, L);
        const dry = smoothstep(1.35, 1.75, L);
        const under = v + STONE_UNDERWATER_LIFT * (1 - dry);
        const water = mix(DEEP_WATER, SHALLOW_WATER, shallow);
        const cover = (1 - SHALLOWS_CLARITY * shallow) * (1 - dry);
        const k = (j * tw + i) * 4;
        img.data[k] = under + (water[0] - under) * cover;
        img.data[k + 1] = under + (water[1] - under) * cover;
        img.data[k + 2] = under + 4 + (water[2] - under - 4) * cover;
        img.data[k + 3] = 255;
      }
    }
    tctx.putImageData(img, 0, 0);
  }

  /** Экранные пиксели → единицы мира (для толщины линий). */
  private px(n: number): number {
    return (n * (window.devicePixelRatio || 1)) / this.scale;
  }

  draw(): void {
    const w = this.world;
    const p = w.params;
    const ctx = this.ctx;
    const s = this.scale;
    const offset = this.wall * s;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.terrain, offset, offset);

    // Маска пятен: контуры одним цветом во вспомогательный холст (перекрытия
    // не складываются).
    const sctx = this.sctx;
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, this.spots.width, this.spots.height);
    sctx.setTransform(s, 0, 0, s, 0, 0);
    sctx.beginPath();
    for (const poly of spotOutlines(w.light, w.step, p.width, p.height)) {
      sctx.moveTo(poly[0], poly[1]);
      for (let i = 2; i < poly.length; i += 2) sctx.lineTo(poly[i], poly[i + 1]);
      sctx.closePath();
    }
    sctx.fillStyle = rgb(SUN_COLOR);
    sctx.fill('nonzero');

    // Сила света пятен в абсолютной шкале: 1 при солнце 1.
    const lit = lightTone(p.sun) / lightTone(1);
    const dpr = window.devicePixelRatio || 1;
    const penumbra = Math.min(3 * dpr, Math.max(0.5, (p.spotSize * SPOT_EDGE * s) / 6));

    // Тень: сплошной слой с «дырами» там, где светят пятна (при тусклом солнце
    // дыры неполные), накладывается на местность умножением.
    const hctx = this.hctx;
    hctx.globalCompositeOperation = 'source-over';
    hctx.filter = 'none';
    hctx.globalAlpha = 1;
    hctx.fillStyle = rgb(SHADE_COLOR);
    hctx.fillRect(0, 0, this.shade.width, this.shade.height);
    hctx.globalCompositeOperation = 'destination-out';
    hctx.filter = `blur(${penumbra.toFixed(1)}px)`;
    hctx.globalAlpha = Math.min(1, lit);
    hctx.drawImage(this.spots, 0, 0);
    hctx.globalCompositeOperation = 'source-over';
    hctx.filter = 'none';
    hctx.globalAlpha = 1;

    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(this.shade, offset, offset);
    // Свет — солнечный тёплый оттенок освещённых мест; нагрев его усиливает.
    const warmth = Math.min(0.95, SUN_WARMTH * Math.min(1, lit) + HEAT_WARMTH * Math.min(1, p.spotHeat / 2));
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = warmth;
    ctx.filter = `blur(${penumbra.toFixed(1)}px)`;
    ctx.drawImage(this.spots, offset, offset);
    // И чуть высветляет их, чтобы свет читался и на тёмной суше.
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = SUN_GLOW * Math.min(1, lit);
    ctx.drawImage(this.spots, offset, offset);
    // Яркое солнце высветляет освещённые места.
    if (lit > 1) {
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = Math.min(1, (lit - 1) * GLARE_STRENGTH);
      ctx.filter = `blur(${penumbra.toFixed(1)}px) grayscale(1) brightness(2)`;
      ctx.drawImage(this.spots, offset, offset);
    }
    ctx.restore();

    ctx.setTransform(s, 0, 0, s, 0, 0);
    this.drawWalls();
  }

  /** Стена вокруг чашки и перегородки: одна заливка, одна обводка (в единицах мира). */
  private drawWalls(): void {
    const ctx = this.ctx;
    const W = this.wall;
    const { width, height } = this.world.params;
    ctx.clearRect(0, 0, width + 2 * W, W);
    ctx.clearRect(0, height + W, width + 2 * W, W);
    ctx.clearRect(0, 0, W, height + 2 * W);
    ctx.clearRect(width + W, 0, W, height + 2 * W);
    const solid = new Path2D();
    // Обод чашки: внешний прямоугольник минус внутренний (правило even-odd),
    // стекло с бликом — светлее к углам.
    solid.rect(0, 0, width + 2 * W, height + 2 * W);
    solid.rect(W, W, width, height);
    const gloss = ctx.createLinearGradient(0, 0, width + 2 * W, height + 2 * W);
    gloss.addColorStop(0, GLASS_GLOSS_FROM);
    gloss.addColorStop(0.5, GLASS_GLOSS_TO);
    gloss.addColorStop(1, GLASS_GLOSS_FROM);
    ctx.fillStyle = gloss;
    ctx.fill(solid, 'evenodd');
    // Перегородка — прямоугольники-отрезки толщиной W с квадратными концами.
    const parts = new Path2D();
    for (const part of this.world.partitions.partitions) {
      for (let k = 1; k < part.points.length; k++) {
        const [ax, ay] = part.points[k - 1];
        const [bx, by] = part.points[k];
        parts.rect(W + Math.min(ax, bx) - W / 2, W + Math.min(ay, by) - W / 2, Math.abs(bx - ax) + W, Math.abs(by - ay) + W);
      }
    }
    ctx.fillStyle = GLASS_FILL;
    ctx.fill(parts);
    this.outline();
  }

  /**
   * Кромка стекла: внешний край обода и граница между свободными ячейками
   * чашки и занятыми (стена или перегородка). Стыки перегородок со стеной и
   * между собой поэтому не обводятся.
   */
  private outline(): void {
    const ctx = this.ctx;
    const W = this.wall;
    const { width, height } = this.world.params;
    const lay = this.world.partitions;
    const c = lay.cell;
    const solid = (i: number, j: number) =>
      i < 0 || j < 0 || i >= lay.cols || j >= lay.rows || lay.blocked[j * lay.cols + i] === 1;
    const half = this.px(0.5);
    ctx.lineWidth = this.px(1);
    ctx.strokeStyle = GLASS_EDGE;
    ctx.strokeRect(half, half, width + 2 * W - 2 * half, height + 2 * W - 2 * half);
    ctx.beginPath();
    for (let j = 0; j < lay.rows; j++) {
      for (let i = 0; i < lay.cols; i++) {
        if (solid(i, j)) continue;
        const x = W + Math.min(i * c, width);
        const y = W + Math.min(j * c, height);
        const x1 = W + Math.min((i + 1) * c, width);
        const y1 = W + Math.min((j + 1) * c, height);
        if (solid(i - 1, j)) { ctx.moveTo(x, y); ctx.lineTo(x, y1); }
        if (solid(i + 1, j)) { ctx.moveTo(x1, y); ctx.lineTo(x1, y1); }
        if (solid(i, j - 1)) { ctx.moveTo(x, y); ctx.lineTo(x1, y); }
        if (solid(i, j + 1)) { ctx.moveTo(x, y1); ctx.lineTo(x1, y1); }
      }
    }
    // Как у стекла: тёмный контур по краю (виден на светлом) и светлый блик
    // поверх него (виден на тёмном).
    ctx.strokeStyle = GLASS_SHADOW;
    ctx.lineWidth = this.px(2);
    ctx.stroke();
    ctx.strokeStyle = GLASS_EDGE;
    ctx.lineWidth = this.px(0.75);
    ctx.stroke();
  }

  /** Координаты мира по точке экрана; вне чашки — null. */
  toWorld(clientX: number, clientY: number): [number, number] | null {
    const rect = this.canvas.getBoundingClientRect();
    const { width, height } = this.world.params;
    const units = (width + 2 * this.wall) / rect.width;
    const x = (clientX - rect.left) * units - this.wall;
    const y = (clientY - rect.top) * units - this.wall;
    return x >= 0 && y >= 0 && x < width && y < height ? [x, y] : null;
  }
}
