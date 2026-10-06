/** Страница «Код как вещество»: карта супа, размеры во времени, графики, код организма. */
import { OPS, createSoup, disassemble, resetWindow, snapshot, step, type Organism, type Soup, type SoupSnapshot } from './vm.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const map = $<HTMLCanvasElement>('map'), ctx = map.getContext('2d')!;
const sizesCanvas = $<HTMLCanvasElement>('sizes');

let soup: Soup, running = true, history: SoupSnapshot[] = [], sizeColumns: Map<number, number>[] = [];
let chosen: Organism | null = null;
const SAMPLE = 100, COLUMNS = 300, MAX_SIZE = 200;

function hsl(h: number, s: number, l: number): [number, number, number] {
  const f = (n: number) => { const k = (n + h * 12) % 12; return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}
/** Цвет размера: мельче предка — тёплые, крупнее — холодные; предок (80) — зелёный. */
const sizeColor = (size: number) => hsl(Math.min(0.75, Math.max(0, 0.33 + (size - 80) / 160)), 0.75, 0.55);
const hashHue = (key: string) => { let h = 2166136261; for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619); return (h >>> 0) / 4294967296; };

function legend(): void {
  const mode = $<HTMLSelectElement>('color').value;
  const item = (rgb: number[], text: string) => `<span><i style="background:rgb(${rgb.map(Math.round).join(',')})"></i>${text}</span>`;
  const tail = '<span>ярче — на свету; темнее — дочь, которую ещё пишут</span>';
  $('legend').innerHTML = tail + (mode === 'size' ? [item(sizeColor(40), 'мельче предка'), item(sizeColor(80), '≈ предок (80)'), item(sizeColor(160), 'крупнее'), item([90, 90, 90], 'мёртвый код')].join('')
    : mode === 'foreign' ? [item([90, 200, 110], 'исполняет свой код'), item([230, 70, 60], 'в основном чужой (паразит)'), item([230, 190, 70], 'в основном мёртвый'), item([90, 90, 90], 'мёртвый код')].join('')
      : item([90, 90, 90], 'мёртвый код') + '<span>остальное — цвет генотипа</span>');
}

function reset(): void {
  soup = createSoup(Number($<HTMLInputElement>('seed').value) || 1);
  map.width = soup.side; map.height = soup.side;
  history = []; sizeColumns = []; chosen = null;
  record(); drawProbe();
}

function record(): void {
  history.push(snapshot(soup));
  const col = new Map<number, number>();
  for (const o of soup.orgs) col.set(o.size, (col.get(o.size) ?? 0) + 1);
  sizeColumns.push(col);
  if (history.length > COLUMNS * 2) { history = history.filter((_, i) => i % 2 === 0); sizeColumns = sizeColumns.filter((_, i) => i % 2 === 0); }
  resetWindow(soup);
}

