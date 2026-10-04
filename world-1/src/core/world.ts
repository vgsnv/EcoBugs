/**
 * Мир: параметры + номер шага. Всё остальное строится из сида детерминированно.
 */
import { finishCalculation, type Calculation } from './task.ts';
import { phase } from './profile.ts';
import { dishOf, type Dish } from './dish.ts';
import { mix32 } from './prng.ts';
import { type WorldParams, validateParams } from './params.ts';
import { type LightMap, createLightMap, lightAt } from './light.ts';
import { type ViscosityMap, createViscosityMap } from './viscosity.ts';
import { type PartitionLayout, buildLayout, layoutForSeed } from './partitions.ts';
import { Drift } from './drift.ts';
import { MINERAL_CELL, MINERAL_PERIOD, TERRAIN_PERIOD } from './constants.ts';
import { createTerrain, levelFromGround, type TerrainState } from './terrain.ts';
import { applyLevels, applyLevelsTask } from './viscosity.ts';
import { createMineral, transparencyAt, updateMineralTask, volcanoNumbers, funnelNumbers, type MineralState } from './mineral.ts';

export interface World {
  readonly dish: Dish;
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

export function createWorld(params: WorldParams, restoring = false): World {
  const errors = validateParams(params);
  if (errors.length > 0) throw new InvalidParamsError(errors);
  const own = structuredClone(params);
  const viscosity = createViscosityMap(own, !restoring);
  const light = createLightMap(own);
  const dish = dishOf(own);
  const partitions = buildLayout(layoutForSeed(own.seed), dish);
  const mineral = createMineral(own, partitions);
  const terrain = createTerrain(own, viscosity, mineral.cols, mineral.rows, mineral.cell, mineral.blocked);
  // С самого начала карта собрана из уровня грунта — как и после каждой пересборки.
  applyLevels(viscosity, terrain.applied, mineral.cols, mineral.rows, mineral.cell);
  return {
    dish, params: own, step: 0, light, viscosity, partitions,
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
  if ((world.step + 1) % MINERAL_PERIOD !== 0) { world.step++; return; }
  finishCalculation(stepWorldTask(world));
}

/** Пока задача не завершена, массивы промежуточные: их нельзя показывать или сохранять. */
export function* stepWorldTask(world: World): Calculation {
  const step = world.step + 1;
  if (step % MINERAL_PERIOD === 0) {
    yield* updateMineralTask(world.mineral, world.params, world.drift, world.partitions, world.terrain, world.light, step);
  }
  if (step % TERRAIN_PERIOD === 0) {
    phase('смена местности');
    const level = levelFromGround(world.terrain, MINERAL_CELL);
    yield* applyLevelsTask(world.viscosity, level, world.mineral.cols, world.mineral.rows, world.mineral.cell);
    world.terrain.applied = level;
    world.drift.reset();
    phase(null);
  }
  world.step = step;
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

/**
 * Снос в точке на текущем шаге: течения от света плюс течения от вулканов и
 * воронок (из жерла и в воронку) — то, что несёт всё в чашке.
 */
export function flowAt(world: World, x: number, y: number, out: [number, number] = [0, 0]): [number, number] {
  world.drift.at(x, y, world.step, out);
  const m = world.mineral;
  if (m.flow) {
    const i = Math.min(m.cols - 1, Math.max(0, Math.floor(x / m.cell)));
    const j = Math.min(m.rows - 1, Math.max(0, Math.floor(y / m.cell)));
    out[0] += m.flow.vx[j * m.cols + i];
    out[1] += m.flow.vy[j * m.cols + i];
  }
  return out;
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
export function worldHash(world: World, legacyV18 = false): number {
  const p = world.params;
  return hashNumbers([
    p.seed, world.dish.width, world.dish.height,
    ...(legacyV18 ? [] : [p.shape === 'circle' ? 1 : 0, p.aspectRatio]), p.sun, p.lightDrift, p.sunRhythm, p.sunPeriod, p.backgroundLevel, p.illumination, p.spotSize,
    p.baseTemperature, p.spotHeat,
    p.viscosityShares.water, p.viscosityShares.shallows, p.viscosityShares.land,
    p.viscosityZoneSize, p.mineralStock, p.terrainSpeed, p.quakeInterval,
    world.step,
    world.mineral.depths,
    ...world.terrain.ground,
    ...world.terrain.deposits,
    ...world.terrain.applied,
    world.terrain.nextMove, world.terrain.nextMoveStep, world.terrain.nextQuake, world.terrain.nextQuakeStep, world.terrain.debt,
    ...world.terrain.active.flatMap((m) => [m.n, m.quake ? 1 : 0, m.start]),
    world.mineral.threshold, world.mineral.eruptions, world.mineral.genesis ? 1 : 0,
    world.mineral.births, world.mineral.volcanoes.length,
    ...world.mineral.volcanoes.flatMap(volcanoNumbers),
    world.mineral.funnelBirths, world.mineral.funnels.length,
    ...world.mineral.funnels.flatMap(funnelNumbers),
    ...world.mineral.field,
  ]);
}
