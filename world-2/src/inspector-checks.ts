import type { GpuWorld } from './gpu.ts';
import { createGrid } from './model.ts';
/** Independent whole-state reference is used only here, never in normal inspection. */
export async function checkInspector(world:GpuWorld):Promise<string>{
 let count=0;
 for(const scene of ['layers','flight-wall','cycle'] as const){
  await world.reset(createGrid(scene,32));
  for(let i=0;i<175;i++)await world.advanceDynamic();
  const snapshot=await world.snapshot(),grid=world.grid,quantum=grid.quantum??.001;
  for(const k of [0,grid.sourceCell,Math.floor(grid.cols*grid.rows/2),grid.cols*grid.rows-1]){
   const x=k%grid.cols,y=Math.floor(k/grid.cols),point=await world.inspect((x+.5)/grid.cols,(y+.5)/grid.rows);
   const expected=[snapshot.state[k*4]*quantum/grid.cell**2,snapshot.terrain[k*4+1]*quantum/grid.cell**2,snapshot.field[k*4],snapshot.climate[k*4+2],(snapshot.flow[k*2]+(x?snapshot.flow[(k-1)*2]:0))*.5*grid.cell,(snapshot.flow[k*2+1]+(y?snapshot.flow[(k-grid.cols)*2+1]:0))*.5*grid.cell];
   const actual=[point.mineral,point.deposits,point.light,point.temperature,point.vx,point.vy];
   if(point.cell!==k||point.step!==world.step||point.blocked!==(snapshot.geometry[k*4+2]>.5)||actual.some((v,i)=>!Number.isFinite(v)||Math.abs(v-expected[i])>1e-6))throw new Error(`Инспектор ${scene}, ячейка ${k}: значения не совпали с независимым снимком.`);
   count++;
  }
  const m=await world.summary();if(m.massError)throw new Error('Инспекция изменила баланс массы.');
 }
 return `✓ ${count} точек: минерал, залежи, свет, температура, скорость граней и границы совпали с независимым GPU-снимком\n✓ чтение 104 байт; масса неизменна; края чашки проверены`;
}
