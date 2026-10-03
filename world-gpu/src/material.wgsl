struct Params {cols:u32,rows:u32,cell:f32,dt:f32,step:u32,source:u32,burst:u32,light:u32,emission:vec4u,physical:vec4f}
@group(0) @binding(0) var<uniform> cfg:Params;
@group(0) @binding(1) var<storage,read> geo:array<vec4f>;
@group(0) @binding(2) var<storage,read> flow:array<vec2f>;
@group(0) @binding(3) var<storage,read> previous:array<vec4f>;
@group(0) @binding(4) var<storage,read_write> next:array<vec4f>;
fn sample(k:u32,x:i32,y:i32)->vec4f {
 if(x<0||y<0||x>=i32(cfg.cols)||y>=i32(cfg.rows)){return previous[k];}
 let j=u32(y)*cfg.cols+u32(x);
 if(geo[j].z>.5||(geo[j].w>.5)!=(geo[k].w>.5)){return previous[k];}
 // Restrict interpolation to directly visible neighbours at corners.
 let ox=i32(k%cfg.cols);let oy=i32(k/cfg.cols);
 if(x!=ox&&y!=oy&&(geo[u32(oy)*cfg.cols+u32(x)].z>.5||geo[u32(y)*cfg.cols+u32(ox)].z>.5)){return previous[k];}
 return previous[j];
}
@compute @workgroup_size(64) fn advect(@builtin(global_invocation_id) id:vec3u){
 let k=id.x;if(k>=cfg.cols*cfg.rows){return;}
 let x=k%cfg.cols;let y=k/cfg.cols;let own=vec2f(f32(x),f32(y))+.5;
 if(geo[k].z>.5){next[k]=vec4f(own,own);return;}
 let west=select(k,k-1u,x>0u);let north=select(k,k-cfg.cols,y>0u);
 let v=.5*vec2f(flow[k].x+select(0.,flow[west].x,x>0u),flow[k].y+select(0.,flow[north].y,y>0u));
 // Display-only Courant bound prevents texture tunnelling across a thin wall.
 let delta=v*.1;let pos=own-delta/max(1.,length(delta)/.45);
 let corner=vec2i(floor(pos-.5));let f=fract(pos-.5);
 var value=mix(mix(sample(k,corner.x,corner.y),sample(k,corner.x+1,corner.y),f.x),mix(sample(k,corner.x,corner.y+1),sample(k,corner.x+1,corner.y+1),f.x),f.y);
 // Two staggered coordinate maps renew only while their image weight is zero.
 if(cfg.step%400u==0u){value=vec4f(own,value.zw);}
 if(cfg.step%400u==200u){value=vec4f(value.xy,own);}
 next[k]=value;
}
