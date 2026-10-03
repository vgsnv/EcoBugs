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
    for(let i=0;i<p.length;i+=16){
      flying+=u[i+6];if(!u[i+11])continue;
      assert([p[i],p[i+1],p[i+4]].every(Number.isFinite),'Полёт: NaN');
      const x=Math.floor(p[i]),y=Math.floor(p[i+1]);
      assert(x>=0&&y>=0&&x<grid.cols&&y<grid.rows&&!grid.geometry[(y*grid.cols+x)*4+2],'Порция оказалась в стенке');
    }
    assert(flying===m.flying,'Реальные порции расходятся с учётом полёта');
    assert(m.massError===0&&m.leak===0,'Полёт потерял массу или прошёл через стенку');
    assert(same(massByComponent(grid,grid.state),massByComponent(grid,shot.state)),'Полёт пересёк закрытый отсек');
    const reduced=await gpu.summary();assert(reduced.massError===0&&reduced.flying===flying&&reduced.flightOverflow===0,'Редукция массы полёта неверна');
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
    for(let i=0;i<p.length;i+=16)if(u[i+11]){
      count++;const distance=Math.hypot(p[i]-p[i+8],p[i+1]-p[i+9])*grid.cell;
      maxError=Math.max(maxError,Math.abs(distance-p[i+10]*mobility));
    }
    assert(count>=64&&maxError<.1,`Дальность не соответствует аналитической: ${count}, ${maxError}`);
    rows.push(`✓ μ=${mobility.toFixed(3)}, ${count} сохранённых траекторий, ошибка дальности ${maxError.toFixed(4)} мм, Δмассы 0`);publish(rows.join('\n'));
  }
  for(const speed of [5000,125]){
    const grid=fixture('flight-wall');grid.ballistics!.speed=speed;grid.ballistics!.range=1200;grid.ballistics!.direction=[1,0];
    await gpu.reset(grid);await run(100);const shot=await gpu.snapshot();await validate(grid,shot);
    for(let i=0;i<shot.particles.length;i+=16)assert(shot.particles[i]<grid.cols/2,'Порция перескочила стенку');
    rows.push(`✓ стенка: ${speed} мм/с, малые и большие перемещения, проникновения нет`);publish(rows.join('\n'));
  }
  const corner=fixture(),k=corner.sourceCell;
  corner.geometry[(k+1)*4+2]=1;corner.geometry[(k+corner.cols)*4+2]=1;
  corner.components=connectedAreas(corner.cols,corner.rows,corner.geometry);
  corner.ballistics!.direction=[1,1];corner.ballistics!.speed=Math.sqrt(2)*125;corner.ballistics!.range=1200;
  await gpu.reset(corner);await run(60);const cornerShot=await gpu.snapshot();await validate(corner,cornerShot);
  assert(diagnose(corner,cornerShot).flying===0,'Движение в углу не затухло');
  rows.push('✓ закрытый угол: повторные удары затухли, масса сохранена');publish(rows.join('\n'));
  const island=fixture('flight-island');island.ballistics!.direction=[1,0];
  await gpu.reset(island);await run(60);const islandShot=await gpu.snapshot();await validate(island,islandShot);
  const p=islandShot.particles,u=new Uint32Array(p.buffer,p.byteOffset,p.length);let error=0;const bins=[0,0,0];
  for(let i=0;i<p.length;i+=16)if(u[i+11]){
    const r=p[i+10],expected=r<=162.5?r:r<=387.5?162.5+(r-162.5)/9:r-200;
    error=Math.max(error,Math.abs((p[i]-p[i+8])*island.cell-expected));bins[r<=162.5?0:r<=387.5?1:2]++;
  }
  assert(error<.1&&bins.every(n=>n>0),`Суша не соответствует аналитической дальности: ${error}, ${bins}`);
  rows.push(`✓ остров: до / на / за сушей ${bins.join(' / ')} порций; ошибка ${error.toFixed(4)} мм`);publish(rows.join('\n'));
  const hole=fixture('flight-hole');hole.ballistics!.direction=[1,0];
  await gpu.reset(hole);await run(100);const holeShot=await gpu.snapshot();await validate(hole,holeShot);let landed=0;
  for(let i=0;i<holeShot.particles.length;i+=16){
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
  // Independent constant-deceleration reference before any wall or mixing event.
  const slowing=fixture();slowing.sourceCell=slowing.cols/2+Math.floor(slowing.rows/2)*slowing.cols;
  slowing.vents![0].cell=slowing.sourceCell;slowing.state.fill(0);slowing.state[slowing.sourceCell*4+2]=slowing.total;
  await gpu.reset(slowing);await run(3);const moving=await gpu.snapshot();await validate(slowing,moving);
  const mu=new Uint32Array(moving.particles.buffer,moving.particles.byteOffset,moving.particles.length);let speedError=0;
  for(let i=0;i<moving.particles.length;i+=16)if(mu[i+6]){
    const age=(moving.step-mu[i+15])*.1,range=moving.particles[i+10];
    const expected=250-250**2/(2*range)*age;
    speedError=Math.max(speedError,Math.abs(moving.particles[i+5]-expected));
  }
  assert(speedError<.05,`Плавное торможение отличается от аналитического: ${speedError}`);
  rows.push(`✓ плавное торможение: ошибка скорости ${speedError.toFixed(4)} мм/с`);publish(rows.join('\n'));
  for(const heading of [[1,0],[1,.5]] as [number,number][]){
    const grid=fixture('flight-wall'),source=grid.cols/2-2+Math.floor(grid.rows/4)*grid.cols;
    grid.sourceCell=source;grid.vents![0].cell=source;grid.state.fill(0);grid.state[source*4+2]=grid.total;
    grid.ballistics!.direction=heading;grid.ballistics!.range=1200;grid.ballistics!.speed=1000;
    await gpu.reset(grid);let impacts=0;const expected=Math.hypot(.15*heading[0],.75*heading[1])/Math.hypot(...heading);
    for(let step=0;step<30;step++){
      await run(1);const shot=await gpu.snapshot();await validate(grid,shot);
      const ints=new Uint32Array(shot.particles.buffer,shot.particles.byteOffset,shot.particles.length);
      for(let i=0;i<shot.particles.length;i+=16)if(ints[i+12]){
        impacts++;assert(shot.particles[i+2]<0,'После удара осталась скорость в стену');
        assert(Math.abs(shot.particles[i+14]/shot.particles[i+13]-expected)<.00001,'Неверная потеря скорости при ударе');
        if(heading[1])assert(shot.particles[i+3]>0&&shot.particles[i+1]>Math.floor(source/grid.cols)+.5,'Скольжение потеряло направление вдоль стены');
      }
    }
    assert(impacts>0,'Контрольный выброс не ударился о стену');
    rows.push(`✓ ${heading[1]?'косой':'прямой'} удар: отношение скоростей ${expected.toFixed(4)}, масса проверена на каждом из 30 шагов`);publish(rows.join('\n'));
  }
  const passage=fixture('flight-wall'),source=passage.cols/2-2+Math.floor(passage.rows/4)*passage.cols;
  passage.sourceCell=source;passage.vents![0].cell=source;passage.state.fill(0);passage.state[source*4+2]=passage.total;
  for(let y=16;y<27;y++){const j=y*passage.cols+passage.cols/2;passage.geometry[j*4+2]=0;passage.geometry[j*4]=1;}
  passage.components=connectedAreas(passage.cols,passage.rows,passage.geometry);
  passage.ballistics!.direction=[1,2];passage.ballistics!.range=1200;passage.ballistics!.speed=1000;
  passage.vents!.push({cell:source,rate:40000,start:0,end:1e9});
  await gpu.reset(passage);await run(200);const through=await gpu.snapshot();await validate(passage,through);let across=0;
  for(let j=0;j<passage.components.length;j++)if(j%passage.cols>passage.cols/2)across+=through.state[j*4];
  assert(across>0,'Течение не провело выброс через открытый проход');
  rows.push(`✓ скольжение и течение у прохода: ${(across*.001).toFixed(2)} мг на другой стороне; закрытые участки непроницаемы`);publish(rows.join('\n'));
  const lip=fixture('flight-wall',128),lipSource=lip.cols/2-2+Math.floor(lip.rows/2)*lip.cols;
  lip.sourceCell=lipSource;lip.vents![0].cell=lipSource;lip.state.fill(0);lip.state[lipSource*4+2]=lip.total;
  for(let y=4;y<9;y++){const j=y*lip.cols+lip.cols/2;lip.geometry[j*4+2]=0;lip.geometry[j*4]=1;}
  lip.components=connectedAreas(lip.cols,lip.rows,lip.geometry);lip.ballistics!.direction=[1,0];lip.ballistics!.speed=1000;lip.ballistics!.range=1200;
  await gpu.reset(lip);await run(60);const stopped=await gpu.snapshot();await validate(lip,stopped);
  for(let j=0;j<lip.components.length;j++)if(j%lip.cols>lip.cols/2)assert(stopped.state[j*4]===0,'Пятно смешивания перескочило тонкую стенку через общий отсек');
  rows.push('✓ смешивание у тонкой стенки с далёким проходом: масса не перескочила стенку внутри одной связной области');publish(rows.join('\n'));
  const moments=(grid:Grid,shot:Snapshot)=>{
    let x=0,y=0,r2=0;const sx=(grid.sourceCell%grid.cols+.5)*grid.cell,sy=(Math.floor(grid.sourceCell/grid.cols)+.5)*grid.cell;
    for(let j=0;j<grid.components.length;j++){
      const mass=shot.state[j*4],dx=(j%grid.cols+.5)*grid.cell-sx,dy=(Math.floor(j/grid.cols)+.5)*grid.cell-sy;
      x+=mass*dx;y+=mass*dy;r2+=mass*(dx*dx+dy*dy);
    }
    return {x:x/grid.total,y:y/grid.total,r:Math.sqrt(r2/grid.total)};
  };
  const sizes=[];
  for(const cols of [64,128,256]){
    const grid=fixture('flight',cols);grid.sourceCell=grid.cols/2+Math.floor(grid.rows/2)*grid.cols;
    grid.vents![0].cell=grid.sourceCell;grid.state.fill(0);grid.state[grid.sourceCell*4+2]=grid.total;
    await gpu.reset(grid);await run(60);const shot=await gpu.snapshot();const m=await validate(grid,shot);
    assert(m.flying===0&&m.reserved===0,'Уточнение сетки не завершило выброс');const value=moments(grid,shot);sizes.push(value);
    rows.push(`✓ смешивание ${cols}×${grid.rows}: центр (${value.x.toFixed(2)},${value.y.toFixed(2)}) мм, RMS ${value.r.toFixed(2)} мм`);publish(rows.join('\n'));
  }
  const fine=sizes[2];
  assert(sizes.every(v=>Math.hypot(v.x-fine.x,v.y-fine.y)<5&&Math.abs(v.r/fine.r-1)<.05),'Форма пятна зависит от сетки');
  const samples=[];
  for(const count of [32,64,128]){
    const grid=fixture('flight',128);grid.sourceCell=grid.cols/2+Math.floor(grid.rows/2)*grid.cols;
    grid.vents![0].cell=grid.sourceCell;grid.state.fill(0);grid.state[grid.sourceCell*4+2]=grid.total;grid.ballistics!.count=count;
    await gpu.reset(grid);await run(60);const shot=await gpu.snapshot();await validate(grid,shot);const value=moments(grid,shot);samples.push(value);
    rows.push(`✓ ${count} новых порций/шаг: центр (${value.x.toFixed(2)},${value.y.toFixed(2)}) мм, RMS ${value.r.toFixed(2)} мм`);publish(rows.join('\n'));
  }
  const refined=samples[2];
  assert(samples.every(v=>Math.hypot(v.x-refined.x,v.y-refined.y)<15&&Math.abs(v.r/refined.r-1)<.05),'Форма пятна зависит от числа порций');
  const timed=fixture('flight',128);await gpu.reset(timed);const started=performance.now();await run(60);await gpu.device.queue.onSubmittedWorkDone();
  rows.push(`✓ 128×96: 60 шагов с полётом и смешиванием ${(performance.now()-started).toFixed(1)} мс (один контрольный замер без изображения)`);publish(rows.join('\n'));
  assert(gpu.errors.length===0,gpu.errors.join('\n'));rows.push('Проверки баллистического полёта прошли.');return rows.join('\n');
}
