struct Settings { cols: u32, rows: u32, cell: f32, dt: f32,
  step: u32, source: u32, emission: u32, capacity: u32,
  range: f32, speed: f32, count: u32, seed: u32, heading: vec4f }
struct Packet { pos: vec2f, direction: vec2f, remaining: f32, speed: f32, mass: u32, serial: u32,
  origin: vec2f, initialRange: f32, originalMass: u32, impacts: u32, impactBefore: f32, impactAfter: f32, birth: u32 }
@group(0) @binding(0) var<uniform> cfg: Settings;
@group(0) @binding(1) var<storage, read> geo: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> state: array<vec4u>;
@group(0) @binding(3) var<storage, read_write> packets: array<Packet>;
@group(0) @binding(4) var<storage, read_write> landing: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read> flow: array<vec2f>;
// serial, pending emission, landed this step, integration guard hits.
@group(0) @binding(6) var<storage, read_write> ledger: array<atomic<u32>>;
fn hash(value: u32) -> u32 {
  var h = value; h = (h ^ (h >> 16u)) * 2246822519u;
  h = (h ^ (h >> 13u)) * 3266489917u; return h ^ (h >> 16u);
}
fn random(value: u32) -> f32 { return f32(hash(value) & 16777215u) / 16777216.; }
// Low-discrepancy samples reduce changes of plume shape when the packet count is refined.
fn radical(value:u32,base:u32)->f32 {
  var n=value;var scale=1./f32(base);var result=0.;
  for(var i=0u;i<32u&&n>0u;i++){result+=f32(n%base)*scale;n/=base;scale/=f32(base);}
  return result;
}
@compute @workgroup_size(1) fn spawn() {
  atomicStore(&ledger[2], 0u);
  let queued = min(state[cfg.source].z, atomicLoad(&ledger[1]));
  let pending = queued + min(cfg.emission, state[cfg.source].z - queued);
  var free = 0u;
  for (var i = 0u; i < cfg.capacity; i++) { if (packets[i].mass == 0u) { free++; } }
  let count = min(min(free, cfg.count), pending);
  if (count == 0u) { atomicStore(&ledger[1], pending); return; }
  let share = pending / count; let extra = pending % count;
  let origin = vec2f(f32(cfg.source % cfg.cols) + .5, f32(cfg.source / cfg.cols) + .5);
  var made = 0u; var serial = atomicLoad(&ledger[0]);
  for (var i = 0u; i < cfg.capacity && made < count; i++) {
    if (packets[i].mass != 0u) { continue; }
    let angle = fract(radical(serial,3u)+random(cfg.seed)) * 6.28318530718;
    let r = fract(radical(serial,2u)+random(cfg.seed+12345u));
    let range = cfg.range * (.08 + .92 * r * r);
    let mass = share + select(0u, 1u, made < extra);
    var direction = vec2f(cos(angle), sin(angle));
    if (cfg.heading.z > .5) { direction = normalize(cfg.heading.xy); }
    packets[i] = Packet(origin, direction, range, cfg.speed, mass, serial, origin, range, mass, 0u, 0., 0., cfg.step);
    made++; serial++;
  }
  state[cfg.source].z -= pending; state[cfg.source].w += pending;
  atomicStore(&ledger[0], serial); atomicStore(&ledger[1], 0u);
}
// Model constants: weak normal rebound, tangential friction, physical mixing footprint.
const REBOUND: f32 = .15;
const SLIDE: f32 = .75;
const MIX_RADIUS: f32 = 35.;
const STOP_SPEED: f32 = .5;
fn blocked(x: i32, y: i32) -> bool {
  if (x < 0 || y < 0 || x >= i32(cfg.cols) || y >= i32(cfg.rows)) { return true; }
  return geo[u32(y) * cfg.cols + u32(x)].z > .5;
}
fn inside(position: vec2f, x: i32, y: i32) -> vec2f {
  return clamp(position, vec2f(f32(x),f32(y))+.0001, vec2f(f32(x+1),f32(y+1))-.0001);
}
// A mixing footprint must not jump across a wall, corner or hole lip, even in an open region.
fn visible(k: u32, destination: u32) -> bool {
  var x=i32(k%cfg.cols); var y=i32(k/cfg.cols);
  let end=vec2i(i32(destination%cfg.cols),i32(destination/cfg.cols));
  let delta=vec2f(end-vec2i(x,y)); let dx=select(-1,1,delta.x>=0.); let dy=select(-1,1,delta.y>=0.);
  let sx=select(1e9,1./abs(delta.x),delta.x!=0.); let sy=select(1e9,1./abs(delta.y),delta.y!=0.);
  var tx=.5*sx; var ty=.5*sy;
  for(var i=0u;i<16u;i++) {
    if(all(vec2i(x,y)==end)) { return true; }
    let crossX=tx<=ty; let crossY=ty<=tx;
    var nx=x; var ny=y;
    if(crossX){nx+=dx;} if(crossY){ny+=dy;}
    if(blocked(nx,ny)||(crossX&&crossY&&(blocked(nx,y)||blocked(x,ny)))) {return false;}
    let j=u32(ny)*cfg.cols+u32(nx);
    if((geo[j].w>.5)!=(geo[k].w>.5)){return false;}
    x=nx;y=ny;if(crossX){tx+=sx;}if(crossY){ty+=sy;}
  }
  return false;
}
fn weight(k:u32,x:i32,y:i32,position:vec2f)->f32 {
  if(blocked(x,y)){return 0.;}
  let j=u32(y)*cfg.cols+u32(x);
  if((geo[j].w>.5)!=(geo[k].w>.5)||!visible(k,j)){return 0.;}
  let r=length((vec2f(f32(x),f32(y))+.5-position)*cfg.cell)/MIX_RADIUS;
  let w=max(0.,1.-r*r);return w*w;
}
fn deposit(packet: Packet, k: u32) -> Packet {
  let x=i32(k%cfg.cols);let y=i32(k/cfg.cols);let radius=i32(ceil(MIX_RADIUS/cfg.cell))+1;
  var total=0.;
  for(var dy=-radius;dy<=radius;dy++){for(var dx=-radius;dx<=radius;dx++){total+=weight(k,x+dx,y+dy,packet.pos);}}
  var assigned=0u;var cumulative=0.;
  if(total>0.) {
    for(var dy=-radius;dy<=radius;dy++){for(var dx=-radius;dx<=radius;dx++){
      let w=weight(k,x+dx,y+dy,packet.pos);if(w==0.){continue;}
      cumulative+=w;
      let next=max(assigned,min(packet.mass,u32(floor(f32(packet.mass)*min(1.,cumulative/total)))));
      atomicAdd(&landing[u32(y+dy)*cfg.cols+u32(x+dx)],next-assigned);assigned=next;
    }}
  }
  atomicAdd(&landing[k],packet.mass-assigned);atomicAdd(&ledger[2],packet.mass);
  var done=packet;done.mass=0u;return done;
}
fn currentAt(k:u32,position:vec2f)->vec2f {
  let x=i32(k%cfg.cols);let y=i32(k/cfg.cols);
  let west=select(k,k-1u,x>0);let north=select(k,k-cfg.cols,y>0);
  var current=.5*vec2f(flow[k].x+flow[west].x,flow[k].y+flow[north].y);
  // At contact, the closed face cancels the inward fluid component.
  let local=position-vec2f(f32(x),f32(y));
  if((local.x<.0002&&current.x<0.&&blocked(x-1,y))||(local.x>.9998&&current.x>0.&&blocked(x+1,y))){current.x=0.;}
  if((local.y<.0002&&current.y<0.&&blocked(x,y-1))||(local.y>.9998&&current.y>0.&&blocked(x,y+1))){current.y=0.;}
  return current;
}
// Solve d = v*t - a*t²/2 with stable roots; acceleration may oppose a fluid component.
fn crossingTime(d:f32,v:f32,a:f32)->f32 {
  if(abs(a)<.00000001){if(abs(v)<.00000001){return 1e9;}let t=d/v;return select(1e9,t,t>=0.);}
  let discriminant=v*v-2.*a*d;if(discriminant<0.){return 1e9;}
  let q=v+select(-sqrt(discriminant),sqrt(discriminant),v>=0.);
  var result=1e9;
  if(abs(q)>.00000001){let t=2.*d/q;if(t>=0.){result=t;}}
  let other=q/a;if(other>=0.){result=min(result,other);}return result;
}
@compute @workgroup_size(64) fn fly(@builtin(global_invocation_id) id: vec3u) {
  if(id.x>=cfg.capacity){return;}
  var packet=packets[id.x];if(packet.mass==0u){return;}
  var time=cfg.dt;
  // Small fixed time slices plus first-contact tracing; preserve the unspent time after an impact.
  for(var event=0u;event<256u;event++) {
    let x=i32(floor(packet.pos.x));let y=i32(floor(packet.pos.y));let k=u32(y)*cfg.cols+u32(x);
    if(geo[k].w>.5||packet.speed<=STOP_SPEED||packet.remaining<=.0001){packets[id.x]=deposit(packet,k);return;}
    if(time<=.000001){packets[id.x]=packet;return;}
    let mobility=geo[k].x;
    let acceleration=packet.speed*packet.speed/(2.*packet.remaining*mobility);
    let chunk=min(min(time,.01),packet.speed/acceleration);
    let velocity=packet.direction*packet.speed/cfg.cell+currentAt(k,packet.pos);
    let deceleration=packet.direction*acceleration/cfg.cell;
    let westTime=crossingTime(f32(x)-packet.pos.x,velocity.x,deceleration.x);
    let eastTime=crossingTime(f32(x+1)-packet.pos.x,velocity.x,deceleration.x);
    let northTime=crossingTime(f32(y)-packet.pos.y,velocity.y,deceleration.y);
    let southTime=crossingTime(f32(y+1)-packet.pos.y,velocity.y,deceleration.y);
    let tx=min(westTime,eastTime);let ty=min(northTime,southTime);
    let dx=select(-1,1,eastTime<=westTime);let dy=select(-1,1,southTime<=northTime);
    let duration=min(chunk,min(tx,ty));
    let before=packet.remaining;
    let distance=max(0.,packet.speed*duration-.5*acceleration*duration*duration);
    packet.remaining=max(0.,before-distance/mobility);
    packet.speed*=sqrt(packet.remaining/before);
    packet.pos+=velocity*duration-.5*deceleration*duration*duration;time-=duration;
    let crossX=tx<=chunk&&tx<=ty;let crossY=ty<=chunk&&ty<=tx;
    if(!crossX&&!crossY){continue;}
    var nx=x;var ny=y;if(crossX){nx+=dx;}if(crossY){ny+=dy;}
    let wallX=crossX&&blocked(x+dx,y);let wallY=crossY&&blocked(x,y+dy);
    let diagonal=crossX&&crossY&&blocked(nx,ny);
    let hitX=wallX||diagonal;let hitY=wallY||diagonal;
    if(hitX||hitY) {
      packet.pos=inside(packet.pos,x,y);
      let old=packet.speed;var own=packet.direction*old;
      if(hitX){own.x*=select(1.,-REBOUND,own.x*f32(dx)>0.);own.y*=SLIDE;}
      if(hitY){own.y*=select(1.,-REBOUND,own.y*f32(dy)>0.);own.x*=SLIDE;}
      packet.speed=length(own);packet.remaining*=packet.speed*packet.speed/max(.000001,old*old);
      packet.impacts++;packet.impactBefore=old;packet.impactAfter=packet.speed;
      if(packet.speed>0.){packet.direction=own/packet.speed;}
      continue;
    }
    // Move a tiny distance inside the entered cell to give the next crossing an unambiguous side.
    packet.pos=inside(packet.pos,nx,ny);
  }
  // Signal an unresolved step; the UI halts rather than silently publishing shortened motion.
  if(time>.000001){atomicAdd(&ledger[3],1u);}
  packets[id.x]=packet;
}
@compute @workgroup_size(64) fn gather(@builtin(global_invocation_id) id: vec3u) {
  let k = id.x; if (k >= cfg.cols * cfg.rows) { return; }
  state[k].x += atomicLoad(&landing[k]);
  if (k == cfg.source) { state[k].w -= atomicLoad(&ledger[2]); }
}
