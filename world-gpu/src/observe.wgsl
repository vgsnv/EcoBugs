struct Params{cols:u32,rows:u32,cell:f32,dt:f32,step:u32,source:u32,burst:u32,light:u32,emission:vec4u,physical:vec4f}
@group(0) @binding(0) var<uniform> cfg:Params;
@group(0) @binding(1) var<storage,read> geo:array<vec4f>;
@group(0) @binding(2) var<storage,read> flow:array<vec2f>;
@group(0) @binding(3) var<storage,read> counters:array<u32>;
@group(0) @binding(4) var<storage,read_write> result:array<vec4u>;
@compute @workgroup_size(1) fn observe(){
 var shares=vec4u(0u);for(var k=0u;k<cfg.cols*cfg.rows;k++){
  if(geo[k].z>.5){shares.w++;continue;}
  let resistance=1./geo[k].x;let grade=select((resistance-1.)/2.,1.+(resistance-3.)/6.,resistance>3.);
  if(grade<.5){shares.x++;}else if(grade<1.5){shares.y++;}else{shares.z++;}
 }
 var sum=0.;var samples=0u;
 for(var y=0u;y<15u;y++){for(var x=0u;x<20u;x++){
  let px=min(cfg.cols-1u,u32((f32(x)+.5)*f32(cfg.cols)/20.));let py=min(cfg.rows-1u,u32((f32(y)+.5)*f32(cfg.rows)/15.));let k=py*cfg.cols+px;
  if(geo[k].z>.5){continue;}let west=select(k,k-1u,px>0u);let north=select(k,k-cfg.cols,py>0u);
  sum+=length(.5*vec2f(flow[k].x+select(0.,flow[west].x,px>0u),flow[k].y+select(0.,flow[north].y,py>0u)))*cfg.cell;samples++;
 }}
 result[0]=shares;result[1]=vec4u(counters[0],counters[1],counters[2],counters[3]);result[2]=vec4u(bitcast<u32>(sum/max(1.,f32(samples))),samples,cfg.step,0u);
}
