/// <reference types="@webgpu/types" />
/**
 * Мир world-1 на CPU и жизнь на видеокарте в одном Worker.
 *
 * Мир шагает как в приложении (10 шагов в секунду мира × ускорение), жизнь —
 * раз в LIFE_PERIOD шагов. На видеокарту каждый ход уходят только пятна света,
 * солнце и доля пути между узлами течений; поля — когда меняется их версия:
 * мутность, градации и стенки — с обновлением минерала (раз в 100 шагов),
 * узлы течений — раз в DRIFT_PERIOD. Минерал: видеокарта копит изменения жизни
 * со знаком и сдаёт их миру в середине периода минерала; мир добавляет их
 * к полю до своего обновления, после обновления отдаёт новый вид поля.
 */
import {
  absorptionAt, createWorld, DRIFT_PERIOD, lightBackground, lightFieldUniforms, makeParams, MAX_SPOTS, MINERAL_PERIOD,
  mineralInDeposits, mineralInEruptions, mineralInMedium, resistanceAt, smoothLevelAt, stepWorld, sunAt, transparencyAt, type World,
} from '../core/index.ts';
import type { GpuWorldCommand, GpuWorldReply, GpuWorldStart } from './protocol.ts';
import { BUCKET, CELL_BYTES, INFO, LIFE_PERIOD, LIFE_WGSL, NG, RENDER_WGSL, RING, TICK_VEC4 } from './shaders.ts';

const host = self as unknown as {
  onmessage: ((event: MessageEvent<GpuWorldCommand>) => void) | null;
  postMessage(message: GpuWorldReply): void;
  requestAnimationFrame(cb: (t: number) => void): number;
};
const send = (m: GpuWorldReply) => host.postMessage(m);

/** Пропуски не догоняются дальше этого отставания, с. */
const MAX_DEBT = 0.25;
/** Сдача минерала — на этом шаге внутри периода минерала (ответ успевает к обновлению). */
const FLUSH_AT = MINERAL_PERIOD / 2;
const WARM_STEPS = 5000;

let world: World;
let device: GPUDevice;
let ctx: GPUCanvasContext;
let speed = 100, paused = false;
const pending: { flushed: number; staging: GPUBuffer | null; ready: Int32Array | null; sentAt: number } = { flushed: 0, staging: null, ready: null, sentAt: 0 };

function fail(e: unknown): void { send({ type: 'error', message: e instanceof Error ? e.message : String(e) }); }

host.onmessage = ({ data }) => {
  if (data.type === 'start') start(data).catch(fail);
  else if (data.type === 'control') { if (data.speed !== undefined) speed = data.speed; if (data.paused !== undefined) paused = data.paused; }
  else if (data.type === 'check') checkRequested = true;
};
let checkRequested = false;

