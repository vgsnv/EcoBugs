import type { GpuWorld } from './gpu.ts';
import { createGrid } from './model.ts';
export async function checkAdvection(gpu:GpuWorld,publish:(s:string)=>void):Promise<string>{
 const rows:string[]=[];
 const centre=(state:Uint32Array,cols:number,cell:number)=>{let sum=0,mass=0;for(let k=0;k<state.length/4;k++){mass+=state[k*4];sum+=state[k*4]*(k%cols+.5)*cell;}return sum/mass;};
 for(const speed of [100,500,1000]){
  const grid=createGrid('quiet',128);grid.scene='world';grid.state.fill(0);grid.total=0;
  for(let x=40;x<44;x++){grid.state[(48*grid.cols+x)*4]=10000;grid.total+=10000;}
  await gpu.reset(grid);const initial=centre(grid.state,grid.cols,grid.cell),flow=new Float32Array(grid.cols*grid.rows*2);
  for(let k=0;k<flow.length/2;k++)if(k%grid.cols+1<grid.cols)flow[k*2]=speed/grid.cell;
  await gpu.setFlowForChecks(flow);await gpu.advanceDynamic();const shot=await gpu.snapshot(),m=await gpu.summary(),shift=centre(shot.state,grid.cols,grid.cell)-initial;
  if(m.massError||m.leak||Math.abs(shift-speed*.1)>.02)throw new Error(`Снос ${speed}: Δx ${shift}, ожидалось ${speed*.1}`);
  rows.push(`✓ ${speed} мм/с: за 0,1 с центр сдвинулся на ${shift.toFixed(4)} мм, масса точна`);publish(rows.join('\n'));
 }
 const grid=createGrid('quiet',128);grid.scene='world';grid.state.fill(0);const k=48*grid.cols+64;grid.geometry[k*4+3]=3;grid.state[k*4]=100;grid.total=100;await gpu.reset(grid);
 for(let i=0;i<20;i++)await gpu.advanceDynamic();const s=await gpu.snapshot();if(!s.state[k*4+1]||(await gpu.summary()).massError)throw new Error('Дробный возврат в недра потерян');
 rows.push(`✓ медленный возврат: ${s.state[k*4+1]} квант из 100 ушёл за 20 шагов; дробная доля сохраняется`);
 for(const cols of [128,256]){
  const g=createGrid('quiet',cols);g.state.fill(0);g.terrain=new Uint32Array(g.state.length);g.total=10_000_000;
  const x=Math.floor(cols/2),y=Math.floor(g.rows/2);g.state[(y*cols+x)*4]=g.total;
  g.mineral={diffusion:100,settling:0,dissolution:0,runoff:0};await gpu.reset(g);
  for(let i=0;i<10;i++)gpu.advance();const shot=await gpu.snapshot();let variance=0;
  for(let k=0;k<cols*g.rows;k++)variance+=shot.state[k*4]*((k%cols-x)**2+(Math.floor(k/cols)-y)**2)*g.cell**2/g.total;
  if((await gpu.summary()).massError||Math.abs(variance-400)>1)throw new Error(`Диффузия ${cols}: дисперсия ${variance}, ожидалось 400 мм²`);
  rows.push(`✓ диффузия ${cols}: дисперсия ${variance.toFixed(3)} мм² за 1 с, ожидается 400 мм²; масса точна`);
 }
 return rows.join('\n')+'\nСильный снос, дробный возврат и масштаб растекания проверены.';
}
