/// <reference types="@webgpu/types" />
/**
 * Этап 6 плана (docs/plan/world-gpu-engine.md): единичное течение толчка вулкана или
 * тяги воронки на видеокарте — как `solvePushSystem` ядра (src/core/push.ts): верхняя
 * релаксация Гаусса — Зейделя в окне вокруг источника, PUSH_ITERATIONS итераций, затем
 * скорость клетки — среднее потоков через её грани. Обход шахматный (красные, затем
 * чёрные клетки) вместо построчного: тот же метод, порядок параллельный. Полупроход —
 * проход по всей видеокарте (одна группа на окно — одно ядро из восьми, в 4 раза медленнее).
 */
import { PUSH_ITERATIONS, PUSH_OMEGA } from '../core/index.ts';
import type { PushField, PushSystem } from '../core/push.ts';

const WGSL = /* wgsl */`
struct U { w: u32, h: u32, n: u32, color: u32, omega: f32, cell: f32, p0: f32, p1: f32 };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> cond: array<f32>;
@group(0) @binding(2) var<storage, read> ce: array<f32>;
@group(0) @binding(3) var<storage, read> cs: array<f32>;
@group(0) @binding(4) var<storage, read> total: array<f32>;
@group(0) @binding(5) var<storage, read> src: array<f32>;
@group(0) @binding(6) var<storage, read_write> p: array<f32>;
@group(0) @binding(7) var<storage, read_write> vel: array<vec2f>;
// Полупроход: клетки одного цвета, по всей видеокарте.
@compute @workgroup_size(64) fn relax(@builtin(global_invocation_id) g: vec3u) {
  let q = g.x; let w = u.w; if (q >= u.n) { return; }
  let i = q % w; let j = q / w;
  if (((i + j) & 1u) != u.color || cond[q] == 0.0) { return; }
  var acc = src[q];
  if (i > 0u) { acc += ce[q - 1u] * p[q - 1u]; }
  if (i + 1u < w) { acc += ce[q] * p[q + 1u]; }
  if (j > 0u) { acc += cs[q - w] * p[q - w]; }
  if (j + 1u < u.h) { acc += cs[q] * p[q + w]; }
  p[q] += u.omega * (acc / total[q] - p[q]);
}
// Скорость клетки — среднее потоков через её грани ÷ ширина грани.
@compute @workgroup_size(64) fn velocity(@builtin(global_invocation_id) g: vec3u) {
  let q = g.x; let w = u.w; if (q >= u.n) { return; }
  if (cond[q] == 0.0) { vel[q] = vec2f(0.0); return; }
  let i = q % w; let j = q / w;
  var fw = 0.0; var fe = 0.0; var fn_ = 0.0; var fs = 0.0;
  if (i > 0u) { fw = ce[q - 1u] * (p[q - 1u] - p[q]); }
  if (i + 1u < w) { fe = ce[q] * (p[q] - p[q + 1u]); }
  if (j > 0u) { fn_ = cs[q - w] * (p[q - w] - p[q]); }
  if (j + 1u < u.h) { fs = cs[q] * (p[q] - p[q + w]); }
  vel[q] = vec2f((fw + fe) / 2.0 / u.cell, (fn_ + fs) / 2.0 / u.cell);
}`;

export interface PushRun { field: PushField; ms: number }

export class GpuPush {
  private readonly device: GPUDevice;
  private readonly relax: GPUComputePipeline;
  private readonly velocity: GPUComputePipeline;

  constructor(device: GPUDevice) {
    this.device = device;
    const module = device.createShaderModule({ code: WGSL });
    this.relax = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'relax' } });
    this.velocity = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'velocity' } });
  }

  /** Решить систему толчка — как `solvePushSystem` ядра; `iterations` — для сверки сходимости. */
  async solve(sys: PushSystem, iterations = PUSH_ITERATIONS): Promise<PushRun> {
    const t0 = performance.now();
    const d = this.device, n = sys.w * sys.h;
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const made: GPUBuffer[] = [];
    const mk = (bytes: number, usage = S) => { const b = d.createBuffer({ size: Math.max(16, Math.ceil(bytes / 16) * 16), usage }); made.push(b); return b; };
    const up = (a: Float64Array) => { const f = Float32Array.from(a), b = mk(f.byteLength); d.queue.writeBuffer(b, 0, f); return b; };
    try {
      const uniforms = [0, 1].map((color) => {
        const ub = new ArrayBuffer(32), uu = new Uint32Array(ub), uf = new Float32Array(ub);
        uu.set([sys.w, sys.h, n, color]); uf.set([PUSH_OMEGA, sys.cell], 4);
        const b = mk(32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
        d.queue.writeBuffer(b, 0, ub);
        return b;
      });
      const data = [up(sys.cond), up(sys.ce), up(sys.cs), up(sys.total), up(sys.src), mk(n * 4), mk(n * 8)];
      const read = mk(n * 8, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
      d.pushErrorScope('validation');
      const groupFor = (pipe: GPUComputePipeline, color: number, bindings: number[]) => d.createBindGroup({
        layout: pipe.getBindGroupLayout(0), entries: bindings.map((binding) => ({ binding, resource: { buffer: binding === 0 ? uniforms[color] : data[binding - 1] } })),
      });
      const relaxGroups = [0, 1].map((c) => groupFor(this.relax, c, [0, 1, 2, 3, 4, 5, 6]));
      const velocityGroup = groupFor(this.velocity, 0, [0, 1, 2, 3, 6, 7]);
      const enc = d.createCommandEncoder();
      enc.clearBuffer(data[5]);
      const pass = enc.beginComputePass();
      const wgs = Math.ceil(n / 64);
      pass.setPipeline(this.relax);
      for (let it = 0; it < iterations; it++) for (const c of [0, 1]) { pass.setBindGroup(0, relaxGroups[c]); pass.dispatchWorkgroups(wgs); }
      pass.setPipeline(this.velocity); pass.setBindGroup(0, velocityGroup); pass.dispatchWorkgroups(wgs);
      pass.end();
      enc.copyBufferToBuffer(data[6], 0, read, 0, n * 8);
      d.queue.submit([enc.finish()]);
      const failure = await d.popErrorScope();
      if (failure) throw Error(`видеокарта отклонила толчок: ${failure.message.split('\n')[0]}`);
      await read.mapAsync(GPUMapMode.READ);
      const v = new Float32Array(read.getMappedRange().slice(0, n * 8));
      read.unmap();
      const vx = new Float32Array(n), vy = new Float32Array(n);
      for (let q = 0; q < n; q++) { vx[q] = v[2 * q]; vy[q] = v[2 * q + 1]; }
      return { field: { vx, vy, cols: sys.w, i0: sys.i0, i1: sys.i1, j0: sys.j0, j1: sys.j1 }, ms: performance.now() - t0 };
    } finally {
      for (const b of made) b.destroy();
    }
  }
}
