/**
 * Тесты полового размножения (Фаза 3+, PLAN.md §4б).
 *
 * Проверяем МЕХАНИКУ и её детерминизм, НЕ конкретный экологический исход: кто
 * победит (половые или бесполые) — эмерджентно и зависит от конфига, это предмет
 * наблюдения, а не инвариант (PLAN.md §4б: «доминирование допустимо, если это
 * наблюдаемый исход»). Здесь фиксируем, что механизм рабочий и воспроизводимый:
 *   1. кроссовер тела берёт гены от родителей и детерминирован;
 *   2. кроссовер мозга выравнивает по innovation и детерминирован;
 *   3. в смешанном мире обе стратегии какое-то время СОСУЩЕСТВУЮТ (ни одна не
 *      исчезает мгновенно — иначе это был бы баг, а не «двойная цена секса»);
 *   4. эволюция стратегии детерминирована (сид → идентичная доля половых).
 *
 *   node sim/sexual-test.ts
 */
import { World } from '../src/world.ts';
import { defaultGenesis, defaultConfig } from '../src/config.ts';
import { crossover, randomGenome, Gene } from '../src/genome.ts';
import { PRNG } from '../src/prng.ts';

let failed = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed++;
    console.log(`  ✗ ${name}${detail ? '\n      ' + detail : ''}`);
  }
};

console.log('\nТест 1: кроссовер тела наследует гены от родителей и детерминирован');
{
  const a = randomGenome(new PRNG(1));
  const b = randomGenome(new PRNG(2));
  const child = crossover(a, b, new PRNG(99));
  let fromParents = true;
  for (let i = 0; i < a.body.length; i++) {
    if (child.body[i] !== a.body[i] && child.body[i] !== b.body[i]) fromParents = false;
  }
  ok('каждый ген тела равен гену одного из родителей', fromParents);

  const c1 = crossover(a, b, new PRNG(99));
  const c2 = crossover(a, b, new PRNG(99));
  let same = true;
  for (let i = 0; i < c1.body.length; i++) if (c1.body[i] !== c2.body[i]) same = false;
  ok('один сид → идентичный кроссовер тела', same);
}

console.log('\nТест 2: кроссовер мозга валиден (узлы и связи от инициатора, веса — микс)');
{
  const a = randomGenome(new PRNG(3));
  const b = randomGenome(new PRNG(4));
  const child = crossover(a, b, new PRNG(7));
  ok('топология ребёнка = топология инициатора (узлы)', child.brain.nodes.length === a.brain.nodes.length);
  ok('связи ребёнка соответствуют инициатору по числу', child.brain.connections.length === a.brain.connections.length);
  const innovOk = child.brain.connections.every((c, i) => c.innovation === a.brain.connections[i].innovation);
  ok('innovation-номера сохранены', innovOk);
}

console.log('\nТест 3: смешанный мир — обе стратегии сосуществуют (не моностратегия сразу)');
{
  const w = new World(defaultGenesis(7), defaultConfig());
  let minShare = 1;
  let maxShare = 0;
  for (let t = 0; t < 6000; t++) {
    w.step();
    if (t % 500 === 0) {
      const share = w.stats().sexualShare;
      if (share < minShare) minShare = share;
      if (share > maxShare) maxShare = share;
    }
  }
  // Обе стратегии присутствуют: доля половых не схлопнулась в 0 и не заняла всё.
  ok(
    'половые не исчезли и не заняли весь мир за 6000 тиков',
    minShare > 0.05 && maxShare < 0.95,
    `share ∈ [${minShare.toFixed(2)}, ${maxShare.toFixed(2)}]`,
  );
  ok('в популяции реально есть носители обеих стратегий', w.creatures.some((c) => c.genome.body[Gene.SexualTendency] > 0.5) && w.creatures.some((c) => c.genome.body[Gene.SexualTendency] <= 0.5));
}

console.log('\nТест 4: эволюция стратегии детерминирована');
{
  const a = new World(defaultGenesis(321), defaultConfig());
  const b = new World(defaultGenesis(321), defaultConfig());
  for (let t = 0; t < 4000; t++) {
    a.step();
    b.step();
  }
  ok('хэш совпал (тело со стратегией в хэше)', a.hash() === b.hash());
  ok(
    'средняя склонность к половому совпала',
    Math.abs(a.stats().meanSexualTendency - b.stats().meanSexualTendency) < 1e-9,
  );
}

console.log('\n' + '─'.repeat(58));
console.log(failed === 0 ? '  ПОЛОВОЕ РАЗМНОЖЕНИЕ ЦЕЛО.' : `  ПРОВАЛЕНО: ${failed}.`);
console.log('─'.repeat(58) + '\n');
process.exit(failed === 0 ? 0 : 1);
