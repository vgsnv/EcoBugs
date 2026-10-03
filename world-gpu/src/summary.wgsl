struct Params { cols: u32, rows: u32, cell: f32, dt: f32,
  step: u32, source: u32, burst: u32, pad: u32, emission: vec4u }
@group(0) @binding(0) var<uniform> cfg: Params;
@group(0) @binding(1) var<storage, read> geo: array<vec4f>;
@group(0) @binding(2) var<storage, read> state: array<vec4u>;
@group(0) @binding(3) var<storage, read> flow: array<vec2f>;
struct Summary { mass: vec4u, accuracy: vec4u, terrain:vec4u }
@group(0) @binding(4) var<storage, read_write> summary: array<Summary>;
@group(0) @binding(5) var<storage, read> field: array<vec4f>;
@group(0) @binding(6) var<storage, read> vents: array<vec4f>;
@group(0) @binding(7) var<storage,read> terrain:array<vec4u>;
@compute @workgroup_size(1) fn summarize(@builtin(global_invocation_id) id: vec3u) {
  let start = id.x * 64u;
  var earth=vec2u(0u);
  var masses = vec4u(0u); var maxSpeed = 0.; var residual = 0.; var scale = 0.; var leak = 0u;
  for (var k = start; k < min(start + 64u, cfg.cols * cfg.rows); k++) {
    masses += state[k];earth+=terrain[k].yx;
    if (geo[k].z > .5) { leak += state[k].x; }
    maxSpeed = max(maxSpeed, max(abs(flow[k].x), abs(flow[k].y)));
    let x = k % cfg.cols; let y = k / cfg.cols;
    var balance = flow[k].x + flow[k].y;
    if (x > 0u) { balance -= flow[k - 1u].x; }
    if (y > 0u) { balance -= flow[k - cfg.cols].y; }
    let source = select(geo[k].y, field[k].w, cfg.pad == 1u) + vents[k].y - vents[k].z * vents[k].x;
    residual += (balance - source) * (balance - source);
    scale += source * source;
  }
  if (cfg.burst == 1u && cfg.step >= 20u) { maxSpeed = 0.; }
  summary[id.x].mass = vec4u(masses.xyz, bitcast<u32>(maxSpeed));
  summary[id.x].terrain=vec4u(earth,0u,0u);
  summary[id.x].accuracy = vec4u(bitcast<u32>(residual), bitcast<u32>(scale), leak, masses.w);
}
