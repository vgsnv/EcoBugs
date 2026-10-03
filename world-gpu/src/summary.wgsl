struct Params { cols: u32, rows: u32, cell: f32, dt: f32,
  step: u32, source: u32, burst: u32, pad: u32 }
@group(0) @binding(0) var<uniform> cfg: Params;
@group(0) @binding(1) var<storage, read> geo: array<vec4f>;
@group(0) @binding(2) var<storage, read> state: array<vec4u>;
@group(0) @binding(3) var<storage, read> flow: array<vec2f>;
struct Summary { mass: vec4u, accuracy: vec4u }
@group(0) @binding(4) var<storage, read_write> summary: array<Summary>;
@compute @workgroup_size(1) fn summarize(@builtin(global_invocation_id) id: vec3u) {
  let start = id.x * 64u;
  var masses = vec3u(0u); var maxSpeed = 0.; var residual = 0.; var scale = 0.; var leak = 0u;
  for (var k = start; k < min(start + 64u, cfg.cols * cfg.rows); k++) {
    masses += state[k].xyz;
    if (geo[k].z > .5) { leak += state[k].x; }
    maxSpeed = max(maxSpeed, max(abs(flow[k].x), abs(flow[k].y)));
    let x = k % cfg.cols; let y = k / cfg.cols;
    var balance = flow[k].x + flow[k].y;
    if (x > 0u) { balance -= flow[k - 1u].x; }
    if (y > 0u) { balance -= flow[k - cfg.cols].y; }
    residual += (balance - geo[k].y) * (balance - geo[k].y);
    scale += geo[k].y * geo[k].y;
  }
  if (cfg.burst == 1u && cfg.step >= 20u) { maxSpeed = 0.; }
  summary[id.x].mass = vec4u(masses, bitcast<u32>(maxSpeed));
  summary[id.x].accuracy = vec4u(bitcast<u32>(residual), bitcast<u32>(scale), leak, 0u);
}
