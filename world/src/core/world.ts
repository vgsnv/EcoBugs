/**
 * Мир: параметры + номер шага. Всё остальное строится из сида детерминированно.
 */
import { DISH_HEIGHT, DISH_WIDTH } from './constants.ts';
import { mix32 } from './prng.ts';
import { type WorldParams, validateParams } from './params.ts';
import { type LightMap, createLightMap } from './light.ts';
import { type ViscosityMap, createViscosityMap } from './viscosity.ts';
import { type PartitionLayout, buildLayout, layoutForSeed } from './partitions.ts';
import { Drift } from './drift.ts';
import { MINERAL_PERIOD } from './constants.ts';
import { createMineral, updateMineral, type MineralState } from './mineral.ts';

export interface World {
  readonly params: Readonly<WorldParams>;
  /** Возраст мира — число прошедших шагов, отсчёт с нуля. */
  step: number;
  /** Карта света; строится из сида, движение — функция номера шага. */
  readonly light: LightMap;
  /** Карта вязкости; строится из сида и не меняется. */
  readonly viscosity: ViscosityMap;
  /** Перегородки по выбранной заготовке; не меняются. */
  readonly partitions: PartitionLayout;
  /** Снос: течения от пятен света; функция номера шага. */
  readonly drift: Drift;
  /** Минерал в среде и недрах, вулканы — состояние, меняется по шагам. */
  readonly mineral: MineralState;
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
  const light = createLightMap(own);
  const viscosity = createViscosityMap(own);
  const partitions = buildLayout(layoutForSeed(own.seed), DISH_WIDTH, DISH_HEIGHT);
  return {
    params: own, step: 0, light, viscosity, partitions,
    drift: new Drift({ params: own, light, viscosity, partitions }),
    mineral: createMineral(own, partitions),
  };
}

/**
 * Один шаг мира. Сдвиг карты света и снос — функции номера шага; минерал —
 * состояние, обновляется раз в MINERAL_PERIOD шагов. Ходы существ появятся позже.
 */
export function stepWorld(world: World): void {
  world.step++;
  // Снос, осаждение и извержения минерала — раз в MINERAL_PERIOD шагов, за весь промежуток.
  if (world.step % MINERAL_PERIOD === 0) updateMineral(world.mineral, world.params, world.drift, world.partitions, world.step);
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
    p.seed, DISH_WIDTH, DISH_HEIGHT, p.sun, p.backgroundLevel, p.illumination, p.spotSize,
    p.baseTemperature, p.spotHeat, p.baseViscosity,
    p.viscosityShares.water, p.viscosityShares.shallows, p.viscosityShares.land,
    p.viscosityZoneSize, p.driftStrength, p.mineralStock, p.volcanoCount, p.eruptionInterval,
    world.step,
    world.mineral.depths,
    ...world.mineral.volcanoes.flatMap((v) => [v.k, v.next]),
    ...world.mineral.field,
  ]);
}
