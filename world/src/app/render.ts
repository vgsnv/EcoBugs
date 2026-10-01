/**
 * Отрисовка мира на холсте в разрешении экрана — как освещённая местность,
 * с камерой: масштаб и перемещение. Вязкость — сама местность: вода синяя,
 * суша тёмный камень, отмель — камень под тонким слоем воды, переходы плавные.
 * Местность рисуется плитками под текущий масштаб и кешируется. Свет освещает
 * её пятнами: вне пятен тень, нагрев теплит освещённые места. Вокруг —
 * стеклянная стена чашки, перегородки тем же стеклом.
 */
import { DISH_HEIGHT, DISH_WIDTH, ERUPTION_RADIUS, hash3, isBlocked, periodicFbm, smoothLevelAt, spotAnchors, spotOutlines, SPOT_EDGE, sunAt, transparencyForDensity, type World } from '../core/index.ts';

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
/**
 * Залежи минерала на дне: тёмно-фиолетовые, с мелкими светлыми кристаллами;
 * с какой густоты залежей (от средней плотности запаса) начинаются и с какой
 * сплошные, наибольшая укрывистость, доля и яркость кристаллов.
 */
export const DEPOSIT_COLOR: Rgb = [84, 44, 122];
const DEPOSIT_FROM = 0.5;
const DEPOSIT_FULL = 8;
const DEPOSIT_MAX = 0.9;
const CRYSTAL_SHARE = 0.06;
const CRYSTAL_LIGHT = 70;
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

/** Блики на освещённой воде: сила, размер узора ряби в единицах мира, скорость, единиц в секунду. */
const GLINT_ALPHA = 0.15;
const GLINT_LAYERS = [
  { size: 130, vx: 5, vy: 2.5 },
  { size: 210, vx: -3.5, vy: 4 },
] as const;
/**
 * Линии течений: начала — через столько единиц по краю пятна; шаг прокладки
 * и предел длины в шагах (единицы мира); порог слабого течения (доля силы
 * сноса); пунктир и его скорость (CSS px); цвет.
 */
const LINE_ANCHOR_SPACING = 60;
const LINE_STEP = 4;
const LINE_MAX_POINTS = 400;
const LINE_MIN_SHARE = 0.05;
const LINE_DASH = 5;
const LINE_GAP = 5;
const LINE_SPEED_CSS = 14;
const LINE_COLOR = 'rgba(235, 245, 255, 0.6)';
/** Наконечник — только у линии не короче стольких CSS px; ниже такого масштаба (CSS px на единицу) линий вдвое меньше. */
const LINE_HEAD_MIN_CSS = 18;
const LINE_THIN_BELOW_CSS = 0.8;

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

/**
 * Минерал: фиолетовая дымка там, где минерала больше среднего (цвет не занят
 * ни местностью, ни светом, ни будущей жизнью) — видны скопления, обычный фон
 * чистый. Плотность, при которой дымка полная, — во столько раз выше средней;
 * наибольшая непрозрачность.
 */
export const MINERAL_COLOR: Rgb = [196, 128, 255];
const MINERAL_FROM = 1;
const MINERAL_FULL = 6;
const MINERAL_ALPHA = 0.5;
/** Насколько мягче показывать затемнение от мутности, чем по модели (1 — как есть). */
const MURK_STRENGTH = 0.8;
/** Кольца идущего извержения: сколько секунд расходится одно, сколько колец сразу. */
const ERUPTION_RING_S = 1.6;
const ERUPTION_RINGS = 3;
const ERUPTION_RING_COLOR = 'rgb(240, 225, 255)';
const ERUPTION_RING_MIN_CSS = 36;

/** Перерисовывать изменившуюся местность не чаще, мс. */
const TERRAIN_REDRAW_MS = 1000;
/**
 * Перерисовка местности блоками REDRAW_BLOCK единиц мира — только там, где
 * уровень изменился больше REDRAW_LEVEL или залежи (в средних плотностях)
 * больше REDRAW_DEPOSIT с прошлой отрисовки.
 */
