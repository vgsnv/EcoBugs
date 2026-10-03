/** Долгий расчёт того же мира без браузера и отрисовки. Node 24+. */
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { createWorld, DEFAULT_PARAMS, parseWorldFile, serializeWorld, stepWorld, worldHash, mineralInMedium, mineralInDeposits, mineralInEruptions } from '../src/core/index.ts';

const usage = 'npm run simulate -- --steps 100000 [--load world.json | --params params.json] [--save result.json] [--checkpoint-every 10000]';
try {
  const args = process.argv.slice(2), options = {};
  if (args.includes('--help')) { console.log(usage); process.exit(0); }
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--steps', '--load', '--params', '--save', '--checkpoint-every'].includes(key) || !args[i + 1] || Object.hasOwn(options, key)) throw Error(`Неверный аргумент: ${key}`);
    options[key] = args[i + 1];
  }
  const steps = Number(options['--steps']);
  const interval = options['--checkpoint-every'] === undefined ? 0 : Number(options['--checkpoint-every']);
  if (!Number.isSafeInteger(steps) || steps < 0) throw Error('--steps: нужно целое неотрицательное число');
  if (!Number.isSafeInteger(interval) || interval < 0 || (options['--checkpoint-every'] && interval === 0)) throw Error('--checkpoint-every: нужно целое положительное число');
  if (interval && !options['--save']) throw Error('Для контрольных сохранений нужен --save');
  if (options['--load'] && options['--params']) throw Error('Выберите --load или --params');
  const world = options['--load'] ? parseWorldFile(readFileSync(resolve(options['--load']), 'utf8'))
    : createWorld({ ...DEFAULT_PARAMS, ...(options['--params'] ? JSON.parse(readFileSync(resolve(options['--params']), 'utf8')) : {}) });
  if (!Number.isSafeInteger(world.step + steps)) throw Error('Итоговый возраст превышает точный диапазон целых чисел');
  const save = () => {
    const path = resolve(options['--save']);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, serializeWorld(world, new Date()));
    renameSync(temporary, path);
  };
  const startStep = world.step, start = performance.now();
  for (let i = 1; i <= steps; i++) {
    stepWorld(world);
    if (interval && i % interval === 0) {
      save();
      console.error(`Контрольное сохранение: шаг ${world.step}`);
    }
  }
  if (options['--save'] && (!interval || steps % interval !== 0 || steps === 0)) save();
  const elapsedMs = performance.now() - start;
  console.log(JSON.stringify({ seed: world.params.seed, startStep, step: world.step, elapsedMs,
    stepsPerSecond: elapsedMs > 0 ? steps * 1000 / elapsedMs : 0, hash: worldHash(world),
    mineral: { depths: world.mineral.depths, medium: mineralInMedium(world.mineral), deposits: mineralInDeposits(world.terrain), inTransit: mineralInEruptions(world.mineral) } }, null, 2));
} catch (error) {
  console.error(String(error));
  console.error(usage);
  process.exitCode = 1;
}
