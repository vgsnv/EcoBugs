import { type FunnelConfig } from './funnels.ts';
import { type GeologyConfig } from './geology.ts';
import { type SourceConfig } from './sources.ts';
import { type Vent } from './vents.ts';

/** Controlled physical scenes, not the complete world generator. */
export type Scene = 'cycle' | 'funnel-life' | 'geology' | 'terrain' | 'mineral' | 'volcanoes' | 'volcano-wall' | 'flight-impact' | 'flight-slide' | 'flight' | 'flight-wall' | 'flight-island' | 'flight-hole' | 'sun-flight' | 'vents' | 'vent-wall' | 'vent-passage' | 'vent-layers' | 'sun-vents' | 'light' | 'light-wall' | 'quiet' | 'contrast' | 'wall' | 'passage' | 'circle' | 'layers' | 'funnel' | 'burst';
export const SCENES: Record<Scene, string> = {
  cycle:'Цикл минерала', 'funnel-life':'Жизнь воронок', geology:'Подвижки и толчки', terrain:'Изменение местности', mineral:'Растекание и залежи', volcanoes:'Жизнь вулканов', 'volcano-wall':'Общие недра в отсеках',
  'flight-impact': 'Прямой удар о стену', 'flight-slide': 'Скольжение вдоль стены', flight: 'Залп: полёт', 'flight-wall': 'Полёт и стенка', 'flight-island': 'Полёт через сушу', 'flight-hole': 'Полёт и отверстие', 'sun-flight': 'Свет + полёт + воронка',
  vents: 'Залп и тяга', 'vent-wall': 'Толчки в закрытых отсеках', 'vent-passage': 'Толчок через проход', 'vent-layers': 'Толчок и сопротивление', 'sun-vents': 'Свет + залп + воронка',
  light: 'Дрейф света', 'light-wall': 'Свет в закрытых отсеках',
  contrast: 'Свет → тень', passage: 'Узкий проход', wall: 'Закрытые отсеки',
  circle: 'Круглая чашка', layers: 'Вода / отмель / суша', funnel: 'Отверстие воронки',
  burst: 'Короткий выброс', quiet: 'Без источников',
};
export const QUANTUM_MG = 0.001;
export interface Grid {
  scene: Scene; cols: number; rows: number; cell: number; width: number; height: number;
  /** mobility, source rate, blocked, one-way hole */
  geometry: Float32Array;
  /** dissolved, captured underground, reserved emission, flying ledger at origin */
  state: Uint32Array;
  components: Int32Array;
  total: number;
  sourceCell: number;
  vents?: Vent[];
  pushLength?: number;
  sources?: SourceConfig;
  underground?: number;
  geology?: GeologyConfig;
  funnels?: FunnelConfig;
  /** Ground and deposits in integer quanta; remaining channels reserved. */
  terrain?: Uint32Array;
  mineral?: { diffusion:number; settling:number; dissolution:number; runoff:number; erosion?:number; weathering?:number; speed?:number; evolving?:boolean };
  ballistics?: { range: number; speed: number; capacity: number; seed: number; count?: number; direction?: [number,number] };
  light?: { drift: number; sun: number; background: number; rhythm: number; contrast: number; entrainment: number };
}

export function connectedAreas(cols: number, rows: number, geometry: Float32Array): Int32Array {
  const ids = new Int32Array(cols * rows).fill(-1);
  let group = 0;
  const queue = new Int32Array(ids.length);
  for (let start = 0; start < ids.length; start++) {
    if (geometry[start * 4 + 2] || ids[start] >= 0) continue;
    let head = 0, tail = 1; queue[0] = start; ids[start] = group;
    while (head < tail) {
      const k = queue[head++], x = k % cols, y = Math.floor(k / cols);
      for (const j of [x > 0 ? k - 1 : -1, x + 1 < cols ? k + 1 : -1,
        y > 0 ? k - cols : -1, y + 1 < rows ? k + cols : -1]) {
        if (j < 0 || ids[j] >= 0 || geometry[j * 4 + 2]) continue;
        ids[j] = group; queue[tail++] = j;
      }
    }
    group++;
  }
  return ids;
}

export function balanceSources(geometry: Float32Array, components: Int32Array): void {
  const count: number[] = [], sums: number[] = [];
  for (let k = 0; k < components.length; k++) {
    const id = components[k]; if (id < 0) continue;
    count[id] = (count[id] ?? 0) + 1; sums[id] = (sums[id] ?? 0) + geometry[k * 4 + 1];
  }
  for (let k = 0; k < components.length; k++) {
    const id = components[k]; if (id >= 0) geometry[k * 4 + 1] -= sums[id] / count[id];
  }
}

