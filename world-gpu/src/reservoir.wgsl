struct Settings { cols:u32, rows:u32, source:u32, burst:u32, effusion:u32, emit:u32, pad0:u32, pad1:u32 }
@group(0) @binding(0) var<uniform> cfg:Settings;
// Available shared stock, reserved effusion, delivered effusion, rejected reservation.
@group(0) @binding(1) var<storage,read_write> depths:array<atomic<u32>>;
@group(0) @binding(2) var<storage,read_write> state:array<vec4u>;
@compute @workgroup_size(1) fn reserve(){
  let requested=cfg.burst+cfg.effusion;let available=atomicLoad(&depths[0]);
  if(requested>available){atomicAdd(&depths[3],1u);return;}
  atomicSub(&depths[0],requested);state[cfg.source].z+=cfg.burst;atomicAdd(&depths[1],cfg.effusion);
}
@compute @workgroup_size(1) fn effuse(){
  let emitted=min(cfg.emit,atomicLoad(&depths[1]));atomicSub(&depths[1],emitted);
  state[cfg.source].x+=emitted;atomicAdd(&depths[2],emitted);
}
@compute @workgroup_size(64) fn collect(@builtin(global_invocation_id) id:vec3u){
  let k=id.x;if(k>=cfg.cols*cfg.rows){return;}
  atomicAdd(&depths[0],state[k].y);state[k].y=0u;
}
