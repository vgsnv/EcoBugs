/** Reproducible CPU-only benchmark; no rendering or Worker messaging. Node 24+. */
import { cpus } from 'node:os';
import { createWorld, makeParams, stepWorld, stepWorldTask, worldHash,
  serializeWorld, parseWorldFile, MINERAL_PERIOD, mineralInMedium,
  mineralInDeposits, mineralInEruptions } from '../src/core/index.ts';

const percentile = (sorted, fraction) => sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0;
const summarize = (values) => {
  values.sort((a, b) => a - b);
  return { count: values.length, p50: percentile(values, .5), p95: percentile(values, .95),
    p99: percentile(values, .99), max: values.at(-1) ?? 0 };
};
const mass = (world) => world.mineral.depths + mineralInMedium(world.mineral)
  + mineralInDeposits(world.terrain) + mineralInEruptions(world.mineral)
  + world.terrain.ground.reduce((sum, value) => sum + value, 0);
const scenarios = [
  { seed: 1, shape: 'rectangle', aspectRatio: 4 / 3 },
  { seed: 2, shape: 'circle', aspectRatio: 1 },
  { seed: 3, shape: 'rectangle', aspectRatio: 16 / 9 },
];
const results = [];
for (const params of scenarios) {
  const begin = performance.now();
  const world = createWorld(makeParams(params));
  const createMs = performance.now() - begin;
  const driftStart = performance.now();
  world.drift.nodes(0);
  const initialDriftMs = performance.now() - driftStart;
  const initialMass = mass(world);
  const windows = [];
  for (let window = 0; window < 3; window++) {
    const updates = [], startStep = world.step, start = performance.now();
    for (let i = 0; i < 50000; i++) {
      if ((world.step + 1) % MINERAL_PERIOD) stepWorld(world);
      else {
        const updateStart = performance.now();
        stepWorld(world);
        updates.push(performance.now() - updateStart);
      }
    }
    const elapsedMs = performance.now() - start;
    windows.push({ startStep, endStep: world.step, elapsedMs,
      stepsPerSecond: 50000 * 1000 / elapsedMs, updateMs: summarize(updates) });
  }
  const hash = worldHash(world), finalMass = mass(world);
  const saveStart = performance.now(), saved = serializeWorld(world, new Date(0));
  const saveMs = performance.now() - saveStart;
  const loadStart = performance.now(), restored = parseWorldFile(saved);
  const loadMs = performance.now() - loadStart;
  const roundTripMatches = worldHash(restored) === hash;
  // Measure generator portions separately: clocks on every yield affect throughput.
  const portions = [];
  for (let i = 0; i < 10000; i++) {
    const task = stepWorldTask(world);
    let done;
    do {
      const start = performance.now();
      done = task.next().done;
      portions.push(performance.now() - start);
    } while (!done);
    stepWorld(restored);
  }
  const continuationMatches = worldHash(world) === worldHash(restored);
  const result = { params, createMs, initialDriftMs, cells: world.mineral.field.length,
    windows, hashAt150000: hash, relativeMassError: (finalMass - initialMass) / initialMass,
    saveMs, loadMs, saveBytes: Buffer.byteLength(saved), roundTripMatches,
    continuationMatches, portionMs: summarize(portions), memory: process.memoryUsage() };
  results.push(result);
  console.error(`${params.shape} seed=${params.seed}: ${windows.map(w => Math.round(w.stepsPerSecond)).join(' / ')} steps/s`);
  if (!roundTripMatches || !continuationMatches || Math.abs(result.relativeMassError) > 1e-8) {
    process.exitCode = 1;
  }
}
console.log(JSON.stringify({ node: process.version, cpu: cpus()[0]?.model,
  note: 'Sequential CPU-only runs; windows include JIT, portions measured separately; memory is process-wide.', results }, null, 2));
