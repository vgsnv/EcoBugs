/**
 * Отрисовка мира на холсте в разрешении экрана — как освещённая местность,
 * с камерой: масштаб и перемещение. Вязкость — сама местность: вода синяя,
 * суша тёмный камень, отмель — камень под тонким слоем воды, переходы плавные.
 * Местность рисуется плитками под текущий масштаб и кешируется. Свет освещает
 * её пятнами: вне пятен тень, нагрев теплит освещённые места. Вокруг —
 * стеклянная стена чашки, перегородки тем же стеклом.
 */
import { DISH_HEIGHT, DISH_WIDTH, hash3, periodicFbm, smoothLevelAt, spotOutlines, SPOT_EDGE, type World } from '../core/index.ts';

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

/** Сторона плитки местности, пикселей. */
const TILE = 256;
/** Масштабы плиток — пикселей устройства на единицу мира, степени двойки. */
const TILE_SCALE_MIN = 0.5;
const TILE_SCALE_MAX = 32;
/** Сколько плиток держать в памяти (≈256 КБ каждая). */
const TILE_CACHE = 240;
/** Сколько миллисекунд кадра можно тратить на новые плитки. */
const TILE_BUDGET_MS = 8;
/** Наибольшее приближение — пикселей экрана (CSS) на единицу мира. */
const MAX_ZOOM_CSS = 24;

/** Цвет местности в точке мира: вязкость и фактура камня, посчитанные один раз на мир. */
function terrainSampler(world: World): (x: number, y: number, out: Uint8ClampedArray, k: number) => void {
  const seed = world.params.seed;
  // Фактура камня в единицах мира — узор только для глаза, на модель не влияет.
  const fbm = periodicFbm(seed ^ 0x51a7e, Math.ceil(DISH_WIDTH / 40), Math.ceil(DISH_HEIGHT / 40), 4);
  const mottle = gridField(DISH_WIDTH, DISH_HEIGHT, 4, (x, y) => fbm(x / 40, y / 40));
  const grain = gridField(DISH_WIDTH, DISH_HEIGHT, 1.25, (x, y) => hash3(seed ^ 0x6a41, Math.round(x * 0.8), Math.round(y * 0.8)) / 2147483648 - 1);
  const edge = cellEdges(seed ^ 0xc4ac, Math.ceil(DISH_WIDTH / STONE_SLAB), Math.ceil(DISH_HEIGHT / STONE_SLAB));
  return (x, y, out, k) => {
    const L = smoothLevelAt(world.viscosity, x, y);
    const crack = 1 - smoothstep(0.02, 0.07, edge(x / STONE_SLAB, y / STONE_SLAB));
    const v = STONE_BASE + STONE_MOTTLE * mottle(x, y) + STONE_GRAIN * grain(x, y) - STONE_CRACK * crack;
    // Вода мелеет к отмели и сходит на нет к суше; камень под ней светлее.
    const shallow = smoothstep(0.2, 1.3, L);
    const dry = smoothstep(1.35, 1.75, L);
    const under = v + STONE_UNDERWATER_LIFT * (1 - dry);
    const water = mix(DEEP_WATER, SHALLOW_WATER, shallow);
    const cover = (1 - SHALLOWS_CLARITY * shallow) * (1 - dry);
    out[k] = under + (water[0] - under) * cover;
    out[k + 1] = under + (water[1] - under) * cover;
    out[k + 2] = under + 4 + (water[2] - under - 4) * cover;
    out[k + 3] = 255;
  };
}

/** Кусок местности [x0, x0 + w) × [y0, y0 + h) единиц мира в масштабе `scale`; вне чашки — прозрачно. */
function renderTerrain(sample: ReturnType<typeof terrainSampler>, x0: number, y0: number, pw: number, ph: number, scale: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = pw;
  c.height = ph;
  const tctx = c.getContext('2d')!;
  const img = tctx.createImageData(pw, ph);
  for (let j = 0; j < ph; j++) {
    const y = y0 + (j + 0.5) / scale;
    if (y < 0 || y >= DISH_HEIGHT) continue;
    for (let i = 0; i < pw; i++) {
      const x = x0 + (i + 0.5) / scale;
      if (x < 0 || x >= DISH_WIDTH) continue;
      sample(x, y, img.data, (j * pw + i) * 4);
    }
  }
  tctx.putImageData(img, 0, 0);
  return c;
}

