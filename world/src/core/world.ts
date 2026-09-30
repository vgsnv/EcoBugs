/**
 * Мир: параметры + номер шага. Всё остальное строится из сида детерминированно.
 */
import { mix32 } from './prng.ts';
import { type WorldParams, validateParams } from './params.ts';
import { type LightMap, createLightMap } from './light.ts';
import { type ViscosityMap, createViscosityMap } from './viscosity.ts';

export interface World {
  readonly params: Readonly<WorldParams>;
  /** Возраст мира — число прошедших шагов, отсчёт с нуля. */
  step: number;
  /** Карта света; строится из сида, движение — функция номера шага. */
  readonly light: LightMap;
  /** Карта вязкости; строится из сида и не меняется. */
  readonly viscosity: ViscosityMap;
}

export class InvalidParamsError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`Неверные параметры мира:\n${errors.join('\n')}`);
    this.errors = errors;
  }
}

export function createWorld(params: WorldParams): World {
  const errors = validateParams(params);
  if (errors.length > 0) throw new InvalidParamsError(errors);
  const own = structuredClone(params);
  return { params: own, step: 0, light: createLightMap(own), viscosity: createViscosityMap(own) };
}

/**
 * Один шаг мира. Сдвиг карты света — функция номера шага, поэтому здесь
 * достаточно увеличить возраст. Ходы существ появятся позже.
 */
export function stepWorld(world: World): void {
  world.step++;
}

/** Хеш произвольных чисел в порядке перечисления. */
export function hashNumbers(values: Iterable<number>): number {
  const buf = new Float64Array(1);
  const words = new Uint32Array(buf.buffer);
  let h = 0x2545f491;
  for (const v of values) {
    buf[0] = v;
    h = mix32(h ^ words[0]);
    h = mix32(h ^ words[1]);
  }
  return h >>> 0;
}

/** Контрольная сумма состояния: одинаковые миры дают одинаковую сумму. */
export function worldHash(world: World): number {
  const p = world.params;
  return hashNumbers([
    p.seed, p.width, p.height, p.sun, p.backgroundLevel, p.illumination, p.spotSize,
    p.baseTemperature, p.spotHeat, p.baseViscosity,
    p.viscosityShares.water, p.viscosityShares.shallows, p.viscosityShares.land,
    p.viscosityZoneSize, [...p.layout].reduce((a, c) => a * 31 + c.charCodeAt(0), 7),
    world.step,
  ]);
}
