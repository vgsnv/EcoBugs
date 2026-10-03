import { GpuWorld } from './gpu.ts';
import { createGrid } from './model.ts';
import { createWorldGrid } from './full-world.ts';
import { encodeCheckpoint,decodeCheckpoint } from './checkpoint.ts';
export async function checkCheckpoint(gpu:GpuWorld,publish:(s:string)=>void):Promise<{gpu:GpuWorld;report:string}>{
 const rows:string[]=[];
 const run=async(n:number)=>{for(let i=0;i<n;i++){await gpu.advanceDynamic();if(i%16===0)await gpu.device.queue.onSubmittedWorkDone();}};
 const equal=async(a:GpuWorld,b:ReturnType<typeof decodeCheckpoint>)=>{
  const shot=await a.checkpoint();
  // Draw uniforms and unordered linked-list indices are derived. Max-light reduction
  // is order-independent; every raw blob, prepared ellipse and physical field must match.
  const ignored=new Set(['render params','partial summary','light spatial index','volcano markers']);
  for(let i=0;i<shot.buffers.length;i++){const x=shot.buffers[i],y=b.buffers[i];if(!ignored.has(x.label)&&(x.bytes.length!==y.bytes.length||!x.bytes.every((v,j)=>v===y.bytes[j]||(x.label==='indexed light blobs'&&j%160>=144&&j%160<148))))throw new Error(`Продолжение расходится: ${x.label}`);}
  if(JSON.stringify([shot.sources,shot.funnels,shot.geology])!==JSON.stringify([b.sources,b.funnels,b.geology]))throw new Error('Автоматы событий расходятся');
  if((await a.summary()).massError!==0)throw new Error('Баланс сохранения нарушен');
 };
 for(const grid of [createGrid('cycle',64),createWorldGrid()]){
  await gpu.reset(grid);await run(175);const saved=decodeCheckpoint(encodeCheckpoint(await gpu.checkpoint()));
  await run(130);const expected=await gpu.checkpoint();await gpu.restore(saved);await run(130);await equal(gpu,expected);
  rows.push(`✓ ${grid.scene}: JSON сохраняет дробные остатки, массу, полёт, события и продолжение 175→305`);publish(rows.join('\n'));
 }
 const saved=await gpu.checkpoint();gpu.device.destroy();await gpu.device.lost;
 const recovered=await GpuWorld.create(gpu.canvas);await recovered.restore(saved);await equal(recovered,saved);
 await recovered.advanceDynamic();if((await recovered.summary()).massError)throw new Error('Восстановленное устройство нарушило баланс');
 rows.push('✓ потеря устройства: новое устройство восстановило все поля и продолжило расчёт');publish(rows.join('\n'));
 return {gpu:recovered,report:rows.join('\n')+'\nСохранение и восстановление проверены.'};
}
