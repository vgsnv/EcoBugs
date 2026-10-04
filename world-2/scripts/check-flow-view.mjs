import assert from 'node:assert/strict';
import { flowMode,flowBlend } from '../src/flow-view.ts';
assert.equal(flowMode('auto',1),0);
assert.equal(flowMode('auto',10),1);
assert.equal(flowMode('auto',100),1);
assert.equal(flowMode('auto',1000),2);
assert.equal(flowMode('auto',10000),2);
for(const speed of [1,10,100,1000,10000]){
 assert.equal(flowMode('ripple',speed),0);assert.equal(flowMode('lines',speed),1);assert.equal(flowMode('strength',speed),2);assert.equal(flowMode('off',speed),3);
}
assert.equal(flowBlend(2,0,false),0,'A paused view must not advance its filter');
assert.equal(flowBlend(2,-1,false),0);
assert.equal(flowBlend(2,0,true),1,'Initial field must not fade in from a made-up zero velocity');
assert.equal(flowBlend(0,.016,false),1,'Real-time ripple uses the current physical field');
const whole=flowBlend(2,.6,false),half=flowBlend(2,.3,false);
assert.ok(Math.abs(whole-(1-(1-half)**2))<1e-12,'Smoothing must be independent of rendering frame rate');
console.log('Adaptive flow: real-time ripple, acceleration diagram, manual overrides, paused filter and frame-independent smoothing.');
