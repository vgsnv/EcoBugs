/**
 * Отрисовка мира на холсте в разрешении экрана — как освещённая местность,
 * с камерой: масштаб и перемещение. Вязкость — сама местность: вода синяя,
 * суша тёмный камень, отмель — камень под тонким слоем воды, переходы плавные.
 * Местность рисуется плитками под текущий масштаб и кешируется. Свет освещает
 * её пятнами: вне пятен тень, нагрев теплит освещённые места. Вокруг —
 * стеклянная стена чашки, перегородки тем же стеклом.
 */
import { DISH_HEIGHT, DISH_WIDTH, ERUPTION_RADIUS, MINERAL_LAYER, MINERAL_MOBILITY, MINERAL_PERIOD, DRIFT_REFERENCE, multiplierForLevel, eruptionRate, eruptionBursts, ventPush, BURST_WIDTH, flowAt, hash3, isBlocked, periodicFbm, smoothLevelAt, spotOutlines, SPOT_EDGE, sunAt, transparencyForDensity, VOLCANO_BIRTH, VOLCANO_POWER, type Volcano, type World } from '../core/index.ts';

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
 * Линии течений — движение среды, светлым тоном воды. Начала — по сетке через
 * столько единиц мира (со сдвигом из хеша); шаг прокладки и предел длины;
 * рисуются только течения не слабее такой доли от DRIFT_REFERENCE × солнце;
 * линия обрывается, войдя в занятую другой линией клетку (размер, ед. мира).
 * Скорость видна трижды: участки делятся на классы по скорости (границы — доли
 * от того же мерила), у быстрых — ярче и толще, и пунктир бежит со скоростью
 * течения (CSS px в секунду на единицу доли). Перестраиваются не чаще, мс.
 */
const LINE_SEED_SPACING = 70;
const LINE_STEP = 4;
const LINE_MAX_POINTS = 300;
const LINE_MIN_SHARE = 0.25;
const LINE_CELL = 20;
const LINE_CLASSES = [0.6, 1.2] as const;
const LINE_STYLES = [
  { color: 'rgba(110, 165, 230, 0.45)', width: 1, speed: 0.4 },
  { color: 'rgba(135, 190, 245, 0.6)', width: 1.4, speed: 0.9 },
  { color: 'rgba(170, 215, 255, 0.75)', width: 1.9, speed: 1.6 },
] as const;
const LINE_DASH = 6;
const LINE_GAP = 6;
const LINE_SPEED_CSS = 22;
const LINE_RETRACE_MS = 150;

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
 * Минерал — вещество с градациями плотности (цвет не занят ни местностью, ни
 * светом, ни будущей жизнью), но не главное на картинке: фон около средней
 * плотности не виден, тонкий слой — едва заметный налёт, густой — плотнее,
 * но полупрозрачный и светлее залежей. С какой плотности (от средней) виден, при
 * какой — полный; наибольшая непрозрачность; цвет тонкого и густого.
 */
export const MINERAL_COLOR: Rgb = [196, 128, 255];
const MINERAL_DEEP: Rgb = [164, 112, 236];
const MINERAL_FROM = 0.15;
const MINERAL_FULL = 8;
const MINERAL_ALPHA = 0.5;
/** Как быстро растёт непрозрачность с плотностью (1 — ровно по логарифму; больше — тонкое прозрачнее). */
const MINERAL_GAMMA = 1.1;
/**
 * Зёрна минерала — только для показа: точки там, где минерал движется (гуще,
 * где больше количество × скорость — видно и тонкие реки), движутся так же,
 * как минерал в модели: по течению на прошедшие шаги, но густое и в вязком —
 * медленнее (течение уносит только слой). Сколько зёрен, жизнь (с), размер
 * (CSS px), с какого потока (плотность от средней × скорость от мерила)
 * рождаются и при каком — наверняка, наибольший сдвиг за кадр (CSS px), цвет и яркость.
 */
const GRAIN_COUNT = 1500;
const GRAIN_LIFE: readonly [number, number] = [2, 5];
const GRAIN_CSS = 1.1;
const GRAIN_FROM = 0.01;
const GRAIN_FULL = 0.3;
const GRAIN_MAX_HOP_CSS = 10;
const GRAIN_COLOR: Rgb = [236, 214, 255];
const GRAIN_ALPHA = 0.6;
/**
 * Мутность. Свет: минерал гасит пятна света ровно настолько, насколько модель
 * задерживает свет (доля 1 − прозрачность; MURK_LIGHT = 1 — как есть). Дно:
 * лёгкое затемнение там, где прозрачность ниже средней (насколько мягче модели).
 */
const MURK_LIGHT = 1;
const MURK_STRENGTH = 0.5;
/**
 * Извержение — показывается только то, что есть в модели: вспышка света у
 * жерла на каждый залп, свечение жерла по темпу выброса; само вещество и
 * толчок — дымка минерала, зёрна и линии течений (во время извержения дымка
 * обновляется чаще).
 */
const ERUPTION_LIGHT: Rgb = [244, 232, 255];
const ERUPTION_FLASH_S = 0.6;
/** Свечение жерла: радиус (доля радиуса выброса), не меньше стольких CSS px. */
const VENT_GLOW = 0.25;
const VENT_GLOW_MIN_CSS = 14;

/** Блёстки кристаллов: с какой густоты залежей, скорость мерцания, порог вспышки (доля времени ярко — малая). */
const SPARKLE_DEPOSIT = 2;
const SPARKLE_SPEED = 1.3;
const SPARKLE_THRESHOLD = 0.965;
/** Пена у берега: насколько видна, фактура (размер ряби, единиц мира), ровная часть, пересчёт маски не чаще, мс. */
const FOAM_ALPHA = 0.4;
const FOAM_RIPPLE_SIZE = 60;
const FOAM_BASE = 0.35;
const FOAM_REBUILD_MS = 300;
/**
 * Жерло: радиус в единицах мира у слабого и сильного вулкана; на экране не
 * меньше (CSS px); цвет пепла потухшего; период мерцания созревшего, с.
 * Цвет «выходит» — тот же, что у полосы минерала.
 */
const VENT_SIZE: readonly [number, number] = [9, 15];
const VENT_MIN_CSS: readonly [number, number] = [6, 9];
const VENT_ASH: Rgb = [110, 108, 122];
const VENT_PULSE_S = 0.9;
/** Отверстие вулкана: в силе — белое с оттенком минерала, без силы (спит) — тусклое. */
const VENT_SPARK: Rgb = [250, 242, 255];
const VENT_DIM: Rgb = [128, 106, 160];
/** Пульс созревшего вулкана: насколько диск вырастает на пике. */
const VENT_BEAT = 0.3;
/** Радиус точки на экране, CSS px: у спящего и только зародившегося — и перед самым взрывом. */
const VENT_DOT_CSS: readonly [number, number] = [2.5, 7];
/**
 * Размер жерла по мощности вулкана (множитель у слабого и сильного); у
 * извергающегося — радиус диска (CSS px) у малого и у большого извержения
 * (объём — по радиусу выброса, от такой его доли); к концу извержения диск
 * сжимается до 0,55 вместе с темпом.
 */
