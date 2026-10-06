/** Мир считает шаги независимо от кадров; показ получает не больше 20 снимков/с. */
import { createWorld, mineralExchanges, mineralProcesses, takeGroundChanges, DRIFT_PERIOD, MINERAL_PERIOD, parseWorldFile, serializeWorld, setWorldLaws, stepWorldTask, WorldFileError, type World } from '../core/index.ts';
import type { ComputeMode, ComputeState, SimulationCommand, SimulationReply, SimulationSnapshot } from './simulation.ts';
import { GpuWorld, type RoundTrip } from '../gpu-world/engine.ts';
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
let lastRoundTrip: RoundTrip | null = null;

function computeState(): ComputeState {
  const r = lastRoundTrip;
  return { mode: computeMode, unavailable: gpuUnavailable,
    ...(r && computeMode === 'gpu' ? { roundTrip: { ms: r.ms, mineralMax: r.mineralMax, groundMax: r.groundMax, exact: r.exact } } : {}) };
}

function useCpu(reason: string): void {
  computeMode = 'cpu'; gpu = null; gpuUnavailable = reason; lastRoundTrip = null;
}

function requestCompute(mode: ComputeMode): void {
  if (mode === 'cpu') { computeMode = 'cpu'; lastRoundTrip = null; return; }
  if (gpu?.usable) { computeMode = 'gpu'; return; }
  if (gpuStarting) return;
  gpuStarting = true;
  GpuWorld.create().then((result) => {
    if (typeof result === 'string') useCpu(result);
    else { gpu = result; gpuUnavailable = null; computeMode = 'gpu'; }
  }, (error) => useCpu(`видеокарта не запустилась: ${String(error)}`)).finally(() => {
    gpuStarting = false;
    publish(false, true);
  });
}

/** Этап 1 плана: мир считает CPU, после обновления минерала состояние проходит видеокарту туда и обратно. */
function* gpuExchange(next: World): Generator<void, void, void> {
  if (!gpu) return;
  if (!gpu.usable) { useCpu('устройство видеокарты потеряно'); return; }
  let done = false;
  waiting = gpu.roundTrip(next).then((r) => {
    lastRoundTrip = r;
    if (!r.exact) host.postMessage({ type: 'error', epoch, problems: ['Видеокарта: суммы долей после обмена не совпали — расчёт возвращён на процессор'] });
    if (!r.exact) useCpu('суммы долей после обмена не совпали');
  }, (error) => useCpu(`ошибка видеокарты: ${String(error)}`)).finally(() => { done = true; waiting = null; });
  while (!done) yield;
}

/** Снимок включает готовые узлы поля: publish никогда не запускает решатель. */
function* calculateStep(next: World): Generator<void, void, void> {
  yield* stepWorldTask(next);
  if (computeMode === 'gpu' && next.step % MINERAL_PERIOD === 0) yield* gpuExchange(next);
  const key = `${next.viscosity.version}:${Math.floor(next.step / DRIFT_PERIOD)}`;
  if (key !== preparedDriftKey) {
    yield* next.drift.nodesTask(next.step);
    preparedDriftKey = key;
  }
}


/** Копии передаются с отдачей буферов; массивы самого мира никогда не отсоединяются. */
function publish(initial = false, force = false): void {
  if (!world || calculation || (inFlight && !force)) return;
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
  if (!world || ((paused || !active) && !calculation)) return;
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
    if (publishOnCompletion) { publishOnCompletion = false; publish(false, true); }
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
        if (world) host.postMessage({ type: 'saved', epoch, id: command.id, text: serializeWorld(world, new Date()), step: world.step, seed: world.params.seed });
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
