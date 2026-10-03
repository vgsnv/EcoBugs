struct Params { cols:u32, rows:u32, cell:f32, dt:f32, step:u32, count:u32, pad0:u32, pad1:u32 }
struct Particle { pos:vec2f, alpha:f32, size:f32, owner:u32, life:u32, age:f32, pad:f32 }
@group(0) @binding(0) var<uniform> cfg:Params;
@group(0) @binding(1) var<storage,read> geo:array<vec4f>;
@group(0) @binding(2) var<storage,read> flow:array<vec2f>;
@group(0) @binding(3) var<storage,read> funnels:array<vec4f>;
@group(0) @binding(4) var<storage,read_write> particles:array<Particle>;
fn hash(v:u32)->f32 { var x=v;x=(x^(x>>16u))*0x7feb352du;x=(x^(x>>15u))*0x846ca68bu;return f32(x^(x>>16u))/4294967296.; }
fn cell(pos:vec2f)->u32 { let p=vec2u(clamp(pos,vec2f(0.),vec2f(f32(cfg.cols)-.001,f32(cfg.rows)-.001)));return p.y*cfg.cols+p.x; }
fn velocity(pos:vec2f)->vec2f {
 let k=cell(pos);let x=k%cfg.cols;let y=k/cfg.cols;let t=fract(pos);
 var west=0.;var north=0.;if(x>0u){west=flow[k-1u].x;}if(y>0u){north=flow[k-cfg.cols].y;}
 return vec2f(mix(west,flow[k].x,t.x),mix(north,flow[k].y,t.y));
}
@compute @workgroup_size(64) fn advect(@builtin(global_invocation_id) id:vec3u) {
 let i=id.x;if(i>=cfg.count*40u){return;}let f=funnels[i/40u];var p=particles[i];let owner=u32(f.w);
 if(p.owner!=owner||p.age>60.||p.alpha<.001){
  p=Particle(f.xy,0.,.07+.07*hash(i+owner),owner,p.life+1u,0.,0.);
  // Deterministic spawn in the halo; actual flow supplies all subsequent motion.
  for(var attempt=0u;attempt<16u;attempt++){
   let seed=i*127u+p.life*7919u+owner*65537u+attempt*31u;
   let a=hash(seed)*6.2831853;let r=(.25+.75*sqrt(hash(seed+1u)))*80./cfg.cell;
   let pos=f.xy+vec2f(cos(a),sin(a))*r;let k=cell(pos);
   if(all(pos>=vec2f(0.))&&all(pos<vec2f(f32(cfg.cols),f32(cfg.rows)))&&geo[k].z<.5&&geo[k].w<.5){p.pos=pos;p.alpha=f.z;break;}
  }
 }
 p.age+=cfg.dt;
 if(geo[cell(p.pos)].w>.5){p.size*=.8;p.alpha*=.6;}else{
  let v=velocity(p.pos);let distance=length(v)*cfg.dt;let delta=v*cfg.dt*min(1.,.35/max(.00001,distance));let next=p.pos+delta;
  if(all(next>=vec2f(0.))&&all(next<vec2f(f32(cfg.cols),f32(cfg.rows)))&&geo[cell(next)].z<.5){p.pos=next;}
  p.alpha=f.z*(.35+.65*min(1.,p.age/2.));
 }
 particles[i]=p;
}
