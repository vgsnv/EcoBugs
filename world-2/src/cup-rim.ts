import { glassSvgStops, glassWidth, glassEdgeWidth } from './glass.ts';
import { layoutPartitions, layoutForSeed } from './generation/partitions.ts';
import { dishOf } from './generation/dish.ts';
import type { Grid } from './model.ts';

type Rect = [number,number,number,number];
// Trace the union, so bends and junctions have no doubled alpha or interior seams.
function outline(rects:Rect[]):string{
 if(!rects.length)return '';
 const xs=[...new Set(rects.flatMap(r=>[r[0],r[2]]))].sort((a,b)=>a-b);
 const ys=[...new Set(rects.flatMap(r=>[r[1],r[3]]))].sort((a,b)=>a-b);
 const inside=(x:number,y:number)=>x>=0&&y>=0&&x<xs.length-1&&y<ys.length-1&&rects.some(r=>(xs[x]+xs[x+1])/2>r[0]&&(xs[x]+xs[x+1])/2<r[2]&&(ys[y]+ys[y+1])/2>r[1]&&(ys[y]+ys[y+1])/2<r[3]);
 const edges=new Map<string,string[]>(),key=(x:number,y:number)=>`${xs[x]},${ys[y]}`;
 const add=(a:string,b:string)=>edges.set(a,[...(edges.get(a)??[]),b]);
 for(let y=0;y<ys.length-1;y++)for(let x=0;x<xs.length-1;x++)if(inside(x,y)){
  if(!inside(x,y-1))add(key(x,y),key(x+1,y));
  if(!inside(x+1,y))add(key(x+1,y),key(x+1,y+1));
  if(!inside(x,y+1))add(key(x+1,y+1),key(x,y+1));
  if(!inside(x-1,y))add(key(x,y+1),key(x,y));
 }
 let path='';
 while(edges.size){const first=edges.keys().next().value!;let at=first;path+=`M${first}`;
  do{const nexts=edges.get(at)!;const next=nexts.pop()!;if(!nexts.length)edges.delete(at);at=next;path+=`L${at}`;}while(at!==first);
  path+='Z';
 }
 return path;
}

/** One SVG material and one width for the outer walls and the partitions. */
export class CupRim {
 private readonly svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
 private key='';
 constructor(private readonly canvas:HTMLCanvasElement){this.svg.classList.add('cup-rim');this.svg.setAttribute('aria-hidden','true');canvas.parentElement!.append(this.svg);}
 update(camera:{x:number;y:number;zoom:number},grid:Grid,fittedWidth:number):void{
  const rect=this.canvas.getBoundingClientRect(),stage=this.canvas.parentElement!.getBoundingClientRect();
  const w=fittedWidth,h=fittedWidth*grid.rows/grid.cols,t=glassWidth,circle=grid.shape==='circle',rim=t*camera.zoom;
  this.svg.style.left=`${rect.left-stage.left+rect.width*.5-camera.x*w*camera.zoom-rim}px`;
  this.svg.style.top=`${rect.top-stage.top+rect.height*.5-camera.y*h*camera.zoom-rim}px`;
  this.svg.style.width=`${(w+2*t)*camera.zoom}px`;this.svg.style.height=`${(h+2*t)*camera.zoom}px`;
  const key=`${w}:${h}:${circle}:${grid.scene}:${grid.params?.seed}:${grid.width}:${grid.height}`;
  if(key===this.key)return;this.key=key;
  this.svg.setAttribute('viewBox',`0 0 ${w+2*t} ${h+2*t}`);
  const rects:Rect[]=circle?[]:[[0,0,w+2*t,t],[0,h+t,w+2*t,h+2*t],[0,t,t,h+t],[w+t,t,w+2*t,h+t]];
  if(grid.scene==='world'&&grid.params){
   for(const part of layoutPartitions(layoutForSeed(grid.params.seed),dishOf(grid.params)))for(let i=1;i<part.points.length;i++){
    const a=part.points[i-1],b=part.points[i];
    rects.push([t+Math.min(a[0],b[0])/grid.width*w-t/2,t+Math.min(a[1],b[1])/grid.height*h-t/2,t+Math.max(a[0],b[0])/grid.width*w+t/2,t+Math.max(a[1],b[1])/grid.height*h+t/2]);
   }
  }
  const outer=circle?`M${w/2+t} 0a${w/2+t} ${h/2+t} 0 1 0 0 ${h+2*t}a${w/2+t} ${h/2+t} 0 1 0 0 -${h+2*t}M${w/2+t} ${t}a${w/2} ${h/2} 0 1 1 0 ${h}a${w/2} ${h/2} 0 1 1 0 -${h}`:'';
  // Gradient coordinates belong to the whole cup, never individual wall segments.
  const material=`fill="url(#cup-gloss)" stroke="#ffffff" stroke-opacity=".9" stroke-width="${glassEdgeWidth}" stroke-linejoin="miter"`;
  const paint=(d:string,attributes='')=>`<path d="${d}" fill="#d5d9d5" ${attributes}/><path d="${d}" ${material} ${attributes}/>`;
  this.svg.innerHTML=`<defs><linearGradient id="cup-gloss" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="${h+2*t}">${glassSvgStops}</linearGradient><clipPath id="cup-interior"><ellipse cx="${w/2+t}" cy="${h/2+t}" rx="${w/2}" ry="${h/2}"/></clipPath></defs>${circle?paint(outer,'fill-rule="evenodd"')+paint(outline(rects),'clip-path="url(#cup-interior)"'):paint(outline(rects))}`;
 }
}
