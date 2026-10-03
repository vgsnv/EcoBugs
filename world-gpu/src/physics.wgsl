struct Params { cols: u32, rows: u32, cell: f32, dt: f32,
  step: u32, source: u32, burst: u32, pad: u32 }
@group(0) @binding(0) var<uniform> cfg: Params;
@group(0) @binding(1) var<storage, read> geo: array<vec4f>;
@group(0) @binding(2) var<storage, read> before: array<vec4u>;
@group(0) @binding(3) var<storage, read_write> after: array<vec4u>;
@group(0) @binding(4) var<storage, read> pressure: array<f32>;
@group(0) @binding(5) var<storage, read_write> nextPressure: array<f32>;
@group(0) @binding(6) var<storage, read_write> flow: array<vec2f>;
@group(0) @binding(7) var<storage, read_write> outgoing: array<vec4u>;
@group(0) @binding(8) var<storage, read_write> carry: array<vec4f>;

fn neighbor(k: u32, dir: u32) -> u32 {
  let x = k % cfg.cols; let y = k / cfg.cols;
  if (dir == 0u && x + 1u < cfg.cols) { return k + 1u; }
  if (dir == 1u && y + 1u < cfg.rows) { return k + cfg.cols; }
  if (dir == 2u && x > 0u) { return k - 1u; }
  if (dir == 3u && y > 0u) { return k - cfg.cols; }
  return k;
}
fn conduct(k: u32, j: u32) -> f32 {
  if (k == j || geo[k].z > 0.5 || geo[j].z > 0.5) { return 0.; }
  return 2. * geo[k].x * geo[j].x / (geo[k].x + geo[j].x);
}
@compute @workgroup_size(64) fn solve(@builtin(global_invocation_id) id: vec3u) {
  let k = id.x; if (k >= cfg.cols * cfg.rows) { return; }
  var sum = 0.; var weight = 0.;
  for (var d = 0u; d < 4u; d++) {
    let j = neighbor(k, d); let c = conduct(k, j); weight += c; sum += c * pressure[j];
  }
  if (weight == 0.) { nextPressure[k] = 0.; return; }
  // Weighted Jacobi avoids the checkerboard mode of undamped Neumann Jacobi.
  nextPressure[k] = mix(pressure[k], (sum + geo[k].y) / weight, 0.75);
}
@compute @workgroup_size(64) fn velocity(@builtin(global_invocation_id) id: vec3u) {
  let k = id.x; if (k >= cfg.cols * cfg.rows) { return; }
  let east = neighbor(k, 0u); let south = neighbor(k, 1u);
  flow[k] = vec2f(conduct(k, east) * (pressure[k] - pressure[east]),
    conduct(k, south) * (pressure[k] - pressure[south]));
}
fn outward(k: u32, d: u32) -> f32 {
  if (cfg.burst == 1u && cfg.step >= 20u) { return 0.; }
  if (d == 0u) { return flow[k].x; }
  if (d == 1u) { return flow[k].y; }
  let j = neighbor(k, d);
  if (j == k) { return 0.; }
  if (d == 2u) { return -flow[j].x; }
  return -flow[j].y;
}
@compute @workgroup_size(64) fn transfer(@builtin(global_invocation_id) id: vec3u) {
  let k = id.x; if (k >= cfg.cols * cfg.rows) { return; }
  if (geo[k].z > 0.5 || geo[k].w > 0.5) { outgoing[k] = vec4u(0u); carry[k] = vec4f(0.); return; }
  var wanted = vec4f(0.);
  let mass = before[k].x;
  // Velocity is in cells/s; lower mobility limits the removable surface layer.
  for (var d = 0u; d < 4u; d++) {
    wanted[d] = f32(mass) * max(0., outward(k, d)) * cfg.dt;
  }
  let budget = f32(mass) * geo[k].x;
  let sum = dot(wanted, vec4f(1.));
  if (sum > budget && sum > 0.) { wanted *= budget / sum; }
  var available = mass;
  var result = vec4u(0u);
  for (var d = 0u; d < 4u; d++) {
    let j = neighbor(k, d);
    if (j == k || conduct(k, j) == 0. || wanted[d] == 0.) { carry[k][d] = 0.; continue; }
    let amount = wanted[d] + carry[k][d];
    result[d] = min(available, u32(floor(amount)));
    available -= result[d];
    carry[k][d] = select(0., amount - f32(result[d]), amount - f32(result[d]) < 1.);
  }
  outgoing[k] = result;
}
@compute @workgroup_size(64) fn advance(@builtin(global_invocation_id) id: vec3u) {
  let k = id.x; if (k >= cfg.cols * cfg.rows) { return; }
  var state = before[k];
  for (var d = 0u; d < 4u; d++) {
    let j = neighbor(k, d);
    state.x -= outgoing[k][d];
    if (j != k) { state.x += outgoing[j][(d + 2u) % 4u]; }
  }
  if (cfg.burst == 1u && k == cfg.source && cfg.step < 20u) {
    // Two-second controlled emission: reserve is a real part of the mass ledger.
    let emitted = min(state.z, 50000u); state.z -= emitted; state.x += emitted;
  }
  if (geo[k].w > 0.5) {
    let threshold = u32(cfg.cell * cfg.cell / 0.001 * 0.005);
    let excess = state.x - min(state.x, threshold);
    let captured = excess / 8u;
    state.x -= captured; state.y += captured;
  }
  after[k] = state;
}
