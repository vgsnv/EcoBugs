/**
 * Страница отчёта стенда замеров: по параметру — сетка маленьких графиков,
 * по графику на наблюдаемую величину. Линия — среднее по сидам, полоса вокруг —
 * разброс по сидам, серая горизонтальная полоса — шум мира при параметрах по
 * умолчанию. Величины упорядочены по отклику: сначала те, на которые параметр влияет.
 */

const PARAM_TITLES = {
  spotCount: 'Число пятен', spotArea: 'Площадь пятна, см²', driftCross: 'Пятна пересекают чашу, ч', driftTurn: 'Смена направления дрейфа, ч',
  sunRhythm: 'Размах ритма солнца', sunPeriod: 'Период ритма солнца, шагов', rhythmShape: 'Форма ритма', spotWobble: 'Неровность края пятна',
  spotBreath: 'Дыхание края пятна, ч', lightShadow: 'Свет в тени, лм/см²', lightExtra: 'Пятно ярче тени на, лм/см²',
  driftResponse: 'Отклик среды на свет', resistanceShallows: 'Сопротивление отмели', resistanceLand: 'Сопротивление суши',
  landCount: 'Число массивов суши', landArea: 'Площадь массива, см²', coastRoughness: 'Изрезанность берега', shelfWidth: 'Ширина отмели, см',
  mineralStock: 'Запас минерала, кг/м²', eruptionPressure: 'Давление извержения', settleHalf: 'Оседание минерала, мин',
  turbidityLoss: 'Мутность', groundThreshold: 'Порог срыва грунта, мм/с', slopeLimit: 'Устойчивый склон', tectonicVolume: 'Объём тектоники, см²/ч',
  heights: 'Высоты тектоники',
};

/** Отклик сильнее шума в столько раз — величина считается затронутой. */
const AFFECTED = 3;

