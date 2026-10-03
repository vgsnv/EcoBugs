struct View { cols: u32, rows: u32, cell: f32, time: f32, arrows: u32, burst: u32, pad0: u32, pad1: u32,appearance:vec4f,camera:vec4f }
struct Packet { pos: vec2f, direction: vec2f, remaining: f32, speed: f32, mass: u32, serial: u32,
  origin: vec2f, initialRange: f32, originalMass: u32, impacts: u32, impactBefore: f32, impactAfter: f32, birth: u32 }
@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var<storage, read> packets: array<Packet>;
struct Vertex { @builtin(position) pos: vec4f, @location(0) local: vec2f }
@vertex fn vertex(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> Vertex {
  let corners = array<vec2f,6>(vec2f(-1.,-1.),vec2f(1.,-1.),vec2f(-1.,1.),vec2f(-1.,1.),vec2f(1.,-1.),vec2f(1.,1.));
  let corner = corners[vertex]; let packet = packets[instance];
  if (packet.mass == 0u) { return Vertex(vec4f(2.,2.,0.,1.),corner); }
  let world=(packet.pos+corner*.16)/vec2f(f32(view.cols),f32(view.rows));
  let uv=(world-view.camera.xy)*view.camera.z+.5;
  return Vertex(vec4f(uv.x*2.-1.,1.-uv.y*2.,0.,1.),corner);
}
@fragment fn fragment(in: Vertex) -> @location(0) vec4f {
  let alpha = 1.-smoothstep(.35,1.,length(in.local));
  return vec4f(.88,.69,1.,alpha);
}