function draw(): void {
  const { side } = soup, img = ctx.createImageData(side, side), d = img.data, mode = $<HTMLSelectElement>('color').value;
  for (let a = 0; a < soup.size; a++) {
    const m = soup.toMap[a], own = soup.owner[a], l = soup.light[a];
    let r: number, g: number, b: number;
    const o = own !== 0 ? soup.byId.get(Math.abs(own)) : undefined;
    if (o) {
      if (mode === 'size') [r, g, b] = sizeColor(o.size);
      else if (mode === 'genotype') [r, g, b] = hsl(hashHue(o.genotype.key), 0.7, 0.55);
      else {
        const f = o.executed ? o.foreign / o.executed : 0, j = o.executed ? o.junk / o.executed : 0;
        r = 90 + 140 * f + 140 * j; g = 200 - 130 * f - 10 * j; b = 110 - 50 * f - 40 * j;
      }
      // Свет — яркость: в пятне организм ярче (он и исполняет больше). Дочь, которую ещё пишут, — темнее.
      const k = (0.45 + 0.55 * l) * (own < 0 ? 0.6 : 1);
      r *= k; g *= k; b *= k;
      if (chosen && o === chosen) { r = 255; g = 255; b = 255; }
    } else {
      const c = soup.code[a] > 1 ? 1 : 0;   // мёртвый код (не nop) — серее
      r = 12 + 30 * l + 50 * c; g = 20 + 34 * l + 50 * c; b = 24 + 30 * l + 50 * c;
    }
    d[m * 4] = r; d[m * 4 + 1] = g; d[m * 4 + 2] = b; d[m * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  $('clock').textContent = `ход ${soup.tick.toLocaleString('ru')}`;
}

function drawSizes(): void {
  const dpr = devicePixelRatio || 1, w = sizesCanvas.clientWidth, h = sizesCanvas.clientHeight;
  if (sizesCanvas.width !== w * dpr) { sizesCanvas.width = w * dpr; sizesCanvas.height = h * dpr; }
  const c = sizesCanvas.getContext('2d')!;
  c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
  const n = sizeColumns.length;
  if (!n) return;
  const cw = w / Math.max(n, 2);
  c.strokeStyle = '#d8d4ca'; c.beginPath(); const y80 = h - 80 / MAX_SIZE * h; c.moveTo(0, y80); c.lineTo(w, y80); c.stroke();
  c.fillStyle = '#76716a'; c.font = '9px ui-monospace, Menlo, monospace'; c.fillText('80', 2, y80 - 2); c.fillText('200', 2, 9); c.fillText('0', 2, h - 2);
  sizeColumns.forEach((col, i) => {
    let total = 0; for (const v of col.values()) total += v;
    for (const [size, count] of col) {
      if (size > MAX_SIZE) continue;
      const [r, g, b] = sizeColor(size), a = Math.min(1, 0.15 + 3 * count / Math.max(1, total));
      c.fillStyle = `rgba(${r | 0},${g | 0},${b | 0},${a})`;
      c.fillRect(i * cw, h - (size + 1) / MAX_SIZE * h, Math.max(1, cw), Math.max(1.5, h / MAX_SIZE * 1.5));
    }
  });
}

type Row = { label: string; get: (s: SoupSnapshot) => number; format: (v: number) => string };
const pct = (v: number) => `${Math.round(v * 100)}%`;
const ROWS: Row[] = [
  { label: 'Организмов', get: (s) => s.population, format: (v) => Math.round(v).toLocaleString('ru') },
  { label: 'Генотипов', get: (s) => s.genotypes, format: (v) => Math.round(v).toLocaleString('ru') },
  { label: 'Размер (среднее)', get: (s) => s.meanSize, format: (v) => v.toFixed(1) },
  { label: 'Исполняют в основном чужой код', get: (s) => s.foreignShare, format: pct },
  { label: 'Исполняют в основном мёртвый код', get: (s) => s.junkShare, format: pct },
  { label: 'Рождений за окно', get: (s) => s.births, format: (v) => Math.round(v).toLocaleString('ru') },
];
const canvases = ROWS.map((row) => {
  const el = document.createElement('div'); el.className = 'row';
  el.innerHTML = `<span>${row.label}</span><b>—</b><canvas></canvas>`;
  $('charts').append(el);
  return { canvas: el.querySelector('canvas')!, value: el.querySelector('b')! };
});
function drawCharts(): void {
  const n = history.length;
  ROWS.forEach((row, r) => {
    const { canvas, value } = canvases[r];
    value.textContent = n ? row.format(row.get(history[n - 1])) : '—';
    const dpr = devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
    const c = canvas.getContext('2d')!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
    if (n < 2) return;
    const vals = history.map(row.get), hi = Math.max(...vals, 1e-9);
    c.strokeStyle = '#a8572b'; c.lineWidth = 1.5; c.beginPath();
    vals.forEach((v, i) => { const x = i / (n - 1) * w, y = 2 + (1 - v / hi) * (h - 4); if (i) c.lineTo(x, y); else c.moveTo(x, y); });
    c.stroke();
    c.fillStyle = '#76716a'; c.font = '9px ui-monospace, Menlo, monospace'; c.textBaseline = 'top'; c.fillText(row.format(hi), 1, 0);
  });
}

function drawProbe(): void {
  const el = $('probe');
  if (!chosen) { el.innerHTML = '<span class="note">Нажмите на организм на карте.</span>'; return; }
  const o = chosen, alive = soup.byId.has(o.id);
  const f = o.executed ? o.foreign / o.executed : 0, j = o.executed ? o.junk / o.executed : 0;
  const code = disassemble(soup, o.start, o.size).map((n) => n === 'nop0' ? '<span class="t0">0</span>' : n === 'nop1' ? '<span class="t1">1</span>' : ` ${n} `).join('');
  el.innerHTML = `${alive ? '' : '<span class="note">Умер. </span>'}Размер ${o.size} · таких сейчас ${o.genotype.count} · возраст ${soup.tick - o.born} ходов<br>`
    + `Детей ${o.births} · ошибок ${o.errors}<br>Исполнил ${o.executed.toLocaleString('ru')} команд: чужих ${Math.round(f * 100)}%, мёртвых ${Math.round(j * 100)}%`
    + `<div class="code">${code}</div><p class="note">Метки: <span style="color:#4a7fb5">0</span> — nop0, <span style="color:#c0703a">1</span> — nop1. Команды: ${OPS.slice(2).join(', ')}.</p>`;
}

map.addEventListener('click', (e) => {
  const rect = map.getBoundingClientRect();
  const x = Math.floor((e.clientX - rect.left) / rect.width * soup.side), y = Math.floor((e.clientY - rect.top) / rect.height * soup.side);
  let best: Organism | null = null, bd = Infinity;
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= soup.side || yy >= soup.side) continue;
    const own = soup.owner[soup.fromMap[yy * soup.side + xx]], o = own ? soup.byId.get(Math.abs(own)) : undefined;
    if (o && dx * dx + dy * dy < bd) { bd = dx * dx + dy * dy; best = o; }
  }
  chosen = best; drawProbe(); draw();
});
$('run').addEventListener('click', () => { running = !running; $('run').textContent = running ? 'Пауза' : 'Пуск'; $('run').classList.toggle('on', !running); });
$('reset').addEventListener('click', () => { reset(); draw(); drawCharts(); drawSizes(); });
$('color').addEventListener('change', () => { legend(); draw(); });

let lastCharts = 0;
function frame(now: number): void {
  if (running) {
    const n = Number($<HTMLInputElement>('speed').value), until = performance.now() + 30;
    for (let k = 0; k < n && performance.now() < until; k++) { step(soup); if (soup.tick % SAMPLE === 0) record(); }
    draw();
    if (now - lastCharts > 500) { lastCharts = now; drawCharts(); drawSizes(); if (chosen) drawProbe(); }
  }
  requestAnimationFrame(frame);
}
legend(); reset(); draw(); drawCharts(); drawSizes();
requestAnimationFrame(frame);
