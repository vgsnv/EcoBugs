/**
 * Round-trip сериализации — фундамент догона мира при resume (см. PLAN.md §6).
 *
 * Ключевой урок из истории проекта (CLAUDE.md, инвариант 5): состояние блуждания
 * RuleBrain (wanderX/wanderY) обязано попадать в снимок — иначе восстановленный
 * мир расходится с непрерывным. Тест ловит это, глаз бы не поймал никогда.
 *
 *   node sim/serialize-test.ts
 */
import { World } from '../src/world.ts';
import { snapshot, restore } from '../src/serialize.ts';
import { defaultGenesis, defaultConfig } from '../src/config.ts';
import { NUM_INPUTS, NUM_OUTPUTS } from '../src/neat.ts';

let failed = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed++;
    console.log(`  ✗ ${name}${detail ? '\n      ' + detail : ''}`);
  }
};

/** Прогон через JSON — как реально ляжет в MMKV (проверяем сериализуемость). */
function roundtrip(w: World): World {
  return restore(JSON.parse(JSON.stringify(snapshot(w))));
}

console.log('\nRound-trip: снимок → JSON → восстановление → догон == непрерывный');
{
  const cont = new World(defaultGenesis(31337), defaultConfig());
  for (let t = 0; t < 4000; t++) cont.step();

  const a = new World(defaultGenesis(31337), defaultConfig());
  for (let t = 0; t < 2000; t++) a.step();
  const restored = roundtrip(a);
  for (let t = 0; t < 2000; t++) restored.step();

  ok(
    'догон после снимка совпал с непрерывным прогоном',
    cont.hash() === restored.hash(),
    `непрерывно=${cont.hash()} догон=${restored.hash()}`,
  );
}

console.log('\nСнимок сохраняет всё, что влияет на будущее');
{
  const w = new World(defaultGenesis(88), defaultConfig());
  for (let t = 0; t < 1500; t++) w.step();
  const snap = snapshot(w);
  const r = restore(JSON.parse(JSON.stringify(snap)));

  ok('тик восстановлен', r.tick === w.tick);
  ok('популяция восстановлена', r.creatures.length === w.creatures.length);
  ok('еда восстановлена', r.foodCount === w.foodCount);
  ok(
    'NEAT-геном мозга сериализуется (узлы ≥ входы+выходы)',
    snap.creatures[0].brain.nodes.length >= NUM_INPUTS + NUM_OUTPUTS &&
      snap.creatures[0].brain.connections.length >= 1,
  );
  ok(
    'счётчики NeatContext восстановлены',
    r.neat.nextInnovation === w.neat.nextInnovation && r.neat.nextNodeId === w.neat.nextNodeId,
  );

  // Один следующий тик должен совпасть — доказывает, что PRNG-состояние тоже в снимке.
  w.step();
  r.step();
  ok('первый тик после restore совпал (PRNG-состояние в снимке)', w.hash() === r.hash());
}

console.log('\n' + '─'.repeat(58));
console.log(failed === 0 ? '  СЕРИАЛИЗАЦИЯ ЦЕЛА.' : `  ПРОВАЛЕНО: ${failed}.`);
console.log('─'.repeat(58) + '\n');
process.exit(failed === 0 ? 0 : 1);
