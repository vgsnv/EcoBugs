import type { GpuWorld } from './gpu.ts';
import { createWorldGrid } from './full-world.ts';
import { makeParams } from './generation/params.ts';
export async function audit(gpu:GpuWorld,publish:(s:string)=>void):Promise<string>{
 const rows:string[]=[];const timings:number[]=[];
 for(let trial=0;trial<3;trial++){
  await gpu.reset(createWorldGrid());
  for(let i=0;i<200;i++)await gpu.advanceDynamic();await gpu.device.queue.onSubmittedWorkDone();
  const begin=performance.now();
  for(let i=0;i<1500;){i+=await gpu.advanceBatch(Math.min(16,1500-i));await gpu.device.queue.onSubmittedWorkDone();}
  await gpu.device.queue.onSubmittedWorkDone();const elapsed=performance.now()-begin;timings.push(1500/elapsed*1000);
  const m=await gpu.summary();if(m.massError||m.leak||m.flightOverflow||m.reservoirError)throw new Error('Аудит выявил нарушение физики');
  rows.push(`✓ прогон ${trial+1}: ${timings.at(-1)!.toFixed(1)} шагов/с без изображения, Δмассы 0, невязка ${m.relativeResidual.toExponential(2)}`);publish(rows.join('\n'));
 }
 for(let i=0;i<17;i++)await gpu.advanceDynamic();const profiles=[];for(let i=0;i<20;i++){const p=await gpu.profileStep();if(p)profiles.push(p);}
 if(profiles.length>=20){profiles.sort((a,b)=>a.gpu-b.gpu);rows.push(`✓ шаг по timestamp-query: GPU до визуального прохода p50 ${profiles[10].gpu.toFixed(3)} мс, CPU подготовка ${profiles.map(p=>p.cpu).reduce((a,b)=>a+b,0)/profiles.length} мс`);publish(rows.join('\n'));}
 const saveStart=performance.now();const saved=await gpu.checkpoint();const saveMs=performance.now()-saveStart;const restoreStart=performance.now();await gpu.restore(saved);const restoreMs=performance.now()-restoreStart;
 rows.push(`✓ GPU-память ${(gpu.allocatedBytes/1048576).toFixed(2)} МиБ; контрольная точка ${saveMs.toFixed(1)} мс; восстановление ${restoreMs.toFixed(1)} мс`);publish(rows.join('\n'));
 const frameTimes:number[]=[];let previous=performance.now();
 for(let i=0;i<120;i++){await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));gpu.draw(false);await gpu.device.queue.onSubmittedWorkDone();const now=performance.now();frameTimes.push(now-previous);previous=now;}
 frameTimes.sort((a,b)=>a-b);rows.push(`✓ изображение на паузе: p50 ${frameTimes[60].toFixed(1)} мс, p95 ${frameTimes[114].toFixed(1)} мс, p99 ${frameTimes[118].toFixed(1)} мс`);publish(rows.join('\n'));
 // Accelerated terrain schedule exercises geology and the complete shared reservoir.
 await gpu.reset(createWorldGrid(makeParams({seed:2,terrainSpeed:100})));
 for(let i=0;i<10000;){
  i+=await gpu.advanceBatch(Math.min(16,10000-i));await gpu.device.queue.onSubmittedWorkDone();
  if(gpu.step%500===0){const m=await gpu.summary();if(m.massError||m.leak||m.flightOverflow||m.reservoirError||m.relativeResidual>.005)throw new Error(`Длительный аудит: шаг ${gpu.step}, баланс ${m.massError}, невязка ${m.relativeResidual}`);publish(rows.join('\n')+`\nДлительный цикл ${gpu.step}/10000…`);}
 }
 rows.push(`✓ 10000 шагов, сид 2, местность ×100: полный цикл, ${gpu.sources!.eruptions} извержений, ${gpu.geology!.moveCount} подвижек, ${gpu.geology!.quakeCount} толчков, ${gpu.funnels!.births} воронок; масса точна`);
 rows.push(`Средняя вычислительная скорость ${(timings.reduce((a,b)=>a+b,0)/3).toFixed(1)} шагов/с. Это GPU-аудит; ускорение относительно старого движка требует общего сопоставимого сценария.`);
 return rows.join('\n');
}
