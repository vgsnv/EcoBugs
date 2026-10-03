struct Params{cols:u32,rows:u32,threshold:u32,pad:u32,speed:f32,pad1:f32,pad2:f32,pad3:f32}
@group(0) @binding(0) var<uniform> cfg:Params;
@group(0) @binding(1) var<storage,read_write> geo:array<vec4f>;
@group(0) @binding(2) var<storage,read_write> terrain:array<vec4u>;
@group(0) @binding(3) var<storage,read_write> state:array<vec4u>;
@group(0) @binding(4) var<storage,read> mask:array<vec4f>;
@compute @workgroup_size(64) fn mark(@builtin(global_invocation_id) id:vec3u){let k=id.x;if(k>=cfg.cols*cfg.rows){return;}geo[k].w=select(0.,2.+mask[k].w,mask[k].z>.5);}
@compute @workgroup_size(64) fn lift(@builtin(global_invocation_id) id:vec3u){
 let k=id.x;if(k>=cfg.cols*cfg.rows){return;}let excess=terrain[k].y-min(terrain[k].y,cfg.threshold);
 let demand=f32(excess)*.0003*mask[k].x*cfg.speed+bitcast<f32>(terrain[k].w);
 let amount=min(excess,u32(floor(demand)));terrain[k].w=bitcast<u32>(fract(demand));terrain[k].y-=amount;state[k].x+=amount;
}
