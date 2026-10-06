/// <reference types="@webgpu/types" />
/**
 * Этапы обновления минерала на видеокарте (план docs/plan/world-gpu-engine.md):
 * «среда» — перенос, растекание, оседание и размыв одним заходом; «стекание».
 * Алгоритмы — те же, что в ядре (`transportRange`, `spread`, `settleRange`,
 * `runoff` в src/core/mineral.ts).
 *
 * Количества — 64-битные доли (пара u32, со знаком в старших). Сколько уходит,
 * считается в f32; что ушло из клетки, ровно столько пришло в другие (остаток
 * раскладки — последнему), поэтому сумма долей сохраняется точно. Сложение из
 * многих потоков — `atomicAdd` младших слов и перенос в старшие.
 */
import { MINERAL_LAYER, MINERAL_MOBILITY, RUNOFF, TRANSPORT_SUBSTEPS, type MediumStage, type RunoffStage } from '../core/index.ts';
import { fromShares, shareSum, toShares } from './engine.ts';

const WGSL = /* wgsl */`
struct U {
  cols: u32, rows: u32, n: u32, subsMax: u32,
  cell: f32, P: f32, layerK: f32, scaleM: f32,
  scaleG: f32, spread: f32, sMax: f32, settle: f32,
  dissolve: f32, perLvl: f32, erosionOver: f32, erosion: f32,
  sinkSettle: f32, runoffK: f32, p0: f32, p1: f32,
};
@group(0) @binding(0) var<uniform> U0: U;
@group(0) @binding(1) var<storage, read> F: array<vec2u>;            // поле на входе этапа
@group(0) @binding(2) var<storage, read_write> A: array<atomic<u32>>; // после переноса; выход стекания
@group(0) @binding(3) var<storage, read> flow: array<vec2f>;          // сумма течений: смещение за шаг
@group(0) @binding(4) var<storage, read> mob: array<f32>;
@group(0) @binding(5) var<storage, read> mask: array<u32>;            // 1 — занята, 2 — отверстие воронки
@group(0) @binding(6) var<storage, read_write> Bm: array<atomic<u32>>; // после растекания и оседания
@group(0) @binding(7) var<storage, read_write> dep: array<vec2u>;
@group(0) @binding(8) var<storage, read> ground: array<vec2u>;
@group(0) @binding(9) var<storage, read_write> erosionOut: array<f32>;
@group(0) @binding(10) var<storage, read_write> settlingOut: array<f32>;

// ---- 64-битные целые: (младшие, старшие), со знаком в старших ----
fn add64(a: vec2u, b: vec2u) -> vec2u { let lo = a.x + b.x; return vec2u(lo, a.y + b.y + select(0u, 1u, lo < a.x)); }
fn sub64(a: vec2u, b: vec2u) -> vec2u { return vec2u(a.x - b.x, a.y - b.y - select(0u, 1u, a.x < b.x)); }
fn neg64(a: vec2u) -> vec2u { return sub64(vec2u(0u), a); }
fn isNeg(a: vec2u) -> bool { return (a.y & 0x80000000u) != 0u; }
fn isZero(a: vec2u) -> bool { return a.x == 0u && a.y == 0u; }
fn lt64(a: vec2u, b: vec2u) -> bool { return a.y < b.y || (a.y == b.y && a.x < b.x); }   // без знака
fn min64(a: vec2u, b: vec2u) -> vec2u { return select(a, b, lt64(b, a)); }
fn toF(a: vec2u) -> f32 { return f32(a.y) * 4294967296.0 + f32(a.x); }                // без знака
fn toFs(a: vec2u) -> f32 { return select(toF(a), -toF(neg64(a)), isNeg(a)); }       // со знаком
fn fromF(x: f32) -> vec2u {                                                          // x ≥ 0, к ближайшему
  let r = floor(x + 0.5);
  if (r <= 0.0) { return vec2u(0u); }
  let hi = floor(r / 4294967296.0);
  return vec2u(u32(max(0.0, r - hi * 4294967296.0)), u32(hi));
}
fn atomicAdd64(buf: u32, k: u32, v: vec2u) {
  if (isZero(v)) { return; }
  if (buf == 0u) {
    let old = atomicAdd(&A[2u * k], v.x);
    atomicAdd(&A[2u * k + 1u], v.y + select(0u, 1u, old + v.x < old));
  } else {
    let old = atomicAdd(&Bm[2u * k], v.x);
    atomicAdd(&Bm[2u * k + 1u], v.y + select(0u, 1u, old + v.x < old));
  }
}
fn loadB(k: u32) -> vec2u { return vec2u(atomicLoad(&Bm[2u * k]), atomicLoad(&Bm[2u * k + 1u])); }
fn loadA(k: u32) -> vec2u { return vec2u(atomicLoad(&A[2u * k]), atomicLoad(&A[2u * k + 1u])); }
fn blocked(k: u32) -> bool { return (mask[k] & 1u) != 0u; }
fn hole(k: u32) -> bool { return (mask[k] & 2u) != 0u; }
fn blockedAt(i: i32, j: i32) -> bool {
  return i < 0 || j < 0 || i >= i32(U0.cols) || j >= i32(U0.rows) || blocked(u32(j) * U0.cols + u32(i));
}

// ---- перенос (transportRange): из F в A ----
fn part(left: vec2u, total: f32, w: f32) -> vec2u { return min64(fromF(total * w), left); }
fn put(i: i32, j: i32, v: vec2u, home: u32) {
  if (blockedAt(i, j)) { atomicAdd64(0u, home, v); } else { atomicAdd64(0u, u32(j) * U0.cols + u32(i), v); }
}
fn spill(x: f32, y: f32, moved: vec2u, home: u32) {
  let fx = x / U0.cell - 0.5; let fy = y / U0.cell - 0.5;
  let i0 = i32(floor(fx)); let j0 = i32(floor(fy)); let u = fx - f32(i0); let w = fy - f32(j0);
  let mf = toF(moved);
  var left = moved;
  let s00 = part(left, mf, (1.0 - u) * (1.0 - w)); left = sub64(left, s00);
  let s10 = part(left, mf, u * (1.0 - w)); left = sub64(left, s10);
  let s01 = part(left, mf, (1.0 - u) * w); left = sub64(left, s01);
  put(i0, j0, s00, home); put(i0 + 1, j0, s10, home); put(i0, j0 + 1, s01, home); put(i0 + 1, j0 + 1, left, home);
}
@compute @workgroup_size(64) fn transport(@builtin(global_invocation_id) g: vec3u) {
  let k = g.x; if (k >= U0.n || blocked(k)) { return; }
  let amount = F[k];
  if (isZero(amount)) { return; }
  // Отрицательное (остаток округления) и отверстие воронки — на месте.
  if (isNeg(amount) || hole(k)) { atomicAdd64(0u, k, amount); return; }
  let f = flow[k]; let fl = length(f);
  if (fl == 0.0) { atomicAdd64(0u, k, amount); return; }
  let mo = mob[k];
  let moved = min64(amount, fromF(U0.layerK * fl / (mo * mo) * U0.scaleM));
  atomicAdd64(0u, k, sub64(amount, moved));
  if (isZero(moved)) { return; }
  let cols = U0.cols; let rows = U0.rows; let cell = U0.cell;
  var x = (f32(k % cols) + 0.5) * cell; var y = (f32(k / cols) + 0.5) * cell;
  let width = f32(cols) * cell; let height = f32(rows) * cell;
  let subs = min(U0.subsMax, max(1u, u32(ceil(fl * U0.P / cell))));
  let dt = U0.P / f32(subs);
  if (subs == 1u) {
    let nx = x + f.x * dt; let ny = y + f.y * dt;
    if (nx >= 0.0 && ny >= 0.0 && nx < width && ny < height && !blocked(u32(ny / cell) * cols + u32(nx / cell))) {
      x = nx; y = ny;
      let t = u32(y / cell) * cols + u32(x / cell);
      if (hole(t)) { atomicAdd64(0u, t, moved); return; }
    }
    spill(x, y, moved, k);
    return;
  }
  for (var s = 0u; s < subs; s++) {
    let fx = clamp(x / cell - 0.5, 0.0, f32(cols - 1u)); let fy = clamp(y / cell - 0.5, 0.0, f32(rows - 1u));
    let a0 = u32(fx); let b0 = u32(fy); let uu = fx - f32(a0); let ww = fy - f32(b0);
    let c00 = b0 * cols + a0; let c10 = select(c00, c00 + 1u, a0 + 1u < cols); let c01 = select(c00, c00 + cols, b0 + 1u < rows); let c11 = c01 + (c10 - c00);
    let v = mix(mix(flow[c00], flow[c10], uu), mix(flow[c01], flow[c11], uu), ww);
    let nx = x + v.x * dt; let ny = y + v.y * dt;
    if (nx < 0.0 || ny < 0.0 || nx >= width || ny >= height) { break; }
    let c = u32(ny / cell) * cols + u32(nx / cell);
    if (blocked(c)) { break; }
    x = nx; y = ny;
    if (hole(c)) { break; }
  }
  let t = u32(y / cell) * cols + u32(x / cell);
  if (hole(t)) { atomicAdd64(0u, t, moved); } else { spill(x, y, moved, k); }
}

// ---- растекание (spread): Bm = A + потоки пар вправо и вниз, по снимку A ----
fn pairFlow(k: u32, n: u32) {
  if (blocked(n)) { return; }
  // Разность — в целых, затем в f32: без потери на близких больших числах.
  let raw = U0.spread * 2.0 * toFs(sub64(loadA(k), loadA(n))) / (mob[k] + mob[n]);
  if (raw > 0.0 && !hole(k)) { let v = fromF(raw); atomicAdd64(1u, k, neg64(v)); atomicAdd64(1u, n, v); }
  if (raw < 0.0 && !hole(n)) { let v = fromF(-raw); atomicAdd64(1u, n, neg64(v)); atomicAdd64(1u, k, v); }
}
@compute @workgroup_size(64) fn spreadPairs(@builtin(global_invocation_id) g: vec3u) {
  let k = g.x; if (k >= U0.n || blocked(k)) { return; }
  let i = k % U0.cols; let j = k / U0.cols;
  if (i + 1u < U0.cols) { pairFlow(k, k + 1u); }
  if (j + 1u < U0.rows) { pairFlow(k, k + U0.cols); }
}

// ---- оседание и размыв (settleRange): Bm и залежи, по клетке ----
@compute @workgroup_size(64) fn settle(@builtin(global_invocation_id) g: vec3u) {
  let k = g.x; if (k >= U0.n) { return; }
  if (blocked(k)) { erosionOut[k] = 0.0; settlingOut[k] = 0.0; return; }
  let cols = U0.cols; let rows = U0.rows;
  let f = flow[k]; let speed = length(f);
  let calm = select(1.0, 1.0 - min(1.0, speed / U0.sMax), U0.sMax > 0.0);
  let d = dep[k];
  let lvl = (toFs(ground[k]) / U0.scaleG + toFs(d) / U0.scaleM) / U0.perLvl;
  let room = clamp((1.4 - lvl) / 0.2, 0.0, 1.0);
  let i = k % cols; let j = k / cols;
  let fr = select(f.x, flow[k + 1u].x, i < cols - 1u && !blocked(k + 1u));
  let fl = select(f.x, flow[k - 1u].x, i > 0u && !blocked(k - 1u));
  let fd = select(f.y, flow[k + cols].y, j < rows - 1u && !blocked(k + cols));
  let fu = select(f.y, flow[k - cols].y, j > 0u && !blocked(k - cols));
  let div = (fr - fl + fd - fu) / (2.0 * U0.cell);
  let sink = min(0.9, max(0.0, -div) * U0.sinkSettle);
  let frac = (1.0 - (1.0 - U0.settle * calm * calm) * (1.0 - sink)) * room;
  let v = loadB(k);
  var settled = vec2u(0u);
  if (!isNeg(v)) { settled = min64(v, fromF(toF(v) * frac)); }
  let over = speed - U0.erosionOver;
  var erode = vec2u(0u);
  if (over > 0.0 && !isNeg(d)) { erode = min64(d, fromF(U0.erosion * over * U0.scaleM)); }
  let rest = sub64(d, erode);
  var dissolved = vec2u(0u);
  if (!isNeg(rest)) { dissolved = min64(rest, fromF(toF(rest) * U0.dissolve)); }
  let nv = add64(sub64(add64(v, erode), settled), dissolved);
  atomicStore(&Bm[2u * k], nv.x); atomicStore(&Bm[2u * k + 1u], nv.y);
  dep[k] = sub64(sub64(add64(d, settled), erode), dissolved);
  erosionOut[k] = toF(erode) / U0.scaleM;
  settlingOut[k] = toF(settled) / U0.scaleM;
}

// ---- стекание (runoff): A = F + сток к соседям ниже ----
fn surf(n: u32) -> f32 { return (toFs(ground[n]) / U0.scaleG + (toFs(dep[n]) + toFs(F[n])) / U0.scaleM) / U0.perLvl; }
fn drop(h: f32, ok: bool, n: u32) -> f32 { if (!ok || blocked(n)) { return 0.0; } return max(0.0, h - surf(n)); }
@compute @workgroup_size(64) fn runoff(@builtin(global_invocation_id) g: vec3u) {
  let k = g.x; if (k >= U0.n) { return; }
  let a = F[k];
  if (isZero(a) || isNeg(a) || blocked(k) || hole(k)) { return; }
  let cols = U0.cols; let rows = U0.rows; let i = k % cols; let j = k / cols;
  let h = surf(k);
  let dl = drop(h, i > 0u, k - 1u); let dr = drop(h, i < cols - 1u, k + 1u);
  let du = drop(h, j > 0u, k - cols); let dd = drop(h, j < rows - 1u, k + cols);
  let total = dl + dr + du + dd;
  if (total == 0.0) { return; }
  let moved = min64(a, fromF(toF(a) * min(0.5, U0.runoffK * total)));
  if (isZero(moved)) { return; }
  atomicAdd64(0u, k, neg64(moved));
  let mf = toF(moved);
  var left = moved;
  // Части по перепадам; остаток — последнему соседу с перепадом.
  var last = 0u;
  if (dl > 0.0) { last = 1u; } if (dr > 0.0) { last = 2u; } if (du > 0.0) { last = 3u; } if (dd > 0.0) { last = 4u; }
  if (dl > 0.0) { let p = select(part(left, mf, dl / total), left, last == 1u); left = sub64(left, p); atomicAdd64(0u, k - 1u, p); }
  if (dr > 0.0) { let p = select(part(left, mf, dr / total), left, last == 2u); left = sub64(left, p); atomicAdd64(0u, k + 1u, p); }
  if (du > 0.0) { let p = select(part(left, mf, du / total), left, last == 3u); left = sub64(left, p); atomicAdd64(0u, k - cols, p); }
  if (dd > 0.0) { atomicAdd64(0u, k + cols, left); }
}
`;