export function renderHtml(data, summary, metrics) {
  const payload = { seeds: data.seeds, defaults: data.defaults, titles: PARAM_TITLES, metrics, summary, affected: AFFECTED };
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Отклик параметров</title>
<style>
:root {
  color-scheme: light;
  --surface: #fcfcfb; --card: #ffffff; --border: #e4e3de;
  --text-primary: #0b0b0b; --text-secondary: #52514e; --text-muted: #8a8984;
  --series: #2a78d6; --series-band: rgba(42, 120, 214, 0.16);
  --noise-band: rgba(120, 118, 110, 0.14); --noise-line: #a8a7a0; --grid: #eeede8;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --surface: #1a1a19; --card: #222220; --border: #34332f;
    --text-primary: #ffffff; --text-secondary: #c3c2b7; --text-muted: #8f8e86;
    --series: #3987e5; --series-band: rgba(57, 135, 229, 0.22);
    --noise-band: rgba(200, 198, 188, 0.12); --noise-line: #6d6c66; --grid: #2c2b28;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --surface: #1a1a19; --card: #222220; --border: #34332f;
  --text-primary: #ffffff; --text-secondary: #c3c2b7; --text-muted: #8f8e86;
  --series: #3987e5; --series-band: rgba(57, 135, 229, 0.22);
  --noise-band: rgba(200, 198, 188, 0.12); --noise-line: #6d6c66; --grid: #2c2b28;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--surface); color: var(--text-primary); font: 14px/1.45 system-ui, -apple-system, sans-serif; }
main { max-width: 1280px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 22px; margin: 0 0 4px; }
.lead { color: var(--text-secondary); margin: 0 0 16px; max-width: 760px; }
nav { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 20px; position: sticky; top: 0; background: var(--surface); padding: 8px 0; z-index: 2; }
nav button { font: inherit; border: 1px solid var(--border); background: var(--card); color: var(--text-primary); border-radius: 999px; padding: 4px 12px; cursor: pointer; }
nav button[aria-pressed="true"] { background: var(--text-primary); color: var(--surface); border-color: var(--text-primary); }
h2 { font-size: 18px; margin: 8px 0 4px; }
.meta { color: var(--text-secondary); margin: 0 0 12px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px 6px; position: relative; }
.card.flat { opacity: 0.55; }
.card h3 { font-size: 13px; font-weight: 600; margin: 0; }
.card .ratio { font-size: 12px; color: var(--text-secondary); margin: 0 0 4px; }
.card .ratio b { color: var(--text-primary); }
svg { display: block; width: 100%; height: auto; overflow: visible; }
svg text { fill: var(--text-muted); font-size: 10px; }
.tip { position: fixed; pointer-events: none; background: var(--card); color: var(--text-primary); border: 1px solid var(--border); border-radius: 8px; padding: 6px 8px; font-size: 12px; box-shadow: 0 4px 16px rgba(0,0,0,.12); z-index: 5; }
.legend { display: flex; flex-wrap: wrap; gap: 16px; color: var(--text-secondary); font-size: 12px; margin: 0 0 12px; }
.legend i { display: inline-block; width: 18px; height: 10px; border-radius: 2px; vertical-align: -1px; margin-right: 6px; }
details { margin-top: 12px; }
summary { cursor: pointer; color: var(--text-secondary); }
table { border-collapse: collapse; font-size: 12px; margin-top: 8px; }
td, th { border-bottom: 1px solid var(--border); padding: 3px 8px; text-align: right; white-space: nowrap; }
th:first-child, td:first-child { text-align: left; }
.errors { color: #c0392b; font-size: 12px; }
</style>
</head>
<body>
<main>
<h1>Отклик параметров мира</h1>
<p class="lead" id="lead"></p>
<div class="legend">
  <span><i style="background: var(--series)"></i>среднее по сидам</span>
  <span><i style="background: var(--series-band)"></i>разброс по сидам (±1 ст. откл.)</span>
  <span><i style="background: var(--noise-band); border: 1px dashed var(--noise-line)"></i>шум мира: прогоны по умолчанию ±1 ст. откл.</span>
  <span>● — значение по умолчанию</span>
</div>
<nav id="nav"></nav>
<section id="view"></section>
</main>
<div class="tip" id="tip" hidden></div>
<script>
const DATA = ${JSON.stringify(payload)};
const fmt = (v) => typeof v === 'string' ? v : !Number.isFinite(v) ? '—' : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('ru') : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : Math.abs(v) >= 0.1 ? v.toFixed(2) : v.toPrecision(2);
document.getElementById('lead').textContent = 'Каждый параметр проходит по точкам своего диапазона, остальные — по умолчанию; каждая точка — ' + DATA.seeds.length + ' сида. Длина прогона — по времени процесса: свет меряется без шагов мира, течения — часы, минерал и тектоника — сутки (указано у параметра). Значение величины — среднее по второй половине прогона. «Отклик» — размах средних по диапазону в долях шума мира; выше ' + DATA.affected + ' — параметр заметно влияет, такие графики идут первыми. Бледные — отклик в пределах шума.';
const tip = document.getElementById('tip');
const nav = document.getElementById('nav'), view = document.getElementById('view');
const params = Object.keys(DATA.summary);
const ns = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs) => { const n = document.createElementNS(ns, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };

function chart(param, key, unit) {
  const { points } = DATA.summary[param];
  const noise = defaultStats(param, key);
  const W = 240, H = 120, L = 34, R = 8, T = 6, B = 20;
  const ys = [];
  for (const p of points) { const m = p.metrics[key]; if (m) ys.push(m.mean - m.sd, m.mean + m.sd); }
  if (noise) ys.push(noise.mean - noise.sd, noise.mean + noise.sd);
  if (!ys.length) return null;
  let lo = Math.min(...ys), hi = Math.max(...ys);
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  if (lo < 0 && Math.min(...ys) >= 0) lo = 0;
  const x = (i) => L + (points.length === 1 ? 0.5 : i / (points.length - 1)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img' });
  for (const v of [lo + pad, (lo + hi) / 2, hi - pad]) {
    svg.append(svgEl('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: 'var(--grid)', 'stroke-width': 1 }));
    const t = svgEl('text', { x: L - 4, y: y(v) + 3, 'text-anchor': 'end' }); t.textContent = fmt(v); svg.append(t);
  }
  if (noise) {
    svg.append(svgEl('rect', { x: L, width: W - L - R, y: y(noise.mean + noise.sd), height: Math.max(1, y(noise.mean - noise.sd) - y(noise.mean + noise.sd)), fill: 'var(--noise-band)' }));
    svg.append(svgEl('line', { x1: L, x2: W - R, y1: y(noise.mean), y2: y(noise.mean), stroke: 'var(--noise-line)', 'stroke-dasharray': '3 3', 'stroke-width': 1 }));
  }
  const ok = points.map((p, i) => [i, p.metrics[key]]).filter(([, m]) => m);
  if (ok.length > 1) {
    const top = ok.map(([i, m]) => x(i) + ',' + y(m.mean + m.sd)).join(' ');
    const bottom = ok.slice().reverse().map(([i, m]) => x(i) + ',' + y(m.mean - m.sd)).join(' ');
    svg.append(svgEl('polygon', { points: top + ' ' + bottom, fill: 'var(--series-band)' }));
    svg.append(svgEl('polyline', { points: ok.map(([i, m]) => x(i) + ',' + y(m.mean)).join(' '), fill: 'none', stroke: 'var(--series)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  }
  points.forEach((p, i) => {
    const t = svgEl('text', { x: x(i), y: H - 5, 'text-anchor': 'middle' }); t.textContent = fmt(p.value); svg.append(t);
    const m = p.metrics[key];
    if (m) svg.append(svgEl('circle', { cx: x(i), cy: y(m.mean), r: p.isDefault ? 4.5 : 3, fill: p.isDefault ? 'var(--text-primary)' : 'var(--series)', stroke: 'var(--card)', 'stroke-width': 2 }));
    const hit = svgEl('rect', { x: x(i) - (W - L - R) / (2 * Math.max(1, points.length - 1)), y: 0, width: (W - L - R) / Math.max(1, points.length - 1), height: H, fill: 'transparent' });
    hit.addEventListener('mousemove', (e) => {
      tip.hidden = false;
      tip.innerHTML = '<b>' + DATA.titles[param] + ' = ' + fmt(p.value) + (p.isDefault ? ' (по умолчанию)' : '') + '</b><br>' +
        (m ? fmt(m.mean) + ' ± ' + fmt(m.sd) + ' ' + unit + ' · сидов: ' + m.n : 'нет данных') +
        (p.errors.length ? '<br><span class="errors">' + p.errors[0] + '</span>' : '');
      tip.style.left = Math.min(innerWidth - tip.offsetWidth - 8, e.clientX + 12) + 'px';
      tip.style.top = (e.clientY + 12) + 'px';
    });
    hit.addEventListener('mouseleave', () => { tip.hidden = true; });
    svg.append(hit);
  });
  return svg;
}

function defaultStats(param, key) {
  const p = DATA.summary[param].points.find((q) => q.isDefault);
  return p ? p.metrics[key] : null;
}

function show(param) {
  for (const b of nav.children) b.setAttribute('aria-pressed', String(b.dataset.param === param));
  const { points, response, hours } = DATA.summary[param];
  // В световых прогонах течения и минерал не меряются — их графиков нет.
  const measured = DATA.metrics.filter(([k]) => points.some((p) => p.metrics[k]));
  view.replaceChildren();
  const h = document.createElement('h2'); h.textContent = DATA.titles[param] ?? param;
  const meta = document.createElement('p'); meta.className = 'meta';
  const affected = measured.filter(([k]) => response[k].ratio >= DATA.affected).length;
  meta.textContent = 'Точки: ' + points.map((p) => fmt(p.value) + (p.isDefault ? ' (по умолчанию)' : '')).join(' · ') + '. Прогон — ' + fmt(hours) + ' ч мира. Заметно влияет на ' + affected + ' из ' + measured.length + ' величин.';
  view.append(h, meta);
  for (const p of points) if (p.errors.length) {
    const e = document.createElement('p'); e.className = 'errors'; e.textContent = fmt(p.value) + ': ' + p.errors[0]; view.append(e);
  }
  const grid = document.createElement('div'); grid.className = 'grid';
  const order = measured.slice().sort((a, b) => (response[b[0]].ratio || 0) - (response[a[0]].ratio || 0));
  for (const [key, label, unit] of order) {
    const r = response[key].ratio;
    const card = document.createElement('div'); card.className = 'card' + (r >= DATA.affected ? '' : ' flat');
    const t = document.createElement('h3'); t.textContent = label + (unit ? ', ' + unit : '');
    const s = document.createElement('p'); s.className = 'ratio';
    s.innerHTML = 'отклик <b>' + (r === null || r === Infinity || r > 1e6 ? '∞' : fmt(r)) + '</b> × шума';
    card.append(t, s);
    const c = chart(param, key, unit); if (c) card.append(c);
    grid.append(card);
  }
  view.append(grid);
  const det = document.createElement('details');
  const sum = document.createElement('summary'); sum.textContent = 'Таблица значений';
  const table = document.createElement('table');
  table.innerHTML = '<tr><th>Величина</th>' + points.map((p) => '<th>' + fmt(p.value) + (p.isDefault ? '*' : '') + '</th>').join('') + '<th>отклик</th></tr>' +
    DATA.metrics.map(([k, label, unit]) => '<tr><td>' + label + (unit ? ', ' + unit : '') + '</td>' + points.map((p) => '<td>' + (p.metrics[k] ? fmt(p.metrics[k].mean) + ' ± ' + fmt(p.metrics[k].sd) : '—') + '</td>').join('') + '<td>' + fmt(response[k].ratio) + '</td></tr>').join('');
  det.append(sum, table); view.append(det);
  try { localStorage.setItem('bench.param', param); } catch {}
}

for (const p of params) {
  const b = document.createElement('button'); b.textContent = DATA.titles[p] ?? p; b.dataset.param = p;
  b.addEventListener('click', () => show(p)); nav.append(b);
}
let start = params[0];
try { const saved = localStorage.getItem('bench.param'); if (saved && params.includes(saved)) start = saved; } catch {}
show(start);
</script>
</body>
</html>
`;
}
