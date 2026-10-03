struct Settings { cols: u32, rows: u32, cell: f32, dt: f32,
  step: u32, source: u32, emission: u32, capacity: u32,
  range: f32, speed: f32, count: u32, seed: u32, heading: vec4f }
struct Packet { pos: vec2f, direction: vec2f, remaining: f32, speed: f32, mass: u32, serial: u32,
  origin: vec2f, initialRange: f32, originalMass: u32 }
@group(0) @binding(0) var<uniform> cfg: Settings;
@group(0) @binding(1) var<storage, read> geo: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> state: array<vec4u>;
@group(0) @binding(3) var<storage, read_write> packets: array<Packet>;
@group(0) @binding(4) var<storage, read_write> landing: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read> flow: array<vec2f>;
// serial, pending emission, landed this step, unused.
@group(0) @binding(6) var<storage, read_write> ledger: array<atomic<u32>>;
fn hash(value: u32) -> u32 {
  var h = value; h = (h ^ (h >> 16u)) * 2246822519u;
  h = (h ^ (h >> 13u)) * 3266489917u; return h ^ (h >> 16u);
}
fn random(value: u32) -> f32 { return f32(hash(value) & 16777215u) / 16777216.; }
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
    let angle = random(serial + cfg.seed) * 6.28318530718;
    let r = random(serial + cfg.seed + 12345u);
    let range = cfg.range * (.08 + .92 * r * r);
    let mass = share + select(0u, 1u, made < extra);
    var direction = vec2f(cos(angle), sin(angle));
    if (cfg.heading.z > .5) { direction = normalize(cfg.heading.xy); }
    packets[i] = Packet(origin, direction, range, cfg.speed, mass, serial, origin, range, mass);
    made++; serial++;
  }
  state[cfg.source].z -= pending; state[cfg.source].w += pending;
  atomicStore(&ledger[0], serial); atomicStore(&ledger[1], 0u);
}
fn deposit(packet: Packet, k: u32, position: vec2f) -> Packet {
  atomicAdd(&landing[k], packet.mass); atomicAdd(&ledger[2], packet.mass);
  var done = packet; done.pos = position; done.mass = 0u; return done;
}
fn inside(position: vec2f, x: i32, y: i32) -> vec2f {
  return clamp(position,vec2f(f32(x),f32(y))+.0001,vec2f(f32(x+1),f32(y+1))-.0001);
}
fn blocked(x: i32, y: i32) -> bool {
  if (x < 0 || y < 0 || x >= i32(cfg.cols) || y >= i32(cfg.rows)) { return true; }
  return geo[u32(y) * cfg.cols + u32(x)].z > .5;
}
@compute @workgroup_size(64) fn fly(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= cfg.capacity) { return; }
  var packet = packets[id.x]; if (packet.mass == 0u) { return; }
  var x = i32(floor(packet.pos.x)); var y = i32(floor(packet.pos.y));
  var k = u32(y) * cfg.cols + u32(x);
  if (geo[k].w > .5) { packets[id.x] = deposit(packet,k,packet.pos); return; }
  let west = select(k,k-1u,x>0); let north = select(k,k-cfg.cols,y>0);
  let current = .5 * vec2f(flow[k].x + flow[west].x, flow[k].y + flow[north].y);
  let delta = (packet.direction * packet.speed / cfg.cell + current) * cfg.dt;
  let distance = length(delta) * cfg.cell;
  if (distance < .000001) { return; }
  let dx = select(-1,1,delta.x >= 0.); let dy = select(-1,1,delta.y >= 0.);
  var tx = 2.; var ty = 2.; var strideX = 2.; var strideY = 2.;
  if (abs(delta.x) > .00000001) {
    let edge = select(f32(x),f32(x+1),delta.x>0.);
    tx = (edge-packet.pos.x)/delta.x; strideX = 1./abs(delta.x);
  }
  if (abs(delta.y) > .00000001) {
    let edge = select(f32(y),f32(y+1),delta.y>0.);
    ty = (edge-packet.pos.y)/delta.y; strideY = 1./abs(delta.y);
  }
  var t = 0.;
  // Trace every crossed cell; no teleport across a thin wall or a diagonal closed corner.
  for (var segment=0u;segment<64u;segment++) {
    let next = min(1.,min(tx,ty));
    let travelled = distance * max(0.,next-t);
    let available = packet.remaining * geo[k].x;
    if (travelled >= available) {
      let at = t + available / distance;
      packet.remaining = 0.; packets[id.x] = deposit(packet,k,inside(packet.pos+delta*at,x,y)); return;
    }
    packet.remaining -= travelled / geo[k].x;
    let crossX = tx <= ty && tx <= 1.; let crossY = ty <= tx && ty <= 1.;
    if (next >= 1. && !crossX && !crossY) { packet.pos += delta; packets[id.x] = packet; return; }
    var nx = x; var ny = y;
    if (crossX) { nx += dx; }
    if (crossY) { ny += dy; }
    let hit = blocked(nx,ny) || (crossX && crossY && (blocked(nx,y) || blocked(x,ny)));
    if (hit) {
      packets[id.x] = deposit(packet,k,inside(packet.pos+delta*next,x,y)); return;
    }
    x = nx; y = ny; k = u32(y)*cfg.cols+u32(x); t = next;
    if (geo[k].w > .5) { packets[id.x] = deposit(packet,k,inside(packet.pos+delta*next,x,y)); return; }
    if (next >= 1.) { packet.pos = inside(packet.pos+delta,x,y); packets[id.x]=packet; return; }
    if (crossX) { tx += strideX; }
    if (crossY) { ty += strideY; }
  }
  // Extreme velocities beyond the stand's integration bound land in the last valid cell.
  packets[id.x] = deposit(packet,k,inside(packet.pos+delta*t,x,y));
}
@compute @workgroup_size(64) fn gather(@builtin(global_invocation_id) id: vec3u) {
  let k = id.x; if (k >= cfg.cols * cfg.rows) { return; }
  state[k].x += atomicLoad(&landing[k]);
  if (k == cfg.source) { state[k].w -= atomicLoad(&ledger[2]); }
}
