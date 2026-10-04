/**
 * Местность: вязкость и фактура камня, залежи на дне, берег. Рисуется
 * плитками под текущий масштаб и кешируется; изменившиеся участки
 * перерисовываются блоками понемногу, по кадрам. Здесь же маска воды.
 */
import { finishCalculation, type Calculation } from '../../core/task.ts';
import { insideDish, hash3, isBlocked, periodicFbm, smoothLevelAt, type Dish, type World } from '../../core/index.ts';
import type { Frame } from './frame.ts';
import {
  CRYSTAL_LIGHT, CRYSTAL_SHARE, DEEP_WATER, DEPOSIT_COLOR, DEPOSIT_FROM, DEPOSIT_FULL, DEPOSIT_MAX, SHALLOW_WATER, SHALLOWS_CLARITY,
  SHORE_LIGHT, STONE_BASE, STONE_CRACK, STONE_GRAIN, STONE_MOTTLE, STONE_SLAB, STONE_UNDERWATER_LIFT, WET_SHORE, mix, smoothstep,
} from './palette.ts';

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
/** Шаг маски воды для бликов, единиц мира. */
const WATER_MASK_STEP = 4;
/** Сторона плитки местности, пикселей. */
const TILE = 256;
/** Масштабы плиток — пикселей устройства на единицу мира, степени двойки. */
export const TILE_SCALE_MIN = 0.5;
const TILE_SCALE_MAX = 32;
/** Сколько плиток держать в памяти (≈256 КБ каждая). */
const TILE_CACHE = 240;
/** Общий бюджет кадра на подложку и новые плитки, мс. */
const TERRAIN_WORK_BUDGET_MS = 4;

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

type Sampler = (x: number, y: number, out: Uint8ClampedArray, k: number, detail: number) => void;

/** Цвет местности в точке мира: вязкость и фактура камня, посчитанные один раз на мир. */
function terrainSampler(world: World): Sampler {
  const { width, height } = world.dish;
  const seed = world.params.seed;
  // Фактура камня в единицах мира — узор только для глаза, на модель не влияет.
  const fbm = periodicFbm(seed ^ 0x51a7e, Math.ceil(width / 40), Math.ceil(height / 40), 4);
  const mottle = gridField(width, height, 4, (x, y) => fbm(x / 40, y / 40));
  const grain = gridField(width, height, 1.25, (x, y) => hash3(seed ^ 0x6a41, Math.round(x * 0.8), Math.round(y * 0.8)) / 2147483648 - 1);
  const edge = cellEdges(seed ^ 0xc4ac, Math.ceil(width / STONE_SLAB), Math.ceil(height / STONE_SLAB));
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
  return (x, y, out, k, detail) => {
    if (!insideDish(world.dish, x, y)) return;
    const L = smoothLevelAt(world.viscosity, x, y);
    const crack = detail > 0 ? 1 - smoothstep(0.02, 0.07, edge(x / STONE_SLAB, y / STONE_SLAB)) : 0;
    const fine = detail > 0 ? STONE_GRAIN * grain(x, y) - STONE_CRACK * crack : 0;
    const v = STONE_BASE + STONE_MOTTLE * mottle(x, y) + fine * detail;
    // Вода мелеет к отмели и сходит на нет к суше; камень под ней светлее.
    const shallow = smoothstep(0.2, 1.3, L);
    const dry = smoothstep(1.35, 1.75, L);
    const stone = v + STONE_UNDERWATER_LIFT * (1 - dry);
    let r = stone + 6, g = stone + 3, b = stone;
    // Залежи: тёмно-фиолетовый налёт на дне — гуще залежи, плотнее цвет;
    // по нему редкие светлые кристаллы.
    const lode = Math.min(1, smoothstep(DEPOSIT_FROM, DEPOSIT_FULL, depositAt(x, y)));
    if (lode > 0) {
      const speck = detail > 0 ? hash3(seed ^ 0x3a7d, Math.round(x * 1.5), Math.round(y * 1.5)) / 4294967296 : 0.5;
      const crystal = speck < CRYSTAL_SHARE * lode ? CRYSTAL_LIGHT * detail : 0;
      // Неподвижная мелкая фактура отличает залежи от гладкой подвижной дымки.
      const cover = lode * DEPOSIT_MAX * (0.94 + 0.12 * (speck - 0.5) * detail);
      r += (DEPOSIT_COLOR[0] + crystal * 0.9 - r) * cover;
      g += (DEPOSIT_COLOR[1] + crystal * 0.6 - g) * cover;
      b += (DEPOSIT_COLOR[2] + crystal - b) * cover;
    }
    const water = mix(DEEP_WATER, SHALLOW_WATER, shallow);
    // Плотные залежи слегка просвечивают и в глубокой воде.
    const cover = (1 - SHALLOWS_CLARITY * shallow) * (1 - dry) * (1 - 0.24 * lode);
    r += (water[0] - r) * cover;
    g += (water[1] - g) * cover;
    b += (water[2] - b) * cover;
    // Две мягкие полосы следуют полю местности: светлое мелководье снаружи,
    // мокрый камень внутри. Это тон берега, не пена и не дополнительное течение.
    const shoreLight = smoothstep(1.08, 1.3, L) * (1 - smoothstep(1.3, 1.5, L)) * 0.22 * (1 - lode);
    const wet = smoothstep(1.35, 1.53, L) * (1 - smoothstep(1.58, 1.83, L)) * 0.42 * (1 - 0.65 * lode);
    r += (SHORE_LIGHT[0] - r) * shoreLight;
    g += (SHORE_LIGHT[1] - g) * shoreLight;
    b += (SHORE_LIGHT[2] - b) * shoreLight;
    out[k] = r + (WET_SHORE[0] - r) * wet;
    out[k + 1] = g + (WET_SHORE[1] - g) * wet;
    out[k + 2] = b + (WET_SHORE[2] - b) * wet;
    out[k + 3] = 255;
  };
}

