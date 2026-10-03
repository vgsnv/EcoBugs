import { GpuWorld, type Snapshot } from './gpu.ts';
import { diagnose } from './checks.ts';
import { createGrid, massByComponent, type Grid, type Scene } from './model.ts';
import { activeDuration } from './vents.ts';

/** Independent Float64 scalar screened equation, with no pressure gauge freedom. */
function reference(grid: Grid): Float64Array {
  const n = grid.components.length, p = new Float64Array(n), rhs = new Float64Array(n);
  for (const vent of grid.vents!) rhs[vent.cell] += vent.rate * activeDuration(vent,0,1) / grid.cell ** 2;
  for (let iteration=0;iteration<4096;iteration++) for (let k=0;k<n;k++) {
    if (grid.components[k]<0) continue;
    const x=k%grid.cols,y=Math.floor(k/grid.cols), mobility=grid.geometry[k*4];
    let sum=rhs[k],weight=grid.cell**2 / ((grid.pushLength ?? 200)**2 * mobility);
    for (const j of [x? k-1:-1,x+1<grid.cols?k+1:-1,y?k-grid.cols:-1,y+1<grid.rows?k+grid.cols:-1]) {
      if (j<0 || grid.components[j]<0) continue;
      const other=grid.geometry[j*4],c=2*mobility*other/(mobility+other);
      weight+=c; sum+=c*p[j];
    }
    p[k]=sum/weight;
  }
  return p;
}

