/**
 * Мир: параметры, номер шага и состояние — свет, минерал, местность. Стартовую
 * картину строит из сида генератор.
 */
import { finishCalculation, type Calculation } from './task.ts';
import { phase } from './profile.ts';
import { dishOf, type Dish } from './dish.ts';
import { mix32 } from './prng.ts';
import { type WorldParams, isLaw, validateParams } from './params.ts';
import { setMediumLaws } from './laws.ts';
import { type LightMap, advanceLight, createLightMap, lightAt, setLightLaws } from './light.ts';
import { type ViscosityMap, createViscosityMap } from './viscosity.ts';
import { type PartitionLayout, buildLayout, layoutForSeed } from './partitions.ts';
import { Drift } from './drift.ts';
import { MINERAL_CELL, MINERAL_PERIOD, TERRAIN_PERIOD } from './constants.ts';
import { createTerrain, levelFromGround, rescheduleMoves, type TerrainState } from './terrain.ts';
import { applyLevels, applyLevelsTask } from './viscosity.ts';
import { createMineral, transparencyAt, updateMineralTask, volcanoNumbers, funnelNumbers, type MineralState } from './mineral.ts';

export interface World {
  readonly dish: Dish;
  readonly params: Readonly<WorldParams>;
  /** Возраст мира — число прошедших шагов, отсчёт с нуля. */
  step: number;
  /** Пятна света, дрейф и ритм — состояние, меняется по шагам. */
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
  setMediumLaws(own);
  const viscosity = createViscosityMap(own);
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
 * Сменить законы живого мира (спецификация, «Слои параметров»): берутся
 * только законы из `next`, содержимое остаётся прежним. Состояние
 * продолжается — фазы ритма и дрейфа копятся по шагам, поэтому скачков нет;
 * запланированное (поворот дрейфа, подвижка, порог извержения) пересчитывается
 * под новые законы. Возвращает причины отказа, если сочетание неверно.
 */
export function setWorldLaws(world: World, next: WorldParams): string[] {
  const merged = { ...world.params };
  for (const key of Object.keys(next) as (keyof WorldParams)[]) if (isLaw(key)) (merged as Record<string, unknown>)[key] = next[key];
  const errors = validateParams(merged);
  if (errors.length > 0) return errors;
  const before = world.params;
  const pressure = before.eruptionPressure, volume = before.tectonicVolume;
  // Снос и минерал читают тот же объект параметров: меняем его на месте.
  Object.assign(before, merged);
  setMediumLaws(before);
  setLightLaws(world.light, before);
  if (before.tectonicVolume !== volume) rescheduleMoves(world.terrain, before, world.step);
  if (before.eruptionPressure !== pressure && pressure > 0) world.mineral.threshold *= before.eruptionPressure / pressure;
  return [];
}

/**
 * Один шаг мира. Сдвиг карты света и снос — функции номера шага; минерал —
 * состояние, обновляется раз в MINERAL_PERIOD шагов. Ходы существ появятся позже.
 */
export function stepWorld(world: World): void {
  if ((world.step + 1) % MINERAL_PERIOD !== 0) { world.step++; advanceLight(world.light, world.step); return; }
  finishCalculation(stepWorldTask(world));
}

/** Пока задача не завершена, массивы промежуточные: их нельзя показывать или сохранять. */
export function* stepWorldTask(world: World): Calculation {
  const step = world.step + 1;
  advanceLight(world.light, step);
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

/** Числа параметров в порядке ключей: строки — по символам, вложенные объекты — по их полям. */
function paramNumbers(p: Readonly<WorldParams>): number[] {
  const out: number[] = [];
  const add = (v: unknown) => {
    if (typeof v === 'number') out.push(v);
    else if (typeof v === 'string') for (const ch of v) out.push(ch.charCodeAt(0));
    else if (v && typeof v === 'object') for (const key of Object.keys(v).sort()) add((v as Record<string, unknown>)[key]);
  };
  add(p);
  return out;
}

/** Состояние света числами: дрейф, ритм, пятна. */
export function lightNumbers(l: LightMap): number[] {
  return [
    l.step, l.offsetX, l.offsetY, l.angle, l.turnFrom, l.turnTo, l.turnStart, Number.isFinite(l.nextTurn) ? l.nextTurn : -1, l.turns, l.rhythmPhase, l.breathPhase,
    l.spots.length, ...l.spots.flatMap((s) => [s.x, s.y, s.r, ...s.amps, ...s.phases, ...s.rates]),
  ];
}

/** Контрольная сумма состояния: одинаковые миры дают одинаковую сумму. */
export function worldHash(world: World): number {
  return hashNumbers([
    ...paramNumbers(world.params), world.dish.width, world.dish.height,
    world.step,
    ...lightNumbers(world.light),
    world.mineral.depths,
    ...world.terrain.ground,
    ...world.terrain.deposits,
    ...world.terrain.applied,
    world.terrain.nextMove, world.terrain.nextMoveStep, world.terrain.debt,
    ...world.terrain.active.flatMap((m) => [m.n, m.start, m.amp]),
    world.mineral.threshold, world.mineral.eruptions, world.mineral.genesis ? 1 : 0,
    world.mineral.births, world.mineral.volcanoes.length,
    ...world.mineral.volcanoes.flatMap(volcanoNumbers),
    world.mineral.funnelBirths, world.mineral.funnels.length,
    ...world.mineral.funnels.flatMap(funnelNumbers),
    ...world.mineral.field,
  ]);
}
