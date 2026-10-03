import geologyShader from './geology.wgsl?raw';
import { Geology } from './geology.ts';
import mineralShader from './mineral.wgsl?raw';
import reservoirShader from './reservoir.wgsl?raw';
import { Sources } from './sources.ts';
import ballisticShader from './ballistics.wgsl?raw';
import flightDrawing from './flight-render.wgsl?raw';
import ventsShader from './vents.wgsl?raw';
import { averagedVents, emittedQuanta } from './vents.ts';
import physics from './physics.wgsl?raw';
import drawing from './render.wgsl?raw';
import summaryShader from './summary.wgsl?raw';
import lightShader from './light.wgsl?raw';
import velocityShader from './velocity.wgsl?raw';
import sorShader from './pressure-sor.wgsl?raw';
import { type Grid } from './model.ts';

export interface Snapshot { state: Uint32Array; pressure: Float32Array; flow: Float32Array; field: Float32Array; vents: Float32Array; particles: Float32Array; reservoir: Uint32Array; terrain:Uint32Array; geometry:Float32Array; step: number }
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
  private field!: GPUBuffer;
  private lightParams!: GPUBuffer;
  private lightPipelines!: Record<string, GPUComputePipeline>;
  private lightGroup!: GPUBindGroup;
  private velocityPipeline!: GPUComputePipeline;
  private velocityGroups!: GPUBindGroup[];
  private ventField!: GPUBuffer;
  private ventEvents!: GPUBuffer;
  private ventPipelines!: GPUComputePipeline[];
  private ventGroup!: GPUBindGroup;
  geology:Geology|null=null;
  private geologyParams!:GPUBuffer;
  private geologyEvents!:GPUBuffer;
  private geologyGroup!:GPUBindGroup;
  private geologyPipelines!:GPUComputePipeline[];
  private terrain!:GPUBuffer;
  private mineralPipelines!:GPUComputePipeline[];
  private mineralGroups!:GPUBindGroup[];
  private common!: GPUBuffer;
  private sourceParams!: GPUBuffer;
  private sourcePipelines!: GPUComputePipeline[];
  private sourceGroups!: GPUBindGroup[];
  private markers!: GPUBuffer;
  private markerCells:number[]=[];
  private sourceUpdateStep=-1;
  sources:Sources|null=null;
  private packets!: GPUBuffer;
  private landing!: GPUBuffer;
  private flightLedger!: GPUBuffer;
  private flightParams!: GPUBuffer;
  private flightPipelines!: GPUComputePipeline[];
  private flightGroups!: GPUBindGroup[];
  private flightRender!: GPURenderPipeline;
  private flightRenderGroup!: GPUBindGroup;
  private previousVentRates: Float32Array | null = null;
  private sorGroup!: GPUBindGroup;
  private current = 0;
  private pressureIndex = 0;
  grid!: Grid;
  step = 0;
  lost = false;
  errors: string[] = [];
  ventMilliseconds = 0;
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
    if(grid.mineral&&Object.values(grid.mineral).some(v=>typeof v==='number'&&(!Number.isFinite(v)||v<0)))throw new Error('Недопустимая скорость процесса минерала.');
    if(grid.terrain&&grid.terrain.length!==grid.state.length)throw new Error('Неверный размер карты грунта и залежей.');
    const emitters = grid.vents?.filter(vent => !!vent.mass) ?? [];
    if (!grid.sources && (emitters.length > 1 || emitters.some(vent => vent.cell !== grid.sourceCell))) {
      throw new Error('Стенд поддерживает одно активное жерло с резервом.');
    }
    if (grid.ballistics) {
      const { capacity, speed, range, direction, count } = grid.ballistics;
      if ((!grid.sources && emitters.length !== 1) || !Number.isInteger(capacity) || capacity < 1 || capacity > 4096
        || !Number.isFinite(speed) || speed <= 0 || !Number.isFinite(range) || range <= 0
        || (count !== undefined && (!Number.isInteger(count) || count < 1 || count > 256))
        || (direction && (!direction.every(Number.isFinite) || Math.hypot(...direction) === 0))) {
        throw new Error('Недопустимые параметры полёта.');
      }
    }
    if(grid.sources){
      if(!Number.isSafeInteger(grid.underground)||grid.underground!<0||grid.total>=0xffffffff
        || grid.sources.sites.some(k=>!Number.isInteger(k)||k<0||k>=grid.cols*grid.rows||grid.geometry[k*4+2]||grid.geometry[k*4+3])
        || !grid.ballistics || grid.ballistics.capacity<(grid.ballistics.count??64)*16){
        throw new Error('Недопустимые места, запас или ёмкость пула для вулканов.');
      }
    }
    await this.device.queue.onSubmittedWorkDone();
    for (const b of this.buffers) b.destroy(); this.buffers = [];
    this.grid = grid;this.geology=grid.geology?new Geology(grid.geology,grid.width,grid.height):null; this.sources=grid.sources?new Sources(grid.sources):null;this.sourceUpdateStep=-1;this.markerCells=[]; this.step = 0; this.current = 0; this.pressureIndex = 0;
    const d = this.device, n = grid.cols * grid.rows;
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    this.uniform = this.buffer('physics params', 48, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.view = this.buffer('render params', 32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.geometry = this.buffer('geometry', grid.geometry, storage);
    this.terrain=this.buffer('ground and deposits',grid.terrain??new Uint32Array(n*4),storage);
    this.field = this.buffer('physical light field', n * 16, storage);
    this.common=this.buffer('shared underground',new Uint32Array([grid.underground??0,0,0,0]),storage);
    this.markers=this.buffer('volcano markers',n*16,storage);
    this.packets = this.buffer('ballistic packets', (grid.ballistics?.capacity ?? 1) * 64, storage);
    this.landing = this.buffer('atomic landings', n * 8, storage);
    this.flightLedger = this.buffer('flight ledger', 16, storage);
    this.ventField = this.buffer('screened push field', n * 16, storage);
    this.ventMilliseconds = 0;
    this.previousVentRates = null;
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
      [this.view, this.geometry, state, this.flow, this.field, this.ventField, this.markers,this.terrain].map((buffer, binding) => ({ binding, resource: { buffer } })) }));
    this.summaries = this.buffer('partial summary', Math.ceil(n / 64) * 48, storage);
    this.summaryPipeline = await d.createComputePipelineAsync({ layout: 'auto', compute: {
      module: d.createShaderModule({ label: 'diagnostic reduction', code: summaryShader }), entryPoint: 'summarize' } });
    this.summaryGroups = this.states.map(state => d.createBindGroup({ layout: this.summaryPipeline.getBindGroupLayout(0), entries:
      [this.uniform, this.geometry, state, this.flow, this.summaries, this.field, this.ventField,this.terrain].map((buffer, binding) => ({ binding, resource: { buffer } })) }));
    const sorModule = d.createShaderModule({ label: 'red-black SOR pressure', code: sorShader });
    const sorLayout = d.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ] });
    const sorPipelineLayout = d.createPipelineLayout({ bindGroupLayouts: [sorLayout] });
    this.sor = await Promise.all(['red', 'black'].map(entryPoint => d.createComputePipelineAsync({
      layout: sorPipelineLayout, compute: { module: sorModule, entryPoint } }))) as [GPUComputePipeline, GPUComputePipeline];
    const sorData = new ArrayBuffer(16); new Uint32Array(sorData).set([grid.cols, grid.rows]); new Float32Array(sorData)[2] = grid.light ? 1.6 : 1.95;
    const sorParams = this.buffer('SOR dimensions', new Uint8Array(sorData), GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.sorGroup = d.createBindGroup({ layout: sorLayout, entries: [sorParams, this.geometry, this.pressures[0]]
      .map((buffer, binding) => ({ binding, resource: { buffer } })) });
    this.velocityPipeline = await d.createComputePipelineAsync({ layout: 'auto', compute: {
      module: d.createShaderModule({code: velocityShader}), entryPoint: 'velocity' } });
    this.velocityGroups = this.pressures.map(pressure => d.createBindGroup({ layout: this.velocityPipeline.getBindGroupLayout(0), entries:
      [this.uniform, this.geometry, pressure, this.flow, this.field, this.ventField].map((buffer, binding) => ({binding, resource: {buffer}})) }));
    if (grid.light) {
      const regions = Math.max(...grid.components) + 1;
      this.lightParams = this.buffer('light parameters', 48, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      const areas = this.buffer('closed regions', grid.components, storage);
      const means = this.buffer('mean light per region', regions * 4, storage);
      const lightLayout = d.createBindGroupLayout({entries: [
        {binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: {type: 'uniform'}},
        ...[1,2,3,4].map(binding => ({binding, visibility: GPUShaderStage.COMPUTE, buffer: {type: binding === 2 ? 'read-only-storage' as const : 'storage' as const}}))]});
      const pipelineLayout = d.createPipelineLayout({bindGroupLayouts: [lightLayout]});
      const module = d.createShaderModule({code: lightShader}); this.lightPipelines = {};
      for (const entryPoint of ['illuminate', 'average', 'entrain', 'sources']) this.lightPipelines[entryPoint] = await d.createComputePipelineAsync({layout: pipelineLayout, compute: {module, entryPoint}});
      this.lightGroup = d.createBindGroup({layout: lightLayout, entries: [this.lightParams, this.geometry, areas, this.field, means].map((buffer, binding) => ({binding, resource: {buffer}}))});
    }
    if (grid.vents) {
      const settings = new ArrayBuffer(32); new Uint32Array(settings).set([grid.cols, grid.rows, grid.vents.length]);
      new Float32Array(settings).set([grid.cell, grid.pushLength ?? 200, 1.6, 0],4);
      const uniform = this.buffer('push settings', new Uint8Array(settings), GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      this.ventEvents = this.buffer('integrated push events', grid.vents.length * 16, storage);
      const layout = d.createBindGroupLayout({entries: [
        {binding:0, visibility:GPUShaderStage.COMPUTE, buffer:{type:'uniform'}},
        ...[1,2,3].map(binding => ({binding, visibility:GPUShaderStage.COMPUTE, buffer:{type:binding === 3 ? 'storage' as const : 'read-only-storage' as const}}))]});
      const module = d.createShaderModule({code:ventsShader}), pipelineLayout = d.createPipelineLayout({bindGroupLayouts:[layout]});
      this.ventPipelines = [];
      for (const entryPoint of ['prepare','red','black']) this.ventPipelines.push(await d.createComputePipelineAsync({layout:pipelineLayout,compute:{module,entryPoint}}));
      this.ventGroup = d.createBindGroup({layout, entries:[uniform,this.geometry,this.ventEvents,this.ventField].map((buffer,binding)=>({binding,resource:{buffer}}))});
    }
    if(grid.sources){
      this.sourceParams=this.buffer('underground exchange parameters',32,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
      const layout=d.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:'uniform'}},...[1,2].map(binding=>({binding,visibility:GPUShaderStage.COMPUTE,buffer:{type:'storage' as const}}))]});
      const module=d.createShaderModule({code:reservoirShader}),pipelineLayout=d.createPipelineLayout({bindGroupLayouts:[layout]});
      const compilation=await module.getCompilationInfo();const failures=compilation.messages.filter(m=>m.type==='error');if(failures.length)throw new Error(failures.map(m=>`Недра ${m.lineNum}: ${m.message}`).join('\n'));
      this.sourcePipelines=[];for(const entryPoint of ['reserve','effuse','collect'])this.sourcePipelines.push(await d.createComputePipelineAsync({layout:pipelineLayout,compute:{module,entryPoint}}));
      this.sourceGroups=this.states.map(state=>d.createBindGroup({layout,entries:[this.sourceParams,this.common,state].map((buffer,binding)=>({binding,resource:{buffer}}))}));
    }
    if(grid.mineral){
      const settings=new ArrayBuffer(64);new Uint32Array(settings).set([grid.cols,grid.rows]);new Uint32Array(settings)[8]=Math.round(grid.cell*grid.cell*.02/.001);
      new Float32Array(settings).set([grid.cell,.1,grid.mineral.diffusion,grid.mineral.settling,grid.mineral.dissolution,grid.mineral.runoff],2);
      new Float32Array(settings).set([grid.mineral.erosion??0,grid.mineral.weathering??0,grid.mineral.speed??1],12);new Uint32Array(settings)[15]=Number(grid.mineral.evolving??false);
      const params=this.buffer('mineral parameters',new Uint8Array(settings),GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
      const residues=this.buffer('spread residues',n*16,storage),phases=this.buffer('phase residues',n*16,storage);
      const layout=d.createBindGroupLayout({entries:Array.from({length:9},(_,binding)=>({binding,visibility:GPUShaderStage.COMPUTE,buffer:{type:binding===0?'uniform':[2,5].includes(binding)?'read-only-storage':'storage'}}))});
      const module=d.createShaderModule({code:mineralShader}),pipelineLayout=d.createPipelineLayout({bindGroupLayouts:[layout]});
      const compilation=await module.getCompilationInfo();const failures=compilation.messages.filter(m=>m.type==='error');if(failures.length)throw new Error(failures.map(m=>`Минерал ${m.lineNum}: ${m.message}`).join('\n'));
      this.mineralPipelines=[];for(const entryPoint of ['spread','phases','refresh'])this.mineralPipelines.push(await d.createComputePipelineAsync({layout:pipelineLayout,compute:{module,entryPoint}}));
      this.mineralGroups=this.states.map((state,i)=>d.createBindGroup({layout,entries:[params,this.geometry,state,this.states[1-i],this.terrain,this.flow,this.outgoing,residues,phases].map((buffer,binding)=>({binding,resource:{buffer}}))}));
    }
    if(grid.geology){
      this.geologyParams=this.buffer('geology parameters',32,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);this.geologyEvents=this.buffer('geology events',16*48,storage);
      const orders=this.buffer('geology requests',n*8,storage),residues=this.buffer('geology residues',n*8,storage);
      const layout=d.createBindGroupLayout({entries:Array.from({length:7},(_,binding)=>({binding,visibility:GPUShaderStage.COMPUTE,buffer:{type:binding===0?'uniform':[1,2].includes(binding)?'read-only-storage':'storage'}}))});
      const module=d.createShaderModule({code:geologyShader}),pipelineLayout=d.createPipelineLayout({bindGroupLayouts:[layout]});const compilation=await module.getCompilationInfo();const failures=compilation.messages.filter(m=>m.type==='error');if(failures.length)throw new Error(failures.map(m=>`Подвижки ${m.lineNum}: ${m.message}`).join('\n'));
      this.geologyPipelines=[];for(const entryPoint of ['request','lower','raise'])this.geologyPipelines.push(await d.createComputePipelineAsync({layout:pipelineLayout,compute:{module,entryPoint}}));
      this.geologyGroup=d.createBindGroup({layout,entries:[this.geologyParams,this.geometry,this.geologyEvents,this.terrain,this.common,orders,residues].map((buffer,binding)=>({binding,resource:{buffer}}))});
    }
    const flightModule = d.createShaderModule({code:flightDrawing});
    this.flightRender = await d.createRenderPipelineAsync({layout:'auto', vertex:{module:flightModule,entryPoint:'vertex'}, fragment:{module:flightModule,entryPoint:'fragment',targets:[{format:navigator.gpu.getPreferredCanvasFormat(),blend:{color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha',operation:'add'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'}}}]}});
    this.flightRenderGroup = d.createBindGroup({layout:this.flightRender.getBindGroupLayout(0),entries:[this.view,this.packets].map((buffer,binding)=>({binding,resource:{buffer}}))});
    if (grid.ballistics) {
      this.flightParams = this.buffer('ballistic parameters',64,GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      const layout=d.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:'uniform'}},...[1,2,3,4,5,6].map(binding=>({binding,visibility:GPUShaderStage.COMPUTE,buffer:{type:[1,5].includes(binding)?'read-only-storage' as const:'storage' as const}}))]});
      const module=d.createShaderModule({code:ballisticShader}),pipelineLayout=d.createPipelineLayout({bindGroupLayouts:[layout]});
      const compilation = await module.getCompilationInfo();
      const errors = compilation.messages.filter(message => message.type === 'error');
      if (errors.length) throw new Error(errors.map(message => `Баллистика ${message.lineNum}:${message.linePos}: ${message.message}`).join('\n'));
      this.flightPipelines=[];
      for(const entryPoint of ['spawn','fly','gather']) this.flightPipelines.push(await d.createComputePipelineAsync({layout:pipelineLayout,compute:{module,entryPoint}}));
      this.flightGroups=this.states.map(state=>d.createBindGroup({layout,entries:[this.flightParams,this.geometry,state,this.packets,this.landing,this.flow,this.flightLedger].map((buffer,binding)=>({binding,resource:{buffer}}))}));
    }
    const error = await d.popErrorScope(); if (error) throw new Error(error.message);
    this.writeParams();
    if(grid.mineral?.evolving)this.refreshTerrain();
    if (grid.light) this.prepareLight();
    await this.solvePressure(options);
    if (grid.vents) await this.solveVents();
    if (this.errors.length) throw new Error(this.errors.join('\n'));
  }

  /** Solve the same equation from zero; preserves mineral/step and allows an honest solver comparison. */
  async solvePressure(options: PressureOptions = {}): Promise<PressureResult> {
    const d = this.device, method = options.method ?? 'sor';
    const iterations = options.iterations ?? (method === 'jacobi'
      ? this.grid.cols ** 2 * (this.grid.scene === 'passage' ? 32 : 4)
      : Math.max(256, this.grid.cols ** 2 * (this.grid.scene === 'passage' ? 1 : this.grid.light ? 1 / 2 : 1 / 8)));
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
    const data = new ArrayBuffer(48), u = new Uint32Array(data), f = new Float32Array(data);
    u[0] = this.grid.cols; u[1] = this.grid.rows; f[2] = this.grid.cell; f[3] = .1;
    u[4] = this.step; u[5] = this.grid.sourceCell; u[6] = this.grid.ballistics ? 3 : this.grid.vents ? 2 : Number(this.grid.scene === 'burst'); u[7] = Number(!!this.grid.light);
    const emitter = this.grid.vents?.find(vent => !!vent.mass);
    const emission=this.sources?.emission(this.step);
    u[8] = emission?.burst ?? (emitter ? emittedQuanta(emitter, this.step) : 0);
    if(this.sources){const params=new Uint32Array([this.grid.cols,this.grid.rows,this.grid.sourceCell,0,0,emission!.effusion,0,0]);this.device.queue.writeBuffer(this.sourceParams,0,params);}
    this.device.queue.writeBuffer(this.uniform, 0, data);
    if (this.grid.ballistics) {
      const config=this.grid.ballistics, packetData=new ArrayBuffer(64), packetU=new Uint32Array(packetData), packetF=new Float32Array(packetData);
      packetU.set([this.grid.cols,this.grid.rows]);packetF[2]=this.grid.cell;packetF[3]=.1;
      packetU.set([this.step,this.grid.sourceCell,u[8],config.capacity],4);
      packetF[8]=emission?.range ?? config.range;packetF[9]=emission?.speed ?? config.speed;packetU[10]=config.count ?? 64;packetU[11]=config.seed;
      if (config.direction) packetF.set([...config.direction,1,0],12);
      this.device.queue.writeBuffer(this.flightParams,0,packetData);
    }
  }
  private dispatch(encoder: GPUCommandEncoder, entry: string): void {
    const pass = encoder.beginComputePass();
    if (entry === 'velocity') {
      pass.setPipeline(this.velocityPipeline); pass.setBindGroup(0, this.velocityGroups[this.pressureIndex]);
      pass.dispatchWorkgroups(Math.ceil(this.grid.cols * this.grid.rows / 64)); pass.end(); return;
    }
    pass.setPipeline(this.compute[entry]);
    pass.setBindGroup(0, this.groups[this.current][this.pressureIndex]);
    pass.dispatchWorkgroups(Math.ceil(this.grid.cols * this.grid.rows / 64)); pass.end();
  }

  private prepareLight(): void {
    const light = this.grid.light!;
    const data = new ArrayBuffer(48), u = new Uint32Array(data), f = new Float32Array(data);
    const regions = Math.max(...this.grid.components) + 1;
    u.set([this.grid.cols, this.grid.rows, regions]);
    f.set([this.step * .1, light.drift, light.sun, light.background, light.rhythm, light.contrast, light.entrainment, 0], 4);
    this.device.queue.writeBuffer(this.lightParams, 0, data);
    const encoder = this.device.createCommandEncoder();
    for (const entry of ['illuminate', 'average', 'entrain', 'sources']) {
      const pass = encoder.beginComputePass(); pass.setPipeline(this.lightPipelines[entry]); pass.setBindGroup(0, this.lightGroup);
      pass.dispatchWorkgroups(entry === 'average' ? regions : Math.ceil(this.grid.cols * this.grid.rows / 64)); pass.end();
    }
    this.device.queue.submit([encoder.finish()]);
  }

  private async solveVents(): Promise<void> {
    const started = performance.now(), queue = this.device.queue;
    const rates = averagedVents(this.grid.vents!, this.sources?Math.floor(this.step/100)*10:Math.floor(this.step/10),this.sources?10:1);
    // Geometry is fixed until reset in this stand. Reuse only an exactly identical forcing.
    if (this.previousVentRates?.length === rates.length && rates.every((value,k) => value === this.previousVentRates![k])) return;
    queue.writeBuffer(this.ventEvents, 0, rates);
    const dispatch = (encoder: GPUCommandEncoder, pipeline: GPUComputePipeline) => {
      const pass = encoder.beginComputePass(); pass.setPipeline(pipeline); pass.setBindGroup(0,this.ventGroup);
      pass.dispatchWorkgroups(Math.ceil(this.grid.cols * this.grid.rows / 64)); pass.end();
    };
    const prepare = this.device.createCommandEncoder(); dispatch(prepare,this.ventPipelines[0]); queue.submit([prepare.finish()]);
    const cycles = Math.max(256,this.grid.cols ** 2 / 8);
    for (let start=0;start<cycles;start+=128) {
      const encoder=this.device.createCommandEncoder();
      for (let k=start;k<Math.min(start+128,cycles);k++) {
        dispatch(encoder,this.ventPipelines[1]); dispatch(encoder,this.ventPipelines[2]);
      }
      queue.submit([encoder.finish()]); await queue.onSubmittedWorkDone();
    }
    const encoder=this.device.createCommandEncoder(); this.dispatch(encoder,'velocity'); queue.submit([encoder.finish()]);
    await queue.onSubmittedWorkDone(); this.ventMilliseconds=performance.now()-started;
    this.previousVentRates = rates;
  }

  private async updateSources():Promise<void>{
    if(!this.sources||this.sourceUpdateStep===this.step)return;
    const m=await this.summary(),reservation=this.sources.update(this.step,m.available,m.reserved);
    const active=this.sources.active;if(active)this.grid.sourceCell=active.cell;
    if(reservation){
      this.device.queue.writeBuffer(this.sourceParams,0,new Uint32Array([this.grid.cols,this.grid.rows,reservation.cell,reservation.burst,reservation.effusion,0,0,0]));
      const encoder=this.device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(this.sourcePipelines[0]);pass.setBindGroup(0,this.sourceGroups[this.current]);pass.dispatchWorkgroups(1);pass.end();this.device.queue.submit([encoder.finish()]);
    }
    const sink=this.grid.vents!.at(-1)!;this.grid.vents=this.sources.events(sink);
    for(const cell of this.markerCells)this.device.queue.writeBuffer(this.markers,cell*16,new Float32Array(4));
    this.markerCells=this.sources.volcanoes.map(v=>v.cell);
    const codes={preparing:1,erupting:2,sleeping:3,fading:4};
    for(const v of this.sources.volcanoes)this.device.queue.writeBuffer(this.markers,v.cell*16,new Float32Array([codes[v.stage],v.power,v.begin,v.until]));
    this.sourceUpdateStep=this.step;
  }

  private refreshTerrain():void{
    const encoder=this.device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(this.mineralPipelines[2]);pass.setBindGroup(0,this.mineralGroups[this.current]);pass.dispatchWorkgroups(Math.ceil(this.grid.cols*this.grid.rows/64));pass.end();this.device.queue.submit([encoder.finish()]);this.previousVentRates=null;
  }

  /** Fixed model intervals include every short impulse through its exact interval integral. */
  async advanceDynamic(): Promise<void> {
    if(this.grid.mineral?.evolving&&this.step%100===0)this.refreshTerrain();
    if(this.sources&&this.step%100===0)await this.updateSources();
    if (this.step > 0 && this.step % 10 === 0) {
      this.writeParams();
      if (this.grid.light || this.grid.mineral?.evolving&&this.step%100===0) { if(this.grid.light)this.prepareLight(); await this.solvePressure(); }
      if (this.grid.vents) await this.solveVents();
    }
    this.advance();
  }

  advance(): void {
    if (this.lost) throw new Error('GPU потерян.');
    this.writeParams();
    if(this.geology){
      const time=this.step*(this.grid.mineral?.speed??1);this.geology.update(time);this.device.queue.writeBuffer(this.geologyEvents,0,this.geology.encoded());
      const data=new ArrayBuffer(32);new Uint32Array(data).set([this.grid.cols,this.grid.rows]);new Float32Array(data).set([this.grid.cell,time],2);new Uint32Array(data)[4]=this.geology.active.length;new Float32Array(data)[5]=this.grid.mineral?.speed??1;this.device.queue.writeBuffer(this.geologyParams,0,data);
    }
    const encoder = this.device.createCommandEncoder();
    this.dispatch(encoder, 'transfer'); this.dispatch(encoder, 'advance');
    if (this.grid.ballistics) {
      encoder.clearBuffer(this.landing);
      for(let i=0;i<this.flightPipelines.length;i++) {
        const pass=encoder.beginComputePass();pass.setPipeline(this.flightPipelines[i]);pass.setBindGroup(0,this.flightGroups[1-this.current]);
        pass.dispatchWorkgroups(i===0?1:Math.ceil((i===1?this.grid.ballistics.capacity:this.grid.cols*this.grid.rows)/64));pass.end();
      }
    }
    if(this.sources){
      for(const i of [1,2]){const pass=encoder.beginComputePass();pass.setPipeline(this.sourcePipelines[i]);pass.setBindGroup(0,this.sourceGroups[1-this.current]);pass.dispatchWorkgroups(i===1?1:Math.ceil(this.grid.cols*this.grid.rows/64));pass.end();}
    }
    if(this.grid.mineral){
      for(const pipeline of this.mineralPipelines.slice(0,2)){const pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,this.mineralGroups[1-this.current]);pass.dispatchWorkgroups(Math.ceil(this.grid.cols*this.grid.rows/64));pass.end();}
    }
    if(this.geology&&(this.grid.mineral?.speed??1)>0){
      for(let i=0;i<3;i++){const pass=encoder.beginComputePass();pass.setPipeline(this.geologyPipelines[i]);pass.setBindGroup(0,this.geologyGroup);pass.dispatchWorkgroups(i===2?1:Math.ceil(this.grid.cols*this.grid.rows/64));pass.end();}
    }
    this.device.queue.submit([encoder.finish()]); if(!this.grid.mineral)this.current = 1 - this.current; this.step++;
  }

  draw(arrows: boolean): void {
    if (this.lost || !this.grid) return;
    this.canvas.dataset.shape = this.grid.scene === 'circle' ? 'circle' : 'rectangle';
    const w = Math.max(1, Math.round(this.canvas.clientWidth * Math.min(devicePixelRatio, 2)));
    const h = Math.max(1, Math.round(w * this.grid.rows / this.grid.cols));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    const data = new ArrayBuffer(32), u = new Uint32Array(data), f = new Float32Array(data);
    u[0] = this.grid.cols; u[1] = this.grid.rows; f[2] = this.grid.cell; f[3] = this.step * .1;
    u[4] = Number(arrows); u[5] = Number(this.grid.scene === 'burst'); u[6] = Number(!!this.grid.light);
    this.device.queue.writeBuffer(this.view, 0, data);
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: this.context.getCurrentTexture().createView(),
      clearValue: { r: .05, g: .08, b: .1, a: 1 }, loadOp: 'clear', storeOp: 'store' }] });
    pass.setPipeline(this.render); pass.setBindGroup(0, this.renderGroups[this.current]); pass.draw(3);
    pass.setPipeline(this.flightRender);pass.setBindGroup(0,this.flightRenderGroup);pass.draw(6,this.grid.ballistics?.capacity ?? 1);pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  /** Full readback is for checks only; drawing never reads physics back to CPU. */
  async snapshot(): Promise<Snapshot> {
    const n = this.grid.cols * this.grid.rows, size = n * 60 + (this.grid.ballistics?.capacity ?? 1) * 64 + 16 + n*32;
    const buffer = this.device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(this.states[this.current], 0, buffer, 0, n * 16);
    encoder.copyBufferToBuffer(this.pressures[this.pressureIndex], 0, buffer, n * 16, n * 4);
    encoder.copyBufferToBuffer(this.flow, 0, buffer, n * 20, n * 8);
    encoder.copyBufferToBuffer(this.field, 0, buffer, n * 28, n * 16);
    encoder.copyBufferToBuffer(this.ventField, 0, buffer, n * 44, n * 16);
    encoder.copyBufferToBuffer(this.packets,0,buffer,n*60,(this.grid.ballistics?.capacity ?? 1)*64);
    encoder.copyBufferToBuffer(this.common,0,buffer,size-n*32-16,16);
    encoder.copyBufferToBuffer(this.terrain,0,buffer,size-n*32,n*16);
    encoder.copyBufferToBuffer(this.geometry,0,buffer,size-n*16,n*16);
    const step = this.step;
    this.device.queue.submit([encoder.finish()]);
    try {
      await buffer.mapAsync(GPUMapMode.READ);
      const copy = buffer.getMappedRange().slice(0);
      return { state: new Uint32Array(copy, 0, n * 4), pressure: new Float32Array(copy, n * 16, n),
        flow: new Float32Array(copy, n * 20, n * 2), field: new Float32Array(copy, n * 28, n * 4), vents: new Float32Array(copy,n*44,n*4), particles:new Float32Array(copy,n*60,(this.grid.ballistics?.capacity ?? 1)*16), reservoir:new Uint32Array(copy,size-n*32-16,4), terrain:new Uint32Array(copy,size-n*32,n*4), geometry:new Float32Array(copy,size-n*16,n*4), step };
    } finally { buffer.unmap(); buffer.destroy(); }
  }

  async summary() {
    this.writeParams();
    const grid = this.grid;
    const groups = Math.ceil(grid.cols * grid.rows / 64), size = groups * 48 + 32;
    const buffer = this.device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = this.device.createCommandEncoder(), pass = encoder.beginComputePass();
    pass.setPipeline(this.summaryPipeline); pass.setBindGroup(0, this.summaryGroups[this.current]);
    pass.dispatchWorkgroups(groups); pass.end(); encoder.copyBufferToBuffer(this.summaries, 0, buffer, 0, groups * 48);
    encoder.copyBufferToBuffer(this.flightLedger, 0, buffer, groups * 48, 16);
    encoder.copyBufferToBuffer(this.common,0,buffer,groups*48+16,16);
    const step = this.step; this.device.queue.submit([encoder.finish()]);
    try {
      await buffer.mapAsync(GPUMapMode.READ);
      const u = new Uint32Array(buffer.getMappedRange()), f = new Float32Array(u.buffer);
      let deposits=0,ground=0;
      let dissolved = 0, captured = 0, reserved = 0, flying = 0, maxSpeed = 0, residual = 0, scale = 0, leak = 0;
      for (let k = 0; k < groups * 12; k += 12) {
        dissolved += u[k]; captured += u[k + 1]; reserved += u[k + 2]; maxSpeed = Math.max(maxSpeed, f[k + 3]);
        residual += f[k + 4]; scale += f[k + 5]; leak += u[k + 6]; flying += u[k + 7];deposits+=u[k+8];ground+=u[k+9];
      }
      const available=u[groups*12+4],effusion=u[groups*12+5];
      return { step, deposits,ground,dissolved, captured, reserved:reserved+effusion, available, reservoirError:u[groups*12+7], flying, flightOverflow: u[groups * 12 + 3], maxSpeed: maxSpeed * grid.cell, leak,
        massError: deposits + ground + dissolved + captured + reserved + effusion + available + flying - grid.total,
        relativeResidual: scale ? Math.sqrt(residual / scale) : Math.sqrt(residual) };
    } finally { buffer.unmap(); buffer.destroy(); }
  }
}
