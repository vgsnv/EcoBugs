import { type Grid, connectedAreas } from './model.ts';
import { type WorldParams, makeParams, validateParams } from './generation/params.ts';
import { dishOf, insideDish } from './generation/dish.ts';
import { createViscosityMap, levelsOnGrid, applyLevels } from './generation/viscosity.ts';
import { buildLayout, layoutForSeed, isBlocked } from './generation/partitions.ts';
import { createLightMap } from './generation/light.ts';

/** Reuse the approved deterministic initial generators, never the old physics engine. */
export function createWorldGrid(params:WorldParams=makeParams(),requestedCols=128):Grid{
 const errors=validateParams(params);if(errors.length)throw new Error(errors.join('\n'));
 const own=structuredClone(params),dish=dishOf(own),cols=Math.max(128,requestedCols),cell=dish.width/cols,rows=Math.round(dish.height/cell),n=cols*rows;
 const map=createViscosityMap(own,true,cell),layout=buildLayout(layoutForSeed(own.seed),dish);
 const geometry=new Float32Array(n*4),state=new Uint32Array(n*4),terrain=new Uint32Array(n*4),levels=levelsOnGrid(map,cols,rows,cell);
 const measured={...map,levels:new Uint8Array(map.levels.length),smooth:new Float32Array(map.smooth.length)};applyLevels(measured,levels,cols,rows,cell);
 if(Math.max(...(['water','shallows','land'] as const).map(key=>Math.abs(measured.shares[key]-own.viscosityShares[key])))>.005)throw new Error('Не удалось выдержать доли на выбранной сетке. Увеличьте разрешение или размер зон.');
 let free=0,groundMg=0;const densities=new Float64Array(n);
 for(let k=0;k<n;k++){
  const x=k%cols,y=Math.floor(k/cols),px=(x+.5)*cell,py=(y+.5)*cell;
  let blocked=!insideDish(dish,px,py);
  for(let b=0;b<4&&!blocked;b++)for(let a=0;a<4;a++)if(isBlocked(layout,(x+(a+.5)/4)*cell,(y+(b+.5)/4)*cell)){blocked=true;break;}
  geometry[k*4+2]=Number(blocked);if(blocked)continue;free++;
  const level=levels[k];geometry[k*4]=1/(level<=1?1+2*level:3+6*(level-1));densities[k]=level*20;groundMg+=densities[k]*cell*cell;
 }
 const stockMg=own.mineralStock*free*cell*cell;
 // One immutable quantum for the world; at most 2^30 total quanta including ground.
 const quantum=Math.max(.001,10**Math.ceil(Math.log10((stockMg+groundMg)/2**30)));
 let total=0;for(let k=0;k<n;k++){terrain[k*4]=Math.round(densities[k]*cell*cell/quantum);total+=terrain[k*4];}
 const stock=Math.round(stockMg/quantum);total+=stock;if(total>=0xffffffff)throw new Error('Масса мира превышает выбранный целочисленный диапазон.');
 const components=connectedAreas(cols,rows,geometry),sites=Array.from(components,(_,k)=>k).filter(k=>components[k]>=0);
 const lightMap=createLightMap(own);
 return {scene:'world',initialShares:measured.shares,shape:own.shape,cols,rows,cell,width:dish.width,height:dish.height,geometry,state,terrain,components,total,sourceCell:sites[0],quantum,referenceDensity:own.mineralStock,params:own,lightMap,
  underground:stock,sources:{seed:own.seed,stock,quantum,displacementDensity:20,sites},vents:Array.from({length:6},()=>({cell:0,rate:0,start:0,end:0})),ballistics:{range:150,speed:240,capacity:1024,seed:own.seed},pushLength:200,
  light:{drift:own.lightDrift,sun:own.sun,background:own.backgroundLevel,rhythm:own.sunRhythm,contrast:.035,entrainment:1,interval:100},
  mineral:{diffusion:100,settling:.0001,dissolution:.00003,runoff:100,erosion:.0003,weathering:.00001,speed:own.terrainSpeed,evolving:true,full:true},geology:{seed:own.seed,levelScale:20,quakeGap:own.quakeInterval},funnels:{stock}};
}
