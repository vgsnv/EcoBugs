/** Мир считает шаги независимо от кадров; показ получает не больше 20 снимков/с. */
import { applySnapshot, createWorld, mineralExchanges, mineralProcesses, snapshotTargets, surfaceTask, takeGroundChanges, type DriftAccelerator, DRIFT_PERIOD, parseWorldFile, serializeWorld, setWorldLaws, stepWorldTask, WorldFileError, type MineralAccelerator, type World } from '../core/index.ts';
import type { ComputeMode, ComputeState, SimulationCommand, SimulationReply, SimulationSnapshot } from './simulation.ts';
import { GpuWorld } from '../gpu-world/engine.ts';
import { STEPS_PER_SECOND } from '../core/units.ts';

// Отдельный интерфейс сохраняет проверку типов без подключения DOM + WebWorker lib вместе.
const host = self as unknown as {
  onmessage: ((event: MessageEvent<SimulationCommand>) => void) | null;
  postMessage(message: SimulationReply, transfer?: Transferable[]): void;
};
const BASE_RATE = STEPS_PER_SECOND;
const SLICE_MS = 6;
const SNAPSHOT_MS = 50;
/** Наибольшее отставание, которое мир догоняет, — в секундах реального времени. */
const MAX_DEBT = 0.25;
let world: World | null = null;
let epoch = 0, paused = false, speed = 1, active = true;
let carry = 0, lastTime = performance.now(), lastSnapshot = 0;
let rate = 0, behind = false, inFlight = false, driftKey = '';
let showProcesses = false;
let sentMineralVersion = -1, sentViscosityVersion = -1;
let timer: ReturnType<typeof setTimeout> | undefined;
let calculation: Generator<void, void, void> | null = null;
let preparedDriftKey = '';
let publishOnCompletion = false;
let scheduleId = 0, immediateSlices = 0;
const wake = new MessageChannel();
wake.port1.onmessage = ({ data }: MessageEvent<number>) => { if (data === scheduleId) tick(); };
const commands: SimulationCommand[] = [];

// Расчёт на видеокарте (план docs/plan/world-gpu-engine.md). Пока ожидается ответ видеокарты,
// шаг не крутится вхолостую: Worker засыпает и продолжает, когда ответ готов.
let computeMode: ComputeMode = 'cpu';
let gpu: GpuWorld | null = null;
let gpuUnavailable: string | null = null;
let gpuStarting = false;
let waiting: Promise<void> | null = null;
function computeState(): ComputeState {
  return { mode: computeMode, unavailable: gpuUnavailable, ...(computeMode === 'gpu' && lastStages.surface > 0 ? { stages: { surface: lastStages.surface, parts: [...lastStages.parts], drift: lastStages.drift, driftIterations: lastStages.driftIterations, push: lastStages.push } } : {}) };
}

function useCpu(reason: string): void {
  computeMode = 'cpu'; gpu = null; gpuUnavailable = reason;
}

function requestCompute(mode: ComputeMode): void {
  if (mode === 'cpu') {
    // Состояние живёт на видеокарте: сначала дочитать его в мир, и только потом считать на процессоре.
    if (computeMode === 'gpu' && gpu && world && gpu.mineral.loaded(world.mineral)) holdWorker(flushGpu(true), () => { computeMode = 'cpu'; publish(false, true); });
    else computeMode = 'cpu';
    return;
  }
  if (gpu?.usable) { computeMode = 'gpu'; return; }
  if (gpuStarting) return;
  gpuStarting = true;
  GpuWorld.create().then((result) => {
    if (typeof result === 'string') useCpu(result);
    else { gpu = result; gpu.mineral.onReady = onSnapshotReady; gpuUnavailable = null; computeMode = 'gpu'; }
  }, (error) => useCpu(`видеокарта не запустилась: ${String(error)}`)).finally(() => {
    gpuStarting = false;
    publish(false, true);
  });
}

/** Дождаться видеокарты, не крутясь вхолостую: Worker засыпает, пока ответ не готов. */
function* awaitGpu<T>(job: Promise<T>): Generator<void, T | null, void> {
  let done = false, result: T | null = null;
  waiting = job.then((r) => { result = r; }, (error) => useCpu(`ошибка видеокарты: ${String(error)}`)).finally(() => { done = true; waiting = null; });
  while (!done) yield;
  return result;
}

// Состояние (поле, залежи, грунт) живёт на видеокарте; массивы мира — снимок с отставанием.
// Мир стоит (`hold`), пока снимок дочитывается целиком: перед сохранением, переключением на процессор и по шагу.
let hold: Promise<void> | null = null;
function holdWorker(job: Promise<void>, then: () => void): void {
  hold = job.then(then).finally(() => { hold = null; schedule(); });
}

