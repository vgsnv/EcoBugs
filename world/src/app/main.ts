/**
 * Песочница неживой природы: мир, управление временем, параметры нового мира.
 * Скорость показа — дело приложения; мир знает только номер шага.
 */
import {
  WorldFileError, lightDriftVelocity, sunRhythmAt, transparencyAt, worldLightAt, mineralDensityAt, mineralInEruptions, mineralInDeposits, mineralInGround, mineralInMedium, smoothLevelAt, absorptionAt, createWorld, gradationAt, isBlocked, makeParams, mutationStrength,
  parseWorldFile, resistanceAt, serializeWorld, stepWorld, temperatureAt, type World, type WorldParams,
} from '../core/index.ts';
import { Panel, SPEEDS, SPEED_KEYS } from './panel.ts';
import { WorldRenderer } from './render.ts';

/** Шагов в секунду при скорости ×1. */
const BASE_STEPS_PER_SECOND = 30;
/**
 * Сколько миллисекунд кадра можно тратить на шаги мира. Не успевает — мир
 * идёт медленнее выбранной скорости (отставание не копится), вкладка не виснет.
 */
const STEP_BUDGET_MS = 24;
/** Шаг масштаба кнопками и клавишами. */
const ZOOM_STEP = 1.5;
const GRADATION_NAMES = ['Вода', 'Отмель', 'Суша'];

const canvas = document.querySelector<HTMLCanvasElement>('#world')!;
const renderer = new WorldRenderer(canvas);
const minimap = document.querySelector<HTMLCanvasElement>('.minimap')!;
const driftArrow = document.querySelector<SVGElement>('.light-drift svg')!;
const mineralStats = document.querySelector<HTMLElement>('.mineral-stats')!;
const sunLabel = document.querySelector<HTMLElement>('.sun-rhythm')!;
let mineralStatsVersion = -1;
/** Время анимации (блики), секунды; стоит на паузе. */
let animTime = 0;
/** Сколько шагов в секунду мир делает на самом деле. */
let actualRate = 0;

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
  a.download = `ecobugs-world-${world.params.seed}-step-${world.step}.json`;
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
  mineralStatsVersion = -1;
  panel.setCurrent(world.params);
  document.title = `Песочница мира · сид ${world.params.seed}`;
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

// Мини-карта: клик или перетаскивание — перейти к этому месту чашки.
minimap.addEventListener('pointerdown', (e) => {
  minimap.setPointerCapture(e.pointerId);
  renderer.centerFromMinimap(minimap, e.clientX, e.clientY);
});
minimap.addEventListener('pointermove', (e) => {
  if (minimap.hasPointerCapture(e.pointerId)) renderer.centerFromMinimap(minimap, e.clientX, e.clientY);
});

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

/** Залежи в точке относительно средней плотности запаса минерала. */
function depositsAt(w: World, x: number, y: number): number {
  const m = w.mineral;
  const i = Math.min(m.cols - 1, Math.max(0, Math.floor(x / m.cell)));
  const j = Math.min(m.rows - 1, Math.max(0, Math.floor(y / m.cell)));
  return w.terrain.deposits[j * m.cols + i] / (m.cell * m.cell) / w.params.mineralStock;
}

