/**
 * Песочница неживой природы: мир, управление временем, параметры нового мира.
 * Скорость показа — дело приложения; мир знает только номер шага.
 */
import {
  Drift, flowAt, meanSpotSpeed, sunRhythmAt, transparencyAt, worldLightAt, mineralDensityAt, mineralInEruptions, mineralInDeposits, mineralInMedium, smoothLevelAt, absorptionAt, createWorld, gradationAt, isBlocked, makeParams, mutationStrength,
  resistanceAt, setMediumLaws, temperatureAt, type World, type WorldParams,
} from '../core/index.ts';
import { WorldSummary } from './world-summary.ts';
import { Panel, SPEEDS, SPEED_KEYS } from './panel.ts';
import { WorldRenderer } from './render.ts';
import { installRenderCheck } from './render-check.ts';
import { formatDuration, formatLength, formatMass, formatNumber, formatPercent } from './units.ts';
import { gramsPerSquareMetre, millimetresPerSecond } from '../core/units.ts';
import type { SimulationCommand, SimulationReply } from './simulation.ts';

/** Шаг масштаба кнопками и клавишами. */
const ZOOM_STEP = 1.5;
const worldSummary = new WorldSummary(document.querySelector<HTMLElement>('#world-summary')!);
const GRADATION_NAMES = ['Вода', 'Отмель', 'Суша'];

const canvas = document.querySelector<HTMLCanvasElement>('#world')!;
const renderer = new WorldRenderer(canvas);
const minimap = document.querySelector<HTMLCanvasElement>('.minimap')!;
minimap.addEventListener('click', event => renderer.centerFromMinimap(minimap, event.clientX, event.clientY));
const lightSpeed = document.querySelector<HTMLElement>('.light-speed')!;
const mineralStats = document.querySelector<HTMLElement>('.mineral-stats')!;
mineralStats.innerHTML = '<details class="mineral-details"><summary><b>Минерал</b><span class="mineral-scale"><span class="mineral-bar" role="img"><i class="depths"></i><i class="out"></i><i class="deposits"></i><i class="medium"></i><i class="threshold"></i></span><span class="mineral-ticks"><span class="mass-zero"></span><span class="mass-half"></span><span class="mass-total"></span></span></span></summary>'
  + '<div class="mineral-keys"><span class="key"><i class="depths"></i>недра <span class="amount-depths"></span></span><span class="key"><i class="deposits"></i>залежи <span class="amount-deposits"></span></span><span class="key"><i class="medium"></i>в среде <span class="amount-medium"></span></span><span class="key"><i class="out"></i>извергается <span class="amount-out"></span></span><span class="volcanoes"></span></div></details>';
const mineralBar = mineralStats.querySelector<HTMLElement>('.mineral-bar')!;
const massTicks = ['zero', 'half', 'total'].map(name => mineralStats.querySelector<HTMLElement>(`.mass-${name}`)!);
const [barDepths, barOut, barDeposits, barMedium, barThreshold] = mineralBar.querySelectorAll<HTMLElement>('i');
const volcanoText = mineralStats.querySelector<HTMLElement>('.volcanoes')!;
const amounts = ['depths', 'out', 'deposits', 'medium'].map(name => mineralStats.querySelector<HTMLElement>(`.amount-${name}`)!);
const sunLabel = document.querySelector<HTMLElement>('.sun-rhythm')!;
let mineralStatsVersion = -1;
/** Время анимации (блики), секунды; стоит на паузе. */
let animTime = 0;
let flowStep = 0;
/** Сколько шагов в секунду мир делает на самом деле. */
let actualRate = 0;
/** Частота отрисованных кадров за последнюю секунду, независимо от расчёта мира. */
let framesPerSecond: number | null = null;
let fpsWindowStart: number | null = null;
let renderedFrames = 0;

