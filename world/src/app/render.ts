/**
 * Отрисовка мира на холст: поле выбранного слоя в пониженном разрешении,
 * перегородки — поверх в полном. Вязкость не меняется, её картинка строится
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

  setWorld(world: World): void {
    this.world = world;
    const { width, height } = world.params;
    this.canvas.width = width;
    this.canvas.height = height;
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
    ctx.imageSmoothingEnabled = layer === 'viscosity';
    ctx.drawImage(this.buffer, 0, 0, p.width, p.height);
    if (showPartitions) {
      ctx.strokeStyle = '#0d1117';
      ctx.lineWidth = w.partitions.thickness;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const part of w.partitions.partitions) {
        ctx.beginPath();
        part.points.forEach(([x, y], k) => (k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
        ctx.stroke();
      }
    }
  }
}