/** Принять готовые снимки с видеокарты в массивы мира (между обновлениями). */
function foldGpu(): void {
  const g = gpu, w = world;
  if (!g || !w || !g.mineral.hasSnapshots || !g.mineral.loaded(w.mineral)) return;
  const t0 = performance.now();
  const sums = g.mineral.fold(snapshotTargets(w.mineral, w.terrain));
  if (!sums) return;
  if (!sums.exact) { gpuFailed({ exact: false }, g, sums.mismatch); return; }
  applySnapshot(w.mineral, w.terrain, sums);
  lastStages.parts[2] = performance.now() - t0;
}

/** Дочитать состояние с видеокарты в мир целиком; `release` — после этого мир считает процессор. */
async function flushGpu(release: boolean): Promise<void> {
  const g = gpu, w = world;
  if (!g || !w || !g.mineral.loaded(w.mineral)) return;
  try {
    const sums = await g.mineral.flush(snapshotTargets(w.mineral, w.terrain));
    if (sums && !sums.exact) gpuFailed({ exact: false }, g, sums.mismatch);
    else if (sums && world === w) applySnapshot(w.mineral, w.terrain, sums);
    if (release) g.mineral.release();
  } catch (error) { useCpu(`ошибка видеокарты: ${String(error)}`); }
}

/** Снимок прочитан, а мир стоит: принять и показать (на ходу его подхватит следующее обновление и публикация). */
function onSnapshotReady(): void {
  if (calculation || hold || !(paused || !active)) return;
  foldGpu();
  publish(false, true);
}

/** Этапы обновления минерала на видеокарте; что не перенесено — считает ядро. */
const accelerator: MineralAccelerator = {
  sumsFlows: true,
  doesTail: true,
  resident: true,
  *surface(a) {
    const g = gpu, t0 = performance.now();
    if (g?.usable && world && a.flows) {
      try {
        const gm = g.mineral;
        if (!gm.loaded(a.m)) { g.attach(world); gm.load(a, g.mineralExponent, g.groundExponent); }
        // Обновления уходят без ожидания; ждём, только если видеокарта отстаёт больше чем на несколько штук.
        const ahead = gm.ahead();
        let waited = 0;
        if (ahead) { const w0 = performance.now(); yield* awaitGpu(ahead); waited = performance.now() - w0; }
        if (gpu === g && g.usable) {
          gm.submit(a, g.flowBuffers(a.flows));
          lastStages.surface = performance.now() - t0; lastStages.parts[0] = lastStages.surface - waited; lastStages.parts[1] = waited;
          return;
        }
      } catch (error) { useCpu(`ошибка видеокарты: ${String(error)}`); }
    }
    gpuFailed(null, g);
    // Видеокарта пропала: обновление считает процессор по последнему принятому снимку.
    const t = snapshotTargets(a.m, a.terrain);
    a.dst.fill(0); t.erosion.fill(0); t.settling.fill(0); t.sinking.fill(0);
    yield* surfaceTask(a);
    a.m.field = a.out;
    applySnapshot(a.m, a.terrain, { sunk: 0, drowned: 0, debt: 0 });
  },
  push: {
    *solve(sys) {
      const g = gpu;
      if (!g?.usable) return null;
      const run = yield* awaitGpu(g.push.solve(sys));
      if (!run) { gpuFailed(null, g); return null; }
      lastStages.push = run.ms;
      return run.field;
    },
  },
};
/** Последний этап на видеокарте: время с ожиданием, мс, и его части. */
const lastStages = { surface: 0, parts: [0, 0, 0], drift: 0, driftIterations: 0, push: 0 };

/** Поле течений на видеокарте; null — пусть считает ядро. */
const driftAccelerator: DriftAccelerator = {
  *field(stage) {
    const g = gpu;
    if (!g?.usable) return null;
    const run = yield* awaitGpu(g.drift.field(stage));
    if (!run) { gpuFailed(null, g); return null; }
    lastStages.drift = run.ms; lastStages.driftIterations = run.iterations;
    return run.field;
  },
};

function gpuFailed(run: { exact: boolean } | null, g: GpuWorld | null, detail = ''): void {
  if (run && !run.exact) {
    useCpu(`суммы долей после этапа не совпали${detail ? ` (${detail})` : ''}`);
    host.postMessage({ type: 'error', epoch, problems: [`Видеокарта: суммы долей после этапа не совпали${detail ? ` (${detail})` : ''} — расчёт возвращён на процессор`] });
  } else if (g && !g.usable) useCpu(g.error ? `ошибка видеокарты: ${g.error}` : 'устройство видеокарты потеряно');
}

