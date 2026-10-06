/// <reference types="@webgpu/types" />
/**
 * Проверка движка неживого мира на видеокарте (план docs/plan/world-gpu-engine.md):
 * несколько настоящих миров, каждый — CPU против видеокарты. Этап 1 — загрузка →
 * снимок: состояние возвращается тем же, суммы долей равны. Следующие этапы
 * добавляют сюда сравнения своих этапов обновления минерала.
 */
import {
  createWorld, groundTotal, makeParams, mediumTask, mineralInDeposits, mineralInMedium, MINERAL_PERIOD, runoffTask, stepWorld, stepWorldTask,
  type MediumStage, type MineralAccelerator, type RunoffStage, type TerrainState, type World,
} from '../core/index.ts';
import { finishCalculation, type Calculation } from '../core/task.ts';
import { GpuWorld, mineralTotal } from './engine.ts';

const out = document.getElementById('out')!;
const log = (s: string) => { out.textContent += s + '\n'; };
const q = new URLSearchParams(location.search);
const seeds = (q.get('seeds') ?? '1,2,3').split(',').map(Number);
const steps = (q.get('steps') ?? '0,20000,50000').split(',').map(Number);
const results: { stage: number; seed: number; step: number; ok: boolean }[] = [];

const copyTerrain = (t: TerrainState): TerrainState => ({ ...t, ground: Float64Array.from(t.ground), deposits: Float64Array.from(t.deposits) });
/** Вход и выход этапов на CPU — снятые «шпионом» на месте ускорителя во время настоящего шага ядра. */
interface Captured {
  medium: { input: MediumStage; dst: Float64Array; deposits: Float64Array };
  runoff: { input: RunoffStage; out: Float64Array };
}
function* spy(world: World, into: Partial<Captured>): Calculation {
  const accel: MineralAccelerator = {
    *medium(st) {
      const input: MediumStage = { ...st, src: Float64Array.from(st.src), dst: new Float64Array(st.dst.length), terrain: copyTerrain(st.terrain),
        erosionOut: new Float32Array(st.erosionOut.length), settlingOut: new Float32Array(st.settlingOut.length) };
      yield* mediumTask(st);
      into.medium = { input, dst: Float64Array.from(st.dst), deposits: Float64Array.from(st.terrain.deposits) };
    },
    *runoff(st) {
      const input: RunoffStage = { ...st, field: Float64Array.from(st.field), ground: Float64Array.from(st.ground), deposits: Float64Array.from(st.deposits), out: new Float64Array(st.out.length) };
      const out = yield* runoffTask(st);
      into.runoff = { input, out: Float64Array.from(out) };
      return out;
    },
  };
  yield* stepWorldTask(world, accel);
}
const relDiff = (a: ArrayLike<number>, b: ArrayLike<number>) => { let d = 0, t = 0; for (let k = 0; k < a.length; k++) { d += Math.abs(a[k] - b[k]); t += Math.abs(a[k]); } return t > 0 ? d / t : 0; };
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
  log('Этапы 2–3: среда (перенос, растекание, оседание и размыв) и стекание — ядро против видеокарты на одном входе');
  for (const seed of seeds) {
    const world = createWorld(makeParams({ seed }));
    for (const target of steps.filter((x) => x > 0)) {
      while (world.step < target - 1) stepWorld(world);
      gpu.attach(world);
      const c: Partial<Captured> = {};
      finishCalculation(spy(world, c));
      const md = c.medium!, ro = c.runoff!;
      const rm = await gpu.mineral.medium(md.input, gpu.mineralExponent, gpu.groundExponent);
      const rr = await gpu.mineral.runoff(ro.input, gpu.mineralExponent, gpu.groundExponent);
      const dField = relDiff(md.dst, md.input.dst), dDep = relDiff(md.deposits, md.input.terrain.deposits), dRun = relDiff(ro.out, ro.input.out);
      const ok = rm.exact && rr.exact && dField < 1e-4 && dDep < 1e-4 && dRun < 1e-4;
      results.push({ stage: 3, seed, step: target, ok });
      log(`  сид ${seed}, шаг ${target}: отличие от ядра — поле после среды ${(100 * dField).toFixed(5)}%, залежи ${(100 * dDep).toFixed(5)}%, поле после стекания ${(100 * dRun).toFixed(5)}%; `
        + `суммы долей ${rm.exact && rr.exact ? 'равны' : 'НЕ равны'}; видеокарта с загрузкой и чтением: среда ${rm.ms.toFixed(1)} мс, стекание ${rr.ms.toFixed(1)} мс — ${ok ? 'да' : 'НЕТ'}`);
    }
  }
  // Ход мира с ускорителем: генератор ждёт видеокарту, драйвер ждёт её обещание.
  let pending: Promise<unknown> | null = null;
  const wait = function* <T>(job: Promise<T>): Generator<void, T, void> {
    let done = false, value: T | undefined;
    pending = job.then((v) => { value = v; }).finally(() => { done = true; });
    while (!done) yield;
    return value as T;
  };
  const accel: MineralAccelerator = {
    *medium(st) { yield* wait(gpu.mineral.medium(st, gpu.mineralExponent, gpu.groundExponent)); },
    *runoff(st) { yield* wait(gpu.mineral.runoff(st, gpu.mineralExponent, gpu.groundExponent)); return st.out; },
  };
  const stepWith = async (w: World) => {
    const task = stepWorldTask(w, accel);
    while (!task.next().done) if (pending) { await pending; pending = null; }
  };
  const updates = Number(q.get('updates') ?? 50);
  log(`Ход мира: два одинаковых мира ещё ${updates} обновлений минерала — CPU и с этапами 2–3 на видеокарте`);
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
    results.push({ stage: 3, seed, step: start, ok });
    log(`  сид ${seed}: минерал всего ${before.toFixed(6)} → CPU ${ta.toFixed(6)}, видеокарта ${tb.toFixed(6)}; `
      + `в среде CPU ${mineralInMedium(a.mineral).toFixed(1)} / видеокарта ${mineralInMedium(b.mineral).toFixed(1)}, в залежах ${mineralInDeposits(a.terrain).toFixed(1)} / ${mineralInDeposits(b.terrain).toFixed(1)}; `
      + `время ${(cpuMs / 1000).toFixed(1)} / ${(gpuMs / 1000).toFixed(1)} с — ${ok ? 'да' : 'НЕТ'}`);
  }
  log(results.every((r) => r.ok) ? 'Всё сходится.' : 'ЕСТЬ РАСХОЖДЕНИЯ.');
  state.done = true;
}
main().catch((e) => { log('ОШИБКА: ' + (e instanceof Error ? e.message : String(e))); state.done = true; });
