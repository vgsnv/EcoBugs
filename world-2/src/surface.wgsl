struct Params{cols:u32,rows:u32,cell:f32,dt:f32}
struct Surface{geometry:vec4f,climate:vec4f}
@group(0) @binding(0) var<uniform> cfg:Params;
@group(0) @binding(1) var<storage,read> geometry:array<vec4f>;
@group(0) @binding(2) var<storage,read> climate:array<vec4f>;
@group(0) @binding(3) var<storage,read_write> surface:array<Surface>;
@compute @workgroup_size(64) fn pack(@builtin(global_invocation_id) id:vec3u){let k=id.x;if(k>=cfg.cols*cfg.rows){return;}surface[k]=Surface(geometry[k],climate[k]);}