/** Снимок включает готовые узлы поля: publish никогда не запускает решатель. */
function* calculateStep(next: World): Generator<void, void, void> {
  foldGpu();
  if (computeMode === 'gpu' && gpu && !gpu.attached(next)) gpu.attach(next);
  next.drift.accelerator = computeMode === 'gpu' && gpu ? driftAccelerator : null;
  yield* stepWorldTask(next, computeMode === 'gpu' && gpu ? accelerator : undefined);
  const key = `${next.viscosity.version}:${Math.floor(next.step / DRIFT_PERIOD)}`;
  if (key !== preparedDriftKey) {
    yield* next.drift.nodesTask(next.step);
    preparedDriftKey = key;
  }
}


/** Копии передаются с отдачей буферов; массивы самого мира никогда не отсоединяются. */
function publish(initial = false, force = false): void {
  if (!world || calculation || (inFlight && !force)) return;
  foldGpu();
  const key = `${world.viscosity.version}:${Math.floor(world.step / DRIFT_PERIOD)}`;
  const drift = key !== driftKey || initial ? world.drift.nodes(world.step) : undefined;
  const geometryChanged = initial || sentViscosityVersion !== world.viscosity.version;
  const mineralChanged = initial || sentMineralVersion !== world.mineral.version;
  const { blocked: _blocked, nearWall: _nearWall, region: _region, ...mineral } = world.mineral;
  const { applied, ...terrain } = world.terrain;
  const state = initial ? {
    initial: { dish: world.dish, params: world.params, light: world.light, partitions: world.partitions },
    mineral: world.mineral, terrain: world.terrain, viscosity: world.viscosity,
  } : {
    ...(mineralChanged ? { mineral } : {}),
    ...(mineralChanged || geometryChanged ? { terrain: { ...terrain, ...(geometryChanged ? { applied } : {}) } } : {}),
    ...(geometryChanged ? { viscosity: world.viscosity } : {}),
  };
  const message: SimulationSnapshot = structuredClone({
    type: 'snapshot', epoch, ...state,
    ...(showProcesses ? { processes: mineralProcesses(world.mineral) } : {}),
    ...(mineralChanged ? { ground: takeGroundChanges(world.mineral) } : {}),
    exchanges: mineralExchanges(world.mineral), step: world.step, light: world.light,
    ...(drift ? { drift: { a: drift.a, b: drift.b } } : {}), rate: paused ? 0 : rate, behind, compute: computeState(),
  });
  const buffers = new Set<ArrayBuffer>();
  const visit = (value: unknown): void => {
    if (ArrayBuffer.isView(value)) buffers.add(value.buffer as ArrayBuffer);
    else if (value && typeof value === 'object') for (const child of Object.values(value)) visit(child);
  };
  visit(message);
  host.postMessage(message, [...buffers]);
  driftKey = key;
  sentMineralVersion = world.mineral.version; sentViscosityVersion = world.viscosity.version;
  inFlight = true;
  lastSnapshot = performance.now();
}

function schedule(delay = 0): void {
  clearTimeout(timer);
  const id = ++scheduleId;
  // Периодически отдаём очередь таймеру: непрерывная цепочка сообщений
  // не должна вытеснять команды и другие источники событий.
  if (delay <= 0 && ++immediateSlices < 4) wake.port2.postMessage(id);
  else {
    immediateSlices = 0;
    timer = setTimeout(() => { if (id === scheduleId) tick(); }, Math.max(0, delay));
  }
}

function tick(): void {
  try { advance(); }
  catch (error) {
    paused = true; rate = 0; calculation = null; commands.length = 0; clearTimeout(timer);
    host.postMessage({ type: 'error', epoch, fatal: true, problems: [String(error)] });
  }
}

