/// <reference types="@webgpu/types" />
/**
 * Проверка движка неживого мира на видеокарте (план docs/plan/world-gpu-engine.md):
 * несколько настоящих миров, каждый — CPU против видеокарты. Этап 1 — загрузка →
 * снимок: состояние возвращается тем же, суммы долей равны. Следующие этапы
 * добавляют сюда сравнения своих этапов обновления минерала.
 */
import {
  createWorld, DRIFT_PERIOD, groundTotal, makeParams, mineralInDeposits, mineralInMedium, MINERAL_PERIOD, stepWorld, stepWorldTask, surfaceTask,
  type DriftAccelerator, type DriftStage, type MineralAccelerator, type SurfaceStage, type TerrainState, type World,
} from '../core/index.ts';
import { finishCalculation, type Calculation } from '../core/task.ts';
import { pushSystem, solvePushSystem, type PushField } from '../core/push.ts';
import { GpuWorld, mineralTotal } from './engine.ts';

const out = document.getElementById('out')!;
const log = (s: string) => { out.textContent += s + '\n'; };
const q = new URLSearchParams(location.search);
const seeds = (q.get('seeds') ?? '1,2,3').split(',').map(Number);
const steps = (q.get('steps') ?? '0,20000,50000').split(',').map(Number);
const results: { stage: number; seed: number; step: number; ok: boolean }[] = [];

