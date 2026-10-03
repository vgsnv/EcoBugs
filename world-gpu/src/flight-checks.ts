import { GpuWorld, type Snapshot } from './gpu.ts';
import { diagnose } from './checks.ts';
import { createGrid, connectedAreas, massByComponent, type Grid, type Scene } from './model.ts';

export async function checkFlight(gpu: GpuWorld, publish: (text: string) => void): Promise<string> {
  const rows: string[]=[];
  const assert=(ok:boolean,message:string)=>{if(!ok)throw new Error(message);};
  const same=(a:ArrayLike<number>,b:ArrayLike<number>)=>a.length===b.length&&Array.from(a).every((v,k)=>v===b[k]);
  const run=async(n:number,batch=16)=>{for(let i=0;i<n;i++){await gpu.advanceDynamic();if(i%batch===0)await gpu.device.queue.onSubmittedWorkDone();}};
  const fixture=(scene:Scene='flight',cols=64)=>{
    const grid=createGrid(scene,cols);for(const vent of grid.vents!)vent.rate=0;return grid;
  };
  const validate=async(grid:Grid,shot:Snapshot)=>{
    const m=diagnose(grid,shot),p=shot.particles,u=new Uint32Array(p.buffer,p.byteOffset,p.length);
    let flying=0;
    for(let i=0;i<p.length;i+=12){
      flying+=u[i+6];if(!u[i+11])continue;
      assert([p[i],p[i+1],p[i+4]].every(Number.isFinite),'Полёт: NaN');
      const x=Math.floor(p[i]),y=Math.floor(p[i+1]);
      assert(x>=0&&y>=0&&x<grid.cols&&y<grid.rows&&!grid.geometry[(y*grid.cols+x)*4+2],'Порция оказалась в стенке');
    }
    assert(flying===m.flying,'Реальные порции расходятся с учётом полёта');
    assert(m.massError===0&&m.leak===0,'Полёт потерял массу или прошёл через стенку');
    assert(same(massByComponent(grid,grid.state),massByComponent(grid,shot.state)),'Полёт пересёк закрытый отсек');
    const reduced=await gpu.summary();assert(reduced.massError===0&&reduced.flying===flying,'Редукция массы полёта неверна');
    return m;
  };
  for(const mobility of [1,1/3,1/9]){
    publish(`${rows.join('\n')}\nПроверяю дальность при подвижности ${mobility}…`);
    const grid=fixture();grid.sourceCell=grid.cols/2+Math.floor(grid.rows/2)*grid.cols;
    grid.vents![0].cell=grid.sourceCell;grid.state.fill(0);grid.state[grid.sourceCell*4+2]=grid.total;
    for(let k=0;k<grid.components.length;k++)grid.geometry[k*4]=mobility;
    await gpu.reset(grid);await run(3);const active=await validate(grid,await gpu.snapshot());
    assert(active.reserved===750000&&active.flying>0,'Частичный залп не вышел в полёт');
    await run(57);const shot=await gpu.snapshot(),m=await validate(grid,shot),p=shot.particles,u=new Uint32Array(p.buffer,p.byteOffset,p.length);
    assert(m.reserved===0&&m.flying===0,'Порции не завершили полёт');let maxError=0,count=0;
    for(let i=0;i<p.length;i+=12)if(u[i+11]){
      count++;const distance=Math.hypot(p[i]-p[i+8],p[i+1]-p[i+9])*grid.cell;
      maxError=Math.max(maxError,Math.abs(distance-p[i+10]*mobility));
    }
    assert(count>=64&&maxError<.1,`Дальность не соответствует аналитической: ${count}, ${maxError}`);
    rows.push(`✓ μ=${mobility.toFixed(3)}, ${count} сохранённых траекторий, ошибка дальности ${maxError.toFixed(4)} мм, Δмассы 0`);publish(rows.join('\n'));
  }
  for(const speed of [5000,125]){
    const grid=fixture('flight-wall');grid.ballistics!.speed=speed;grid.ballistics!.range=1200;grid.ballistics!.direction=[1,0];
    await gpu.reset(grid);await run(100);const shot=await gpu.snapshot();await validate(grid,shot);
    for(let i=0;i<shot.particles.length;i+=12)assert(shot.particles[i]<grid.cols/2,'Порция перескочила стенку');
    rows.push(`✓ стенка: ${speed} мм/с, включая границу шага, проникновения нет`);publish(rows.join('\n'));
  }
  const corner=fixture(),k=corner.sourceCell;
  corner.geometry[(k+1)*4+2]=1;corner.geometry[(k+corner.cols)*4+2]=1;
  corner.components=connectedAreas(corner.cols,corner.rows,corner.geometry);
  corner.ballistics!.direction=[1,1];corner.ballistics!.speed=Math.sqrt(2)*125;corner.ballistics!.range=1200;
  await gpu.reset(corner);await run(60);const cornerShot=await gpu.snapshot();await validate(corner,cornerShot);
  assert(cornerShot.state[k*4]===corner.total,'Полёт прорезал закрытый диагональный угол');
  rows.push('✓ закрытый диагональный угол удержал весь минерал');publish(rows.join('\n'));
  const island=fixture('flight-island');island.ballistics!.direction=[1,0];
  await gpu.reset(island);await run(60);const islandShot=await gpu.snapshot();await validate(island,islandShot);
  const p=islandShot.particles,u=new Uint32Array(p.buffer,p.byteOffset,p.length);let error=0;const bins=[0,0,0];
  for(let i=0;i<p.length;i+=12)if(u[i+11]){
    const r=p[i+10],expected=r<=162.5?r:r<=387.5?162.5+(r-162.5)/9:r-200;
    error=Math.max(error,Math.abs((p[i]-p[i+8])*island.cell-expected));bins[r<=162.5?0:r<=387.5?1:2]++;
  }
  assert(error<.1&&bins.every(n=>n>0),`Суша не соответствует аналитической дальности: ${error}, ${bins}`);
  rows.push(`✓ остров: до / на / за сушей ${bins.join(' / ')} порций; ошибка ${error.toFixed(4)} мм`);publish(rows.join('\n'));
  const hole=fixture('flight-hole');hole.ballistics!.direction=[1,0];
  await gpu.reset(hole);await run(100);const holeShot=await gpu.snapshot();await validate(hole,holeShot);let landed=0;
  for(let i=0;i<holeShot.particles.length;i+=12){
    const v=holeShot.particles[i],y=Math.floor(holeShot.particles[i+1]);
    if(hole.geometry[(y*hole.cols+Math.floor(v))*4+3])landed++;
    assert(v<Math.floor(hole.cols*.4)+1,'Порция перелетела отверстие');
  }
  assert(landed>0,'Ни одна порция не попала в отверстие');rows.push(`✓ отверстие остановило ${landed} порций; масса сохранена`);publish(rows.join('\n'));
  const small=fixture();small.ballistics!.capacity=8;
  await gpu.reset(small);await run(100);const smallMass=await validate(small,await gpu.snapshot());
  assert(smallMass.flying===0&&smallMass.reserved===0,'Малый пул потерял или задержал выдачу');
  rows.push('✓ пул из 8 порций: очередь выдана полностью, Δмассы 0');publish(rows.join('\n'));
  const replay=createGrid('sun-flight',32);
  await gpu.reset(replay);await run(200,16);const first=await gpu.snapshot();await validate(replay,first);
  await gpu.reset(replay);await run(200,5);const second=await gpu.snapshot();await validate(replay,second);
  assert(same(first.state,second.state)&&same(first.flow,second.flow)&&same(first.particles,second.particles),'Полёт зависит от пакетов кадров');
  rows.push('✓ свет + толчок + полёт: 200 шагов, повтор с другими пакетами совпал');publish(rows.join('\n'));
  for(const cols of [64,128]){
    const grid=createGrid('flight-wall',cols);await gpu.reset(grid);await run(5);await validate(grid,await gpu.snapshot());
    await run(55);await validate(grid,await gpu.snapshot());rows.push(`✓ ${cols}×${grid.rows}: масса и отсеки проверены во время и после полёта`);publish(rows.join('\n'));
  }
  assert(gpu.errors.length===0,gpu.errors.join('\n'));rows.push('Проверки баллистического полёта прошли.');return rows.join('\n');
}
