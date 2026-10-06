/**
 * Шейдеры лаборатории «жизнь на видеокарте в нашем мире». Клетка — та же, что
 * в замере docs/gpu-bench.md (деление, смерть, связи, регуляция, минерал
 * квантами), но свет, мутность, течения, вязкость и стенки берутся из мира.
 */
import { MAX_SPOTS, SPOT_EDGE, SPOT_REACH } from '../core/index.ts';

/** Ход жизни — раз в столько шагов мира (как в первой попытке). */
export const LIFE_PERIOD = 5;
/** Корзина сетки соседей, мм: не меньше диаметра самой крупной клетки. */
export const BUCKET = 2.5;
export const NG = 10;
export const CELL_BYTES = 48;
/** Сколько ходов вперёд держит кольцо с пятнами света. */
export const RING = 128;
/** Запись хода в кольце, vec4: солнце и фон, размер плоскости, пятна, гармоники, фазы. */
export const TICK_VEC4 = 2 + 3 * MAX_SPOTS;
/** Номера в info. */
export const INFO = { slots: 0, births: 1, alive: 2, tick: 3, totalBirths: 4, totalDeaths: 5, grid: 6, refused: 7, driftU: 8, overdraw: 9, takes: 10 } as const;


const COMMON = /* wgsl */`
struct Cell { vel: vec2f, e: f32, m: f32, age: f32, mn: u32, pad0: u32, pad1: u32, bonds: vec4i };
struct Prm {
  popCap: u32, slotCap: u32, gw: u32, gh: u32, B: u32, nb: u32, mcols: u32, mrows: u32, dcols: u32, drows: u32, pad0: u32, pad1: u32,
  width: f32, height: f32, mcell: f32, dcell: f32,
  push: f32, f1: f32, f2: f32, f3: f32,
};
const BUCKET = ${BUCKET};
const NG = ${NG}u;
const STEPS = ${LIFE_PERIOD}.0;
fn pcg(v: u32) -> u32 { let s = v * 747796405u + 2891336453u; let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
fn rnd(a: u32, b: u32) -> f32 { return f32(pcg(a ^ pcg(b)) >> 8u) / 16777216.0; }
fn radius(m: f32) -> f32 { return 0.5 * sqrt(m); }
`;

