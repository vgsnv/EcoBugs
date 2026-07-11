/**
 * Балансный конфиг. Значения подобраны ЭМПИРИЧЕСКИ в браузерном прототипе
 * (core/prototype/aquarium.html) — при них мир не вымирает и не взрывается.
 * Не крути наугад: экономика энергии хрупкая, балансировка — самая дорогая
 * часть проекта (см. PLAN.md §7, Фаза 0).
 */
import type { WorldGenesis, WorldConfig, GenePool } from './types.ts';
import { DEFAULT_GENE_POOL } from './genome.ts';

/** Параметры творения по умолчанию для заданного сида (и опционально генофонда). */
export function defaultGenesis(seed: number, genePool: GenePool = DEFAULT_GENE_POOL): WorldGenesis {
  return {
    seed,
    width: 600,
    height: 600,
    cellSize: 30,
    maxFood: 1200,
    startPopulation: 120,
    genePool: { ...genePool },
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
