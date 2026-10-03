import { GpuWorld, type Snapshot } from './gpu.ts';
import { createGrid, massByComponent, type Grid, type Scene } from './model.ts';

export function diagnose(grid: Grid, shot: Snapshot) {
  let deposits=0,ground=0;
  let total = 0, dissolved = 0, captured = 0, reserved = 0, flying = 0, leak = 0, maxSpeed = 0;
  let residual = 0, sourceNorm = 0;
  for (let k = 0; k < grid.cols * grid.rows; k++) {
    deposits+=shot.terrain[k*4+1];ground+=shot.terrain[k*4];
    dissolved += shot.state[k * 4]; captured += shot.state[k * 4 + 1]; reserved += shot.state[k * 4 + 2]; flying += shot.state[k * 4 + 3];
    if (shot.geometry[k * 4 + 2]) leak += shot.state[k * 4];
    maxSpeed = Math.max(maxSpeed, Math.abs(shot.flow[k * 2]), Math.abs(shot.flow[k * 2 + 1]));
    const x = k % grid.cols, y = Math.floor(k / grid.cols);
    let balance = 0;
    if (x + 1 < grid.cols) balance += shot.flow[k * 2];
    if (y + 1 < grid.rows) balance += shot.flow[k * 2 + 1];
    if (x > 0) balance -= shot.flow[(k - 1) * 2];
    if (y > 0) balance -= shot.flow[(k - grid.cols) * 2 + 1];
    const source = (grid.light ? shot.field[k * 4 + 3] : shot.geometry[k * 4 + 1]) + shot.vents[k*4+1] - shot.vents[k*4+2] * shot.vents[k*4];
    residual += (balance - source) ** 2;
    sourceNorm += source ** 2;
  }
  reserved += shot.reservoir[1];
  const available=shot.reservoir[0];
  total = deposits + ground + dissolved + captured + reserved + flying + available;
  return { step: shot.step, total, deposits,ground, available, dissolved, captured, reserved, flying, massError: total - grid.total, leak,
    maxSpeed: maxSpeed * grid.cell, relativeResidual: sourceNorm ? Math.sqrt(residual / sourceNorm) : Math.sqrt(residual) };
}

/** Small independent scalar reference for the chosen pressure equation. */
export function referencePressure(grid: Grid, iterations: number): Float32Array {
  let p = new Float32Array(grid.cols * grid.rows), next = new Float32Array(p.length);
  const g = grid.geometry;
  for (let pass = 0; pass < iterations; pass++) {
    for (let k = 0; k < p.length; k++) {
      const x = k % grid.cols, y = Math.floor(k / grid.cols);
      let weight = 0, sum = 0;
      for (const j of [x + 1 < grid.cols ? k + 1 : k, y + 1 < grid.rows ? k + grid.cols : k,
        x > 0 ? k - 1 : k, y > 0 ? k - grid.cols : k]) {
        if (j === k || g[k * 4 + 2] || g[j * 4 + 2]) continue;
        const c = 2 * g[k * 4] * g[j * 4] / (g[k * 4] + g[j * 4]);
        weight += c; sum += c * p[j];
      }
      next[k] = weight ? p[k] * .25 + .75 * (sum + g[k * 4 + 1]) / weight : 0;
    }
    [p, next] = [next, p];
  }
  return p;
}

