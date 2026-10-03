import { GpuWorld } from './gpu.ts';
import { diagnose } from './checks.ts';
import { createGrid, type Grid } from './model.ts';
export async function checkSources(gpu:GpuWorld,publish:(text:string)=>void):Promise<string>{
  const rows:string[]=[];
  const assert=(ok:boolean,message:string)=>{if(!ok)throw new Error(message);};
  const same=(a:ArrayLike<number>,b:ArrayLike<number>)=>a.length===b.length&&Array.from(a).every((v,k)=>Object.is(v,b[k]));
  const run=async(n:number,batch=16)=>{for(let i=0;i<n;i++){await gpu.advanceDynamic();if(i%batch===0)await gpu.device.queue.onSubmittedWorkDone();}};
  const validate=async(grid:Grid)=>{
    const shot=await gpu.snapshot(),m=diagnose(grid,shot),summary=await gpu.summary();
    assert(m.massError===0&&m.leak===0&&summary.massError===0,'Источники нарушили массу или стенку');
    assert(summary.reservoirError===0&&summary.flightOverflow===0,'Обмен с недрами или полёт не завершены');
    const ints=new Uint32Array(shot.particles.buffer,shot.particles.byteOffset,shot.particles.length);let flying=0;
    for(let i=0;i<ints.length;i+=16)flying+=ints[i+6];assert(flying===m.flying&&flying===summary.flying,'Смена жерла потеряла учёт массы в полёте');
    return {shot,m};
  };
  const world=createGrid('volcanoes',32);await gpu.reset(world);
  assert(gpu.sources!.volcanoes.length===0,'При сотворении уже появился вулкан');
  let activeCount=0;
  for(let i=0;i<500;i++){
    await run(1);await validate(world);
    assert(gpu.sources!.volcanoes.filter(v=>v.stage==='erupting'||v.stage==='preparing').length<=1,'Одновременно работают два вулкана');
    if(gpu.sources!.active?.stage==='erupting')activeCount++;
  }
  assert(gpu.sources!.eruptions>=2&&activeCount>0,'Стартовая серия не создала несколько извержений');
  rows.push(`✓ стартовая серия: ${gpu.sources!.eruptions} извержений, 500 шагов, баланс проверен на каждом шаге`);publish(rows.join('\n'));
  const low=createGrid('volcanoes',32);low.underground=0;low.total=0;await gpu.reset(low);await run(300);
  assert(gpu.sources!.eruptions===0&&gpu.sources!.volcanoes.length===0,'При пустых недрах родился вулкан');await validate(low);
  rows.push('✓ пустые недра: подготовки и извержения нет');publish(rows.join('\n'));
  const closed=createGrid('volcano-wall',32);closed.state.fill(0);closed.underground=0;
  const left=12*closed.cols+5;closed.state[left*4+1]=5_000_000;closed.total=5_000_000;
  closed.sources!.sites=[12*closed.cols+22];closed.sources!.preparation=100;
  await gpu.reset(closed);await run(1);let shared=await validate(closed);
  assert(shared.shot.reservoir[0]===5_000_000&&shared.shot.state[left*4+1]===0,'Поглощённое вещество не поступило в общие недра');
  await run(399);shared=await validate(closed);let right=0;
  for(let k=0;k<closed.components.length;k++)if(k%closed.cols>closed.cols/2)right+=shared.shot.state[k*4]+shared.shot.state[k*4+3];
  assert(right>0&&gpu.sources!.eruptions>0,'Общие недра не передали вещество из одного закрытого отсека в другой');
  for(let y=0;y<closed.rows;y++)assert(shared.shot.flow[(y*closed.cols+closed.cols/2-1)*2]===0,'Стенка пропускает поток');
  rows.push(`✓ общие недра: поглощено в левом отсеке, ${(right*.001).toFixed(2)} мг вышло в правом; поток через стену нулевой`);publish(rows.join('\n'));
  const hole=createGrid('volcanoes',32);hole.state.fill(0);hole.underground=0;
  const k=hole.vents!.at(-1)!.cell;hole.state[k*4]=100_000;hole.total=100_000;
  hole.sources!.threshold=5_000_000;await gpu.reset(hole);await run(100);const drained=await validate(hole);
  assert(drained.shot.reservoir[0]>0&&drained.shot.state[k*4]>=12500,'Воронка не вернула избыток или забрала обычный слой');
  rows.push(`✓ отверстие вернуло ${(drained.shot.reservoir[0]*.001).toFixed(2)} мг в общий запас; обычный слой остался`);publish(rows.join('\n'));
  const replay=createGrid('volcanoes',32);await gpu.reset(replay);await run(1200,16);const first=await validate(replay),events=JSON.stringify(gpu.sources);
  await gpu.reset(createGrid('volcanoes',32));await run(1200,5);const second=await validate(gpu.grid);
  assert(same(first.shot.state,second.shot.state)&&same(first.shot.particles,second.shot.particles)&&same(first.shot.reservoir,second.shot.reservoir)&&same(first.shot.flow,second.shot.flow)&&same(first.shot.terrain,second.shot.terrain)&&events===JSON.stringify(gpu.sources),'Источники зависят от разбивки кадров');
  rows.push(`✓ 1200 шагов: GPU-состояние, общий запас и автомат побитово повторились; ${gpu.sources!.eruptions} извержений`);publish(rows.join('\n'));
  await run(1800);await validate(gpu.grid);rows.push('✓ 3000 шагов: общий баланс точен, нет ошибок очереди или полёта');publish(rows.join('\n'));
  for(const cols of [64,128]){const grid=createGrid('volcanoes',cols);await gpu.reset(grid);await run(220);await validate(grid);assert(gpu.sources!.eruptions>0,'Сетка не запустила вулкан');rows.push(`✓ ${cols}×${grid.rows}: резерв, залпы, истечение и общий баланс проверены`);publish(rows.join('\n'));}
  assert(gpu.errors.length===0,gpu.errors.join('\n'));rows.push('Проверки общих недр и вулканов прошли.');return rows.join('\n');
}
