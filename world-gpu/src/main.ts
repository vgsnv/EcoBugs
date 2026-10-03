import { audit } from './audit.ts';
import { installUi,camera,updateRulers } from './ui.ts';
import { encodeCheckpoint,decodeCheckpoint,type Checkpoint } from './checkpoint.ts';
import { checkCheckpoint } from './checkpoint-checks.ts';
import { validateParams,type WorldParams } from './generation/params.ts';
import { createWorldGrid } from './full-world.ts';
import { makeParams } from './generation/params.ts';
import { checkWorld } from './world-checks.ts';
import './style.css';
import { checkFunnels } from './funnel-checks.ts';
import { checkTerrain } from './terrain-checks.ts';
import { checkMineral } from './mineral-checks.ts';
import { GpuWorld } from './gpu.ts';
import { createGrid, QUANTUM_MG, SCENES, type Scene } from './model.ts';
import { runChecks } from './checks.ts';
import { comparePressure } from './pressure-checks.ts';
import { checkSources } from './source-checks.ts';
import { checkFlight } from './flight-checks.ts';
import { checkVents } from './vent-checks.ts';
import { checkAdvection } from './advection-checks.ts';
import { checkMultigrid } from './multigrid-checks.ts';
import { checkLight } from './light-checks.ts';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <header><div><p class="eyebrow">ECOBUGS / WEBGPU</p><h1>Течение в чашке</h1><p class="subtitle">Шаг 0,1 с · единое течение · замкнутый баланс минерала</p></div><span id="device" class="badge">Проверяю WebGPU…</span></header>
  <main><section class="surface"><div class="toolbar">
    <label>Сцена<select id="scene">${Object.entries(SCENES).map(([id, name]) => `<option value="${id}">${name}</option>`).join('')}</select></label>
    <label>Сетка<select id="grid"><option value="32">32 × 24</option><option value="64" selected>64 × 48</option><option value="128">128 × 96</option><option value="256">256 × 192</option></select></label>
    <label class="toggle"><input id="arrows" type="checkbox"> Поле скорости</label>
    <label>Дрейф света<select id="drift"><option value="0.012">Движется</option><option value="0">Стоит</option></select></label>
  </div><div class="dish"><canvas id="world" aria-label="Чашка: физическое поле среды и минерала"></canvas></div>
  <div class="transport"><button id="play">Пуск</button><button id="step">Один шаг</button><button id="reset">Сначала</button><label>Скорость<select id="speed"><option value="1">×1</option><option value="10" selected>×10</option><option value="100">×100</option></select></label><span id="runtime"></span><span id="clock">Шаг 0 · 0,0 с</span></div>
  <p class="caption">Сиреневый цвет — минерал. Оранжевые точки — источник, голубые — возвратный поток. Тёмные границы непроницаемы.</p></section>
  <aside><h2>Баланс среды</h2><div id="status" role="status">Создание устройства…</div><dl id="metrics"></dl>
  <p class="note">Течение, минерал и местность используют общие GPU-поля. Камера меняет только изображение.</p>
  <button id="interface-checks">Проверить интерфейс</button><button id="audit">Измерить и проверить цикл</button><button id="checkpoint-checks">Проверить сохранение</button><button id="checks">Проверить физику GPU</button><button id="advection-checks">Проверить сильное течение</button><button id="multigrid-checks">Проверить многоуровневое давление</button><button id="pressure-checks">Сравнить решатели</button><button id="light-checks">Проверить свет</button><button id="vent-checks">Проверить толчки</button><button id="flight-checks">Проверить полёт</button><button id="world-checks">Проверить полный мир</button><button id="funnel-checks">Проверить воронки</button><button id="terrain-checks">Проверить местность</button><button id="mineral-checks">Проверить залежи</button><button id="source-checks">Проверить источники</button><details id="save-export" hidden><summary>Текст сохранения</summary><a id="save-link">Скачать файл</a><textarea id="save-data" readonly aria-label="Текст сохранения мира"></textarea></details><pre id="report" aria-live="polite"></pre></aside></main>`;

const canvas = document.querySelector<HTMLCanvasElement>('#world')!;
const ui=installUi(canvas);
let saveUrl:string|null=null;
let checkpointing:Promise<Checkpoint>|null=null;
let worldParams:WorldParams=makeParams(),checkpoint:Checkpoint|null=null,lastCheckpoint=0;
let visualClock=0;
const draw=()=>{if(!gpu)return;gpu.draw(element<HTMLInputElement>('arrows').checked,camera,undefined,visualClock);gpu.draw(false,{x:.5,y:.5,zoom:1,layer:0},ui.mini,visualClock);updateRulers(gpu.grid.width,gpu.grid.height,gpu.grid.shape);element('ruler').textContent=`${(gpu.grid.width/camera.zoom/4).toFixed(0)} мм`;};
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const scene = element<HTMLSelectElement>('scene'), grid = element<HTMLSelectElement>('grid');
const status = element('status'), report = element('report');
let gpu: GpuWorld | null = null, paused = true, busy = true, last = performance.now(), debt = 0;
let advancing: Promise<void> = Promise.resolve();
let history:{step:number;shares:number[];medium:number;deposits:number;emitted:number;captured:number}[]=[];
const massLabel=(mg:number)=>Math.abs(mg)>=1e6?`${(mg/1e6).toFixed(2)} кг`:Math.abs(mg)>=1000?`${(mg/1000).toFixed(2)} г`:`${mg.toFixed(2)} мг`;
let pendingMetrics = false, lastMetrics = 0, completedStep = 0;
const controls = [...document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('button,select,input')];
const lock = (value: boolean) => { busy = value; for (const c of controls) c.disabled = value; };
const failure = (e: unknown) => { lock(true); paused = true; status.textContent = e instanceof Error ? e.message : String(e); status.className = 'error';for(const c of document.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>('#world-settings input,#world-settings select,#world-settings button'))c.disabled=false;if(gpu&&!gpu.lost)element<HTMLButtonElement>('reset').disabled=false; if(gpu?.lost&&checkpoint){element('recover').hidden=false;element<HTMLButtonElement>('recover').disabled=false;} } ;
async function metrics(): Promise<void> {
  if (!gpu || pendingMetrics || busy) return;
  pendingMetrics = true;
  try {
    const observedGrid = gpu.grid;
    const m = await gpu.summary();
    if (busy || gpu.grid !== observedGrid) return;
    if (m.reservoirError) throw new Error('Недостаточно общего запаса для зарезервированного извержения. Расчёт остановлен.');
    if (m.flightOverflow) throw new Error('Слишком много столкновений за шаг: движение вещества не удалось рассчитать полностью. Расчёт остановлен.');
    completedStep = m.step;
    const observation=await gpu.observe();if(busy||gpu.grid!==observedGrid)return;
    const quantum=gpu.grid.quantum??QUANTUM_MG;
    const values = [['В среде', massLabel((m.dissolved+m.flying)*quantum)], ['В недрах', massLabel((m.captured+m.reserved+m.available)*quantum)],
      ['Ошибка массы', `${m.massError} квантов`], ['Макс. скорость грани', `${m.maxSpeed.toFixed(2)} мм/с`], ['Невязка давления', m.relativeResidual.toExponential(2)]];
    if(gpu.grid.mineral)values.push(['В залежях',massLabel(m.deposits*quantum)],['Грунт',massLabel(m.ground*quantum)]);
    if (gpu.grid.ballistics) values.push(['Из них растворено', massLabel(m.dissolved*quantum)], ['Из них в полёте', massLabel(m.flying*quantum)]);
    if(gpu.sources){
      const active=gpu.sources.active;
      values.push(['Давление недр',`${((m.available+m.reserved)/gpu.sources.threshold*100).toFixed(1)}% порога`],['Извержений',String(gpu.sources.eruptions)],['Вулканы',`${gpu.sources.volcanoes.length} · ${active?.stage==='preparing'?'подготовка':active?.stage==='erupting'?'извержение':'покой'}`]);
    }
    if(gpu.funnels)values.push(['Воронки',`${gpu.funnels.active.length} · родилось ${gpu.funnels.births}`]);
    if (gpu.grid.vents) values.push(['Расчёт толчка', `${gpu.ventMilliseconds.toFixed(1)} мс`]);
    if (gpu.pressureResult) values.push([`Подготовка давления ${gpu.pressureResult.method.toUpperCase()}`, `${gpu.pressureResult.milliseconds.toFixed(1)} мс`]);
    const point={step:m.step,shares:observation.shares,medium:(m.dissolved+m.flying)*quantum,deposits:m.deposits*quantum,emitted:observation.emitted,captured:observation.captured};
    if(!history.length||history.at(-1)!.step!==m.step)history.push(point);
    while(history.length>2&&history[1].step<=m.step-600)history.shift();const before=history[0];
    values.push(['Размеры',`${gpu.grid.width.toFixed(0)} × ${gpu.grid.height.toFixed(0)} мм`],['Площадь чашки','1,92 м²'],['Вода / отмель / суша',observation.shares.map(v=>`${(v*100).toFixed(1)}%`).join(' / ')],['Среднее течение · ≈',`${observation.averageSpeed.toFixed(2)} мм/с`]);
    if(gpu.geology)values.push(['Подвижки / толчки',`${gpu.geology.active.filter(e=>!e.quake).length} / ${gpu.geology.active.filter(e=>e.quake).length}`]);
    if(point.step>before.step)values.push([`Изменения за ${((point.step-before.step)/10).toFixed(1)} с`,point.shares.map((v,i)=>`${((v-before.shares[i])*100).toFixed(2)} п.п.`).join(' / ')],['Δ среды / залежей',`${massLabel(point.medium-before.medium)} / ${massLabel(point.deposits-before.deposits)}`],['Выброс / возврат',`${massLabel(point.emitted-before.emitted)} / ${massLabel(point.captured-before.captured)}`]);
    element('metrics').innerHTML = values.map(([key, value]) => `<dt>${key}</dt><dd>${value}</dd>`).join('');
  } catch (e) { failure(e); } finally { pendingMetrics = false; }
}
async function reset(): Promise<void> {
  if (!gpu) return;
  lock(true); paused = true; debt = 0; element('play').textContent = 'Пуск'; status.textContent = 'Расчёт поля давления…';
  try {
    await advancing;await checkpointing;
    const cols = Number(grid.value);
    for (const option of grid.options) {
      const size = Number(option.value);
      option.textContent = `${size} × ${scene.value === 'circle' ? size : size * 3 / 4}`;
    }
    const initial = scene.value==='world'?createWorldGrid(makeParams({...worldParams,lightDrift:Number(element<HTMLSelectElement>('drift').value)===0?0:worldParams.lightDrift}),cols):createGrid(scene.value as Scene, cols);grid.value=String(initial.cols);
    for(const option of grid.options){const size=Number(option.value);option.disabled=scene.value==='world'&&size<128;option.textContent=`${size} × ${Math.round(size*initial.height/initial.width)}`;}
    if (initial.light&&!initial.lightMap) initial.light.drift = Number(element<HTMLSelectElement>('drift').value);
    await gpu.reset(initial);
    history=[];checkpoint=await gpu.checkpoint();lastCheckpoint=performance.now();
    completedStep = 0; status.textContent = 'WebGPU · физика готова'; status.className = '';
    lock(false); draw(); await metrics();
  } catch (e) { failure(e); }
}
element('world-settings').onsubmit=async e=>{e.preventDefault();try{const p=ui.params(),errors=validateParams(p);if(errors.length)throw new Error(errors.join('\n'));worldParams=p;scene.value='world';element('creation-error').textContent='';await reset();}catch(e){element('creation-error').textContent=e instanceof Error?e.message:String(e);}};
element('save').onclick=async()=>{if(!gpu||busy)return;paused=true;lock(true);try{await advancing;await checkpointing;checkpoint=await gpu.checkpoint();if(saveUrl)URL.revokeObjectURL(saveUrl);const blob=new Blob([encodeCheckpoint(checkpoint)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');saveUrl=url;element('save-export').hidden=false;const text=encodeCheckpoint(checkpoint);element<HTMLTextAreaElement>('save-data').value=text;const link=element<HTMLAnchorElement>('save-link');link.href=url;a.href=url;a.download=`cup-${gpu.grid.params?.seed??1}-${gpu.step}.json`;link.download=a.download;link.textContent=`Скачать ${a.download}`;document.body.append(a);a.click();a.remove();lock(false);element('play').textContent='Пуск';}catch(e){failure(e);}};
element<HTMLInputElement>('load').onchange=async e=>{const file=(e.target as HTMLInputElement).files?.[0];if(!file||!gpu)return;paused=true;lock(true);try{await advancing;await checkpointing;const saved=decodeCheckpoint(await file.text());await gpu.restore(saved);history=[];checkpoint=saved;worldParams=saved.grid.params??makeParams();ui.setParams(worldParams);scene.value=saved.grid.scene;grid.value=String(saved.grid.cols);element('play').textContent='Пуск';status.textContent=`Загружен шаг ${gpu.step}`;status.className='';lock(false);draw();await metrics();}catch(e){failure(e);}finally{(e.target as HTMLInputElement).value='';}};
element('recover').onclick=async()=>{if(!checkpoint)return;lock(true);try{gpu=await GpuWorld.create(canvas);await gpu.restore(checkpoint);history=[];status.textContent=`Восстановлен шаг ${gpu.step} из контрольной точки`;element('recover').hidden=true;lock(false);draw();await metrics();}catch(e){failure(e);}};
element('audit').onclick=async()=>{if(!gpu||busy)return;paused=true;lock(true);status.textContent='Длительный аудит GPU…';try{await advancing;await checkpointing;report.textContent=await audit(gpu,text=>{report.textContent=text;});await reset();}catch(e){report.textContent+=`\n✗ ${e instanceof Error?e.message:String(e)}`;failure(e);}};
element('advection-checks').onclick=async()=>{if(!gpu||busy)return;paused=true;lock(true);try{await advancing;await checkpointing;report.textContent=await checkAdvection(gpu,text=>{report.textContent=text;});await reset();}catch(e){report.textContent+=`\n✗ ${e instanceof Error?e.message:String(e)}`;failure(e);}};
element('multigrid-checks').onclick=async()=>{if(!gpu||busy)return;paused=true;lock(true);try{await advancing;await checkpointing;report.textContent=await checkMultigrid(gpu,text=>{report.textContent=text;});await reset();}catch(e){report.textContent+=`\n✗ ${e instanceof Error?e.message:String(e)}`;failure(e);}};
element('checkpoint-checks').onclick=async()=>{if(!gpu||busy)return;paused=true;lock(true);try{await advancing;await checkpointing;const result=await checkCheckpoint(gpu,text=>{report.textContent=text;});gpu=result.gpu;report.textContent=result.report;await reset();}catch(e){failure(e);}};
const setPaused=(value:boolean)=>{paused=value;debt=0;element('play').textContent=paused?'Пуск':'Пауза';};
element('play').onclick=()=>setPaused(!paused);
let frameWaiters:((now:number)=>void)[]=[];
const nextFrame=()=>new Promise<number>(resolve=>frameWaiters.push(resolve));
element('interface-checks').onclick=async()=>{
 if(!gpu||busy)return;setPaused(true);lock(true);
 try{
  await advancing;await checkpointing;await gpu.reset(createWorldGrid());history=[];
  for(const c of controls)c.disabled=true;busy=false;
  element<HTMLSelectElement>('speed').value='100';setPaused(false);status.textContent='Проверка изображения и управления ×100…';
  const intervals:number[]=[];let before=await nextFrame(),begin=before,firstStep=gpu.step;
  for(let i=0;i<120;i++){const now=await nextFrame();intervals.push(now-before);before=now;}
  const rate=(gpu.step-firstStep)/(before-begin)*1000;
  const pauses:number[]=[],reactions:number[]=[];
  for(let i=0;i<20;i++){
   setPaused(false);await nextFrame();const deadline=performance.now()+30;
   await new Promise<void>(resolve=>setTimeout(resolve,30));const received=performance.now();setPaused(true);
   await advancing;await gpu.device.queue.onSubmittedWorkDone();reactions.push(received-deadline);pauses.push(performance.now()-received);
   const step=gpu.step;await nextFrame();if(gpu.step!==step)throw new Error('Мир продолжился после завершённой паузы');
  }
  setPaused(true);intervals.sort((a,b)=>a-b);pauses.sort((a,b)=>a-b);reactions.sort((a,b)=>a-b);
  const m=await gpu.summary();if(m.massError||m.flightOverflow||m.reservoirError)throw new Error('Интерфейсный прогон нарушил физику');
  report.textContent=`✓ ×100 с изображением и миникартой: ${rate.toFixed(1)} шагов/с; кадры p50 ${intervals[60].toFixed(1)}, p95 ${intervals[114].toFixed(1)}, p99 ${intervals[118].toFixed(1)} мс\n✓ 20 пауз: задержка обработки p95 ${reactions[19].toFixed(1)} мс; завершение уже отправленного расчёта p95 ${pauses[19].toFixed(1)} мс; после завершения шаг не меняется\n✓ баланс точен, очередь ограничена 32 шагами`;
  lock(true);await reset();
 }catch(e){failure(e);}
};
element('step').onclick = async () => {
  if (!gpu || busy) return;
  paused = true; element('play').textContent = 'Пуск'; debt = 0;
  lock(true);
  try {
    await advancing;await checkpointing; await gpu.advanceDynamic(); await gpu.device.queue.onSubmittedWorkDone();
    lock(false); draw(); await metrics();
  } catch (e) { failure(e); }
};
element('reset').onclick = () => { void reset(); };
scene.onchange = () => { void reset(); }; grid.onchange = () => { void reset(); };
element('drift').onchange = () => { void reset(); };
element('checks').onclick = async () => {
  if (!gpu || busy) return;
  paused = true; lock(true); status.textContent = 'Выполняются числовые проверки GPU…';
  try {
    await advancing;await checkpointing;
    report.textContent = await runChecks(gpu, (text) => { report.textContent = text; });
    await reset();
  } catch (e) { report.textContent += `\n✗ ${e instanceof Error ? e.message : String(e)}`; failure(e); }
};
element('pressure-checks').onclick = async () => {
  if (!gpu || busy) return;
  paused = true; lock(true); status.textContent = 'Сравнение решателей давления…';
  try {
    await advancing;await checkpointing;
    report.textContent = await comparePressure(gpu, (text) => { report.textContent = text; });
    await reset();
  } catch (e) { report.textContent += `\n✗ ${e instanceof Error ? e.message : String(e)}`; failure(e); }
};
element('light-checks').onclick = async () => {
  if (!gpu || busy) return;
  paused = true; lock(true); status.textContent = 'Проверка динамического света…';
  try {
    await advancing;await checkpointing;
    report.textContent = await checkLight(gpu, text => { report.textContent = text; });
    await reset();
  } catch (e) { report.textContent += `\n✗ ${e instanceof Error ? e.message : String(e)}`; failure(e); }
};
element('vent-checks').onclick = async () => {
  if (!gpu || busy) return;
  paused = true; lock(true); status.textContent = 'Проверка затухающих толчков…';
  try {
    await advancing;await checkpointing;
    report.textContent = await checkVents(gpu, text => { report.textContent = text; });
    await reset();
  } catch (e) { report.textContent += `\n✗ ${e instanceof Error ? e.message : String(e)}`; failure(e); }
};
element('flight-checks').onclick = async () => {
  if (!gpu || busy) return;
  paused = true; lock(true); status.textContent = 'Проверка баллистического полёта…';
  try {
    await advancing;await checkpointing;
    report.textContent = await checkFlight(gpu, text => { report.textContent = text; });
    await reset();
  } catch (e) { report.textContent += `\n✗ ${e instanceof Error ? e.message : String(e)}`; failure(e); }
};
element('source-checks').onclick = async () => {
  if (!gpu || busy) return;
  paused=true;lock(true);status.textContent='Проверка общих недр и источников…';
  try {await advancing;await checkpointing;report.textContent=await checkSources(gpu,text=>{report.textContent=text;});await reset();}
  catch(e){report.textContent+=`\n✗ ${e instanceof Error?e.message:String(e)}`;failure(e);}
};
element('world-checks').onclick=async()=>{
 if(!gpu||busy)return;paused=true;lock(true);status.textContent='Проверка полного мира…';
 try{await advancing;await checkpointing;report.textContent=await checkWorld(gpu,text=>{report.textContent=text;});await reset();}
 catch(e){report.textContent+=`\n✗ ${e instanceof Error?e.message:String(e)}`;failure(e);}
};
element('funnel-checks').onclick=async()=>{
 if(!gpu||busy)return;paused=true;lock(true);status.textContent='Проверка воронок…';
 try{await advancing;await checkpointing;report.textContent=await checkFunnels(gpu,text=>{report.textContent=text;});await reset();}
 catch(e){report.textContent+=`\n✗ ${e instanceof Error?e.message:String(e)}`;failure(e);}
};
element('terrain-checks').onclick=async()=>{
 if(!gpu||busy)return;paused=true;lock(true);status.textContent='Проверка местности…';
 try{await advancing;await checkpointing;report.textContent=await checkTerrain(gpu,text=>{report.textContent=text;});await reset();}
 catch(e){report.textContent+=`\n✗ ${e instanceof Error?e.message:String(e)}`;failure(e);}
};
element('mineral-checks').onclick=async()=>{
 if(!gpu||busy)return;paused=true;lock(true);status.textContent='Проверка минерала и залежей…';
 try{await advancing;await checkpointing;report.textContent=await checkMineral(gpu,text=>{report.textContent=text;});await reset();}
 catch(e){report.textContent+=`\n✗ ${e instanceof Error?e.message:String(e)}`;failure(e);}
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
        const steps = Math.min(32, Math.floor(debt));
        let advanced = 0;
        advancing = (async () => {
          advanced=await gpu!.advanceBatch(steps,()=>!paused&&!busy);
        })();
        await advancing;await checkpointing; debt = paused || busy ? 0 : Math.min(32, debt - advanced);
      }
      if (!busy) {
        await gpu.device.queue.onSubmittedWorkDone(); completedStep = gpu.step;
        element('clock').textContent = `Шаг ${completedStep} · ${(completedStep / 10).toFixed(1)} с`;
        if(!paused&&now-lastCheckpoint>15000){checkpointing=gpu.checkpoint();checkpoint=await checkpointing;checkpointing=null;lastCheckpoint=now;}
        element('checkpoint-age').textContent=checkpoint?`Копия: шаг ${checkpoint.step}`:'';
        if (now - lastMetrics > 1000) { lastMetrics = now; void metrics(); }
      }
    } catch (e) { failure(e); }
  }
  requestAnimationFrame((time) => { void frame(time); });
}
let previousDraw=performance.now(),rateTime=performance.now(),rateStep=0,rateFrames=0;
async function renderFrame(now:number):Promise<void>{
 const elapsed=Math.min(.1,(now-previousDraw)/1000);previousDraw=now;
 if(gpu&&!busy&&!document.hidden){
  try{if(!paused)visualClock+=elapsed;draw();await gpu.device.queue.onSubmittedWorkDone();rateFrames++;const end=performance.now();if(end-rateTime>=1000){const seconds=(end-rateTime)/1000;element('runtime').textContent=`${(rateFrames/seconds).toFixed(0)} FPS`;element('runtime').title=`${(Math.max(0,gpu.step-rateStep)/seconds).toFixed(0)} шагов/с`;rateStep=gpu.step;rateFrames=0;rateTime=end;}for(const resolve of frameWaiters.splice(0))resolve(performance.now());}catch(e){failure(e);}
 }
 requestAnimationFrame(time=>{void renderFrame(time);});
}
requestAnimationFrame(time=>{void renderFrame(time);});
lock(true);
void GpuWorld.create(canvas).then(async (world) => {
  gpu = world;
  const info = world.adapter.info;
  element('device').textContent = `WebGPU · ${info.description || info.architecture || info.vendor || 'устройство готово'}`;
  await reset();
}).catch(failure);
requestAnimationFrame((now) => { void frame(now); });
