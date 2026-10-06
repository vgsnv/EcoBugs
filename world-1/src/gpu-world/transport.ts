/// <reference types="@webgpu/types" />
/**
 * Этап 2 плана (docs/plan/world-gpu-engine.md): перенос минерала на видеокарте.
 * Алгоритм — `transportRange` ядра: поток на клетку, путь по течению шажками не
 * длиннее клетки, раскладка по четырём соседям, доля у стенки — домой.
 * Количества — 64-битные доли (пара u32); сложение из многих потоков —
 * `atomicAdd` младших слов и перенос в старшие. Сколько уносится и как делится
 * по соседям, считается в f32, а остаток всегда достаётся последней части —
 * поэтому сумма долей сохраняется точно.
 */
import { MINERAL_LAYER, MINERAL_MOBILITY, TRANSPORT_SUBSTEPS, type MineralState } from '../core/index.ts';
import { shareSum, toShares, fromShares } from './engine.ts';

const WGSL = /* wgsl */`
struct U { cols: u32, rows: u32, n: u32, subsMax: u32, cell: f32, P: f32, layerK: f32, scale: f32 };
@group(0) @binding(0) var<uniform> U0: U;
@group(0) @binding(1) var<storage, read> src: array<vec2u>;
@group(0) @binding(2) var<storage, read_write> dst: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read> flow: array<vec2f>;
@group(0) @binding(4) var<storage, read> mob: array<f32>;
@group(0) @binding(5) var<storage, read> mask: array<u32>;

// 64-битные целые: (младшие, старшие).
fn sub64(a: vec2u, b: vec2u) -> vec2u { return vec2u(a.x - b.x, a.y - b.y - select(0u, 1u, a.x < b.x)); }
fn lt64(a: vec2u, b: vec2u) -> bool { return a.y < b.y || (a.y == b.y && a.x < b.x); }
fn min64(a: vec2u, b: vec2u) -> vec2u { return select(a, b, lt64(b, a)); }
fn toF(a: vec2u) -> f32 { return f32(a.y) * 4294967296.0 + f32(a.x); }
fn fromF(x: f32) -> vec2u {
  if (x <= 0.0) { return vec2u(0u); }
  let hi = floor(x / 4294967296.0);
  return vec2u(u32(max(0.0, x - hi * 4294967296.0)), u32(hi));
}
fn add(k: u32, v: vec2u) {
  if (v.x == 0u && v.y == 0u) { return; }
  let old = atomicAdd(&dst[2u * k], v.x);
  atomicAdd(&dst[2u * k + 1u], v.y + select(0u, 1u, old + v.x < old));
}
fn blockedAt(i: i32, j: i32) -> bool {
  return i < 0 || j < 0 || i >= i32(U0.cols) || j >= i32(U0.rows) || (mask[u32(j) * U0.cols + u32(i)] & 1u) != 0u;
}
// Часть w от остатка: не больше остатка; возвращает взятое.
fn part(left: vec2u, total: f32, w: f32) -> vec2u { return min64(fromF(total * w), left); }
fn put(i: i32, j: i32, v: vec2u, home: u32) {
  if (blockedAt(i, j)) { add(home, v); } else { add(u32(j) * U0.cols + u32(i), v); }
}
// Как spill ядра: билинейно по четырём соседям, доля у стенки — домой; остаток — последнему.
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
  let k = g.x; if (k >= U0.n) { return; }
  let mk = mask[k]; if ((mk & 1u) != 0u) { return; }
  let amount = src[k];
  if (amount.x == 0u && amount.y == 0u) { return; }
  // Отрицательное (остаток округления) не переносится.
  if ((amount.y & 0x80000000u) != 0u || (mk & 2u) != 0u) { add(k, amount); return; }
  let f = flow[k]; let fl = length(f);
  if (fl == 0.0) { add(k, amount); return; }
  let mo = mob[k];
  let moved = min64(amount, fromF(U0.layerK * fl / (mo * mo) * U0.scale));
  add(k, sub64(amount, moved));
  if (moved.x == 0u && moved.y == 0u) { return; }
  let cols = U0.cols; let rows = U0.rows; let cell = U0.cell;
  var x = (f32(k % cols) + 0.5) * cell; var y = (f32(k / cols) + 0.5) * cell;
  let width = f32(cols) * cell; let height = f32(rows) * cell;
  let subs = min(U0.subsMax, max(1u, u32(ceil(fl * U0.P / cell))));
  let dt = U0.P / f32(subs);
  if (subs == 1u) {
    let nx = x + f.x * dt; let ny = y + f.y * dt;
    if (nx >= 0.0 && ny >= 0.0 && nx < width && ny < height && (mask[u32(ny / cell) * cols + u32(nx / cell)] & 1u) == 0u) {
      x = nx; y = ny;
      let t = u32(y / cell) * cols + u32(x / cell);
      if ((mask[t] & 2u) != 0u) { add(t, moved); return; }
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
    if ((mask[c] & 1u) != 0u) { break; }
    x = nx; y = ny;
    if ((mask[c] & 2u) != 0u) { break; }
  }
  let t = u32(y / cell) * cols + u32(x / cell);
  if ((mask[t] & 2u) != 0u) { add(t, moved); } else { spill(x, y, moved, k); }
}`;

