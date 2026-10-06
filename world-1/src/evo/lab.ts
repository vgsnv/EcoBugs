/** Страница эволюционной лаборатории: карта, управление, графики, правила организма. */
import { ACTIONS, ACTION_COUNT, createSim, describeRule, resetWindow, snapshot, step, type Genotype, type Sim, type Snapshot } from './sim.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const map = $<HTMLCanvasElement>('map'), ctx = map.getContext('2d')!;
const ACTION_COLORS: [number, number, number][] = [
  [120, 200, 80],   // фотосинтез
  [190, 140, 70],   // есть останки
  [230, 60, 50],    // напасть
  [80, 150, 240],   // двигаться
  [240, 210, 90],   // расти
  [250, 250, 250],  // делиться
  [200, 120, 230],  // делиться энергией
  [120, 120, 120],  // ждать
];
$('legend').innerHTML = ACTIONS.map((a, k) => `<span><i style="background:rgb(${ACTION_COLORS[k].join(',')})"></i>${a}</span>`).join('');

let sim: Sim, running = true, history: Snapshot[] = [], established: number[] = [], selected = -1;
/** Генотип выбранного организма — правила остаются на экране, даже если организм ушёл или умер. */
let chosen: Genotype | null = null;

function reset(): void {
  sim = createSim(Number($<HTMLInputElement>('seed').value) || 1);
  map.width = sim.w; map.height = sim.h;
  history = []; established = []; selected = -1; chosen = null;
  record();
}

const SAMPLE = 200;
function record(): void {
  const s = snapshot(sim);
  history.push(s); established.push(sim.stats.newEstablished);
  if (history.length > 600) { history = history.filter((_, i) => i % 2 === 0); established = established.filter((_, i) => i % 2 === 0); }
  resetWindow(sim);
}

