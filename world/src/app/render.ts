/**
 * Отрисовка мира на холст: поле выбранного слоя в пониженном разрешении,
 * вокруг — стена чашки, поверх — перегородки тем же стилем, что и стена. Вязкость не меняется, её картинка строится
 * один раз на мир.
 */
import {
  lightFromIntensity, rasterizeSpotIntensity, rasterizeTemperature, smoothLevelAt, type World,
} from '../core/index.ts';

export type Layer = 'light' | 'temperature' | 'viscosity';

export const LAYER_NAMES: Record<Layer, string> = {
  light: 'Свет',
  temperature: 'Температура',
  viscosity: 'Вязкость',
};

/** Размер ячейки отрисовки полей, единиц мира. */
const CELL = 4;

/** Стекло стен и перегородок: полупрозрачная заливка, светлая кромка, лёгкая тень. */
const GLASS_FILL = 'rgba(190, 225, 255, 0.22)';
const GLASS_GLOSS_FROM = 'rgba(205, 228, 245, 0.85)';
const GLASS_GLOSS_TO = 'rgba(150, 190, 222, 0.45)';
const GLASS_EDGE = 'rgba(255, 255, 255, 0.9)';
const GLASS_SHADOW = 'rgba(30, 55, 80, 0.65)';

type Rgb = readonly [number, number, number];
const VISC_COLORS: readonly Rgb[] = [[25, 70, 150], [60, 160, 165], [170, 135, 80]];
const COLD: Rgb = [40, 70, 200];
const WARM: Rgb = [255, 120, 40];

/** Свет → яркость пикселя 0…1: экспоненциальное насыщение, одинаковое для всех миров. */
export function lightTone(light: number): number {
  return 1 - Math.exp(-1.1 * light);
}

function mix(a: Rgb, b: Rgb, u: number): Rgb {
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}

