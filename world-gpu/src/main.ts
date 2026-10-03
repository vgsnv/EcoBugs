import './style.css';
import { GpuWorld } from './gpu.ts';
import { createGrid, QUANTUM_MG, SCENES, type Scene } from './model.ts';
import { runChecks } from './checks.ts';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <header><div><p class="eyebrow">ECOBUGS / WEBGPU</p><h1>Течение в чашке</h1><p class="subtitle">Первый физический стенд · шаг 0,1 с · консервативный перенос минерала</p></div><span id="device" class="badge">Проверяю WebGPU…</span></header>
  <main><section class="surface"><div class="toolbar">
    <label>Сцена<select id="scene">${Object.entries(SCENES).map(([id, name]) => `<option value="${id}">${name}</option>`).join('')}</select></label>
    <label>Сетка<select id="grid"><option value="32">32 × 24</option><option value="64" selected>64 × 48</option><option value="128">128 × 96</option></select></label>
    <label class="toggle"><input id="arrows" type="checkbox"> Поле скорости</label>
  </div><div class="dish"><canvas id="world" aria-label="Чашка: физическое поле среды и минерала"></canvas></div>
  <div class="transport"><button id="play">Пуск</button><button id="step">Один шаг</button><button id="reset">Сначала</button><label>Скорость<select id="speed"><option value="1">×1</option><option value="10" selected>×10</option><option value="100">×100</option></select></label><span id="clock">Шаг 0 · 0,0 с</span></div>
  <p class="caption">Сиреневый цвет — минерал. Оранжевые точки — источник, голубые — возвратный поток. Тёмные границы непроницаемы.</p></section>
  <aside><h2>Баланс среды</h2><div id="status" role="status">Создание устройства…</div><dl id="metrics"></dl>
  <p class="note">Это стенд вычислительного метода. Генерация мира, жизненные циклы источников, местность и полноценный свет будут добавлены следующими этапами.</p>
  <button id="checks">Проверить физику GPU</button><pre id="report" aria-live="polite"></pre></aside></main>`;

const canvas = document.querySelector<HTMLCanvasElement>('#world')!;
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const scene = element<HTMLSelectElement>('scene'), grid = element<HTMLSelectElement>('grid');
const status = element('status'), report = element('report');
let gpu: GpuWorld | null = null, paused = true, busy = true, last = performance.now(), debt = 0;
let pendingMetrics = false, lastMetrics = 0, completedStep = 0;
const controls = [...document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('button,select,input')];
const lock = (value: boolean) => { busy = value; for (const c of controls) c.disabled = value; };
const failure = (e: unknown) => { lock(true); paused = true; status.textContent = e instanceof Error ? e.message : String(e); status.className = 'error'; };
async function metrics(): Promise<void> {
  if (!gpu || pendingMetrics || busy) return;
  pendingMetrics = true;
  try {
    const observedGrid = gpu.grid;
    const m = await gpu.summary();
    if (busy || gpu.grid !== observedGrid) return;
    completedStep = m.step;
    const values = [['В среде', `${(m.dissolved * QUANTUM_MG).toFixed(2)} мг`], ['В недрах', `${((m.captured + m.reserved) * QUANTUM_MG).toFixed(2)} мг`],
      ['Ошибка массы', `${m.massError} квантов`], ['Макс. скорость грани', `${m.maxSpeed.toFixed(2)} мм/с`], ['Невязка давления', m.relativeResidual.toExponential(2)]];
    element('metrics').innerHTML = values.map(([key, value]) => `<dt>${key}</dt><dd>${value}</dd>`).join('');
  } catch (e) { failure(e); } finally { pendingMetrics = false; }
}
async function reset(): Promise<void> {
  if (!gpu) return;
  lock(true); paused = true; debt = 0; element('play').textContent = 'Пуск'; status.textContent = 'Расчёт поля давления…';
  try {
    const cols = Number(grid.value);
    for (const option of grid.options) {
      const size = Number(option.value);
      option.textContent = `${size} × ${scene.value === 'circle' ? size : size * 3 / 4}`;
    }
    await gpu.reset(createGrid(scene.value as Scene, cols), cols * cols * (scene.value === 'passage' ? 32 : 4));
    completedStep = 0; status.textContent = 'WebGPU · физика готова'; status.className = '';
    lock(false); gpu.draw(element<HTMLInputElement>('arrows').checked); await metrics();
  } catch (e) { failure(e); }
}
element('play').onclick = () => { paused = !paused; debt = 0; element('play').textContent = paused ? 'Пуск' : 'Пауза'; };
element('step').onclick = async () => {
  if (!gpu || busy) return;
  paused = true; element('play').textContent = 'Пуск'; debt = 0;
  gpu.advance(); await gpu.device.queue.onSubmittedWorkDone(); gpu.draw(element<HTMLInputElement>('arrows').checked); await metrics();
};
element('reset').onclick = () => { void reset(); };
scene.onchange = () => { void reset(); }; grid.onchange = () => { void reset(); };
element('checks').onclick = async () => {
  if (!gpu || busy) return;
  paused = true; lock(true); status.textContent = 'Выполняются числовые проверки GPU…';
  try {
    report.textContent = await runChecks(gpu, (text) => { report.textContent = text; });
    await reset();
  } catch (e) { report.textContent += `\n✗ ${e instanceof Error ? e.message : String(e)}`; failure(e); }
};
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { paused = true; debt = 0; element('play').textContent = 'Пуск'; }
});
async function frame(now: number): Promise<void> {
  const dt = Math.min(.1, (now - last) / 1000); last = now;
  if (gpu && !busy) {
    try {
      if (gpu.lost || gpu.errors.length) throw new Error(gpu.errors.join('\n'));
      if (!paused && !document.hidden) {
        debt += dt * 10 * Number(element<HTMLSelectElement>('speed').value);
        const steps = Math.min(8, Math.floor(debt));
        for (let k = 0; k < steps; k++) gpu.advance();
        debt = Math.min(8, debt - steps);
      }
      gpu.draw(element<HTMLInputElement>('arrows').checked);
      await gpu.device.queue.onSubmittedWorkDone(); completedStep = gpu.step;
      element('clock').textContent = `Шаг ${completedStep} · ${(completedStep / 10).toFixed(1)} с`;
      if (now - lastMetrics > 1000) { lastMetrics = now; void metrics(); }
    } catch (e) { failure(e); }
  }
  requestAnimationFrame((time) => { void frame(time); });
}
lock(true);
void GpuWorld.create(canvas).then(async (world) => {
  gpu = world;
  const info = world.adapter.info;
  element('device').textContent = `WebGPU · ${info.description || info.architecture || info.vendor || 'устройство готово'}`;
  await reset();
}).catch(failure);
requestAnimationFrame((now) => { void frame(now); });
