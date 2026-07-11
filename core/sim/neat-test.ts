/**
 * Тесты NEAT (Фаза 3+, PLAN.md §4а). Проверяют ЧИСЛАМИ, что:
 *   1. сеть усложняется со временем — появляются новые гены (скрытые узлы/связи);
 *   2. эволюция мозга детерминирована (сид → идентичная сложность и хэш);
 *   3. сеть feed-forward и её вычисление воспроизводимо;
 *   4. сид-геном ведёт себя как «плыви к еде» (иначе сбалансированный мир рухнул бы).
 *
 * Рост сети СКРОМНЫЙ и капризный — это ожидание, а не баг: в эмерджентном отборе без
 * функции приспособленности новизна не защищена, мутант с бесполезным узлом умирает
 * (PLAN.md §4а, «честная плата»).
 *
 *   node sim/neat-test.ts
 */
import { World } from '../src/world.ts';
import { defaultGenesis, defaultConfig } from '../src/config.ts';
import { NeatBrain } from '../src/brain.ts';
import { seedGenome, brainComplexity } from '../src/neat.ts';
import { PRNG } from '../src/prng.ts';

let failed = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed++;
    console.log(`  ✗ ${name}${detail ? '\n      ' + detail : ''}`);
  }
};

function meanConns(w: World): number {
  let c = 0;
  for (const cr of w.creatures) c += brainComplexity(cr.genome.brain).connections;
  return c / (w.creatures.length || 1);
}
function totalHidden(w: World): number {
  let h = 0;
  for (const cr of w.creatures) h += cr.genome.brain.nodes.filter((n) => n.type === 'hidden').length;
  return h;
}

console.log('\nТест 1: сеть усложняется — появляются новые гены (узлы/связи)');
{
  let grewConns = 0;
  let sawHidden = 0;
  let maxInnov = 0;
  for (const seed of [1, 2, 3]) {
    const w = new World(defaultGenesis(seed), defaultConfig());
    const c0 = meanConns(w);
    for (let t = 0; t < 8000; t++) w.step();
    const c1 = meanConns(w);
    if (c1 > c0 + 0.2) grewConns++;
    if (totalHidden(w) > 0) sawHidden++;
    maxInnov = Math.max(maxInnov, w.neat.nextInnovation);
  }
  ok('среднее число связей выросло на всех 3 сидах', grewConns === 3, `сидов с ростом: ${grewConns}/3`);
  ok('скрытые узлы (новые гены) появились на всех 3 сидах', sawHidden === 3, `сидов со скрытыми: ${sawHidden}/3`);
  ok('структурные мутации срабатывали (innovation ≫ 4)', maxInnov > 100, `maxInnov=${maxInnov}`);
}

console.log('\nТест 2: эволюция мозга детерминирована');
{
  const a = new World(defaultGenesis(555), defaultConfig());
  const b = new World(defaultGenesis(555), defaultConfig());
  for (let t = 0; t < 4000; t++) {
    a.step();
    b.step();
  }
  ok('два мира сид 555: хэш совпал (мозг в хэше)', a.hash() === b.hash(), `${a.hash()} vs ${b.hash()}`);
  ok('счётчики инноваций совпали', a.neat.nextInnovation === b.neat.nextInnovation);
  ok('средняя сложность сети совпала', Math.abs(meanConns(a) - meanConns(b)) < 1e-9);
}

console.log('\nТест 3: вычисление сети воспроизводимо (feed-forward)');
{
  const g = seedGenome(new PRNG(12345));
  const brain = new NeatBrain(g);
  const s = { hasFood: true, foodDx: 0.6, foodDy: 0.8, energy: 0.5 };
  const rngA = new PRNG(9);
  const rngB = new PRNG(9);
  const d1 = brain.decide(s, () => rngA.next());
  const d2 = brain.decide(s, () => rngB.next());
  ok('один вход + один сид шума → идентичный выход', d1.dirX === d2.dirX && d1.dirY === d2.dirY);
  const len = Math.hypot(d1.dirX, d1.dirY);
  ok('выход — единичный вектор (или ноль)', Math.abs(len - 1) < 1e-6 || len < 1e-9, `len=${len}`);
}

console.log('\nТест 4: сид-геном плывёт к еде (жизнеспособность экономики)');
{
  const g = seedGenome(new PRNG(42));
  const brain = new NeatBrain(g);
  // Еда строго по +x; усредняем по многим тикам, чтобы шум не решал.
  const rng = new PRNG(1);
  let sumX = 0;
  const N = 400;
  for (let i = 0; i < N; i++) {
    const d = brain.decide({ hasFood: true, foodDx: 1, foodDy: 0, energy: 0.5 }, () => rng.next());
    sumX += d.dirX;
  }
  ok('в среднем движется к еде (dirX > 0.5)', sumX / N > 0.5, `mean dirX=${(sumX / N).toFixed(2)}`);
}

console.log('\n' + '─'.repeat(58));
console.log(failed === 0 ? '  NEAT ЦЕЛ.' : `  ПРОВАЛЕНО: ${failed}.`);
console.log('─'.repeat(58) + '\n');
process.exit(failed === 0 ? 0 : 1);
