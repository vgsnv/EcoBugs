/** Страница лаборатории: холст отдаётся Worker, здесь — управление и сводка. */
import type { GpuWorldCommand, GpuWorldReply, GpuWorldStats } from './protocol.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const opts = { seed: num('seed', 1), cap: num('cap', 100_000), speed: num('speed', 100), compactEvery: num('k', 4), quantaPerCell: num('quanta', 30), mineralOptional: num('need', 0) === 0, carry: num('carry', 0.1), push: num('push', 0.5) };

const canvas = $<HTMLCanvasElement>('view'), out = $<HTMLPreElement>('log'), summary = $<HTMLDivElement>('summary');
const lines: string[] = [];
const history: GpuWorldStats[] = [];
const state = { lines, history, checks: [] as unknown[], ready: false };
(window as unknown as { gpuWorld: typeof state }).gpuWorld = state;
const log = (s: string) => { lines.push(s); out.textContent = lines.slice(-200).join('\n'); };

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const post = (m: GpuWorldCommand, t: Transferable[] = []) => worker.postMessage(m, t);
const off = canvas.transferControlToOffscreen();
post({ type: 'start', canvas: off, ...opts }, [off]);
log(`сид ${opts.seed}, предел ${opts.cap.toLocaleString('ru')}, ×${opts.speed}, уплотнение раз в ${opts.compactEvery} ходов, ${opts.quantaPerCell} квантов на клетку при пределе, минерал ${opts.mineralOptional ? 'ускоряет рост, не обязателен' : 'обязателен для роста'}, снос у дна ${opts.carry}, расталкивание ${opts.push}`);

const f0 = (x: number) => Math.round(x).toLocaleString('ru');
const f1 = (x: number) => x.toFixed(1);
worker.onmessage = ({ data }: MessageEvent<GpuWorldReply>) => {
  if (data.type === 'error') { log('ОШИБКА: ' + data.message); return; }
  if (data.type === 'ready') {
    canvas.style.aspectRatio = `${data.width} / ${data.height}`;
    state.ready = true;
    log(`мир ${data.shape} ${f0(data.width)}×${f0(data.height)} мм, сетка минерала ${f0(data.mineralCells)} клеток; квант ${data.quantum.toPrecision(3)}; посеяно ${f0(data.seeded)} квантов в телах`);
    return;
  }
  if (data.type === 'check') {
    state.checks.push(data);
    log(`проверка: живых ${f0(data.alive)}, в связях ${f1(100 * data.bonded / Math.max(1, data.alive))}%; кванты: в телах ${f0(data.bodies)} + сдано миру ${f0(data.flushed)} + в пути ${f0(data.pending)} = ${f0(data.bodies + data.flushed + data.pending)} из ${f0(data.seeded)} — ${data.exact ? 'точно' : 'РАСХОЖДЕНИЕ'}; мир + жизнь: ${data.worldBefore.toPrecision(12)} → ${data.worldNow.toPrecision(12)}; наименьшее поле ${data.minField.toPrecision(3)}`);
    log(data.sample);
    return;
  }
  history.push(data);
  const s = data;
  summary.innerHTML = [
    ['Шаг мира / ход жизни', `${f0(s.step)} / ${f0(s.tick)}`],
    ['Шагов/с (цель)', `${f0(s.stepsPerSecond)} (${f0(s.target)})`],
    ['Ходов жизни/с', f0(s.ticksPerSecond)],
    ['Живых / мест', `${f0(s.alive)} / ${f0(s.slots)}`],
    ['Рождений / смертей', `${f0(s.births)} / ${f0(s.deaths)}`],
    ['Кадров/с', f1(s.fps)],
    ['CPU, мс/с: мир, поля, команды', `${f0(s.cpuWorld)}, ${f0(s.cpuFields)}, ${f0(s.cpuEncode)}`],
    ['Самый долгий шаг мира, мс', f1(s.worldSpike)],
    ['Видеокарта: отправка → готово, мс', f1(s.gpuLatency)],
    ['Ждали видеокарту / минерал, кадров', `${s.waitGpu} / ${s.waitMineral}`],
    ['Сдача минерала, мс', f1(s.flushLatency)],
    ['Взято квантов / сверх поля', `${f0(s.takes)} / ${f0(s.overdraw)}`],
  ].map(([k, v]) => `<div class="row"><span>${k}</span><b>${v}</b></div>`).join('');
  log(`шаг ${s.step}: ${f0(s.stepsPerSecond)}/${f0(s.target)} шагов/с, ${f0(s.ticksPerSecond)} ходов/с, ${f1(s.fps)} к/с; живых ${f0(s.alive)} мест ${f0(s.slots)}; CPU мир ${f0(s.cpuWorld)} поля ${f0(s.cpuFields)} команды ${f0(s.cpuEncode)} мс/с, пик ${f1(s.worldSpike)} мс; GPU ${f1(s.gpuLatency)} мс; ждали GPU ${s.waitGpu} минерал ${s.waitMineral}; сдача ${f1(s.flushLatency)} мс; сверх поля ${s.overdraw}`);
};

for (const sp of [10, 50, 100, 200]) {
  const bt = document.createElement('button');
  bt.textContent = `×${sp}`;
  bt.onclick = () => { post({ type: 'control', speed: sp }); log(`ускорение ×${sp}`); };
  $('bar').append(bt);
}
$<HTMLButtonElement>('check').onclick = () => post({ type: 'check' });
(window as unknown as { gpuCheck: () => void }).gpuCheck = () => post({ type: 'check' });
