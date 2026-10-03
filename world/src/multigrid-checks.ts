import { type GpuWorld } from './gpu.ts';
import { createGrid,type Scene } from './model.ts';
import { createWorldGrid } from './full-world.ts';
export async function checkMultigrid(gpu:GpuWorld,publish:(s:string)=>void):Promise<string>{
 const rows:string[]=[];
 const grids=[...(['contrast','wall','circle','layers','passage'] as Scene[]).map(scene=>createGrid(scene,64)),createGrid('passage',128),createWorldGrid(),createWorldGrid(undefined,200)];
 for(const grid of grids){
  publish(rows.join('\n')+`\nСравниваю ${grid.scene} ${grid.cols}…`);
  await gpu.reset(grid,{method:'sor'});const ref=await gpu.snapshot(),refResult=gpu.pressureResult!;
  const mg=await gpu.solvePressure({method:'multigrid'}),shot=await gpu.snapshot(),m=await gpu.summary();let error=0,norm=0;
  for(let i=0;i<shot.flow.length;i++){error+=(shot.flow[i]-ref.flow[i])**2;norm+=ref.flow[i]**2;}
  const difference=Math.sqrt(error/Math.max(1e-30,norm));
  if(m.relativeResidual>.003||difference>.003||m.massError||m.leak||gpu.errors.length)throw new Error(`${grid.scene} ${grid.cols}: r=${m.relativeResidual}, Δv=${difference}, ${gpu.errors.join('; ')}`);
  rows.push(`✓ ${grid.scene} ${grid.cols}×${grid.rows}: SOR ${refResult.milliseconds.toFixed(1)} мс, MG ${mg.milliseconds.toFixed(1)} мс; r=${m.relativeResidual.toExponential(2)}, Δv=${difference.toExponential(2)}, масса точна`);publish(rows.join('\n'));
 }
 return rows.join('\n')+'\nМногоуровневый решатель прошёл контрольные поля.';
}
