/// <reference types="@webgpu/types" />
/**
 * Этап 5 плана (docs/plan/world-gpu-engine.md): поле течений от света на видеокарте —
 * то же, что `computeDriftFieldTask` ядра (src/core/drift.ts):
 * растр пятен → свет места и средний свет отсека → увлечение на гранях → источник →
 * давление (сопряжённые градиенты с многосеточным V-циклом, как `solve`) → поток через
 * грани → скорость в клетке.
 *
 * Решатель — из замера 5 (src/bench/drift.ts, docs/gpu-bench.md): шахматное сглаживание,
 * слитые проходы, самая грубая сетка — матрицей оператора ядра (40 симметричных проходов
 * Гаусса — Зейделя с нуля); матрица строится здесь же, на видеокарте, при смене местности.
 * Суммы и остановка — на видеокарте; шагов даётся столько, сколько было в прошлый раз, с
 * запасом, и если не сошлось — досчитывается следующей отправкой.
 */
import { DRIFT_COARSEST_SWEEPS, DRIFT_MAX, DRIFT_MAX_ITERATIONS, DRIFT_PERIOD, DRIFT_TOLERANCE, MAX_SPOTS, SPOT_EDGE, SPOT_REACH, type DriftField, type DriftStage, type Level } from '../core/index.ts';

const MAX_LEVELS = 8;
/** С какого уровня грубые считаются одной группой (замер 5: уровни от 50×38). */
const LOW = 2;

