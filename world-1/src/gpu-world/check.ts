/// <reference types="@webgpu/types" />
/**
 * Проверка движка неживого мира на видеокарте (план docs/plan/world-gpu-engine.md):
 * несколько настоящих миров, каждый — CPU против видеокарты. Этап 1 — загрузка →
 * снимок: состояние возвращается тем же, суммы долей равны. Следующие этапы
 * добавляют сюда сравнения своих этапов обновления минерала.
 */
import { createWorld, groundTotal, makeParams, stepWorld } from '../core/index.ts';
import { GpuWorld, mineralTotal } from './engine.ts';

const out = document.getElementById('out')!;
const log = (s: string) => { out.textContent += s + '\n'; };
const q = new URLSearchParams(location.search);
const seeds = (q.get('seeds') ?? '1,2,3').split(',').map(Number);
const steps = (q.get('steps') ?? '0,20000,50000').split(',').map(Number);
const results: { seed: number; step: number; ok: boolean }[] = [];
const state = { results, done: false };
(window as unknown as { engineCheck: typeof state }).engineCheck = state;

async function main(): Promise<void> {
  const gpu = await GpuWorld.create();
  if (typeof gpu === 'string') { log(`Видеокарта недоступна: ${gpu}`); state.done = true; return; }
  log('Этап 1: загрузка → снимок');
  for (const seed of seeds) {
    const world = createWorld(makeParams({ seed }));
    for (const target of steps) {
      while (world.step < target) stepWorld(world);
      const mineral = mineralTotal(world), ground = groundTotal(world.terrain);
      gpu.attach(world);
      const r = await gpu.roundTrip(world);
      const mineralAfter = mineralTotal(world), groundAfter = groundTotal(world.terrain);
      // Перевод в доли меняет клетку не больше чем на полдоли: проверяем по показателю.
      const ok = r.exact && r.mineralMax <= 2 ** -gpu.mineralExponent && r.groundMax <= 2 ** -gpu.groundExponent;
      results.push({ seed, step: target, ok });
      log(`  сид ${seed}, шаг ${target}: доли 2^-${gpu.mineralExponent} минерала, 2^-${gpu.groundExponent} грунта; `
        + `отличие в клетке до ${r.mineralMax.toExponential(1)} / ${r.groundMax.toExponential(1)}; `
        + `сумма минерала ${mineral.toFixed(6)} → ${mineralAfter.toFixed(6)}, грунта ${ground.toFixed(3)} → ${groundAfter.toFixed(3)}; `
        + `суммы долей ${r.exact ? 'равны' : 'НЕ равны'}; ${r.ms.toFixed(1)} мс — ${ok ? 'да' : 'НЕТ'}`);
    }
  }
  log(results.every((r) => r.ok) ? 'Всё сходится.' : 'ЕСТЬ РАСХОЖДЕНИЯ.');
  state.done = true;
}
main().catch((e) => { log('ОШИБКА: ' + (e instanceof Error ? e.message : String(e))); state.done = true; });
