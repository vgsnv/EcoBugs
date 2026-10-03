import { GpuWorld, type PressureMethod } from './gpu.ts';
import { diagnose } from './checks.ts';
import { createGrid, type Scene } from './model.ts';

/** Host elapsed time through queue completion, excluding compilation and readback. */
export async function comparePressure(gpu: GpuWorld, publish: (text: string) => void): Promise<string> {
  const rows = ['Давление: прогрев + 3 чередующихся прогона.', 'Время до завершения очереди; не GPU timestamp.', 'Оба метода: невязка < 0,003; отличие скорости < 0,003.'];
  const median = (times: number[]) => [...times].sort((a, b) => a - b)[1];
  for (const [scene, cols] of [['contrast', 64], ['wall', 64], ['circle', 64], ['layers', 64], ['passage', 64], ['contrast', 128]] as [Scene, number][]) {
    publish(`${rows.join('\n')}\nСравниваю ${scene} ${cols}…`);
    const grid = createGrid(scene, cols);
    await gpu.reset(grid);
    for (const method of ['jacobi', 'sor'] as PressureMethod[]) await gpu.solvePressure({ method });
    const times: Record<PressureMethod, number[]> = { sor: [], jacobi: [] };
    const residuals: Record<PressureMethod, number> = { sor: 0, jacobi: 0 };
    const passes: Record<PressureMethod, number> = { sor: 0, jacobi: 0 };
    let flowDifference = 0;
    for (let repeat = 0; repeat < 3; repeat++) {
      const flows: Partial<Record<PressureMethod, Float32Array>> = {};
      for (const method of (repeat % 2 ? ['sor', 'jacobi'] : ['jacobi', 'sor']) as PressureMethod[]) {
        const result = await gpu.solvePressure({ method });
        times[method].push(result.milliseconds); passes[method] = result.passes;
        const shot = await gpu.snapshot(), metrics = diagnose(grid, shot);
        residuals[method] = Math.max(residuals[method], metrics.relativeResidual);
        if (metrics.relativeResidual >= .003 || metrics.massError || !shot.flow.every(Number.isFinite)) {
          throw new Error(`${scene} ${method}: сходимость/масса/NaN`);
        }
        flows[method] = shot.flow;
      }
      let error = 0, norm = 0;
      for (let k = 0; k < flows.sor!.length; k++) {
        error += (flows.sor![k] - flows.jacobi![k]) ** 2; norm += flows.jacobi![k] ** 2;
      }
      flowDifference = Math.max(flowDifference, Math.sqrt(error / norm));
    }
    if (flowDifference >= .003 || gpu.errors.length) throw new Error(`${scene}: поля скорости расходятся ${flowDifference}`);
    const format = (method: PressureMethod) => `${median(times[method]).toFixed(1)} мс [${Math.min(...times[method]).toFixed(1)}–${Math.max(...times[method]).toFixed(1)}], ${passes[method]} проходов, r=${residuals[method].toExponential(2)}`;
    rows.push(`✓ ${scene} ${cols}×${grid.rows}\n  Jacobi ${format('jacobi')}\n  SOR ${format('sor')}\n  ×${(median(times.jacobi) / median(times.sor)).toFixed(2)}, Δv=${flowDifference.toExponential(2)}`);
    publish(rows.join('\n'));
  }
  rows.push('Сравнение пройдено. Это ускорение подготовки статического поля, не всего мира.');
  return rows.join('\n');
}
