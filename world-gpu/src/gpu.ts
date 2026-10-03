import physics from './physics.wgsl?raw';
import drawing from './render.wgsl?raw';
import summaryShader from './summary.wgsl?raw';
import sorShader from './pressure-sor.wgsl?raw';
import { type Grid } from './model.ts';

export interface Snapshot { state: Uint32Array; pressure: Float32Array; flow: Float32Array; step: number }
export type PressureMethod = 'sor' | 'jacobi';
export interface PressureOptions { method?: PressureMethod; iterations?: number }
export interface PressureResult { method: PressureMethod; iterations: number; passes: number; milliseconds: number }
export class GpuWorld {
  readonly device: GPUDevice;
  readonly adapter: GPUAdapter;
  readonly context: GPUCanvasContext;
  readonly canvas: HTMLCanvasElement;
  private uniform!: GPUBuffer;
  private view!: GPUBuffer;
  private geometry!: GPUBuffer;
  private states!: [GPUBuffer, GPUBuffer];
  private pressures!: [GPUBuffer, GPUBuffer];
  private flow!: GPUBuffer;
  private outgoing!: GPUBuffer;
  private carry!: GPUBuffer;
  private buffers: GPUBuffer[] = [];
  private compute!: Record<string, GPUComputePipeline>;
  private render!: GPURenderPipeline;
  private groups!: GPUBindGroup[][];
  private renderGroups!: GPUBindGroup[];
  private summaries!: GPUBuffer;
  private summaryPipeline!: GPUComputePipeline;
  private summaryGroups!: GPUBindGroup[];
  private sor!: [GPUComputePipeline, GPUComputePipeline];
  private sorGroup!: GPUBindGroup;
  private current = 0;
  private pressureIndex = 0;
  grid!: Grid;
  step = 0;
  lost = false;
  errors: string[] = [];
  pressureResult: PressureResult | null = null;

  private constructor(canvas: HTMLCanvasElement, adapter: GPUAdapter, device: GPUDevice) {
    this.canvas = canvas; this.adapter = adapter; this.device = device;
    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('Не удалось создать контекст WebGPU.');
    this.context = context;
    context.configure({ device, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: 'opaque' });
    device.addEventListener('uncapturederror', (e) => { this.errors.push(e.error.message); });
    void device.lost.then((info) => { this.lost = true; this.errors.push(`GPU потерян: ${info.message}`); });
  }

  static async create(canvas: HTMLCanvasElement): Promise<GpuWorld> {
    if (!navigator.gpu) throw new Error('Этот браузер не предоставляет WebGPU. Откройте прототип в браузере с WebGPU.');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('WebGPU доступен, но GPU-адаптер не найден.');
    const device = await adapter.requestDevice();
    return new GpuWorld(canvas, adapter, device);
  }

