/**
 * Мир: параметры + номер шага. Всё остальное строится из сида детерминированно.
 */
import { DISH_HEIGHT, DISH_WIDTH } from './constants.ts';
import { mix32 } from './prng.ts';
import { type WorldParams, validateParams } from './params.ts';
import { type LightMap, createLightMap, lightAt } from './light.ts';
import { type ViscosityMap, createViscosityMap } from './viscosity.ts';
import { type PartitionLayout, buildLayout, layoutForSeed } from './partitions.ts';
import { Drift } from './drift.ts';
import { MINERAL_CELL, MINERAL_PERIOD, TERRAIN_PERIOD } from './constants.ts';
import { createTerrain, levelFromGround, type TerrainState } from './terrain.ts';
import { applyLevels } from './viscosity.ts';
import { createMineral, transparencyAt, updateMineral, volcanoNumbers, type MineralState } from './mineral.ts';

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
  /** Местность: грунт, снимок уровня, подвижки — состояние, меняется по шагам. */
  readonly terrain: TerrainState;
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
  const mineral = createMineral(own, partitions);
  const terrain = createTerrain(own, viscosity, mineral.cols, mineral.rows, mineral.cell, mineral.blocked);
  // С самого начала карта собрана из уровня грунта — как и после каждой пересборки.
  applyLevels(viscosity, terrain.applied, mineral.cols, mineral.rows, mineral.cell);
  return {
    params: own, step: 0, light, viscosity, partitions,
    drift: new Drift({ params: own, light, viscosity, partitions }),
    mineral,
    terrain,
  };
}

/**
 * Один шаг мира. Сдвиг карты света и снос — функции номера шага; минерал —
 * состояние, обновляется раз в MINERAL_PERIOD шагов. Ходы существ появятся позже.
 */
export function stepWorld(world: World): void {
  world.step++;
  // Снос, осаждение и извержения минерала — раз в MINERAL_PERIOD шагов, за весь промежуток.
  if (world.step % MINERAL_PERIOD === 0) {
    updateMineral(world.mineral, world.params, world.drift, world.partitions, world.terrain, world.light, world.step);
  }
  // Местность пересобирается из грунта: карта вязкости, затем течения.
  if (world.step % TERRAIN_PERIOD === 0) applyTerrain(world, levelFromGround(world.terrain, MINERAL_CELL));
}

/** Собрать карту вязкости по снимку уровня и забыть течения, посчитанные по старой местности. */
export function applyTerrain(world: World, level: Float32Array): void {
  world.terrain.applied = level;
  applyLevels(world.viscosity, level, world.mineral.cols, world.mineral.rows, world.mineral.cell);
  world.drift.reset();
}

/** Свет, доходящий до места: свет карты при текущем солнце × прозрачность (мутность от минерала). */
export function worldLightAt(world: World, x: number, y: number): number {
  return lightAt(world.light, x, y, world.step) * transparencyAt(world.mineral, x, y);
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
    p.seed, DISH_WIDTH, DISH_HEIGHT, p.sun, p.lightDrift, p.sunRhythm, p.sunPeriod, p.backgroundLevel, p.illumination, p.spotSize,
    p.baseTemperature, p.spotHeat,
    p.viscosityShares.water, p.viscosityShares.shallows, p.viscosityShares.land,
    p.viscosityZoneSize, p.mineralStock, p.terrainSpeed, p.quakeInterval,
    world.step,
    world.mineral.depths,
    ...world.terrain.ground,
    ...world.terrain.deposits,
    ...world.terrain.applied,
    world.terrain.nextMove, world.terrain.nextMoveStep, world.terrain.nextQuake, world.terrain.nextQuakeStep,
    ...world.terrain.active.flatMap((m) => [m.n, m.quake ? 1 : 0, m.start]),
    world.mineral.threshold, world.mineral.eruptions, world.mineral.genesis ? 1 : 0,
    world.mineral.births, world.mineral.volcanoes.length,
    ...world.mineral.volcanoes.flatMap(volcanoNumbers),
    ...world.mineral.field,
  ]);
}
