/**
 * Песочница неживой природы: мир, управление временем, параметры нового мира.
 * Скорость показа — дело приложения; мир знает только номер шага.
 */
import {
  LAYOUT_PRESETS, WorldFileError, absorptionAt, createWorld, gradationAt, isBlocked, lightAt, makeParams, mutationStrength,
  parseWorldFile, resistanceAt, serializeWorld, stepWorld, temperatureAt, type World, type WorldParams,
} from '../core/index.ts';
import { Panel, SPEEDS, SPEED_KEYS } from './panel.ts';
import { WorldRenderer } from './render.ts';

/** Шагов в секунду при скорости ×1. */
const BASE_STEPS_PER_SECOND = 30;
/** Больше шагов за кадр не делаем, чтобы не подвесить вкладку. */
const MAX_STEPS_PER_FRAME = 100_000;
/** Шаг масштаба кнопками и клавишами. */
const ZOOM_STEP = 1.5;
const GRADATION_NAMES = ['Вода', 'Отмель', 'Суша'];

const canvas = document.querySelector<HTMLCanvasElement>('#world')!;
const renderer = new WorldRenderer(canvas);

let world: World = createWorld(makeParams({ seed: 1 }));
let paused = false;
let speed = 1;
let carry = 0;
let lastTime = performance.now();
/** Курсор над чашкой: координаты мира и окна. */
let pointer: { x: number; y: number; clientX: number; clientY: number } | null = null;

const $ = (selector: string) => document.querySelector<HTMLElement>(selector)!;
const panel = new Panel({ app: $('.app'), toolbar: $('#toolbar'), params: $('#params'), legend: $('#legend'), tip: $('.tip'), scrim: $('#scrim') }, world.params, {
  onCreate: (params: WorldParams) => setWorld(createWorld(params)),
  onTogglePause: () => { paused = !paused; },
  onStepOnce: () => stepOnce(),
  onSpeed: (s) => { speed = s; carry = 0; },
  onSave: () => saveWorld(),
  onLoad: (file) => { void loadWorld(file); },
  onZoomIn: () => renderer.zoomBy(ZOOM_STEP),
  onZoomOut: () => renderer.zoomBy(1 / ZOOM_STEP),
  onZoomFit: () => renderer.fit(),
});
renderer.onZoomChange = (relative) => panel.setZoom(relative);

function saveWorld(): void {
  const blob = new Blob([serializeWorld(world, new Date())], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ecobugs-world-${world.params.seed}-${world.params.layout}-step-${world.step}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  panel.setFileStatus([`Сохранён мир на шаге ${world.step.toLocaleString('ru')}`], false);
}

async function loadWorld(file: File): Promise<void> {
  try {
    setWorld(parseWorldFile(await file.text()));
    carry = 0;
    panel.setFileStatus([`Загружен «${file.name}»: шаг ${world.step.toLocaleString('ru')}`], false);
  } catch (e) {
    const problems = e instanceof WorldFileError ? e.problems : [String(e)];
    panel.setFileStatus([`«${file.name}» не загружен:`, ...problems], true);
  }
}

function setWorld(next: World): void {
  world = next;
  renderer.setWorld(world);
  panel.setCurrent(world.params);
  document.title = `Песочница мира · ${LAYOUT_PRESETS[world.params.layout].name}`;
}

/** Один шаг: ставит на паузу, если время шло. */
function stepOnce(): void {
  paused = true;
  stepWorld(world);
}

// Камера: колесо — масштаб у курсора, щипок и прокрутка двумя пальцами на
// тачпаде — масштаб и сдвиг, перетаскивание — сдвиг, двойной клик — приблизить.
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const lines = e.deltaMode === 1;
  const mouseWheel = lines || (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 40);
  if (e.ctrlKey || mouseWheel) {
    renderer.zoomBy(Math.exp(-e.deltaY * (lines ? 0.06 : e.ctrlKey ? 0.01 : 0.002)), e.clientX, e.clientY);
  } else {
    renderer.panBy(-e.deltaX, -e.deltaY);
  }
}, { passive: false });

let drag: { x: number; y: number } | null = null;
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  drag = { x: e.clientX, y: e.clientY };
  canvas.setPointerCapture(e.pointerId);
  canvas.parentElement!.classList.add('dragging');
});
canvas.addEventListener('pointermove', (e) => {
  if (drag) {
    renderer.panBy(e.clientX - drag.x, e.clientY - drag.y);
    drag = { x: e.clientX, y: e.clientY };
    pointer = null;
    return;
  }
  const at = renderer.toWorld(e.clientX, e.clientY);
  pointer = at ? { x: at[0], y: at[1], clientX: e.clientX, clientY: e.clientY } : null;
});
const endDrag = () => {
  drag = null;
  canvas.parentElement!.classList.remove('dragging');
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('pointerleave', () => { pointer = null; });
canvas.addEventListener('dblclick', (e) => renderer.zoomBy(2, e.clientX, e.clientY));

// Горячие клавиши: не мешают полям ввода.
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    saveWorld();
    return;
  }
  if (e.key === 'Escape') { panel.toggleParams(false); return; }
  const target = e.target as HTMLElement;
  if (e.ctrlKey || e.metaKey || e.altKey || target.closest('input, select, textarea')) return;
  if (e.key === ' ') {
    e.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur();
    paused = !paused;
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    stepOnce();
  } else if (e.key === '+' || e.key === '=') {
    renderer.zoomBy(ZOOM_STEP);
  } else if (e.key === '-' || e.key === '_') {
    renderer.zoomBy(1 / ZOOM_STEP);
  } else if (e.key === '0') {
    renderer.fit();
  } else if (SPEED_KEYS.includes(e.key)) {
    speed = SPEEDS[SPEED_KEYS.indexOf(e.key)];
    carry = 0;
  }
});

function probe(): void {
  if (!pointer) { panel.setProbe(null); return; }
  const { x, y, clientX, clientY } = pointer;
  const p = world.params;
  const where = `(${Math.round(x)}, ${Math.round(y)})`;
  if (isBlocked(world.partitions, x, y)) {
    panel.setProbe([`Перегородка · ${where}`], clientX, clientY);
    return;
  }
  const temp = temperatureAt(p, world.light, x, y, world.step);
  panel.setProbe([
    `${GRADATION_NAMES[gradationAt(world.viscosity, x, y)]} · ${where}`,
    `Свет ${lightAt(world.light, x, y, world.step).toFixed(3)} · усваивается ${absorptionAt(world.viscosity, x, y).toFixed(2)}`,
    `Температура ${temp.toFixed(2)} · мутации ${mutationStrength(temp).toFixed(2)}`,
    `Сопротивление движению ${resistanceAt(p, world.viscosity, x, y).toFixed(2)}`,
  ], clientX, clientY);
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
  renderer.draw();
  panel.setTime(world.step, paused, speed, stepsPerSecond);
  probe();
  requestAnimationFrame(frame);
}

setWorld(world);
requestAnimationFrame(frame);
