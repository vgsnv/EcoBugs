import { type GpuWorld } from './gpu.ts';
import { createGrid, type Grid } from './model.ts';
import { diagnose } from './checks.ts';
export async function checkTerrain(gpu:GpuWorld,publish:(s:string)=>void):Promise<string>{
 const rows:string[]=[];const assert=(ok:boolean,m:string)=>{if(!ok)throw new Error(m);};
 const fixture=():Grid=>{const g=createGrid('mineral',32);g.state.fill(0);g.terrain=new Uint32Array(g.state.length);g.mineral={diffusion:0,runoff:0,settling:0,dissolution:0,erosion:.01,weathering:0,speed:1};return g;};
 const run=async(n:number,batch=16)=>{for(let i=0;i<n;i++){await gpu.advanceDynamic();if(i%batch===0)await gpu.device.queue.onSubmittedWorkDone();}};
 const shot=async()=>{const s=await gpu.snapshot(),m=diagnose(gpu.grid,s);assert(m.massError===0&&m.leak===0,'Местность потеряла массу');assert((await gpu.summary()).massError===0,'Сводка местности потеряла массу');return s;};
 const k=12*32+8;const g=fixture();for(let i=0;i<g.components.length;i++)g.geometry[i*4+1]=.5*Math.cos((i%32+.5)/32*2*Math.PI);
 g.terrain![k*4]=100000;g.terrain![k*4+1]=50000;g.total=150000;
 await gpu.reset(g);await run(10);const stripped=await shot();assert(stripped.terrain[k*4+1]<50000,'Течение не размывает залежи');assert(stripped.terrain[k*4]===100000,'Грунт размыт раньше залежей');rows.push('✓ сильный поток снимает сначала залежи, грунт сохраняется');publish(rows.join('\n'));
 await run(3000);const eroded=await shot();assert(eroded.terrain[k*4+1]===0&&eroded.terrain[k*4]<100000,'После залежей грунт не размывается');rows.push('✓ после истощения залежей размывается грунт, баланс точен');
 const hill=fixture();hill.mineral!.erosion=0;hill.mineral!.weathering=.01;hill.terrain![k*4]=100000;hill.total=100000;
 await gpu.reset(hill);await run(500);const weathered=await shot();assert(weathered.terrain[k*4]<100000&&weathered.state[k*4]>0,'Склон не выветривается');assert(weathered.terrain[k*4]>=25000,'Выветривание ушло ниже середины отмели');rows.push('✓ склон отдаёт грунт в среду, не опускается ниже середины отмели');
 const flat=fixture();flat.mineral!.erosion=0;flat.mineral!.weathering=.01;for(let i=0;i<flat.components.length;i++)flat.terrain![i*4]=100000;flat.total=100000*flat.components.length;
 await gpu.reset(flat);await run(300);const stable=await shot();assert(stable.terrain.every((m,i)=>i%4!==0||m===100000),'Плоская суша выветривается');rows.push('✓ ровная середина суши устойчива');
 const frozen=structuredClone(g);frozen.mineral!.speed=0;frozen.mineral!.weathering=1;await gpu.reset(frozen);await run(300);const idle=await shot();assert(idle.terrain[k*4]===100000&&idle.terrain[k*4+1]===50000&&idle.state.every((v,i)=>v===frozen.state[i]),'Скорость местности 0 не останавливает процессы');rows.push('✓ скорость местности 0 выключает обмены грунта и залежей');
 const dynamic=createGrid('terrain',32);await gpu.reset(dynamic);const initial=await shot();assert(Math.min(...Array.from(initial.geometry).filter((_,i)=>i%4===0))<.2,'Высокая местность не меняет сопротивление');
 await run(1000,16);const a=await shot();await gpu.reset(createGrid('terrain',32));await run(1000,5);const b=await shot();assert(a.state.every((v,i)=>v===b.state[i])&&a.terrain.every((v,i)=>v===b.terrain[i])&&a.geometry.every((v,i)=>v===b.geometry[i]),'Пересборка местности зависит от пакетов');rows.push('✓ уровень управляет сопротивлением; свет и поток пересчитываются; повтор 16 / 5 совпал');publish(rows.join('\n'));
 const moving=createGrid('geology',32);moving.mineral={diffusion:0,runoff:0,settling:0,dissolution:0,speed:1,evolving:true};moving.geology={seed:6107,moveGap:300,moveDuration:1000,quakeGap:800,quakeDuration:200};
 moving.terrain!.fill(0);for(let i=0;i<moving.components.length;i++){moving.terrain![i*4]=50000;moving.terrain![i*4+1]=1000;}moving.total=moving.underground!+51000*moving.components.length;
 await gpu.reset(moving);await run(1500,16);const moved=await shot();const events=JSON.stringify(gpu.geology);assert(moved.terrain.some((v,i)=>i%4===0&&v!==50000),'Подвижки не меняют грунт');assert(moved.terrain.some((v,i)=>i%4===1&&v===0),'Проседание не топит залежи');
 await gpu.reset(structuredClone(moving));await run(1500,5);const repeated=await shot();assert(moved.terrain.every((v,i)=>v===repeated.terrain[i])&&moved.reservoir.every((v,i)=>v===repeated.reservoir[i])&&events===JSON.stringify(gpu.geology),'Подвижки зависят от пакетов');rows.push('✓ парные подвижки и толчки меняют грунт через общие недра; проседание топит залежи; повтор 16 / 5 совпал');publish(rows.join('\n'));
 const empty=structuredClone(moving);empty.underground=0;empty.terrain!.fill(0);empty.total=0;await gpu.reset(empty);await run(1000);const noMass=await shot();assert(noMass.terrain.every((v,i)=>i%4>=2||v===0),'Подъём создал минерал из пустых недр');rows.push('✓ пустые недра и пустой грунт не дают подвижкам создать вещество');
 const stopped=structuredClone(moving);stopped.mineral!.speed=0;await gpu.reset(stopped);await run(1000);const frozenMoves=await shot();assert(frozenMoves.terrain.every((v,i)=>i%4>=2||v===stopped.terrain![i])&&gpu.geology!.active.length===0,'Нулевая скорость не остановила подвижки');rows.push('✓ нулевая скорость местности останавливает подвижки и толчки');
 assert(gpu.errors.length===0,gpu.errors.join('\n'));return rows.join('\n')+'\nПроверки местности и обменов с недрами прошли.';
}
