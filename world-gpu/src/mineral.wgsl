struct Params { cols:u32, rows:u32, cell:f32, dt:f32, diffusion:f32, settling:f32, dissolution:f32, runoff:f32, cap:u32, pad0:u32, pad1:u32, pad2:u32 }
@group(0) @binding(0) var<uniform> cfg:Params;
@group(0) @binding(1) var<storage,read> geo:array<vec4f>;
@group(0) @binding(2) var<storage,read> before:array<vec4u>;
@group(0) @binding(3) var<storage,read_write> after:array<vec4u>;
@group(0) @binding(4) var<storage,read_write> terrain:array<vec4u>;
@group(0) @binding(5) var<storage,read> flow:array<vec2f>;
@group(0) @binding(6) var<storage,read_write> outgoing:array<vec4u>;
@group(0) @binding(7) var<storage,read_write> carry:array<vec4f>;
@group(0) @binding(8) var<storage,read_write> phaseCarry:array<vec4f>;
fn neighbor(k:u32,d:u32)->u32 {
 let x=k%cfg.cols;let y=k/cfg.cols;
 if(d==0u&&x+1u<cfg.cols){return k+1u;} if(d==1u&&y+1u<cfg.rows){return k+cfg.cols;}
 if(d==2u&&x>0u){return k-1u;} if(d==3u&&y>0u){return k-cfg.cols;} return k;
}
@compute @workgroup_size(64) fn spread(@builtin(global_invocation_id) id:vec3u){
 let k=id.x;if(k>=cfg.cols*cfg.rows){return;}
 outgoing[k]=vec4u(0u);
 if(geo[k].z>.5||geo[k].w>.5){carry[k]=vec4f(0.);return;}
 let mass=before[k].x;var wanted=vec4f(0.);
 let area=cfg.cell*cfg.cell;let surface=f32(terrain[k].x+terrain[k].y+mass)*.001/area;
 for(var d=0u;d<4u;d++){
  let j=neighbor(k,d);if(j==k||geo[j].z>.5){carry[k][d]=0.;continue;}
  let mobility=2.*geo[k].x*geo[j].x/(geo[k].x+geo[j].x);
  let gradient=max(0.,f32(mass)-f32(before[j].x));
  let slope=max(0.,surface-f32(terrain[j].x+terrain[j].y+before[j].x)*.001/area);
  wanted[d]=(cfg.diffusion*gradient+cfg.runoff*f32(mass)*slope/.02)*mobility*cfg.dt/area;
 }
 let sum=dot(wanted,vec4f(1.));if(sum>f32(mass)*.5){wanted*=f32(mass)*.5/sum;}
 var remaining=mass;
 for(var d=0u;d<4u;d++){
  // Reset inactive remainders: they cannot push uphill after a gradient reverses.
  if(wanted[d]<=0.){carry[k][d]=0.;continue;}
  let amount=wanted[d]+carry[k][d];let moved=min(remaining,u32(floor(amount)));
  outgoing[k][d]=moved;remaining-=moved;carry[k][d]=amount-f32(moved);
 }
}
@compute @workgroup_size(64) fn phases(@builtin(global_invocation_id) id:vec3u){
 let k=id.x;if(k>=cfg.cols*cfg.rows){return;}
 var state=before[k];for(var d=0u;d<4u;d++){let j=neighbor(k,d);state.x-=outgoing[k][d];if(j!=k){state.x+=outgoing[j][(d+2u)%4u];}}
 if(geo[k].z>.5||geo[k].w>.5){after[k]=state;return;}
 let x=k%cfg.cols;let y=k/cfg.cols;
 var west=0.;var north=0.;if(x>0u){west=flow[k-1u].x;}if(y>0u){north=flow[k-cfg.cols].y;}
 let speed=length(vec2f((flow[k].x+west)*.5,(flow[k].y+north)*.5))*cfg.cell;
 let convergence=max(0.,west+north-flow[k].x-flow[k].y);
 let cap=cfg.cap;
 let occupied=terrain[k].x+terrain[k].y;let room=cap-min(cap,occupied);
 let settleWanted=f32(state.x)*cfg.settling*cfg.dt*(1.+min(2.,convergence))/(1.+speed/10.);
 let a=settleWanted+phaseCarry[k].x;let settled=min(min(state.x,room),u32(floor(a)));
 phaseCarry[k].x=select(0.,fract(a),settled<room);state.x-=settled;terrain[k].y+=settled;
 let b=f32(terrain[k].y)*cfg.dissolution*cfg.dt+phaseCarry[k].y;
 let dissolved=min(terrain[k].y,u32(floor(b)));phaseCarry[k].y=fract(b);
 terrain[k].y-=dissolved;state.x+=dissolved;after[k]=state;
}