export class WorldRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  /** Маска пятен света одним цветом, в пикселях экрана. */
  private readonly spots = document.createElement('canvas');
  private readonly sctx: CanvasRenderingContext2D;
  /** Слой тени с «дырами» пятен — накладывается умножением. */
  private readonly shade = document.createElement('canvas');
  private readonly hctx: CanvasRenderingContext2D;
  private world!: World;
  /** Толщина стены вокруг чашки, единиц мира — как у перегородок. */
  private wall = 0;
  /** Местность целиком в самом мелком масштабе — подложка, пока нет плиток. */
  private base!: HTMLCanvasElement;
  private sample!: ReturnType<typeof terrainSampler>;
  /** Плитки местности: ключ «масштаб:i:j», порядок — давность использования. */
  private readonly tiles = new Map<string, HTMLCanvasElement>();
  /** Кромка стекла (в единицах мира) — строится один раз на мир. */
  private edges = new Path2D();
  /** Камера: центр вида в единицах мира и пикселей устройства на единицу мира. */
  private cx = DISH_WIDTH / 2;
  private cy = DISH_HEIGHT / 2;
  private zoom = 1;
  /** Вид «вся чашка»: при изменении размера окна остаётся вписанным. */
  private fitted = true;
  /** Вызывается при смене масштаба (для подписи в панели). */
  onZoomChange: (relative: number) => void = () => {};

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.sctx = this.spots.getContext('2d')!;
    this.hctx = this.shade.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  setWorld(world: World): void {
    this.world = world;
    this.wall = world.partitions.thickness;
    this.sample = terrainSampler(world);
    this.base = renderTerrain(this.sample, 0, 0, DISH_WIDTH * TILE_SCALE_MIN, DISH_HEIGHT * TILE_SCALE_MIN, TILE_SCALE_MIN);
    this.tiles.clear();
    this.edges = this.buildEdges();
    this.resize();
    this.fit();
  }

  private get dpr(): number {
    return window.devicePixelRatio || 1;
  }

  /** Подогнать разрешение холстов под размер на экране и плотность пикселей. */
  private resize(): void {
    const w = Math.max(1, Math.round(this.canvas.clientWidth * this.dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * this.dpr));
    if (w !== this.canvas.width || h !== this.canvas.height) {
      for (const c of [this.canvas, this.spots, this.shade]) {
        c.width = w;
        c.height = h;
      }
    }
    if (!this.world) return;
    if (this.fitted) this.fit();
    else this.setView(this.zoom, this.cx, this.cy);
  }

  // ── Камера ────────────────────────────────────────────────────────────

  /** Масштаб, при котором чашка со стенкой целиком вписана в холст. */
  private fitZoom(): number {
    return Math.min(this.canvas.width / (DISH_WIDTH + 2 * this.wall), this.canvas.height / (DISH_HEIGHT + 2 * this.wall));
  }

  /** Установить вид: масштаб в допустимых пределах, чашка не уезжает из кадра. */
  private setView(zoom: number, cx: number, cy: number): void {
    const min = this.fitZoom();
    const max = Math.max(min, MAX_ZOOM_CSS * this.dpr);
    this.zoom = Math.min(max, Math.max(min, zoom));
    this.fitted = this.zoom <= min * 1.0001;
    const clampAxis = (c: number, size: number, view: number) => {
      const half = view / this.zoom / 2;
      const lo = -this.wall + half, hi = size + this.wall - half;
      return lo > hi ? size / 2 : Math.min(hi, Math.max(lo, c));
    };
    this.cx = clampAxis(cx, DISH_WIDTH, this.canvas.width);
    this.cy = clampAxis(cy, DISH_HEIGHT, this.canvas.height);
    this.onZoomChange(this.zoom / min);
  }

  /** Показать чашку целиком. */
  fit(): void {
    this.setView(0, DISH_WIDTH / 2, DISH_HEIGHT / 2);
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

  private screenToWorld(sx: number, sy: number): [number, number] {
    return [this.cx + (sx - this.canvas.width / 2) / this.zoom, this.cy + (sy - this.canvas.height / 2) / this.zoom];
  }

  /** Координаты мира по точке экрана; вне чашки — null. */
  toWorld(clientX: number, clientY: number): [number, number] | null {
    const rect = this.canvas.getBoundingClientRect();
    const [x, y] = this.screenToWorld((clientX - rect.left) * this.dpr, (clientY - rect.top) * this.dpr);
    return x >= 0 && y >= 0 && x < DISH_WIDTH && y < DISH_HEIGHT ? [x, y] : null;
  }

  /** Перенос мира на экран: ctx.setTransform с этими числами. */
  private view(): [number, number, number, number, number, number] {
    const z = this.zoom;
    return [z, 0, 0, z, this.canvas.width / 2 - this.cx * z, this.canvas.height / 2 - this.cy * z];
  }

  /** Экранные пиксели (CSS) → единицы мира (для толщины линий). */
  private px(n: number): number {
    return (n * this.dpr) / this.zoom;
  }

  // ── Местность плитками ────────────────────────────────────────────────

  /** Нарисовать местность в видимой части: готовые плитки, остальное — из подложки; недостающие достроить. */
  private drawTerrain(): void {
    const ctx = this.ctx;
    ctx.setTransform(...this.view());
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.base, 0, 0, DISH_WIDTH, DISH_HEIGHT);
    const scale = Math.min(TILE_SCALE_MAX, Math.max(TILE_SCALE_MIN, 2 ** Math.ceil(Math.log2(this.zoom))));
    if (scale <= TILE_SCALE_MIN) return;
    const span = TILE / scale;
    const [x0, y0] = this.screenToWorld(0, 0);
    const [x1, y1] = this.screenToWorld(this.canvas.width, this.canvas.height);
    const i0 = Math.max(0, Math.floor(x0 / span)), i1 = Math.min(Math.ceil(DISH_WIDTH / span) - 1, Math.floor(x1 / span));
    const j0 = Math.max(0, Math.floor(y0 / span)), j1 = Math.min(Math.ceil(DISH_HEIGHT / span) - 1, Math.floor(y1 / span));
    const missing: [number, number][] = [];
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const key = `${scale}:${i}:${j}`;
        const tile = this.tiles.get(key);
        if (tile) {
          this.tiles.delete(key);
          this.tiles.set(key, tile);
          ctx.drawImage(tile, i * span, j * span, span, span);
        } else {
          // Пока плитки нет — ближайшая готовая крупнее (мельче масштабом), иначе подложка.
          this.drawCoarser(scale, i, j, span);
          missing.push([i, j]);
        }
      }
    }
    // Сначала ближние к центру вида.
    const ci = (x0 + x1) / 2 / span, cj = (y0 + y1) / 2 / span;
    missing.sort((a, b) => Math.hypot(a[0] - ci, a[1] - cj) - Math.hypot(b[0] - ci, b[1] - cj));
    const start = performance.now();
    for (const [i, j] of missing) {
      if (performance.now() - start > TILE_BUDGET_MS) break;
      const tile = renderTerrain(this.sample, i * span, j * span, TILE, TILE, scale);
      this.tiles.set(`${scale}:${i}:${j}`, tile);
      ctx.drawImage(tile, i * span, j * span, span, span);
    }
    while (this.tiles.size > TILE_CACHE) this.tiles.delete(this.tiles.keys().next().value!);
  }

  private drawCoarser(scale: number, i: number, j: number, span: number): void {
    for (let s = scale / 2, k = 2; s > TILE_SCALE_MIN; s /= 2, k *= 2) {
      const tile = this.tiles.get(`${s}:${Math.floor(i / k)}:${Math.floor(j / k)}`);
      if (!tile) continue;
      const part = TILE / k;
      this.ctx.drawImage(tile, (i % k) * part, (j % k) * part, part, part, i * span, j * span, span, span);
      return;
    }
  }

  // ── Кадр ──────────────────────────────────────────────────────────────

  draw(): void {
    const w = this.world;
    const p = w.params;
    const ctx = this.ctx;
    const z = this.zoom;
    const view = this.view();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.save();
    ctx.beginPath();
    ctx.setTransform(...view);
    ctx.rect(0, 0, DISH_WIDTH, DISH_HEIGHT);
    ctx.clip();
    this.drawTerrain();

    // Маска пятен: контуры одним цветом (перекрытия не складываются).
    const sctx = this.sctx;
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, this.spots.width, this.spots.height);
    sctx.setTransform(...view);
    sctx.beginPath();
    // Отрезков в контуре — столько, чтобы при любом масштабе край оставался гладким.
    const segments = Math.min(360, Math.max(48, Math.round(p.spotSize * z)));
    for (const poly of spotOutlines(w.light, w.step, DISH_WIDTH, DISH_HEIGHT, segments)) {
      sctx.moveTo(poly[0], poly[1]);
      for (let i = 2; i < poly.length; i += 2) sctx.lineTo(poly[i], poly[i + 1]);
      sctx.closePath();
    }
    sctx.fillStyle = rgb(SUN_COLOR);
    sctx.fill('nonzero');

    // Сила света пятен в абсолютной шкале: 1 при солнце 1.
    const lit = lightTone(p.sun) / lightTone(1);
    const penumbra = Math.min(3 * this.dpr, Math.max(0.5, (p.spotSize * SPOT_EDGE * z) / 6));

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

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(this.shade, 0, 0);
    // Свет — солнечный тёплый оттенок освещённых мест; нагрев его усиливает.
    const warmth = Math.min(0.95, SUN_WARMTH * Math.min(1, lit) + HEAT_WARMTH * Math.min(1, p.spotHeat / 2));
    ctx.globalAlpha = warmth;
    ctx.filter = `blur(${penumbra.toFixed(1)}px)`;
    ctx.drawImage(this.spots, 0, 0);
    // И чуть высветляет их, чтобы свет читался и на тёмной суше.
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = SUN_GLOW * Math.min(1, lit);
    ctx.drawImage(this.spots, 0, 0);
    // Яркое солнце высветляет освещённые места.
    if (lit > 1) {
      ctx.globalAlpha = Math.min(1, (lit - 1) * GLARE_STRENGTH);
      ctx.filter = `blur(${penumbra.toFixed(1)}px) grayscale(1) brightness(2)`;
      ctx.drawImage(this.spots, 0, 0);
    }
    ctx.restore();

    ctx.setTransform(...view);
    this.drawWalls();
  }

  /** Стена вокруг чашки и перегородки: одна заливка, одна обводка (в единицах мира). */
  private drawWalls(): void {
    const ctx = this.ctx;
    const W = this.wall;
    const solid = new Path2D();
    // Обод чашки: внешний прямоугольник минус внутренний (правило even-odd),
    // стекло с бликом — светлее к углам.
    solid.rect(-W, -W, DISH_WIDTH + 2 * W, DISH_HEIGHT + 2 * W);
    solid.rect(0, 0, DISH_WIDTH, DISH_HEIGHT);
    const gloss = ctx.createLinearGradient(-W, -W, DISH_WIDTH + W, DISH_HEIGHT + W);
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
        parts.rect(Math.min(ax, bx) - W / 2, Math.min(ay, by) - W / 2, Math.abs(bx - ax) + W, Math.abs(by - ay) + W);
      }
    }
    ctx.fillStyle = GLASS_FILL;
    ctx.fill(parts);

    const half = this.px(0.5);
    ctx.lineWidth = this.px(1);
    ctx.strokeStyle = GLASS_EDGE;
    ctx.strokeRect(-W + half, -W + half, DISH_WIDTH + 2 * W - 2 * half, DISH_HEIGHT + 2 * W - 2 * half);
    // Как у стекла: тёмный контур по краю (виден на светлом) и светлый блик
    // поверх него (виден на тёмном).
    ctx.strokeStyle = GLASS_SHADOW;
    ctx.lineWidth = this.px(2);
    ctx.stroke(this.edges);
    ctx.strokeStyle = GLASS_EDGE;
    ctx.lineWidth = this.px(0.75);
    ctx.stroke(this.edges);
  }

  /**
   * Кромка стекла: граница между свободными ячейками чашки и занятыми (стена
   * или перегородка). Стыки перегородок со стеной и между собой поэтому не
   * обводятся.
   */
  private buildEdges(): Path2D {
    const lay = this.world.partitions;
    const c = lay.cell;
    const solid = (i: number, j: number) =>
      i < 0 || j < 0 || i >= lay.cols || j >= lay.rows || lay.blocked[j * lay.cols + i] === 1;
    const path = new Path2D();
    for (let j = 0; j < lay.rows; j++) {
      for (let i = 0; i < lay.cols; i++) {
        if (solid(i, j)) continue;
        const x = Math.min(i * c, DISH_WIDTH);
        const y = Math.min(j * c, DISH_HEIGHT);
        const x1 = Math.min((i + 1) * c, DISH_WIDTH);
        const y1 = Math.min((j + 1) * c, DISH_HEIGHT);
        if (solid(i - 1, j)) { path.moveTo(x, y); path.lineTo(x, y1); }
        if (solid(i + 1, j)) { path.moveTo(x1, y); path.lineTo(x1, y1); }
        if (solid(i, j - 1)) { path.moveTo(x, y); path.lineTo(x1, y); }
        if (solid(i, j + 1)) { path.moveTo(x, y1); path.lineTo(x1, y1); }
      }
    }
    return path;
  }
}
