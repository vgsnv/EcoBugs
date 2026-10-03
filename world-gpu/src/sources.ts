import { emittedQuanta, type Vent } from './vents.ts';
export type VolcanoStage = 'preparing' | 'erupting' | 'sleeping' | 'fading';
export interface Volcano { id:number; cell:number; power:number; stage:VolcanoStage; until:number; begin:number; bursts:Vent[]; effusion:Vent|null; eruptions:number }
export interface SourceConfig { seed:number; stock:number; threshold?:number; preparation?:number; duration?:number; startup?:boolean; sites:number[] }
export interface Reservation { cell:number; burst:number; effusion:number }
/** Small deterministic event controller. Mineral ownership and all transfers remain on GPU. */
export class Sources {
  readonly volcanoes:Volcano[]=[];
  threshold:number; startup:boolean; eruptions=0; births=0; private counter=0;
  readonly config:SourceConfig;
  constructor(config:SourceConfig){
    this.config=config;
    if(!config.sites.length||config.stock<=0)throw new Error('Нет свободных мест или запаса для источников.');
    this.startup=config.startup ?? true;this.threshold=config.threshold ?? this.nextThreshold();
  }
  private random(){let h=(this.config.seed+Math.imul(++this.counter,0x9e3779b9))>>>0;h=Math.imul(h^(h>>>16),0x85ebca6b);h=Math.imul(h^(h>>>13),0xc2b2ae35);return ((h^(h>>>16))>>>0)/4294967296;}
  private nextThreshold(){return Math.round(this.config.stock*(.2+.15*this.random()));}
  get active(){return this.volcanoes.find(v=>v.stage==='preparing'||v.stage==='erupting');}
  /** Called only at boundaries of fixed 100-step intervals, using beginning-of-interval pressure. */
  update(step:number,available:number,reserved:number):Reservation|null {
    const pressure=available+reserved;
    if(pressure<this.threshold)this.startup=false;
    for(let i=this.volcanoes.length-1;i>=0;i--){
      const v=this.volcanoes[i];
      if(v.stage==='sleeping'&&step>=v.until){v.stage='fading';v.begin=step;v.until=step+20000;}
      if(v.stage==='fading'&&step>=v.until)this.volcanoes.splice(i,1);
    }
    let active=this.active;
    if(active?.stage==='erupting'&&step>=active.until&&reserved===0){
      active.stage=this.random()<.5?'sleeping':'fading';active.begin=step;
      active.until=step+(active.stage==='sleeping'?200000+Math.floor(this.random()*200000):20000);
      active=undefined;
    }
    if(!active&&pressure>=.6*this.threshold){
      const sleeping=this.volcanoes.filter(v=>v.stage==='sleeping');let chosen:Volcano|undefined;
      if(sleeping.length&&this.random()<.5){
        let choice=this.random()*sleeping.reduce((sum,v)=>sum+v.power,0);
        chosen=sleeping.find(v=>(choice-=v.power)<0)??sleeping[sleeping.length-1];
      }
      if(!chosen){
        const occupied=new Set(this.volcanoes.map(v=>v.cell));const sites=this.config.sites.filter(k=>!occupied.has(k));
        if(!sites.length)return null;
        chosen={id:++this.births,cell:sites[Math.floor(this.random()*sites.length)],power:.01+.99*this.random(),stage:'preparing',begin:step,until:step,bursts:[],effusion:null,eruptions:0};
        this.volcanoes.push(chosen);
      }
      chosen.stage='preparing';chosen.begin=step;
      chosen.until=step+Math.max(1,Math.round((this.config.preparation??(4000+3000*this.random()))/(this.startup?100:1)));
      active=chosen;
    }
    if(active?.stage!=='preparing'||step<active.until||pressure<this.threshold)return null;
    const amount=Math.min(available,Math.round(this.config.stock*(.03+.09*active.power)));
    if(!amount)return null;
    const count=1+Math.floor(this.random()*4),burstTotal=Math.round(amount*.6),effusion=amount-burstTotal;
    const duration=Math.max(5,Math.round((this.config.duration??(5000+5000*this.random()))/(this.startup?100:1)));
    const fractions=[0,...Array.from({length:count-1},()=>.2+.65*this.random()).sort((a,b)=>a-b)];
    const sum=Array.from({length:count},(_,i)=>2**-i).reduce((a,b)=>a+b,0);
    const width=this.startup?1:100;
    let allocated=0,last=step-width;
    active.bursts=fractions.map((fraction,i)=>{
      const at=Math.max(last+width,step+Math.floor(duration*fraction));last=at;
      const mass=i===count-1?burstTotal-allocated:Math.floor(burstTotal*2**-i/sum);allocated+=mass;
      const seconds=width*.1;
      const strength=2**-i;
      return {cell:active!.cell,start:at*.1,end:at*.1+seconds,mass,rate:mass*.01/seconds,range:(50+100*active!.power)*Math.sqrt(strength),speed:(80+160*active!.power)*Math.sqrt(strength)};
    });
    active.effusion={cell:active.cell,start:step*.1,end:(step+duration)*.1,mass:effusion,rate:effusion*.01/(duration*.1),shape:'declining'};
    active.stage='erupting';active.begin=step;active.until=Math.max(step+duration,Math.ceil(active.bursts.at(-1)!.end*10));active.eruptions++;this.eruptions++;
    this.threshold=this.config.threshold??this.nextThreshold();
    return {cell:active.cell,burst:burstTotal,effusion};
  }
  events(sink:Vent):Vent[]{
    const active=this.active;
    return [...Array.from({length:4},(_,i)=>active?.stage==='erupting'?active.bursts[i]??{cell:0,rate:0,start:0,end:0}:{cell:0,rate:0,start:0,end:0}),active?.stage==='erupting'&&active.effusion?active.effusion:{cell:0,rate:0,start:0,end:0},sink];
  }
  emission(step:number){
    const active=this.active;if(active?.stage!=='erupting')return {burst:0,effusion:0,range:50,speed:80};
    let burst=0,range=0,speed=0;
    for(const vent of active.bursts){const mass=emittedQuanta(vent,step);burst+=mass;if(mass){range=Math.max(range,vent.range!);speed=Math.max(speed,vent.speed!);}}
    return {burst,effusion:emittedQuanta(active.effusion!,step),range:range||50,speed:speed||80};
  }
}
