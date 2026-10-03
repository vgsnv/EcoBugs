import assert from 'node:assert/strict';
import { PanGesture, cameraLimits } from '../src/pan.ts';
const sample=(x,y,extra={})=>({pointerId:1,pointerType:'mouse',button:0,buttons:1,isPrimary:true,clientX:x,clientY:y,...extra});
const pan=new PanGesture();
assert.equal(pan.begin(sample(100,100)),true);
assert.deepEqual(pan.move(sample(120,130)),{x:20,y:30});
assert.equal(pan.move(sample(130,150,{buttons:0})),null);
assert.equal(pan.active,null,'Missing pointerup must not leave a drag active');
assert.equal(pan.move(sample(200,200)),null,'Hover must not keep moving the map');
for(const reason of ['wheel','blur','pointercancel','lostpointercapture','pointerup']){
 pan.begin(sample(100,100));assert.equal(pan.cancel(),1,reason);assert.equal(pan.move(sample(150,150)),null,reason);
}
pan.begin(sample(100,100));assert.equal(pan.move(sample(130,130,{pointerId:2})),null);assert.equal(pan.active.id,1);
pan.cancel();assert.equal(pan.begin(sample(0,0,{isPrimary:false})),false);
for(const zoom of [1.5,2.25,4,16]){
 const width=600*zoom,height=450*zoom,rim=10*zoom+2;
 const limits=cameraLimits(width,height,640,600,rim);
 assert.ok(Math.abs(320-limits.x*width-rim)<1e-9,'Left rim must be inside the viewport');
 assert.ok(Math.abs(300-limits.y*height-rim)<1e-9,'Top rim must be inside the viewport');
 assert.ok(Math.abs(320+(1-(1-limits.x))*width+rim-640)<1e-9,'Right rim must be inside the viewport');
}
console.log('Pan lifecycle: missing release, cancellation, hover, unrelated pointers; outer rim reachable at zoom 1.5–16.');