export function createGrid(scene: Scene, cols = 64): Grid {
  const lifecycle=scene==='volcanoes'||scene==='volcano-wall'||scene==='cycle';
  const hasSource = lifecycle || scene.includes('vent') || scene.includes('flight');
  const holeU = scene === 'flight-hole' ? .4 : .76;
  const rows = scene === 'circle' ? cols : cols * 3 / 4;
  const width = scene === 'circle' ? Math.sqrt(1920000 * 4 / Math.PI) : 1600;
  const height = scene === 'circle' ? width : 1200;
  const n = cols * rows, geometry = new Float32Array(n * 4), state = new Uint32Array(n * 4);
  const cell = width / cols;
  const sx = Math.floor(cols * (scene === 'flight-impact' || scene === 'flight-slide' ? .43 : .24)), sy = Math.floor(rows * .5), sourceCell = sy * cols + sx;
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const k = y * cols + x, u = (x + .5) / cols, v = (y + .5) / rows;
    const circleOutside = scene === 'circle' && Math.hypot(u - .5, v - .5) >= .5;
    const wall = (scene === 'wall' || scene === 'light-wall' || scene === 'volcano-wall' || scene === 'flight-wall' || scene === 'flight-impact' || scene === 'flight-slide' || scene === 'vent-wall' || scene === 'vent-passage' || scene === 'passage') && x === Math.floor(cols / 2)
      && (scene === 'wall' || scene === 'light-wall' || scene === 'volcano-wall' || scene === 'flight-wall' || scene === 'flight-impact' || scene === 'flight-slide' || scene === 'vent-wall' || Math.abs(v - .5) > .08);
    geometry[k * 4 + 2] = Number(circleOutside || wall);
    if (circleOutside || wall) continue;
    geometry[k * 4] = (scene === 'layers' || scene === 'vent-layers') ? (u < 1 / 3 ? 1 : u < 2 / 3 ? 1 / 3 : 1 / 9) : 1;
    if (scene === 'flight-island' && u * width > 540 && u * width < 575 && v > .25 && v < .75) geometry[k * 4] = 1 / 9;
    if (scene === 'contrast' || scene === 'wall' || scene === 'layers') {
      geometry[k * 4 + 1] = .018 * Math.cos(u * Math.PI * 2);
    } else if (scene !== 'quiet' && scene !== 'mineral' && scene !== 'terrain' && scene !== 'geology' && scene !== 'funnel-life' && scene !== 'light' && scene !== 'light-wall' && !hasSource) {
      // A prescribed balanced source/return pair; full sunlight and damped vent solves come later.
      const left = Math.exp(-((u - .24) ** 2 + (v - .5) ** 2) / .009);
      const right = Math.exp(-((u - .76) ** 2 + (v - .5) ** 2) / .009);
      geometry[k * 4 + 1] = .12 * (left - right);
    }
    const initialDensity = scene === 'quiet' ? .01 : .08 * Math.exp(-((u - .24) ** 2 + (v - .5) ** 2) / .005);
    state[k * 4] = Math.round(initialDensity * cell * cell / QUANTUM_MG);
    if (scene === 'wall' && x > cols / 2) state[k * 4] = 0;
    if (scene === 'burst' || hasSource) state[k * 4] = 0;
    if ((scene === 'funnel' || (hasSource && !scene.includes('flight')) || scene === 'flight-hole' || scene === 'sun-flight') && Math.hypot(u - holeU, v - .5) < .05) {
      geometry[k * 4 + 3] = 1;
    }
  }
  if (scene === 'burst' || hasSource) state[sourceCell * 4 + 2] = 1_000_000; // Exactly 1 g, reserved underground.
  const components = connectedAreas(cols, rows, geometry);
  balanceSources(geometry, components);
  const total = state.reduce((a, b) => a + b, 0);
  if (total >= 0xffffffff) throw new Error('Стенд превышает диапазон массы u32.');
  const light = (scene.startsWith('light') || scene === 'sun-vents' || scene === 'sun-flight' || scene === 'terrain' || scene==='cycle') ? { drift: .012, sun: 1, background: .12, rhythm: .2, contrast: .035, entrainment: 1 } : undefined;
  const vents = hasSource ? [
    {cell: sourceCell, rate: 50000, start: .25, end: .45, mass: 1_000_000},
    {cell: sy * cols + Math.floor(cols * holeU), rate: -8000, start: 0, end: 1e9},
  ] : undefined;
  if (scene.includes('flight') && scene !== 'sun-flight' && scene !== 'flight-hole') vents!.pop();
  const ballistics: Grid['ballistics'] = scene.includes('flight') ? {range: 480, speed: 250, capacity: 1024, seed: 6107} : undefined;
  if (scene === 'flight-impact' || scene === 'flight-slide') {
    ballistics!.range=800;ballistics!.speed=400;ballistics!.direction=scene==='flight-impact'?[1,0]:[1,.65];
  }
  if(lifecycle){
    state.fill(0);const stock=5_000_000;
    const sources:SourceConfig={seed:9307,stock,sites:Array.from(components,(_,k)=>k).filter(k=>components[k]>=0&&!geometry[k*4+3])};
    const events:Vent[]=Array.from({length:5},()=>({cell:0,rate:0,start:0,end:0}));events.push({cell:sy*cols+Math.floor(cols*.76),rate:scene==='cycle'?0:-8000,start:0,end:1e9});
    if(scene==='cycle'){for(let k=0;k<n;k++)geometry[k*4+3]=0;sources.sites=Array.from(components,(_,k)=>k).filter(k=>components[k]>=0);}
    return {scene,cols,rows,width,height,cell,geometry,state,components,total:stock,sourceCell,vents:events,sources,underground:stock,light:scene==='cycle'?light:undefined,funnels:scene==='cycle'?{stock}:undefined,geology:scene==='cycle'?{seed:9307}:undefined,mineral:{diffusion:100,settling:.0001,dissolution:.00005,runoff:100,erosion:scene==='cycle'?.0003:0,weathering:scene==='cycle'?.00001:0,evolving:scene==='cycle'},ballistics:{range:150,speed:240,capacity:1024,seed:6107},pushLength:200};
  }
  if(scene==='funnel-life'){
    state.fill(0);const terrain=new Uint32Array(n*4),stock=5_000_000;
    for(let k=0;k<n;k++){geometry[k*4+3]=0;const dx=(k%cols+.5)*cell-width*.35,dy=(Math.floor(k/cols)+.5)*cell-height*.5;terrain[k*4+1]=Math.round(.02*Math.exp(-(dx*dx+dy*dy)/(100*100))*cell*cell/.001);}
    return {scene,cols,rows,width,height,cell,geometry,state,terrain,components,total:terrain.reduce((a,b)=>a+b,0),sourceCell,vents:[{cell:0,rate:0,start:0,end:0}],funnels:{stock,ramp:3000,interval:100,draw:.001},mineral:{diffusion:100,settling:.0001,dissolution:.00005,runoff:100,speed:1}};
  }
  if(scene==='terrain'||scene==='geology'){
    state.fill(0);const terrain=new Uint32Array(n*4);
    for(let k=0;k<n;k++){const u=(k%cols+.5)/cols,v=(Math.floor(k/cols)+.5)/rows;terrain[k*4]=Math.round((.002+.035*Math.exp(-((u-.5)**2+(v-.5)**2)/.025))*cell*cell/.001);}
    const underground=scene==='geology'?5_000_000:0;
    return {scene,cols,rows,width,height,cell,geometry,state,terrain,components,total:underground+terrain.reduce((a,b)=>a+b,0),sourceCell,light,underground,geology:scene==='geology'?{seed:6107,moveGap:1000,moveDuration:3000,quakeGap:2000,quakeDuration:300}:undefined,mineral:{diffusion:100,settling:.0001,dissolution:.00005,runoff:100,erosion:.0003,weathering:.00001,speed:1,evolving:true}};
  }
  const mineral=scene==='mineral'?{diffusion:100,settling:.0001,dissolution:.00005,runoff:100}:undefined;
  return { mineral, scene, cols, rows, width, height, cell, geometry, state, components, total, sourceCell, light, vents, ballistics, pushLength: 200 };
}

export function massByComponent(grid: Grid, state: Uint32Array): number[] {
  const out: number[] = [];
  for (let k = 0; k < grid.components.length; k++) {
    const id = grid.components[k]; if (id < 0) continue;
    out[id] = (out[id] ?? 0) + state[k * 4] + state[k * 4 + 1] + state[k * 4 + 2] + state[k * 4 + 3];
  }
  return out;
}
