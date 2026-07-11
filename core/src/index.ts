/**
 * Публичный API ядра. RN-слой (core/rn/) импортирует симуляцию ТОЛЬКО отсюда,
 * чтобы внутренняя структура ядра могла меняться без правок в UI.
 *
 * ⛔ В обратную сторону импортов нет: ядро headless и ничего не знает про RN/Skia.
 */
export { World } from './world.ts';
export type { Creature, Stats } from './world.ts';

export { Gene, GENE_COUNT, GENE_BOUNDS, randomGenome, mutate } from './genome.ts';
export type { Genome, BrainGenome } from './genome.ts';

export { RuleBrain, NeatBrain } from './brain.ts';
export type { Brain, Sensors, Decision } from './brain.ts';

export { NeatContext, Network, seedGenome, mutateBrain, brainComplexity, NUM_INPUTS, NUM_OUTPUTS } from './neat.ts';
export type { NeatGenome, NodeGene, ConnGene, NodeType } from './neat.ts';

export { PRNG } from './prng.ts';
export { SpatialGrid } from './grid.ts';
export { SimClock, RenderState } from './render.ts';

export { snapshot, restore } from './serialize.ts';
export type { WorldSnapshot, CreatureSnapshot } from './serialize.ts';

export { defaultGenesis, defaultConfig } from './config.ts';
export type { WorldGenesis, WorldConfig, TimelineEvent, Easing } from './types.ts';
