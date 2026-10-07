/// <reference types="@webgpu/types" />
/**
 * Проверка режима без ожидания (этап 7в плана docs/plan/world-gpu-engine.md): поле, залежи и грунт живут
 * на видеокарте, обновления уходят подряд, массивы мира — снимок с отставанием. Мир против CPU-мира:
 * суммы долей сходятся на каждом принятом снимке, минерал и грунт сохраняются, число несошедшихся — нуль.
 * `mode=sync` — то же с ожиданием после каждого обновления (прежний путь) для сравнения.
 */
import {
  applySnapshot, createWorld, groundTotal, makeParams, mineralInDeposits, mineralInMedium, MINERAL_PERIOD, snapshotTargets, stepWorld, stepWorldTask,
  type DriftAccelerator, type MineralAccelerator, type World,
} from '../core/index.ts';
import { GpuWorld, mineralTotal } from './engine.ts';

const out = document.getElementById('out')!;
const log = (s: string) => { out.textContent += s + '\n'; };
const q = new URLSearchParams(location.search);
const seeds = (q.get('seeds') ?? '1,2,3').split(',').map(Number);
const from = Number(q.get('from') ?? 0);
const updates = Number(q.get('updates') ?? 2000);
const mode = q.get('mode') ?? 'both';
const results: { seed: number; mode: string; ok: boolean }[] = [];
const state = { results, done: false };
(window as unknown as { residentCheck: typeof state }).residentCheck = state;

const yieldToCallbacks = () => new Promise<void>((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });

async function main(): Promise<void> {
  const gpu = await GpuWorld.create();
  if (typeof gpu === 'string') { log(`Видеокарта недоступна: ${gpu}`); state.done = true; return; }
  let pending: Promise<unknown> | null = null;
  const wait = function* <T>(job: Promise<T>): Generator<void, T, void> {
    let done = false, value: T | undefined;
    pending = job.then((v) => { value = v; }).finally(() => { done = true; });
    while (!done) yield;
    return value as T;
  };
  const driftAccel: DriftAccelerator = { *field(st) { return (yield* wait(gpu.drift.field(st))).field; } };
  const gm = gpu.mineral;
  log(`Без ожидания против CPU: с шага ${from} ещё ${updates} обновлений (${updates * MINERAL_PERIOD} шагов)`);

  for (const seed of seeds) {
    for (const kind of mode === 'both' ? ['resident', 'sync'] : [mode]) {
      const a = createWorld(makeParams({ seed })), b = createWorld(makeParams({ seed }));
      while (a.step < from) { stepWorld(a); stepWorld(b); }
      gpu.attach(b);
      const end = from + updates * MINERAL_PERIOD;
      const before = mineralTotal(a), ground0 = groundTotal(a.terrain);
      const t0 = performance.now();
      while (a.step < end) stepWorld(a);
      const cpuMs = performance.now() - t0;
      let maxDiff = 0, diffSteps: string[] = [], inexact = 0, snapshots = 0, folds = 0, aheadWaits = 0, firstBad: string | undefined;
      const t1 = performance.now();
      if (kind === 'resident') {
        const fold = (w: World) => {
          if (!gm.hasSnapshots || !gm.loaded(w.mineral)) return;
          const sums = gm.fold(snapshotTargets(w.mineral, w.terrain));
          if (!sums) return;
          folds++; snapshots += sums.snapshots;
          if (Math.abs(sums.diff) > Math.abs(maxDiff)) maxDiff = sums.diff;
          if (sums.diff !== 0 && diffSteps.length < 12) diffSteps.push(`${w.step}:${sums.diff}`);
          if (!sums.exact) { inexact++; firstBad ??= `шаг ${w.step}: ${sums.mismatch}`; } else applySnapshot(w.mineral, w.terrain, sums);
        };
        const accel: MineralAccelerator = {
          sumsFlows: true, doesTail: true, resident: true,
          *surface(st) {
            if (!gm.loaded(st.m)) gm.load(st, gpu.mineralExponent, gpu.groundExponent);
            const ahead = gm.ahead();
            if (ahead) { aheadWaits++; yield* wait(ahead); }
            gm.submit(st, gpu.flowBuffers(st.flows!));
          },
          push: { *solve(sys) { return (yield* wait(gpu.push.solve(sys))).field; } },
        };
        while (b.step < end) {
          fold(b);
          b.drift.accelerator = driftAccel;
          const task = stepWorldTask(b, accel);
          while (!task.next().done) if (pending) { await pending; pending = null; }
          if (b.step % MINERAL_PERIOD === 0) await yieldToCallbacks();
        }
        const flushed = await gm.flush(snapshotTargets(b.mineral, b.terrain));
        if (flushed) { if (!flushed.exact) { inexact++; firstBad ??= `завершение: ${flushed.mismatch}`; } else applySnapshot(b.mineral, b.terrain, flushed); }
        gm.release();
      } else {
        const accel: MineralAccelerator = {
          sumsFlows: true, doesTail: true,
          *surface(st) {
            const r = yield* wait(gm.surface(st, gpu.mineralExponent, gpu.groundExponent, st.flows && gpu.flowBuffers(st.flows)));
            folds++;
            if (!r.exact) { inexact++; firstBad ??= `шаг ${b.step}`; }
          },
          push: { *solve(sys) { return (yield* wait(gpu.push.solve(sys))).field; } },
        };
        while (b.step < end) {
          b.drift.accelerator = driftAccel;
          const task = stepWorldTask(b, accel);
          while (!task.next().done) if (pending) { await pending; pending = null; }
        }
      }
      const gpuMs = performance.now() - t1;
      const ta = mineralTotal(a), tb = mineralTotal(b);
      const ok = inexact === 0 && Math.abs(tb - before) < 1e-6 * before && Math.abs(groundTotal(b.terrain) - groundTotal(a.terrain)) < 1e-6 * ground0;
      results.push({ seed, mode: kind, ok });
      log(`  сид ${seed}, ${kind === 'resident' ? 'без ожидания' : 'с ожиданием'}: минерал всего ${before.toFixed(6)} → CPU ${ta.toFixed(6)}, видеокарта ${tb.toFixed(6)}; `
        + `проверок сумм ${folds}${kind === 'resident' ? ` (снимков ${snapshots}, ожиданий отставания ${aheadWaits})` : ''}, несошедшихся ${inexact}${firstBad ? ` — ${firstBad}` : ''}${kind === 'resident' ? `; наибольшая невязка ${maxDiff} долей (${diffSteps.join(' ')})` : ''}; `
        + `в среде CPU ${mineralInMedium(a.mineral).toFixed(1)} / видеокарта ${mineralInMedium(b.mineral).toFixed(1)}, в залежах ${mineralInDeposits(a.terrain).toFixed(1)} / ${mineralInDeposits(b.terrain).toFixed(1)}; `
        + `грунт ${ground0.toFixed(3)} → CPU ${groundTotal(a.terrain).toFixed(3)}, видеокарта ${groundTotal(b.terrain).toFixed(3)}; `
        + `время CPU ${(cpuMs / 1000).toFixed(2)} с, видеокарта ${(gpuMs / 1000).toFixed(2)} с (${Math.round(updates * MINERAL_PERIOD / (gpuMs / 1000))} шагов/с) — ${ok ? 'да' : 'НЕТ'}`);
    }
  }
  log(results.every((r) => r.ok) ? 'Всё сходится.' : 'ЕСТЬ РАСХОЖДЕНИЯ.');
  state.done = true;
}
main().catch((e) => { log('ОШИБКА: ' + (e instanceof Error ? e.stack ?? e.message : String(e))); state.done = true; });