let world: World = createWorld(makeParams({ seed: 1 }));
let paused = false;
/** Идёт настройка черновика нового мира: время стоит, пока его не запустят. */
let drafting = false;
let speed = 1;
const simulation = new Worker(new URL('./simulation.worker.ts', import.meta.url), { type: 'module' });
let epoch = 0;
let requestId = 0;
let behind = false;
let ready = false;
const pendingLoads = new Map<number, string>();
function send(command: SimulationCommand): void { simulation.postMessage(command); }
function control(): void {
  send({ type: 'control', epoch, paused, speed, active: document.visibilityState === 'visible' });
}
function togglePause(): void { if (drafting) return; paused = !paused; control(); }
function changeSpeed(next: number): void { speed = next; control(); }
function create(params: WorldParams): void {
  epoch++;
  send({ type: 'create', epoch, params });
  control();
}

let lastTime = performance.now();
/** Курсор над чашкой: координаты мира и окна. */
let pointer: { x: number; y: number } | null = null;
let pinnedPoint: { x: number; y: number } | null = null;

const $ = (selector: string) => document.querySelector<HTMLElement>(selector)!;
const panel = new Panel({ app: $('.app'), toolbar: $('#toolbar'), params: $('#params'), legend: $('#legend'), tip: $('.tip'), observation: $('#observation'), navigation: $('#navigation'), viewControls: $('#view-controls'), summary: $('#world-summary') }, world.params, {
  onLayoutChange: () => { pointer = null; renderer.resizeKeepingView(); },
  onDraft: (params: WorldParams) => { drafting = true; paused = true; create(params); },
  onLaunch: () => { drafting = false; paused = false; control(); },
  onTogglePause: () => togglePause(),
  onUnpinProbe: () => { pinnedPoint = null; renderer.setProbePoint(null); panel.setProbePinned(false); },
  onSpeed: (s) => changeSpeed(s),
  onSave: () => saveWorld(),
  onLoad: (file) => { void loadWorld(file); },
  onZoomIn: () => renderer.zoomBy(ZOOM_STEP),
  onZoomOut: () => renderer.zoomBy(1 / ZOOM_STEP),
  onZoomFit: () => renderer.fit(),
  onRulers: (enabled) => renderer.setRulers(enabled),
  onStreamView: (view) => { renderer.streamView = view; },
  onProcesses: (enabled) => {
    renderer.showProcesses = enabled;
    send({ type: 'processes', epoch, enabled });
  },
});
renderer.onZoomChange = (relative) => panel.setZoom(relative);

function saveWorld(): void {
  send({ type: 'save', epoch, id: ++requestId });
}

async function loadWorld(file: File): Promise<void> {
  try {
    const text = await file.text();
    const id = ++requestId;
    pendingLoads.set(id, file.name);
    epoch++;
    send({ type: 'load', epoch, id, text });
    control();
  } catch (error) {
    panel.setFileStatus([`«${file.name}» не загружен:`, String(error)], true);
  }
}