async function start(opts: GpuWorldStart): Promise<void> {
  speed = opts.speed;
  world = createWorld(makeParams({ seed: opts.seed }));
  // Сотворение: минерал приходит в среду извержениями — прогнать мир, пока вода не наполнится.
  while (world.step < WARM_STEPS) stepWorld(world);
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw Error('WebGPU недоступен');
  device = await adapter.requestDevice({ requiredLimits: {
    maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage,
    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize,
  } });
  device.addEventListener('uncapturederror', (e) => fail((e as GPUUncapturedErrorEvent).error.message));

  const m = world.mineral, dish = world.dish;
  const mcols = m.cols, mrows = m.rows, NM = mcols * mrows;
  const drift0 = world.drift.nodes(world.step);
  const dcols = drift0.a.cols, drows = drift0.a.rows, ND = dcols * drows;
  const gw = Math.ceil(dish.width / BUCKET), gh = Math.ceil(dish.height / BUCKET), B = gw * gh, B1 = B + 1, NB = Math.ceil(B1 / 512);
  const popCap = opts.cap, slotCap = Math.ceil(popCap * 1.35) + 4096;
  const quantum = mineralInMedium(m) / (popCap * opts.quantaPerCell);

  const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
  const mk = (size: number, usage = S) => device.createBuffer({ size: Math.max(16, Math.ceil(size / 16) * 16), usage });
  const b = {
    prm: mk(80, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
    P: [mk(slotCap * 16), mk(slotCap * 16)], C: [mk(slotCap * CELL_BYTES), mk(slotCap * CELL_BYTES)], G: [mk(slotCap * NG * 16), mk(slotCap * NG * 16)],
    info: mk(64), counts: mk(B1 * 4), start: mk(B1 * 4), cursor: mk(B1 * 4), blockSum: mk(NB * 4), blockOff: mk(NB * 4),
    items: mk(slotCap * 4), newIndex: mk(slotCap * 4),
    env: mk(NM * 16), flow: mk((2 * ND + NM) * 8), mq: mk(NM * 8), viewQ: mk(NM * 4), ring: mk(RING * TICK_VEC4 * 16),
    args: mk(64, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC),
  };
  const q = device.queue;
  const prm = new ArrayBuffer(80), pu = new Uint32Array(prm), pf = new Float32Array(prm);
  pu.set([popCap, slotCap, gw, gh, B, NB, mcols, mrows, dcols, drows, opts.mineralOptional ? 1 : 0, new Uint32Array(new Float32Array([opts.carry]).buffer)[0]]);
  pf.set([dish.width, dish.height, m.cell, drift0.a.cell, opts.push, 0, 0, 0], 12);
  q.writeBuffer(b.prm, 0, prm);

  // ---- поля мира для видеокарты ----
  const env = new Float32Array(NM * 4), flowBuf = new Float32Array((2 * ND + NM) * 2), viewQ = new Uint32Array(NM);
  let envKey = '', driftKey = -1;
  function buildEnv(): void {
    const v = world.viscosity;
    for (let j = 0; j < mrows; j++) for (let i = 0; i < mcols; i++) {
      const k = j * mcols + i, x = (i + 0.5) * m.cell, y = (j + 0.5) * m.cell;
      if (m.blocked[k]) { env.set([0, 1, -1, 0], k * 4); continue; }
      env[k * 4] = transparencyAt(m, x, y) * absorptionAt(v, x, y);
      env[k * 4 + 1] = resistanceAt(v, x, y);
      env[k * 4 + 2] = smoothLevelAt(v, x, y);
    }
    // w (свет хода) пишет видеокарта; запись всего массива его затирает до ближайшего прохода света — он идёт первым в каждом ходу
    q.writeBuffer(b.env, 0, env);
    const f = m.flow;
    for (let k = 0; k < NM; k++) { flowBuf[(2 * ND + k) * 2] = f ? f.vx[k] : 0; flowBuf[(2 * ND + k) * 2 + 1] = f ? f.vy[k] : 0; }
    q.writeBuffer(b.flow, 2 * ND * 8, flowBuf, 2 * ND * 2, NM * 2);
  }
  function uploadDrift(): void {
    const { a, b: bb } = world.drift.nodes(world.step);
    for (let k = 0; k < ND; k++) {
      flowBuf[2 * k] = a.vx[k]; flowBuf[2 * k + 1] = a.vy[k];
      flowBuf[2 * (ND + k)] = bb.vx[k]; flowBuf[2 * (ND + k) + 1] = bb.vy[k];
    }
    q.writeBuffer(b.flow, 0, flowBuf, 0, 4 * ND);
  }
  function makeView(): void {
    for (let k = 0; k < NM; k++) viewQ[k] = m.blocked[k] ? 0 : Math.floor(Math.max(0, m.field[k]) / quantum);
    q.writeBuffer(b.viewQ, 0, viewQ);
  }

  // ---- посев: клетки в воде, минерал тела берётся из поля мира ----
  const N0 = Math.floor(popCap * 0.5);
  const pos = new Float32Array(slotCap * 4), cellsAB = new ArrayBuffer(slotCap * CELL_BYTES), genes = new Float32Array(slotCap * NG * 4);
  const cf = new Float32Array(cellsAB), ci = new Int32Array(cellsAB), cu = new Uint32Array(cellsAB);
  for (let i = 0; i < slotCap; i++) ci.set([-1, -1, -1, -1], i * 12 + 8);
  let seed = opts.seed * 7919 + 17;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  let seeded = 0, n = 0;
  for (let tries = 0; n < N0 && tries < N0 * 50; tries++) {
    const x = rnd() * dish.width, y = rnd() * dish.height;
    const k = Math.floor(y / m.cell) * mcols + Math.floor(x / m.cell);
    if (m.blocked[k] || smoothLevelAt(world.viscosity, x, y) > 0.5) continue;
    // Минерал тела — из поля на месте, если он там есть; в пятнах света его обычно нет (течения выносят его в тень).
    const mn = m.field[k] >= 8 * quantum ? 8 : 0;
    m.field[k] -= mn * quantum; seeded += mn;
    const mass = 0.8 + rnd() * 0.8, hue = rnd();
    pos.set([x, y, 0.5 * Math.sqrt(mass), hue], n * 4);
    const o = n * 12;
    cf[o + 2] = 0.8; cf[o + 3] = mass; cf[o + 4] = rnd() * 300; cu[o + 5] = mn;
    const g = n * NG * 4;
    genes.set([0, 0.5, 0.5, 0.5, 0.5, 0.3, hue, 0], g);
    for (let kk = 16; kk < 40; kk++) genes[g + kk] = (rnd() - 0.5) * 0.2;
    n++;
  }
  const worldTotal = () => m.depths + mineralInMedium(m) + mineralInDeposits(world.terrain) + mineralInEruptions(m);
  const worldBefore = worldTotal() + seeded * quantum;
  q.writeBuffer(b.P[0], 0, pos); q.writeBuffer(b.C[0], 0, cellsAB); q.writeBuffer(b.G[0], 0, genes);
  q.writeBuffer(b.info, 0, new Uint32Array([n, 0, n, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
  q.writeBuffer(b.args, 0, new Uint32Array([Math.ceil(n / 256), 1, 1, 0, 1, 1, 0, 0, 6, n, 0, 0, 0, 0, 0, 0]));
  buildEnv(); uploadDrift(); makeView();
  envKey = `${m.version}:${world.viscosity.version}`; driftKey = Math.floor(world.step / DRIFT_PERIOD);

  // ---- конвейеры ----
  const module = device.createShaderModule({ code: LIFE_WGSL });
  for (const msg of (await module.getCompilationInfo()).messages) if (msg.type === 'error') throw Error(`WGSL ${msg.lineNum}:${msg.linePos} ${msg.message}`);
  const names = ['light', 'clearCounts', 'count', 'scanBlocks', 'scanSums', 'scanAdd', 'scatter', 'update', 'finalize', 'clearIndex', 'indexCells', 'gather', 'finalizeCompact', 'applyView'] as const;
  type Name = typeof names[number];
  const pipes = {} as Record<Name, GPUComputePipeline>;
  for (const e of names) pipes[e] = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: e } });
  const USE: Record<Name, number[]> = {
    light: [0, 5, 12, 20], clearCounts: [0, 6], count: [0, 1, 5, 6], scanBlocks: [0, 6, 7, 9], scanSums: [0, 9, 10], scanAdd: [0, 5, 7, 8, 10, 15], scatter: [0, 1, 5, 8, 11],
    update: [0, 1, 2, 3, 4, 5, 7, 11, 12, 13, 14], finalize: [0, 5, 15],
    clearIndex: [5, 16], indexCells: [5, 11, 16], gather: [1, 3, 4, 5, 11, 16, 17, 18, 19], finalizeCompact: [5, 15], applyView: [0, 5, 14, 21],
  };
  const groups = new Map<string, GPUBindGroup>();
  function group(name: Name, s: number, ph: number): GPUBindGroup {
    const key = `${name}/${s}/${ph}`;
    let g = groups.get(key);
    if (g) return g;
    const map: Record<number, GPUBuffer> = { 0: b.prm, 1: b.P[ph], 2: b.P[ph ^ 1], 3: b.C[s], 4: b.G[s], 5: b.info, 6: b.counts, 7: b.start, 8: b.cursor, 9: b.blockSum, 10: b.blockOff,
      11: b.items, 12: b.env, 13: b.flow, 14: b.mq, 15: b.args, 16: b.newIndex, 17: b.C[s ^ 1], 18: b.G[s ^ 1], 19: b.P[ph ^ 1], 20: b.ring, 21: b.viewQ };
    g = device.createBindGroup({ layout: pipes[name].getBindGroupLayout(0), entries: USE[name].map((k) => ({ binding: k, resource: { buffer: map[k] } })) });
    groups.set(key, g);
    return g;
  }
  let cs = 0, ph = 0, sinceCompact = 0, cpuTick = 0;
  const run = (pass: GPUComputePassEncoder, name: Name, wg: number | { at: number }) => {
    pass.setPipeline(pipes[name]); pass.setBindGroup(0, group(name, cs, ph));
    if (typeof wg === 'number') pass.dispatchWorkgroups(wg); else pass.dispatchWorkgroupsIndirect(b.args, wg.at);
  };
  const grid = (pass: GPUComputePassEncoder) => {
    run(pass, 'clearCounts', Math.ceil(B1 / 256)); run(pass, 'count', { at: 0 }); run(pass, 'scanBlocks', NB);
    run(pass, 'scanSums', 1); run(pass, 'scanAdd', Math.ceil(B1 / 256)); run(pass, 'scatter', { at: 0 });
  };
  const tickData = new Float32Array(TICK_VEC4 * 4);
  function encodeTick(enc: GPUCommandEncoder): void {
    const t = world.step, lu = lightFieldUniforms(world.light, t), k = Math.floor(t / DRIFT_PERIOD);
    tickData.set([sunAt(world.light, t), lightBackground(world.light), t / DRIFT_PERIOD - k, lu.count, lu.plane[0], lu.plane[1], 0, 0], 0);
    tickData.set(lu.spots, 8); tickData.set(lu.amps, 8 + MAX_SPOTS * 4); tickData.set(lu.phases, 8 + MAX_SPOTS * 8);
    q.writeBuffer(b.ring, (cpuTick % RING) * TICK_VEC4 * 16, tickData);
    cpuTick++;
    const pass = enc.beginComputePass();
    run(pass, 'light', Math.ceil(NM / 256));
    grid(pass);
    run(pass, 'update', { at: 0 });
    run(pass, 'finalize', 1);
    pass.end();
    ph ^= 1; sinceCompact++;
    if (sinceCompact >= opts.compactEvery) {
      const p2 = enc.beginComputePass();
      grid(p2); run(p2, 'clearIndex', { at: 0 }); run(p2, 'indexCells', { at: 12 }); run(p2, 'gather', { at: 12 }); run(p2, 'finalizeCompact', 1);
      p2.end();
      cs ^= 1; ph ^= 1; sinceCompact = 0;
    }
  }

  {
    const e = device.createCommandEncoder(), p = e.beginComputePass();
    p.setPipeline(pipes.applyView); p.setBindGroup(0, group('applyView', cs, ph)); p.dispatchWorkgroups(Math.ceil(NM / 256)); p.end();
    q.submit([e.finish()]);
  }

  // ---- отрисовка ----
  const canvas = opts.canvas;
  const scale = Math.min(1600 / dish.width, 1200 / dish.height);
  canvas.width = Math.round(dish.width * scale); canvas.height = Math.round(dish.height * scale);
  ctx = canvas.getContext('webgpu') as GPUCanvasContext;
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: 'opaque' });
  const rmod = device.createShaderModule({ code: RENDER_WGSL });
  const bgPipe = device.createRenderPipeline({ layout: 'auto', vertex: { module: rmod, entryPoint: 'bgVs' }, fragment: { module: rmod, entryPoint: 'bgFs', targets: [{ format }] } });
  const cellPipe = device.createRenderPipeline({ layout: 'auto', vertex: { module: rmod, entryPoint: 'cellVs' }, fragment: { module: rmod, entryPoint: 'cellFs', targets: [{ format }] } });
  const bgGroup = device.createBindGroup({ layout: bgPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: b.prm } }, { binding: 2, resource: { buffer: b.env } }] });
  const cellGroups = b.P.map((p) => device.createBindGroup({ layout: cellPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: b.prm } }, { binding: 1, resource: { buffer: p } }] }));
  function encodeDraw(enc: GPUCommandEncoder): void {
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: 'store' }] });
    pass.setPipeline(bgPipe); pass.setBindGroup(0, bgGroup); pass.draw(3);
    pass.setPipeline(cellPipe); pass.setBindGroup(0, cellGroups[ph]); pass.drawIndirect(b.args, 32);
    pass.end();
  }

  // ---- минерал: сдача миру и новый вид поля ----
  let flushedTotal = 0;
  const flushBytes = NM * 4;
  function encodeFlush(enc: GPUCommandEncoder): void {
    const staging = device.createBuffer({ size: flushBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    enc.copyBufferToBuffer(b.mq, NM * 4, staging, 0, flushBytes);
    enc.clearBuffer(b.mq, NM * 4, flushBytes);
    pending.staging = staging; pending.ready = null;
  }
  function afterSubmitFlush(): void {
    const staging = pending.staging!;
    pending.sentAt = performance.now();
    staging.mapAsync(GPUMapMode.READ).then(() => {
      pending.ready = new Int32Array(staging.getMappedRange().slice(0));
      staging.unmap(); staging.destroy();
      flushLatency = performance.now() - pending.sentAt;
    }).catch(fail);
  }
  /** Изменения жизни — в поле мира; true, если сдавать было нечего или сданное пришло. */
  function mergeFlush(): boolean {
    if (!pending.staging) return true;
    if (!pending.ready) return false;
    const d = pending.ready;
    for (let k = 0; k < NM; k++) if (d[k]) { m.field[k] += d[k] * quantum; flushedTotal += d[k]; }
    pending.staging = null; pending.ready = null;
    return true;
  }

  send({ type: 'ready', width: dish.width, height: dish.height, shape: dish.shape, mineralCells: NM, quantum, seeded });

  // ---- кадр: шаги мира, ходы жизни, отрисовка ----
  let carry = 0, last = performance.now(), inflight = 0, flushLatency = 0;
  let winStart = last, winSteps = 0, winTicks = 0, winFrames = 0, cpuW = 0, cpuF = 0, cpuE = 0, spike = 0, waitGpu = 0, waitMineral = 0;
  const latencies: number[] = [];
  let info = new Uint32Array(16), infoPending = false;
  const readInfo = async () => {
    const r = device.createBuffer({ size: 64, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const e = device.createCommandEncoder(); e.copyBufferToBuffer(b.info, 0, r, 0, 64); q.submit([e.finish()]);
    await r.mapAsync(GPUMapMode.READ); const v = new Uint32Array(r.getMappedRange().slice(0)); r.unmap(); r.destroy(); return v;
  };

  let sample = '';
  async function check(): Promise<void> {
    await q.onSubmittedWorkDone();
    const inf = await readInfo();
    const slots = inf[INFO.slots];
    const read = async (src: GPUBuffer, offset: number, size: number) => {
      const r = device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const e = device.createCommandEncoder(); e.copyBufferToBuffer(src, offset, r, 0, size); q.submit([e.finish()]);
      await r.mapAsync(GPUMapMode.READ); const v = r.getMappedRange().slice(0); r.unmap(); r.destroy(); return v;
    };
    const cb = await read(b.C[cs], 0, Math.ceil(Math.max(1, slots) * CELL_BYTES / 16) * 16);
    const f = new Float32Array(cb), u = new Uint32Array(cb), i32 = new Int32Array(cb);
    let alive = 0, bonded = 0, bodies = 0;
    for (let i = 0; i < slots; i++) {
      if (f[i * 12 + 3] <= 0) continue;
      alive++; bodies += u[i * 12 + 5];
      if (i32[i * 12 + 8] >= 0 || i32[i * 12 + 9] >= 0 || i32[i * 12 + 10] >= 0 || i32[i * 12 + 11] >= 0) bonded++;
    }
    // срез: свет у клетки (по ячейке минерала), запас, масса, возраст
    const pb = new Float32Array(await read(b.P[ph], 0, Math.ceil(Math.max(1, slots) * 16 / 16) * 16));
    const ev = new Float32Array(await read(b.env, 0, NM * 16));
    const Ls: number[] = [], Es: number[] = [], Ms: number[] = [], As: number[] = [];
    for (let i = 0; i < slots; i += Math.max(1, Math.floor(slots / 5000))) {
      if (f[i * 12 + 3] <= 0) continue;
      const k = Math.min(mrows - 1, Math.floor(pb[i * 4 + 1] / m.cell)) * mcols + Math.min(mcols - 1, Math.floor(pb[i * 4] / m.cell));
      Ls.push(ev[k * 4 + 3]); Es.push(f[i * 12 + 2]); Ms.push(f[i * 12 + 3]); As.push(f[i * 12 + 4]);
    }
    const pq = (a: number[]) => { const s2 = [...a].sort((x, y) => x - y); return [0.1, 0.5, 0.9].map((p2) => (s2[Math.floor(p2 * (s2.length - 1))] ?? NaN).toFixed(3)).join('/'); };
    // густота: клеток в занятой корзине сетки соседей (сетка последнего хода)
    const cnt = new Uint32Array(await read(b.counts, 0, Math.ceil(B1 * 4 / 16) * 16));
    const occ: number[] = []; let totalC = 0, pairs = 0;
    for (let k = 0; k < B; k++) if (cnt[k]) { occ.push(cnt[k]); totalC += cnt[k]; pairs += cnt[k] * cnt[k]; }
    occ.sort((x, y) => x - y);
    const dens = `корзин занято ${occ.length} из ${B}; клеток в корзине p50/p90/p99/макс ${[0.5, 0.9, 0.99].map((p2) => occ[Math.floor(p2 * (occ.length - 1))]).join('/')}/${occ[occ.length - 1]}; в среднем на клетку соседей-кандидатов в своей корзине ${(pairs / Math.max(1, totalC)).toFixed(1)}`;
    sample = dens + '\n' + `свет у клеток p10/50/90 ${pq(Ls)}; запас ${pq(Es)}; масса ${pq(Ms)}; возраст ${pq(As)}; рождений ${inf[INFO.totalBirths]}, смертей ${inf[INFO.totalDeaths]}`;
    const dq = new Int32Array(await read(b.mq, NM * 4, flushBytes));
    let pendingQ = 0; for (const v of dq) pendingQ += v;
    if (pending.ready) for (const v of pending.ready) pendingQ += v;
    let minField = Infinity; for (let k = 0; k < NM; k++) if (!m.blocked[k]) minField = Math.min(minField, m.field[k]);
    const worldNow = worldTotal() + (bodies + pendingQ) * quantum;
    send({ type: 'check', alive, bonded, bodies, flushed: flushedTotal, pending: pendingQ, seeded, exact: bodies + flushedTotal + pendingQ === seeded,
      worldBefore, worldNow, minField, sample });
  }

  async function frame(now: number): Promise<void> {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    winFrames++;
    if (checkRequested && inflight === 0 && (!pending.staging || pending.ready)) { checkRequested = false; await check(); }
    if (!paused && !checkRequested) carry = Math.min(carry + dt * 10 * speed, MAX_DEBT * 10 * speed);
    let enc = device.createCommandEncoder();
    let encodedFlush = false;
    const submit = () => {
      const e = enc; enc = device.createCommandEncoder();
      const t0 = performance.now(); q.submit([e.finish()]);
      if (encodedFlush) { afterSubmitFlush(); encodedFlush = false; }
      inflight++;
      q.onSubmittedWorkDone().then(() => { inflight--; latencies.push(performance.now() - t0); });
    };
    if (inflight >= 2) { waitGpu++; }
    else {
      let steps = 0;
      const tEnd = performance.now() + 12;
      while (carry >= 1 && steps < RING * LIFE_PERIOD && performance.now() < tEnd) {
        const next = world.step + 1;
        if (next % MINERAL_PERIOD === 0 && !mergeFlush()) { waitMineral++; break; }
        const t0 = performance.now();
        stepWorld(world);
        const t1 = performance.now();
        cpuW += t1 - t0; spike = Math.max(spike, t1 - t0);
        carry--; steps++; winSteps++;
        // Поля меняются — то, что уже записано, должно уйти на видеокарту со старыми полями.
        const ek = `${m.version}:${world.viscosity.version}`, dk = Math.floor(world.step / DRIFT_PERIOD);
        if (ek !== envKey || dk !== driftKey) {
          submit();
          const f0 = performance.now();
          if (dk !== driftKey) { uploadDrift(); driftKey = dk; }
          if (ek !== envKey) {
            buildEnv(); makeView(); envKey = ek;
            const p = enc.beginComputePass(); p.setPipeline(pipes.applyView); p.setBindGroup(0, group('applyView', cs, ph)); p.dispatchWorkgroups(Math.ceil(NM / 256)); p.end();
          }
          cpuF += performance.now() - f0;
        }
        if (world.step % LIFE_PERIOD === 0) {
          const e0 = performance.now();
          encodeTick(enc); winTicks++;
          cpuE += performance.now() - e0;
        }
        if (world.step % MINERAL_PERIOD === FLUSH_AT && !pending.staging) { encodeFlush(enc); encodedFlush = true; submit(); }
      }
    }
    encodeDraw(enc);
    submit();
    if (!infoPending) { infoPending = true; readInfo().then((v) => { info = v; infoPending = false; }).catch(fail); }
    const win = now - winStart;
    if (win >= 1000) {
      const sec = win / 1000;
      latencies.sort((a, z) => a - z);
      send({ type: 'stats', step: world.step, tick: cpuTick, stepsPerSecond: winSteps / sec, ticksPerSecond: winTicks / sec, target: 10 * speed,
        cpuWorld: cpuW / sec, cpuFields: cpuF / sec, cpuEncode: cpuE / sec, worldSpike: spike, fps: winFrames / sec,
        gpuLatency: latencies[Math.floor(latencies.length / 2)] ?? 0, waitGpu, waitMineral, flushLatency,
        alive: info[INFO.alive], slots: info[INFO.slots], births: info[INFO.totalBirths], deaths: info[INFO.totalDeaths], refused: info[INFO.refused],
        takes: info[INFO.takes], overdraw: info[INFO.overdraw], quantum, mineralInLife: 0 });
      winStart = now; winSteps = winTicks = winFrames = 0; cpuW = cpuF = cpuE = spike = 0; waitGpu = waitMineral = 0; latencies.length = 0;
    }
    host.requestAnimationFrame((t) => { frame(t).catch(fail); });
  }
  host.requestAnimationFrame((t) => { frame(t).catch(fail); });
}
