/// <reference types="@webgpu/types" />
/**
 * Проверка движка неживого мира на видеокарте (план docs/plan/world-gpu-engine.md):
 * несколько настоящих миров, каждый — CPU против видеокарты. Этап 1 — загрузка →
 * снимок: состояние возвращается тем же, суммы долей равны. Следующие этапы
 * добавляют сюда сравнения своих этапов обновления минерала.
 */
import { createWorld, groundTotal, makeParams, mineralInDeposits, mineralInMedium, MINERAL_PERIOD, multiplierForLevel, stepWorld, stepWorldTask, transportRange, type MineralAccelerator, type World } from '../core/index.ts';
import { GpuWorld, mineralTotal } from './engine.ts';

const out = document.getElementById('out')!;
const log = (s: string) => { out.textContent += s + '\n'; };
const q = new URLSearchParams(location.search);
const seeds = (q.get('seeds') ?? '1,2,3').split(',').map(Number);
const steps = (q.get('steps') ?? '0,20000,50000').split(',').map(Number);
const results: { stage: number; seed: number; step: number; ok: boolean }[] = [];

/** Вход этапа «перенос» на шаге обновления — как в updateMineralTask. */
function transportInput(world: World) {
  const m = world.mineral, n = m.cols * m.rows, P = MINERAL_PERIOD;
  const { a, b, u } = world.drift.nodes(world.step + 1 - P / 2);
  const tvx = new Float32Array(n), tvy = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    if (m.blocked[k]) continue;
    tvx[k] = a.vx[k] + (b.vx[k] - a.vx[k]) * u + (m.flow ? m.flow.vx[k] : 0);
    tvy[k] = a.vy[k] + (b.vy[k] - a.vy[k]) * u + (m.flow ? m.flow.vy[k] : 0);
  }
  const holes = new Uint8Array(n);
  for (const f of m.funnels) for (const k of f.cells) holes[k] = 1;
  return { src: Float64Array.from(m.field), mobility: Float64Array.from(world.terrain.applied, multiplierForLevel), tvx, tvy, holes, P };
}
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
      results.push({ stage: 1, seed, step: target, ok });
      log(`  сид ${seed}, шаг ${target}: доли 2^-${gpu.mineralExponent} минерала, 2^-${gpu.groundExponent} грунта; `
        + `отличие в клетке до ${r.mineralMax.toExponential(1)} / ${r.groundMax.toExponential(1)}; `
        + `сумма минерала ${mineral.toFixed(6)} → ${mineralAfter.toFixed(6)}, грунта ${ground.toFixed(3)} → ${groundAfter.toFixed(3)}; `
        + `суммы долей ${r.exact ? 'равны' : 'НЕ равны'}; ${r.ms.toFixed(1)} мс — ${ok ? 'да' : 'НЕТ'}`);
    }
  }
  log('Этап 2: перенос — ядро против видеокарты на одном входе');
  for (const seed of seeds) {
    const world = createWorld(makeParams({ seed }));
    for (const target of steps.filter((s) => s > 0)) {
      while (world.step < target - 1) stepWorld(world);
      gpu.attach(world);
      const m = world.mineral, n = m.cols * m.rows, inp = transportInput(world);
      const cpu = new Float64Array(n), gpuOut = new Float64Array(n);
      const t0 = performance.now();
      transportRange(m, inp.src, cpu, inp.holes, inp.mobility, inp.tvx, inp.tvy, inp.P, 0, n);
      const cpuMs = performance.now() - t0;
      const r = await gpu.transport.run(m, inp.src, gpuOut, inp.holes, inp.mobility, inp.tvx, inp.tvy, inp.P, gpu.mineralExponent);
      let total = 0, diff = 0, cpuSum = 0, gpuSum = 0;
      for (let k = 0; k < n; k++) { total += inp.src[k]; cpuSum += cpu[k]; gpuSum += gpuOut[k]; diff += Math.abs(cpu[k] - gpuOut[k]); }
      const ok = r.exact && diff / total < 1e-4;
      results.push({ stage: 2, seed, step: target, ok });
      log(`  сид ${seed}, шаг ${target}: отличие от ядра ${(100 * diff / total).toFixed(5)}% минерала; сумма ${total.toFixed(4)} → ядро ${cpuSum.toFixed(4)}, видеокарта ${gpuSum.toFixed(4)}; `
        + `суммы долей ${r.exact ? 'равны' : 'НЕ равны'}; ядро ${cpuMs.toFixed(1)} мс, видеокарта с загрузкой и чтением ${r.ms.toFixed(1)} мс — ${ok ? 'да' : 'НЕТ'}`);
    }
  }
  // Ход мира с ускорителем: генератор ждёт видеокарту, драйвер ждёт её обещание.
  let pending: Promise<unknown> | null = null;
  const accel: MineralAccelerator = {
    *transport(m, src, dst, holes, mobility, tvx, tvy, P) {
      let done = false;
      pending = gpu.transport.run(m, src, dst, holes, mobility, tvx, tvy, P, gpu.mineralExponent).finally(() => { done = true; });
      while (!done) yield;
    },
  };
  const stepWith = async (w: World) => {
    const task = stepWorldTask(w, accel);
    while (!task.next().done) if (pending) { await pending; pending = null; }
  };
  const updates = Number(q.get('updates') ?? 50);
  log(`Ход мира: два одинаковых мира ещё ${updates} обновлений минерала — CPU и с переносом на видеокарте`);
  for (const seed of seeds) {
    const a = createWorld(makeParams({ seed })), b = createWorld(makeParams({ seed }));
    const start = steps[1] ?? 20000;
    while (a.step < start) { stepWorld(a); stepWorld(b); }
    gpu.attach(b);
    const before = mineralTotal(a);
    const t0 = performance.now();
    while (a.step < start + updates * MINERAL_PERIOD) stepWorld(a);
    const cpuMs = performance.now() - t0, t1 = performance.now();
    while (b.step < start + updates * MINERAL_PERIOD) await stepWith(b);
    const gpuMs = performance.now() - t1;
    const ta = mineralTotal(a), tb = mineralTotal(b);
    const ok = Math.abs(tb - before) < 1e-3 * updates * 1e-3 + 1e-6 * before;
    results.push({ stage: 2, seed, step: start, ok });
    log(`  сид ${seed}: минерал всего ${before.toFixed(6)} → CPU ${ta.toFixed(6)}, видеокарта ${tb.toFixed(6)}; `
      + `в среде CPU ${mineralInMedium(a.mineral).toFixed(1)} / видеокарта ${mineralInMedium(b.mineral).toFixed(1)}, в залежах ${mineralInDeposits(a.terrain).toFixed(1)} / ${mineralInDeposits(b.terrain).toFixed(1)}; `
      + `время ${(cpuMs / 1000).toFixed(1)} / ${(gpuMs / 1000).toFixed(1)} с — ${ok ? 'да' : 'НЕТ'}`);
  }
  log(results.every((r) => r.ok) ? 'Всё сходится.' : 'ЕСТЬ РАСХОЖДЕНИЯ.');
  state.done = true;
}
main().catch((e) => { log('ОШИБКА: ' + (e instanceof Error ? e.message : String(e))); state.done = true; });