function probe(): void {
  if (!pointer) { panel.setProbe(null); return; }
  const { x, y, clientX, clientY } = pointer;
  const p = world.params;
  const where = `(${Math.round(x)}, ${Math.round(y)})`;
  const volcano = world.mineral.volcanoes.findIndex((v) => Math.hypot(v.x - x, v.y - y) < 12);
  if (volcano >= 0) {
    const v = world.mineral.volcanoes[volcano];
    const state = v.active
      ? [`Извергается ещё ${(v.until - world.step).toLocaleString('ru')} шагов`, `Осталось выбросить: ${Math.round((v.left / (world.params.mineralStock * world.mineral.freeArea)) * 1000) / 10}% запаса`]
      : ['Спит — проснётся, когда недра наберут давление (какой вулкан — случай, сильные чаще)'];
    panel.setProbe([`Вулкан ${volcano + 1} · ${where}`, `Мощность ×${v.power.toFixed(2)} · извержений было: ${v.k - (v.active ? 1 : 0)}`, ...state], clientX, clientY);
    return;
  }
  if (isBlocked(world.partitions, x, y)) {
    panel.setProbe([`Перегородка · ${where}`], clientX, clientY);
    return;
  }
  const temp = temperatureAt(p, world.light, x, y, world.step);
  panel.setProbe([
    `${GRADATION_NAMES[gradationAt(world.viscosity, x, y)]} · уровень ${smoothLevelAt(world.viscosity, x, y).toFixed(2)} · ${where}`,
    `Свет ${worldLightAt(world, x, y).toFixed(3)} · усваивается ${absorptionAt(world.viscosity, x, y).toFixed(2)}`,
    `Температура ${temp.toFixed(2)} · мутации ${mutationStrength(temp).toFixed(2)}`,
    `Сопротивление движению ${resistanceAt(p, world.viscosity, x, y).toFixed(2)}`,
    `Снос ${Math.hypot(...world.drift.at(x, y, world.step)).toFixed(3)} за шаг`,
    `Минерал ×${mineralDensityAt(world.mineral, p.mineralStock, x, y).toFixed(2)} от среднего · прозрачность ${transparencyAt(world.mineral, x, y).toFixed(2)}`,
    `Залежи ×${depositsAt(world, x, y).toFixed(2)} от среднего запаса`,
  ], clientX, clientY);
}

function frame(now: number): void {
  const dt = Math.min(0.25, (now - lastTime) / 1000);
  lastTime = now;
  const stepsPerSecond = BASE_STEPS_PER_SECOND * speed;
  let behind = false;
  if (!paused) {
    carry += dt * stepsPerSecond;
    const want = Math.floor(carry);
    const start = performance.now();
    let n = 0;
    while (n < want) {
      stepWorld(world);
      n++;
      if ((n & 63) === 0 && performance.now() - start > STEP_BUDGET_MS) break;
    }
    behind = n < want;
    carry = behind ? 0 : carry - n;
    animTime += dt;
    // Настоящая скорость — сглаженно.
    if (dt > 0) actualRate += (n / dt - actualRate) * Math.min(1, dt * 2);
  } else {
    actualRate = 0;
  }
  renderer.draw(animTime);
  renderer.drawMinimap(minimap);
  const [dvx, dvy] = lightDriftVelocity(world.light, world.step);
  driftArrow.style.transform = `rotate(${Math.atan2(dvy, dvx)}rad)`;
  const rhythm = sunRhythmAt(world.light, world.step);
  const rising = sunRhythmAt(world.light, world.step + 100) >= rhythm;
  const sunText = world.params.sunRhythm > 0 ? `солнце ×${rhythm.toFixed(2)} ${rising ? '↑' : '↓'}` : 'солнце ровное';
  if (sunLabel.textContent !== sunText) sunLabel.textContent = sunText;
  if (world.mineral.version !== mineralStatsVersion) {
    mineralStatsVersion = world.mineral.version;
    const medium = mineralInMedium(world.mineral);
    const ground = mineralInGround(world.terrain);
    const deposits = mineralInDeposits(world.terrain);
    const total = medium + world.mineral.depths + mineralInEruptions(world.mineral) + ground + deposits;
    const share = (x: number) => `${Math.round((x / total) * 100)}%`;
    const active = world.mineral.volcanoes.flatMap((v, i) => (v.active ? [i + 1] : []));
    mineralStats.innerHTML = `<b>минерал</b> · в среде ${share(medium)} · в залежах ${share(deposits)} · давление недр ${Math.round((world.mineral.depths / world.mineral.threshold) * 100)}% · ${active.length ? `извергается вулкан ${active.join(', ')}` : 'вулканы спят'} · извержений ${world.mineral.eruptions}`;
  }
  panel.setTime(world.step, paused, speed, behind || actualRate < stepsPerSecond * 0.9 ? actualRate : stepsPerSecond, behind);
  probe();
  requestAnimationFrame(frame);
}

setWorld(world);
requestAnimationFrame(frame);
