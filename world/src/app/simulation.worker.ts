/** Мир считает шаги независимо от кадров; показ получает не больше 20 снимков/с. */
import { createWorld, mineralProcesses, DRIFT_PERIOD, parseWorldFile, serializeWorld, stepWorld, WorldFileError, type World } from '../core/index.ts';
import type { SimulationCommand, SimulationReply, SimulationSnapshot } from './simulation.ts';

// Отдельный интерфейс сохраняет проверку типов без подключения DOM + WebWorker lib вместе.
const host = self as unknown as {
  onmessage: ((event: MessageEvent<SimulationCommand>) => void) | null;
  postMessage(message: SimulationReply, transfer?: Transferable[]): void;
};
const BASE_RATE = 30;
const SLICE_MS = 12;
const SNAPSHOT_MS = 50;
let world: World | null = null;
let epoch = 0, paused = false, speed = 1, active = true;
let carry = 0, lastTime = performance.now(), lastSnapshot = 0;
let rate = 0, behind = false, inFlight = false, driftKey = '';
let showProcesses = false;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Копии передаются с отдачей буферов; массивы самого мира никогда не отсоединяются. */
function publish(initial = false, force = false): void {
  if (!world || (inFlight && !force)) return;
  const key = `${world.viscosity.version}:${Math.floor(world.step / DRIFT_PERIOD)}`;
  const drift = key !== driftKey || initial ? world.drift.nodes(world.step) : undefined;
  const message: SimulationSnapshot = structuredClone({
    type: 'snapshot', epoch,
    ...(initial ? { initial: { params: world.params, light: world.light, partitions: world.partitions } } : {}),
    ...(showProcesses ? { processes: mineralProcesses(world.mineral) } : {}),
    step: world.step, mineral: world.mineral, terrain: world.terrain, viscosity: world.viscosity,
    ...(drift ? { drift: { a: drift.a, b: drift.b } } : {}), rate: paused ? 0 : rate, behind,
  });
  const buffers = new Set<ArrayBuffer>();
  const visit = (value: unknown): void => {
    if (ArrayBuffer.isView(value)) buffers.add(value.buffer as ArrayBuffer);
    else if (value && typeof value === 'object') for (const child of Object.values(value)) visit(child);
  };
  visit(message);
  host.postMessage(message, [...buffers]);
  driftKey = key;
  inFlight = true;
  lastSnapshot = performance.now();
}

function schedule(delay = 0): void {
  clearTimeout(timer);
  timer = setTimeout(tick, delay);
}

function tick(): void {
  try { advance(); }
  catch (error) {
    paused = true; rate = 0; clearTimeout(timer);
    host.postMessage({ type: 'error', epoch, fatal: true, problems: [String(error)] });
  }
}

function advance(): void {
  if (!world || paused || !active) return;
  const start = performance.now();
  const dt = Math.min(0.25, (start - lastTime) / 1000);
  lastTime = start;
  carry += dt * BASE_RATE * speed;
  const want = Math.floor(carry);
  let n = 0;
  while (n < want) {
    stepWorld(world);
    n++;
    if ((n & 63) === 0 && performance.now() - start >= SLICE_MS) break;
  }
  behind = n < want;
  carry = behind ? 0 : carry - n;
  if (dt > 0) rate += (n / dt - rate) * Math.min(1, dt * 2);
  if (performance.now() - lastSnapshot >= SNAPSHOT_MS) publish();
  schedule(behind ? 0 : Math.max(1, Math.min(16, (1 - carry) * 1000 / (BASE_RATE * speed))));
}

host.onmessage = ({ data: command }) => {
  if (command.type !== 'create' && command.type !== 'load' && command.epoch !== epoch) return;
  try {
    switch (command.type) {
      case 'create':
      case 'load': {
        // Разбор и проверка контрольной суммы закончены до замены текущего мира.
        const next = command.type === 'create' ? createWorld(command.params) : parseWorldFile(command.text);
        world = next;
        epoch = command.epoch;
        carry = 0; rate = 0; behind = false; lastTime = performance.now();
        publish(true, true);
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
        if (world) { paused = true; stepWorld(world); behind = false; publish(false, true); }
        break;
      case 'save':
        if (world) host.postMessage({ type: 'saved', epoch, id: command.id, text: serializeWorld(world, new Date()), step: world.step, seed: world.params.seed });
        break;
      case 'processes':
        showProcesses = command.enabled;
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
