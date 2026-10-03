import assert from 'node:assert/strict';
import { Funnels } from '../src/funnels.ts';
import { Geology } from '../src/geology.ts';
const cols=32,rows=24,n=cols*rows,geometry=new Float32Array(n*4),terrain=new Uint32Array(n*4);for(let k=0;k<n;k++)geometry[k*4]=1;
for(let y=10;y<14;y++)for(let x=8;x<12;x++)terrain[(y*cols+x)*4+1]=100000;
const controller=new Funnels({stock:5000000,ramp:1000},cols,rows,50,geometry);controller.update(0,terrain);assert.equal(controller.active.length,1);const holes=[...controller.active[0].holes];assert.equal(holes.length,2);
controller.update(500,terrain);assert.equal(controller.active.length,1);assert.equal(controller.active[0].strength,.5);assert.deepEqual(controller.active[0].holes,holes);
const empty=new Uint32Array(n*4);controller.update(750,empty);assert.equal(controller.active[0].stage,'fading');assert.equal(controller.active[0].strength,.25);
controller.update(1000,terrain);assert.equal(controller.active[0].stage,'growing');assert.equal(controller.active[0].strength,.5);assert.deepEqual(controller.active[0].holes,holes);
controller.update(2000,empty);assert.equal(controller.active.length,0);assert.ok(controller.mask().every(v=>v===0));
const weights=controller.siteWeights(terrain);assert.ok(weights[11*cols+9]<.03&&weights[11*cols+25]>.99);
const frozen=new Funnels({stock:5000000},cols,rows,50,geometry);frozen.update(1000,terrain,0);assert.equal(frozen.active.length,0);
for(const seed of [1,2,3]){const a=new Geology({seed},1600,1200),b=new Geology({seed},1600,1200);for(let step=0;step<=1000000;step+=100){a.update(step);b.update(step);}assert.deepEqual(a,b);assert.ok(a.moveCount>=3&&a.quakeCount>=1);}
console.log('Funnel connected cluster, fixed 10% hole, exclusion halo, growth, fading, revival, disappearance, source-site weights and geological seed repeat passed.');
