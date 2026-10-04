import { GpuWorld } from './gpu.ts';
import { createWorldGrid } from './full-world.ts';
import { makeParams } from './generation/params.ts';

/** Test the actual generated cup, not just a hand-made contrast fixture. */
export async function checkSunFlow(gpu:GpuWorld,publish:(text:string)=>void):Promise<string>{
 const rows:string[]=[];
 const assert=(ok:boolean,why:string)=>{if(!ok)throw new Error(why);};
 const norm=(values:Float32Array)=>Math.sqrt(values.reduce((sum,v)=>sum+v*v,0));
 const grid=(sun:number)=>{const g=createWorldGrid(makeParams({seed:1,sun:Math.max(.001,sun),lightDrift:0,sunRhythm:0}));g.light!.sun=sun;return g;};
 await gpu.reset(grid(0));const dark=await gpu.snapshot();
 assert(norm(dark.flow)<1e-7,'При нулевом солнце возникло течение без источников');
 rows.push('✓ Полный мир: солнце 0, вулканы/воронки ещё не активны → течение 0');publish(rows.join('\n'));
 await gpu.reset(grid(1));const lit=await gpu.snapshot();const litNorm=norm(lit.flow);
 assert(litNorm>1e-4,'Неподвижные солнечные пятна не создали поток');
 let sourceAlignment=0,sourcePower=0;
 for(let k=0;k<gpu.grid.cols*gpu.grid.rows;k++){
  const x=k%gpu.grid.cols,y=Math.floor(k/gpu.grid.cols);
  const balance=lit.flow[k*2]+lit.flow[k*2+1]-(x>0?lit.flow[(k-1)*2]:0)-(y>0?lit.flow[(k-gpu.grid.cols)*2+1]:0);
  sourceAlignment+=balance*lit.field[k*4+3];sourcePower+=lit.field[k*4+3]**2;
 }
 assert(sourceAlignment>sourcePower*.97,'Источник потока не совпал с контрастом света');
 rows.push('✓ Пятна стоят: контраст света создаёт исходящий поток в светлых зонах и входящий в тёмных');publish(rows.join('\n'));
 // Visible material coordinates are a backtrace: their displacement opposes the flow.
 for(let i=0;i<16;i++)await gpu.advanceDynamic();
 const material=(await gpu.checkpoint()).buffers.find(b=>b.label===`material ${gpu.step%2===0?'A':'B'}`)!;
 const coordinates=new Float32Array(material.bytes.buffer,material.bytes.byteOffset,material.bytes.byteLength/4);
 let moved=0,alignment=0;
 for(let k=0;k<gpu.grid.cols*gpu.grid.rows;k++){
  if(gpu.grid.geometry[k*4+2])continue;
  const x=k%gpu.grid.cols,y=Math.floor(k/gpu.grid.cols);
  const vx=.5*(lit.flow[k*2]+(x>0?lit.flow[(k-1)*2]:0));
  const vy=.5*(lit.flow[k*2+1]+(y>0?lit.flow[(k-gpu.grid.cols)*2+1]:0));
  const dx=coordinates[k*4+2]-(x+.5),dy=coordinates[k*4+3]-(y+.5);
  moved+=dx*dx+dy*dy;alignment-=dx*vx+dy*vy;
 }
 assert(moved>1e-5&&alignment>0,'Координаты ряби не переносятся солнечным потоком');
 rows.push('✓ Рябь: координаты рисунка действительно переносятся тем же солнечным течением');publish(rows.join('\n'));
 await gpu.reset(grid(2));const brighter=await gpu.snapshot();
 const error=norm(Float32Array.from(brighter.flow,(v,k)=>v-lit.flow[k]*2))/Math.max(1e-9,2*litNorm);
 assert(error<.005,`Удвоение солнца не удвоило течение: ${error}`);
 rows.push(`✓ Солнце ×2 → течение ×${(norm(brighter.flow)/litNorm).toFixed(4)}; относительная ошибка ${(error*100).toFixed(4)}%`);
 assert(gpu.errors.length===0,gpu.errors.join('\n'));
 return rows.join('\n');
}
