/**
 * Градиентный шум с сомкнутыми краями: значение повторяется с периодом
 * по обеим осям. Нужен для карт, у которых края сомкнуты (карта света),
 * и для плавных полей (карта вязкости).
 */
import { hash3 } from './prng.ts';

export type Noise2 = (x: number, y: number) => number;

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/**
 * Периодический шум Перлина. Решётка — `cellsX × cellsY` ячеек, координаты
 * в ячейках: шум(x + cellsX, y) = шум(x, y). Значения примерно в [-1, 1].
 */
export function periodicNoise(seed: number, cellsX: number, cellsY: number): Noise2 {
  const gradient = (ix: number, iy: number, dx: number, dy: number): number => {
    const h = hash3(seed, mod(ix, cellsX), mod(iy, cellsY));
    const angle = (h / 4294967296) * Math.PI * 2;
    return Math.cos(angle) * dx + Math.sin(angle) * dy;
  };
  return (x, y) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const u = fade(fx);
    const v = fade(fy);
    const n00 = gradient(x0, y0, fx, fy);
    const n10 = gradient(x0 + 1, y0, fx - 1, fy);
    const n01 = gradient(x0, y0 + 1, fx, fy - 1);
    const n11 = gradient(x0 + 1, y0 + 1, fx - 1, fy - 1);
    const a = n00 + (n10 - n00) * u;
    const b = n01 + (n11 - n01) * u;
    return (a + (b - a) * v) * Math.SQRT2;
  };
}

/**
 * Сумма октав периодического шума (fBm). Каждая октава вдвое мельче и сохраняет
 * период, так что сумма тоже с сомкнутыми краями. Результат нормирован в ~[-1, 1].
 */
export function periodicFbm(seed: number, cellsX: number, cellsY: number, octaves: number): Noise2 {
  const layers: Noise2[] = [];
  for (let o = 0; o < octaves; o++) {
    layers.push(periodicNoise(hash3(seed, o, 7919), cellsX << o, cellsY << o));
  }
  let norm = 0;
  for (let o = 0; o < octaves; o++) norm += 1 / (1 << o);
  return (x, y) => {
    let sum = 0;
    for (let o = 0; o < octaves; o++) {
      const k = 1 << o;
      sum += layers[o](x * k, y * k) / k;
    }
    return sum / norm;
  };
}