const SOLVER = /* wgsl */`
struct U { lev: array<vec4u, ${MAX_LEVELS}>, d: u32, color: u32, count: u32, pad: u32 };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> faces: array<vec4f>;   // запад, восток, север, юг
@group(0) @binding(2) var<storage, read> inv: array<f32>;
@group(0) @binding(3) var<storage, read_write> X: array<f32>;
@group(0) @binding(4) var<storage, read_write> B: array<f32>;
@group(0) @binding(5) var<storage, read_write> P: array<f32>;
@group(0) @binding(6) var<storage, read_write> Rv: array<f32>;
@group(0) @binding(7) var<storage, read_write> D: array<f32>;
@group(0) @binding(8) var<storage, read_write> Q: array<f32>;
// scal: 0 rz, 1 dq, 2 rr, 3 стоп, 4 идёт (1/0), 5 alpha, 6 beta, 7 шагов
@group(0) @binding(9) var<storage, read_write> scal: array<f32>;
@group(0) @binding(10) var<storage, read> src: array<f32>;
@group(0) @binding(11) var<storage, read> M: array<f32>;
@group(0) @binding(12) var<storage, read_write> Mw: array<f32>;

fn nb(L: vec4u, k: u32) -> vec4u {
  let i = k % L.x; let o = L.z;
  return vec4u(select(k, k - 1u, i > 0u), select(k, k + 1u, i + 1u < L.x), select(k, k - L.x, k >= L.x), select(k, k + L.x, k + L.x < L.w)) + vec4u(o);
}
fn colorOf(L: vec4u, k: u32) -> u32 { return ((k % L.x) + (k / L.x)) & 1u; }
fn relax(L: vec4u, k: u32) {
  let o = L.z + k; let f = faces[o]; let m = nb(L, k);
  X[o] = (B[o] + f.x * X[m.x] + f.y * X[m.y] + f.z * X[m.z] + f.w * X[m.w]) * inv[o];
}
fn res(L: vec4u, k: u32) -> f32 {
  let o = L.z + k; let f = faces[o]; let m = nb(L, k);
  return B[o] - ((f.x + f.y + f.z + f.w) * X[o] - f.x * X[m.x] - f.y * X[m.y] - f.z * X[m.z] - f.w * X[m.w]);
}
fn restrictCell(F: vec4u, C: vec4u, K: u32) {
  let I = K % C.x; let J = K / C.x; var s = 0.0;
  for (var b = 0u; b < 2u; b++) { for (var a = 0u; a < 2u; a++) {
    let i = 2u * I + a; let j = 2u * J + b;
    if (i < F.x && j < F.y) { s += res(F, j * F.x + i); }
  } }
  B[C.z + K] = s;
}
fn prolongCell(F: vec4u, C: vec4u, k: u32) {
  if (inv[F.z + k] == 0.0) { return; }
  let i = k % F.x; let j = k / F.x;
  X[F.z + k] += X[C.z + (j >> 1u) * C.x + (i >> 1u)];
}
fn running() -> bool { return scal[4] != 0.0; }

@compute @workgroup_size(256) fn sweepFirst(@builtin(global_invocation_id) g: vec3u) {
  let L = u.lev[u.d]; let k = g.x; if (k >= L.w || !running()) { return; }
  X[L.z + k] = select(0.0, B[L.z + k] * inv[L.z + k], colorOf(L, k) == 0u);
}
@compute @workgroup_size(256) fn sweep(@builtin(global_invocation_id) g: vec3u) {
  let L = u.lev[u.d]; let k = g.x; if (k >= L.w || !running() || colorOf(L, k) != u.color || inv[L.z + k] == 0.0) { return; }
  relax(L, k);
}
@compute @workgroup_size(256) fn restrictTo(@builtin(global_invocation_id) g: vec3u) {
  let F = u.lev[u.d]; let C = u.lev[u.d + 1u]; if (g.x >= C.w || !running()) { return; }
  restrictCell(F, C, g.x);
}
@compute @workgroup_size(256) fn prolong(@builtin(global_invocation_id) g: vec3u) {
  let F = u.lev[u.d]; let C = u.lev[u.d + 1u]; if (g.x >= F.w || !running()) { return; }
  prolongCell(F, C, g.x);
}

var<workgroup> act: u32;
fn sync() { storageBarrier(); workgroupBarrier(); }
fn halfSweep(L: vec4u, c: u32, t: u32) {
  for (var k = t; k < L.w; k += 1024u) { if (colorOf(L, k) == c && inv[L.z + k] != 0.0) { relax(L, k); } }
  sync();
}
@compute @workgroup_size(1024) fn vdown(@builtin(local_invocation_id) l: vec3u) {
  if (l.x == 0u) { act = select(0u, 1u, running()); }
  if (workgroupUniformLoad(&act) == 0u) { return; }
  let t = l.x; let last = u.count - 1u;
  for (var d = u.d; d < last; d++) {
    let L = u.lev[d];
    for (var k = t; k < L.w; k += 1024u) { X[L.z + k] = select(0.0, B[L.z + k] * inv[L.z + k], colorOf(L, k) == 0u); }
    sync();
    halfSweep(L, 1u, t);
    let C = u.lev[d + 1u];
    for (var K = t; K < C.w; K += 1024u) { restrictCell(L, C, K); }
    sync();
  }
}
var<workgroup> row: array<f32, 128>;
@compute @workgroup_size(128) fn coarse(@builtin(workgroup_id) w: vec3u, @builtin(local_invocation_id) l: vec3u) {
  let Z = u.lev[u.count - 1u]; let i = w.x;
  var s = 0.0;
  for (var j = l.x; j < Z.w; j += 128u) { s += M[i * Z.w + j] * B[Z.z + j]; }
  row[l.x] = s; workgroupBarrier();
  for (var o = 64u; o > 0u; o >>= 1u) { if (l.x < o) { row[l.x] += row[l.x + o]; } workgroupBarrier(); }
  if (l.x == 0u && running()) { X[Z.z + i] = row[0]; }
}
@compute @workgroup_size(1024) fn vup(@builtin(local_invocation_id) l: vec3u) {
  if (l.x == 0u) { act = select(0u, 1u, running()); }
  if (workgroupUniformLoad(&act) == 0u) { return; }
  let t = l.x; let last = u.count - 1u;
  for (var d = last; d > u.d; d--) {
    let F = u.lev[d - 1u]; let C = u.lev[d];
    for (var k = t; k < F.w; k += 1024u) { prolongCell(F, C, k); }
    sync();
    halfSweep(F, 1u, t);
    halfSweep(F, 0u, t);
  }
}
// Матрица самой грубой сетки: столбец j — проходы ядра (построчный Гаусс — Зейдель, вперёд и назад) с нуля для b = e_j.
// Цепочка из 80 × n зависимых шагов на столбец (~47 мс на 25×19); строится при смене местности.
fn gsM(Z: vec4u, k: u32, j: u32) {
  let o = Z.z + k; let iv = inv[o]; if (iv == 0.0) { return; }
  let f = faces[o]; let i = k % Z.x; let n = Z.w;
  var s = select(0.0, 1.0, k == j);
  if (i > 0u) { s += f.x * Mw[(k - 1u) * n + j]; }
  if (i + 1u < Z.x) { s += f.y * Mw[(k + 1u) * n + j]; }
  if (k >= Z.x) { s += f.z * Mw[(k - Z.x) * n + j]; }
  if (k + Z.x < n) { s += f.w * Mw[(k + Z.x) * n + j]; }
  Mw[k * n + j] = s * iv;
}
@compute @workgroup_size(64) fn buildCoarse(@builtin(global_invocation_id) g: vec3u) {
  let Z = u.lev[u.count - 1u]; let j = g.x; if (j >= Z.w) { return; }
  let n = Z.w;
  for (var k = 0u; k < n; k++) { Mw[k * n + j] = 0.0; }
  for (var s = 0u; s < ${DRIFT_COARSEST_SWEEPS}u; s++) {
    for (var k = 0u; k < n; k++) { gsM(Z, k, j); }
    for (var k = n; k > 0u; k--) { gsM(Z, k - 1u, j); }
  }
}

@compute @workgroup_size(256) fn cgInit(@builtin(global_invocation_id) g: vec3u) {
  let k = g.x; if (k >= u.lev[0].w) { return; }
  let r = select(0.0, src[k], inv[k] != 0.0);
  Rv[k] = r; B[k] = r; P[k] = 0.0;
}
@compute @workgroup_size(256) fn zToD(@builtin(global_invocation_id) g: vec3u) { if (g.x < u.lev[0].w) { D[g.x] = X[g.x]; } }
@compute @workgroup_size(256) fn applyD(@builtin(global_invocation_id) g: vec3u) {
  let L = u.lev[0]; let k = g.x; if (k >= L.w || !running()) { return; }
  let f = faces[k]; let m = nb(L, k);
  Q[k] = (f.x + f.y + f.z + f.w) * D[k] - f.x * D[m.x] - f.y * D[m.y] - f.z * D[m.z] - f.w * D[m.w];
}
@compute @workgroup_size(256) fn updatePR(@builtin(global_invocation_id) g: vec3u) {
  let k = g.x; if (k >= u.lev[0].w || !running()) { return; }
  let a = scal[5]; P[k] += a * D[k]; let r = Rv[k] - a * Q[k]; Rv[k] = r; B[k] = r;
}
@compute @workgroup_size(256) fn updateD(@builtin(global_invocation_id) g: vec3u) {
  let k = g.x; if (k >= u.lev[0].w || !running()) { return; }
  D[k] = X[k] + scal[6] * D[k];
}
var<workgroup> sh: array<f32, 1024>;
fn reduce(t: u32, v: f32) -> f32 {
  sh[t] = v; workgroupBarrier();
  for (var o = 512u; o > 0u; o >>= 1u) { if (t < o) { sh[t] += sh[t + o]; } workgroupBarrier(); }
  return sh[0];
}
fn dotRR(t: u32) -> f32 { var v = 0.0; for (var k = t; k < u.lev[0].w; k += 1024u) { v += Rv[k] * Rv[k]; } return reduce(t, v); }
fn dotDQ(t: u32) -> f32 { var v = 0.0; for (var k = t; k < u.lev[0].w; k += 1024u) { v += D[k] * Q[k]; } return reduce(t, v); }
fn dotRZ(t: u32) -> f32 { var v = 0.0; for (var k = t; k < u.lev[0].w; k += 1024u) { v += Rv[k] * X[k]; } return reduce(t, v); }
@compute @workgroup_size(1024) fn stopInit(@builtin(local_invocation_id) l: vec3u) {
  let s = dotRR(l.x); if (l.x == 0u) { scal[3] = ${DRIFT_TOLERANCE} * sqrt(s); scal[4] = 1.0; scal[7] = 0.0; }
}
@compute @workgroup_size(1024) fn rzInit(@builtin(local_invocation_id) l: vec3u) {
  let s = dotRZ(l.x); if (l.x == 0u) { scal[0] = s; }
}
@compute @workgroup_size(1024) fn rrCheck(@builtin(local_invocation_id) l: vec3u) {
  let s = dotRR(l.x);
  if (l.x == 0u && scal[4] != 0.0) { scal[2] = s; if (sqrt(s) <= scal[3] || scal[7] >= ${DRIFT_MAX_ITERATIONS}.0) { scal[4] = 0.0; } else { scal[7] += 1.0; } }
}
@compute @workgroup_size(1024) fn dq(@builtin(local_invocation_id) l: vec3u) {
  let s = dotDQ(l.x); if (l.x == 0u && scal[4] != 0.0) { scal[1] = s; scal[5] = scal[0] / s; }
}
@compute @workgroup_size(1024) fn rzNext(@builtin(local_invocation_id) l: vec3u) {
  let s = dotRZ(l.x); if (l.x == 0u && scal[4] != 0.0) { scal[6] = s / scal[0]; scal[0] = s; }
}
`;