simulation.onmessage = ({ data }: MessageEvent<SimulationReply>) => {
  if (data.epoch !== epoch) return;
  switch (data.type) {
    case 'snapshot': {
      ready = true;
      if (data.initial) {
        const next: World = { ...data.initial, light: data.light, step: data.step, mineral: data.mineral, terrain: data.terrain,
          viscosity: data.viscosity, drift: new Drift({ ...data.initial, light: data.light, viscosity: data.viscosity }) };
        if (data.drift) next.drift.acceptNodes(data.step, data.drift.a, data.drift.b);
        setWorld(next);
      } else {
        world.step = data.step;
        Object.assign(world.light, data.light);
        if (data.mineral) Object.assign(world.mineral, data.mineral);
        if (data.terrain) Object.assign(world.terrain, data.terrain);
        if (data.viscosity) Object.assign(world.viscosity, data.viscosity);
        if (data.drift) world.drift.acceptNodes(data.step, data.drift.a, data.drift.b);
      }
      worldSummary.observe(world, data.exchanges);
      renderer.processes = data.processes ?? null;
      if (data.ground) renderer.acceptGround(data.ground);
      actualRate = data.rate;
      behind = data.behind;
      send({ type: 'ack', epoch });
      break;
    }
    case 'saved': {
      const blob = new Blob([data.text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ecobugs-world-${data.seed}-step-${data.step}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      panel.setFileStatus([`Сохранён мир на шаге ${data.step.toLocaleString('ru')}`], false);
      break;
    }
    case 'loaded': {
      const name = pendingLoads.get(data.id) ?? 'мир';
      pendingLoads.delete(data.id);
      panel.setFileStatus([`Загружен «${name}»: шаг ${data.step.toLocaleString('ru')}`], false);
      break;
    }
    case 'error': {
      if (data.fatal) { paused = true; actualRate = 0; behind = false; }
      const name = data.id === undefined ? undefined : pendingLoads.get(data.id);
      if (data.id !== undefined) pendingLoads.delete(data.id);
      if (!data.fatal && data.id === undefined) panel.showCreationErrors(data.problems);
      else panel.setFileStatus([...(name ? [`«${name}» не загружен:`] : []), ...data.problems], true);
      break;
    }
  }
};
simulation.onerror = (event) => {
  paused = true;
  panel.setFileStatus([`Расчёт мира остановлен: ${event.message}`], true);
};
document.addEventListener('visibilitychange', () => {
  control();
  fpsWindowStart = null;
  framesPerSecond = null;
  renderedFrames = 0;
});

function setWorld(next: World): void {
  pinnedPoint = pointer = null;
  renderer.setProbePoint(null);
  panel.setProbePinned(false);
  flowStep = next.step;
  worldSummary.reset(next);
  const sameDish = next.dish.width === world.dish.width && next.dish.height === world.dish.height;
  world = next;
  setMediumLaws(world.params);
  renderer.setWorld(world, drafting && sameDish);
  mineralStatsVersion = -1;
  panel.setCurrent(world.params);
  document.title = `Песочница мира · сид ${world.params.seed}`;
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

let drag: { x: number; y: number; startX: number; startY: number; moved: boolean } | null = null;
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  drag = { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, moved: false };
  canvas.setPointerCapture(e.pointerId);
  canvas.parentElement!.classList.add('dragging');
});
canvas.addEventListener('pointermove', (e) => {
  if (drag) {
    renderer.panBy(e.clientX - drag.x, e.clientY - drag.y);
    drag.moved ||= Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 4;
    drag.x = e.clientX; drag.y = e.clientY;
    pointer = null;
    return;
  }
  const at = renderer.toWorld(e.clientX, e.clientY);
  pointer = at ? { x: at[0], y: at[1] } : null;
});
const endDrag = () => {
  drag = null;
  canvas.parentElement!.classList.remove('dragging');
};
canvas.addEventListener('pointerup', (e) => {
  if (drag && !drag.moved && !$('.probe-dock').hidden && document.querySelector<HTMLDetailsElement>('.probe-dock')!.open) {
    const at = renderer.toWorld(e.clientX, e.clientY);
    if (at) { pinnedPoint = { x: at[0], y: at[1] }; renderer.setProbePoint(pinnedPoint); panel.setProbePinned(true); }
  }
  endDrag();
});
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
  if (e.key === 'Escape') { panel.closePanels(); return; }
  const target = e.target as HTMLElement;
  if (e.ctrlKey || e.metaKey || e.altKey || target.closest('input, select, textarea')) return;
  // Native controls use Space/Enter for activation; the world shortcut applies
  // when focus is outside a button or disclosure.
  if ((e.key === ' ' || e.key === 'Enter') && target.closest('button, summary')) return;
  if (e.key === ' ') {
    e.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur();
    togglePause();
  } else if (e.key === '+' || e.key === '=') {
    renderer.zoomBy(ZOOM_STEP);
  } else if (e.key === '-' || e.key === '_') {
    renderer.zoomBy(1 / ZOOM_STEP);
  } else if (e.key === '0') {
    renderer.fit();
  } else if (SPEED_KEYS.includes(e.key)) {
    changeSpeed(SPEEDS[SPEED_KEYS.indexOf(e.key)]);
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
  const point = pinnedPoint ?? pointer;
  if (!point) { panel.setProbe(null); return; }
  const { x, y } = point;
  const p = world.params;
  const where = `(${formatLength(x)}, ${formatLength(y)})`;
  const v = world.mineral.volcanoes.find((v) => Math.hypot(v.x - x, v.y - y) < 12);
  if (v) {
    const steps = formatDuration;
    const pressure = Math.round((world.mineral.depths / world.mineral.threshold) * 100);
    const state = {
      preparing: [v.fresh ? 'Зарождается — готовится к первому выбросу' : 'Проснулся — готовится к выбросу',
        world.step < v.stageUntil ? `Созреет через ${steps(v.stageUntil - world.step)}; давление недр ${pressure}%` : `Созрел; извергнется, когда давление недр дойдёт до 100% (сейчас ${pressure}%)`],
      erupting: [`Извергается ещё ${steps(v.until - world.step)}`, `Осталось выбросить: ${formatMass(v.left)} · всего ${formatMass(v.total)}`],
      dormant: ['Спит — может проснуться, когда недра снова наберут давление', `Потухнет без выбросов через ${steps(v.stageUntil - world.step)}`],
      extinct: ['Потух', `Исчезнет через ${steps(v.stageUntil - world.step)}`],
    }[v.stage];
    panel.setProbe([`Вулкан ${v.id + 1} · ${where}`, `Мощность ×${v.power.toFixed(2)} · извержений было: ${v.k - (v.stage === 'erupting' ? 1 : 0)}`, ...state]);
    return;
  }
  if (isBlocked(world.partitions, x, y)) {
    panel.setProbe([`Перегородка · ${where}`]);
    return;
  }
  const temp = temperatureAt(p, world.light, x, y, world.step);
  const processes = renderer.showProcesses ? renderer.processes : null;
  const k = Math.floor(y / world.mineral.cell) * world.mineral.cols + Math.floor(x / world.mineral.cell);
  panel.setProbe([
    `${GRADATION_NAMES[gradationAt(world.viscosity, x, y)]} · уровень ${smoothLevelAt(world.viscosity, x, y).toFixed(2)} · ${where}`,
    `Свет ${worldLightAt(world, x, y).toFixed(3)} усл. ед. · усваивается ${formatPercent(absorptionAt(world.viscosity, x, y))}`,
    `Температура ${formatNumber(temp)} усл. ед. · сила мутаций ${formatNumber(mutationStrength(temp))}`,
    `Сопротивление движению ×${formatNumber(resistanceAt(world.viscosity, x, y))}`,
    `Течение ${formatNumber(millimetresPerSecond(Math.hypot(...flowAt(world, x, y))))} мм/с`,
    `Минерал ${formatNumber(gramsPerSquareMetre(mineralDensityAt(world.mineral, p.mineralStock, x, y) * p.mineralStock))} г/м² · прозрачность ${formatPercent(transparencyAt(world.mineral, x, y))}`,
    `Залежи ${formatNumber(gramsPerSquareMetre(depositsAt(world, x, y) * p.mineralStock))} г/м²`,
    ...(processes && processes.step > 0 ? [
      `Последний расчёт: шаг ${processes.step.toLocaleString('ru')} · за ${formatDuration(100)}`,
      `Размыв ${formatMass(processes.erosion[k])} · оседание ${formatMass(processes.settling[k])} · воронка → недра ${formatMass(processes.sinking[k])}`,
      groundLine(renderer.groundAt(k)),
    ] : []),
  ]);
}

/** Грунт в пробе «Процессов»: изменение уровня в сутки мира (864 000 шагов). */
function groundLine(g: { sand: number; tectonic: number }): string {
  const day = (v: number) => `${v >= 0 ? '+' : '−'}${formatNumber(Math.abs(v * 864_000))}`;
  return `Грунт за сутки: течения ${day(g.sand)} ур. · тектоника ${day(g.tectonic)} ур.`;
}

function frame(now: number): void {
  const dt = Math.min(0.25, (now - lastTime) / 1000);
  lastTime = now;
  if (!paused) animTime += dt;
  if (!ready) { requestAnimationFrame(frame); return; }
  worldSummary.render(world, now);
  flowStep = paused ? world.step : Math.min(world.step, flowStep + dt * (actualRate || 10 * speed));
  renderer.draw(animTime, flowStep);
  if (fpsWindowStart === null) {
    fpsWindowStart = now;
  } else {
    renderedFrames++;
    const elapsed = now - fpsWindowStart;
    if (elapsed >= 1000) {
      framesPerSecond = renderedFrames * 1000 / elapsed;
      fpsWindowStart = now;
      renderedFrames = 0;
    }
  }
  renderer.drawMinimap(minimap);
  const spotSpeed = millimetresPerSecond(meanSpotSpeed(world.light, world.step)) * 60;
  const speedText = spotSpeed > 0 ? `пятна плывут ≈ ${(spotSpeed * 60 * 24 / 10).toFixed(0)} см/сут` : 'свет стоит';
  if (lightSpeed.textContent !== speedText) lightSpeed.textContent = speedText;
  const rhythm = sunRhythmAt(world.light, world.step);
  const rising = sunRhythmAt(world.light, world.step + 100) >= rhythm;
  const sunText = world.params.sunRhythm > 0 ? `солнце ×${rhythm.toFixed(2)} ${rising ? '↑' : '↓'}` : 'солнце ровное';
  if (sunLabel.textContent !== sunText) sunLabel.textContent = sunText;
  if (world.mineral.version !== mineralStatsVersion) {
    mineralStatsVersion = world.mineral.version;
    // Полоса — весь минерал: недра, «в пути» (взято извержением,
    // ещё не вышло), залежи, среда; риска — порог давления недр. Под полосой — шкала массы.
    const m = world.mineral;
    const medium = mineralInMedium(m);
    const deposits = mineralInDeposits(world.terrain);
    const inTransit = mineralInEruptions(m);
    const total = m.depths + inTransit + medium + deposits;
    for (const [i, fraction] of [0, 0.5, 1].entries()) massTicks[i].textContent = formatMass(total * fraction);
    const pct = (x: number) => (total > 0 ? Math.min(100, Math.max(0, (x / total) * 100)) : 0);
    const pctText = (x: number) => (pct(x) > 0 && pct(x) < 1 ? '<1%' : `${Math.round(pct(x))}%`);
    let left = 0;
    for (const [el, x] of [[barDepths, m.depths], [barOut, inTransit], [barDeposits, deposits], [barMedium, medium]] as const) {
      el.style.left = `${left}%`;
      el.style.width = `${pct(x)}%`;
      left += pct(x);
    }
    for (const [i, amount] of [m.depths, inTransit, deposits, medium].entries()) {
      amounts[i].textContent = `${pctText(amount)} · ${formatMass(amount)}`;
    }
    barThreshold.style.left = `${pct(m.threshold)}%`;
    const erupting = m.volcanoes.find((v) => v.stage === 'erupting');
    const preparing = m.volcanoes.find((v) => v.stage === 'preparing');
    const alive = m.volcanoes.filter((v) => v.stage !== 'extinct').length;
    const now = erupting ? `извергается вулкан ${erupting.id + 1}` : preparing ? `${preparing.fresh ? 'зарождается' : 'просыпается'} вулкан ${preparing.id + 1}` : alive ? 'вулканы спят' : 'вулканов нет';
    volcanoText.textContent = `${now} · живых ${alive} · извержений ${m.eruptions}`;
    mineralBar.title = `Весь минерал: ${formatMass(total)}; недра ${pctText(m.depths)} (${formatMass(m.depths)})`
      + (inTransit > 0 ? `, выходит извержением ${pctText(inTransit)}` : '')
      + `, в залежах ${pctText(deposits)}, в среде ${pctText(medium)}. Риска — порог давления недр (${pctText(m.threshold)}, ${formatMass(m.threshold)}): когда недра дорастут до неё, начнётся извержение.`;
    mineralBar.setAttribute('aria-label', mineralBar.title);
  }
  panel.setTime(world.step, paused, speed, framesPerSecond, paused ? 0 : actualRate, behind);
  probe();
  requestAnimationFrame(frame);
}

setWorld(world);
// ?check — проверка отрисовки (см. render-check.ts): без расчёта и анимации.
if (new URLSearchParams(location.search).has('check')) installRenderCheck(renderer);
else {
  create(world.params);
  requestAnimationFrame(frame);
}
