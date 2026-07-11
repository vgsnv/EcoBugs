/**
 * Балансный конфиг. Значения подобраны ЭМПИРИЧЕСКИ в браузерном прототипе
 * (core/prototype/aquarium.html) — при них мир не вымирает и не взрывается.
 * Не крути наугад: экономика энергии хрупкая, балансировка — самая дорогая
 * часть проекта (см. PLAN.md §7, Фаза 0).
 */
import type { WorldGenesis, WorldConfig } from './types.ts';

/** Параметры творения по умолчанию для заданного сида. */
export function defaultGenesis(seed: number): WorldGenesis {
  return {
    seed,
    width: 600,
    height: 600,
    cellSize: 30,
    maxFood: 1200,
    startPopulation: 120,
  };
}

/** Живой конфиг среды по умолчанию (сбалансирован в прототипе). */
export function defaultConfig(): WorldConfig {
  return {
    sunlight: 6,
    foodEnergy: 32,
    nutrition: 1,
    baseCost: 0.18,
    moveCost: 0.3,
    temperature: 1,
  };
}