const FIELD = /* wgsl */`
struct V {
  cols: u32, rows: u32, n: u32, spots: u32,
  cell: f32, sun: f32, bg: f32, response: f32,
  pull: f32, svx: f32, svy: f32, maxV: f32,
  planeW: f32, planeH: f32, p0: f32, p1: f32,
};
@group(0) @binding(0) var<uniform> v: V;
@group(0) @binding(1) var<storage, read> spots: array<vec4f>;    // пятна, гармоники, фазы — по ${MAX_SPOTS}
@group(0) @binding(2) var<storage, read> mask: array<u32>;       // 1 — преграда
@group(0) @binding(3) var<storage, read> region: array<i32>;
@group(0) @binding(4) var<storage, read_write> regionSum: array<atomic<u32>>; // свет отсека, доли 2^-24, пара u32
@group(0) @binding(5) var<storage, read> regionCount: array<f32>;
@group(0) @binding(6) var<storage, read_write> intensity: array<f32>;
@group(0) @binding(7) var<storage, read_write> light: array<f32>;
@group(0) @binding(8) var<storage, read_write> fE: array<f32>;
@group(0) @binding(9) var<storage, read_write> fS: array<f32>;
@group(0) @binding(10) var<storage, read_write> src: array<f32>;
@group(0) @binding(11) var<storage, read> faces: array<vec4f>;   // тонкий уровень: запад, восток, север, юг
@group(0) @binding(12) var<storage, read> P: array<f32>;
@group(0) @binding(13) var<storage, read_write> vel: array<vec2f>;

fn blocked(k: u32) -> bool { return mask[k] != 0u; }
// Вклад пятен (как spotProfile / LIGHT_FIELD_GLSL ядра).
fn spotField(w: vec2f) -> f32 {
  var sum = 0.0;
  let plane = vec2f(v.planeW, v.planeH);
  for (var i = 0u; i < v.spots; i++) {
    let s = spots[i];
    var d = w - s.xy;
    d -= plane * floor(d / plane + 0.5);
    let r = length(d); let e = ${SPOT_EDGE.toFixed(3)} * s.z;
    if (r > s.z * ${SPOT_REACH.toFixed(3)} + e) { continue; }
    let th = atan2(d.y, d.x);
    let a = spots[${MAX_SPOTS}u + i]; let p = spots[${2 * MAX_SPOTS}u + i];
    let rr = 1.0 + a.x * cos(2.0 * th + p.x) + a.y * cos(3.0 * th + p.y) + a.z * cos(4.0 * th + p.z) + a.w * cos(5.0 * th + p.w);
    sum += smoothstep(0.0, 1.0, (s.z * rr * s.w + e * 0.5 - r) / e);
  }
  return sum;
}
fn pullX(k: u32) -> f32 { if (blocked(k) || intensity[k] <= 0.0) { return 0.0; } return v.pull * intensity[k] * v.svx; }
fn pullY(k: u32) -> f32 { if (blocked(k) || intensity[k] <= 0.0) { return 0.0; } return v.pull * intensity[k] * v.svy; }

// Свет места и сумма света отсека.
@compute @workgroup_size(64) fn raster(@builtin(global_invocation_id) g: vec3u) {
  let k = g.x; if (k >= v.n) { return; }
  let w = vec2f(f32(k % v.cols) + 0.5, f32(k / v.cols) + 0.5) * v.cell;
  let I = spotField(w);
  intensity[k] = I;
  if (blocked(k)) { light[k] = 0.0; return; }
  let L = v.sun * (v.bg + (1.0 - v.bg) * I);
  light[k] = L;
  let q = floor(L * 16777216.0 + 0.5);
  let hi = floor(q / 4294967296.0);
  let lo = u32(q - hi * 4294967296.0);
  let r = u32(region[k]);
  let old = atomicAdd(&regionSum[2u * r], lo);
  atomicAdd(&regionSum[2u * r + 1u], u32(hi) + select(0u, 1u, old + lo < old));
}
// Увлечение на гранях — среднее двух клеток (грань закрыта — 0).
@compute @workgroup_size(64) fn drag(@builtin(global_invocation_id) g: vec3u) {
  let k = g.x; if (k >= v.n) { return; }
  let f = faces[k];
  fE[k] = select(0.0, (pullX(k) + pullX(k + 1u)) / 2.0, f.y != 0.0);
  fS[k] = select(0.0, (pullY(k) + pullY(k + v.cols)) / 2.0, f.w != 0.0);
}
// Источник: отклонение света от среднего по отсеку минус вынос увлечением.
@compute @workgroup_size(64) fn source(@builtin(global_invocation_id) g: vec3u) {
  let k = g.x; if (k >= v.n) { return; }
  if (blocked(k)) { src[k] = 0.0; return; }
  let r = u32(region[k]);
  let mean = (f32(atomicLoad(&regionSum[2u * r + 1u])) * 4294967296.0 + f32(atomicLoad(&regionSum[2u * r]))) / 16777216.0 / regionCount[r];
  let f = faces[k];
  var s = light[k] - mean - f.y * fE[k] - f.w * fS[k];
  if (k % v.cols > 0u) { s += f.x * fE[k - 1u]; }
  if (k >= v.cols) { s += f.z * fS[k - v.cols]; }
  src[k] = s;
}
// Скорость в клетке — среднее потоков через её грани (давление + увлечение), не больше DRIFT_MAX.
@compute @workgroup_size(64) fn flux(@builtin(global_invocation_id) g: vec3u) {
  let k = g.x; if (k >= v.n) { return; }
  if (blocked(k)) { vel[k] = vec2f(0.0); return; }
  let cols = v.cols; let i = k % cols; let j = k / cols; let f = faces[k];
  var fw = 0.0; var fe = 0.0; var fn_ = 0.0; var fs = 0.0;
  if (i > 0u) { fw = f.x * (P[k - 1u] - P[k] + fE[k - 1u]); }
  if (i + 1u < cols) { fe = f.y * (P[k] - P[k + 1u] + fE[k]); }
  if (j > 0u) { fn_ = f.z * (P[k - cols] - P[k] + fS[k - cols]); }
  if (j + 1u < v.rows) { fs = f.w * (P[k] - P[k + cols] + fS[k]); }
  var x = v.response * (fw + fe) / 2.0; var y = v.response * (fn_ + fs) / 2.0;
  let s = sqrt(x * x + y * y);
  if (s > v.maxV) { x *= v.maxV / s; y *= v.maxV / s; }
  vel[k] = vec2f(x, y);
}
`;

