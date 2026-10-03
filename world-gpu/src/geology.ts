export interface GeologyConfig { seed:number; levelScale?:number; moveGap?:number; moveDuration?:number; quakeGap?:number; quakeDuration?:number }
export interface Movement { x:number;y:number;radius:number;amplitude:number;start:number;duration:number;angle:number;band:boolean;quake:boolean;pairX:number;pairY:number }
const random=(seed:number,n:number,salt:number)=>{let x=(seed^Math.imul(n+1,0x9e3779b9)^Math.imul(salt+1,0x85ebca6b))>>>0;x=Math.imul(x^(x>>>16),0x7feb352d);x=Math.imul(x^(x>>>15),0x846ca68b);return ((x^(x>>>16))>>>0)/4294967296;};
export class Geology {
 active:Movement[]=[];moveCount=0;quakeCount=0;nextMove:number;nextQuake:number;
 readonly config:GeologyConfig;readonly width:number;readonly height:number;
 constructor(config:GeologyConfig,width:number,height:number){this.config=config;this.width=width;this.height=height;this.nextMove=this.gap(false,0);this.nextQuake=this.gap(true,0);}
 private gap(quake:boolean,n:number){return Math.max(100,Math.round((quake?this.config.quakeGap??400000:this.config.moveGap??200000)*(.5+random(this.config.seed,n,quake?20:21))));}
 update(step:number):void{
  this.active=this.active.filter(m=>m.start+m.duration>step);
  // World intervals are bounded, so at most one birth of each kind per interval.
  for(const quake of [false,true]){
   const start=quake?this.nextQuake:this.nextMove;if(step<start)continue;
   const n=quake?this.quakeCount++:this.moveCount++,r=(salt:number)=>random(this.config.seed,n,salt+(quake?100:0));
   const radius=100+120*r(3),angle=r(4)*Math.PI*2,x=r(1)*this.width,y=r(2)*this.height;
   this.active.push({x,y,radius,angle,band:!quake&&r(5)<.5,quake,amplitude:(r(6)<.5?-1:1)*(.004+.004*r(7))*(this.config.levelScale??.02)/.02,start,duration:quake?this.config.quakeDuration??Math.round(200+400*r(8)):this.config.moveDuration??Math.round(150000+200000*r(8)),pairX:x+Math.cos(angle+Math.PI/2)*radius*1.7,pairY:y+Math.sin(angle+Math.PI/2)*radius*1.7});
   if(quake)this.nextQuake=start+this.gap(true,this.quakeCount);else this.nextMove=start+this.gap(false,this.moveCount);
  }
  if(this.active.length>16)throw new Error('Слишком много одновременных подвижек: интервал меньше длительности.');
 }
 encoded():Float32Array{const data=new Float32Array(16*12);this.active.forEach((m,i)=>data.set([m.x,m.y,m.radius,m.amplitude,m.start,m.duration,m.angle,Number(m.band),m.pairX,m.pairY,Number(m.quake),0],i*12));return data;}
}
