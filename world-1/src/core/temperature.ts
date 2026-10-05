/**
 * Температура (спецификация, раздел «Температура»): определяется светом в той же
 * точке, мгновенно, не растекается. На фоне — базовая, в пятне — базовая плюс
 * нагрев, на краю пятна — промежуточная. Солнце на температуру не влияет:
 * она зависит от того, пятно здесь или фон, а не от абсолютной яркости.
 */
import type { WorldParams } from './params.ts';
import { type LightMap, rasterizeSpotIntensity, spotIntensityAt } from './light.ts';

/** Температура по интенсивности пятна в точке (0 — фон, 1 — пятно). */
export function temperatureFromIntensity(params: Pick<WorldParams, 'baseTemperature' | 'spotHeat'>, intensity: number): number {
  return params.baseTemperature + params.spotHeat * Math.min(1, intensity);
}

export function temperatureAt(params: WorldParams, light: LightMap, x: number, y: number, t: number): number {
  return temperatureFromIntensity(params, spotIntensityAt(light, x, y, t));
}

/**
 * Сила мутаций места — единственное свойство, которое задаёт температура.
 * Пока равна температуре; всегда больше нуля, потому что базовая температура > 0.
 */
export function mutationStrength(temperature: number): number {
  return temperature;
}

/** Поле температуры на сетке чашки — из поля интенсивности пятен или заново. */
export function rasterizeTemperature(params: WorldParams, light: LightMap, t: number, cols: number, rows: number, cell: number, intensity?: Float32Array, out?: Float32Array): Float32Array {
  const source = intensity ?? rasterizeSpotIntensity(light, t, cols, rows, cell);
  const field = out && out.length === source.length ? out : new Float32Array(source.length);
  for (let k = 0; k < source.length; k++) field[k] = temperatureFromIntensity(params, source[k]);
  return field;
}