const SOLVER_USE = {
  sweepFirst: [0, 2, 3, 4, 9], sweep: [0, 1, 2, 3, 4, 9], restrictTo: [0, 1, 3, 4, 9], prolong: [0, 2, 3, 9],
  vdown: [0, 1, 2, 3, 4, 9], coarse: [0, 3, 4, 9, 11], vup: [0, 1, 2, 3, 4, 9], buildCoarse: [0, 1, 2, 12],
  cgInit: [0, 2, 4, 5, 6, 10], zToD: [0, 3, 7], applyD: [0, 1, 7, 8, 9], updatePR: [0, 4, 5, 6, 7, 8, 9], updateD: [0, 3, 7, 9],
  stopInit: [0, 6, 9], rzInit: [0, 3, 6, 9], rrCheck: [0, 6, 9], dq: [0, 7, 8, 9], rzNext: [0, 3, 6, 9],
} as const;
const FIELD_USE = {
  raster: [0, 1, 2, 3, 4, 6, 7], drag: [0, 2, 6, 8, 9, 11], source: [0, 2, 3, 4, 5, 7, 8, 9, 10, 11], flux: [0, 2, 8, 9, 11, 12, 13],
} as const;
type SolverName = keyof typeof SOLVER_USE;
type FieldName = keyof typeof FIELD_USE;

