struct Params { cols: u32, rows: u32, cell: f32, dt: f32,
  step: u32, source: u32, burst: u32, light: u32 }
@group(0) @binding(0) var<uniform> cfg: Params;
@group(0) @binding(1) var<storage, read> geo: array<vec4f>;
@group(0) @binding(2) var<storage, read> pressure: array<f32>;
@group(0) @binding(3) var<storage, read_write> flow: array<vec2f>;
@group(0) @binding(4) var<storage, read> field: array<vec4f>;
fn conduct(k: u32, j: u32) -> f32 {
  if (k == j || geo[k].z > .5 || geo[j].z > .5) { return 0.; }
  return 2. * geo[k].x * geo[j].x / (geo[k].x + geo[j].x);
}
@compute @workgroup_size(64) fn velocity(@builtin(global_invocation_id) id: vec3u) {
  let k = id.x; if (k >= cfg.cols * cfg.rows) { return; }
  let east = select(k, k + 1u, k % cfg.cols + 1u < cfg.cols);
  let south = select(k, k + cfg.cols, k / cfg.cols + 1u < cfg.rows);
  let projected = vec2f(conduct(k, east) * (pressure[k] - pressure[east]), conduct(k, south) * (pressure[k] - pressure[south]));
  flow[k] = projected + select(vec2f(0.), field[k].yz, cfg.light == 1u);
}
