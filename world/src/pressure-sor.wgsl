struct Params { cols: u32, rows: u32, omega: f32, pad: u32 }
@group(0) @binding(0) var<uniform> cfg: Params;
@group(0) @binding(1) var<storage, read> geo: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> pressure: array<f32>;

fn neighbor(k: u32, dir: u32) -> u32 {
  let x = k % cfg.cols; let y = k / cfg.cols;
  if (dir == 0u && x + 1u < cfg.cols) { return k + 1u; }
  if (dir == 1u && y + 1u < cfg.rows) { return k + cfg.cols; }
  if (dir == 2u && x > 0u) { return k - 1u; }
  if (dir == 3u && y > 0u) { return k - cfg.cols; }
  return k;
}
fn relax(k: u32, color: u32) {
  if (k >= cfg.cols * cfg.rows) { return; }
  // Neighbours have the opposite color; no two active cells depend on each other's writes.
  if (((k % cfg.cols + k / cfg.cols) & 1u) != color) { return; }
  if (geo[k].z > .5) { pressure[k] = 0.; return; }
  var weight = 0.; var sum = 0.;
  for (var d = 0u; d < 4u; d++) {
    let j = neighbor(k, d);
    if (j == k || geo[j].z > .5) { continue; }
    let conductance = 2. * geo[k].x * geo[j].x / (geo[k].x + geo[j].x);
    weight += conductance; sum += conductance * pressure[j];
  }
  if (weight == 0.) { pressure[k] = 0.; return; }
  pressure[k] += cfg.omega * ((sum + geo[k].y) / weight - pressure[k]);
}
// Separate dispatches provide a device-wide dependency between red and black phases.
@compute @workgroup_size(64) fn red(@builtin(global_invocation_id) id: vec3u) { relax(id.x, 0u); }
@compute @workgroup_size(64) fn black(@builtin(global_invocation_id) id: vec3u) { relax(id.x, 1u); }