/** Кусок местности [x0, x0 + w) × [y0, y0 + h) единиц мира в масштабе `scale`; вне чашки — прозрачно. */
function renderTerrain(sample: Sampler, x0: number, y0: number, pw: number, ph: number, scale: number, dish: Dish): HTMLCanvasElement {
  return finishCalculation(renderTerrainTask(sample, x0, y0, pw, ph, scale, dish));
}

function* renderTerrainTask(sample: Sampler, x0: number, y0: number, pw: number, ph: number, scale: number, dish: Dish): Calculation<HTMLCanvasElement> {
  const { width, height } = dish;
  pw = Math.ceil(pw); ph = Math.ceil(ph);
  const c = document.createElement('canvas');
  c.width = pw;
  c.height = ph;
  const tctx = c.getContext('2d')!;
  const img = tctx.createImageData(pw, ph);
  // Уровни кеша фиксированы; между ними камера смешивает уже готовые плитки.
  const detail = smoothstep(TILE_SCALE_MIN, 4, scale);
  for (let j = 0; j < ph; j++) {
    if ((j & 3) === 0) yield;
    const y = y0 + (j + 0.5) / scale;
    if (y < 0 || y >= height) continue;
    for (let i = 0; i < pw; i++) {
      const x = x0 + (i + 0.5) / scale;
      if (x < 0 || x >= width) continue;
      sample(x, y, img.data, (j * pw + i) * 4, detail);
    }
  }
  tctx.putImageData(img, 0, 0);
  return c;
}

export class TerrainLayer {
  /** Местность целиком в самом мелком масштабе — подложка, пока нет плиток. */
  base!: HTMLCanvasElement;
  /** Где вода (альфа), в масштабе 1:4 — строится один раз на мир. */
  waterMask = document.createElement('canvas');
  /** Уровень и залежи, по которым нарисована местность (на сетке минерала). */
  drawnLevel = new Float32Array(0);
  drawnDeposit = new Float32Array(0);
  private world!: World;
  private sample!: Sampler;
  /** Плитки местности: ключ «масштаб:i:j», порядок — давность использования. */
  private readonly tiles = new Map<string, HTMLCanvasElement>();
  private tileWork: { key: string; i: number; j: number; scale: number; task: Calculation<HTMLCanvasElement> } | null = null;
  private deadline = 0;
  private pending = false;
  /** Блоки подложки, ждущие перерисовки, и сколько блоков в строке. */
  private readonly redrawQueue = new Set<number>();
  private redrawCols = 1;
  /** Версия карты вязкости, по которой нарисована местность, и когда перерисована. */
  private version = -1;
  private drawnAt = 0;