export async function runChecks(gpu: GpuWorld, publish: (text: string) => void): Promise<string> {
  const rows: string[] = [];
  const assert = (ok: boolean, message: string) => { if (!ok) throw new Error(message); };
  const run = async (steps: number) => {
    for (let start = 0; start < steps; start += 16) {
      for (let k = start; k < Math.min(steps, start + 16); k++) gpu.advance();
      await gpu.device.queue.onSubmittedWorkDone();
    }
  };
  for (const scene of ['quiet', 'contrast', 'wall', 'passage', 'circle', 'layers', 'funnel', 'burst'] as Scene[]) {
    publish(`${rows.join('\n')}\nПроверяю: ${scene}…`);
    const grid = createGrid(scene, 32), iterations = scene === 'passage' ? 32768 : 4096;
    await gpu.reset(grid);
    const initial = await gpu.snapshot();
    const reference = referencePressure(grid, iterations);
    // Neumann pressure has an arbitrary additive constant in each isolated region.
    const means: number[] = [], referenceMeans: number[] = [], counts: number[] = [];
    for (let k = 0; k < reference.length; k++) {
      const area = grid.components[k]; if (area < 0) continue;
      means[area] = (means[area] ?? 0) + initial.pressure[k]; referenceMeans[area] = (referenceMeans[area] ?? 0) + reference[k];
      counts[area] = (counts[area] ?? 0) + 1;
    }
    let difference = 0;
    for (let k = 0; k < reference.length; k++) {
      const area = grid.components[k]; if (area < 0) continue;
      const offset = (means[area] - referenceMeans[area]) / counts[area];
      difference = Math.max(difference, Math.abs(initial.pressure[k] - reference[k] - offset));
    }
    assert(difference < .002, `${scene}: GPU/CPU давление расходится на ${difference}`);
    const pressure = diagnose(grid, initial);
    assert(pressure.relativeResidual < .003, `${scene}: невязка ${pressure.relativeResidual}`);
    const started = performance.now();
    await run(scene === 'funnel' ? 2000 : 400);
    const elapsed = performance.now() - started;
    const shot = await gpu.snapshot(), metrics = diagnose(grid, shot);
    assert(metrics.massError === 0, `${scene}: нарушен баланс массы`);
    assert(metrics.leak === 0, `${scene}: масса в стенке`);
    const summary = await gpu.summary();
    assert(summary.massError === metrics.massError && summary.dissolved === metrics.dissolved && summary.captured === metrics.captured,
      `${scene}: редукция отличается от полного снимка`);
    assert([...shot.pressure, ...shot.flow].every(Number.isFinite), `${scene}: NaN/Infinity`);
    assert(massByComponent(grid, shot.state).every((mass, id) => mass === massByComponent(grid, grid.state)[id]), `${scene}: утечка между отсеками`);
    if (scene === 'quiet') assert(shot.state.every((m, k) => m === grid.state[k]), 'Неподвижная среда изменилась');
    if (scene === 'funnel') assert(metrics.captured > 0, 'Воронка не принимает избыток');
    if (scene === 'burst') assert(metrics.reserved === 0 && metrics.dissolved === grid.total, 'Залп потерял вещество');
    if (scene === 'passage') {
      const section = (x: number) => {
        let flux = 0, cells = 0;
        for (let y = 0; y < grid.rows; y++) {
          const k = y * grid.cols + x;
          if (!grid.geometry[k * 4 + 2] && !grid.geometry[(k + 1) * 4 + 2]) { flux += initial.flow[k * 2]; cells++; }
        }
        return { flux, speed: flux / cells };
      };
      const wide = section(Math.floor(grid.cols * .44)), narrow = section(grid.cols / 2 - 1);
      assert(narrow.speed > wide.speed * 2, 'Узкий проход не ускоряет поток');
      assert(Math.abs(narrow.flux - wide.flux) / narrow.flux < .01, 'Расход через проход не сохраняется');
    }
    if (scene === 'contrast') {
      await gpu.reset(grid); await run(400);
      const repeated = await gpu.snapshot();
      assert(repeated.state.every((m, k) => m === shot.state[k]), 'Повтор запуска отличается');
      await gpu.reset(grid);
      // Different submission batching must not alter model steps or fractional residues.
      for (let k = 0; k < 400; k++) { gpu.advance(); if (k % 5 === 0) await gpu.device.queue.onSubmittedWorkDone(); }
      const differentlyScheduled = await gpu.snapshot();
      assert(differentlyScheduled.state.every((m, k) => m === shot.state[k]), 'Пакеты шагов изменяют мир');
    }
    rows.push(`✓ ${scene}: шаг ${shot.step}, Δмассы 0, невязка ${pressure.relativeResidual.toExponential(2)}, GPU/CPU ${difference.toExponential(2)}, ${(shot.step / elapsed * 1000).toFixed(0)} шагов/с`);
    publish(rows.join('\n'));
  }
  publish(`${rows.join('\n')}\nПроверяю запрет выхода из воронки…`);
  const reversed = createGrid('funnel', 32);
  for (let k = 0; k < reversed.components.length; k++) {
    reversed.geometry[k * 4 + 1] *= -1;
    reversed.state[k * 4] = reversed.geometry[k * 4 + 3] ? 100000 : 0;
  }
  reversed.total = reversed.state.reduce((a, b) => a + b, 0);
  await gpu.reset(reversed); await run(400);
  const closedHole = await gpu.snapshot();
  assert(diagnose(reversed, closedHole).massError === 0, 'Обратная воронка нарушила массу');
  for (let k = 0; k < reversed.components.length; k++) {
    if (!reversed.geometry[k * 4 + 3]) assert(closedHole.state[k * 4] === 0, 'Минерал вышел из отверстия');
  }
  rows.push('✓ обратное течение: отверстие не выпускает минерал');
  publish(`${rows.join('\n')}\nПроверяю слой при сильном потоке…`);
  const layers = createGrid('layers', 32);
  layers.state.fill(0);
  for (let k = 0; k < layers.components.length; k++) layers.geometry[k * 4 + 1] *= 100;
  const donors = [6, 12, 26].map(x => 12 * layers.cols + x);
  for (const k of donors) layers.state[k * 4] = 100000;
  layers.total = 300000;
  await gpu.reset(layers); gpu.advance();
  const thinLayer = await gpu.snapshot();
  for (const k of donors) {
    const moved = 100000 - thinLayer.state[k * 4];
    assert(moved > 0 && moved <= Math.ceil(100000 * layers.geometry[k * 4]),
      `Слой ${k}: ушло ${moved}, предел ${Math.ceil(100000 * layers.geometry[k * 4])}`);
  }
  assert(diagnose(layers, thinLayer).massError === 0, 'Слой нарушил баланс');
  rows.push('✓ сильный поток: бюджеты подвижного слоя 1 / ⅓ / ⅑ соблюдены');
  for (const cols of [64, 128]) {
    publish(`${rows.join('\n')}\nПроверяю сетку ${cols}…`);
    const larger = createGrid('contrast', cols);
    await gpu.reset(larger); await run(400);
    const metrics = diagnose(larger, await gpu.snapshot());
    assert(metrics.massError === 0 && metrics.relativeResidual < .003, `Сетка ${cols}: баланс или сходимость`);
    rows.push(`✓ ${cols}×${larger.rows}: Δмассы 0, невязка ${metrics.relativeResidual.toExponential(2)}`);
  }
  publish(`${rows.join('\n')}\nДлительный прогон: 100 000 шагов…`);
  const long = createGrid('contrast', 32);
  await gpu.reset(long); await run(100000);
  const final = diagnose(long, await gpu.snapshot());
  assert(final.massError === 0 && final.leak === 0, 'Длительный прогон нарушил баланс');
  rows.push('✓ 100 000 шагов: Δмассы 0, утечки 0');
  assert(gpu.errors.length === 0, gpu.errors.join('\n'));
  rows.push('Все проверки GPU прошли. Полный мир и длительный межустройственный аудит ещё впереди.');
  return rows.join('\n');
}