function hsl(h: number, s: number, l: number): [number, number, number] {
  const f = (n: number) => { const k = (n + h * 12) % 12; return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

function draw(): void {
  const img = ctx.createImageData(sim.w, sim.h), d = img.data, mode = $<HTMLSelectElement>('color').value;
  for (let p = 0; p < sim.w * sim.h; p++) {
    let r: number, g: number, b: number;
    if (sim.alive[p]) {
      const ge = sim.geno[p]!;
      if (mode === 'lineage') [r, g, b] = hsl(ge.tag, 0.75, 0.6);
      else if (mode === 'rules') [r, g, b] = hsl(0.66 - Math.min(1, ge.rules.length / 12) * 0.66, 0.8, 0.55);
      else { const c = ACTION_COLORS[Math.max(0, sim.last[p])] ?? [150, 150, 150]; [r, g, b] = c; }
      const e = Math.min(1, Math.max(0.35, sim.energy[p] / (sim.body[p] * 2)));
      r *= e; g *= e; b *= e;
      if (sim.bonds[p]) { r = r * 0.7 + 70; g = g * 0.7 + 70; b = b * 0.7 + 70; }
    } else {
      const l = sim.light[p], m = Math.min(1, sim.mineral[p] / 3), rem = Math.min(1, sim.remE[p] / 2);
      r = 16 + 40 * l + 70 * m + 90 * rem; g = 32 + 55 * l + 20 * m + 50 * rem; b = 42 + 45 * l + 90 * m + 10 * rem;
    }
    d[p * 4] = r; d[p * 4 + 1] = g; d[p * 4 + 2] = b; d[p * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  if (selected >= 0) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 0.5; ctx.strokeRect((selected % sim.w) - 1, Math.floor(selected / sim.w) - 1, 3, 3); }
  $('clock').textContent = `ход ${sim.tick.toLocaleString('ru')}`;
}

type Row = { label: string; get: (s: Snapshot, i: number) => number; format: (v: number) => string; zero?: boolean };
const pct = (v: number) => `${Math.round(v * 100)}%`;
const ROWS: Row[] = [
  { label: 'Организмов', get: (s) => s.population, format: (v) => Math.round(v).toLocaleString('ru'), zero: true },
  { label: 'Генотипов', get: (s) => s.genotypes, format: (v) => Math.round(v).toLocaleString('ru'), zero: true },
  { label: 'Новых закрепилось (≥ 20) за окно', get: (_, i) => established[i], format: (v) => String(Math.round(v)), zero: true },
  { label: 'Правил в геноме (среднее)', get: (s) => s.meanRules, format: (v) => v.toFixed(1) },
  { label: 'Из них срабатывает (≥ 0,1% ходов)', get: (s) => s.meanLiving, format: (v) => v.toFixed(1) },
  { label: 'Правил — больше всего', get: (s) => s.maxRules, format: (v) => String(Math.round(v)) },
  { label: 'Действий в ходу (> 2%)', get: (s) => s.usedActions, format: (v) => String(Math.round(v)) },
  { label: 'Убийств за окно', get: (s) => s.kills, format: (v) => String(Math.round(v)), zero: true },
  { label: 'Связанных', get: (s) => s.bonded, format: pct, zero: true },
  { label: 'Тело (среднее)', get: (s) => s.meanBody, format: (v) => v.toFixed(2) },
  ...ACTIONS.slice(1, ACTION_COUNT - 1).map((a, k): Row => ({ label: `Доля «${a}»`, get: (s) => s.actions[k + 1], format: pct, zero: true })),
];
const charts = $('charts');
const canvases = ROWS.map((row) => {
  const el = document.createElement('div'); el.className = 'row';
  el.innerHTML = `<span>${row.label}</span><b>—</b><canvas></canvas>`;
  charts.append(el);
  return { canvas: el.querySelector('canvas')!, value: el.querySelector('b')! };
});

function drawCharts(): void {
  const n = history.length, css = getComputedStyle(document.body);
  const line = css.getPropertyValue('--accent').trim(), mark = css.getPropertyValue('--muted').trim();
  ROWS.forEach((row, r) => {
    const { canvas, value } = canvases[r];
    value.textContent = n ? row.format(row.get(history[n - 1], n - 1)) : '—';
    const dpr = devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
    const c = canvas.getContext('2d')!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
    if (n < 2) return;
    const vals = history.map((s, i) => row.get(s, i));
    let lo = row.zero ? 0 : Math.min(...vals), hi = Math.max(...vals);
    const flat = hi - lo < 1e-9;
    if (flat) hi = lo + 1;
    const X = (i: number) => i / (n - 1) * w, Y = (v: number) => 2 + (1 - (v - lo) / (hi - lo)) * (h - 4);
    c.strokeStyle = line; c.lineWidth = 1.5; c.beginPath();
    vals.forEach((v, i) => i ? c.lineTo(X(i), Y(v)) : c.moveTo(X(i), Y(v))); c.stroke();
    c.fillStyle = mark; c.font = '9px ui-monospace, Menlo, monospace';
    if (!flat) { c.textBaseline = 'top'; c.fillText(row.format(hi), 1, 0); c.textBaseline = 'bottom'; c.fillText(row.format(lo), 1, h); }
  });
}

function drawProbe(): void {
  const el = $('probe');
  if (!chosen) { el.innerHTML = '<span class="note">Нажмите на организм на карте.</span>'; return; }
  const p = selected, g = chosen, here = p >= 0 && sim.alive[p] && sim.geno[p] === g;
  const state = here ? `Запас ${sim.energy[p].toFixed(2)} · тело ${sim.body[p].toFixed(2)} · возраст ${sim.age[p]}<br>Сейчас: ${sim.last[p] >= 0 ? ACTIONS[sim.last[p]] : '—'}` : '<span class="note">Организм ушёл с места или умер.</span>';
  el.innerHTML = `Генотип №${g.id} (от №${g.parent}) · сейчас таких ${g.count}<br>${state}<ol>${g.rules.map((r) => `<li>${describeRule(r)}</li>`).join('')}</ol>`;
}

map.addEventListener('click', (e) => {
  const rect = map.getBoundingClientRect();
  const x = Math.floor((e.clientX - rect.left) / rect.width * sim.w), y = Math.floor((e.clientY - rect.top) / rect.height * sim.h);
  // Ближайший организм в радиусе 2 мест.
  let best = y * sim.w + x, bd = Infinity;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= sim.w || yy >= sim.h) continue;
    const q = yy * sim.w + xx; if (sim.alive[q] && dx * dx + dy * dy < bd) { bd = dx * dx + dy * dy; best = q; }
  }
  selected = best; chosen = sim.alive[best] ? sim.geno[best] : null; drawProbe(); draw();
});
$('run').addEventListener('click', () => { running = !running; $('run').textContent = running ? 'Пауза' : 'Пуск'; $('run').classList.toggle('on', !running); });
$('reset').addEventListener('click', () => { reset(); draw(); drawCharts(); drawProbe(); });
$('color').addEventListener('change', draw);

let lastCharts = 0;
function frame(now: number): void {
  if (running) {
    const n = Number($<HTMLInputElement>('speed').value);
    for (let k = 0; k < n; k++) { step(sim); if (sim.tick % SAMPLE === 0) record(); }
    draw();
    if (now - lastCharts > 500) { lastCharts = now; drawCharts(); if (selected >= 0) drawProbe(); }
  }
  requestAnimationFrame(frame);
}
reset(); draw(); drawCharts();
requestAnimationFrame(frame);
