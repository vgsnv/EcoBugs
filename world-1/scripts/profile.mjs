/**
 * Время физики по этапам: сколько миллисекунд каждый этап занимает в одном
 * обновлении минерала. Без браузера и отрисовки. Node 24+.
 * npm run profile -- [--steps 100000] [--warmup 20000]
 */
import { createWorld, makeParams, stepWorld, setPhaseHook, MINERAL_PERIOD } from '../src/core/index.ts';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const value = Number(args[i + 1]);
  if (!Number.isSafeInteger(value) || value < 0) throw Error(`${name}: нужно целое неотрицательное число`);
  return value;
};
const steps = option('--steps', 100_000), warmup = option('--warmup', 20_000);
const scenarios = [
  { seed: 1, shape: 'rectangle', aspectRatio: 4 / 3 },
  { seed: 2, shape: 'circle', aspectRatio: 1 },
  { seed: 3, shape: 'rectangle', aspectRatio: 16 / 9 },
];

const spent = new Map();
let current = null, since = 0;
setPhaseHook((name) => {
  const now = performance.now();
  if (current) spent.set(current, (spent.get(current) ?? 0) + now - since);
  current = name;
  since = now;
});

const ms = (x) => x.toFixed(2).padStart(6);
const totals = new Map();
let allMs = 0, allUpdates = 0;
for (const params of scenarios) {
  const world = createWorld(makeParams(params));
  while (world.step < warmup) stepWorld(world);
  spent.clear();
  const start = performance.now();
  for (let i = 0; i < steps; i++) stepWorld(world);
  const elapsed = performance.now() - start;
  const updates = steps / MINERAL_PERIOD;
  allMs += elapsed; allUpdates += updates;
  for (const [name, value] of spent) totals.set(name, (totals.get(name) ?? 0) + value);
  console.log(`${params.shape} сид ${params.seed}: ${Math.round(steps / elapsed * 1000)} шагов/с, ${ms(elapsed / updates).trim()} мс на обновление минерала`);
}

console.log(`\nВсего: ${Math.round(allUpdates * MINERAL_PERIOD / allMs * 1000)} шагов/с (шаги ${warmup}–${warmup + steps}, ${scenarios.length} мира)`);
console.log('   мс   доля  этап (в среднем на одно обновление минерала)');
const covered = [...totals.values()].reduce((a, b) => a + b, 0);
for (const [name, value] of [...totals, ['прочее (шаги без обновления, отметки)', allMs - covered]].sort((a, b) => b[1] - a[1])) {
  console.log(`${ms(value / allUpdates)}  ${(100 * value / allMs).toFixed(1).padStart(4)}%  ${name}`);
}
console.log(`${ms(allMs / allUpdates)}  100%  всё обновление`);
