import { Funnels } from './funnels.ts';
import { type GpuWorld } from './gpu.ts';
import { createGrid } from './model.ts';
import { diagnose } from './checks.ts';
export async function checkFunnels(gpu:GpuWorld,publish:(s:string)=>void):Promise<string>{
 const rows:string[]=[];const assert=(ok:boolean,m:string)=>{if(!ok)throw new Error(m);};
 const run=async(n:number,batch=16)=>{for(let i=0;i<n;i++){await gpu.advanceDynamic();if(i%batch===0)await gpu.device.queue.onSubmittedWorkDone();}};
 const validate=async()=>{const s=await gpu.snapshot(),m=diagnose(gpu.grid,s),sum=await gpu.summary();assert(m.massError===0&&sum.massError===0&&m.leak===0,'Воронки нарушили баланс');assert(!sum.reservoirError&&!sum.flightOverflow,'Незавершённый обмен');return s;};
 const fixture=()=>{const g=createGrid('funnel-life',32),f=new Funnels(g.funnels!,g.cols,g.rows,g.cell,g.geometry);f.update(0,g.terrain!);for(const k of f.active[0].holes){g.state[k*4]=f.shape*2;g.total+=f.shape*2;}return g;};
 const grid=fixture();await gpu.reset(grid);await run(1);assert(gpu.funnels!.active.length===1,'Густая залежь не родила воронку');const holes=[...gpu.funnels!.active[0].holes];const zero=await validate();assert(holes.every(k=>zero.geometry[k*4+3]>=2),'Отверстие не помечено односторонним');
 await run(2199);const first=await validate(),events=JSON.stringify(gpu.funnels);assert(gpu.funnels!.active.length===1&&gpu.funnels!.active[0].strength>0,'Воронка не растёт или дублируется');assert(gpu.funnels!.active[0].holes.every((k,i)=>k===holes[i]),'Отверстие меняет форму');assert(first.reservoir[0]>0,'Воронка не возвращает избыток в недра');assert(holes.every(k=>first.state[k*4]>=gpu.funnels!.shape),'Воронка забрала обычный слой');rows.push(`✓ скопление родило одну воронку; отверстие фиксировано; ${(first.reservoir[0]*.001).toFixed(3)} мг вернулось в недра`);publish(rows.join('\n'));
 await gpu.reset(fixture());await run(2200,5);const second=await validate();assert(first.state.every((v,i)=>v===second.state[i])&&first.terrain.every((v,i)=>v===second.terrain[i])&&first.reservoir.every((v,i)=>v===second.reservoir[i])&&events===JSON.stringify(gpu.funnels),'Воронки зависят от пакетов');rows.push('✓ повтор с пакетами 16 / 5 совпал, включая скопления и недра');
 const fading=createGrid('funnel-life',32);fading.terrain!.fill(0);fading.total=0;fading.funnels!.ramp=1000;await gpu.reset(fading);gpu.funnels!.active=structuredClone(JSON.parse(events).active);for(const f of gpu.funnels!.active)f.strength=1;
 await run(1200);const gone=await validate();assert(gpu.funnels!.active.length===0&&gone.geometry.every((v,i)=>i%4!==3||v===0),'Воронка без ядра не растаяла');rows.push('✓ без сверхплотного ядра воронка тает и удаляет отверстие');
 const idle=createGrid('funnel-life',32);idle.mineral!.speed=0;await gpu.reset(idle);await run(1000);await validate();assert(gpu.funnels!.active.length===0,'Нулевая скорость местности создаёт воронку');rows.push('✓ скорость местности 0 выключает автомат воронок');
 const cycle=createGrid('cycle',32);await gpu.reset(cycle);await run(2000);const together=await validate();const controllers=JSON.stringify([gpu.sources,gpu.funnels,gpu.geology]);
 await gpu.reset(createGrid('cycle',32));await run(2000,5);const replay=await validate();assert(together.state.every((v,i)=>v===replay.state[i])&&together.terrain.every((v,i)=>v===replay.terrain[i])&&together.reservoir.every((v,i)=>v===replay.reservoir[i])&&controllers===JSON.stringify([gpu.sources,gpu.funnels,gpu.geology]),'Общий цикл зависит от пакетов');rows.push('✓ общий цикл света, вулканов, минерала и автоматов: 2000 шагов, точный баланс, повтор 16 / 5 совпал');
 assert(gpu.errors.length===0,gpu.errors.join('\n'));return rows.join('\n')+'\nПроверки жизненного цикла воронок прошли.';
}
