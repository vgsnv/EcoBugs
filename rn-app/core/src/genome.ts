/**
 * Геном — расщеплён на две части (см. план §4):
 *   bodyGenes  — фиксированный вектор, критичен для экономики энергии.
 *   brainGenome — открытая, растущая часть (NEAT). В Фазе 0 — заглушка.
 *
 * Такое разделение заложено СЕЙЧАС, хотя brainGenome ещё пуст, чтобы позже
 * ввести NEAT и половое размножение без переписывания ядра и сериализации.
 */
import { PRNG } from './prng.ts';
import { seedGenome, mutateBrain, crossoverBrain, type NeatGenome, type NeatContext } from './neat.ts';
import type { GenePool } from './types.ts';

/**
 * Индексы генов тела. Фиксированная длина, плоский Float32Array.
 * const-объект вместо enum: Node strip-only не поддерживает enum,
 * а использование Gene.Size остаётся идентичным.
 */
export const Gene = {
  Size: 0,          // размер: крупнее → заметнее, дороже метаболизм, дальше ест
  Speed: 1,         // макс. скорость: быстрее → дороже движение (∝ speed²)
  Metabolism: 2,    // базовый множитель расхода энергии в покое
  VisionRadius: 3,  // радиус зрения: дальше видит еду, но это «бесплатно» в Ф0
  ReproThreshold: 4,// порог энергии для деления
  MutationRate: 5,  // мета-ген: собственная вероятность мутации гена
  Hue: 6,           // окраска [0,1) — для визуализации, на экономику не влияет
  SexualTendency: 7,// 0 = всегда деление, 1 = всегда партнёр, между — факультативно
} as const;

export const GENE_COUNT = 8;

/** Границы генов. Мутация всегда клампится сюда — иначе экономика улетает. */
export const GENE_BOUNDS: ReadonlyArray<readonly [number, number]> = [
  [0.4, 2.5],   // Size
  [0.3, 2.0],   // Speed
  [0.5, 1.5],   // Metabolism
  [8, 60],      // VisionRadius
  [60, 200],    // ReproThreshold
  [0.02, 0.5],  // MutationRate
  [0, 1],       // Hue
  [0, 1],       // SexualTendency
];

/** Геном мозга — NEAT-сеть переменной топологии (см. neat.ts). */
export type BrainGenome = NeatGenome;

export interface Genome {
  body: Float32Array;      // длина GENE_COUNT
  brain: BrainGenome;      // растущая NEAT-сеть
}

/**
 * Дефолтный генофонд: полный разброс, смешанная стратегия, естественный центр мутаций.
 * ВАЖНО: при этих значениях randomGenome даёт РОВНО те же rng-вызовы, что и раньше
 * (center = середина диапазона, diversity = 1) → детерминизм и тесты не меняются.
 */
export const DEFAULT_GENE_POOL: GenePool = {
  diversity: 1,
  sexualCenter: 0.5,
  mutationCenter: 0.26, // = середина [0.02, 0.5]
};

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Случайный геном стартовой особи: тело по генофонду + сид-мозг «плыви к еде».
 * Формула сохраняет число/порядок rng-вызовов (по одному range на ген), поэтому при
 * DEFAULT_GENE_POOL история побайтно совпадает с прежней.
 *
 *   значение = центр + (разброс − серединаДиапазона) · diversity, клампится в границы.
 * diversity=0 → все особи у центра (клоны); diversity=1 → полный разброс.
 * Для SexualTendency центр = sexualCenter, для MutationRate = mutationCenter.
 */
export function randomGenome(rng: PRNG, pool: GenePool = DEFAULT_GENE_POOL): Genome {
  const body = new Float32Array(GENE_COUNT);
  for (let i = 0; i < GENE_COUNT; i++) {
    const [lo, hi] = GENE_BOUNDS[i];
    const r = rng.range(lo, hi);
    const mid = (lo + hi) / 2;
    let center = mid;
    if (i === Gene.SexualTendency) center = pool.sexualCenter * (hi - lo) + lo;
    else if (i === Gene.MutationRate) center = pool.mutationCenter;
    body[i] = clamp(center + (r - mid) * pool.diversity, lo, hi);
  }
  return { body, brain: seedGenome(rng) };
}

/**
 * Мутация при рождении потомка. Возвращает НОВЫЙ геном (родитель не меняется).
 * Каждый ген с вероятностью mutationRate получает гауссов сдвиг.
 * mutationRate — мета-ген: мутирует сам себя, поэтому скорость мутации
 * тоже под отбором.
 */
export function mutate(parent: Genome, rng: PRNG, ctx: NeatContext): Genome {
  const rate = parent.body[Gene.MutationRate];
  const body = new Float32Array(GENE_COUNT);
  for (let i = 0; i < GENE_COUNT; i++) {
    const [lo, hi] = GENE_BOUNDS[i];
    let v = parent.body[i];
    if (rng.next() < rate) {
      // Масштаб сдвига — доля диапазона гена, чтобы шаг был соразмерен.
      const scale = (hi - lo) * 0.1;
      v += rng.gaussian() * scale;
    }
    body[i] = clamp(v, lo, hi);
  }
  // Мозг мутирует отдельно: возмущение весов + структурные мутации (связь/узел).
  const brain = mutateBrain(parent.brain, rate, rng, ctx);
  return { body, brain };
}

/**
 * Кроссовер двух геномов (половое размножение, §4б). Возвращает НОВЫЙ геном:
 *   - тело: каждый ген наследуется случайно от одного из родителей;
 *   - мозг: выравнивание по innovation-номерам (см. neat.crossoverBrain).
 * Мутация применяется ОТДЕЛЬНО после кроссовера (см. world.ts).
 */
export function crossover(a: Genome, b: Genome, rng: PRNG): Genome {
  const body = new Float32Array(GENE_COUNT);
  for (let i = 0; i < GENE_COUNT; i++) {
    body[i] = rng.next() < 0.5 ? a.body[i] : b.body[i];
  }
  return { body, brain: crossoverBrain(a.brain, b.brain, rng) };
}
