import flowViewShader from './flow-view.wgsl?raw';
import { flowBlend, type FlowMode } from './flow-view.ts';
import { layoutPartitions, layoutForSeed } from './generation/partitions.ts';
import { dishOf } from './generation/dish.ts';
import { PARTITION_THICKNESS } from './generation/constants.ts';
import funnelParticleShader from './funnel-particles.wgsl?raw';
import funnelParticleDrawing from './funnel-particles-render.wgsl?raw';
import courantShader from './advection-courant.wgsl?raw';
import multigridShader from './pressure-multigrid.wgsl?raw';
import surfaceShader from './surface.wgsl?raw';
import observationShader from './observe.wgsl?raw';
import materialShader from './material.wgsl?raw';
import type { Checkpoint } from './checkpoint.ts';
import { rippleBytes } from './legacy/ripple.ts';
import { lightOffset, lightDriftVelocity, sunRhythmAt } from './generation/light.ts';
import funnelShader from './funnels.wgsl?raw';
import { Funnels } from './funnels.ts';
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
import { glassShader } from './glass.ts';
import summaryShader from './summary.wgsl?raw';
import lightShader from './light.wgsl?raw';
import velocityShader from './velocity.wgsl?raw';
import sorShader from './pressure-sor.wgsl?raw';
import { type Grid } from './model.ts';