export interface DriftRun {
  field: DriftField;
  /** Шагов сопряжённых градиентов; отправок (больше одной — не сошлось с первого раза). */
  iterations: number;
  submits: number;
  ms: number;
  /** Матрица самой грубой сетки строилась (сменилась местность), мс работы видеокарты вместе с полем. */
  rebuilt: boolean;
}

export class GpuDrift {
  private readonly device: GPUDevice;
  private readonly solver: Record<SolverName, GPUComputePipeline>;
  private readonly fieldPipes: Record<FieldName, GPUComputePipeline>;
  private fine: Level | null = null;
  private levels: readonly Level[] = [];
  private offs: number[] = [];
  private buf: Record<string, GPUBuffer> = {};
  private uni: GPUBuffer[][] = [];
  private groups = new Map<string, GPUBindGroup>();
  private regions = 0;
  /** Шагов в прошлом решении — с запасом даётся столько же. */
  private lastIterations = 20;
  /** Узлы течений на видеокарте по номеру узла (скорость клетки, vec2f): для суммы течений без загрузки. */
  private readonly nodes = new Map<number, { field: DriftField; buf: GPUBuffer }>();

  /** Буфер узла `k` с полем `field`: свой, если считался здесь, иначе загружается из CPU-поля. */
  nodeBuffer(k: number, field: DriftField): GPUBuffer {
    const hit = this.nodes.get(k);
    if (hit && hit.field === field) {
      // Порядок в Map — давность обращения: свежий узел — в конец.
      this.nodes.delete(k); this.nodes.set(k, hit);
      return hit.buf;
    }
    const n = field.vx.length, data = new Float32Array(n * 2);
    for (let q = 0; q < n; q++) { data[2 * q] = field.vx[q]; data[2 * q + 1] = field.vy[q]; }
    const buf = this.keepNode(k, field, n);
    this.device.queue.writeBuffer(buf, 0, data);
    return buf;
  }