export const LIFE_WGSL = COMMON + /* wgsl */`
@group(0) @binding(0) var<uniform> prm: Prm;
@group(0) @binding(1) var<storage, read> posR: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> posW: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> cells: array<Cell>;
@group(0) @binding(4) var<storage, read_write> genes: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> info: array<atomic<u32>>;
@group(0) @binding(6) var<storage, read_write> counts: array<atomic<u32>>;
@group(0) @binding(7) var<storage, read_write> start: array<u32>;
@group(0) @binding(8) var<storage, read_write> cursor: array<atomic<u32>>;
@group(0) @binding(9) var<storage, read_write> blockSum: array<u32>;
@group(0) @binding(10) var<storage, read_write> blockOff: array<u32>;
@group(0) @binding(11) var<storage, read_write> items: array<u32>;
// env на сетке минерала: x — доля света (мутность × усвоение), y — сопротивление, z — уровень (−1 — стенка или вне чаши), w — свет хода
@group(0) @binding(12) var<storage, read_write> env: array<vec4f>;
// течения: узел A, узел B (сетка сноса), течения вулканов и воронок (сетка минерала) — смещение за шаг мира
@group(0) @binding(13) var<storage, read> flow: array<vec2f>;
// минерал: доступные кванты по клеткам сетки, затем изменение жизнью с последней сдачи миру (со знаком)
@group(0) @binding(14) var<storage, read_write> mq: array<atomic<u32>>;
@group(0) @binding(15) var<storage, read_write> args: array<u32>;
@group(0) @binding(16) var<storage, read_write> newIndex: array<u32>;
@group(0) @binding(17) var<storage, read_write> cellsDst: array<Cell>;
@group(0) @binding(18) var<storage, read_write> genesDst: array<vec4f>;
@group(0) @binding(19) var<storage, read_write> posDst: array<vec4f>;
@group(0) @binding(20) var<storage, read> ring: array<vec4f>;
@group(0) @binding(21) var<storage, read> viewQ: array<u32>;

fn bucket2(x: vec2f) -> vec2u { return vec2u(clamp(vec2i(x / BUCKET), vec2i(0), vec2i(i32(prm.gw) - 1, i32(prm.gh) - 1))); }
fn bucketIdx(x: vec2f) -> u32 { let b = bucket2(x); return b.y * prm.gw + b.x; }
fn mIdx(x: vec2f) -> u32 {
  let i = min(u32(max(x.x, 0.0) / prm.mcell), prm.mcols - 1u); let j = min(u32(max(x.y, 0.0) / prm.mcell), prm.mrows - 1u);
  return j * prm.mcols + i;
}
fn inside(x: vec2f) -> bool {
  return x.x >= 0.0 && x.y >= 0.0 && x.x < prm.width && x.y < prm.height && env[mIdx(x)].z >= 0.0;
}
// Свет хода: билинейно по центрам ячеек сетки минерала (как mineralDensity мира).
fn lightAt(x: vec2f) -> f32 {
  let fx = clamp(x.x / prm.mcell - 0.5, 0.0, f32(prm.mcols - 1u)); let fy = clamp(x.y / prm.mcell - 0.5, 0.0, f32(prm.mrows - 1u));
  let i0 = u32(fx); let j0 = u32(fy); let i1 = min(prm.mcols - 1u, i0 + 1u); let j1 = min(prm.mrows - 1u, j0 + 1u);
  let u = fx - f32(i0); let v = fy - f32(j0);
  let a = mix(env[j0 * prm.mcols + i0].w, env[j0 * prm.mcols + i1].w, u);
  let b = mix(env[j1 * prm.mcols + i0].w, env[j1 * prm.mcols + i1].w, u);
  return mix(a, b, v);
}
// Снос — как Drift.at мира: билинейно по узлу A и узлу B, затем по доле пути между узлами.
fn driftNode(base: u32, x: vec2f) -> vec2f {
  let fx = clamp(x.x / prm.dcell - 0.5, 0.0, f32(prm.dcols - 1u)); let fy = clamp(x.y / prm.dcell - 0.5, 0.0, f32(prm.drows - 1u));
  let i0 = u32(fx); let j0 = u32(fy); let i1 = min(prm.dcols - 1u, i0 + 1u); let j1 = min(prm.drows - 1u, j0 + 1u);
  let u = fx - f32(i0); let v = fy - f32(j0);
  let a = mix(flow[base + j0 * prm.dcols + i0], flow[base + j0 * prm.dcols + i1], u);
  let b = mix(flow[base + j1 * prm.dcols + i0], flow[base + j1 * prm.dcols + i1], u);
  return mix(a, b, v);
}
fn flowAt(x: vec2f, w: f32) -> vec2f {
  let nd = prm.dcols * prm.drows;
  return mix(driftNode(0u, x), driftNode(nd, x), w) + flow[2u * nd + mIdx(x)];
}
fn takeQuantum(k: u32) -> bool {
  var old = atomicLoad(&mq[k]);
  for (var t = 0; t < 8; t++) {
    if (old == 0u) { return false; }
    let r = atomicCompareExchangeWeak(&mq[k], old, old - 1u);
    if (r.exchanged) { atomicAdd(&mq[prm.mcols * prm.mrows + k], 0xffffffffu); return true; }
    old = r.old_value;
  }
  return false;
}
fn giveQuanta(k: u32, n: u32) { atomicAdd(&mq[k], n); atomicAdd(&mq[prm.mcols * prm.mrows + k], n); }

// ---- свет хода: поле пятен мира (LIGHT_FIELD_GLSL) × солнце × доля света места ----
@compute @workgroup_size(256) fn light(@builtin(global_invocation_id) g: vec3u) {
  let k = g.x; let n = prm.mcols * prm.mrows;
  let slot = atomicLoad(&info[3]) % ${RING}u; let base = slot * ${TICK_VEC4}u;
  let h0 = ring[base]; let plane = ring[base + 1u].xy;
  if (k == 0u) { atomicStore(&info[8], bitcast<u32>(h0.z)); }
  if (k >= n) { return; }
  let e = env[k];
  if (e.z < 0.0) { env[k].w = 0.0; return; }
  let w = vec2f(f32(k % prm.mcols) + 0.5, f32(k / prm.mcols) + 0.5) * prm.mcell;
  var sum = 0.0;
  let count = u32(h0.w);
  for (var i = 0u; i < count; i++) {
    let s = ring[base + 2u + i];
    var d = w - s.xy;
    d -= plane * floor(d / plane + 0.5);
    let r = length(d); let ed = ${SPOT_EDGE.toFixed(3)} * s.z;
    if (r > s.z * ${SPOT_REACH.toFixed(3)} + ed) { continue; }
    let th = atan2(d.y, d.x);
    let a = ring[base + 2u + ${MAX_SPOTS}u + i]; let p = ring[base + 2u + ${2 * MAX_SPOTS}u + i];
    let rr = 1.0 + a.x * cos(2.0 * th + p.x) + a.y * cos(3.0 * th + p.y) + a.z * cos(4.0 * th + p.z) + a.w * cos(5.0 * th + p.w);
    sum += smoothstep(0.0, 1.0, (s.z * rr * s.w + ed * 0.5 - r) / ed);
  }
  // h0.x — солнце (sunAt), h0.y — фон (lightBackground): как lightFromIntensity мира
  env[k].w = h0.x * (h0.y + (1.0 - h0.y) * sum) * e.x;
}

// ---- сетка: подсчёт по корзинам, префиксная сумма, раскладка номеров ----
@compute @workgroup_size(256) fn clearCounts(@builtin(global_invocation_id) g: vec3u) {
  if (g.x < prm.B + 1u) { atomicStore(&counts[g.x], 0u); }
}
@compute @workgroup_size(256) fn count(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x; if (i >= atomicLoad(&info[0])) { return; }
  let p = posR[i]; if (p.z <= 0.0) { return; }
  atomicAdd(&counts[bucketIdx(p.xy)], 1u);
}
var<workgroup> sh: array<u32, 256>;
@compute @workgroup_size(256) fn scanBlocks(@builtin(local_invocation_id) l: vec3u, @builtin(workgroup_id) w: vec3u) {
  let base = w.x * 512u + l.x * 2u; let n = prm.B + 1u;
  var a = 0u; var b = 0u;
  if (base < n) { a = atomicLoad(&counts[base]); }
  if (base + 1u < n) { b = atomicLoad(&counts[base + 1u]); }
  sh[l.x] = a + b; workgroupBarrier();
  for (var off = 1u; off < 256u; off <<= 1u) {
    var v = 0u; if (l.x >= off) { v = sh[l.x - off]; }
    workgroupBarrier(); sh[l.x] += v; workgroupBarrier();
  }
  let ex = sh[l.x] - (a + b);
  if (base < n) { start[base] = ex; }
  if (base + 1u < n) { start[base + 1u] = ex + a; }
  if (l.x == 255u) { blockSum[w.x] = sh[255]; }
}
@compute @workgroup_size(256) fn scanSums(@builtin(local_invocation_id) l: vec3u) {
  let chunk = (prm.nb + 255u) / 256u; let s0 = l.x * chunk;
  var sum = 0u;
  for (var k = 0u; k < chunk; k++) { let i = s0 + k; if (i < prm.nb) { sum += blockSum[i]; } }
  sh[l.x] = sum; workgroupBarrier();
  for (var off = 1u; off < 256u; off <<= 1u) {
    var v = 0u; if (l.x >= off) { v = sh[l.x - off]; }
    workgroupBarrier(); sh[l.x] += v; workgroupBarrier();
  }
  var run = sh[l.x] - sum;
  for (var k = 0u; k < chunk; k++) { let i = s0 + k; if (i < prm.nb) { blockOff[i] = run; run += blockSum[i]; } }
}
@compute @workgroup_size(256) fn scanAdd(@builtin(global_invocation_id) g: vec3u) {
  let e = g.x; if (e > prm.B) { return; }
  let v = start[e] + blockOff[e / 512u];
  start[e] = v; atomicStore(&cursor[e], v);
  if (e == prm.B) { atomicStore(&info[6], v); args[3] = (v + 255u) / 256u; args[4] = 1u; args[5] = 1u; }
}
@compute @workgroup_size(256) fn scatter(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x; if (i >= atomicLoad(&info[0])) { return; }
  let p = posR[i]; if (p.z <= 0.0) { return; }
  items[atomicAdd(&cursor[bucketIdx(p.xy)], 1u)] = i;
}

// ---- ход клетки в мире ----
@compute @workgroup_size(256) fn update(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  let slots = atomicLoad(&info[0]);
  if (i >= slots) { return; }
  var c = cells[i];
  if (c.m <= 0.0) { posW[i] = vec4f(0.0); return; }
  let tick = atomicLoad(&info[3]);
  let du = bitcast<f32>(atomicLoad(&info[8]));
  let p = posR[i]; let x = p.xy; let r = p.z;
  let bc = vec2i(bucket2(x));
  var push = vec2f(0.0); var nb = 0u;
  for (var dy = -1; dy <= 1; dy++) {
    let yy = bc.y + dy; if (yy < 0 || yy >= i32(prm.gh)) { continue; }
    for (var dx = -1; dx <= 1; dx++) {
      let xx = bc.x + dx; if (xx < 0 || xx >= i32(prm.gw)) { continue; }
      let bi = u32(yy) * prm.gw + u32(xx);
      let e = start[bi + 1u];
      for (var k = start[bi]; k < e; k++) {
        let j = items[k]; if (j == i) { continue; }
        let qj = posR[j]; let d = x - qj.xy; let d2 = dot(d, d); let md = r + qj.z;
        if (d2 < md * md && d2 > 1e-12) { let dl = sqrt(d2); push += d * ((md - dl) * 0.5 / dl); nb++; }
      }
    }
  }
  var spring = vec2f(0.0); var nbond = 0u;
  for (var s = 0; s < 4; s++) {
    let j = c.bonds[s]; if (j < 0) { continue; }
    let qj = posR[u32(j)];
    if (qj.z <= 0.0) { c.bonds[s] = -1; continue; }
    let d = qj.xy - x; let dl = max(length(d), 1e-6); let rest = r + qj.z;
    if (dl > 4.0 * rest) { c.bonds[s] = -1; continue; }
    spring += d / dl * (dl - rest) * 0.3; nbond++;
  }
  let mk = mIdx(x);
  let en = env[mk];
  let L = lightAt(x);
  let gr = vec2f(lightAt(x + vec2f(8.0, 0.0)) - lightAt(x - vec2f(8.0, 0.0)), lightAt(x + vec2f(0.0, 8.0)) - lightAt(x - vec2f(0.0, 8.0)));
  let sg = vec4f(clamp(L, 0.0, 2.0), c.e, f32(nb) / 8.0, f32(nbond) / 4.0);
  let o = i * NG;
  let b0 = genes[o]; let b1 = genes[o + 1u];
  let eff = clamp(0.5 + b0.x + dot(genes[o + 4u], sg), 0.0, 1.0);
  let swim = clamp(b0.y + dot(genes[o + 5u], sg), 0.0, 1.0);
  let photo = clamp(b0.z + dot(genes[o + 6u], sg), -1.0, 1.0);
  let divS = 1.5 + clamp(b0.w + dot(genes[o + 7u], sg), 0.0, 1.5);
  let life = 300.0 + 300.0 * clamp(b1.x + dot(genes[o + 8u], sg), 0.0, 1.0);
  let sticky = clamp(b1.y + dot(genes[o + 9u], sg), 0.0, 1.0);
  let hue = b1.z;
  let h = pcg(i * 9781u + tick * 6271u);
  let nz = vec2f(f32(h & 0xffffu), f32(h >> 16u)) / 65535.0 - 0.5;
  // Плавание (2 мм/с при 1, за ход 0,5 с) — наугад и к свету, сквозь сопротивление среды; снос — течения мира за 5 шагов,
  // у дна — доля prm.pad1 (упрощение лаборатории: клетка лежит в пограничном слое).
  let gl = length(gr);
  var dir = nz * 2.0;
  if (gl > 1e-4) { dir = dir * (1.0 - abs(photo)) + photo * gr / gl; }
  let v = push * prm.push + spring * 0.3 + flowAt(x, du) * STEPS * bitcast<f32>(prm.pad1) + dir * swim / max(en.y, 0.05);
  var q = clamp(x + v, vec2f(0.5), vec2f(prm.width - 0.5, prm.height - 0.5));
  if (!inside(q)) { q = x; }
  c.vel = v;
  let dry = select(0.0, 0.01, en.z > 1.5);
  c.e = min(c.e + L * eff * 0.06 - 0.004 * c.m - 0.003 * swim - dry, 2.0);
  c.age += 1.0;
  let fi = mIdx(q);
  if (c.e > 0.6 && c.m < 3.4) {
    if (takeQuantum(fi)) { c.mn += 1u; c.m += 0.03; c.e -= 0.04; atomicAdd(&info[10], 1u); }
    // Упрощение лаборатории (prm.pad0 = 1): без минерала клетка растёт из одного света, вдвое медленнее.
    else if (prm.pad0 == 1u) { c.m += 0.015; c.e -= 0.04; }
  }
  if (c.e <= 0.0 || c.age > life) {
    giveQuanta(fi, c.mn); c.m = 0.0;
    atomicSub(&info[2], 1u); atomicAdd(&info[5], 1u);
    cells[i] = c; posW[i] = vec4f(q, 0.0, hue);
    return;
  }
  if (c.m > divS && c.e > 0.4 && atomicLoad(&info[2]) < prm.popCap) {
    if (atomicAdd(&info[2], 1u) < prm.popCap) {
      let k = atomicAdd(&info[1], 1u); let s = slots + k;
      if (s < prm.slotCap) {
        c.m *= 0.5; c.e *= 0.5;
        var d = c; d.age = 0.0; d.vel = vec2f(0.0); d.bonds = vec4i(-1); d.mn = c.mn / 2u; c.mn -= d.mn;
        let ang = rnd(h, 7u) * 6.2831853; let off = vec2f(cos(ang), sin(ang)) * radius(c.m) * 0.6;
        if (rnd(h, 11u) < sticky) {
          for (var f = 0; f < 4; f++) { if (c.bonds[f] < 0) { c.bonds[f] = i32(s); d.bonds.x = i32(i); break; } }
        }
        for (var gk = 0u; gk < NG; gk++) {
          let rs = vec4f(rnd(h, 100u + gk), rnd(h, 200u + gk), rnd(h, 300u + gk), rnd(h, 400u + gk));
          let rv = vec4f(rnd(h, 500u + gk), rnd(h, 600u + gk), rnd(h, 700u + gk), rnd(h, 800u + gk));
          genes[s * NG + gk] = genes[o + gk] + select(vec4f(0.0), (rv - 0.5) * 0.2, rs < vec4f(0.02));
        }
        var qd = q - off; if (!inside(qd)) { qd = q; }
        var qm = q + off; if (inside(qm)) { q = qm; }
        cells[s] = d; posW[s] = vec4f(qd, radius(d.m), hue);
        atomicAdd(&info[4], 1u);
      } else { atomicSub(&info[2], 1u); atomicAdd(&info[7], 1u); }
    } else { atomicSub(&info[2], 1u); atomicAdd(&info[7], 1u); }
  }
  cells[i] = c; posW[i] = vec4f(q, radius(c.m), hue);
}
@compute @workgroup_size(1) fn finalize() {
  let births = atomicExchange(&info[1], 0u);
  let slots = min(atomicLoad(&info[0]) + births, prm.slotCap);
  atomicStore(&info[0], slots); atomicAdd(&info[3], 1u);
  args[0] = (slots + 255u) / 256u; args[1] = 1u; args[2] = 1u;
  args[8] = 6u; args[9] = slots; args[10] = 0u; args[11] = 0u;
}

// ---- уплотнение: живые клетки по порядку корзин, связи по новым номерам ----
@compute @workgroup_size(256) fn clearIndex(@builtin(global_invocation_id) g: vec3u) {
  if (g.x < atomicLoad(&info[0])) { newIndex[g.x] = 0xffffffffu; }
}
@compute @workgroup_size(256) fn indexCells(@builtin(global_invocation_id) g: vec3u) {
  if (g.x < atomicLoad(&info[6])) { newIndex[items[g.x]] = g.x; }
}
@compute @workgroup_size(256) fn gather(@builtin(global_invocation_id) g: vec3u) {
  let d = g.x; if (d >= atomicLoad(&info[6])) { return; }
  let j = items[d];
  var c = cells[j];
  for (var s = 0; s < 4; s++) {
    let b = c.bonds[s];
    if (b >= 0) { let ni = newIndex[u32(b)]; c.bonds[s] = select(-1, i32(ni), ni != 0xffffffffu); }
  }
  cellsDst[d] = c; posDst[d] = posR[j];
  for (var k = 0u; k < NG; k++) { genesDst[d * NG + k] = genes[j * NG + k]; }
}
@compute @workgroup_size(1) fn finalizeCompact() {
  let n = atomicLoad(&info[6]);
  atomicStore(&info[0], n);
  args[0] = (n + 255u) / 256u; args[1] = 1u; args[2] = 1u; args[9] = n;
}

// ---- минерал: новый вид поля мира + изменения жизни, ещё не сданные миру ----
@compute @workgroup_size(256) fn applyView(@builtin(global_invocation_id) g: vec3u) {
  let k = g.x; let n = prm.mcols * prm.mrows; if (k >= n) { return; }
  let v = i32(viewQ[k]) + bitcast<i32>(atomicLoad(&mq[n + k]));
  if (v < 0) { atomicAdd(&info[9], u32(-v)); }
  atomicStore(&mq[k], u32(max(v, 0)));
}
`;

