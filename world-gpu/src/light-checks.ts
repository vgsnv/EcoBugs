import { GpuWorld, type Snapshot } from './gpu.ts';
import { diagnose } from './checks.ts';
import { createGrid, massByComponent, type Grid } from './model.ts';

export async function checkLight(gpu: GpuWorld, publish: (text: string) => void): Promise<string> {
  const rows: string[] = [];
  const assert = (ok: boolean, why: string) => { if (!ok) throw new Error(why); };
  const same = (a: ArrayLike<number>, b: ArrayLike<number>) => Array.from(a).every((v,k) => v === b[k]);
  const run = async (n: number, batch = 16) => {
    for (let k = 0; k < n; k++) {
      await gpu.advanceDynamic();
      if (k % batch === 0) await gpu.device.queue.onSubmittedWorkDone();
    }
  };
  const validate = async (grid: Grid, shot: Snapshot) => {
    const d = diagnose(grid, shot), sums: number[] = [], scales: number[] = [];
    assert(d.massError === 0 && d.leak === 0, 'Масса или утечки света');
    assert(d.relativeResidual < .001, `Свет: невязка ${d.relativeResidual}`);
    assert([...shot.field, ...shot.flow].every(Number.isFinite), 'Свет: NaN');
    for (let k = 0; k < grid.components.length; k++) {
      const area = grid.components[k]; if (area < 0) continue;
      sums[area] = (sums[area] ?? 0) + shot.field[k*4+3]; scales[area] = (scales[area] ?? 0) + Math.abs(shot.field[k*4+3]);
      const x = k % grid.cols, y = Math.floor(k / grid.cols);
      if (x === grid.cols-1 || grid.components[k+1] < 0) assert(shot.flow[k*2] === 0, 'Свет проходит восточную стенку');
      if (y === grid.rows-1 || grid.components[k+grid.cols] < 0) assert(shot.flow[k*2+1] === 0, 'Свет проходит южную стенку');
    }
    assert(sums.every((v,id) => Math.abs(v) < Math.max(1e-6, scales[id] * 1e-5)), `Несбалансированный свет в отсеке: ${sums.map((v,id) => v/scales[id]).join(', ')}`);
    assert(same(massByComponent(grid, grid.state), massByComponent(grid, shot.state)), 'Перенос массы между отсеками');
    const summary = await gpu.summary();
    assert(Math.abs(summary.relativeResidual - d.relativeResidual) < 1e-6, 'Редукция света отличается от снимка');
    return d;
  };
  const stationary = createGrid('light', 32); stationary.light!.drift = 0; stationary.light!.rhythm = 0;
  await gpu.reset(stationary); const still = await gpu.snapshot();
  assert(diagnose(stationary, still).maxSpeed > .1, 'Неподвижный свет не создаёт контрастное течение');
  for (let k = 0; k < stationary.components.length; k++) assert(still.field[k*4+1] === 0 && still.field[k*4+2] === 0, 'Дрейф ноль не отключил увлечение');
  rows.push('✓ неподвижный свет: контрастный поток есть, увлечение равно нулю'); publish(rows.join('\n'));
  const brighter = createGrid('light', 32); brighter.light = {...stationary.light!, sun:2};
  await gpu.reset(brighter); const bright = await gpu.snapshot();
  assert(bright.flow.every((v,k) => Math.abs(v - still.flow[k]*2) < .00002), 'Солнце не масштабирует течение');
  const muddy = createGrid('light',32); muddy.light = {...stationary.light!}; muddy.state.fill(0); muddy.state[0] = muddy.total;
  await gpu.reset(muddy); const dirty = await gpu.snapshot();
  assert(same(dirty.field, still.field) && same(dirty.flow, still.flow), 'Минерал изменяет физику света');
  rows.push('✓ яркость ×2 усиливает течение ×2; минерал не меняет свет и скорость'); publish(rows.join('\n'));
  const entrained = createGrid('light',32); entrained.light!.contrast = 0;
  await gpu.reset(entrained); const drift = await gpu.snapshot();
  // Pure drift must have nonzero circulation and almost zero divergence.
  assert(diagnose(entrained, drift).maxSpeed > .1, 'Проекция уничтожила всё увлечение');
  let divergence = 0, reverse = false;
  for (let y=0;y<entrained.rows;y++) for (let x=0;x<entrained.cols;x++) {
    const k=y*entrained.cols+x;
    const balance = drift.flow[k*2]+drift.flow[k*2+1]-(x ? drift.flow[(k-1)*2] : 0)-(y ? drift.flow[(k-entrained.cols)*2+1] : 0);
    divergence=Math.max(divergence,Math.abs(balance)); reverse ||= drift.flow[k*2] < -.001;
  }
  assert(divergence < .001 && reverse, `Увлечение без возврата/проекции: ${divergence}`);
  rows.push(`✓ чистое увлечение: есть возврат, max дивергенции ${divergence.toExponential(2)}`); publish(rows.join('\n'));
  for (const scene of ['light','light-wall'] as const) {
    const grid = createGrid(scene,32); await gpu.reset(grid); const start = await gpu.snapshot();
    await run(200); const result = await gpu.snapshot(); const metrics = await validate(grid,result);
    assert(!same(start.field,result.field) && !same(start.flow,result.flow), 'Дрейф не обновляет свет/течение');
    await gpu.reset(grid); await run(200,5); const replay = await gpu.snapshot();
    assert(same(result.state,replay.state) && same(result.field,replay.field) && same(result.flow,replay.flow), 'Динамика зависит от пакетов');
    rows.push(`✓ ${scene}: 200 шагов, Δмассы 0, r=${metrics.relativeResidual.toExponential(2)}, повтор совпал`); publish(rows.join('\n'));
  }
  for (const cols of [64,128]) {
    publish(`${rows.join('\n')}\nПроверяю свет ${cols}…`);
    const grid=createGrid('light',cols); await gpu.reset(grid); await run(40);
    const m=await validate(grid,await gpu.snapshot());
    rows.push(`✓ свет ${cols}×${grid.rows}: Δмассы 0, r=${m.relativeResidual.toExponential(2)}`);
  }
  assert(gpu.errors.length === 0,gpu.errors.join('\n'));
  rows.push('Проверки динамического света прошли. Генератор по сиду и затухающие источники впереди.');
  return rows.join('\n');
}
