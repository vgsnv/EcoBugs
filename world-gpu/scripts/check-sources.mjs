import assert from 'node:assert/strict';
import { Sources } from '../src/sources.ts';
import { averagedVents, emittedQuanta } from '../src/vents.ts';
for(let seed=1;seed<=20;seed++){
  const sources=new Sources({seed,stock:5_000_000,sites:[1,2,3]});
  assert.equal(sources.volcanoes.length,0);
  assert.equal(sources.update(0,5_000_000,0),null);
  assert.equal(sources.active.stage,'preparing');
  const reservation=sources.update(100,5_000_000,0),volcano=sources.active;
  assert.ok(reservation&&reservation.burst+reservation.effusion<=5_000_000);
  assert.ok(volcano.bursts.length>=1&&volcano.bursts.length<=4);
  assert.equal(volcano.bursts.reduce((sum,v)=>sum+v.mass,0),reservation.burst);
  for(let i=1;i<volcano.bursts.length;i++){
    assert.ok(Math.abs(volcano.bursts[i].mass-.5*volcano.bursts[i-1].mass)<=4);
    assert.ok(volcano.bursts[i].start>=volcano.bursts[i-1].end-1e-9);
    assert.ok(volcano.bursts[i].range<volcano.bursts[i-1].range);
  }
  let burst=0,effusion=0;
  for(let step=100;step<=volcano.until;step++){
    for(const event of volcano.bursts)burst+=emittedQuanta(event,step);
    effusion+=emittedQuanta(volcano.effusion,step);
  }
  assert.equal(burst,reservation.burst);assert.equal(effusion,reservation.effusion);
  const events=sources.events({cell:9,rate:0,start:0,end:0});let displaced=0;
  for(let step=100;step<volcano.until;step+=100){const data=averagedVents(events,step*.1,10);for(let i=1;i<data.length;i+=4)displaced+=data[i]*10;}
  assert.ok(Math.abs(displaced-(burst+effusion)*.01)<.01);
  assert.ok(emittedQuanta(volcano.effusion,100)>=emittedQuanta(volcano.effusion,volcano.until-1));
}
const waiting=new Sources({seed:2,stock:10000,threshold:10000,preparation:1,startup:false,sites:[1]});
assert.equal(waiting.update(0,5999,0),null);assert.equal(waiting.active,undefined);
waiting.update(100,6000,0);assert.equal(waiting.active.stage,'preparing');
assert.equal(waiting.update(200,9999,0),null);assert.equal(waiting.eruptions,0);
assert.ok(waiting.update(300,10000,0));assert.equal(waiting.eruptions,1);
const dying=new Sources({seed:1,stock:10000,sites:[1]});
dying.volcanoes.push({id:1,cell:1,power:1,stage:'sleeping',begin:0,until:100,bursts:[],effusion:null,eruptions:1});
dying.update(100,0,0);assert.equal(dying.volcanoes[0].stage,'fading');dying.update(20100,0,0);assert.equal(dying.volcanoes.length,0);
console.log('20 seeds: pressure gate, preparation, 1–4 diminishing bursts, declining effusion, exact mass/displacement integrals and extinction.');

const full=new Sources({seed:6,stock:18000000,quantum:1,displacementDensity:20,sites:[1]});
full.update(0,18000000,0);const reservation=full.update(100,18000000,0);assert.ok(reservation);
const area=full.events({cell:0,rate:0,start:0,end:0}).reduce((sum,v)=>sum+v.rate*(v.end-v.start),0);
assert.ok(Math.abs(area-(reservation.burst+reservation.effusion)/20)<1e-7);
console.log('Full-world eruption: displaced area equals emitted mineral mass / 20 mg per mm².');