  private keepNode(k: number, field: DriftField, n: number): GPUBuffer {
    const old = this.nodes.get(k);
    if (old) { old.buf.destroy(); this.nodes.delete(k); }
    const buf = this.device.createBuffer({ label: `узел течений ${k}`, size: n * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    // Держим четыре узла: нужны k и k + 1, остальное — запас на переход. Выбрасываем давно не нужный.
    while (this.nodes.size >= 4) {
      const [oldest, entry] = this.nodes.entries().next().value!;
      entry.buf.destroy(); this.nodes.delete(oldest);
    }
    this.nodes.set(k, { field, buf });
    return buf;
  }

  constructor(device: GPUDevice) {
    this.device = device;
    const sm = device.createShaderModule({ code: SOLVER }), fm = device.createShaderModule({ code: FIELD });
    this.solver = Object.fromEntries((Object.keys(SOLVER_USE) as SolverName[]).map((e) => [e, device.createComputePipeline({ layout: 'auto', compute: { module: sm, entryPoint: e } })])) as Record<SolverName, GPUComputePipeline>;
    this.fieldPipes = Object.fromEntries((Object.keys(FIELD_USE) as FieldName[]).map((e) => [e, device.createComputePipeline({ layout: 'auto', compute: { module: fm, entryPoint: e } })])) as Record<FieldName, GPUComputePipeline>;
  }

  /** Неизменное до смены местности: уровни решателя, преграды, отсеки, матрица самой грубой сетки. */
  private ensureGround(s: DriftStage, enc: GPUCommandEncoder): boolean {
    if (this.fine === s.levels[0]) return false;
    const d = this.device;
    for (const b of Object.values(this.buf)) b.destroy();
    for (const row of this.uni) for (const b of row) b.destroy();
    this.groups.clear();
    const levels = s.levels;
    const last = levels[levels.length - 1];
    if (levels.length > MAX_LEVELS || last.cols * last.rows > 4096) throw Error('течения: сетка решателя не помещается');
    this.offs = []; let total = 0;
    for (const l of levels) { this.offs.push(total); total += l.cols * l.rows; }
    const faces = new Float32Array(total * 4), inv = new Float32Array(total);
    levels.forEach((l, e) => {
      for (let k = 0; k < l.cols * l.rows; k++) {
        faces.set([l.west[k], l.east[k], l.north[k], l.south[k]], (this.offs[e] + k) * 4);
        inv[this.offs[e] + k] = l.inverse[k];
      }
    });
    const n = s.cols * s.rows, nz = last.cols * last.rows;
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const mk = (bytes: number, usage = S) => d.createBuffer({ size: Math.max(16, Math.ceil(bytes / 16) * 16), usage });
    const up = (data: ArrayBufferView & { byteLength: number; buffer: ArrayBufferLike }) => { const b = mk(data.byteLength); d.queue.writeBuffer(b, 0, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength); return b; };
    const count = new Float32Array(s.regions), mask = new Uint32Array(n);
    for (let k = 0; k < n; k++) { mask[k] = s.blocked[k]; if (!s.blocked[k]) count[s.region[k]]++; }
    this.buf = {
      faces: up(faces), inv: up(inv), X: mk(total * 4), B: mk(total * 4), P: mk(n * 4), Rv: mk(n * 4), D: mk(n * 4), Q: mk(n * 4),
      scal: mk(64), src: mk(n * 4), M: mk(nz * nz * 4),
      fieldU: mk(64, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST), spots: mk(3 * MAX_SPOTS * 16), mask: up(mask), region: up(Int32Array.from(s.region)),
      regionSum: mk(s.regions * 8), regionCount: up(count), intensity: mk(n * 4), light: mk(n * 4), fE: mk(n * 4), fS: mk(n * 4), vel: mk(n * 8),
      read: mk(n * 8 + 32, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST),
    };
    this.uni = levels.map((_, e) => [0, 1].map((color) => {
      const a = new Uint32Array(MAX_LEVELS * 4 + 4);
      levels.forEach((l, f) => a.set([l.cols, l.rows, this.offs[f], l.cols * l.rows], f * 4));
      a.set([e, color, levels.length, 0], MAX_LEVELS * 4);
      const b = mk(a.byteLength, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      d.queue.writeBuffer(b, 0, a);
      return b;
    }));
    this.fine = levels[0]; this.levels = levels; this.regions = s.regions;
    // Матрица самой грубой сетки — заново при смене местности.
    const p = enc.beginComputePass();
    this.run(p, 'buildCoarse', Math.ceil(nz / 64), 0, 0);
    p.end();
    return true;
  }

  private group(name: SolverName, d: number, color: number): GPUBindGroup {
    const key = `${name}/${d}/${color}`;
    let g = this.groups.get(key);
    if (!g) {
      const order = [null, 'faces', 'inv', 'X', 'B', 'P', 'Rv', 'D', 'Q', 'scal', 'src', 'M', 'M'] as const;
      g = this.device.createBindGroup({ layout: this.solver[name].getBindGroupLayout(0), entries: SOLVER_USE[name].map((b) => ({ binding: b, resource: { buffer: b === 0 ? this.uni[d][color] : this.buf[order[b]!] } })) });
      this.groups.set(key, g);
    }
    return g;
  }

  private fieldGroup(name: FieldName): GPUBindGroup {
    const key = `field/${name}`;
    let g = this.groups.get(key);
    if (!g) {
      const order = ['fieldU', 'spots', 'mask', 'region', 'regionSum', 'regionCount', 'intensity', 'light', 'fE', 'fS', 'src', 'faces', 'P', 'vel'] as const;
      g = this.device.createBindGroup({ layout: this.fieldPipes[name].getBindGroupLayout(0), entries: FIELD_USE[name].map((b) => ({ binding: b, resource: { buffer: this.buf[order[b]] } })) });
      this.groups.set(key, g);
    }
    return g;
  }

  private run(pass: GPUComputePassEncoder, name: SolverName, count: number, d: number, color: number): void {
    pass.setPipeline(this.solver[name]); pass.setBindGroup(0, this.group(name, d, color)); pass.dispatchWorkgroups(count);
  }

  private fieldPass(pass: GPUComputePassEncoder, name: FieldName, cells: number): void {
    pass.setPipeline(this.fieldPipes[name]); pass.setBindGroup(0, this.fieldGroup(name)); pass.dispatchWorkgroups(Math.ceil(cells / 64));
  }

  private wg(d: number): number { const l = this.levels[d]; return Math.ceil(l.cols * l.rows / 256); }

  private vcycle(pass: GPUComputePassEncoder): void {
    const low = Math.min(LOW, this.levels.length - 1);
    const nz = this.levels[this.levels.length - 1].cols * this.levels[this.levels.length - 1].rows;
    const down = (d: number) => {
      if (d === low) { this.run(pass, 'vdown', 1, d, 0); this.run(pass, 'coarse', nz, d, 0); this.run(pass, 'vup', 1, d, 0); return; }
      this.run(pass, 'sweepFirst', this.wg(d), d, 0);
      this.run(pass, 'sweep', this.wg(d), d, 1);
      this.run(pass, 'restrictTo', this.wg(d + 1), d, 0);
      down(d + 1);
      this.run(pass, 'prolong', this.wg(d), d, 0);
      this.run(pass, 'sweep', this.wg(d), d, 1);
      this.run(pass, 'sweep', this.wg(d), d, 0);
    };
    down(0);
  }

  private iterations(pass: GPUComputePassEncoder, count: number): void {
    const W0 = this.wg(0);
    for (let it = 0; it < count; it++) {
      this.run(pass, 'rrCheck', 1, 0, 0);
      this.run(pass, 'applyD', W0, 0, 0); this.run(pass, 'dq', 1, 0, 0);
      this.run(pass, 'updatePR', W0, 0, 0);
      this.vcycle(pass);
      this.run(pass, 'rzNext', 1, 0, 0);
      this.run(pass, 'updateD', W0, 0, 0);
    }
  }

  private async finish(enc: GPUCommandEncoder, n: number): Promise<{ vel: Float32Array; scal: Float32Array }> {
    const p = enc.beginComputePass();
    this.fieldPass(p, 'flux', n);
    p.end();
    enc.copyBufferToBuffer(this.buf.vel, 0, this.buf.read, 0, n * 8);
    enc.copyBufferToBuffer(this.buf.scal, 0, this.buf.read, n * 8, 32);
    this.device.queue.submit([enc.finish()]);
    await this.buf.read.mapAsync(GPUMapMode.READ, 0, n * 8 + 32);
    const data = this.buf.read.getMappedRange(0, n * 8 + 32).slice(0);
    this.buf.read.unmap();
    return { vel: new Float32Array(data, 0, n * 2), scal: new Float32Array(data, n * 8, 8) };
  }

  /** Поле течений в шаге `s.t` — как `computeDriftFieldTask`. */
  async field(s: DriftStage): Promise<DriftRun> {
    const t0 = performance.now();
    const n = s.cols * s.rows, q = this.device.queue;
    this.device.pushErrorScope('validation');
    let enc = this.device.createCommandEncoder();
    const rebuilt = this.ensureGround(s, enc);
    const lu = s.light;
    const ub = new ArrayBuffer(64), u = new Uint32Array(ub), f = new Float32Array(ub);
    u.set([s.cols, s.rows, n, lu.count]);
    f.set([s.cell, s.sun, s.bg, s.response, s.pull, s.vx, s.vy, DRIFT_MAX, lu.plane[0], lu.plane[1], 0, 0], 4);
    q.writeBuffer(this.buf.fieldU, 0, ub);
    const spots = new Float32Array(3 * MAX_SPOTS * 4);
    spots.set(lu.spots, 0); spots.set(lu.amps, MAX_SPOTS * 4); spots.set(lu.phases, 2 * MAX_SPOTS * 4);
    q.writeBuffer(this.buf.spots, 0, spots);
    enc.clearBuffer(this.buf.regionSum);
    let pass = enc.beginComputePass();
    this.fieldPass(pass, 'raster', n);
    this.fieldPass(pass, 'drag', n);
    this.fieldPass(pass, 'source', n);
    const W0 = this.wg(0);
    this.run(pass, 'cgInit', W0, 0, 0);
    this.run(pass, 'stopInit', 1, 0, 0);
    this.vcycle(pass);
    this.run(pass, 'zToD', W0, 0, 0); this.run(pass, 'rzInit', 1, 0, 0);
    let issued = Math.min(DRIFT_MAX_ITERATIONS, this.lastIterations + 3);
    this.iterations(pass, issued);
    pass.end();
    let out = await this.finish(enc, n), submits = 1;
    const failure = await this.device.popErrorScope();
    if (failure) throw Error(`видеокарта отклонила поле течений: ${failure.message.split('\n')[0]}`);
    // Не сошлось за отпущенные шаги — досчитать следующей отправкой, пока не сойдётся или не кончится предел.
    while (out.scal[4] !== 0 && issued < DRIFT_MAX_ITERATIONS) {
      const more = Math.min(DRIFT_MAX_ITERATIONS - issued, Math.max(4, this.lastIterations));
      enc = this.device.createCommandEncoder();
      pass = enc.beginComputePass();
      this.iterations(pass, more);
      pass.end();
      issued += more; submits++;
      out = await this.finish(enc, n);
    }
    const iterations = out.scal[7];
    this.lastIterations = Math.max(1, iterations);
    const vx = new Float32Array(n), vy = new Float32Array(n);
    for (let k = 0; k < n; k++) { vx[k] = out.vel[2 * k]; vy[k] = out.vel[2 * k + 1]; }
    const field: DriftField = { cols: s.cols, rows: s.rows, cell: s.cell, vx, vy };
    // Узел остаётся на видеокарте для суммы течений.
    const node = this.keepNode(Math.round(s.t / DRIFT_PERIOD), field, n);
    const copy = this.device.createCommandEncoder();
    copy.copyBufferToBuffer(this.buf.vel, 0, node, 0, n * 8);
    this.device.queue.submit([copy.finish()]);
    return { field, iterations, submits, ms: performance.now() - t0, rebuilt };
  }

  /** Отсеков в текущей местности (для отладки). */
  get regionCount(): number { return this.regions; }
}