  setWorld(world: World): void {
    this.world = world;
    this.pending = false;
    this.sample = terrainSampler(world);
    this.base = renderTerrain(this.sample, 0, 0, world.dish.width * TILE_SCALE_MIN, world.dish.height * TILE_SCALE_MIN, TILE_SCALE_MIN, world.dish);
    this.tiles.clear();
    this.tileWork = null;
    this.waterMask = this.buildWaterMask();
    this.version = world.viscosity.version;
    this.redrawQueue.clear();
    this.drawnLevel = Float32Array.from(world.terrain.applied);
    const per = world.mineral.cell * world.mineral.cell * world.params.mineralStock;
    this.drawnDeposit = Float32Array.from(world.terrain.deposits, (d) => d / per);
  }

  /** Остались недостроенные плитки или блоки — следующий кадр продолжит. */
  get unfinished(): boolean {
    return this.pending || this.redrawQueue.size > 0;
  }

  get queued(): number {
    return this.redrawQueue.size;
  }

  /** Начало кадра: бюджет построения, изменения местности, дорисовка блоков. Возвращает, изменились ли нарисованные уровень и залежи. */
  begin(): boolean {
    this.deadline = performance.now() + TERRAIN_WORK_BUDGET_MS;
    const changed = this.refresh();
    this.drainRedraw();
    return changed;
  }

  /** Дорисовать часть очереди изменившихся блоков подложки — в пределах общего бюджета построения местности. */
  private drainRedraw(): void {
    if (this.redrawQueue.size === 0) return;
    const bctx = this.base.getContext('2d')!;
    const wctx = this.waterMask.getContext('2d')!;
    for (const b of this.redrawQueue) {
      this.redrawQueue.delete(b);
      const x0 = (b % this.redrawCols) * REDRAW_BLOCK, y0 = Math.floor(b / this.redrawCols) * REDRAW_BLOCK;
      const px = REDRAW_BLOCK * TILE_SCALE_MIN;
      bctx.drawImage(renderTerrain(this.sample, x0, y0, px, px, TILE_SCALE_MIN, this.world.dish), x0 * TILE_SCALE_MIN, y0 * TILE_SCALE_MIN);
      wctx.putImageData(this.waterMaskBlock(x0, y0), x0 / WATER_MASK_STEP, y0 / WATER_MASK_STEP);
      if (performance.now() >= this.deadline) break;
    }
  }

  /**
   * Местность изменилась (пересборка из грунта) — перерисовать изменившиеся
   * блоки подложки и маски воды и сбросить задетые плитки. Не чаще раза в
   * TERRAIN_REDRAW_MS: на ускорении пересборки идут часто, а картинка нужна плавная.
   */
  private refresh(): boolean {
    const v = this.world.viscosity.version;
    if (v === this.version) return false;
    const now = performance.now();
    if (now - this.drawnAt < TERRAIN_REDRAW_MS) return false;
    this.version = v;
    this.drawnAt = now;
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
    if (!any) return false;
    this.tileWork = null;
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
    return true;
  }