const VENT_POWER_SCALE: readonly [number, number] = [0.7, 1.3];
/** Темп хвоста сразу после залпа (доля начального) — от него тускнеет цвет жерла. */
const VENT_TAIL_RATE = 0.13;
/** Набухание перед повторным залпом: за такую долю времени извержения до залпа, на сколько растёт диск. */
const VENT_SWELL_TIME = 0.06;
const VENT_SWELL = 0.8;
/** Приток из жерла: сколько крупинок, размер (CSS px), докуда видны (в радиусах диска). */
const SPRING_COUNT = 70;
const SPRING_DOT_CSS = 1.8;
const SPRING_REACH = 2.2;
/** Воронка: цвет отверстия и его непрозрачность (край мягкий — от сглаживания сетки). */
const FUNNEL_COLOR: Rgb = [58, 30, 92];
/** Центр отверстия — глубина: тёмно-синий. */
const FUNNEL_DEEP: Rgb = [8, 14, 46];
const FUNNEL_ALPHA = 0.6;
/** Отверстия рисуются во столько раз детальнее сетки поля; уступов глубины от кромки к центру. */
const FUNNEL_RES = 3;
const FUNNEL_STEPS = 4;
/** С такой силы воронка видна полностью; слабее — проявляется. */
const FUNNEL_SHOWN = 0.25;
/** Кромка отверстия: цвет и непрозрачность. */
const FUNNEL_RIM_COLOR: Rgb = [190, 150, 240];
const FUNNEL_RIM_ALPHA = 0.75;
/** Стекающие крупинки: сколько на воронку и сколько живут, с. */
const FUNNEL_GRAINS = 40;
const FUNNEL_GRAIN_LIFE = 6;
/** Попав в отверстие, крупинка зависает и тает за столько секунд. */
const SINK_S = 1.5;
/** Свечение недр из отверстия: цвет, размер (в радиусах отверстия), не меньше CSS px, яркость при полной силе. */
const FUNNEL_GLOW: Rgb = [110, 80, 220];
const FUNNEL_GLOW_SIZE = 2.2;
const FUNNEL_GLOW_MIN_CSS = 10;
const FUNNEL_GLOW_ALPHA = 0.7;
/** Искра ушедшей крупинки: сколько живёт, с, и размер, CSS px. */
const SPARK_S = 0.35;
const SPARK_CSS = 4;
/** Размер стекающей крупинки вдали от отверстия, CSS px (к отверстию — до точки). */
const FUNNEL_GRAIN_CSS = 2.4;
const VENT_ERUPT_CSS: readonly [number, number] = [5, 11];
const VENT_VOLUME_FROM = 0.35;
const BAR_OUT: Rgb = [226, 200, 255];

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
/** Во время извержения — чаще: видно, как выброс растекается. */
const HAZE_REDRAW_ERUPTING_MS = 60;

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
  const stock = world.params.mineralStock;
  /** Залежи в точке относительно средней плотности запаса — билинейно по клеткам. */
  const depositAt = (x: number, y: number) => {
    const deposits = world.terrain.deposits;
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

/** Мягкое круглое пятно цвета `c` — спрайт свечения и фронта (кеш по цвету). */
const puffSprites = new Map<string, HTMLCanvasElement>();
function puffSprite(c: Rgb): HTMLCanvasElement {
  const key = c.join(',');
  let sprite = puffSprites.get(key);
  if (sprite) return sprite;
  const size = 64;
  sprite = document.createElement('canvas');
  sprite.width = sprite.height = size;
  const g = sprite.getContext('2d')!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, rgb(c, 1));
  grad.addColorStop(0.4, rgb(c, 0.55));
  grad.addColorStop(1, rgb(c, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  puffSprites.set(key, sprite);
  return sprite;
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
  private lines: Path2D[] = [];
  private linesKey = '';
  private linesTracedAt = 0;
  /** Дымка минерала (клетка поля — пиксель) и версия поля, по которой она построена. */
  private readonly mineralCanvas = document.createElement('canvas');
  /** Затемнение от мутности (серый для умножения), той же сетки. */
  private readonly murkCanvas = document.createElement('canvas');
  /** Сколько света задерживает минерал (альфа = 1 − прозрачность), той же сетки — гасит маску пятен. */
  private readonly lightMurkCanvas = document.createElement('canvas');
  private mineralVersion = -1;
  /** Зёрна минерала: x, y, возраст, жизнь (по 4 числа); время анимации и шаг мира прошлого кадра. */
  private readonly grains = new Float32Array(GRAIN_COUNT * 4);
  private grainTime = -1;
  private grainStep = 0;
  /** Крупинки притока из жерла по вулканам: угол, расстояние от центра, жива ли (−1 — нет); шаг мира прошлого кадра. */
  private springs = new Map<number, { p: Float32Array; step: number }>();
  /** Отверстия воронок (клетка поля — пиксель). */
  private readonly funnelCanvas = document.createElement('canvas');
  /** Показанные воронки: место ядра, отверстие, ареол, проявленность 0…1, жива ли, крупинки (x, y, возраст; −1 — нет). */
  private funnelViews: { id: number; x: number; y: number; cells: Int32Array; reach: number; alpha: number; alive: boolean; grains: Float32Array }[] = [];
  private funnelTime = -1;
  /** Версия мира, по которой нарисованы отверстия воронок. */
  private funnelDrawn = -1;
  /** Искры крупинок, ушедших в недра: где и когда (время анимации). */
  private funnelSparks: { x: number; y: number; t: number }[] = [];
  private funnelStep = 0;
  /** Вспышки начала извержений: где, когда (время анимации), размах. */
  private shocks: { x: number; y: number; t: number; scale: number }[] = [];
  /** Сколько раз извергался каждый вулкан на прошлом кадре. */
  private seenBursts = new Map<string, number>();
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
  /** Блёстки (x, y, фаза), маска пены и когда она построена. */
  private sparkles = new Float32Array(0);
  private readonly foamCanvas = document.createElement('canvas');
  private foamBuiltAt = 0;
  private foamStep = -1;
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
    this.buildSparkles();
    this.foamStep = -1;
    this.shocks = [];
    this.seenBursts = new Map(world.mineral.volcanoes.filter((v) => v.stage === 'erupting')
      .map((v) => [`${v.id}:${v.k}`, eruptionBursts(world.params, v).filter((b) => b.at <= Math.max(0, (world.step - v.begin) / Math.max(1, v.until - v.begin))).length]));
    this.springs.clear();
    this.funnelViews = [];
    this.funnelSparks = [];
    this.funnelTime = -1;
    this.funnelStep = world.step;

    this.grains.fill(0);
    this.grainTime = -1;
    this.grainStep = world.step;
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
    this.buildSparkles();
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
    // Мутность: минерал задерживает свет — пятна над ним тусклее (по модели).
    // От маски пятен зависят и тень, и тёплый оттенок, и высветление, и блики.
    const lm = this.lightMurkCanvas;
    if (lm.width > 0) {
      sctx.globalCompositeOperation = 'destination-out';
      sctx.imageSmoothingEnabled = true;
      sctx.drawImage(lm, 0, 0, lm.width * w.mineral.cell, lm.height * w.mineral.cell);
      sctx.globalCompositeOperation = 'source-over';
    }

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
    this.drawSparkles(animTime, lit);
    this.drawFoam(animTime);
    ctx.restore();

    ctx.setTransform(...view);
    this.drawMineral(animTime);
    this.drawDriftLines(animTime);
    // Жерла — отверстия в недра: поверх течений, ничто не проходит сквозь них.
    this.drawVents(animTime);
    this.drawWalls();
  }

  /** Дымка минерала, вулканы и кольца извержений. */
  private drawMineral(animTime: number): void {
    const m = this.world.mineral;
    const stock = this.world.params.mineralStock;
    const ctx = this.ctx;
    const nowMs = performance.now();
    const hazeEvery = m.volcanoes.some((v) => v.stage === 'erupting') ? HAZE_REDRAW_ERUPTING_MS : HAZE_REDRAW_MS;
    if ((m.version !== this.mineralVersion && nowMs - this.hazeDrawnAt >= hazeEvery) || this.mineralCanvas.width !== m.cols) {
      this.hazeDrawnAt = nowMs;
      this.mineralVersion = m.version;
      const c = this.mineralCanvas;
      c.width = m.cols;
      c.height = m.rows;
      const mctx = c.getContext('2d')!;
      const img = mctx.createImageData(m.cols, m.rows);
      const area = m.cell * m.cell;
      // Размытие (два прохода [1 2 1] по каждой оси) — скопления выглядят
      // округлыми, а не квадратами клеток, но край различим. Только для показа.
      const smooth = Float32Array.from(m.field);
      const tmp = new Float32Array(smooth.length);
      for (let pass = 0; pass < 2; pass++) {
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
      const lm = this.lightMurkCanvas;
      lm.width = m.cols;
      lm.height = m.rows;
      const lctx = lm.getContext('2d')!;
      const held = lctx.createImageData(m.cols, m.rows);
      for (let k = 0; k < m.field.length; k++) {
        held.data[k * 4 + 3] = 255 * Math.min(1, (1 - transparencyForDensity(smooth[k] / area)) * MURK_LIGHT);
      }
      lctx.putImageData(held, 0, 0);
      for (let k = 0; k < m.field.length; k++) {
        // Градации: по логарифму плотности — видно и тонкий налёт, и густое ядро.
        const d = smooth[k] / area / stock;
        const t = d <= MINERAL_FROM ? 0 : Math.min(1, Math.log(d / MINERAL_FROM) / Math.log(MINERAL_FULL / MINERAL_FROM));
        const a = t ** MINERAL_GAMMA * MINERAL_ALPHA;
        const c = mix(MINERAL_COLOR, MINERAL_DEEP, smoothstep(0.4, 1, t));
        img.data[k * 4] = c[0];
        img.data[k * 4 + 1] = c[1];
        img.data[k * 4 + 2] = c[2];
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
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(this.mineralCanvas, 0, 0, m.cols * m.cell, m.rows * m.cell);
    this.drawGrains(animTime);
    ctx.restore();

    this.drawEruptions(animTime);
  }

  /** Зёрна минерала: рождаются по массе, движутся как минерал в модели, гаснут. */
  private drawGrains(animTime: number): void {
    const w = this.world;
    const m = w.mineral;
    const ctx = this.ctx;
    const dt = this.grainTime < 0 ? 0 : Math.min(0.1, Math.max(0, animTime - this.grainTime));
    this.grainTime = animTime;
    const steps = Math.max(0, w.step - this.grainStep);
    this.grainStep = w.step;
    const perMean = m.cell * m.cell * w.params.mineralStock;
    const density = (x: number, y: number) => {
      const i = Math.min(m.cols - 1, Math.max(0, Math.floor(x / m.cell)));
      const j = Math.min(m.rows - 1, Math.max(0, Math.floor(y / m.cell)));
      return m.field[j * m.cols + i];
    };
    const g = this.grains;
    const v: [number, number] = [0, 0];
    const maxHop = this.px(GRAIN_MAX_HOP_CSS);
    const layer = MINERAL_LAYER * MINERAL_MOBILITY * MINERAL_PERIOD * m.cell * m.cell;
    const size = this.px(GRAIN_CSS);
    const ref = DRIFT_REFERENCE * Math.max(1e-9, sunAt(w.light, w.step));
    /** Доля минерала клетки, которую течение уносит за обновление (тоньше слой в вязком). */
    const moving = (x: number, y: number, speed: number) => {
      const i = Math.min(m.cols - 1, Math.max(0, Math.floor(x / m.cell)));
      const j = Math.min(m.rows - 1, Math.max(0, Math.floor(y / m.cell)));
      const amount = m.field[j * m.cols + i];
      const mob = multiplierForLevel(w.terrain.applied[j * m.cols + i]);
      return amount > 0 ? Math.min(1, (layer * speed) / (mob * mob) / amount) : 1;
    };
    /** Поток минерала в точке: плотность (от средней) × скорость его движения (от мерила). */
    const flux = (x: number, y: number) => {
      flowAt(w, x, y, v);
      const sp = Math.hypot(v[0], v[1]);
      return (density(x, y) / perMean) * (sp * moving(x, y, sp)) / ref;
    };
    const holes = new Uint8Array(m.field.length);
    for (const f of m.funnels) for (const k of f.cells) holes[k] = 1;
    ctx.fillStyle = rgb(GRAIN_COLOR);
    for (let n = 0; n < GRAIN_COUNT; n++) {
      const o = n * 4;
      g[o + 2] += dt;
      if (g[o + 3] === 0 || g[o + 2] >= g[o + 3]) {
        // Новое зерно — в случайной клетке, тем вероятнее, чем больше там
        // минерала движется (количество × скорость): видно и тонкие реки.
        // Не прижилось — попробует в следующем кадре.
        const x = Math.random() * DISH_WIDTH, y = Math.random() * DISH_HEIGHT;
        g[o + 3] = 1;
        g[o + 2] = 1;
        const f = flux(x, y);
        if (f <= GRAIN_FROM || Math.random() >= (f - GRAIN_FROM) / (GRAIN_FULL - GRAIN_FROM)) continue;
        g[o] = x;
        g[o + 1] = y;
        g[o + 2] = 0;
        g[o + 3] = GRAIN_LIFE[0] + (GRAIN_LIFE[1] - GRAIN_LIFE[0]) * Math.random();
      }
      // Сдвиг, как у минерала: по течению на прошедшие шаги; из густой клетки
      // за обновление уходит лишь слой (тоньше в вязком) — во столько же раз медленнее.
      if (steps > 0) {
        flowAt(w, g[o], g[o + 1], v);
        const share = moving(g[o], g[o + 1], Math.hypot(v[0], v[1]));
        let dx = v[0] * steps * share, dy = v[1] * steps * share;
        const hop = Math.hypot(dx, dy);
        if (hop > maxHop) { dx *= maxHop / hop; dy *= maxHop / hop; }
        if (isBlocked(w.partitions, g[o] + dx, g[o + 1] + dy)) { g[o + 2] = g[o + 3]; continue; }
        // В отверстии воронки зерно не уносится: зависает и тает (уходит вниз).
        const hi = Math.min(m.cols - 1, Math.max(0, Math.floor(g[o] / m.cell)));
        const hj = Math.min(m.rows - 1, Math.max(0, Math.floor(g[o + 1] / m.cell)));
        if (!holes[hj * m.cols + hi]) {
          g[o] += dx;
          g[o + 1] += dy;
        }
      }
      const ci = Math.min(m.cols - 1, Math.max(0, Math.floor(g[o] / m.cell)));
      const cj = Math.min(m.rows - 1, Math.max(0, Math.floor(g[o + 1] / m.cell)));
      let sz = size;
      if (holes[cj * m.cols + ci]) {
        g[o + 3] = Math.min(g[o + 3], g[o + 2] + SINK_S);
        sz = size * Math.max(0.1, (g[o + 3] - g[o + 2]) / SINK_S);
      }
      const f = g[o + 2] / g[o + 3];
      ctx.globalAlpha = Math.min(1, f * 6, (1 - f) * 3) * GRAIN_ALPHA;
      ctx.fillRect(g[o] - sz / 2, g[o + 1] - sz / 2, sz, sz);
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Извержения: вспышка каждого залпа (во времени анимации — залп, прошедший
   * между кадрами, тоже её даёт) и свечение жерла по темпу выброса.
   */
  private drawEruptions(animTime: number): void {
    const w = this.world;
    const m = w.mineral;
    const ctx = this.ctx;
    const light = puffSprite(ERUPTION_LIGHT);

    // Залпы, прошедшие с прошлого кадра, — вспышки (слабые залпы — меньше).
    const live = new Set<string>();
    for (const v of m.volcanoes) {
      if (v.stage !== 'erupting') continue;
      const key = `${v.id}:${v.k}`;
      live.add(key);
      const bursts = eruptionBursts(w.params, v);
      const phase = this.eruptionPhase(v);
      const passed = bursts.filter((b) => b.at <= phase).length;
      for (let q = this.seenBursts.get(key) ?? 0; q < passed; q++) {
        this.shocks.push({ x: v.x, y: v.y, t: animTime, scale: (v.radius / ERUPTION_RADIUS) * Math.sqrt(bursts[q].share / bursts[0].share) });
      }
      this.seenBursts.set(key, passed);
    }
    for (const key of this.seenBursts.keys()) if (!live.has(key)) this.seenBursts.delete(key);
    this.shocks = this.shocks.filter((s) => animTime - s.t < ERUPTION_FLASH_S);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, DISH_WIDTH, DISH_HEIGHT);
    ctx.clip();
    ctx.globalCompositeOperation = 'screen';

    // Свечение жерла — по темпу выброса; между залпами слабее.
    for (const v of m.volcanoes) {
      if (v.stage !== 'erupting') continue;
      const flicker = 0.8 + 0.12 * Math.sin(animTime * 11 + v.id * 1.7) + 0.08 * Math.sin(animTime * 23.3 + v.id);
      const r = Math.max(this.px(VENT_GLOW_MIN_CSS), v.radius * VENT_GLOW) * (0.85 + 0.15 * flicker);
      ctx.globalAlpha = Math.min(1, (0.15 + 0.85 * this.ventStrength(v)) * flicker);
      ctx.drawImage(light, v.x - r, v.y - r, r * 2, r * 2);
    }

    // Вспышки залпов.
    for (const s of this.shocks) {
      const f = (animTime - s.t) / ERUPTION_FLASH_S;
      const r = Math.max(this.px(VENT_GLOW_MIN_CSS * 2), ERUPTION_RADIUS * 0.4 * s.scale) * (0.6 + 0.6 * f);
      ctx.globalAlpha = (1 - f) ** 2;
      ctx.drawImage(light, s.x - r, s.y - r, r * 2, r * 2);
    }
    ctx.restore();
  }

  /**
   * Жерла по стадиям — плоские; само жерло — отверстие в недра, сплошной
   * непрозрачный диск (мягкий только ореол). Размер — по модели: сильный
   * вулкан крупнее во всех стадиях; извергающийся — по объёму извержения и
   * темпу выброса сейчас:
   * - готовится — маленькая белая точка с оттенком минерала и ореолом набирает
   *   силу (растёт и ярчает, к самому взрыву — заметно крупнее) по мере
   *   созревания и роста давления к порогу;
   *   созревший перед самым выбросом пульсирует размером, цветом и ореолом;
   * - извергается — белое отверстие со светлым ореолом, к концу сжимается;
   * - спит — угасшая искра: маленькое тусклое отверстие;
   * - потух — отверстие сереет и затягивается до исчезновения.
   */
  private drawVents(animTime: number): void {
    const m = this.world.mineral;
    const step = this.world.step;
    const ctx = this.ctx;
    const pressure = Math.max(0, Math.min(1, (m.depths / m.threshold - VOLCANO_BIRTH) / (1 - VOLCANO_BIRTH)));
    ctx.globalCompositeOperation = 'source-over';
    for (const v of m.volcanoes) {
      const power = (v.power - VOLCANO_POWER[0]) / (VOLCANO_POWER[1] - VOLCANO_POWER[0]);
      const r = Math.max(this.px(VENT_MIN_CSS[0] + (VENT_MIN_CSS[1] - VENT_MIN_CSS[0]) * power), VENT_SIZE[0] + (VENT_SIZE[1] - VENT_SIZE[0]) * power);
      const phase = Math.max(0, Math.min(1, (step - v.stageAt) / Math.max(1, v.stageUntil - v.stageAt)));
      const pulse = (Math.sin((animTime * 2 * Math.PI) / VENT_PULSE_S + v.id) + 1) / 2;
      // Размер — по мощности вулкана: сильный крупнее во всех стадиях.
      const big = VENT_POWER_SCALE[0] + (VENT_POWER_SCALE[1] - VENT_POWER_SCALE[0]) * power;
      // Само жерло — отверстие в недра: сплошной непрозрачный диск; мягким
      // бывает только ореол вокруг.
      if (v.stage === 'preparing') {
        // Набирает силу: растёт и светлеет от тусклого к белому по мере
        // созревания и роста давления к порогу; к самому взрыву — заметно
        // крупнее; созревший перед выбросом мерцает. Новорождённый открывается из точки.
        const grown = v.fresh ? smoothstep(0, 1, phase) : 1;
        const force = grown * (0.3 + 0.7 * pressure);
        const ready = phase >= 1 ? smoothstep(0.85, 1, pressure) : 0;
        // Пульс созревшего — размером и цветом диска и ореолом; диск всегда непрозрачен.
        const beat = ready * pulse;
        const grow = force * force;
        const dot = Math.max(this.px(VENT_DOT_CSS[0] + (VENT_DOT_CSS[1] - VENT_DOT_CSS[0]) * grow) * big, r * (0.2 + 0.7 * grow))
          * (v.fresh ? smoothstep(0, 0.3, phase) : 1) * (1 + VENT_BEAT * beat);
        this.softSpot(v.x, v.y, dot * (3.2 + 1.2 * beat), [[0, MINERAL_COLOR, (0.45 + 0.3 * beat) * force], [0.5, MINERAL_COLOR, (0.15 + 0.15 * beat) * force], [1, MINERAL_COLOR, 0]]);
        this.solidDot(v.x, v.y, dot, mix(mix(VENT_DIM, VENT_SPARK, force), MINERAL_COLOR, 0.45 * beat));
      } else if (v.stage === 'erupting') {
        // Извергается: крупнее у большого извержения (по объёму) и сейчас, пока
        // выброс силён, — к концу диск сжимается вместе с темпом.
        const volume = Math.max(0, Math.min(1, (v.radius / ERUPTION_RADIUS - VENT_VOLUME_FROM) / (1 - VENT_VOLUME_FROM)));
        const now = VENT_ERUPT_CSS[0] + (VENT_ERUPT_CSS[1] - VENT_ERUPT_CSS[0]) * volume;
        const dot = Math.max(this.px(now) * big, r * 0.7) * (0.55 + 0.45 * this.ventStrength(v)) * (1 + VENT_SWELL * this.burstState(v).swell);
        // Залп — ярко-белый; после залпа идёт вещество — цвет минерала, тускнеет с темпом.
        // Во время залпа — ярко-белое; между залпами идёт вещество — цвет
        // минерала; перед следующим залпом набухает — растёт и светлеет — и лопается.
        const { burst, swell } = this.burstState(v);
        const after = 1 - Math.max(burst, swell);
        const color = mix(VENT_SPARK, mix(MINERAL_COLOR, VENT_DIM, 0.4 * Math.max(0, 1 - this.ventStrength(v) / VENT_TAIL_RATE)), after);
        this.softSpot(v.x, v.y, dot * 2.3, [[0.3, mix(BAR_OUT, MINERAL_COLOR, after), 0.8 - 0.4 * after], [0.75, MINERAL_COLOR, 0.35 - 0.15 * after], [1, MINERAL_COLOR, 0]]);
        this.solidDot(v.x, v.y, dot, color);
        this.drawSpring(v, dot, after);
      } else if (v.stage === 'dormant') {
        // Угасшая искра: маленькое тусклое отверстие, без ореола; может снова разгореться.
        this.solidDot(v.x, v.y, Math.max(this.px(VENT_DOT_CSS[0]) * big, r * 0.2), VENT_DIM);
      } else {
        // Потухший: отверстие сереет и затягивается до исчезновения.
        const dot = Math.max(this.px(VENT_DOT_CSS[0]) * big, r * 0.2) * (1 - phase);
        this.solidDot(v.x, v.y, dot, mix(VENT_DIM, VENT_ASH, Math.min(1, phase * 3)));
      }
    }
    for (const id of this.springs.keys()) if (!m.volcanoes.some((v) => v.id === id && v.stage === 'erupting')) this.springs.delete(id);
    this.drawFunnels(animTime);
    ctx.globalAlpha = 1;
  }

  /**
   * Приток вещества: по всей площади диска жерла появляются крупинки и уходят
   * от центра наружу так, как в модели расступается среда — скорость по
   * впрыснутому объёму (dA/dt ÷ 2πr), у центра быстрее; за краем диска тают.
   * Чем сильнее выброс, тем их больше. Движутся по шагам мира — на паузе стоят.
   */
  private drawSpring(v: Volcano, disk: number, after: number): void {
    const w = this.world;
    const ctx = this.ctx;
    let st = this.springs.get(v.id);
    if (!st) {
      st = { p: new Float32Array(SPRING_COUNT * 3), step: w.step };
      for (let n = 0; n < SPRING_COUNT; n++) st.p[n * 3 + 2] = -1;
      this.springs.set(v.id, st);
    }
    const steps = Math.max(0, w.step - st.step);
    st.step = w.step;
    // Скорость расступания: сила толчка (площадь за шаг) ÷ 2πr.
    const u = this.eruptionPhase(v);
    const rate = ventPush(w.params, v, u);
    const strength = this.ventStrength(v);
    const size = this.px(SPRING_DOT_CSS);
    const p = st.p;
    ctx.fillStyle = rgb(VENT_SPARK);
    for (let n = 0; n < SPRING_COUNT; n++) {
      const o = n * 3;
      if (p[o + 2] < 0) {
        // Новая — в случайной точке диска (равномерно по площади); живых тем больше, чем сильнее выброс.
        if (Math.random() > 0.05 + 0.6 * strength) continue;
        const a = Math.random() * Math.PI * 2, rr = disk * Math.sqrt(Math.random());
        p[o] = a; p[o + 1] = rr; p[o + 2] = 0;
      }
      const r = Math.max(p[o + 1], disk * 0.05);
      p[o + 1] = Math.sqrt(r * r + (rate * steps) / Math.PI);
      const f = p[o + 1] / (disk * SPRING_REACH);
      if (f >= 1) { p[o + 2] = -1; continue; }
      ctx.globalAlpha = (1 - f) * (0.6 + 0.35 * after) * Math.min(1, 0.55 + strength * 3);
      // Рождается точкой в жерле и растёт, отходя от него.
      const sz = size * (0.15 + 0.85 * smoothstep(0, disk * 1.2, p[o + 1]));
      ctx.fillRect(v.x + Math.cos(p[o]) * p[o + 1] - sz / 2, v.y + Math.sin(p[o]) * p[o + 1] - sz / 2, sz, sz);
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Воронки — отверстия в недра. Отверстие — светлая кромка по краю и уступы
   * вниз к центру (темнее и синее, между уступами — тонкие светлые линии) —
   * плоско, без теней; свечение недр из него по силе воронки; ушедшая вниз
   * крупинка мелькает искрой. Сгущаются и тают по модели (проявленность — сила воронки).
   * Светлые крупинки в ареоле идут по сумме
   * течений — прямо или по спирали, если рядом течение; дойдя до отверстия,
   * зависают и тают (у жерла наоборот: рождаются точкой и растут).
   */
  private drawFunnels(animTime: number): void {
    const w = this.world;
    const m = w.mineral;
    const dt = this.funnelTime < 0 ? 0 : Math.min(0.1, Math.max(0, animTime - this.funnelTime));
    this.funnelTime = animTime;
    const steps = Math.max(0, w.step - this.funnelStep);
    this.funnelStep = w.step;
    // Воронки модели — по номеру; проявленность — их сила (сгущаются и тают по модели).
    const views = new Map(this.funnelViews.map((e) => [e.id, e]));
    this.funnelViews = m.funnels.map((f) => {
      const e = views.get(f.id) ?? { id: f.id, x: f.x, y: f.y, cells: f.cells, reach: f.reach, alpha: 0, alive: true, grains: new Float32Array(FUNNEL_GRAINS * 4).fill(-1) };
      e.alpha = f.strength;
      e.alive = f.forming;
      return e;
    });
    if (this.funnelViews.length === 0) return;
    // Отверстия: форма (размытая), сила, глубина от края к центру — на сетке
    // поля; рисуются в FUNNEL_RES раз детальнее, только когда мир изменился.
    const n = m.field.length;
    const holes = new Uint8Array(n);
    for (const e of this.funnelViews) if (e.alpha > 0) for (const k of e.cells) holes[k] = 1;
    const c = this.funnelCanvas;
    const S = FUNNEL_RES;
    if (c.width !== m.cols * S) { c.width = m.cols * S; c.height = m.rows * S; this.funnelDrawn = -1; }
    if (this.funnelDrawn !== m.version) {
      this.funnelDrawn = m.version;
      const shape = new Float32Array(n), power = new Float32Array(n), depth = new Float32Array(n);
      for (const e of this.funnelViews) {
        // Глубина клетки отверстия — расстояние от её центра до края отверстия (в клетках), к центру — 1.
        const inHole = new Set<number>(Array.from(e.cells));
        const edges: number[] = [];
        for (const k of e.cells) {
          const i = k % m.cols, j = (k - i) / m.cols;
          for (const [di, dj] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
            const qi = i + di, qj = j + dj;
            if (qi < 0 || qj < 0 || qi >= m.cols || qj >= m.rows || !inHole.has(qj * m.cols + qi)) edges.push(i + di / 2, j + dj / 2);
          }
        }
        const dist = new Map<number, number>();
        for (const k of e.cells) {
          const i = k % m.cols, j = (k - i) / m.cols;
          let best = Infinity;
          for (let q = 0; q < edges.length; q += 2) best = Math.min(best, Math.hypot(edges[q] - i, edges[q + 1] - j));
          dist.set(k, best);
        }
        const deepest = Math.max(0.5, ...dist.values());
        for (const k of e.cells) {
          shape[k] = 1;
          power[k] = Math.max(power[k], e.alpha);
          depth[k] = Math.max(depth[k], (dist.get(k) ?? 0.5) / deepest);
        }
      }
      const blur = (a: Float32Array, passes: number) => {
        const tmp = new Float32Array(n);
        for (let pass = 0; pass < passes; pass++) {
          for (let k = 0; k < n; k++) {
            const i = k % m.cols;
            tmp[k] = ((i > 0 ? a[k - 1] : a[k]) + 2 * a[k] + (i < m.cols - 1 ? a[k + 1] : a[k])) / 4;
          }
          for (let k = 0; k < n; k++) a[k] = ((k >= m.cols ? tmp[k - m.cols] : tmp[k]) + 2 * tmp[k] + (k + m.cols < n ? tmp[k + m.cols] : tmp[k])) / 4;
        }
      };
      blur(shape, 1);
      blur(power, 2);
      blur(depth, 1);
      const W = m.cols * S, H = m.rows * S;
      const fctx = c.getContext('2d')!;
      fctx.clearRect(0, 0, W, H);
      const at = (a: Float32Array, fx: number, fy: number) => {
        const x = Math.min(m.cols - 1, Math.max(0, fx)), y = Math.min(m.rows - 1, Math.max(0, fy));
        const i0 = Math.floor(x), j0 = Math.floor(y), i1 = Math.min(m.cols - 1, i0 + 1), j1 = Math.min(m.rows - 1, j0 + 1);
        const u = x - i0, v = y - j0;
        return (a[j0 * m.cols + i0] * (1 - u) + a[j0 * m.cols + i1] * u) * (1 - v) + (a[j1 * m.cols + i0] * (1 - u) + a[j1 * m.cols + i1] * u) * v;
      };
      for (const e of this.funnelViews) {
        if (e.alpha <= 0) continue;
        let i0 = m.cols, i1 = 0, j0 = m.rows, j1 = 0;
        for (const k of e.cells) { const i = k % m.cols, j = (k - i) / m.cols; i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j); }
        i0 = Math.max(0, i0 - 2); j0 = Math.max(0, j0 - 2); i1 = Math.min(m.cols - 1, i1 + 2); j1 = Math.min(m.rows - 1, j1 + 2);
        const bw = (i1 - i0 + 1) * S, bh = (j1 - j0 + 1) * S;
        const img = fctx.getImageData(i0 * S, j0 * S, bw, bh);
        for (let py = 0; py < bh; py++) {
          for (let px = 0; px < bw; px++) {
            const fx = i0 + (px + 0.5) / S - 0.5, fy = j0 + (py + 0.5) / S - 0.5;
            const sh = at(shape, fx, fy);
            const st = at(power, fx, fy);
            if (sh <= 0.05 || st <= 0) continue;
            // Кромка — светлая линия по краю; внутри — уступы вниз: темнее и синее к центру, между уступами — тонкие светлые линии.
            const inside = smoothstep(0.35, 0.6, sh);
            const rim = Math.max(0, 1 - Math.abs(sh - 0.45) / 0.14);
            const d = at(depth, fx, fy) * inside;
            const ds = d * FUNNEL_STEPS;
            const level = Math.min(1, Math.floor(ds) / (FUNNEL_STEPS - 1));
            const frac = ds - Math.floor(ds);
            const contour = level > 0 && frac < 0.18 ? 1 : 0;
            let col = mix(FUNNEL_COLOR, FUNNEL_DEEP, level);
            col = mix(col, FUNNEL_RIM_COLOR, Math.max(rim, contour * 0.3));
            const a = Math.max(inside * FUNNEL_ALPHA, rim * FUNNEL_RIM_ALPHA) * smoothstep(0, FUNNEL_SHOWN, st);
            const o = (py * bw + px) * 4;
            img.data[o] = col[0];
            img.data[o + 1] = col[1];
            img.data[o + 2] = col[2];
            img.data[o + 3] = Math.max(img.data[o + 3], 255 * a);
          }
        }
        fctx.putImageData(img, i0 * S, j0 * S);
      }
    }
    const ctx = this.ctx;
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(c, 0, 0, m.cols * m.cell, m.rows * m.cell);
    // Свечение недр из отверстия — по силе воронки: рождающаяся тлеет, полная светится, тающая гаснет.
    const glow = puffSprite(FUNNEL_GLOW);
    ctx.globalCompositeOperation = 'screen';
    for (const e of this.funnelViews) {
      if (e.alpha <= 0) continue;
      let cx = 0, cy = 0;
      for (const k of e.cells) { const i = k % m.cols; cx += (i + 0.5) * m.cell; cy += ((k - i) / m.cols + 0.5) * m.cell; }
      cx /= e.cells.length; cy /= e.cells.length;
      const r = Math.max(this.px(FUNNEL_GLOW_MIN_CSS), Math.sqrt((e.cells.length * m.cell * m.cell) / Math.PI) * FUNNEL_GLOW_SIZE);
      ctx.globalAlpha = FUNNEL_GLOW_ALPHA * e.alpha;
      ctx.drawImage(glow, cx - r, cy - r, r * 2, r * 2);
    }
    ctx.globalCompositeOperation = 'source-over';
    // Крупинки стекают в отверстие по сумме течений.
    const v: [number, number] = [0, 0];
    const size = this.px(FUNNEL_GRAIN_CSS);
    const maxHop = this.px(10);
    ctx.fillStyle = rgb(VENT_SPARK);
    for (const e of this.funnelViews) {
      const p = e.grains;
      for (let q = 0; q < FUNNEL_GRAINS; q++) {
        const o = q * 4;
        if (p[o + 2] < 0) {
          if (Math.random() > 0.15 * e.alpha) continue;
          const a = Math.random() * Math.PI * 2, r = e.reach * (0.3 + 0.7 * Math.sqrt(Math.random()));
          p[o] = e.x + Math.cos(a) * r; p[o + 1] = e.y + Math.sin(a) * r; p[o + 2] = 0; p[o + 3] = -1;
        }
        p[o + 2] += dt;
        const ci = Math.min(m.cols - 1, Math.max(0, Math.floor(p[o] / m.cell)));
        const cj = Math.min(m.rows - 1, Math.max(0, Math.floor(p[o + 1] / m.cell)));
        if (holes[cj * m.cols + ci]) {
          // В отверстии течение вещество не уносит: крупинка зависает и тает — уходит вниз.
          if (p[o + 3] < 0) p[o + 3] = 0;
          p[o + 3] += dt;
        } else if (steps > 0) {
          // По сумме течений: тяга внутрь + солнечное течение вбок — прямо или по спирали.
          flowAt(w, p[o], p[o + 1], v);
          let dx = v[0] * steps, dy = v[1] * steps;
          const hop = Math.hypot(dx, dy);
          if (hop > maxHop) { dx *= maxHop / hop; dy *= maxHop / hop; }
          p[o] += dx; p[o + 1] += dy;
        }
        const sinking = p[o + 3] < 0 ? 1 : 1 - p[o + 3] / SINK_S;
        if (sinking <= 0) {
          // Ушла вниз — на её месте мелькает искра.
          this.funnelSparks.push({ x: p[o], y: p[o + 1], t: animTime });
          p[o + 2] = -1;
          continue;
        }
        if (p[o + 2] > FUNNEL_GRAIN_LIFE) { p[o + 2] = -1; continue; }
        const sz = size * (0.1 + 0.9 * sinking);
        ctx.globalAlpha = e.alpha * Math.min(1, p[o + 2] * 3) * 0.9;
        ctx.fillRect(p[o] - sz / 2, p[o + 1] - sz / 2, sz, sz);
      }
    }
    // Искры — крупинки, ушедшие в недра: короткая вспышка, расширяется и гаснет.
    this.funnelSparks = this.funnelSparks.filter((sp) => animTime - sp.t < SPARK_S);
    ctx.globalCompositeOperation = 'screen';
    const spark = puffSprite(VENT_SPARK);
    for (const sp of this.funnelSparks) {
      const f = (animTime - sp.t) / SPARK_S;
      const r = this.px(SPARK_CSS) * (0.6 + 0.8 * f);
      ctx.globalAlpha = (1 - f) ** 2;
      ctx.drawImage(spark, sp.x - r, sp.y - r, r * 2, r * 2);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  /** Сплошной непрозрачный диск. */
  private solidDot(x: number, y: number, radius: number, c: Rgb): void {
    if (radius <= 0) return;
    const ctx = this.ctx;
    ctx.globalAlpha = 1;
    ctx.fillStyle = rgb(c);
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  /** Мягкое круглое пятно: стопы — (доля радиуса, цвет, непрозрачность). */
  private softSpot(x: number, y: number, radius: number, stops: [number, Rgb, number][]): void {
    if (radius <= 0) return;
    const ctx = this.ctx;
    const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
    for (const [at, c, a] of stops) g.addColorStop(at, rgb(c, Math.max(0, Math.min(1, a))));
    ctx.globalAlpha = 1;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  /** Доля времени идущего извержения, 0…1 — плавно по шагам (темп в модели обновляется реже). */
  private eruptionPhase(v: Volcano): number {
    return Math.min(1, Math.max(0, (this.world.step - v.begin) / Math.max(1, v.until - v.begin)));
  }

  /** Сила выброса сейчас относительно начала извержения, 0…1 — как в модели. */
  private ventStrength(v: Volcano): number {
    return eruptionRate(this.world.params, v, this.eruptionPhase(v));
  }
  /** Залп сейчас (0…1) и набухание перед следующим залпом (0…1, растёт к самому залпу, с пульсом). */
  private burstState(v: Volcano): { burst: number; swell: number } {
    const u = this.eruptionPhase(v);
    let burst = 0, swell = 0;
    for (const b of eruptionBursts(this.world.params, v)) {
      if (u >= b.at && u < b.at + BURST_WIDTH) burst = Math.max(burst, 1 - (u - b.at) / BURST_WIDTH);
      if (b.at > 0 && u < b.at && u > b.at - VENT_SWELL_TIME) swell = Math.max(swell, smoothstep(b.at - VENT_SWELL_TIME, b.at, u));
    }
    return { burst, swell };
  }









  /**
   * Блёстки кристаллов залежей: точки на плотных неглубоких залежах коротко
   * вспыхивают каждая в своё время; видны только в пятнах света.
   */
  private drawSparkles(time: number, lit: number): void {
    const pts = this.sparkles;
    if (pts.length === 0) return;
    const g = this.gctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, this.glint.width, this.glint.height);
    g.setTransform(...this.view());
    const [x0, y0] = this.screenToWorld(0, 0);
    const [x1, y1] = this.screenToWorld(this.glint.width, this.glint.height);
    const buckets = [new Path2D(), new Path2D(), new Path2D()];
    for (let n = 0; n < pts.length; n += 3) {
      const x = pts[n], y = pts[n + 1];
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      const tw = Math.sin(time * SPARKLE_SPEED + pts[n + 2]);
      if (tw < SPARKLE_THRESHOLD) continue;
      const b = (tw - SPARKLE_THRESHOLD) / (1 - SPARKLE_THRESHOLD);
      const r = this.px(0.8 + 2.2 * b);
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
    g.drawImage(this.spots, 0, 0);
    g.globalCompositeOperation = 'source-over';
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = Math.min(1, lit);
    ctx.drawImage(this.glint, 0, 0);
  }

  /** Точки блёсток: на плотных залежах неглубоко — по нескольку на клетку, место и фаза из хеша. */
  private buildSparkles(): void {
    const m = this.world.mineral;
    const out: number[] = [];
    const seed = this.world.params.seed ^ 0x51a4c;
    for (let k = 0; k < this.drawnDeposit.length; k++) {
      const d = this.drawnDeposit[k];
      const L = this.drawnLevel[k];
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
   * Пена у берега: на мелководье у суши, где течение направлено в берег, —
   * гуще при сильном потоке. Маска строится по полю течений, фактура — бегущая рябь.
   */
  private drawFoam(time: number): void {
    const now = performance.now();
    if (now - this.foamBuiltAt >= FOAM_REBUILD_MS || this.foamStep < 0) {
      this.foamBuiltAt = now;
      this.foamStep = this.world.step;
      this.buildFoam();
    }
    const g = this.gctx;
    const view = this.view();
    const [x0, y0] = this.screenToWorld(0, 0);
    const [x1, y1] = this.screenToWorld(this.glint.width, this.glint.height);
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
    g.drawImage(this.foamCanvas, 0, 0, DISH_WIDTH, DISH_HEIGHT);
    g.globalCompositeOperation = 'source-over';
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = FOAM_ALPHA;
    ctx.drawImage(this.glint, 0, 0);
  }

  private buildFoam(): void {
    const w = this.world;
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
    const sun = sunAt(w.light, w.step);
    if (sun <= 0) return;
    // Вид изменился — перестроить сразу; шагнул мир — не чаще LINE_RETRACE_MS.
    const view = `${this.zoom.toFixed(4)}:${this.cx.toFixed(1)}:${this.cy.toFixed(1)}:${this.canvas.width}x${this.canvas.height}`;
    const now = performance.now();
    if (view !== this.linesKey || now - this.linesTracedAt >= LINE_RETRACE_MS) {
      this.linesKey = view;
      this.linesTracedAt = now;
      this.lines = this.traceDriftLines(sun);
    }
    const ctx = this.ctx;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash([this.px(LINE_DASH), this.px(LINE_GAP)]);
    LINE_STYLES.forEach((st, c) => {
      ctx.lineWidth = this.px(st.width);
      ctx.strokeStyle = st.color;
      // Пунктир бежит со скоростью течения своего класса.
      ctx.lineDashOffset = -this.px(animTime * LINE_SPEED_CSS * st.speed * sun);
      ctx.stroke(this.lines[c]);
    });
    ctx.setLineDash([]);
  }

  /** Линии течений по классам скорости — по сетке начал, без наложения. */
  private traceDriftLines(sun: number): Path2D[] {
    const w = this.world;
    const ref = DRIFT_REFERENCE * sun;
    const minSpeed = ref * LINE_MIN_SHARE;
    const paths = LINE_STYLES.map(() => new Path2D());
    const [vx0, vy0] = this.screenToWorld(0, 0);
    const [vx1, vy1] = this.screenToWorld(this.canvas.width, this.canvas.height);
    // На мелком масштабе начала реже, иначе линии сливаются в рябь.
    const spacing = LINE_SEED_SPACING * Math.max(1, 0.8 / (this.zoom / this.dpr));
    const gc = Math.ceil(DISH_WIDTH / LINE_CELL), gr = Math.ceil(DISH_HEIGHT / LINE_CELL);
    const taken = new Int32Array(gc * gr).fill(-1);
    const v: [number, number] = [0, 0];
    let id = 0;
    for (let sy = spacing / 2; sy < DISH_HEIGHT; sy += spacing) {
      for (let sx = spacing / 2; sx < DISH_WIDTH; sx += spacing) {
        let x = sx + (hash3(0x11ae, Math.round(sx), Math.round(sy)) / 4294967296 - 0.5) * spacing * 0.8;
        let y = sy + (hash3(0x22be, Math.round(sx), Math.round(sy)) / 4294967296 - 0.5) * spacing * 0.8;
        if (x < vx0 - spacing || x > vx1 + spacing || y < vy0 - spacing || y > vy1 + spacing) continue;
        if (x < 0 || y < 0 || x >= DISH_WIDTH || y >= DISH_HEIGHT || isBlocked(w.partitions, x, y)) continue;
        id++;
        let last = -1;
        for (let n = 0; n < LINE_MAX_POINTS; n++) {
          const cell = Math.floor(y / LINE_CELL) * gc + Math.floor(x / LINE_CELL);
          if (taken[cell] >= 0 && taken[cell] !== id) break;
          taken[cell] = id;
          flowAt(w, x, y, v);
          const sp = Math.hypot(v[0], v[1]);
          if (sp < minSpeed) break;
          const nx = x + (v[0] / sp) * LINE_STEP, ny = y + (v[1] / sp) * LINE_STEP;
          if (nx < 0 || ny < 0 || nx >= DISH_WIDTH || ny >= DISH_HEIGHT || isBlocked(w.partitions, nx, ny)) break;
          const c = sp < ref * LINE_CLASSES[0] ? 0 : sp < ref * LINE_CLASSES[1] ? 1 : 2;
          if (c !== last) { paths[c].moveTo(x, y); last = c; }
          paths[c].lineTo(nx, ny);
          x = nx; y = ny;
        }
      }
    }
    return paths;
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