const REDRAW_BLOCK = 64;
const REDRAW_LEVEL = 0.02;
const REDRAW_DEPOSIT = 0.3;
/** Сколько мс кадра можно тратить на дорисовку подложки. */
const REDRAW_BUDGET_MS = 4;
/** Шаг маски воды для бликов, единиц мира. */
const WATER_MASK_STEP = 4;
/** Дымку минерала пересобирать не чаще, мс. */
const HAZE_REDRAW_MS = 250;

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
  const m = world.mineral;
  const deposits = world.terrain.deposits;
  const stock = world.params.mineralStock;
  /** Залежи в точке относительно средней плотности запаса — билинейно по клеткам. */
  const depositAt = (x: number, y: number) => {
    const fx = Math.min(m.cols - 1, Math.max(0, x / m.cell - 0.5)), fy = Math.min(m.rows - 1, Math.max(0, y / m.cell - 0.5));
    const i0 = Math.floor(fx), j0 = Math.floor(fy), i1 = Math.min(m.cols - 1, i0 + 1), j1 = Math.min(m.rows - 1, j0 + 1);
    const u = fx - i0, v = fy - j0;
    const a = deposits[j0 * m.cols + i0] + (deposits[j0 * m.cols + i1] - deposits[j0 * m.cols + i0]) * u;
    const b = deposits[j1 * m.cols + i0] + (deposits[j1 * m.cols + i1] - deposits[j1 * m.cols + i0]) * u;
    return (a + (b - a) * v) / (m.cell * m.cell) / stock;
  };
  return (x, y, out, k) => {
    const L = smoothLevelAt(world.viscosity, x, y);
    const crack = 1 - smoothstep(0.02, 0.07, edge(x / STONE_SLAB, y / STONE_SLAB));
    const v = STONE_BASE + STONE_MOTTLE * mottle(x, y) + STONE_GRAIN * grain(x, y) - STONE_CRACK * crack;
    // Вода мелеет к отмели и сходит на нет к суше; камень под ней светлее.
    const shallow = smoothstep(0.2, 1.3, L);
    const dry = smoothstep(1.35, 1.75, L);
    const stone = v + STONE_UNDERWATER_LIFT * (1 - dry);
    let r = stone, g = stone, b = stone + 4;
    // Залежи: тёмно-фиолетовый налёт на дне — гуще залежи, плотнее цвет;
    // по нему редкие светлые кристаллы.
    const lode = Math.min(1, smoothstep(DEPOSIT_FROM, DEPOSIT_FULL, depositAt(x, y)));
    if (lode > 0) {
      const speck = hash3(seed ^ 0x3a7d, Math.round(x * 1.5), Math.round(y * 1.5)) / 4294967296;
      const crystal = speck < CRYSTAL_SHARE * lode ? CRYSTAL_LIGHT : 0;
      const cover = lode * DEPOSIT_MAX;
      r += (DEPOSIT_COLOR[0] + crystal * 0.9 - r) * cover;
      g += (DEPOSIT_COLOR[1] + crystal * 0.6 - g) * cover;
      b += (DEPOSIT_COLOR[2] + crystal - b) * cover;
    }
    const water = mix(DEEP_WATER, SHALLOW_WATER, shallow);
    const cover = (1 - SHALLOWS_CLARITY * shallow) * (1 - dry);
    out[k] = r + (water[0] - r) * cover;
    out[k + 1] = g + (water[1] - g) * cover;
    out[k + 2] = b + (water[2] - b) * cover;
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
  /** Слой бликов: рябь, оставленная только на освещённой воде. */
  private readonly glint = document.createElement('canvas');
  private readonly gctx: CanvasRenderingContext2D;
  private readonly ripplePattern: CanvasPattern;
  /** Где вода (альфа), в масштабе 1:4 — строится один раз на мир. */
  private waterMask = document.createElement('canvas');
  /** Перегородки одним путём (в единицах мира). */
  private parts = new Path2D();
  /** Линии течений и ключ вида, для которого они проведены. */
  private lines = { body: new Path2D(), heads: new Path2D() };
  private linesKey = '';
  /** Дымка минерала (клетка поля — пиксель) и версия поля, по которой она построена. */
  private readonly mineralCanvas = document.createElement('canvas');
  /** Затемнение от мутности (серый для умножения), той же сетки. */
  private readonly murkCanvas = document.createElement('canvas');
  private mineralVersion = -1;
  /** Контуры пятен последнего кадра — для мини-карты. */
  private lastSpots = new Path2D();
  private world!: World;
  /** Толщина стены вокруг чашки, единиц мира — как у перегородок. */
  private wall = 0;
  /** Версия карты вязкости, по которой нарисована местность, и когда перерисована. */
  private terrainVersion = -1;
  private terrainDrawnAt = 0;
  /** Уровень и залежи, по которым нарисована местность (на сетке минерала). */
  private drawnLevel = new Float32Array(0);
  private drawnDeposit = new Float32Array(0);
  private hazeDrawnAt = 0;
  /** Блоки подложки, ждущие перерисовки, и сколько блоков в строке. */
  private readonly redrawQueue = new Set<number>();
  private redrawCols = 1;
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
    this.gctx = this.glint.getContext('2d')!;
    this.ripplePattern = this.gctx.createPattern(ripple(), 'repeat')!;
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  setWorld(world: World): void {
    this.world = world;
    this.wall = world.partitions.thickness;
    this.sample = terrainSampler(world);
    this.base = renderTerrain(this.sample, 0, 0, DISH_WIDTH * TILE_SCALE_MIN, DISH_HEIGHT * TILE_SCALE_MIN, TILE_SCALE_MIN);
    this.tiles.clear();
    this.edges = this.buildEdges();
    this.parts = this.buildParts();
    this.waterMask = this.buildWaterMask();
    this.terrainVersion = world.viscosity.version;
    this.redrawQueue.clear();
    this.drawnLevel = Float32Array.from(world.terrain.applied);
    const per = world.mineral.cell * world.mineral.cell * world.params.mineralStock;
    this.drawnDeposit = Float32Array.from(world.terrain.deposits, (d) => d / per);
    this.resize();
    this.fit();
  }

  private get dpr(): number {
    return window.devicePixelRatio || 1;
  }

  /**
   * Местность изменилась (пересборка из грунта) — перестроить подложку, маску
   * воды и сбросить плитки. Не чаще раза в TERRAIN_REDRAW_MS: на ускорении
   * пересборки идут часто, а картинка нужна плавная.
   */
  /** Дорисовать часть очереди изменившихся блоков подложки — в пределах REDRAW_BUDGET_MS. */
  private drainRedraw(): void {
    if (this.redrawQueue.size === 0) return;
    const start = performance.now();
    const bctx = this.base.getContext('2d')!;
    const wctx = this.waterMask.getContext('2d')!;
    for (const b of this.redrawQueue) {
      this.redrawQueue.delete(b);
      const x0 = (b % this.redrawCols) * REDRAW_BLOCK, y0 = Math.floor(b / this.redrawCols) * REDRAW_BLOCK;
      const px = REDRAW_BLOCK * TILE_SCALE_MIN;
      bctx.drawImage(renderTerrain(this.sample, x0, y0, px, px, TILE_SCALE_MIN), x0 * TILE_SCALE_MIN, y0 * TILE_SCALE_MIN);
      wctx.putImageData(this.waterMaskBlock(x0, y0), x0 / WATER_MASK_STEP, y0 / WATER_MASK_STEP);
      if (performance.now() - start > REDRAW_BUDGET_MS) break;
    }
  }

  private refreshTerrain(): void {
    const v = this.world.viscosity.version;
    if (v === this.terrainVersion) return;
    const now = performance.now();
    if (now - this.terrainDrawnAt < TERRAIN_REDRAW_MS) return;
    this.terrainVersion = v;
    this.terrainDrawnAt = now;
    // Перерисовываем только участки, где уровень или залежи заметно изменились
    // с прошлой отрисовки: блоки по REDRAW_BLOCK единиц мира.
    const m = this.world.mineral;
    const level = this.world.terrain.applied;
    const dep = this.world.terrain.deposits;
    const perDensity = m.cell * m.cell * this.world.params.mineralStock;
    const bs = REDRAW_BLOCK / m.cell;
    const bcols = Math.ceil(m.cols / bs), brows = Math.ceil(m.rows / bs);
    const dirty = new Uint8Array(bcols * brows);
    let any = false;
    for (let k = 0; k < level.length; k++) {
      const d = dep[k] / perDensity;
      if (Math.abs(level[k] - this.drawnLevel[k]) > REDRAW_LEVEL || Math.abs(d - this.drawnDeposit[k]) > REDRAW_DEPOSIT) {
        this.drawnLevel[k] = level[k];
        this.drawnDeposit[k] = d;
        const i = k % m.cols, j = (k - i) / m.cols;
        dirty[Math.floor(j / bs) * bcols + Math.floor(i / bs)] = 1;
        any = true;
      }
    }
    if (!any) return;
    // Подложку и маску воды по изменившимся блокам дорисовываем понемногу,
    // по кадрам (drainRedraw), — чтобы не было рывка.
    for (let bj = 0; bj < brows; bj++) {
      for (let bi = 0; bi < bcols; bi++) if (dirty[bj * bcols + bi]) this.redrawQueue.add(bj * bcols + bi);
    }
    this.redrawCols = bcols;
    // Плитки, задевающие изменившиеся блоки, — заново (лениво, как обычно).
    for (const key of [...this.tiles.keys()]) {
      const [sc, ti, tj] = key.split(':').map(Number);
      const span = TILE / sc;
      const b0i = Math.floor((ti * span) / REDRAW_BLOCK), b1i = Math.floor(((ti + 1) * span - 1e-6) / REDRAW_BLOCK);
      const b0j = Math.floor((tj * span) / REDRAW_BLOCK), b1j = Math.floor(((tj + 1) * span - 1e-6) / REDRAW_BLOCK);
      let hit = false;
      for (let bj = Math.max(0, b0j); bj <= Math.min(brows - 1, b1j) && !hit; bj++) {
        for (let bi = Math.max(0, b0i); bi <= Math.min(bcols - 1, b1i); bi++) if (dirty[bj * bcols + bi]) { hit = true; break; }
      }
      if (hit) this.tiles.delete(key);
    }
  }


  /** Подогнать разрешение холстов под размер на экране и плотность пикселей. */
  private resize(): void {
    const w = Math.max(1, Math.round(this.canvas.clientWidth * this.dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * this.dpr));
    if (w !== this.canvas.width || h !== this.canvas.height) {
      for (const c of [this.canvas, this.spots, this.shade, this.glint]) {
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

  /** Кадр; `animTime` — секунды анимации бликов (стоит на паузе). */
  draw(animTime = 0): void {
    this.refreshTerrain();
    this.drainRedraw();
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
    const spotsPath = new Path2D();
    // Отрезков в контуре — столько, чтобы при любом масштабе край оставался гладким.
    const segments = Math.min(360, Math.max(48, Math.round(p.spotSize * z)));
    for (const poly of spotOutlines(w.light, w.step, DISH_WIDTH, DISH_HEIGHT, segments)) {
      spotsPath.moveTo(poly[0], poly[1]);
      for (let i = 2; i < poly.length; i += 2) spotsPath.lineTo(poly[i], poly[i + 1]);
      spotsPath.closePath();
    }
    this.lastSpots = spotsPath;
    sctx.fillStyle = rgb(SUN_COLOR);
    sctx.fill(spotsPath, 'nonzero');

    // Сила света пятен в абсолютной шкале: 1 при солнце 1.
    const lit = lightTone(sunAt(w.light, w.step)) / lightTone(1);
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
    ctx.filter = 'none';
    this.drawGlints(animTime, lit);
    ctx.restore();

    ctx.setTransform(...view);
    this.drawMineral(animTime);
    this.drawDriftLines(animTime);
    this.drawWalls();
  }

  /** Дымка минерала, вулканы и кольца извержений. */
  private drawMineral(animTime: number): void {
    const m = this.world.mineral;
    const stock = this.world.params.mineralStock;
    const ctx = this.ctx;
    const nowMs = performance.now();
    if ((m.version !== this.mineralVersion && nowMs - this.hazeDrawnAt >= HAZE_REDRAW_MS) || this.mineralCanvas.width !== m.cols) {
      this.hazeDrawnAt = nowMs;
      this.mineralVersion = m.version;
      const c = this.mineralCanvas;
      c.width = m.cols;
      c.height = m.rows;
      const mctx = c.getContext('2d')!;
      const img = mctx.createImageData(m.cols, m.rows);
      const area = m.cell * m.cell;
      // Размытие (три прохода [1 2 1] по каждой оси) — скопления выглядят
      // округлыми пятнами, а не квадратами клеток. Только для показа.
      const smooth = Float32Array.from(m.field);
      const tmp = new Float32Array(smooth.length);
      for (let pass = 0; pass < 3; pass++) {
        for (let j = 0; j < m.rows; j++) {
          for (let i = 0; i < m.cols; i++) {
            const k = j * m.cols + i;
            const l = i > 0 ? smooth[k - 1] : smooth[k], r = i < m.cols - 1 ? smooth[k + 1] : smooth[k];
            tmp[k] = (l + 2 * smooth[k] + r) / 4;
          }
        }
        for (let j = 0; j < m.rows; j++) {
          for (let i = 0; i < m.cols; i++) {
            const k = j * m.cols + i;
            const u = j > 0 ? tmp[k - m.cols] : tmp[k], d = j < m.rows - 1 ? tmp[k + m.cols] : tmp[k];
            smooth[k] = (u + 2 * tmp[k] + d) / 4;
          }
        }
      }
      const murk = this.murkCanvas;
      murk.width = m.cols;
      murk.height = m.rows;
      const kctx = murk.getContext('2d')!;
      const dark = kctx.createImageData(m.cols, m.rows);
      const meanT = transparencyForDensity(stock);
      for (let k = 0; k < m.field.length; k++) {
        // Мутность: темнее там, где прозрачность ниже, чем при средней плотности.
        const shade = Math.min(1, transparencyForDensity(smooth[k] / area) / meanT);
        const g = 255 * (1 - (1 - shade) * MURK_STRENGTH);
        dark.data[k * 4] = dark.data[k * 4 + 1] = dark.data[k * 4 + 2] = g;
        dark.data[k * 4 + 3] = 255;
      }
      kctx.putImageData(dark, 0, 0);
      for (let k = 0; k < m.field.length; k++) {
        const d = smooth[k] / area / stock;
        const a = Math.min(1, Math.max(0, (d - MINERAL_FROM) / (MINERAL_FULL - MINERAL_FROM))) ** 0.8 * MINERAL_ALPHA;
        img.data[k * 4] = MINERAL_COLOR[0];
        img.data[k * 4 + 1] = MINERAL_COLOR[1];
        img.data[k * 4 + 2] = MINERAL_COLOR[2];
        img.data[k * 4 + 3] = a * 255;
      }
      mctx.putImageData(img, 0, 0);
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, DISH_WIDTH, DISH_HEIGHT);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(this.murkCanvas, 0, 0, m.cols * m.cell, m.rows * m.cell);
    ctx.globalCompositeOperation = 'screen';
    ctx.drawImage(this.mineralCanvas, 0, 0, m.cols * m.cell, m.rows * m.cell);
    ctx.restore();

    // Идущие извержения: кольца расходятся от вулкана, пока он извергается;
    // ярче на пике извержения (выброс за шаг относительно пикового).
    for (const v of m.volcanoes) {
      if (!v.active) continue;
      const peak = (2 * v.total) / Math.max(1, v.until - v.begin);
      const strength = 0.25 + 0.75 * Math.min(1, v.rate / Math.max(1e-12, peak));
      for (let n = 0; n < ERUPTION_RINGS; n++) {
        const f = (animTime / ERUPTION_RING_S + n / ERUPTION_RINGS) % 1;
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = (1 - f) * strength;
        ctx.strokeStyle = ERUPTION_RING_COLOR;
        ctx.lineWidth = this.px(2);
        ctx.beginPath();
        // Не меньше ERUPTION_RING_MIN_CSS на экране — чтобы было видно и на всей чашке.
        ctx.arc(v.x, v.y, Math.max(ERUPTION_RADIUS, this.px(ERUPTION_RING_MIN_CSS)) * (0.15 + 0.85 * f), 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    // Вулканы: тёмный кружок с фиолетовой каймой; извергающийся — светлый.
    const r = this.px(5);
    for (const v of m.volcanoes) {
      ctx.beginPath();
      ctx.arc(v.x, v.y, v.active ? r * 1.3 : r, 0, Math.PI * 2);
      ctx.fillStyle = v.active ? ERUPTION_RING_COLOR : 'rgba(30, 18, 40, 0.9)';
      ctx.fill();
      ctx.lineWidth = this.px(2);
      ctx.strokeStyle = rgb(MINERAL_COLOR);
      ctx.stroke();
    }
  }

  /** Блики: две сдвигающиеся ряби, оставленные только на воде и в пятнах света. */
  private drawGlints(time: number, lit: number): void {
    const g = this.gctx;
    const [x0, y0] = this.screenToWorld(0, 0);
    const [x1, y1] = this.screenToWorld(this.glint.width, this.glint.height);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, this.glint.width, this.glint.height);
    g.setTransform(...this.view());
    GLINT_LAYERS.forEach((layer, n) => {
      const k = layer.size / 256;
      this.ripplePattern.setTransform(new DOMMatrix([k, 0, 0, k, layer.vx * time, layer.vy * time]));
      g.fillStyle = this.ripplePattern;
      g.globalCompositeOperation = n === 0 ? 'source-over' : 'lighter';
      g.fillRect(x0, y0, x1 - x0, y1 - y0);
    });
    g.globalCompositeOperation = 'destination-in';
    g.imageSmoothingEnabled = true;
    g.drawImage(this.waterMask, 0, 0, DISH_WIDTH, DISH_HEIGHT);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(this.spots, 0, 0);
    g.globalCompositeOperation = 'source-over';
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = GLINT_ALPHA * Math.min(1, lit);
    ctx.drawImage(this.glint, 0, 0);
  }

  /**
   * Линии течений — часть пятен света: от точек на внешнем краю каждого пятна
   * по течению до его конца, бегущим пунктиром, на конце — наконечник. Точки
   * движутся вместе с пятнами, поэтому линии не пропадают, а плавно меняются
   * вслед за светом; где течения нет, линия нулевой длины.
   */
  private drawDriftLines(animTime: number): void {
    const w = this.world;
    const strength = w.params.driftStrength;
    if (strength <= 0) return;
    const key = `${this.zoom.toFixed(4)}:${this.cx.toFixed(1)}:${this.cy.toFixed(1)}:${w.step}:${this.canvas.width}x${this.canvas.height}`;
    if (key !== this.linesKey) {
      this.linesKey = key;
      this.lines = this.traceDriftLines();
    }
    const ctx = this.ctx;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = this.px(1.2);
    ctx.strokeStyle = LINE_COLOR;
    ctx.setLineDash([this.px(LINE_DASH), this.px(LINE_GAP)]);
    // Пунктир бежит вдоль течения; быстрее при большей силе сноса.
    ctx.lineDashOffset = -this.px(animTime * LINE_SPEED_CSS * Math.min(2, strength / 0.3));
    ctx.stroke(this.lines.body);
    ctx.setLineDash([]);
    ctx.fillStyle = LINE_COLOR;
    ctx.fill(this.lines.heads);
  }

  private traceDriftLines(): { body: Path2D; heads: Path2D } {
    const w = this.world;
    const minSpeed = w.params.driftStrength * LINE_MIN_SHARE;
    const body = new Path2D();
    const heads = new Path2D();
    // Только пятна рядом с видимой частью: линия уходит от края не дальше, чем течение.
    const [vx0, vy0] = this.screenToWorld(0, 0);
    const [vx1, vy1] = this.screenToWorld(this.canvas.width, this.canvas.height);
    const pad = LINE_STEP * LINE_MAX_POINTS;
    const anchors = spotAnchors(w.light, w.step, DISH_WIDTH, DISH_HEIGHT, LINE_ANCHOR_SPACING);
    const v: [number, number] = [0, 0];
    const minLen = this.px(LINE_HEAD_MIN_CSS);
    // На мелком масштабе — каждая вторая точка: иначе линии сливаются в рябь.
    const stride = (this.zoom / this.dpr) < LINE_THIN_BELOW_CSS ? 4 : 2;
    for (let a = 0; a < anchors.length; a += stride) {
      let x = anchors[a], y = anchors[a + 1];
      if (x < vx0 - pad || x > vx1 + pad || y < vy0 - pad || y > vy1 + pad) continue;
      if (x < 0 || y < 0 || x >= DISH_WIDTH || y >= DISH_HEIGHT || isBlocked(w.partitions, x, y)) continue;
      let px = 0, py = 0, len = 0, started = false;
      for (let n = 0; n < LINE_MAX_POINTS; n++) {
        w.drift.at(x, y, w.step, v);
        const s = Math.hypot(v[0], v[1]);
        if (s < minSpeed) break;
        const ux = v[0] / s, uy = v[1] / s;
        // Разворот — место встречи течений: там конец.
        if (n > 0 && ux * px + uy * py < 0.2) break;
        const nx = x + ux * LINE_STEP, ny = y + uy * LINE_STEP;
        if (nx < 0 || ny < 0 || nx >= DISH_WIDTH || ny >= DISH_HEIGHT || isBlocked(w.partitions, nx, ny)) break;
        if (!started) { body.moveTo(x, y); started = true; }
        body.lineTo(nx, ny);
        x = nx; y = ny; px = ux; py = uy; len += LINE_STEP;
      }
      // Наконечник — только у заметной линии, по направлению последнего шага.
      if (len < minLen) continue;
      const h = this.px(4.5), hw = this.px(2.6);
      heads.moveTo(x + px * h * 0.4, y + py * h * 0.4);
      heads.lineTo(x - px * h - py * hw, y - py * h + px * hw);
      heads.lineTo(x - px * h + py * hw, y - py * h - px * hw);
      heads.closePath();
    }
    return { body, heads };
  }

  /** Мини-карта при приближении: вся чашка, пятна света, перегородки и рамка вида; скрыта, когда видна вся чашка. */
  drawMinimap(mini: HTMLCanvasElement): void {
    mini.hidden = this.fitted;
    if (this.fitted || !this.world) return;
    const w = Math.round(mini.clientWidth * this.dpr);
    const h = Math.round(mini.clientHeight * this.dpr);
    if (mini.width !== w || mini.height !== h) { mini.width = w; mini.height = h; }
    const m = mini.getContext('2d')!;
    const s = w / DISH_WIDTH;
    m.setTransform(s, 0, 0, s, 0, 0);
    m.globalCompositeOperation = 'source-over';
    m.drawImage(this.base, 0, 0, DISH_WIDTH, DISH_HEIGHT);
    m.globalCompositeOperation = 'multiply';
    m.fillStyle = rgb(SHADE_COLOR);
    m.fillRect(0, 0, DISH_WIDTH, DISH_HEIGHT);
    m.globalCompositeOperation = 'source-over';
    m.save();
    m.clip(this.lastSpots);
    m.drawImage(this.base, 0, 0, DISH_WIDTH, DISH_HEIGHT);
    m.restore();
    m.fillStyle = 'rgba(214, 230, 245, 0.9)';
    m.fill(this.parts);
    const [x0, y0] = this.screenToWorld(0, 0);
    const [x1, y1] = this.screenToWorld(this.canvas.width, this.canvas.height);
    m.lineWidth = 2 * this.dpr / s;
    m.strokeStyle = '#ffffff';
    m.strokeRect(Math.max(0, x0), Math.max(0, y0), Math.min(DISH_WIDTH, x1) - Math.max(0, x0), Math.min(DISH_HEIGHT, y1) - Math.max(0, y0));
  }

  /** Точка мини-карты (координаты окна) → центр вида там. */
  centerFromMinimap(mini: HTMLCanvasElement, clientX: number, clientY: number): void {
    const r = mini.getBoundingClientRect();
    const x = ((clientX - r.left) / r.width) * DISH_WIDTH;
    const y = ((clientY - r.top) / r.height) * DISH_HEIGHT;
    this.setView(this.zoom, x, y);
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
    ctx.fillStyle = GLASS_FILL;
    ctx.fill(this.parts);

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

  /** Перегородки — прямоугольники-отрезки толщиной стенки с квадратными концами. */
  private buildParts(): Path2D {
    const W = this.wall;
    const parts = new Path2D();
    for (const part of this.world.partitions.partitions) {
      for (let k = 1; k < part.points.length; k++) {
        const [ax, ay] = part.points[k - 1];
        const [bx, by] = part.points[k];
        parts.rect(Math.min(ax, bx) - W / 2, Math.min(ay, by) - W / 2, Math.abs(bx - ax) + W, Math.abs(by - ay) + W);
      }
    }
    return parts;
  }

  /** Маска воды для бликов: непрозрачна в воде, гаснет к отмели, пуста на суше и перегородках. */
  private buildWaterMask(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = DISH_WIDTH / WATER_MASK_STEP;
    c.height = DISH_HEIGHT / WATER_MASK_STEP;
    const mctx = c.getContext('2d')!;
    for (let y0 = 0; y0 < DISH_HEIGHT; y0 += REDRAW_BLOCK) {
      for (let x0 = 0; x0 < DISH_WIDTH; x0 += REDRAW_BLOCK) mctx.putImageData(this.waterMaskBlock(x0, y0), x0 / WATER_MASK_STEP, y0 / WATER_MASK_STEP);
    }
    return c;
  }

  /** Кусок маски воды для блока REDRAW_BLOCK × REDRAW_BLOCK с углом (x0, y0). */
  private waterMaskBlock(x0: number, y0: number): ImageData {
    const step = WATER_MASK_STEP;
    const n = REDRAW_BLOCK / step;
    const img = new ImageData(n, n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = x0 + (i + 0.5) * step, y = y0 + (j + 0.5) * step;
        const inside = x < DISH_WIDTH && y < DISH_HEIGHT;
        const water = !inside || isBlocked(this.world.partitions, x, y) ? 0 : 1 - smoothstep(0.35, 0.95, smoothLevelAt(this.world.viscosity, x, y));
        const k = (j * n + i) * 4;
        img.data[k] = img.data[k + 1] = img.data[k + 2] = 255;
        img.data[k + 3] = water * 255;
      }
    }
    return img;
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