export interface StageRun {
  /** От загрузки до готового результата, мс: подготовка на CPU (доли, загрузка), видеокарта с чтением, разбор ответа. */
  ms: number;
  prepMs: number;
  gpuMs: number;
  doneMs: number;
  /** Сумма долей минерала до и после этапа равна. */
  exact: boolean;
}

type Name = 'transport' | 'spreadPairs' | 'settle' | 'runoff';
const USED: Record<Name, number[]> = {
  transport: [0, 1, 2, 3, 4, 5, 6],
  spreadPairs: [0, 2, 4, 5, 6],
  settle: [0, 3, 5, 6, 7, 8, 9, 10],
  runoff: [0, 1, 2, 5, 6, 7, 8],
};

/** Минерал на видеокарте: «среда» и «стекание»; вход — из CPU-мира, выход — обратно. */
export class GpuMineral {
  private readonly device: GPUDevice;
  private readonly pipes: Record<Name, GPUComputePipeline>;
  private cells = 0;
  private b: Record<'uniform' | 'F' | 'A' | 'flow' | 'mob' | 'mask' | 'B' | 'dep' | 'ground' | 'erosion' | 'settling' | 'read', GPUBuffer> | null = null;
  private groups: Record<Name, GPUBindGroup> | null = null;
  private fShares = new Uint32Array(0);
  private dShares = new Uint32Array(0);
  private gShares = new Uint32Array(0);
  private flowData = new Float32Array(0);
  private mobData = new Float32Array(0);
  private maskData = new Uint32Array(0);