export interface Snapshot { state: Uint32Array; pressure: Float32Array; flow: Float32Array; field: Float32Array; vents: Float32Array; particles: Float32Array; reservoir: Uint32Array; terrain:Uint32Array; geometry:Float32Array; climate:Float32Array; step: number }
export type PressureMethod = 'sor' | 'jacobi' | 'multigrid';
export interface PressureOptions { method?: PressureMethod; iterations?: number }
export interface PressureResult { method: PressureMethod; iterations: number; passes: number; milliseconds: number }
export class GpuWorld {
  readonly device: GPUDevice;
  readonly adapter: GPUAdapter;
  readonly context: GPUCanvasContext;
  readonly canvas: HTMLCanvasElement;
  private observation!:GPUBuffer;
  private observations!:GPUBuffer;
  private observePipeline!:GPUComputePipeline;
  private observeGroup!:GPUBindGroup;
  private surface!:GPUBuffer;
  private rippleTexture:GPUTexture|null=null;
  private surfacePipeline!:GPUComputePipeline;
  private surfaceGroup!:GPUBindGroup;
  private material!:[GPUBuffer,GPUBuffer];
  private materialPipeline!:GPUComputePipeline;
  private materialGroups!:GPUBindGroup[];
  private profiling:GPUQuerySet|null=null;
  private lastEncodingMs=0;
  private transportSubsteps=1;
  private mineralSubsteps=1;
  private courantMaxima!:GPUBuffer;
  private courantPipeline!:GPUComputePipeline;
  private courantGroup!:GPUBindGroup;
  private uniform!: GPUBuffer;
  private view!: GPUBuffer;
  private glassGeometry!: GPUBuffer;
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
  private renderGroups!: GPUBindGroup[][];
  private visualFlow!:GPUBuffer;
  private visualFlowParams!:GPUBuffer;
  private visualFlowPipeline!:GPUComputePipeline;
  private visualFlowGroups!:GPUBindGroup[];
  private visualStocks!:GPUBuffer;
  private processView!:GPUBuffer;
  private visualFlowStep=-1;
  private visualFlowTime=0;
  private summaries!: GPUBuffer;
  private summaryPipeline!: GPUComputePipeline;
  private summaryGroups!: GPUBindGroup[];
  private multigridPipelines!:Record<string,GPUComputePipeline>;
  private multigridLevels:{cols:number;rows:number;group:GPUBindGroup}[]=[];
  private sor!: [GPUComputePipeline, GPUComputePipeline];
  private climate!:GPUBuffer;
  private field!: GPUBuffer;
  private lightIndexSize=[1,1];
  private lightParams!: GPUBuffer;
  private lightPipelines!: Record<string, GPUComputePipeline>;
  private lightGroup!: GPUBindGroup;
  private velocityPipeline!: GPUComputePipeline;
  private velocityGroups!: GPUBindGroup[];
  private ventField!: GPUBuffer;
  private ventEvents!: GPUBuffer;
  private ventPipelines!: GPUComputePipeline[];
  private ventGroup!: GPUBindGroup;
  funnels:Funnels|null=null;
  private funnelParticleParams!:GPUBuffer;
  private funnelParticleObjects!:GPUBuffer;
  private funnelParticles!:GPUBuffer;
  private funnelParticlePipeline!:GPUComputePipeline;
  private funnelParticleGroup!:GPUBindGroup;
  private funnelParticleRender!:GPURenderPipeline;
  private funnelParticleRenderGroup!:GPUBindGroup;
  private funnelParticleCapacity=0;
  private funnelMask!:GPUBuffer;
  private funnelPipelines!:GPUComputePipeline[];
  private funnelGroups!:GPUBindGroup[];
  geology:Geology|null=null;
  private geologyOrders!:GPUBuffer;
  private geologyResidues!:GPUBuffer;
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
  private visualBursts=new Map<number,{signature:string;start:number}>();
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
    const device = await adapter.requestDevice({requiredFeatures:adapter.features.has('timestamp-query')?['timestamp-query']:[]});
    return new GpuWorld(canvas, adapter, device);
  }

  private buffer(label: string, data: ArrayBufferView | number, usage: number): GPUBuffer {
    const size = typeof data === 'number' ? data : data.byteLength;
    const b = this.device.createBuffer({label,size,usage:usage|GPUBufferUsage.COPY_SRC}); this.buffers.push(b);
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
    this.rippleTexture?.destroy();
    for (const b of this.buffers) b.destroy(); this.buffers = [];
    this.grid = grid;this.funnels=grid.funnels?new Funnels(grid.funnels,grid.cols,grid.rows,grid.cell,grid.geometry):null;this.geology=grid.geology?new Geology(grid.geology,grid.width,grid.height):null; this.sources=grid.sources?new Sources(grid.sources):null;this.sourceUpdateStep=-1;this.markerCells=[];this.visualBursts.clear(); this.step = 0;this.transportSubsteps=1;this.mineralSubsteps=1; this.current = 0; this.pressureIndex = 0;
    const d = this.device, n = grid.cols * grid.rows;
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    this.uniform = this.buffer('physics params', 64, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.view = this.buffer('render params', 64, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    // Display geometry uses the actual layout, independent of the collision raster.
    const glass = new Float32Array(4 + 64 * 4);
    if(grid.scene==='world' && grid.params){
      glass[1]=1;
      for(const part of layoutPartitions(layoutForSeed(grid.params.seed),dishOf(grid.params))){
        for(let i=1;i<part.points.length;i++){
          const a=part.points[i-1],b=part.points[i],at=4+glass[0]*4;
          if(glass[0]>=64)throw new Error('Слишком много отрезков перегородок');
          glass.set([(a[0]+b[0])/2,(a[1]+b[1])/2,(Math.abs(a[0]-b[0])+PARTITION_THICKNESS)/2,(Math.abs(a[1]-b[1])+PARTITION_THICKNESS)/2],at);
          glass[0]++;
        }
      }
    }
    this.glassGeometry=this.buffer('continuous glass geometry',glass,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
    this.geometry = this.buffer('geometry', grid.geometry, storage);
    this.terrain=this.buffer('ground and deposits',grid.terrain??new Uint32Array(n*4),storage);
    this.climate=this.buffer('spot intensity and temperature',n*16,storage);
    this.field = this.buffer('physical light field', n * 16, storage);
    this.common=this.buffer('shared underground',new Uint32Array([grid.underground??0,0,0,0]),storage);
    this.funnelMask=this.buffer('funnel influence',n*16,storage);
    this.markers=this.buffer('volcano markers',n*32,storage);
    this.packets = this.buffer('ballistic packets', (grid.ballistics?.capacity ?? 1) * 64, storage);
    this.landing = this.buffer('atomic landings', n * 8, storage);
    this.flightLedger = this.buffer('flight ledger', 16, storage);
    this.observation=this.buffer('observation counters',16,storage);
    this.observations=this.buffer('observation statistics',48,storage);
    this.ventField = this.buffer('screened push field', n * 16, storage);
    this.ventMilliseconds = 0;
    this.previousVentRates = null;
    const material=Float32Array.from({length:n*4},(_,i)=>i%2===0?(Math.floor(i/4)%grid.cols+.5):(Math.floor(Math.floor(i/4)/grid.cols)+.5));
    this.material=[this.buffer('material A',material,storage),this.buffer('material B',material,storage)];
    const materialModule=d.createShaderModule({code:materialShader});
    this.materialPipeline=await d.createComputePipelineAsync({layout:'auto',compute:{module:materialModule,entryPoint:'advect'}});
    this.states = [this.buffer('state A', grid.state, storage), this.buffer('state B', grid.state, storage)];
    this.pressures = [this.buffer('pressure A', n * 4, storage), this.buffer('pressure B', n * 4, storage)];
    this.flow = this.buffer('face velocities', n * 8, storage);
    this.visualFlowStep=-1;this.visualFlowTime=0;
    // Presentation-only fields are excluded from checkpoints and physical state.
    this.visualFlow=this.buffer('observation smoothed flow',n*32,storage);
    this.visualStocks=this.buffer('observation previous stocks',n*16,storage);
    this.visualFlowParams=this.buffer('observation flow params',32,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
    this.processView=this.buffer('observation process view',16,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
    const visualFlowModule=d.createShaderModule({label:'flow presentation',code:flowViewShader});
    const flowErrors=(await visualFlowModule.getCompilationInfo()).messages.filter(m=>m.type==='error');
    if(flowErrors.length)throw new Error(flowErrors.map(m=>`Вид течений ${m.lineNum}:${m.linePos}: ${m.message}`).join('\n'));
    this.visualFlowPipeline=await d.createComputePipelineAsync({layout:'auto',compute:{module:visualFlowModule,entryPoint:'filterFlow'}});

    this.courantMaxima=this.buffer('advection face maxima',Math.ceil(n/64)*4,storage);
    this.courantPipeline=await d.createComputePipelineAsync({layout:'auto',compute:{module:d.createShaderModule({code:courantShader}),entryPoint:'maximum'}});
    this.courantGroup=d.createBindGroup({layout:this.courantPipeline.getBindGroupLayout(0),entries:[this.uniform,this.geometry,this.flow,this.courantMaxima].map((buffer,binding)=>({binding,resource:{buffer}}))});
    this.surface=this.buffer('render surface climate',n*32,storage);
    this.surfacePipeline=await d.createComputePipelineAsync({layout:'auto',compute:{module:d.createShaderModule({code:surfaceShader}),entryPoint:'pack'}});
    this.surfaceGroup=d.createBindGroup({layout:this.surfacePipeline.getBindGroupLayout(0),entries:[this.uniform,this.geometry,this.climate,this.surface].map((buffer,binding)=>({binding,resource:{buffer}}))});
    this.materialGroups=[0,1].map(i=>d.createBindGroup({layout:this.materialPipeline.getBindGroupLayout(0),entries:[this.uniform,this.geometry,this.flow,this.material[i],this.material[1-i]].map((buffer,binding)=>({binding,resource:{buffer}}))}));
    this.observePipeline=await d.createComputePipelineAsync({layout:'auto',compute:{module:d.createShaderModule({code:observationShader}),entryPoint:'observe'}});
    this.observeGroup=d.createBindGroup({layout:this.observePipeline.getBindGroupLayout(0),entries:[this.uniform,this.geometry,this.flow,this.observation,this.observations].map((buffer,binding)=>({binding,resource:{buffer}}))});

    this.outgoing = this.buffer('integer transfers', n * 16, storage);
    this.carry = this.buffer('fractional transfer residues', n * 32, storage);
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
    for (const entryPoint of ['solve', 'velocity', 'transfer', 'advance','captureHoles']) {
      this.compute[entryPoint] = await d.createComputePipelineAsync({ layout: pipelineLayout, compute: { module, entryPoint } });
    }
    this.groups = [0, 1].map(s => [0, 1].map(p => d.createBindGroup({ layout, entries:
      [this.uniform, this.geometry, this.states[s], this.states[1 - s], this.pressures[p], this.pressures[1 - p],
        this.flow, this.outgoing, this.carry].map((buffer, binding) => ({ binding, resource: { buffer } })) })));
    const renderModule = d.createShaderModule({ label: 'surface image', code: drawing.replace('// SHARED_GLASS_MATERIAL', glassShader) });
    const renderErrors=(await renderModule.getCompilationInfo()).messages.filter(message=>message.type==='error');
    if(renderErrors.length)throw new Error(renderErrors.map(message=>`render.wgsl:${message.lineNum}:${message.linePos} ${message.message}`).join('\n'));
    this.render = await d.createRenderPipelineAsync({ layout: 'auto',
      vertex: { module: renderModule, entryPoint: 'vertex' },
      fragment: { module: renderModule, entryPoint: 'fragment', targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }] },
    });
    this.rippleTexture=d.createTexture({label:'original world ripple',size:[256,256],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
    d.queue.writeTexture({texture:this.rippleTexture},rippleBytes(),{bytesPerRow:1024},[256,256]);
    const rippleSampler=d.createSampler({addressModeU:'repeat',addressModeV:'repeat',magFilter:'linear',minFilter:'linear'});
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
    const sorData = new ArrayBuffer(16); new Uint32Array(sorData).set([grid.cols, grid.rows]); new Float32Array(sorData)[2] = grid.scene==='world'?1.95:grid.light ? 1.6 : 1.95;
    const sorParams = this.buffer('SOR dimensions', new Uint8Array(sorData), GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.sorGroup = d.createBindGroup({ layout: sorLayout, entries: [sorParams, this.geometry, this.pressures[0]]
      .map((buffer, binding) => ({ binding, resource: { buffer } })) });
    const mgLayout=d.createBindGroupLayout({entries:Array.from({length:6},(_,binding)=>({binding,visibility:GPUShaderStage.COMPUTE,buffer:{type:binding===5?'read-only-storage':binding===0?'uniform':'storage'}}))});
    const mgModule=d.createShaderModule({code:multigridShader}),mgPipelineLayout=d.createPipelineLayout({bindGroupLayouts:[mgLayout]});this.multigridPipelines={};
    for(const entryPoint of ['initialize','red','black','restrictResidual','prolong','coarseSolve'])this.multigridPipelines[entryPoint]=await d.createComputePipelineAsync({layout:mgPipelineLayout,compute:{module:mgModule,entryPoint}});
    const levels=[{cols:grid.cols,rows:grid.rows,geometry:this.buffer('multigrid fine matrix',n*16,storage),pressure:this.pressures[0]}];
    while(Math.max(levels.at(-1)!.cols,levels.at(-1)!.rows)>16){const parent=levels.at(-1)!,cols=Math.ceil(parent.cols/2),rows=Math.ceil(parent.rows/2);levels.push({cols,rows,geometry:this.buffer(`multigrid geometry ${levels.length}`,cols*rows*16,storage),pressure:this.buffer(`multigrid pressure ${levels.length}`,cols*rows*4,storage)});}
    const dummyGeo=this.buffer('multigrid dummy geometry',16,storage),dummyPressure=this.buffer('multigrid dummy pressure',4,storage);
    this.multigridLevels=levels.map((level,i)=>{const child=levels[i+1],data=new ArrayBuffer(32);new Uint32Array(data).set([level.cols,level.rows,child?.cols??1,child?.rows??1]);new Float32Array(data)[4]=1.7;
      const params=this.buffer(`multigrid parameters ${i}`,new Uint8Array(data),GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
      return {cols:level.cols,rows:level.rows,group:d.createBindGroup({layout:mgLayout,entries:[params,level.geometry,level.pressure,child?.geometry??dummyGeo,child?.pressure??dummyPressure,this.geometry].map((buffer,binding)=>({binding,resource:{buffer}}))})};});
    this.velocityPipeline = await d.createComputePipelineAsync({ layout: 'auto', compute: {
      module: d.createShaderModule({code: velocityShader}), entryPoint: 'velocity' } });
    this.velocityGroups = this.pressures.map(pressure => d.createBindGroup({ layout: this.velocityPipeline.getBindGroupLayout(0), entries:
      [this.uniform, this.geometry, pressure, this.flow, this.field, this.ventField].map((buffer, binding) => ({binding, resource: {buffer}})) }));
    let visualBlobs!:GPUBuffer,visualIndex!:GPUBuffer;
    if (grid.light) {
      const regions = Math.max(...grid.components) + 1;
      this.lightParams = this.buffer('light parameters', 112, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      const areas = this.buffer('closed regions', grid.components, storage);
      const means = this.buffer('mean light per region', regions * 4, storage);
      const encoded:number[]=[];for(const spot of grid.lightMap?.spots??[])for(const b of spot.blobs)encoded.push(spot.x0,spot.y0,b.radius,b.aspect,b.a0,b.wa,spot.vx,spot.vy,b.ax,b.wx,b.px,b.ay,b.wy,b.py,b.wr,b.pr,b.e3,b.p3,b.w3,b.e5,b.p5,b.w5,0,0,...new Array(16).fill(0));
      let reach=1;for(const spot of grid.lightMap?.spots??[])for(const b of spot.blobs)reach=Math.max(reach,b.radius*Math.sqrt(b.aspect)*1.14*1.35);
      this.lightIndexSize=[Math.max(1,Math.min(512,Math.floor(grid.width*2/reach))),Math.max(1,Math.min(512,Math.floor(grid.height*2/reach)))];
      const blobs=this.buffer('indexed light blobs',encoded.length?new Float32Array(encoded):new Float32Array(40),storage),index=this.buffer('light spatial index',this.lightIndexSize[0]*this.lightIndexSize[1]*4,storage);
      visualBlobs=blobs;visualIndex=index;
      const lightLayout = d.createBindGroupLayout({entries: [
        {binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: {type: 'uniform'}},
        ...[1,2,3,4,5,6,7].map(binding => ({binding, visibility: GPUShaderStage.COMPUTE, buffer: {type: binding === 2 ? 'read-only-storage' as const : 'storage' as const}}))]});
      const pipelineLayout = d.createPipelineLayout({bindGroupLayouts: [lightLayout]});
      const module = d.createShaderModule({code: lightShader}); this.lightPipelines = {};
      for (const entryPoint of ['clearIndex','prepareBlobs','illuminate', 'average', 'entrain', 'sources']) this.lightPipelines[entryPoint] = await d.createComputePipelineAsync({layout: pipelineLayout, compute: {module, entryPoint}});
      this.lightGroup = d.createBindGroup({layout: lightLayout, entries: [this.lightParams, this.geometry, areas, this.field, means,blobs,this.climate,index].map((buffer, binding) => ({binding, resource: {buffer}}))});
    }
    if(!grid.light){
      this.lightParams=this.buffer('visual light parameters',112,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
      visualBlobs=this.buffer('visual light placeholder',160,storage);
      visualIndex=this.buffer('visual light index placeholder',new Uint32Array([0xffffffff]),storage);
    }
    // Eight storage bindings: reuse the prepared spatial index instead of adding a light raster pass.
    this.visualFlowGroups=this.states.map(state=>d.createBindGroup({layout:this.visualFlowPipeline.getBindGroupLayout(0),entries:[this.visualFlowParams,this.geometry,this.flow,this.visualFlow,this.terrain,state,this.visualStocks].map((buffer,binding)=>({binding,resource:{buffer}}))}));
    this.renderGroups=this.states.map(state=>[0,1].map(material=>d.createBindGroup({layout:this.render.getBindGroupLayout(0),entries:[
      ...[this.view,this.surface,state,this.visualFlow,visualBlobs,visualIndex,this.markers,this.terrain,this.material[material]].map((buffer,binding)=>({binding,resource:{buffer}})),
      {binding:9,resource:this.rippleTexture!.createView()},{binding:10,resource:rippleSampler},{binding:11,resource:{buffer:this.lightParams}},{binding:12,resource:{buffer:this.glassGeometry}},{binding:13,resource:{buffer:this.processView}}
    ]})));
    if (grid.vents) {
      const settings = new ArrayBuffer(32); new Uint32Array(settings).set([grid.cols, grid.rows, grid.vents.length]);
      new Float32Array(settings).set([grid.cell, grid.pushLength ?? 200, 1.6, 0],4);
      const uniform = this.buffer('push settings', new Uint8Array(settings), GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      this.ventEvents = this.buffer('integrated push events', grid.vents.length * 16, storage);
      const layout = d.createBindGroupLayout({entries: [
        {binding:0, visibility:GPUShaderStage.COMPUTE, buffer:{type:'uniform'}},
        ...[1,2,3,4].map(binding => ({binding, visibility:GPUShaderStage.COMPUTE, buffer:{type:binding === 3 ? 'storage' as const : 'read-only-storage' as const}}))]});
      const module = d.createShaderModule({code:ventsShader}), pipelineLayout = d.createPipelineLayout({bindGroupLayouts:[layout]});
      this.ventPipelines = [];
      for (const entryPoint of ['prepare','red','black']) this.ventPipelines.push(await d.createComputePipelineAsync({layout:pipelineLayout,compute:{module,entryPoint}}));
      this.ventGroup = d.createBindGroup({layout, entries:[uniform,this.geometry,this.ventEvents,this.ventField,this.funnelMask].map((buffer,binding)=>({binding,resource:{buffer}}))});
    }
    if(grid.sources||grid.funnels){
      this.sourceParams=this.buffer('underground exchange parameters',32,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
      const layout=d.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:'uniform'}},...[1,2,3].map(binding=>({binding,visibility:GPUShaderStage.COMPUTE,buffer:{type:'storage' as const}}))]});
      const module=d.createShaderModule({code:reservoirShader}),pipelineLayout=d.createPipelineLayout({bindGroupLayouts:[layout]});
      const compilation=await module.getCompilationInfo();const failures=compilation.messages.filter(m=>m.type==='error');if(failures.length)throw new Error(failures.map(m=>`Недра ${m.lineNum}: ${m.message}`).join('\n'));
      this.sourcePipelines=[];for(const entryPoint of ['reserve','effuse','collect'])this.sourcePipelines.push(await d.createComputePipelineAsync({layout:pipelineLayout,compute:{module,entryPoint}}));
      this.sourceGroups=this.states.map(state=>d.createBindGroup({layout,entries:[this.sourceParams,this.common,state,this.observation].map((buffer,binding)=>({binding,resource:{buffer}}))}));
    }
    if(grid.mineral){
      // Explicit diffusion must retain its physical rate when the grid becomes finer.
      this.mineralSubsteps=Math.max(1,Math.ceil(4*grid.mineral.diffusion*.1/(grid.cell*grid.cell*.45)));
      if(this.mineralSubsteps%2===0)this.mineralSubsteps++;
      const settings=new ArrayBuffer(80);new Uint32Array(settings).set([grid.cols,grid.rows]);new Uint32Array(settings)[8]=Math.round(grid.cell*grid.cell*(grid.mineral.full?30:.02)/(grid.quantum??.001));
      new Float32Array(settings).set([grid.cell,.1/this.mineralSubsteps,grid.mineral.diffusion,grid.mineral.settling,grid.mineral.dissolution,grid.mineral.runoff],2);
      new Float32Array(settings).set([grid.mineral.erosion??0,grid.mineral.weathering??0,grid.mineral.speed??1],12);new Uint32Array(settings)[15]=Number(grid.mineral.evolving??false);new Float32Array(settings)[16]=grid.quantum??.001;new Float32Array(settings)[17]=grid.mineral.full?20:.02;new Uint32Array(settings)[18]=Number(grid.mineral.full??false);
      const params=this.buffer('mineral parameters',new Uint8Array(settings),GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
      const residues=this.buffer('spread residues',n*16,storage),phases=this.buffer('phase residues',n*16,storage);
      const layout=d.createBindGroupLayout({entries:Array.from({length:9},(_,binding)=>({binding,visibility:GPUShaderStage.COMPUTE,buffer:{type:binding===0?'uniform':[2,5].includes(binding)?'read-only-storage':'storage'}}))});
      const module=d.createShaderModule({code:mineralShader}),pipelineLayout=d.createPipelineLayout({bindGroupLayouts:[layout]});
      const compilation=await module.getCompilationInfo();const failures=compilation.messages.filter(m=>m.type==='error');if(failures.length)throw new Error(failures.map(m=>`Минерал ${m.lineNum}: ${m.message}`).join('\n'));
      this.mineralPipelines=[];for(const entryPoint of ['spread','phases','refresh'])this.mineralPipelines.push(await d.createComputePipelineAsync({layout:pipelineLayout,compute:{module,entryPoint}}));
      this.mineralGroups=this.states.map((state,i)=>d.createBindGroup({layout,entries:[params,this.geometry,state,this.states[1-i],this.terrain,this.flow,this.outgoing,residues,phases].map((buffer,binding)=>({binding,resource:{buffer}}))}));
    }
    if(grid.geology){
      this.geologyParams=this.buffer('geology parameters',48,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);this.geologyEvents=this.buffer('geology events',16*48,storage);
      const orders=this.geologyOrders=this.buffer('geology requests',n*8,storage),residues=this.geologyResidues=this.buffer('geology residues',n*8,storage);
      const blockTotals=this.buffer('geology block prefixes',(Math.ceil(n/64)+1)*8,storage);
      const layout=d.createBindGroupLayout({entries:Array.from({length:8},(_,binding)=>({binding,visibility:GPUShaderStage.COMPUTE,buffer:{type:binding===0?'uniform':[1,2].includes(binding)?'read-only-storage':'storage'}}))});
      const module=d.createShaderModule({code:geologyShader}),pipelineLayout=d.createPipelineLayout({bindGroupLayouts:[layout]});const compilation=await module.getCompilationInfo();const failures=compilation.messages.filter(m=>m.type==='error');if(failures.length)throw new Error(failures.map(m=>`Подвижки ${m.lineNum}: ${m.message}`).join('\n'));
      this.geologyPipelines=[];for(const entryPoint of ['request','lower','totals','reserveRaise','allocate'])this.geologyPipelines.push(await d.createComputePipelineAsync({layout:pipelineLayout,compute:{module,entryPoint}}));
      this.geologyGroup=d.createBindGroup({layout,entries:[this.geologyParams,this.geometry,this.geologyEvents,this.terrain,this.common,orders,residues,blockTotals].map((buffer,binding)=>({binding,resource:{buffer}}))});
    }
    if(grid.funnels){
      this.funnelParticleCapacity=Math.min(n,Math.ceil(grid.width*grid.height/(grid.funnels.minimumArea??1920))+1);
      this.funnelParticleParams=this.buffer('funnel particle parameters',32,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
      this.funnelParticleObjects=this.buffer('funnel particle emitters',this.funnelParticleCapacity*16,storage);
      this.funnelParticles=this.buffer('funnel visual particles',this.funnelParticleCapacity*40*32,storage);
      const particleModule=d.createShaderModule({code:funnelParticleShader});
      this.funnelParticlePipeline=await d.createComputePipelineAsync({layout:'auto',compute:{module:particleModule,entryPoint:'advect'}});
      this.funnelParticleGroup=d.createBindGroup({layout:this.funnelParticlePipeline.getBindGroupLayout(0),entries:[this.funnelParticleParams,this.geometry,this.flow,this.funnelParticleObjects,this.funnelParticles].map((buffer,binding)=>({binding,resource:{buffer}}))});
      const particleDrawing=d.createShaderModule({code:funnelParticleDrawing});
      this.funnelParticleRender=await d.createRenderPipelineAsync({layout:'auto',vertex:{module:particleDrawing,entryPoint:'vertex'},fragment:{module:particleDrawing,entryPoint:'fragment',targets:[{format:navigator.gpu.getPreferredCanvasFormat(),blend:{color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha',operation:'add'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'}}}]}});
      this.funnelParticleRenderGroup=d.createBindGroup({layout:this.funnelParticleRender.getBindGroupLayout(0),entries:[this.view,this.funnelParticles].map((buffer,binding)=>({binding,resource:{buffer}}))});
      const data=new ArrayBuffer(32);new Uint32Array(data).set([grid.cols,grid.rows,this.funnels!.shape,0]);new Float32Array(data)[4]=grid.mineral?.speed??1;
      const params=this.buffer('funnel parameters',new Uint8Array(data),GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
      const layout=d.createBindGroupLayout({entries:Array.from({length:5},(_,binding)=>({binding,visibility:GPUShaderStage.COMPUTE,buffer:{type:binding===0?'uniform':binding===4?'read-only-storage':'storage'}}))});
      const module=d.createShaderModule({code:funnelShader}),pipelineLayout=d.createPipelineLayout({bindGroupLayouts:[layout]});const compilation=await module.getCompilationInfo();const failures=compilation.messages.filter(m=>m.type==='error');if(failures.length)throw new Error(failures.map(m=>`Воронки ${m.lineNum}: ${m.message}`).join('\n'));
      this.funnelPipelines=[];for(const entryPoint of ['mark','lift'])this.funnelPipelines.push(await d.createComputePipelineAsync({layout:pipelineLayout,compute:{module,entryPoint}}));this.funnelGroups=this.states.map(state=>d.createBindGroup({layout,entries:[params,this.geometry,this.terrain,state,this.funnelMask].map((buffer,binding)=>({binding,resource:{buffer}}))}));
    }
    const flightModule = d.createShaderModule({code:flightDrawing});
    this.flightRender = await d.createRenderPipelineAsync({layout:'auto', vertex:{module:flightModule,entryPoint:'vertex'}, fragment:{module:flightModule,entryPoint:'fragment',targets:[{format:navigator.gpu.getPreferredCanvasFormat(),blend:{color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha',operation:'add'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'}}}]}});
    this.flightRenderGroup = d.createBindGroup({layout:this.flightRender.getBindGroupLayout(0),entries:[this.view,this.packets].map((buffer,binding)=>({binding,resource:{buffer}}))});
    if (grid.ballistics) {
      this.flightParams = this.buffer('ballistic parameters',64,GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      const layout=d.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:'uniform'}},...[1,2,3,4,5,6,7].map(binding=>({binding,visibility:GPUShaderStage.COMPUTE,buffer:{type:[1,5].includes(binding)?'read-only-storage' as const:'storage' as const}}))]});
      const module=d.createShaderModule({code:ballisticShader}),pipelineLayout=d.createPipelineLayout({bindGroupLayouts:[layout]});
      const compilation = await module.getCompilationInfo();
      const errors = compilation.messages.filter(message => message.type === 'error');
      if (errors.length) throw new Error(errors.map(message => `Баллистика ${message.lineNum}:${message.linePos}: ${message.message}`).join('\n'));
      this.flightPipelines=[];
      for(const entryPoint of ['spawn','fly','gather']) this.flightPipelines.push(await d.createComputePipelineAsync({layout:pipelineLayout,compute:{module,entryPoint}}));
      this.flightGroups=this.states.map(state=>d.createBindGroup({layout,entries:[this.flightParams,this.geometry,state,this.packets,this.landing,this.flow,this.flightLedger,this.observation].map((buffer,binding)=>({binding,resource:{buffer}}))}));
    }
    const error = await d.popErrorScope(); if (error) throw new Error(error.message);
    this.writeParams();
    if(grid.mineral?.evolving)this.refreshTerrain();
    if (grid.light) this.prepareLight();
    await this.solvePressure(options);
    if (grid.vents) await this.solveVents();
    await this.updateTransportSubsteps();
    if (this.errors.length) throw new Error(this.errors.join('\n'));
  }

  private async solveMultigrid():Promise<PressureResult>{
    const start=performance.now();this.pressureIndex=0;let passes=0;
    if(this.step===0){const clear=this.device.createCommandEncoder();clear.clearBuffer(this.pressures[0]);this.device.queue.submit([clear.finish()]);}
    const dispatch=(encoder:GPUCommandEncoder,entry:string,level:number)=>{const l=this.multigridLevels[level],count=entry==='restrictResidual'?this.multigridLevels[level+1].cols*this.multigridLevels[level+1].rows:l.cols*l.rows;const p=encoder.beginComputePass();p.setPipeline(this.multigridPipelines[entry]);p.setBindGroup(0,l.group);p.dispatchWorkgroups(entry==='coarseSolve'?1:Math.ceil(count/64));p.end();passes++;};
    const smooth=(e:GPUCommandEncoder,l:number,count:number)=>{for(let i=0;i<count;i++){dispatch(e,'red',l);dispatch(e,'black',l);}};
    const cycle=(e:GPUCommandEncoder,l:number)=>{if(l===this.multigridLevels.length-1){dispatch(e,'coarseSolve',l);return;}smooth(e,l,8);dispatch(e,'restrictResidual',l);cycle(e,l+1);dispatch(e,'prolong',l);smooth(e,l,8);};
    const initialize=this.device.createCommandEncoder();dispatch(initialize,'initialize',0);this.device.queue.submit([initialize.finish()]);
    const cycles=this.step===0?24:8;
    for(let i=0;i<cycles;i++){const e=this.device.createCommandEncoder();cycle(e,0);this.device.queue.submit([e.finish()]);await this.device.queue.onSubmittedWorkDone();}
    const e=this.device.createCommandEncoder();smooth(e,0,64);this.dispatch(e,'velocity');this.device.queue.submit([e.finish()]);await this.device.queue.onSubmittedWorkDone();
    return this.pressureResult={method:'multigrid',iterations:cycles,passes,milliseconds:performance.now()-start};
  }

  /** Solve the same equation from zero; preserves mineral/step and allows an honest solver comparison. */
  async solvePressure(options: PressureOptions = {}): Promise<PressureResult> {
    const d = this.device, method = options.method ?? (this.grid.scene==='world'&&Math.max(this.grid.cols,this.grid.rows)>=192?'multigrid':'sor');
    if(method==='multigrid')return this.solveMultigrid();
    const iterations = options.iterations ?? (method === 'jacobi'
      ? this.grid.cols ** 2 * (this.grid.scene === 'passage' ? 32 : 4)
      : this.grid.scene==='world'&&this.step>0?Math.max(512,this.grid.cols**2/32):Math.max(256, this.grid.cols ** 2 * (this.grid.scene === 'passage' ? 1 : this.grid.light ? 1 / 2 : 1 / 8)));
    this.pressureIndex = 0;
    const started = performance.now(), clear = d.createCommandEncoder();
    if(!(method==='sor'&&this.grid.scene==='world'&&this.step>0))for (const buffer of this.pressures) clear.clearBuffer(buffer);
    d.queue.submit([clear.finish()]);
    const chunk = method === 'sor' ? 128 : 256;
    for (let start = 0; start < iterations; start += chunk) {
      const encoder = d.createCommandEncoder();
      for (let i = start; i < Math.min(start + chunk, iterations); i++) {
        if (method === 'jacobi') { this.dispatch(encoder, 'solve'); this.pressureIndex = 1 - this.pressureIndex; }
        else {
          for (const pipeline of this.sor) {
            const pass = encoder.beginComputePass(); pass.setPipeline(pipeline); pass.setBindGroup(0,this.sorGroup);
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
    const data = new ArrayBuffer(64), u = new Uint32Array(data), f = new Float32Array(data);
    u[0] = this.grid.cols; u[1] = this.grid.rows; f[2] = this.grid.cell; f[3] = .1/this.transportSubsteps;
    u[4] = this.step; u[5] = this.grid.sourceCell; u[6] = this.grid.ballistics ? 3 : this.grid.vents ? 2 : Number(this.grid.scene === 'burst'); u[7] = Number(!!this.grid.light);
    const emitter = this.grid.vents?.find(vent => !!vent.mass);
    const emission=this.sources?.emission(this.step);
    u[11]=this.funnels?.shape??0;f[12]=this.grid.quantum??.001;f[13]=Number(this.grid.scene==='world');
    u[8] = emission?.burst ?? (emitter ? emittedQuanta(emitter, this.step) : 0);
    if(this.sources||this.funnels){const params=new Uint32Array([this.grid.cols,this.grid.rows,this.grid.sourceCell,0,0,emission?.effusion??0,0,0]);this.device.queue.writeBuffer(this.sourceParams,0,params);}
    this.device.queue.writeBuffer(this.uniform,0,data);
    if (this.grid.ballistics) {
      const config=this.grid.ballistics, packetData=new ArrayBuffer(64), packetU=new Uint32Array(packetData), packetF=new Float32Array(packetData);
      packetU.set([this.grid.cols,this.grid.rows]);packetF[2]=this.grid.cell;packetF[3]=.1;
      packetU.set([this.step,this.grid.sourceCell,u[8],config.capacity],4);
      packetF[8]=emission?.range ?? config.range;packetF[9]=emission?.speed ?? config.speed;packetU[10]=config.count ?? 64;packetU[11]=config.seed;
      if (config.direction) packetF.set([...config.direction,1,0],12);
      this.device.queue.writeBuffer(this.flightParams,0,packetData);
    }
  }
  private dispatch(encoder: GPUCommandEncoder, entry: string,timestamp=true): void {
    const pass = encoder.beginComputePass(timestamp&&this.profiling&&entry==='transfer'?{timestampWrites:{querySet:this.profiling,beginningOfPassWriteIndex:0}}:undefined);
    if (entry === 'velocity') {
      pass.setPipeline(this.velocityPipeline); pass.setBindGroup(0,this.velocityGroups[this.pressureIndex]);
      pass.dispatchWorkgroups(Math.ceil(this.grid.cols * this.grid.rows / 64)); pass.end(); return;
    }
    pass.setPipeline(this.compute[entry]);
    pass.setBindGroup(0,this.groups[this.current][this.pressureIndex]);
    pass.dispatchWorkgroups(Math.ceil(this.grid.cols * this.grid.rows / 64)); pass.end();
  }

  private prepareLight(): void {
    const light=this.grid.light!,map=this.grid.lightMap,data=new ArrayBuffer(112),u=new Uint32Array(data),f=new Float32Array(data),regions=Math.max(...this.grid.components)+1;
    const count=map?.spots.reduce((sum,spot)=>sum+spot.blobs.length,0)??0;u.set([this.grid.cols,this.grid.rows,regions,count]);
    f.set([this.step*.1,light.drift,light.sun,light.background,light.rhythm,light.contrast,light.entrainment,0],4);
    f.set([this.grid.width,this.grid.height,this.grid.params?.baseTemperature??1,this.grid.params?.spotHeat??1],12);
    if(map){f.set([...lightOffset(map,this.step),...lightDriftVelocity(map,this.step)],16);f.set([map.rhythm.period*.1,map.rhythm.phase,0,0],20);}
    f.set([...this.lightIndexSize,0,0],24);
    this.device.queue.writeBuffer(this.lightParams,0,data);
    const encoder=this.device.createCommandEncoder();
    for(const entry of ['clearIndex','prepareBlobs','illuminate','average','entrain','sources']){
      const pass=encoder.beginComputePass();pass.setPipeline(this.lightPipelines[entry]);pass.setBindGroup(0,this.lightGroup);pass.dispatchWorkgroups(entry==='average'?regions:Math.ceil((entry==='clearIndex'?this.lightIndexSize[0]*this.lightIndexSize[1]:entry==='prepareBlobs'?Math.max(1,count):this.grid.cols*this.grid.rows)/64));pass.end();
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
    const cycles = this.grid.scene==='world'?Math.max(256,this.grid.cols**2/32):Math.max(256,this.grid.cols ** 2 / 8);
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
    for(const cell of this.markerCells)this.device.queue.writeBuffer(this.markers,cell*32,new Float32Array(8));
    this.markerCells=this.sources.volcanoes.map(v=>v.cell);
    const codes={preparing:1,erupting:2,sleeping:3,fading:4};
    for(const v of this.sources.volcanoes)this.device.queue.writeBuffer(this.markers,v.cell*32,new Float32Array([codes[v.stage],v.power,v.begin,v.until,0,0,0,0]));
    this.sourceUpdateStep=this.step;
  }

  private async updateFunnels():Promise<void>{
    if(!this.funnels)return;const n=this.grid.cols*this.grid.rows,buffer=this.device.createBuffer({size:n*16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),encoder=this.device.createCommandEncoder();encoder.copyBufferToBuffer(this.terrain,0,buffer,0,n*16);this.device.queue.submit([encoder.finish()]);
    try{await buffer.mapAsync(GPUMapMode.READ);const terrain=new Uint32Array(buffer.getMappedRange().slice(0));this.funnels.update(this.step,terrain,this.grid.mineral?.speed??1);if(this.sources)this.sources.siteWeights=this.funnels.siteWeights(terrain);this.device.queue.writeBuffer(this.funnelMask,0,this.funnels.mask());}
    finally{buffer.unmap();buffer.destroy();}
    if(this.funnels.active.length>this.funnelParticleCapacity)throw new Error('Превышена ёмкость визуальных воронок.');
    if(this.funnels.active.length)this.device.queue.writeBuffer(this.funnelParticleObjects,0,Float32Array.from(this.funnels.active.flatMap(f=>[f.core%this.grid.cols+.5,Math.floor(f.core/this.grid.cols)+.5,f.strength,f.id])));
    const commands=this.device.createCommandEncoder(),pass=commands.beginComputePass();pass.setPipeline(this.funnelPipelines[0]);pass.setBindGroup(0,this.funnelGroups[this.current]);pass.dispatchWorkgroups(Math.ceil(n/64));pass.end();this.device.queue.submit([commands.finish()]);this.previousVentRates=null;
  }

  private refreshTerrain():void{
    const encoder=this.device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(this.mineralPipelines[2]);pass.setBindGroup(0,this.mineralGroups[this.current]);pass.dispatchWorkgroups(Math.ceil(this.grid.cols*this.grid.rows/64));pass.end();this.device.queue.submit([encoder.finish()]);this.previousVentRates=null;
  }

  private async updateTransportSubsteps():Promise<void>{
    if(this.grid.scene!=='world'){this.transportSubsteps=1;return;}
    const size=this.courantMaxima.size,read=this.device.createBuffer({size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),e=this.device.createCommandEncoder(),p=e.beginComputePass();p.setPipeline(this.courantPipeline);p.setBindGroup(0,this.courantGroup);p.dispatchWorkgroups(Math.ceil(this.grid.cols*this.grid.rows/64));p.end();e.copyBufferToBuffer(this.courantMaxima,0,read,0,size);this.device.queue.submit([e.finish()]);
    try{await read.mapAsync(GPUMapMode.READ);const rates=new Float32Array(read.getMappedRange()),maximum=Math.max(...rates);if(!Number.isFinite(maximum)||maximum<0)throw new Error('Недопустимое течение для сноса.');let count=Math.max(1,Math.ceil(maximum*.1/.8));if(count%2===0)count++;if(count>2047)throw new Error(`Течение на шаге ${this.step} требует ${count} подшагов (поток ${maximum} клеток/с). Уменьшите мощность света или запас минерала.`);this.transportSubsteps=count;}
    finally{read.unmap();read.destroy();}
  }
  /** Manufactured-field checks only; does not alter production forcing. */
  async setFlowForChecks(flow:Float32Array){if(flow.length!==this.grid.cols*this.grid.rows*2)throw new Error('Неверное тестовое поле');this.device.queue.writeBuffer(this.flow,0,flow);await this.updateTransportSubsteps();}

  /** Fixed model intervals include every short impulse through its exact interval integral. */
  async advanceDynamic(): Promise<void> {
    if(this.funnels&&this.step%(this.grid.funnels!.interval??1000)===0)await this.updateFunnels();
    if(this.grid.mineral?.evolving&&this.step%100===0)this.refreshTerrain();
    if(this.sources&&this.step%100===0)await this.updateSources();
    if (this.step > 0 && this.step % 10 === 0) {
      this.writeParams();
      if (this.grid.light&&this.step%(this.grid.light.interval??10)===0 || this.grid.mineral?.evolving&&this.step%100===0) { if(this.grid.light)this.prepareLight(); await this.solvePressure(); }
      if (this.grid.vents) await this.solveVents();
      if(this.grid.scene==='world'&&this.step%100===0)await this.updateTransportSubsteps();
    }
    this.advance();
  }

  async profileStep(){
    if(!this.device.features.has('timestamp-query'))return null;
    await this.device.queue.onSubmittedWorkDone();const query=this.device.createQuerySet({type:'timestamp',count:2});this.profiling=query;
    await this.advanceDynamic();const cpu=this.lastEncodingMs;this.profiling=null;
    const resolved=this.device.createBuffer({size:256,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC}),read=this.device.createBuffer({size:16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),encoder=this.device.createCommandEncoder();encoder.resolveQuerySet(query,0,2,resolved,0);encoder.copyBufferToBuffer(resolved,0,read,0,16);this.device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);const times=new BigUint64Array(read.getMappedRange());const result=times[0]>0n&&times[1]>=times[0]?{cpu,gpu:Number(times[1]-times[0])/1e6}:null;read.unmap();read.destroy();resolved.destroy();query.destroy();return result;
  }
  async advanceBatch(count:number,keepGoing=()=>true):Promise<number>{let done=0;for(;done<count&&keepGoing();done++)await this.advanceDynamic();return done;}
  advance(): void {
    const encodeStart=performance.now();
    if (this.lost) throw new Error('GPU потерян.');
    this.writeParams();
    const hadGeology=!!this.geology?.active.length;
    if(this.geology){
      const time=this.step*(this.grid.mineral?.speed??1);this.geology.update(time);this.device.queue.writeBuffer(this.geologyEvents,0,this.geology.encoded());
      const data=new ArrayBuffer(48);new Uint32Array(data).set([this.grid.cols,this.grid.rows]);new Float32Array(data).set([this.grid.cell,time],2);new Float32Array(data)[8]=this.grid.quantum??.001;new Uint32Array(data)[4]=this.geology.active.length;new Float32Array(data)[5]=this.grid.mineral?.speed??1;this.device.queue.writeBuffer(this.geologyParams,0,data);
    }
    const encoder = this.device.createCommandEncoder();
    for(let i=0;i<this.transportSubsteps;i++){this.dispatch(encoder,'transfer',i===0);this.dispatch(encoder,'advance');if(i+1<this.transportSubsteps)this.current=1-this.current;}
    if(this.grid.scene==='world')this.dispatch(encoder,'captureHoles');
    if (this.grid.ballistics) {
      encoder.clearBuffer(this.landing);
      for(let i=0;i<this.flightPipelines.length;i++) {
        const pass=encoder.beginComputePass();pass.setPipeline(this.flightPipelines[i]);pass.setBindGroup(0,this.flightGroups[1-this.current]);
        pass.dispatchWorkgroups(i===0?1:Math.ceil((i===1?this.grid.ballistics.capacity:this.grid.cols*this.grid.rows)/64));pass.end();
      }
    }
    if(this.sources||this.funnels){
      for(const i of (this.sources?[1,2]:[2])){const pass=encoder.beginComputePass();pass.setPipeline(this.sourcePipelines[i]);pass.setBindGroup(0,this.sourceGroups[1-this.current]);pass.dispatchWorkgroups(i===1?1:Math.ceil(this.grid.cols*this.grid.rows/64));pass.end();}
    }
    if(this.grid.mineral){
      for(let substep=0;substep<this.mineralSubsteps;substep++){
        for(const pipeline of this.mineralPipelines.slice(0,2)){const pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,this.mineralGroups[1-this.current]);pass.dispatchWorkgroups(Math.ceil(this.grid.cols*this.grid.rows/64));pass.end();}
        if(substep+1<this.mineralSubsteps)this.current=1-this.current;
      }
    }
    if(this.funnels){const pass=encoder.beginComputePass();pass.setPipeline(this.funnelPipelines[1]);pass.setBindGroup(0,this.funnelGroups[this.grid.mineral?this.current:1-this.current]);pass.dispatchWorkgroups(Math.ceil(this.grid.cols*this.grid.rows/64));pass.end();}
    if(hadGeology&&!this.geology?.active.length){encoder.clearBuffer(this.geologyOrders);encoder.clearBuffer(this.geologyResidues);}
    if(this.geology?.active.length&&(this.grid.mineral?.speed??1)>0){
      for(let i=0;i<5;i++){const pass=encoder.beginComputePass();pass.setPipeline(this.geologyPipelines[i]);pass.setBindGroup(0,this.geologyGroup);pass.dispatchWorkgroups(i===3?1:i>=2?Math.ceil(Math.ceil(this.grid.cols*this.grid.rows/64)/64):Math.ceil(this.grid.cols*this.grid.rows/64));pass.end();}
    }
    {const pass=encoder.beginComputePass(this.profiling?{timestampWrites:{querySet:this.profiling,beginningOfPassWriteIndex:1}}:undefined);pass.setPipeline(this.materialPipeline);pass.setBindGroup(0,this.materialGroups[this.step%2]);pass.dispatchWorkgroups(Math.ceil(this.grid.cols*this.grid.rows/64));pass.end();}
    if(this.funnels?.active.length){
      const data=new ArrayBuffer(32);new Uint32Array(data).set([this.grid.cols,this.grid.rows]);new Float32Array(data).set([this.grid.cell,.1],2);new Uint32Array(data).set([this.step,this.funnels.active.length],4);this.device.queue.writeBuffer(this.funnelParticleParams,0,data);
      const pass=encoder.beginComputePass();pass.setPipeline(this.funnelParticlePipeline);pass.setBindGroup(0,this.funnelParticleGroup);pass.dispatchWorkgroups(Math.ceil(this.funnels.active.length*40/64));pass.end();
    }
    this.device.queue.submit([encoder.finish()]); if(!this.grid.mineral)this.current = 1 - this.current; this.step++;this.lastEncodingMs=performance.now()-encodeStart;
  }

  draw(arrows: boolean, camera={x:.5,y:.5,zoom:1,layer:0}, target?:HTMLCanvasElement,effectTime=this.step*.1,mode:FlowMode=0,processes=false): void {
    if (this.lost || !this.grid) return;
    const canvas=target??this.canvas;
    if(!target)this.canvas.parentElement?.style.setProperty('--world-aspect',String(this.grid.cols/this.grid.rows));
    const codes={preparing:1,erupting:2,sleeping:3,fading:4};
    for(const v of this.sources?.volcanoes??[]){
      const passed=v.bursts.filter(b=>b.start<=this.step*.1).length,signature=`${v.eruptions}:${passed}`;
      let flash=this.visualBursts.get(v.id);
      const newBurst=this.visualFlowStep>=0&&v.bursts.some(b=>b.start>this.visualFlowStep*.1&&b.start<=this.step*.1);
      if(newBurst&&passed>0&&flash?.signature!==signature){flash={signature,start:effectTime};this.visualBursts.set(v.id,flash);}
      this.device.queue.writeBuffer(this.markers,v.cell*32,new Float32Array([codes[v.stage],v.power,v.begin,v.until,flash?.start??-1000,Number(!!flash&&effectTime-flash.start<1),0,0]));
    }
    const context=target?target.getContext('webgpu')!:this.context;
    if(target)context.configure({device:this.device,format:navigator.gpu.getPreferredCanvasFormat(),alphaMode:'opaque'});
    canvas.dataset.shape = this.grid.shape??(this.grid.scene === 'circle' ? 'circle' : 'rectangle');
    const w = Math.max(1, Math.round(canvas.clientWidth * Math.min(devicePixelRatio, 2)));
    const h = Math.max(1, Math.round(w * this.grid.rows / this.grid.cols));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const data = new ArrayBuffer(64), u = new Uint32Array(data), f = new Float32Array(data);
    f.set([camera.x,camera.y,camera.zoom,camera.layer],12);
    u[0] = this.grid.cols; u[1] = this.grid.rows; f[2] = this.grid.cell; f[3] = this.step * .1;
    // Preserve the 64-byte checkpoint layout. Render flags pack CSS width and heat; pad0 holds visual sun tone.
    f[7]=effectTime;u[4] = (Math.min(32767,Math.round(canvas.clientWidth))<<1)|Number(arrows)|(Math.round(Math.min(1,(this.grid.params?.spotHeat??1)/2)*255)<<16); if(!target)u[4]|=0x80000000; u[5] = ((this.grid.params?.seed??1)<<1)|Number(this.grid.scene === 'burst'); const sun=(this.grid.params?.sun??this.grid.light?.sun??1)*(this.grid.lightMap?sunRhythmAt(this.grid.lightMap,this.step):1);f[6]=this.grid.light?(1-Math.exp(-1.1*sun))/(1-Math.exp(-1.1)):0;f[8]=this.grid.quantum??.001;f[9]=this.grid.referenceDensity??(5/75);f[10]=Number(this.grid.scene==='world');f[11]=Number(this.grid.shape==='circle');
    this.device.queue.writeBuffer(this.view, 0, data);
    this.device.queue.writeBuffer(this.processView,0,new Float32Array([target?3:mode,effectTime,Number(processes&&!target),0]));
    const encoder = this.device.createCommandEncoder();
    if(this.visualFlowStep!==this.step){
      const data=new ArrayBuffer(32);new Uint32Array(data).set([this.grid.cols,this.grid.rows,0,Number(this.visualFlowStep<0)]);
      const values=new Float32Array(data),elapsed=effectTime-this.visualFlowTime;
      values[2]=flowBlend(mode,elapsed,this.visualFlowStep<0);
      values.set([this.grid.cell,this.grid.quantum??.001,(this.step-this.visualFlowStep)*.1,flowBlend(2,elapsed,this.visualFlowStep<0)],4);
      this.device.queue.writeBuffer(this.visualFlowParams,0,data);
      const smooth=encoder.beginComputePass();smooth.setPipeline(this.visualFlowPipeline);smooth.setBindGroup(0,this.visualFlowGroups[this.current]);smooth.dispatchWorkgroups(Math.ceil(this.grid.cols*this.grid.rows/64));smooth.end();
      this.visualFlowStep=this.step;this.visualFlowTime=effectTime;
    }
    {const pack=encoder.beginComputePass();pack.setPipeline(this.surfacePipeline);pack.setBindGroup(0,this.surfaceGroup);pack.dispatchWorkgroups(Math.ceil(this.grid.cols*this.grid.rows/64));pack.end();}
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(),
      clearValue: { r: .05, g: .08, b: .1, a: 1 }, loadOp: 'clear', storeOp: 'store' }] });
    pass.setPipeline(this.render); pass.setBindGroup(0,this.renderGroups[this.current][this.step%2]); pass.draw(3);
    if(camera.layer===0){pass.setPipeline(this.flightRender);pass.setBindGroup(0,this.flightRenderGroup);pass.draw(6,this.grid.ballistics?.capacity ?? 1);}
    if(this.funnels?.active.length&&camera.layer===0){pass.setPipeline(this.funnelParticleRender);pass.setBindGroup(0,this.funnelParticleRenderGroup);pass.draw(6,this.funnels.active.length*40);}
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  /** Consistent device checkpoint, including every fractional residue and controller. */
  async checkpoint():Promise<Checkpoint>{
    await this.device.queue.onSubmittedWorkDone();
    const buffers=this.buffers.filter(b=>!b.label.startsWith('observation'));
    let size=0;const offsets=buffers.map(b=>{const offset=size;size+=b.size;return offset;});
    const read=this.device.createBuffer({size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    const encoder=this.device.createCommandEncoder();buffers.forEach((b,i)=>encoder.copyBufferToBuffer(b,0,read,offsets[i],b.size));
    this.device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);const bytes=new Uint8Array(read.getMappedRange()).slice();read.unmap();read.destroy();
    return structuredClone({version:'ecobugs-gpu-2',grid:this.grid,step:this.step,current:this.current,pressureIndex:this.pressureIndex,
      buffers:buffers.map((b,i)=>({label:b.label,bytes:bytes.slice(offsets[i],offsets[i]+b.size)})),
      sources:this.sources,funnels:this.funnels,geology:this.geology,sourceUpdateStep:this.sourceUpdateStep,
      markerCells:this.markerCells,previousVentRates:this.previousVentRates});
  }
  async restore(saved:Checkpoint):Promise<void>{
    if(saved.version!=='ecobugs-gpu-2')throw new Error('Несовместимая версия мира.');
    await this.reset(structuredClone(saved.grid));
    const buffers=this.buffers.filter(b=>!b.label.startsWith('observation'));
    if(saved.buffers.length!==buffers.length||saved.buffers.some((b,i)=>b.label!==buffers[i].label||b.bytes.byteLength!==buffers[i].size))throw new Error('Размеры полей сохранения не соответствуют модели.');
    for(let i=0;i<buffers.length;i++)this.device.queue.writeBuffer(buffers[i],0,saved.buffers[i].bytes);
    if(this.sources&&saved.sources)Object.assign(this.sources,structuredClone(saved.sources));
    if(this.funnels&&saved.funnels)Object.assign(this.funnels,structuredClone(saved.funnels));
    if(this.geology&&saved.geology)Object.assign(this.geology,structuredClone(saved.geology));
    this.step=saved.step;this.current=saved.current;this.pressureIndex=saved.pressureIndex;this.sourceUpdateStep=saved.sourceUpdateStep;
    this.markerCells=[...saved.markerCells];this.previousVentRates=saved.previousVentRates?.slice()??null;await this.updateTransportSubsteps();
    await this.device.queue.onSubmittedWorkDone();
  }
  async observe(){
    this.writeParams();
    const read=this.device.createBuffer({size:48,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST}),encoder=this.device.createCommandEncoder(),pass=encoder.beginComputePass();
    pass.setPipeline(this.observePipeline);pass.setBindGroup(0,this.observeGroup);pass.dispatchWorkgroups(1);pass.end();encoder.copyBufferToBuffer(this.observations,0,read,0,48);this.device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);const bytes=read.getMappedRange(),u=new Uint32Array(bytes),f=new Float32Array(bytes),free=u[0]+u[1]+u[2];
    const result={step:this.step,shares:[u[0]/free,u[1]/free,u[2]/free],averageSpeed:f[8],emitted:(u[4]+u[5]*2**32)*(this.grid.quantum??.001),captured:(u[6]+u[7]*2**32)*(this.grid.quantum??.001)};read.unmap();read.destroy();return result;
  }
  get allocatedBytes():number{return this.buffers.reduce((sum,b)=>sum+b.size,0);}

  /** Bounded inspector read: one cell and its incident velocity faces, 104 bytes total. */
  async inspect(x:number,y:number){
    const grid=this.grid,step=this.step;
    const px=Math.min(grid.cols-1,Math.max(0,Math.floor(x*grid.cols)));
    const py=Math.min(grid.rows-1,Math.max(0,Math.floor(y*grid.rows))),k=py*grid.cols+px;
    const read=this.device.createBuffer({label:'point inspector read',size:104,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
    try{
      const encoder=this.device.createCommandEncoder();
      for(const [buffer,offset,size,destination] of [[this.states[this.current],k*16,16,0],[this.terrain,k*16,16,16],[this.geometry,k*16,16,32],[this.climate,k*16,16,48],[this.field,k*16,16,64],[this.flow,k*8,8,80],[this.flow,(px>0?k-1:k)*8,8,88],[this.flow,(py>0?k-grid.cols:k)*8,8,96]] as [GPUBuffer,number,number,number][]){encoder.copyBufferToBuffer(buffer,offset,read,destination,size);}
      this.device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
      const bytes=read.getMappedRange(),u=new Uint32Array(bytes),f=new Float32Array(bytes),quantum=grid.quantum??.001,area=grid.cell**2;
      const resistance=1/Math.max(.0001,f[8]);
      const grade=grid.scene==='world'?(u[4]+u[5])*quantum/area/20:resistance>3?1+(resistance-3)/6:(resistance-1)/2;
      const vx=(f[20]+(px>0?f[22]:0))*.5*grid.cell,vy=(f[21]+(py>0?f[25]:0))*.5*grid.cell;
      return {grid,step,cell:k,blocked:f[10]>.5,hole:f[11]>.5,grade,mineral:u[0]*quantum/area,deposits:u[5]*quantum/area,ground:u[4]*quantum/area,light:f[16],temperature:f[14],vx,vy};
    }finally{if(read.mapState==='mapped')read.unmap();read.destroy();}
  }

  /** Full readback is for checks only; drawing never reads physics back to CPU. */
  async snapshot(): Promise<Snapshot> {
    const n = this.grid.cols * this.grid.rows, size = n * 60 + (this.grid.ballistics?.capacity ?? 1) * 64 + 16 + n*48;
    const buffer = this.device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(this.states[this.current], 0, buffer, 0, n * 16);
    encoder.copyBufferToBuffer(this.pressures[this.pressureIndex], 0, buffer, n * 16, n * 4);
    encoder.copyBufferToBuffer(this.flow, 0, buffer, n * 20, n * 8);
    encoder.copyBufferToBuffer(this.field, 0, buffer, n * 28, n * 16);
    encoder.copyBufferToBuffer(this.ventField, 0, buffer, n * 44, n * 16);
    encoder.copyBufferToBuffer(this.packets,0,buffer,n*60,(this.grid.ballistics?.capacity ?? 1)*64);
    encoder.copyBufferToBuffer(this.common,0,buffer,size-n*48-16,16);
    encoder.copyBufferToBuffer(this.terrain,0,buffer,size-n*48,n*16);
    encoder.copyBufferToBuffer(this.geometry,0,buffer,size-n*32,n*16);
    encoder.copyBufferToBuffer(this.climate,0,buffer,size-n*16,n*16);
    const step = this.step;
    this.device.queue.submit([encoder.finish()]);
    try {
      await buffer.mapAsync(GPUMapMode.READ);
      const copy = buffer.getMappedRange().slice(0);
      return { state: new Uint32Array(copy, 0, n * 4), pressure: new Float32Array(copy, n * 16, n),
        flow: new Float32Array(copy, n * 20, n * 2), field: new Float32Array(copy, n * 28, n * 4), vents: new Float32Array(copy,n*44,n*4), particles:new Float32Array(copy,n*60,(this.grid.ballistics?.capacity ?? 1)*16), reservoir:new Uint32Array(copy,size-n*48-16,4), terrain:new Uint32Array(copy,size-n*48,n*4), geometry:new Float32Array(copy,size-n*32,n*4), climate:new Float32Array(copy,size-n*16,n*4), step };
    } finally { buffer.unmap(); buffer.destroy(); }
  }

  async summary() {
    this.writeParams();
    this.writeParams();
    const grid = this.grid;
    const groups = Math.ceil(grid.cols * grid.rows / 64), size = groups * 48 + 32;
    const buffer = this.device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = this.device.createCommandEncoder(), pass = encoder.beginComputePass();
    pass.setPipeline(this.summaryPipeline); pass.setBindGroup(0,this.summaryGroups[this.current]);
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
