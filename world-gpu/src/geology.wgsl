struct Params{cols:u32,rows:u32,cell:f32,step:f32,count:u32,stride:f32,pad1:u32,pad2:u32,quantum:f32,pad3:f32,pad4:f32,pad5:f32}
struct Movement{shape:vec4f,time:vec4f,pair:vec4f}
@group(0) @binding(0) var<uniform> cfg:Params;
@group(0) @binding(1) var<storage,read> geo:array<vec4f>;
@group(0) @binding(2) var<storage,read> events:array<Movement>;
@group(0) @binding(3) var<storage,read_write> terrain:array<vec4u>;
@group(0) @binding(4) var<storage,read_write> depths:array<atomic<u32>>;
@group(0) @binding(5) var<storage,read_write> orders:array<vec2u>;
@group(0) @binding(6) var<storage,read_write> carry:array<vec2f>;
fn weight(pos:vec2f,center:vec2f,radius:f32,angle:f32,band:f32)->f32{
 let delta=pos-center;var r=length(delta)/radius;
 if(band>.5){let axis=vec2f(cos(angle),sin(angle));let along=dot(delta,axis);let across=dot(delta,vec2f(-axis.y,axis.x));r=length(vec2f(max(0.,abs(along)-radius)/radius,across/(radius*.35)));}
 return 1.-smoothstep(0.,1.,r);
}
@compute @workgroup_size(64) fn request(@builtin(global_invocation_id) id:vec3u){
 let k=id.x;if(k>=cfg.cols*cfg.rows){return;}orders[k]=vec2u(0u);if(geo[k].z>.5){return;}
 let pos=(vec2f(f32(k%cfg.cols),f32(k/cfg.cols))+.5)*cfg.cell;var delta=0.;
 for(var i=0u;i<cfg.count;i++){
  let e=events[i];let a=clamp((cfg.step-e.time.x)/e.time.y,0.,1.);let b=clamp((cfg.step+cfg.stride-e.time.x)/e.time.y,0.,1.);
  let progress=(b*b*(3.-2.*b)-a*a*(3.-2.*a));
  let own=weight(pos,e.shape.xy,e.shape.z,e.time.z,e.time.w);
  let paired=select(weight(pos,e.pair.xy,e.shape.z,e.time.z,e.time.w),0.,e.pair.z>.5);
  delta+=(own-paired)*progress*e.shape.w*cfg.cell*cfg.cell/cfg.quantum;
 }
 let wanted=vec2f(max(0.,delta),max(0.,-delta));
 for(var d=0u;d<2u;d++){if(wanted[d]==0.){carry[k][d]=0.;continue;}let amount=wanted[d]+carry[k][d];orders[k][d]=u32(floor(amount));carry[k][d]=fract(amount);}
}
@compute @workgroup_size(64) fn lower(@builtin(global_invocation_id) id:vec3u){
 let k=id.x;if(k>=cfg.cols*cfg.rows){return;}let down=min(terrain[k].x,orders[k].y);
 if(down>0u){let drowned=terrain[k].y;terrain[k].x-=down;terrain[k].y=0u;atomicAdd(&depths[0],down+drowned);}
}
@compute @workgroup_size(1) fn raise(){
 var total=0u;for(var k=0u;k<cfg.cols*cfg.rows;k++){total+=orders[k].x;}
 let budget=min(total,atomicLoad(&depths[0]));if(budget==0u){return;}atomicSub(&depths[0],budget);
 var cumulative=0u;var assigned=0u;
 for(var k=0u;k<cfg.cols*cfg.rows;k++){
  cumulative+=orders[k].x;let allocation=select(min(budget,u32(floor(f32(budget)*f32(cumulative)/f32(total)))),budget,cumulative==total);
  terrain[k].x+=allocation-assigned;assigned=allocation;
 }
}
