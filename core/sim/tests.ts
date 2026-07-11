/**
 * Тесты Фазы 0: доказывают, что мир «интересный» ЧИСЛАМИ, а не на глаз
 * (см. PLAN.md §7 и CLAUDE.md — «балансировку проверяй числами»).
 *
 *   1. Стабильность — при разумном конфиге не вымирает и не взрывается.
 *   2. Дрейф генов — средние значения генов уходят со временем → отбор работает.
 *   3. Детерминизм — один сид даёт идентичную историю.
 *   4. Sweep по солнцу — мало света → мало жизни, много → много. Видно «окно жизни».
 *
 * Пороги подобраны по эмпирическим замерам движка (см. core/prototype).
 *
 *   node sim/tests.ts
 */
import { World } from '../src/world.ts';
import { defaultGenesis, defaultConfig } from '../src/config.ts';

let failed = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed++;
    console.log(`  ✗ ${name}${detail ? '\n      ' + detail : ''}`);
  }
};

function withSunlight(sun: number) {
  const cfg = defaultConfig();
  cfg.sunlight = sun;
  return cfg;
}

console.log('\nТест 1: стабильность — популяция держится в коридоре, не вымирает');
{
  let everExtinct = false;
  let everExploded = false;
  const finals: number[] = [];
  for (const seed of [1, 2, 3, 4, 5]) {
    const w = new World(defaultGenesis(seed), defaultConfig());
    for (let t = 0; t < 4000; t++) {
      w.step();
      const p = w.creatures.length;
      if (p === 0) everExtinct = true;
      if (p > 5000) everExploded = true;
    }
    finals.push(w.creatures.length);
  }
  ok('ни один сид не вымер за 4000 тиков', !everExtinct);
  ok('ни один сид не взорвался (> 5000)', !everExploded);
  ok(
    'финальная популяция здоровая (> 100 на каждом сиде)',
    finals.every((p) => p > 100),
    `финалы: ${finals.join(', ')}`,
  );
}

console.log('\nТест 2: дрейф генов — среднее уходит со временем (отбор работает)');
{
  // Отбор давит размер к минимуму (мелкий дешевле, контрдавления нет — известный
  // долг из PLAN.md §5-1). Значит meanSize должен заметно упасть.
  const drops: number[] = [];
  for (const seed of [1, 2, 3]) {
    const w = new World(defaultGenesis(seed), defaultConfig());
    const start = w.stats().meanSize;
    for (let t = 0; t < 4000; t++) w.step();
    const end = w.stats().meanSize;
    drops.push(start - end);
  }
  ok(
    'meanSize заметно снизился на всех сидах (дрейф > 0.3)',
    drops.every((d) => d > 0.3),
    `падения: ${drops.map((d) => d.toFixed(2)).join(', ')}`,
  );
}

console.log('\nТест 3: детерминизм — один сид → идентичная история');
{
  const a = new World(defaultGenesis(777), defaultConfig());
  const b = new World(defaultGenesis(777), defaultConfig());
  for (let t = 0; t < 2000; t++) {
    a.step();
    b.step();
  }
  ok('два мира с сидом 777 совпали по хэшу', a.hash() === b.hash(), `${a.hash()} vs ${b.hash()}`);
}

console.log('\nТест 4: sweep по солнцу — больше света → больше жизни (окно жизни)');
{
  const measure = (sun: number) => {
    const w = new World(defaultGenesis(42), withSunlight(sun));
    for (let t = 0; t < 3000; t++) w.step();
    return w.creatures.length;
  };
  const low = measure(1);
  const mid = measure(6);
  const high = measure(12);
  ok(
    'популяция монотонно растёт со светом: p(1) < p(6) < p(12)',
    low < mid && mid < high,
    `p(1)=${low}, p(6)=${mid}, p(12)=${high}`,
  );
}

console.log('\n' + '─'.repeat(58));
console.log(failed === 0 ? '  ФАЗА 0: МИР ИНТЕРЕСНЫЙ.' : `  ПРОВАЛЕНО ТЕСТОВ: ${failed}.`);
console.log('─'.repeat(58) + '\n');
process.exit(failed === 0 ? 0 : 1);