export class WorldRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly buffer = document.createElement('canvas');
  private readonly bctx: CanvasRenderingContext2D;
  private world!: World;
  private cols = 0;
  private rows = 0;
  private image!: ImageData;
  private intensity: Float32Array = new Float32Array(0);
  private temperature: Float32Array = new Float32Array(0);
  private viscosityImage!: ImageData;

  private readonly canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.bctx = this.buffer.getContext('2d')!;
  }

  /** Толщина стены вокруг чашки на холсте — как у перегородок. */
  private wall = 0;

  setWorld(world: World): void {
    this.world = world;
    const { width, height } = world.params;
    this.wall = world.partitions.thickness;
    this.canvas.width = width + 2 * this.wall;
    this.canvas.height = height + 2 * this.wall;
    this.cols = Math.ceil(width / CELL);
    this.rows = Math.ceil(height / CELL);
    this.buffer.width = this.cols;
    this.buffer.height = this.rows;
    this.image = this.bctx.createImageData(this.cols, this.rows);
    this.intensity = new Float32Array(this.cols * this.rows);
    this.temperature = new Float32Array(this.cols * this.rows);
    this.viscosityImage = this.buildViscosityImage();
  }

  private buildViscosityImage(): ImageData {
    const img = this.bctx.createImageData(this.cols, this.rows);
    for (let k = 0; k < this.cols * this.rows; k++) {
      const x = ((k % this.cols) + 0.5) * CELL;
      const y = (Math.floor(k / this.cols) + 0.5) * CELL;
      const l = smoothLevelAt(this.world.viscosity, x, y);
      const c = l <= 1 ? mix(VISC_COLORS[0], VISC_COLORS[1], l) : mix(VISC_COLORS[1], VISC_COLORS[2], l - 1);
      img.data.set([c[0], c[1], c[2], 255], k * 4);
    }
    return img;
  }

  draw(layer: Layer, showPartitions: boolean): void {
    const w = this.world;
    const p = w.params;
    if (layer === 'viscosity') {
      this.bctx.putImageData(this.viscosityImage, 0, 0);
    } else {
      this.intensity = rasterizeSpotIntensity(w.light, w.step, this.cols, this.rows, CELL, this.intensity);
      const data = this.image.data;
      if (layer === 'light') {
        // Абсолютная шкала с мягким насыщением: яркость солнца видна глазами.
        for (let k = 0; k < this.intensity.length; k++) {
          const c = lightTone(lightFromIntensity(w.light, this.intensity[k])) * 255;
          data[k * 4] = c;
          data[k * 4 + 1] = c;
          data[k * 4 + 2] = c * 0.8;
          data[k * 4 + 3] = 255;
        }
      } else {
        this.temperature = rasterizeTemperature(p, w.light, w.step, this.cols, this.rows, CELL, this.intensity, this.temperature);
        const span = p.spotHeat || 1;
        for (let k = 0; k < this.temperature.length; k++) {
          const c = mix(COLD, WARM, (this.temperature[k] - p.baseTemperature) / span);
          data[k * 4] = c[0];
          data[k * 4 + 1] = c[1];
          data[k * 4 + 2] = c[2];
          data[k * 4 + 3] = 255;
        }
      }
      this.bctx.putImageData(this.image, 0, 0);
    }

    const ctx = this.ctx;
    const W = this.wall;
    ctx.imageSmoothingEnabled = layer === 'viscosity';
    ctx.drawImage(this.buffer, W, W, p.width, p.height);
    this.drawWalls(showPartitions);
  }

  /** Стена вокруг чашки и перегородки: одна заливка, одна обводка. */
  private drawWalls(showPartitions: boolean): void {
    const ctx = this.ctx;
    const W = this.wall;
    const { width, height } = this.world.params;
    ctx.clearRect(0, 0, width + 2 * W, W);
    ctx.clearRect(0, height + W, width + 2 * W, W);
    ctx.clearRect(0, 0, W, height + 2 * W);
    ctx.clearRect(width + W, 0, W, height + 2 * W);
    const solid = new Path2D();
    // Обод чашки: внешний прямоугольник минус внутренний (правило even-odd),
    // стекло с бликом — светлее к верхнему левому углу.
    solid.rect(0, 0, width + 2 * W, height + 2 * W);
    solid.rect(W, W, width, height);
    const gloss = ctx.createLinearGradient(0, 0, width + 2 * W, height + 2 * W);
    gloss.addColorStop(0, GLASS_GLOSS_FROM);
    gloss.addColorStop(0.5, GLASS_GLOSS_TO);
    gloss.addColorStop(1, GLASS_GLOSS_FROM);
    ctx.fillStyle = gloss;
    ctx.fill(solid, 'evenodd');
    if (showPartitions) {
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
    }
    this.outline(showPartitions);
  }

  /**
   * Кромка стекла: внешний край обода и граница между свободными ячейками
   * чашки и занятыми (стена или перегородка). Стыки перегородок со стеной и
   * между собой поэтому не обводятся.
   */
  private outline(showPartitions: boolean): void {
    const ctx = this.ctx;
    const W = this.wall;
    const { width, height } = this.world.params;
    const lay = this.world.partitions;
    const c = lay.cell;
    const solid = (i: number, j: number) =>
      i < 0 || j < 0 || i >= lay.cols || j >= lay.rows || (showPartitions && lay.blocked[j * lay.cols + i] === 1);
    ctx.lineWidth = 1;
    ctx.strokeStyle = GLASS_EDGE;
    ctx.strokeRect(0.5, 0.5, width + 2 * W - 1, height + 2 * W - 1);
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
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.strokeStyle = GLASS_EDGE;
    ctx.lineWidth = 0.75;
    ctx.stroke();
  }

  /** Координаты мира по точке экрана; вне чашки — null. */
  toWorld(clientX: number, clientY: number): [number, number] | null {
    const rect = this.canvas.getBoundingClientRect();
    const scale = this.canvas.width / rect.width;
    const x = (clientX - rect.left) * scale - this.wall;
    const y = (clientY - rect.top) * scale - this.wall;
    const { width, height } = this.world.params;
    return x >= 0 && y >= 0 && x < width && y < height ? [x, y] : null;
  }
}