  constructor(device: GPUDevice) {
    this.device = device;
    const module = device.createShaderModule({ code: WGSL });
    this.pipes = Object.fromEntries((Object.keys(USED) as Name[]).map((e) => [e, device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: e } })])) as Record<Name, GPUComputePipeline>;
  }

  private ensure(n: number): void {
    if (n === this.cells && this.b) return;
    if (this.b) for (const x of Object.values(this.b)) x.destroy();
    const d = this.device, S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const make = (size: number, usage = S) => d.createBuffer({ size: Math.ceil(size / 16) * 16, usage });
    this.b = {
      uniform: make(80, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
      F: make(n * 8), A: make(n * 8), flow: make(n * 8), mob: make(n * 4), mask: make(n * 4), B: make(n * 8),
      dep: make(n * 8), ground: make(n * 8), erosion: make(n * 4), settling: make(n * 4),
      read: make(n * 24, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST),
    };
    const order = [this.b.uniform, this.b.F, this.b.A, this.b.flow, this.b.mob, this.b.mask, this.b.B, this.b.dep, this.b.ground, this.b.erosion, this.b.settling];
    this.groups = Object.fromEntries((Object.keys(USED) as Name[]).map((e) => [e, d.createBindGroup({
      layout: this.pipes[e].getBindGroupLayout(0), entries: USED[e].map((binding) => ({ binding, resource: { buffer: order[binding] } })),
    })])) as Record<Name, GPUBindGroup>;
    this.fShares = new Uint32Array(n * 2); this.dShares = new Uint32Array(n * 2); this.gShares = new Uint32Array(n * 2);
    this.flowData = new Float32Array(n * 2); this.mobData = new Float32Array(n); this.maskData = new Uint32Array(n);
    this.cells = n;
  }

  private uniform(cols: number, rows: number, cell: number, mExp: number, gExp: number, s: Partial<MediumStage> & { P: number; perLvl: number }): void {
    const ub = new ArrayBuffer(80), u = new Uint32Array(ub), f = new Float32Array(ub);
    u.set([cols, rows, cols * rows, TRANSPORT_SUBSTEPS]);
    f.set([cell, s.P, MINERAL_LAYER * MINERAL_MOBILITY * s.P * cell * cell, 2 ** mExp,
      2 ** gExp, s.spread ?? 0, s.sMax ?? 0, s.settle ?? 0,
      s.dissolve ?? 0, s.perLvl, s.erosionOver ?? 0, s.erosion ?? 0,
      s.sinkSettle ?? 0, RUNOFF * s.P, 0, 0], 4);
    this.device.queue.writeBuffer(this.b!.uniform, 0, ub);
  }

  private pass(enc: GPUCommandEncoder, name: Name): void {
    const p = enc.beginComputePass();
    p.setPipeline(this.pipes[name]); p.setBindGroup(0, this.groups![name]); p.dispatchWorkgroups(Math.ceil(this.cells / 64));
    p.end();
  }

  private mask(blocked: Uint8Array, holes: Uint8Array): void {
    for (let k = 0; k < this.cells; k++) this.maskData[k] = (blocked[k] ? 1 : 0) | (holes[k] ? 2 : 0);
    this.device.queue.writeBuffer(this.b!.mask, 0, this.maskData);
  }

  private async read(enc: GPUCommandEncoder, parts: [GPUBuffer, number][]): Promise<ArrayBuffer> {
    let at = 0;
    for (const [buf, size] of parts) { enc.copyBufferToBuffer(buf, 0, this.b!.read, at, size); at += size; }
    this.device.queue.submit([enc.finish()]);
    await this.b!.read.mapAsync(GPUMapMode.READ, 0, at);
    const data = this.b!.read.getMappedRange(0, at).slice(0);
    this.b!.read.unmap();
    return data;
  }

  /** Перенос, растекание, оседание и размыв: как три этапа ядра подряд. */
  async medium(s: MediumStage, mExp: number, gExp: number): Promise<StageRun> {
    const t0 = performance.now();
    const { cols, rows, cell, blocked } = s.m, n = cols * rows;
    this.ensure(n);
    const b = this.b!, q = this.device.queue;
    this.uniform(cols, rows, cell, mExp, gExp, s);
    toShares(s.src, mExp, this.fShares); toShares(s.terrain.deposits, mExp, this.dShares); toShares(s.terrain.ground, gExp, this.gShares);
    for (let k = 0; k < n; k++) { this.flowData[2 * k] = s.tvx[k]; this.flowData[2 * k + 1] = s.tvy[k]; this.mobData[k] = s.mobility[k]; }
    q.writeBuffer(b.F, 0, this.fShares); q.writeBuffer(b.dep, 0, this.dShares); q.writeBuffer(b.ground, 0, this.gShares);
    q.writeBuffer(b.flow, 0, this.flowData); q.writeBuffer(b.mob, 0, this.mobData);
    this.mask(blocked, s.holes);
    const before = shareSum(this.fShares) + shareSum(this.dShares);
    const t1 = performance.now();
    const enc = this.device.createCommandEncoder();
    enc.clearBuffer(b.A);
    this.pass(enc, 'transport');
    enc.copyBufferToBuffer(b.A, 0, b.B, 0, n * 8);
    this.pass(enc, 'spreadPairs');
    this.pass(enc, 'settle');
    const data = await this.read(enc, [[b.B, n * 8], [b.dep, n * 8], [b.erosion, n * 4], [b.settling, n * 4]]);
    const t2 = performance.now();
    const field = new Uint32Array(data, 0, n * 2), deposits = new Uint32Array(data, n * 8, n * 2);
    fromShares(field, mExp, s.dst);
    fromShares(deposits, mExp, s.terrain.deposits);
    s.erosionOut.set(new Float32Array(data, n * 16, n));
    s.settlingOut.set(new Float32Array(data, n * 20, n));
    const t3 = performance.now();
    return { ms: t3 - t0, prepMs: t1 - t0, gpuMs: t2 - t1, doneMs: t3 - t2, exact: shareSum(field) + shareSum(deposits) === before };
  }

  /** Стекание: как `runoff` ядра. */
  async runoff(s: RunoffStage, mExp: number, gExp: number): Promise<StageRun> {
    const t0 = performance.now();
    const { cols, rows, cell, blocked } = s.m, n = cols * rows;
    this.ensure(n);
    const b = this.b!, q = this.device.queue;
    this.uniform(cols, rows, cell, mExp, gExp, s);
    toShares(s.field, mExp, this.fShares); toShares(s.deposits, mExp, this.dShares); toShares(s.ground, gExp, this.gShares);
    q.writeBuffer(b.F, 0, this.fShares); q.writeBuffer(b.dep, 0, this.dShares); q.writeBuffer(b.ground, 0, this.gShares);
    this.mask(blocked, s.holes);
    const t1 = performance.now();
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(b.F, 0, b.A, 0, n * 8);
    this.pass(enc, 'runoff');
    const out = new Uint32Array(await this.read(enc, [[b.A, n * 8]]));
    const t2 = performance.now();
    fromShares(out, mExp, s.out);
    const t3 = performance.now();
    return { ms: t3 - t0, prepMs: t1 - t0, gpuMs: t2 - t1, doneMs: t3 - t2, exact: shareSum(out) === shareSum(this.fShares) };
  }
}
