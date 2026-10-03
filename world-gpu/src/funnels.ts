export interface FunnelConfig{stock:number;ramp?:number;interval?:number;draw?:number;minimumArea?:number}
export interface Funnel{id:number;core:number;area:number[];holes:number[];strength:number;stage:'growing'|'living'|'fading'}
export class Funnels{
 readonly config:FunnelConfig;readonly cols:number;readonly rows:number;readonly cell:number;readonly blocked:Float32Array;
 active:Funnel[]=[];births=0;last=0;shape:number;coreThreshold:number;
 constructor(config:FunnelConfig,cols:number,rows:number,cell:number,geometry:Float32Array){this.config=config;this.cols=cols;this.rows=rows;this.cell=cell;this.blocked=geometry;const free=Array.from(geometry).filter((v,i)=>i%4===2&&v===0).length;this.shape=Math.max(1,Math.round(config.stock/free*1.5));this.coreThreshold=Math.max(this.shape+1,Math.round(config.stock/free*6));}
 private neighbors(k:number){const x=k%this.cols,y=Math.floor(k/this.cols);return [x>0?k-1:-1,x+1<this.cols?k+1:-1,y>0?k-this.cols:-1,y+1<this.rows?k+this.cols:-1].filter(j=>j>=0);}
 update(step:number,deposits:Uint32Array,speed=1):void{
  if(speed===0)return;const delta=(step-this.last)*speed/(this.config.ramp??60000);this.last=step;
  for(const f of this.active){const dense=f.area.some(k=>deposits[k*4+1]>=this.coreThreshold);f.strength=Math.max(0,Math.min(1,f.strength+(dense?delta:-delta)));f.stage=dense?(f.strength===1?'living':'growing'):'fading';}
  this.active=this.active.filter(f=>f.stage!=='fading'||f.strength>0);
  const occupied=new Uint8Array(this.cols*this.rows);for(const f of this.active)for(const k of f.area)occupied[k]=1;
  const visited=new Uint8Array(occupied.length);
  for(let start=0;start<visited.length;start++){
   if(visited[start]||this.blocked[start*4+2]||deposits[start*4+1]<this.shape)continue;
   const cells=[start];visited[start]=1;let core=start;
   for(let i=0;i<cells.length;i++){const k=cells[i];if(deposits[k*4+1]>deposits[core*4+1])core=k;for(const j of this.neighbors(k))if(!visited[j]&&!this.blocked[j*4+2]&&deposits[j*4+1]>=this.shape){visited[j]=1;cells.push(j);}}
   if(cells.length*this.cell*this.cell<(this.config.minimumArea??1920)||deposits[core*4+1]<this.coreThreshold||cells.some(k=>occupied[k]))continue;
   const areaSet=new Set<number>();const radius=Math.ceil(80/this.cell);
   for(const k of cells){const x=k%this.cols,y=Math.floor(k/this.cols);for(let dy=-radius;dy<=radius;dy++)for(let dx=-radius;dx<=radius;dx++)if(Math.hypot(dx,dy)*this.cell<=80){const xx=x+dx,yy=y+dy;if(xx>=0&&yy>=0&&xx<this.cols&&yy<this.rows){const j=yy*this.cols+xx;if(!this.blocked[j*4+2])areaSet.add(j);}}}
   const area=[...areaSet];if(area.some(k=>occupied[k]))continue;
   const component=new Set(cells),holes=[core],front=this.neighbors(core).filter(k=>component.has(k)),seen=new Set(holes);for(const k of front)seen.add(k);
   while(holes.length<Math.max(1,Math.ceil(cells.length*.1))&&front.length){front.sort((a,b)=>Math.hypot(a%this.cols-core%this.cols,Math.floor(a/this.cols)-Math.floor(core/this.cols))-Math.hypot(b%this.cols-core%this.cols,Math.floor(b/this.cols)-Math.floor(core/this.cols)));const k=front.shift()!;holes.push(k);for(const j of this.neighbors(k))if(component.has(j)&&!seen.has(j)){seen.add(j);front.push(j);}}
   this.active.push({id:++this.births,core,area,holes,strength:0,stage:'growing'});for(const k of area)occupied[k]=1;
  }
 }
 mask():Float32Array{const out=new Float32Array(this.cols*this.rows*4);for(const f of this.active){for(const k of f.area)out[k*4]=f.strength;const rate=-f.area.length*this.cell*this.cell*(this.config.draw??.001)*f.strength/f.holes.length;for(const k of f.holes){out[k*4+1]=rate;out[k*4+2]=1;out[k*4+3]=f.strength;}}return out;}
 siteWeights(deposits:Uint32Array):Float32Array{
  const n=this.cols*this.rows,dist=new Int32Array(n).fill(n),queue:number[]=[];
  for(let k=0;k<n;k++)if(deposits[k*4+1]>=this.shape*.1){dist[k]=0;queue.push(k);}
  for(let i=0;i<queue.length;i++){const k=queue[i];for(const j of this.neighbors(k))if(dist[j]>dist[k]+1){dist[j]=dist[k]+1;queue.push(j);}}
  const weights=Float32Array.from(dist,d=>.02+.98*Math.min(1,d*this.cell/150)**2);for(const f of this.active)for(const k of f.holes)weights[k]=0;return weights;
 }
}
