struct Settings { cols: u32, rows: u32, regions: u32, pad: u32,
  time: f32, drift: f32, sun: f32, background: f32,
  rhythm: f32, contrast: f32, entrainment: f32, pad2: f32 }
@group(0) @binding(0) var<uniform> cfg: Settings;
@group(0) @binding(1) var<storage, read_write> geo: array<vec4f>;
@group(0) @binding(2) var<storage, read> areas: array<i32>;
// illumination, tentative east/south flow, balanced physical contrast source.
@group(0) @binding(3) var<storage, read_write> field: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> means: array<f32>;

fn spot(uv: vec2f, center: vec2f, radius: f32) -> f32 {
  // Periodic map larger than the dish: spots enter and leave without wrapping at its walls.
  let delta = uv - center;
  let distance = length(delta - round(delta / 2.) * 2.);
  return 1. - smoothstep(radius * .35, radius, distance);
}
@compute @workgroup_size(64) fn illuminate(@builtin(global_invocation_id) id: vec3u) {
  let k = id.x; if (k >= cfg.cols * cfg.rows) { return; }
  let uv = (vec2f(f32(k % cfg.cols), f32(k / cfg.cols)) + .5) / vec2f(f32(cfg.cols), f32(cfg.rows));
  let shifted = uv - vec2f(cfg.drift, cfg.drift * .35) * cfg.time;
  let deform = sin(cfg.time * .035) * .025;
  let a = spot(shifted, vec2f(.27 + deform, .34), .28 + deform);
  let b = spot(shifted, vec2f(.77, .73 - deform), .23 - deform * .5);
  let c = spot(shifted, vec2f(1.34, .21), .31);
  let sun = cfg.sun * (1. + cfg.rhythm * sin(cfg.time * .1 + .7));
  field[k] = vec4f(sun * mix(cfg.background, 1., max(a, max(b, c))), 0., 0., 0.);
}
// One invocation per closed region; sequential summation avoids order-dependent atomic sums.
@compute @workgroup_size(1) fn average(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= cfg.regions) { return; }
  var buckets: array<f32, 128>; var count = 0u;
  for (var k = 0u; k < cfg.cols * cfg.rows; k++) {
    if (areas[k] == i32(id.x)) { buckets[k % 128u] += field[k].x; count++; }
  }
  // Explicit tree summation bounds the length of each Float32 accumulation chain.
  for (var stride = 64u; stride > 0u; stride /= 2u) {
    for (var k = 0u; k < stride; k++) { buckets[k] += buckets[k + stride]; }
  }
  means[id.x] = buckets[0] / f32(max(1u, count));
}
fn conduct(k: u32, j: u32) -> f32 {
  if (k == j || geo[k].z > .5 || geo[j].z > .5) { return 0.; }
  return 2. * geo[k].x * geo[j].x / (geo[k].x + geo[j].x);
}
@compute @workgroup_size(64) fn entrain(@builtin(global_invocation_id) id: vec3u) {
  let k = id.x; if (k >= cfg.cols * cfg.rows) { return; }
  let x = k % cfg.cols; let y = k / cfg.cols;
  let east = select(k, k + 1u, x + 1u < cfg.cols);
  let south = select(k, k + cfg.cols, y + 1u < cfg.rows);
  let drift = cfg.drift * cfg.entrainment * vec2f(f32(cfg.cols), f32(cfg.rows) * .35);
  field[k].y = conduct(k, east) * .5 * (field[k].x + field[east].x) * drift.x;
  field[k].z = conduct(k, south) * .5 * (field[k].x + field[south].x) * drift.y;
}
@compute @workgroup_size(64) fn sources(@builtin(global_invocation_id) id: vec3u) {
  let k = id.x; if (k >= cfg.cols * cfg.rows) { return; }
  if (areas[k] < 0) { geo[k].y = 0.; field[k].w = 0.; return; }
  let x = k % cfg.cols; let y = k / cfg.cols;
  var divergence = field[k].y + field[k].z;
  if (x > 0u) { divergence -= field[k - 1u].y; }
  if (y > 0u) { divergence -= field[k - cfg.cols].z; }
  let contrast = cfg.contrast * (field[k].x - means[u32(areas[k])]);
  field[k].w = contrast;
  geo[k].y = contrast - divergence;
}