export interface TransportRun {
  /** От загрузки до готового результата, мс. */
  ms: number;
  /** Сумма долей до и после переноса равна. */
  exact: boolean;
}

/** Перенос на видеокарте: загрузить вход, посчитать, прочитать результат в `dst`. */
export class GpuTransport {
  private readonly device: GPUDevice;
  private readonly pipeline: GPUComputePipeline;
  private cells = 0;
  private buffers: { uniform: GPUBuffer; src: GPUBuffer; dst: GPUBuffer; flow: GPUBuffer; mob: GPUBuffer; mask: GPUBuffer; read: GPUBuffer } | null = null;
  private group: GPUBindGroup | null = null;
  private srcShares = new Uint32Array(0);
  private flow = new Float32Array(0);
  private mob = new Float32Array(0);
  private mask = new Uint32Array(0);

  constructor(device: GPUDevice) {
    this.device = device;
    this.pipeline = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: WGSL }), entryPoint: 'transport' } });
  }

  private ensure(n: number): void {
    if (n === this.cells && this.buffers) return;
    if (this.buffers) for (const b of Object.values(this.buffers)) b.destroy();
    const d = this.device, S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const make = (size: number, usage = S) => d.createBuffer({ size: Math.ceil(size / 16) * 16, usage });
    this.buffers = {
      uniform: make(32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
      src: make(n * 8), dst: make(n * 8), flow: make(n * 8), mob: make(n * 4), mask: make(n * 4),
      read: make(n * 8, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST),
    };
    const b = this.buffers;
    this.group = d.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [b.uniform, b.src, b.dst, b.flow, b.mob, b.mask].map((buffer, binding) => ({ binding, resource: { buffer } })) });
    this.srcShares = new Uint32Array(n * 2); this.flow = new Float32Array(n * 2); this.mob = new Float32Array(n); this.mask = new Uint32Array(n);
    this.cells = n;
  }

  async run(m: MineralState, src: Float64Array, dst: Float64Array, holes: Uint8Array, mobility: Float64Array, tvx: Float32Array, tvy: Float32Array, P: number, exponent: number): Promise<TransportRun> {
    const t0 = performance.now();
    const { cols, rows, cell, blocked } = m, n = cols * rows;
    this.ensure(n);
    const b = this.buffers!, q = this.device.queue;
    toShares(src, exponent, this.srcShares);
    for (let k = 0; k < n; k++) {
      this.flow[2 * k] = tvx[k]; this.flow[2 * k + 1] = tvy[k];
      this.mob[k] = mobility[k];
      this.mask[k] = (blocked[k] ? 1 : 0) | (holes[k] ? 2 : 0);
    }
    const ub = new ArrayBuffer(32), uu = new Uint32Array(ub), uf = new Float32Array(ub);
    uu.set([cols, rows, n, TRANSPORT_SUBSTEPS]);
    uf.set([cell, P, MINERAL_LAYER * MINERAL_MOBILITY * P * cell * cell, 2 ** exponent], 4);
    q.writeBuffer(b.uniform, 0, ub);
    q.writeBuffer(b.src, 0, this.srcShares); q.writeBuffer(b.flow, 0, this.flow); q.writeBuffer(b.mob, 0, this.mob); q.writeBuffer(b.mask, 0, this.mask);
    const enc = this.device.createCommandEncoder();
    enc.clearBuffer(b.dst);
    const pass = enc.beginComputePass();
    pass.setPipeline(this.pipeline); pass.setBindGroup(0, this.group!); pass.dispatchWorkgroups(Math.ceil(n / 64));
    pass.end();
    enc.copyBufferToBuffer(b.dst, 0, b.read, 0, n * 8);
    q.submit([enc.finish()]);
    await b.read.mapAsync(GPUMapMode.READ, 0, n * 8);
    const shares = new Uint32Array(b.read.getMappedRange(0, n * 8).slice(0));
    b.read.unmap();
    fromShares(shares, exponent, dst);
    return { ms: performance.now() - t0, exact: shareSum(shares) === shareSum(this.srcShares) };
  }
}