  private buffer(label: string, data: ArrayBufferView | number, usage: number): GPUBuffer {
    const size = typeof data === 'number' ? data : data.byteLength;
    const b = this.device.createBuffer({ label, size, usage }); this.buffers.push(b);
    if (typeof data !== 'number') this.device.queue.writeBuffer(b, 0, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
    return b;
  }

  async reset(grid: Grid, options: PressureOptions = {}): Promise<void> {
    if (this.lost) throw new Error('Устройство GPU потеряно. Перезагрузите прототип.');
    await this.device.queue.onSubmittedWorkDone();
    for (const b of this.buffers) b.destroy(); this.buffers = [];
    this.grid = grid; this.step = 0; this.current = 0; this.pressureIndex = 0;
    const d = this.device, n = grid.cols * grid.rows;
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    this.uniform = this.buffer('physics params', 32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.view = this.buffer('render params', 32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.geometry = this.buffer('geometry', grid.geometry, storage);
    this.states = [this.buffer('state A', grid.state, storage), this.buffer('state B', grid.state, storage)];
    this.pressures = [this.buffer('pressure A', n * 4, storage), this.buffer('pressure B', n * 4, storage)];
    this.flow = this.buffer('face velocities', n * 8, storage);
    this.outgoing = this.buffer('integer transfers', n * 16, storage);
    this.carry = this.buffer('fractional transfer residues', n * 16, storage);
    d.pushErrorScope('validation');
    const module = d.createShaderModule({ label: 'physical passes', code: physics });
    const info = await module.getCompilationInfo();
    const mistakes = info.messages.filter(m => m.type === 'error');
    if (mistakes.length) throw new Error(mistakes.map(m => `WGSL ${m.lineNum}: ${m.message}`).join('\n'));
    const layout = d.createBindGroupLayout({ entries: Array.from({ length: 9 }, (_, binding) => ({
      binding, visibility: GPUShaderStage.COMPUTE,
      buffer: { type: binding === 0 ? 'uniform' : [1, 2, 4].includes(binding) ? 'read-only-storage' : 'storage' },
    })) });
    const pipelineLayout = d.createPipelineLayout({ bindGroupLayouts: [layout] });
    this.compute = {};
    for (const entryPoint of ['solve', 'velocity', 'transfer', 'advance']) {
      this.compute[entryPoint] = await d.createComputePipelineAsync({ layout: pipelineLayout, compute: { module, entryPoint } });
    }
    this.groups = [0, 1].map(s => [0, 1].map(p => d.createBindGroup({ layout, entries:
      [this.uniform, this.geometry, this.states[s], this.states[1 - s], this.pressures[p], this.pressures[1 - p],
        this.flow, this.outgoing, this.carry].map((buffer, binding) => ({ binding, resource: { buffer } })) })));
    const renderModule = d.createShaderModule({ label: 'surface image', code: drawing });
    this.render = await d.createRenderPipelineAsync({ layout: 'auto',
      vertex: { module: renderModule, entryPoint: 'vertex' },
      fragment: { module: renderModule, entryPoint: 'fragment', targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }] },
    });
    this.renderGroups = this.states.map(state => d.createBindGroup({ layout: this.render.getBindGroupLayout(0), entries:
      [this.view, this.geometry, state, this.flow].map((buffer, binding) => ({ binding, resource: { buffer } })) }));
    this.summaries = this.buffer('partial summary', Math.ceil(n / 64) * 32, storage);
    this.summaryPipeline = await d.createComputePipelineAsync({ layout: 'auto', compute: {
      module: d.createShaderModule({ label: 'diagnostic reduction', code: summaryShader }), entryPoint: 'summarize' } });
    this.summaryGroups = this.states.map(state => d.createBindGroup({ layout: this.summaryPipeline.getBindGroupLayout(0), entries:
      [this.uniform, this.geometry, state, this.flow, this.summaries].map((buffer, binding) => ({ binding, resource: { buffer } })) }));
    const sorModule = d.createShaderModule({ label: 'red-black SOR pressure', code: sorShader });
    const sorLayout = d.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ] });
    const sorPipelineLayout = d.createPipelineLayout({ bindGroupLayouts: [sorLayout] });
    this.sor = await Promise.all(['red', 'black'].map(entryPoint => d.createComputePipelineAsync({
      layout: sorPipelineLayout, compute: { module: sorModule, entryPoint } }))) as [GPUComputePipeline, GPUComputePipeline];
    const sorData = new ArrayBuffer(16); new Uint32Array(sorData).set([grid.cols, grid.rows]); new Float32Array(sorData)[2] = 1.95;
    const sorParams = this.buffer('SOR dimensions', new Uint8Array(sorData), GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.sorGroup = d.createBindGroup({ layout: sorLayout, entries: [sorParams, this.geometry, this.pressures[0]]
      .map((buffer, binding) => ({ binding, resource: { buffer } })) });
    const error = await d.popErrorScope(); if (error) throw new Error(error.message);
    this.writeParams();
    await this.solvePressure(options);
    if (this.errors.length) throw new Error(this.errors.join('\n'));
  }

  /** Solve the same equation from zero; preserves mineral/step and allows an honest solver comparison. */
  async solvePressure(options: PressureOptions = {}): Promise<PressureResult> {
    const d = this.device, method = options.method ?? 'sor';
    const iterations = options.iterations ?? (method === 'jacobi'
      ? this.grid.cols ** 2 * (this.grid.scene === 'passage' ? 32 : 4)
      : Math.max(256, this.grid.cols ** 2 * (this.grid.scene === 'passage' ? 1 : 1 / 8)));
    this.pressureIndex = 0;
    const started = performance.now(), clear = d.createCommandEncoder();
    for (const buffer of this.pressures) clear.clearBuffer(buffer);
    d.queue.submit([clear.finish()]);
    const chunk = method === 'sor' ? 128 : 256;
    for (let start = 0; start < iterations; start += chunk) {
      const encoder = d.createCommandEncoder();
      for (let i = start; i < Math.min(start + chunk, iterations); i++) {
        if (method === 'jacobi') { this.dispatch(encoder, 'solve'); this.pressureIndex = 1 - this.pressureIndex; }
        else {
          for (const pipeline of this.sor) {
            const pass = encoder.beginComputePass(); pass.setPipeline(pipeline); pass.setBindGroup(0, this.sorGroup);
            pass.dispatchWorkgroups(Math.ceil(this.grid.cols * this.grid.rows / 64)); pass.end();
          }
        }
      }
      d.queue.submit([encoder.finish()]);
      await d.queue.onSubmittedWorkDone(); // Bound queue length and yield during initialization.
    }
    const encoder = d.createCommandEncoder(); this.dispatch(encoder, 'velocity'); d.queue.submit([encoder.finish()]);
    await d.queue.onSubmittedWorkDone();
    this.pressureResult = { method, iterations, passes: iterations * (method === 'sor' ? 2 : 1), milliseconds: performance.now() - started };
    return this.pressureResult;
  }

  private writeParams(): void {
    const data = new ArrayBuffer(32), u = new Uint32Array(data), f = new Float32Array(data);
    u[0] = this.grid.cols; u[1] = this.grid.rows; f[2] = this.grid.cell; f[3] = .1;
    u[4] = this.step; u[5] = this.grid.sourceCell; u[6] = Number(this.grid.scene === 'burst');
    this.device.queue.writeBuffer(this.uniform, 0, data);
  }
  private dispatch(encoder: GPUCommandEncoder, entry: string): void {
    const pass = encoder.beginComputePass(); pass.setPipeline(this.compute[entry]);
    pass.setBindGroup(0, this.groups[this.current][this.pressureIndex]);
    pass.dispatchWorkgroups(Math.ceil(this.grid.cols * this.grid.rows / 64)); pass.end();
  }

  advance(): void {
    if (this.lost) throw new Error('GPU потерян.');
    this.writeParams();
    const encoder = this.device.createCommandEncoder();
    this.dispatch(encoder, 'transfer'); this.dispatch(encoder, 'advance');
    this.device.queue.submit([encoder.finish()]); this.current = 1 - this.current; this.step++;
  }

  draw(arrows: boolean): void {
    if (this.lost || !this.grid) return;
    this.canvas.dataset.shape = this.grid.scene === 'circle' ? 'circle' : 'rectangle';
    const w = Math.max(1, Math.round(this.canvas.clientWidth * Math.min(devicePixelRatio, 2)));
    const h = Math.max(1, Math.round(w * this.grid.rows / this.grid.cols));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    const data = new ArrayBuffer(32), u = new Uint32Array(data), f = new Float32Array(data);
    u[0] = this.grid.cols; u[1] = this.grid.rows; f[2] = this.grid.cell; f[3] = this.step * .1;
    u[4] = Number(arrows); u[5] = Number(this.grid.scene === 'burst');
    this.device.queue.writeBuffer(this.view, 0, data);
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: this.context.getCurrentTexture().createView(),
      clearValue: { r: .05, g: .08, b: .1, a: 1 }, loadOp: 'clear', storeOp: 'store' }] });
    pass.setPipeline(this.render); pass.setBindGroup(0, this.renderGroups[this.current]); pass.draw(3); pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  /** Full readback is for checks only; drawing never reads physics back to CPU. */
  async snapshot(): Promise<Snapshot> {
    const n = this.grid.cols * this.grid.rows, size = n * 28;
    const buffer = this.device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(this.states[this.current], 0, buffer, 0, n * 16);
    encoder.copyBufferToBuffer(this.pressures[this.pressureIndex], 0, buffer, n * 16, n * 4);
    encoder.copyBufferToBuffer(this.flow, 0, buffer, n * 20, n * 8);
    const step = this.step;
    this.device.queue.submit([encoder.finish()]);
    try {
      await buffer.mapAsync(GPUMapMode.READ);
      const copy = buffer.getMappedRange().slice(0);
      return { state: new Uint32Array(copy, 0, n * 4), pressure: new Float32Array(copy, n * 16, n),
        flow: new Float32Array(copy, n * 20, n * 2), step };
    } finally { buffer.unmap(); buffer.destroy(); }
  }

  async summary() {
    this.writeParams();
    const grid = this.grid;
    const groups = Math.ceil(grid.cols * grid.rows / 64), size = groups * 32;
    const buffer = this.device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = this.device.createCommandEncoder(), pass = encoder.beginComputePass();
    pass.setPipeline(this.summaryPipeline); pass.setBindGroup(0, this.summaryGroups[this.current]);
    pass.dispatchWorkgroups(groups); pass.end(); encoder.copyBufferToBuffer(this.summaries, 0, buffer, 0, size);
    const step = this.step; this.device.queue.submit([encoder.finish()]);
    try {
      await buffer.mapAsync(GPUMapMode.READ);
      const u = new Uint32Array(buffer.getMappedRange()), f = new Float32Array(u.buffer);
      let dissolved = 0, captured = 0, reserved = 0, maxSpeed = 0, residual = 0, scale = 0, leak = 0;
      for (let k = 0; k < groups * 8; k += 8) {
        dissolved += u[k]; captured += u[k + 1]; reserved += u[k + 2]; maxSpeed = Math.max(maxSpeed, f[k + 3]);
        residual += f[k + 4]; scale += f[k + 5]; leak += u[k + 6];
      }
      return { step, dissolved, captured, reserved, maxSpeed: maxSpeed * grid.cell, leak,
        massError: dissolved + captured + reserved - grid.total,
        relativeResidual: scale ? Math.sqrt(residual / scale) : Math.sqrt(residual) };
    } finally { buffer.unmap(); buffer.destroy(); }
  }
}
