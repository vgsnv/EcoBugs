import assert from 'node:assert/strict';
import { createWorldGrid } from '../src/full-world.ts';
import { makeParams } from '../src/generation/params.ts';
for(const params of [makeParams(),makeParams({seed:2,shape:'circle'}),makeParams({seed:3,aspectRatio:16/9}),makeParams({seed:1,mineralStock:99}),makeParams({terrainSpeed:0,lightDrift:0})]){
 const a=createWorldGrid(params),b=createWorldGrid(params);assert.deepEqual(a.geometry,b.geometry);assert.deepEqual(a.terrain,b.terrain);assert.equal(a.total,b.total);assert.ok(a.total<2**30);assert.ok(a.state.every(v=>v===0));assert.ok(a.terrain.every((v,i)=>i%4!==1||v===0));assert.equal(a.total,a.underground+a.terrain.reduce((sum,v,i)=>sum+(i%4===0?v:0),0));
 for(const key of ['water','shallows','land'])assert.ok(Math.abs(a.initialShares[key]-params.viscosityShares[key])<=.005);
 assert.ok(a.lightMap.spots.length>0&&a.quantum>0);if(params.mineralStock===99)assert.ok(a.quantum>=.1);
}
console.log('Full-world rectangular/circular generators, three seeds, initial shares ±0.5 pp, clean creation, adaptive fixed quantum, high stock and repeated initial fields passed.');

assert.throws(()=>createWorldGrid(makeParams({spotSize:1})),/слишком много пятен/);
console.log("Tiny light spots reject excessive allocations before generating objects.");
