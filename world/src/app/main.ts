/**
 * Песочница неживой природы: мир, панель параметров, время, слои.
 * Скорость показа — дело приложения; мир знает только номер шага.
 */
import {
  LAYOUT_PRESETS, absorptionAt, createWorld, gradationAt, isBlocked, lightAt, makeParams, mutationStrength,
  resistanceAt, stepWorld, temperatureAt, type World, type WorldParams,
} from '../core/index.ts';
import { Panel } from './panel.ts';
import { WorldRenderer, type Layer } from './render.ts';

/** Шагов в секунду при скорости ×1. */
const BASE_STEPS_PER_SECOND = 30;
/** Больше шагов за кадр не делаем, чтобы не подвесить вкладку. */
const MAX_STEPS_PER_FRAME = 100_000;
const GRADATION_NAMES = ['вода', 'отмель', 'суша'];

const canvas = document.querySelector<HTMLCanvasElement>('#world')!;
const renderer = new WorldRenderer(canvas);

let world: World = createWorld(makeParams({ seed: 1 }));
let layer: Layer = 'light';
let showPartitions = true;
let paused = false;
let speed = 1;
let carry = 0;
let lastTime = performance.now();
let pointer: [number, number] | null = null;

const panel = new Panel(document.querySelector<HTMLElement>('#panel')!, world.params, {
  onCreate: (params: WorldParams) => setWorld(createWorld(params)),
  onTogglePause: () => { paused = !paused; },
  onStepOnce: () => { stepWorld(world); },
  onSpeed: (s) => { speed = s; carry = 0; },
  onLayer: (l) => { layer = l; },
  onPartitions: (show) => { showPartitions = show; },
});

function setWorld(next: World): void {
  world = next;
  renderer.setWorld(world);
  panel.setCurrent(world.params);
  document.title = `Песочница мира · ${LAYOUT_PRESETS[world.params.layout].name}`;
}

canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  pointer = [((e.clientX - rect.left) / rect.width) * world.params.width, ((e.clientY - rect.top) / rect.height) * world.params.height];
});
canvas.addEventListener('mouseleave', () => { pointer = null; });

function probe(): void {
  if (!pointer) { panel.setProbe(null); return; }
  const [x, y] = pointer;
  const p = world.params;
  if (isBlocked(world.partitions, x, y) && world.partitions.partitions.length > 0 && x >= 0 && y >= 0 && x < p.width && y < p.height) {
    panel.setProbe([`(${Math.round(x)}, ${Math.round(y)})`, 'Перегородка']);
    return;
  }
  const temp = temperatureAt(p, world.light, x, y, world.step);
  panel.setProbe([
    `(${Math.round(x)}, ${Math.round(y)})`,
    `Свет: ${lightAt(world.light, x, y, world.step).toFixed(3)}`,
    `Температура: ${temp.toFixed(2)} · сила мутаций ${mutationStrength(temp).toFixed(2)}`,
    `Градация: ${GRADATION_NAMES[gradationAt(world.viscosity, x, y)]}`,
    `Сопротивление движению: ${resistanceAt(p, world.viscosity, x, y).toFixed(2)}`,
    `Доля усваиваемого света: ${absorptionAt(world.viscosity, x, y).toFixed(2)}`,
  ]);
}

function frame(now: number): void {
  const dt = Math.min(0.25, (now - lastTime) / 1000);
  lastTime = now;
  const stepsPerSecond = BASE_STEPS_PER_SECOND * speed;
  if (!paused) {
    carry += dt * stepsPerSecond;
    const n = Math.min(MAX_STEPS_PER_FRAME, Math.floor(carry));
    carry -= n;
    for (let i = 0; i < n; i++) stepWorld(world);
  }
  renderer.draw(layer, showPartitions);
  panel.setTime(world.step, paused, speed, stepsPerSecond);
  probe();
  requestAnimationFrame(frame);
}

setWorld(world);
requestAnimationFrame(frame);
