/**
 * Тесты рендер-моста (headless): SimClock и RenderState.
 * Оба — чистый TS, поэтому проверяются в Node без устройства/Skia.
 *
 *   node sim/render-test.ts
 */
import { World } from '../src/world.ts';
import { SimClock, RenderState } from '../src/render.ts';
import { defaultGenesis, defaultConfig } from '../src/config.ts';

let failed = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed++;
    console.log(`  ✗ ${name}${detail ? '\n      ' + detail : ''}`);
  }
};

console.log('\nSimClock: тик отвязан от FPS, шаги накапливаются по времени');
{
  // 10 тиков/сек → 100 мс на тик. Кормим 10 реалистичных кадров по 100 мс:
  // в сумме ровно 10 тиков (одиночный advance клампится до 250 мс — защита
  // от «спирали смерти», поэтому большой dt за один вызов не даёт лавину).
  const w = new World(defaultGenesis(5), defaultConfig());
  const clock = new SimClock(10);
  const startTick = w.tick;
  let total = 0;
  for (let f = 0; f < 10; f++) total += clock.advance(w, 100);
  ok('10 кадров по 100 мс при 10 tps → 10 тиков', total === 10, `total=${total}`);
  ok('world.tick продвинулся ровно на число шагов', w.tick - startTick === total);
}
{
  // Антизависание: гигантский dt за один кадр не выстреливает лавиной шагов.
  const w = new World(defaultGenesis(5), defaultConfig());
  const clock = new SimClock(60);
  const steps = clock.advance(w, 100000);
  ok('гигантский dt за кадр ограничен капом (≤ 12 шагов)', steps <= 12, `steps=${steps}`);
}
{
  // Смена скорости: 20 tps = 50 мс/тик. 5 кадров по 100 мс → 10 тиков.
  const w = new World(defaultGenesis(5), defaultConfig());
  const clock = new SimClock(10);
  clock.setSpeed(20);
  let total = 0;
  for (let f = 0; f < 5; f++) total += clock.advance(w, 100);
  ok('после setSpeed(20): 5 кадров по 100 мс → 10 тиков', total === 10, `total=${total}`);
}

console.log('\nRenderState: буферы синхронизируются без аллокаций и с обрезкой по cap');
{
  const w = new World(defaultGenesis(5), defaultConfig());
  for (let t = 0; t < 500; t++) w.step();

  const rs = new RenderState(5000);
  const bx = rs.posX; // сохраняем ссылку — sync НЕ должен пересоздавать буферы
  rs.sync(w);
  ok('count равен числу существ', rs.count === w.creatures.length, `count=${rs.count}, pop=${w.creatures.length}`);
  ok('буфер не переаллоцирован (та же ссылка)', rs.posX === bx);
  ok(
    'позиции скопированы из мира (с точностью float32)',
    rs.posX[0] === Math.fround(w.creatures[0].x) && rs.posY[0] === Math.fround(w.creatures[0].y),
  );
  ok('радиус положителен', rs.radius[0] > 0);

  // Обрезка по маленькому cap.
  const small = new RenderState(10);
  small.sync(w);
  ok('при cap=10 count обрезан до 10', small.count === 10, `count=${small.count}`);
}

console.log('\n' + '─'.repeat(58));
console.log(failed === 0 ? '  РЕНДЕР-МОСТ ЦЕЛ.' : `  ПРОВАЛЕНО: ${failed}.`);
console.log('─'.repeat(58) + '\n');
process.exit(failed === 0 ? 0 : 1);
