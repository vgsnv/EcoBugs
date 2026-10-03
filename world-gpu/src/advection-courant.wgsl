struct Params { cols:u32,rows:u32,cell:f32,dt:f32 }
@group(0) @binding(0) var<uniform> cfg:Params;
@group(0) @binding(1) var<storage,read> geo:array<vec4f>;
@group(0) @binding(2) var<storage,read> flow:array<vec2f>;
@group(0) @binding(3) var<storage,read_write> maxima:array<f32>;
var<workgroup> rates:array<f32,64>;
@compute @workgroup_size(64) fn maximum(@builtin(global_invocation_id) global:vec3u,@builtin(local_invocation_id) local:vec3u,@builtin(workgroup_id) group:vec3u){
 let k=global.x;var rate=0.;if(k<cfg.cols*cfg.rows&&geo[k].z<.5&&geo[k].w<.5){
  rate=max(0.,flow[k].x)+max(0.,flow[k].y);if(k%cfg.cols>0u){rate+=max(0.,-flow[k-1u].x);}if(k>=cfg.cols){rate+=max(0.,-flow[k-cfg.cols].y);}
 }
 rates[local.x]=rate;workgroupBarrier();
 for(var stride=32u;stride>0u;stride/=2u){if(local.x<stride){rates[local.x]=max(rates[local.x],rates[local.x+stride]);}workgroupBarrier();}
 if(local.x==0u){maxima[group.x]=rates[0];}
}
