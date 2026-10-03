struct Settings { cols: u32, rows: u32, count: u32, pad: u32,
  cell: f32, length: f32, omega: f32, pad2: f32 }
@group(0) @binding(0) var<uniform> cfg: Settings;
@group(0) @binding(1) var<storage, read> geo: array<vec4f>;
@group(0) @binding(2) var<storage, read> vents: array<vec4f>;
// pressure, signed displacement rate / cell area, friction, unused.
@group(0) @binding(3) var<storage, read_write> field: array<vec4f>;
fn neighbor(k: u32, d: u32) -> u32 {
  if (d == 0u && k % cfg.cols + 1u < cfg.cols) { return k + 1u; }
  if (d == 1u && k / cfg.cols + 1u < cfg.rows) { return k + cfg.cols; }
  if (d == 2u && k % cfg.cols > 0u) { return k - 1u; }
  if (d == 3u && k / cfg.cols > 0u) { return k - cfg.cols; }
  return k;
}
@compute @workgroup_size(64) fn prepare(@builtin(global_invocation_id) id: vec3u) {
  let k = id.x; if (k >= cfg.cols * cfg.rows) { return; }
  field[k] = vec4f(0.);
  if (geo[k].z > .5) { return; }
  var source = 0.;
  for (var v = 0u; v < cfg.count; v++) {
    if (u32(vents[v].x) == k) { source += vents[v].y; }
  }
  let friction = cfg.cell * cfg.cell / (cfg.length * cfg.length * geo[k].x);
  field[k] = vec4f(0., source / (cfg.cell * cfg.cell), friction, 0.);
}
fn relax(k: u32, color: u32) {
  if (k >= cfg.cols * cfg.rows || ((k % cfg.cols + k / cfg.cols) & 1u) != color) { return; }
  if (geo[k].z > .5) { return; }
  var weight = field[k].z; var sum = field[k].y;
  for (var d = 0u; d < 4u; d++) {
    let j = neighbor(k, d);
    if (j == k || geo[j].z > .5) { continue; }
    let c = 2. * geo[k].x * geo[j].x / (geo[k].x + geo[j].x);
    weight += c; sum += c * field[j].x;
  }
  field[k].x += cfg.omega * (sum / weight - field[k].x);
}
@compute @workgroup_size(64) fn red(@builtin(global_invocation_id) id: vec3u) { relax(id.x, 0u); }
@compute @workgroup_size(64) fn black(@builtin(global_invocation_id) id: vec3u) { relax(id.x, 1u); }