  /** Нарисовать местность в видимой части: готовые плитки, остальное — из подложки; недостающие достроить. */
  draw(frame: Frame): void {
    const { ctx, camera } = frame;
    const { width, height } = this.world.dish;
    ctx.setTransform(...camera.view());
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.base, 0, 0, width, height);
    const scale = Math.min(TILE_SCALE_MAX, Math.max(TILE_SCALE_MIN, 2 ** Math.ceil(Math.log2(camera.zoom))));
    if (scale <= TILE_SCALE_MIN) { this.pending = false; return; }
    const span = TILE / scale;
    const blend = smoothstep(0, 1, Math.log2(camera.zoom / (scale / 2)));
    const [x0, y0, x1, y1] = camera.visible();
    const i0 = Math.max(0, Math.floor(x0 / span)), i1 = Math.min(Math.ceil(width / span) - 1, Math.floor(x1 / span));
    const j0 = Math.max(0, Math.floor(y0 / span)), j1 = Math.min(Math.ceil(height / span) - 1, Math.floor(y1 / span));
    const missing: [number, number][] = [];
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const key = `${scale}:${i}:${j}`;
        const tile = this.tiles.get(key);
        // Нижний уровень остаётся под верхним: фактура проявляется непрерывно,
        // в том числе при переходе через степень двойки.
        this.drawCoarser(ctx, scale, i, j, span);
        if (tile) {
          this.tiles.delete(key);
          this.tiles.set(key, tile);
          ctx.globalAlpha = blend;
          ctx.drawImage(tile, i * span, j * span, span, span);
          ctx.globalAlpha = 1;
        } else {
          // Пока плитки нет — ближайшая готовая крупнее (мельче масштабом), иначе подложка.
          missing.push([i, j]);
        }
      }
    }
    // Сначала ближние к центру вида.
    const ci = (x0 + x1) / 2 / span, cj = (y0 + y1) / 2 / span;
    missing.sort((a, b) => Math.hypot(a[0] - ci, a[1] - cj) - Math.hypot(b[0] - ci, b[1] - cj));
    if (this.tileWork && (this.tileWork.scale !== scale || this.tileWork.i < i0 || this.tileWork.i > i1 || this.tileWork.j < j0 || this.tileWork.j > j1)) this.tileWork = null;
    let index = 0;
    while (performance.now() < this.deadline) {
      if (!this.tileWork) {
        const next = missing[index++];
        if (!next) break;
        const [i, j] = next;
        const key = `${scale}:${i}:${j}`;
        if (this.tiles.has(key)) continue;
        this.tileWork = { key, i, j, scale, task: renderTerrainTask(this.sample, i * span, j * span, TILE, TILE, scale, this.world.dish) };
      }
      const result = this.tileWork.task.next();
      if (!result.done) continue;
      const { key, i, j } = this.tileWork;
      this.tiles.set(key, result.value);
      ctx.globalAlpha = blend;
      ctx.drawImage(result.value, i * span, j * span, span, span);
      ctx.globalAlpha = 1;
      this.tileWork = null;
    }
    this.pending = !!this.tileWork || missing.some(([i, j]) => !this.tiles.has(`${scale}:${i}:${j}`));
    while (this.tiles.size > TILE_CACHE) this.tiles.delete(this.tiles.keys().next().value!);
  }

  private drawCoarser(ctx: CanvasRenderingContext2D, scale: number, i: number, j: number, span: number): void {
    for (let s = scale / 2, k = 2; s > TILE_SCALE_MIN; s /= 2, k *= 2) {
      const tile = this.tiles.get(`${s}:${Math.floor(i / k)}:${Math.floor(j / k)}`);
      if (!tile) continue;
      const part = TILE / k;
      ctx.drawImage(tile, (i % k) * part, (j % k) * part, part, part, i * span, j * span, span, span);
      return;
    }
  }

  /** Маска воды для бликов: непрозрачна в воде, гаснет к отмели, пуста на суше и перегородках. */
  private buildWaterMask(): HTMLCanvasElement {
    const { width, height } = this.world.dish;
    const c = document.createElement('canvas');
    c.width = width / WATER_MASK_STEP;
    c.height = height / WATER_MASK_STEP;
    const mctx = c.getContext('2d')!;
    for (let y0 = 0; y0 < height; y0 += REDRAW_BLOCK) {
      for (let x0 = 0; x0 < width; x0 += REDRAW_BLOCK) mctx.putImageData(this.waterMaskBlock(x0, y0), x0 / WATER_MASK_STEP, y0 / WATER_MASK_STEP);
    }
    return c;
  }

  /** Кусок маски воды для блока REDRAW_BLOCK × REDRAW_BLOCK с углом (x0, y0). */
  private waterMaskBlock(x0: number, y0: number): ImageData {
    const { width, height } = this.world.dish;
    const step = WATER_MASK_STEP;
    const n = REDRAW_BLOCK / step;
    const img = new ImageData(n, n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = x0 + (i + 0.5) * step, y = y0 + (j + 0.5) * step;
        const inside = x < width && y < height;
        const water = !inside || isBlocked(this.world.partitions, x, y) ? 0 : 1 - smoothstep(1.1, 1.65, smoothLevelAt(this.world.viscosity, x, y));
        const k = (j * n + i) * 4;
        img.data[k] = img.data[k + 1] = img.data[k + 2] = 255;
        img.data[k + 3] = water * 255;
      }
    }
    return img;
  }
}