function advance(): void {
  if (hold || !world || ((paused || !active) && !calculation)) return;
  const start = performance.now();
  const dt = Math.min(0.25, (start - lastTime) / 1000);
  lastTime = start;
  if (!paused && active) carry += dt * BASE_RATE * speed;
  const want = paused || !active ? 0 : Math.floor(carry);
  let n = 0;
  while (n < want || calculation) {
    calculation ??= calculateStep(world);
    const finished = calculation.next().done;
    if (waiting) break;
    if (finished) {
      calculation = null; n++;
      // Выйти на готовом состоянии, прежде чем начать следующее тяжёлое обновление.
      if (performance.now() - lastSnapshot >= SNAPSHOT_MS) break;
    }
    if (performance.now() - start >= SLICE_MS || (!calculation && commands.length)) break;
  }
  // Отставание не сбрасывается, а ограничивается: иначе после сброса Worker
  // засыпает, хотя мог бы считать, и упирается в предел раньше, чем позволяет физика.
  // Предел — когда долг держится у потолка, а не после одного долгого обновления.
  const maxDebt = MAX_DEBT * BASE_RATE * speed;
  carry = paused || !active ? 0 : Math.min(Math.max(0, carry - n), maxDebt);
  behind = !paused && active && carry >= maxDebt / 2;
  if (dt > 0 && !paused) rate += (n / dt - rate) * Math.min(1, dt * 2);
  if (!calculation) {
    if (publishOnCompletion) {
      publishOnCompletion = false;
      // Шаг по одному: показать мир целиком, а не снимок с отставанием.
      if (gpu && gpu.mineral.loaded(world.mineral)) holdWorker(flushGpu(false), () => publish(false, true));
      else publish(false, true);
    }
    while (!calculation && commands.length) handleCommand(commands.shift()!);
    if (performance.now() - lastSnapshot >= SNAPSHOT_MS) publish();
  }
  if (waiting) { clearTimeout(timer); const id = ++scheduleId; waiting.then(() => { if (id === scheduleId) tick(); }); return; }
  schedule(calculation || carry >= 1 ? 0 : Math.max(1, Math.min(16, (1 - carry) * 1000 / (BASE_RATE * speed))));
}

host.onmessage = ({ data: command }) => {
  if (calculation && command.type !== 'ack') {
    // Частые движения ползунка заменяют только предыдущую соседнюю команду того же рода.
    if ((command.type === 'control' || command.type === 'laws') && commands.at(-1)?.type === command.type) commands.pop();
    commands.push(command);
    return;
  }
  handleCommand(command);
};

function handleCommand(command: SimulationCommand): void {
  if (command.type !== 'create' && command.type !== 'load' && command.epoch !== epoch) return;
  try {
    switch (command.type) {
      case 'create':
      case 'load': {
        // Разбор и проверка контрольной суммы закончены до замены текущего мира.
        const next = command.type === 'create' ? createWorld(command.params) : parseWorldFile(command.text);
        world = next;
        preparedDriftKey = '';
        epoch = command.epoch;
        carry = 0; rate = 0; behind = false; lastTime = performance.now();
        publish(true, true);
        preparedDriftKey = `${next.viscosity.version}:${Math.floor(next.step / DRIFT_PERIOD)}`;
        if (command.type === 'load') host.postMessage({ type: 'loaded', epoch, id: command.id, step: world.step });
        schedule();
        break;
      }
      case 'control':
        paused = command.paused; speed = command.speed; active = command.active;
        carry = 0; behind = false; lastTime = performance.now();
        if (paused) { rate = 0; publish(false, true); }
        schedule();
        break;
      case 'step':
        if (world) {
          paused = true; behind = false;
          calculation = calculateStep(world);
          publishOnCompletion = true;
          schedule();
        }
        break;
      case 'laws':
        if (world) {
          // Между шагами: команды ждут, пока шаг не досчитан.
          const problems = setWorldLaws(world, command.params);
          if (problems.length > 0) host.postMessage({ type: 'error', epoch, problems });
          publish(false, true);
        }
        break;
      case 'save':
        if (world) {
          const w = world, post = () => host.postMessage({ type: 'saved', epoch, id: command.id, text: serializeWorld(w, new Date()), step: w.step, seed: w.params.seed });
          // Сохранение — по точному состоянию, а не по снимку с отставанием.
          if (gpu && gpu.mineral.loaded(w.mineral)) holdWorker(flushGpu(false), post);
          else post();
        }
        break;
      case 'processes':
        showProcesses = command.enabled;
        publish(false, true);
        break;
      case 'compute':
        requestCompute(command.mode);
        publish(false, true);
        break;
      case 'ack':
        inFlight = false;
        break;
    }
  } catch (error) {
    if (command.type === 'create' || command.type === 'load') {
      epoch = command.epoch;
      // Ошибочный файл не оставляет интерфейс в ожидании нового поколения снимков.
      publish(false, true);
      schedule();
    } else { paused = true; clearTimeout(timer); }
    host.postMessage({ type: 'error', epoch, ...('id' in command ? { id: command.id } : {}),
      fatal: command.type !== 'create' && command.type !== 'load',
      problems: error instanceof WorldFileError ? error.problems : [String(error)] });
  }
};