const copyTerrain = (t: TerrainState): TerrainState => ({ ...t, ground: Float64Array.from(t.ground), deposits: Float64Array.from(t.deposits) });
/** Вход и выход этапа «поверхность» на CPU — снятые «шпионом» на месте ускорителя во время настоящего шага ядра. */
interface Captured { tail: { sunk: number; drowned: number; debt: number } | null; input: SurfaceStage; tvx: Float32Array; tvy: Float32Array; out: Float64Array; deposits: Float64Array; ground: Float64Array; lift: Float32Array }
function* spy(world: World, into: Partial<Captured>): Calculation {
  const accel: MineralAccelerator = {
    sumsFlows: true,
    doesTail: true,
    *surface(st) {
      const n = st.src.length;
      const input: SurfaceStage = { ...st, src: Float64Array.from(st.src), dst: new Float64Array(n), out: new Float64Array(n), terrain: copyTerrain(st.terrain),
        erosionOut: new Float32Array(n), settlingOut: new Float32Array(n), lift: new Float32Array(n), net: new Float32Array(n),
        tvx: new Float32Array(n), tvy: new Float32Array(n), ...(st.flows ? { flows: { ...st.flows, pushX: new Float32Array(n), pushY: new Float32Array(n) } } : {}),
        ...(st.tail ? { tail: { ...st.tail, sinking: new Float32Array(n), tectonic: new Float32Array(n), result: { sunk: 0, drowned: 0, debt: 0 } } } : {}) };
      const debt0 = st.terrain.debt;
      const lift0 = Float32Array.from(st.lift);
      yield* surfaceTask(st);
      Object.assign(into, { tail: st.tail ? { ...st.tail.result, debt: st.terrain.debt - debt0 + st.tail.result.debt } : null, input, tvx: Float32Array.from(st.tvx), tvy: Float32Array.from(st.tvy), out: Float64Array.from(st.out), deposits: Float64Array.from(st.terrain.deposits), ground: Float64Array.from(st.terrain.ground),
        lift: Float32Array.from(st.lift, (v, k) => v - lift0[k]) });
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
  log('Этапы 2–4: поверхность (перенос, растекание, оседание и размыв, грунт, стекание) — ядро против видеокарты на одном входе');
  for (const seed of seeds) {
    const world = createWorld(makeParams({ seed }));
    for (const target of steps.filter((x) => x > 0)) {
      while (world.step < target - 1) stepWorld(world);
      gpu.attach(world);
      const c: Partial<Captured> = {};
      finishCalculation(spy(world, c));
      const cap = c as Captured, inp = cap.input;
      const r = await gpu.mineral.surface(inp, gpu.mineralExponent, gpu.groundExponent, inp.flows && gpu.flowBuffers(inp.flows));
      let fNum = 0, fDen = 0;
      for (let k = 0; k < cap.tvx.length; k++) { fNum += (cap.tvx[k] - inp.tvx[k]) ** 2 + (cap.tvy[k] - inp.tvy[k]) ** 2; fDen += cap.tvx[k] ** 2 + cap.tvy[k] ** 2; }
      const dFlow = fDen > 0 ? Math.sqrt(fNum / fDen) : 0;
      const dField = relDiff(cap.out, inp.out), dDep = relDiff(cap.deposits, inp.terrain.deposits), dGround = relDiff(cap.ground, inp.terrain.ground);
      const dLift = relDiff(cap.lift, inp.lift);
      // Подъём грунта — показ с порогом срыва: клетки у самого порога от разницы f32 в течениях срываются или нет — до ~0,5%.
      const tg = inp.tail?.result, tc = cap.tail;
      const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(1e-9, Math.abs(b));
      const tailText = tg && tc ? `хвост: воронок ${inp.tail!.funnels.length}, подвижек ${inp.tail!.moves.length}, бросков ${inp.tail!.spills.length}; в недра ${tg.sunk.toFixed(4)}/${tc.sunk.toFixed(4)}, утоплено ${tg.drowned.toFixed(4)}/${tc.drowned.toFixed(4)}, долг ${tg.debt.toFixed(4)}/${tc.debt.toFixed(4)} (видеокарта/ядро); ` : '';
      const tailOk = !tg || !tc || (rel(tg.sunk, tc.sunk) < 1e-3 && rel(tg.drowned, tc.drowned) < 1e-3 && Math.abs(tg.debt - tc.debt) < 1e-3 * Math.max(1, tc.debt));
      const ok = tailOk && r.exact && dField < 1e-4 && dDep < 1e-4 && dGround < 1e-6 && dLift < 1e-2 && dFlow < 1e-5;
      results.push({ stage: 4, seed, step: target, ok });
      log(`  сид ${seed}, шаг ${target}: ${tailText}${inp.flows ? `сумма течений на видеокарте (толчков ${inp.flows.pushes.length}) — отличие ${(100 * dFlow).toFixed(6)}%; ` : ''}отличие от ядра — поле ${(100 * dField).toFixed(5)}%, залежи ${(100 * dDep).toFixed(5)}%, грунт ${(100 * dGround).toFixed(7)}%, подъём грунта течением ${(100 * dLift).toFixed(3)}%; `
        + `суммы долей ${r.exact ? 'равны' : 'НЕ равны'}; видеокарта с загрузкой и чтением ${r.ms.toFixed(1)} мс — ${ok ? 'да' : 'НЕТ'}`);
    }
  }
  log('Этап 5: поле течений от света — ядро против видеокарты на одном входе');
  for (const seed of seeds) {
    const world = createWorld(makeParams({ seed }));
    for (const target of steps.filter((x) => x > 0)) {
      while (world.step < target) stepWorld(world);
      // Шпион: запоминает вход и отдаёт расчёт ядру; узлы — заведомо ещё не посчитанные.
      const stages: DriftStage[] = [];
      world.drift.accelerator = { *field(st) { stages.push(st); return null; } } satisfies DriftAccelerator;
      const t = (Math.floor(world.step / DRIFT_PERIOD) + 10) * DRIFT_PERIOD;
      const t0 = performance.now();
      const cpu = finishCalculation(world.drift.nodesTask(t));
      const cpuMs = (performance.now() - t0) / 2;
      world.drift.accelerator = null;
      for (const [st, ref] of [[stages[0], cpu.a], [stages[1], cpu.b]] as const) {
        const r = await gpu.drift.field(st);
        if (r.rebuilt) { const tr = await gpu.drift.timeRebuild(st); log(`    пересборка: всё ${tr.all.toFixed(1)} мс, матрица одна ${tr.matrix.toFixed(1)} мс`); }
        let num = 0, den = 0, maxV = 0;
        for (let k = 0; k < ref.vx.length; k++) {
          num += (r.field.vx[k] - ref.vx[k]) ** 2 + (r.field.vy[k] - ref.vy[k]) ** 2;
          den += ref.vx[k] ** 2 + ref.vy[k] ** 2;
          maxV = Math.max(maxV, Math.hypot(ref.vx[k], ref.vy[k]));
        }
        const diff = den > 0 ? Math.sqrt(num / den) : 0;
        const ok = diff < 0.005;
        results.push({ stage: 5, seed, step: st.t, ok });
        log(`  сид ${seed}, узел ${st.t}: отличие скоростей ${(100 * diff).toFixed(3)}% (наибольшая скорость ${maxV.toFixed(3)} за шаг); `
          + `шагов решателя ${r.iterations}, отправок ${r.submits}${r.rebuilt ? `, матрица грубой сетки построена (подготовка ${r.prepMs.toFixed(1)} мс)` : ''}; CPU ${cpuMs.toFixed(1)} мс, видеокарта с чтением ${r.ms.toFixed(1)} мс — ${ok ? 'да' : 'НЕТ'}`);
      }
    }
  }

  log('Этап 6: единичное течение толчка — ядро (70 итераций), видеокарта (70, шахматный обход) и точное решение (3000 итераций)');
  const velDiff = (a: PushField, b: PushField) => { let num = 0, den = 0; for (let q = 0; q < a.vx.length; q++) { num += (a.vx[q] - b.vx[q]) ** 2 + (a.vy[q] - b.vy[q]) ** 2; den += b.vx[q] ** 2 + b.vy[q] ** 2; } return den > 0 ? Math.sqrt(num / den) : 0; };
  for (const seed of seeds) {
    const world = createWorld(makeParams({ seed }));
    while (world.step < (steps[1] ?? 20000)) stepWorld(world);
    const m = world.mineral;
    // Источники мира (вулканы, воронки) и три клетки воды — чтобы проверка была всегда.
    const sources: { name: string; seeds: number[] }[] = [];
    for (const v of m.volcanoes) sources.push({ name: `вулкан ${v.id}`, seeds: [Math.floor(v.y / m.cell) * m.cols + Math.floor(v.x / m.cell)] });
    for (const f of m.funnels) sources.push({ name: `воронка ${f.id}`, seeds: Array.from(f.cells) });
    for (const [fx, fy] of [[0.3, 0.4], [0.6, 0.6], [0.8, 0.3]]) {
      let k = Math.floor(fy * m.rows) * m.cols + Math.floor(fx * m.cols);
      while (m.blocked[k] && k < m.cols * m.rows - 1) k++;
      sources.push({ name: `клетка ${k}`, seeds: [k] });
    }
    for (const src of sources.slice(0, 6)) {
      const sys = pushSystem(m, world.terrain.applied, src.seeds);
      const t0 = performance.now(); const cpu = solvePushSystem(sys); const cpuMs = performance.now() - t0;
      const exact = solvePushSystem(sys, 3000);
      const r = await gpu.push.solve(sys);
      const eCpu = velDiff(cpu, exact), eGpu = velDiff(r.field, exact), dCg = velDiff(r.field, cpu);
      const ok = eGpu <= Math.max(0.05, 1.5 * eCpu);
      results.push({ stage: 6, seed, step: world.step, ok });
      log(`  сид ${seed}, ${src.name} (окно ${sys.w}×${sys.h}): отличие от точного — ядро ${(100 * eCpu).toFixed(2)}%, видеокарта ${(100 * eGpu).toFixed(2)}%; видеокарта от ядра ${(100 * dCg).toFixed(2)}%; `
        + `ядро ${cpuMs.toFixed(1)} мс, видеокарта с чтением ${r.ms.toFixed(1)} мс — ${ok ? 'да' : 'НЕТ'}`);
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
    sumsFlows: true,
    doesTail: true,
    *surface(st) { yield* wait(gpu.mineral.surface(st, gpu.mineralExponent, gpu.groundExponent, st.flows && gpu.flowBuffers(st.flows))); },
    push: { *solve(sys) { return (yield* wait(gpu.push.solve(sys))).field; } },
  };
  const driftAccel: DriftAccelerator = { *field(st) { return (yield* wait(gpu.drift.field(st))).field; } };
  const stepWith = async (w: World) => {
    w.drift.accelerator = driftAccel;
    const task = stepWorldTask(w, accel);
    while (!task.next().done) if (pending) { await pending; pending = null; }
  };
  const updates = Number(q.get('updates') ?? 50);
  log(`Ход мира: два одинаковых мира ещё ${updates} обновлений минерала — CPU и с поверхностью и течениями на видеокарте`);
  for (const seed of seeds) {
    const a = createWorld(makeParams({ seed })), b = createWorld(makeParams({ seed }));
    const start = steps[1] ?? 20000;
    while (a.step < start) { stepWorld(a); stepWorld(b); }
    gpu.attach(b);
    const before = mineralTotal(a), groundA0 = groundTotal(a.terrain);
    const t0 = performance.now();
    while (a.step < start + updates * MINERAL_PERIOD) stepWorld(a);
    const cpuMs = performance.now() - t0, t1 = performance.now();
    while (b.step < start + updates * MINERAL_PERIOD) await stepWith(b);
    const gpuMs = performance.now() - t1;
    const ta = mineralTotal(a), tb = mineralTotal(b);
    const ok = Math.abs(tb - before) < 1e-3 * updates * 1e-3 + 1e-6 * before && Math.abs(groundTotal(b.terrain) - groundTotal(a.terrain)) < 1e-3;
    results.push({ stage: 5, seed, step: start, ok });
    log(`  сид ${seed}: минерал всего ${before.toFixed(6)} → CPU ${ta.toFixed(6)}, видеокарта ${tb.toFixed(6)}; `
      + `в среде CPU ${mineralInMedium(a.mineral).toFixed(1)} / видеокарта ${mineralInMedium(b.mineral).toFixed(1)}, в залежах ${mineralInDeposits(a.terrain).toFixed(1)} / ${mineralInDeposits(b.terrain).toFixed(1)}; `
      + `грунт ${groundA0.toFixed(3)} → CPU ${groundTotal(a.terrain).toFixed(3)}, видеокарта ${groundTotal(b.terrain).toFixed(3)}; `
      + `время ${(cpuMs / 1000).toFixed(1)} / ${(gpuMs / 1000).toFixed(1)} с — ${ok ? 'да' : 'НЕТ'}`);
  }
  log(results.every((r) => r.ok) ? 'Всё сходится.' : 'ЕСТЬ РАСХОЖДЕНИЯ.');
  state.done = true;
}
main().catch((e) => { log('ОШИБКА: ' + (e instanceof Error ? e.message : String(e))); state.done = true; });