export const RENDER_WGSL = COMMON + /* wgsl */`
@group(0) @binding(0) var<uniform> prm: Prm;
@group(0) @binding(1) var<storage, read> pos: array<vec4f>;
@group(0) @binding(2) var<storage, read> env: array<vec4f>;
struct VO { @builtin(position) p: vec4f, @location(0) uv: vec2f, @location(1) col: vec3f };
fn clip(w: vec2f) -> vec4f { return vec4f(w.x / prm.width * 2.0 - 1.0, 1.0 - w.y / prm.height * 2.0, 0.0, 1.0); }

@vertex fn bgVs(@builtin(vertex_index) vi: u32) -> VO {
  var t = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VO; o.p = vec4f(t[vi], 0.0, 1.0);
  o.uv = vec2f((t[vi].x + 1.0) * 0.5 * prm.width, (1.0 - t[vi].y) * 0.5 * prm.height); o.col = vec3f(0.0);
  return o;
}
@fragment fn bgFs(v: VO) -> @location(0) vec4f {
  let i = min(u32(max(v.uv.x, 0.0) / prm.mcell), prm.mcols - 1u); let j = min(u32(max(v.uv.y, 0.0) / prm.mcell), prm.mrows - 1u);
  let e = env[j * prm.mcols + i];
  if (e.z < 0.0) { return vec4f(0.08, 0.08, 0.09, 1.0); }
  let water = vec3f(0.05, 0.13, 0.2); let shallow = vec3f(0.12, 0.2, 0.22); let land = vec3f(0.22, 0.2, 0.15);
  let base = select(mix(water, shallow, e.z), mix(shallow, land, e.z - 1.0), e.z > 1.0);
  return vec4f(base * (0.45 + 0.55 * clamp(e.w, 0.0, 1.5)), 1.0);
}

@vertex fn cellVs(@builtin(vertex_index) vi: u32, @builtin(instance_index) i: u32) -> VO {
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let c = pos[i]; let uv = corners[vi]; var o: VO; o.uv = uv;
  if (c.z <= 0.0) { o.p = vec4f(2.0, 2.0, 2.0, 1.0); o.col = vec3f(0.0); return o; }
  o.p = clip(c.xy + uv * max(c.z, prm.width / 1600.0));
  o.col = 0.6 + 0.4 * cos(6.2831853 * (c.w + vec3f(0.0, 0.33, 0.67)));
  return o;
}
@fragment fn cellFs(v: VO) -> @location(0) vec4f { if (dot(v.uv, v.uv) > 1.0) { discard; } return vec4f(v.col, 1.0); }
`;
