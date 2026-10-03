import { type GpuWorld } from './gpu.ts';
import { createGrid, type Grid } from './model.ts';
import { diagnose } from './checks.ts';

export async function checkMineral(gpu:GpuWorld,publish:(text:string)=>void):Promise<string>{
 const rows:string[]=[];const assert=(ok:boolean,message:string)=>{if(!ok)throw new Error(message);};
 const run=async(n:number,batch=16)=>{for(let i=0;i<n;i++){gpu.advance();if(i%batch===0)await gpu.device.queue.onSubmittedWorkDone();}await gpu.device.queue.onSubmittedWorkDone();};
 const fixture=(cols=32):Grid=>{const g=createGrid('mineral',cols);g.state.fill(0);g.terrain=new Uint32Array(g.state.length);return g;};
 const balance=async(g:Grid)=>{const s=await gpu.snapshot(),m=diagnose(g,s),summary=await gpu.summary();assert(m.massError===0&&m.leak===0,'Нарушен баланс или граница');assert(summary.deposits===m.deposits&&summary.ground===m.ground&&summary.massError===0,'Сводка залежей расходится');return s;};
 const g=fixture(),k=12*g.cols+8;g.state[k*4]=1_000_000;g.total=1_000_000;g.mineral={diffusion:100,settling:0,dissolution:0,runoff:0};
 await gpu.reset(g);await run(1000);const spread=await balance(g);
 assert(spread.state[k*4]<1_000_000&&spread.state[(k+1)*4]>0,'Густое пятно не растекается');
 await gpu.reset(g);await run(1000,5);const repeat=await balance(g);assert(repeat.state.every((m,i)=>m===spread.state[i]),'Разбиение команд изменило растекание');
 rows.push('✓ густое пятно растекается; баланс точен; пакеты 16 / 5 дают одинаковое состояние');publish(rows.join('\n'));
 const flat=fixture();flat.state.fill(0);for(let i=0;i<flat.components.length;i++)flat.state[i*4]=10000;flat.total=flat.components.length*10000;flat.mineral=g.mineral;
 await gpu.reset(flat);await run(500);const uniform=await balance(flat);assert(uniform.state.every((m,i)=>m===flat.state[i]),'Ровный фон растекается');rows.push('✓ ровный фон неподвижен');
 const wall=fixture();for(let y=0;y<wall.rows;y++)wall.geometry[(y*wall.cols+16)*4+2]=1;wall.state[k*4]=1_000_000;wall.total=1_000_000;wall.mineral=g.mineral;
 await gpu.reset(wall);await run(1000);const isolated=await balance(wall);for(let i=0;i<wall.components.length;i++)if(i%wall.cols>=16)assert(isolated.state[i*4]===0,'Растекание прошло через стенку');rows.push('✓ перегородка не пропускает растекание');
 const hole=fixture();hole.geometry[k*4+3]=1;hole.state[k*4]=10000;hole.total=10000;hole.mineral={...g.mineral,runoff:100};
 await gpu.reset(hole);await run(500);const trapped=await balance(hole);for(let i=0;i<hole.components.length;i++)if(i!==k)assert(trapped.state[i*4]===0,'Стекание вынесло минерал из отверстия');rows.push('✓ отверстие не выпускает минерал при растекании и стекании');
 const rates:number[]=[];
 for(const mobility of [1,1/3,1/9]){const layer=fixture();for(let i=0;i<layer.components.length;i++)layer.geometry[i*4]=mobility;layer.state[k*4]=1_000_000;layer.total=1_000_000;layer.mineral=g.mineral;await gpu.reset(layer);gpu.advance();rates.push(1_000_000-(await balance(layer)).state[k*4]);}
 assert(Math.abs(rates[0]/rates[1]-3)<.01&&Math.abs(rates[0]/rates[2]-9)<.01,'Нарушены сопротивления растекания');rows.push(`✓ вода / отмель / суша: перенос ${rates.join(' / ')} квантов, отношение 1 : ⅓ : ⅑`);
 const slope=fixture();slope.state[k*4]=100000;slope.terrain![k*4]=100000;slope.total=200000;slope.mineral={diffusion:0,settling:0,dissolution:0,runoff:100};
 await gpu.reset(slope);await run(100);const downhill=await balance(slope);assert(downhill.state[(k+1)*4]>0&&downhill.terrain[k*4]===100000,'Стекание не учитывает грунт');rows.push('✓ минерал стекает с высокого грунта, грунт не перемещается');
 const settle=fixture();settle.state[k*4]=200000;settle.total=200000;settle.mineral={diffusion:0,settling:.01,dissolution:0,runoff:0};
 await gpu.reset(settle);await run(1000);const settled=await balance(settle);const cap=Math.floor(settle.cell**2*.02/.001);assert(settled.terrain[k*4+1]===cap&&settled.state[k*4]===200000-cap,'Оседание превышает верх отмели');rows.push('✓ оседание ограничено верхом отмели и точно переводит массу в залежи');
 const dissolve=fixture();dissolve.terrain![k*4+1]=50000;dissolve.total=50000;dissolve.mineral={diffusion:0,settling:0,dissolution:.00005,runoff:0};
 await gpu.reset(dissolve);await run(10000);const returned=await balance(dissolve);assert(returned.state[k*4]>2000&&returned.state[k*4]<3000,'Неверная скорость растворения');rows.push(`✓ медленное растворение: ${(returned.state[k*4]*.001).toFixed(3)} мг за 10 000 шагов; баланс точен`);publish(rows.join('\n'));
 for(const cols of [64,128]){const bigger=fixture(cols);const center=Math.floor(bigger.rows/2)*cols+Math.floor(cols/2);bigger.state[center*4]=1_000_000;bigger.total=1_000_000;await gpu.reset(bigger);await run(500);await balance(bigger);rows.push(`✓ ${cols}×${bigger.rows}: совместное растекание, стекание, оседание и растворение без потерь`);}
 assert(gpu.errors.length===0,gpu.errors.join('\n'));return rows.join('\n')+'\nПроверки минерала и залежей прошли.';
}