export async function checkVents(gpu: GpuWorld, publish: (text: string) => void): Promise<string> {
  const rows: string[] = [];
  const assert=(ok:boolean,why:string)=>{if(!ok)throw new Error(why);};
  const same=(a:ArrayLike<number>,b:ArrayLike<number>)=>Array.from(a).every((v,k)=>v===b[k]);
  const run=async(n:number,batch=16)=>{
    for(let k=0;k<n;k++){await gpu.advanceDynamic();if(k%batch===0)await gpu.device.queue.onSubmittedWorkDone();}
  };
  const validate=async(grid:Grid,shot:Snapshot)=>{
    const m=diagnose(grid,shot);
    assert(m.massError===0&&m.leak===0,'Толчок: масса/стенка');
    assert(m.relativeResidual<.001,`Толчок: невязка ${m.relativeResidual}`);
    assert([...shot.flow,...shot.vents].every(Number.isFinite),'Толчок: NaN');
    assert(same(massByComponent(grid,grid.state),massByComponent(grid,shot.state)),'Толчок переносит массу между отсеками');
    for(let k=0;k<grid.components.length;k++) {
      const x=k%grid.cols,y=Math.floor(k/grid.cols);
      if(grid.components[k]<0||x===grid.cols-1||grid.components[k+1]<0)assert(shot.flow[k*2]===0,'Восточная стенка пропускает толчок');
      if(grid.components[k]<0||y===grid.rows-1||grid.components[k+grid.cols]<0)assert(shot.flow[k*2+1]===0,'Южная стенка пропускает толчок');
    }
    const reduced=await gpu.summary();
    assert(Math.abs(reduced.relativeResidual-m.relativeResidual)<1e-6&&reduced.massError===0,'Редукция толчка неверна');
    return m;
  };
  for(const scene of ['vents','vent-wall','vent-passage','vent-layers','sun-vents'] as Scene[]) {
    publish(`${rows.join('\n')}\nПроверяю ${scene}…`);
    const grid=createGrid(scene,32);await gpu.reset(grid);const shot=await gpu.snapshot(),cpu=reference(grid);
    const scale=Math.max(...cpu.map(Math.abs));
    const error=Math.max(...cpu.map((p,k)=>Math.abs(p-shot.vents[k*4])))/scale;
    assert(error<.0001,`${scene}: screened GPU/CPU ${error}`);
    await validate(grid,shot);await run(200);const end=await gpu.snapshot(),m=await validate(grid,end);
    assert(m.reserved===0,`${scene}: короткий залп не вышел целиком`);
    rows.push(`✓ ${scene}: GPU/CPU ${error.toExponential(2)}, r=${m.relativeResidual.toExponential(2)}, 200 шагов, Δмассы 0`);
    publish(rows.join('\n'));
  }
  const pulse=createGrid('vents',32);pulse.vents=pulse.vents!.slice(0,1);
  await gpu.reset(pulse);const start=await gpu.snapshot();
  assert(start.vents[pulse.sourceCell*4+1]>0,'Залп между выборками потерян');
  await run(3);assert((await gpu.snapshot()).state[pulse.sourceCell*4+2]===750000,'Частичный выброс неверен');
  await run(7);const emitted=await gpu.snapshot();
  assert(diagnose(pulse,emitted).reserved===0,'Короткий залп потерял массу');
  await run(1);const stopped=await gpu.snapshot();
  assert(stopped.vents.every(v=>v===0||v>0) && stopped.flow.every(v=>v===0),'Выключенный залп продолжает толкать');
  // Friction persists as a material property; pressure and forcing must be exactly zero.
  for(let k=0;k<pulse.components.length;k++)assert(stopped.vents[k*4]===0&&stopped.vents[k*4+1]===0,'После залпа остался источник');
  rows.push('✓ залп 0,25–0,45 с: полный интеграл, частичная выдача точна, после интервала толчок выключен');publish(rows.join('\n'));

  const constant=(scene:Scene,cols=64)=>{
    const grid=createGrid(scene,cols);grid.vents=[{cell:grid.sourceCell,rate:10000,start:0,end:1e9}];return grid;
  };
  const closed=constant('vent-wall');await gpu.reset(closed);const sealed=await gpu.snapshot();
  for(let k=0;k<closed.components.length;k++)if(k%closed.cols>closed.cols/2)assert(sealed.vents[k*4]===0,'Толчок пересёк закрытую стену');
  const passage=constant('vent-passage');await gpu.reset(passage);const around=await gpu.snapshot();
  const far=Math.floor(passage.rows*.5)*passage.cols+Math.floor(passage.cols*.65);
  assert(around.vents[far*4]>1e-7,'Толчок не огибает перегородку через проход');await validate(passage,around);
  rows.push('✓ закрытая стенка изолирует толчок; открытый проход передаёт его на другую сторону');publish(rows.join('\n'));

  const speeds:number[]=[];
  for(const mobility of [1,1/3,1/9]) {
    const grid=constant('vents');grid.vents![0].cell=Math.floor(grid.rows/2)*grid.cols+grid.cols/2;
    for(let k=0;k<grid.components.length;k++)grid.geometry[k*4]=mobility;
    await gpu.reset(grid);const shot=await gpu.snapshot();
    speeds.push(Math.abs(shot.flow[(grid.vents![0].cell+8)*2]));
  }
  assert(speeds[0]>speeds[1]*2&&speeds[1]>speeds[2]*2,'Трение не сокращает дальность');
  rows.push(`✓ поток в 200 мм: вода / отмель / суша ${speeds.map(v=>(v*25).toExponential(2)).join(' / ')} мм/с`);publish(rows.join('\n'));

  const combined=createGrid('sun-vents',32);await gpu.reset(combined);const sum=await gpu.snapshot();
  const light=createGrid('sun-vents',32);light.vents=undefined;await gpu.reset(light);const sunlight=await gpu.snapshot();
  const push=createGrid('sun-vents',32);push.light=undefined;await gpu.reset(push);const thrust=await gpu.snapshot();
  assert(sum.flow.every((v,k)=>Math.abs(v-sunlight.flow[k]-thrust.flow[k])<.00001),'Суммарный поток не равен сумме физических полей');
  const cancel=constant('vents',32);cancel.vents!.push({...cancel.vents![0],rate:-10000});await gpu.reset(cancel);
  assert((await gpu.snapshot()).flow.every(v=>v===0),'Противоположные толчки не компенсируются');
  rows.push('✓ солнечный и затухающий потоки складываются; одинаковые противоположные источники компенсируются');publish(rows.join('\n'));

  const reversed=createGrid('vents',32),hole=reversed.vents![1].cell;
  reversed.vents=[{cell:hole,rate:10000,start:0,end:1e9}];
  reversed.state.fill(0);reversed.state[hole*4]=100000;reversed.total=100000;
  await gpu.reset(reversed);await run(200);const trapped=await gpu.snapshot();
  assert(diagnose(reversed,trapped).massError===0&&trapped.state[hole*4+1]>0,'Воронка не сохраняет/не поглощает избыток');
  assert(trapped.state[hole*4]>=12500,'Воронка забрала обычный слой');
  for(let k=0;k<reversed.components.length;k++)if(!reversed.geometry[k*4+3])assert(trapped.state[k*4]===0,'Обратный толчок вынес минерал из отверстия');
  rows.push('✓ обратный толчок не выносит минерал из отверстия; избыток поглощается, обычный слой остаётся');publish(rows.join('\n'));

  const replay=createGrid('sun-vents',32);await gpu.reset(replay);await run(200,16);const first=await gpu.snapshot();
  await gpu.reset(replay);await run(200,5);const second=await gpu.snapshot();
  assert(same(first.state,second.state)&&same(first.flow,second.flow)&&same(first.vents,second.vents),'Толчки зависят от пакетов шагов');
  rows.push('✓ повтор динамики с другими пакетами совпал');publish(rows.join('\n'));
  await run(800);await validate(replay,await gpu.snapshot());
  rows.push('✓ совместный поток: 1000 шагов, Δмассы 0');publish(rows.join('\n'));
  for(const cols of [64,128]) {
    const grid=createGrid('vents',cols);await gpu.reset(grid);const initial=await validate(grid,await gpu.snapshot());await run(40);
    await validate(grid,await gpu.snapshot());rows.push(`✓ ${cols}×${grid.rows}: начальная r=${initial.relativeResidual.toExponential(2)}, Δмассы 0`);publish(rows.join('\n'));
  }
  assert(gpu.errors.length===0,gpu.errors.join('\n'));
  rows.push('Проверки толчков прошли. Полный цикл воронок требует залежей.');return rows.join('\n');
}
