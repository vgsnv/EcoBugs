/// <reference types="@webgpu/types" />
/**
 * Замер: перенос минерала (этап «перенос» обновления минерала) на CPU — функция
 * ядра world-1 — и тем же алгоритмом на видеокарте. Вход — снимок настоящего
 * мира на шаге обновления. На видеокарте количество — целые доли (сложение из
 * многих потоков в одну ячейку есть только для целых), сумма сохраняется точно.
 */
import {
  createWorld, makeParams, MINERAL_LAYER, MINERAL_MOBILITY, MINERAL_PERIOD, multiplierForLevel, stepWorld, TRANSPORT_SUBSTEPS, transportRange,
} from '../core/index.ts';

const out = document.getElementById('out')!;
const log = (s: string) => { out.textContent += s + '\n'; };
const q = new URLSearchParams(location.search);
const seed = Number(q.get('seed') ?? 1), warm = Number(q.get('steps') ?? 20000);
const results: Record<string, unknown> = {};
(window as unknown as { transportBench: typeof results }).transportBench = results;

const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

async function main(): Promise<void> {
  // ---- снимок входа переноса из настоящего мира ----
  const world = createWorld(makeParams({ seed }));
  const t0 = performance.now();
  while (world.step < warm - 1) stepWorld(world);
  log(`сид ${seed}: мир прогнан до шага ${world.step} за ${((performance.now() - t0) / 1000).toFixed(1)} с`);
  const m = world.mineral, { cols, rows, cell, blocked } = m, n = cols * rows, P = MINERAL_PERIOD;
  const step = world.step + 1, tMid = step - P / 2;
  const { a, b, u } = world.drift.nodes(tMid);
  const tvx = new Float32Array(n), tvy = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    if (blocked[k]) continue;
    tvx[k] = a.vx[k] + (b.vx[k] - a.vx[k]) * u + (m.flow ? m.flow.vx[k] : 0);
    tvy[k] = a.vy[k] + (b.vy[k] - a.vy[k]) * u + (m.flow ? m.flow.vy[k] : 0);
  }
  const mobility = Float64Array.from(world.terrain.applied, multiplierForLevel);
  const holes = new Uint8Array(n);
  for (const f of m.funnels) for (const k of f.cells) holes[k] = 1;
  const src = Float64Array.from(m.field);
  let total = 0, max = 0, moving = 0;
  for (let k = 0; k < n; k++) { total += src[k]; max = Math.max(max, src[k]); if (src[k] > 0 && (tvx[k] || tvy[k])) moving++; }
  log(`сетка ${cols}×${rows}, клетка ${cell} мм; минерала в среде ${total.toFixed(1)}, наибольшее в клетке ${max.toFixed(1)}; клеток с минералом в течении ${moving}`);

  // ---- CPU: функция ядра, одно ядро ----
  const dst = new Float64Array(n);
  const cpuRun = () => { dst.fill(0); transportRange(m, src, dst, holes, mobility, tvx, tvy, P, 0, n); };
  for (let i = 0; i < 5; i++) cpuRun();
  const cpuTimes: number[] = [];
  for (let i = 0; i < 30; i++) { const s = performance.now(); cpuRun(); cpuTimes.push(performance.now() - s); }
  const cpuMs = median(cpuTimes);
  let cpuTotal = 0; for (let k = 0; k < n; k++) cpuTotal += dst[k];
  log(`CPU (функция ядра, JS, одно ядро): ${cpuMs.toFixed(3)} мс на перенос; сумма после ${cpuTotal.toFixed(6)} (было ${total.toFixed(6)})`);
  const cpuDst = Float64Array.from(dst);

  // ---- видеокарта ----
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) { log('WebGPU недоступен'); return; }
  const device = await adapter.requestDevice();
  device.addEventListener('uncapturederror', (e) => log('ОШИБКА GPU: ' + (e as GPUUncapturedErrorEvent).error.message));
  // Целые доли: вся сумма с запасом помещается в u32.
  const scale = 2 ** 32 / (total * 1.05);
  const srcQ = new Uint32Array(n); let srcQTotal = 0;
  for (let k = 0; k < n; k++) { srcQ[k] = Math.round(src[k] * scale); srcQTotal += srcQ[k]; }
  const flow = new Float32Array(n * 2), mob = new Float32Array(n), mask = new Uint32Array(n);
  for (let k = 0; k < n; k++) { flow[2 * k] = tvx[k]; flow[2 * k + 1] = tvy[k]; mob[k] = mobility[k]; mask[k] = (blocked[k] ? 1 : 0) | (holes[k] ? 2 : 0); }
  const code = /* wgsl */`
struct U { cols: u32, rows: u32, n: u32, subsMax: u32, cell: f32, P: f32, layerK: f32, scale: f32 };
@group(0) @binding(0) var<uniform> U0: U;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read> flow: array<vec2f>;
@group(0) @binding(4) var<storage, read> mob: array<f32>;
@group(0) @binding(5) var<storage, read> mask: array<u32>;
fn blockedAt(i: i32, j: i32) -> bool {
  return i < 0 || j < 0 || i >= i32(U0.cols) || j >= i32(U0.rows) || (mask[u32(j) * U0.cols + u32(i)] & 1u) != 0u;
}
// Как spill ядра: билинейно по четырём соседям, доля у стенки — домой; целые доли, остаток — последней.
fn spill(x: f32, y: f32, moved: u32, home: u32) {
  let fx = x / U0.cell - 0.5; let fy = y / U0.cell - 0.5;
  let i0 = i32(floor(fx)); let j0 = i32(floor(fy)); let uu = fx - f32(i0); let ww = fy - f32(j0);
  let mf = f32(moved);
  let s00 = u32(mf * (1.0 - uu) * (1.0 - ww)); let s10 = u32(mf * uu * (1.0 - ww)); let s01 = u32(mf * (1.0 - uu) * ww);
  let parts = s00 + s10 + s01;
  let s11 = select(0u, moved - parts, moved >= parts);
  var kept = 0u;
  if (blockedAt(i0, j0)) { kept += s00; } else { atomicAdd(&dst[u32(j0) * U0.cols + u32(i0)], s00); }
  if (blockedAt(i0 + 1, j0)) { kept += s10; } else { atomicAdd(&dst[u32(j0) * U0.cols + u32(i0 + 1)], s10); }
  if (blockedAt(i0, j0 + 1)) { kept += s01; } else { atomicAdd(&dst[u32(j0 + 1) * U0.cols + u32(i0)], s01); }
  if (blockedAt(i0 + 1, j0 + 1)) { kept += s11; } else { atomicAdd(&dst[u32(j0 + 1) * U0.cols + u32(i0 + 1)], s11); }
  if (kept > 0u) { atomicAdd(&dst[home], kept); }
}
@compute @workgroup_size(64) fn transport(@builtin(global_invocation_id) g: vec3u) {
  let k = g.x; if (k >= U0.n) { return; }
  let mk = mask[k]; if ((mk & 1u) != 0u) { return; }
  let amount = src[k]; if (amount == 0u) { return; }
  if ((mk & 2u) != 0u) { atomicAdd(&dst[k], amount); return; }
  let f = flow[k]; let fl = length(f);
  if (fl == 0.0) { atomicAdd(&dst[k], amount); return; }
  let mo = mob[k];
  let layer = U0.layerK * fl / (mo * mo) * U0.scale;
  var moved = amount; if (layer < f32(amount)) { moved = u32(layer); }
  atomicAdd(&dst[k], amount - moved);
  let cols = U0.cols; let rows = U0.rows; let cell = U0.cell;
  let i = k % cols; let j = k / cols;
  var x = (f32(i) + 0.5) * cell; var y = (f32(j) + 0.5) * cell;
  let width = f32(cols) * cell; let height = f32(rows) * cell;
  let subs = min(U0.subsMax, max(1u, u32(ceil(fl * U0.P / cell))));
  let dt = U0.P / f32(subs);
  if (subs == 1u) {
    let nx = x + f.x * dt; let ny = y + f.y * dt;
    if (nx >= 0.0 && ny >= 0.0 && nx < width && ny < height && (mask[u32(ny / cell) * cols + u32(nx / cell)] & 1u) == 0u) {
      x = nx; y = ny;
      let t = u32(y / cell) * cols + u32(x / cell);
      if ((mask[t] & 2u) != 0u) { atomicAdd(&dst[t], moved); return; }
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
  if ((mask[t] & 2u) != 0u) { atomicAdd(&dst[t], moved); } else { spill(x, y, moved, k); }
}`;
  const module = device.createShaderModule({ code });
  for (const msg of (await module.getCompilationInfo()).messages) if (msg.type === 'error') { log(`WGSL ${msg.lineNum}:${msg.linePos} ${msg.message}`); return; }
  const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
  const buf = (data: ArrayBufferView & { byteLength: number }, usage = S) => {
    const bb = device.createBuffer({ size: Math.ceil(data.byteLength / 16) * 16, usage }); device.queue.writeBuffer(bb, 0, data.buffer, data.byteOffset, data.byteLength); return bb;
  };
  const ub = new ArrayBuffer(32), uu32 = new Uint32Array(ub), uf = new Float32Array(ub);
  uu32.set([cols, rows, n, TRANSPORT_SUBSTEPS]);
  uf.set([cell, P, MINERAL_LAYER * MINERAL_MOBILITY * P * cell * cell, scale], 4);
  const uniform = buf(new Uint8Array(ub), GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
  const srcB = buf(srcQ), dstB = device.createBuffer({ size: Math.ceil(n * 4 / 16) * 16, usage: S }), flowB = buf(flow), mobB = buf(mob), maskB = buf(mask);
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'transport' } });
  const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [uniform, srcB, dstB, flowB, mobB, maskB].map((buffer, binding) => ({ binding, resource: { buffer } })) });
  const encode = (enc: GPUCommandEncoder) => {
    enc.clearBuffer(dstB);
    const pass = enc.beginComputePass(); pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(n / 64)); pass.end();
  };
  const runBatch = async (count: number) => {
    const enc = device.createCommandEncoder();
    for (let i = 0; i < count; i++) encode(enc);
    const s = performance.now(); device.queue.submit([enc.finish()]); await device.queue.onSubmittedWorkDone(); return performance.now() - s;
  };
  await runBatch(5);
  const single: number[] = [], batched: number[] = [];
  for (let i = 0; i < 20; i++) single.push(await runBatch(1));
  for (let i = 0; i < 5; i++) batched.push((await runBatch(100)) / 100);
  const gpuMs = median(batched);
  // результат одного переноса
  const read = device.createBuffer({ size: Math.ceil(n * 4 / 16) * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  { const enc = device.createCommandEncoder(); encode(enc); enc.copyBufferToBuffer(dstB, 0, read, 0, Math.ceil(n * 4 / 16) * 16); device.queue.submit([enc.finish()]); }
  await read.mapAsync(GPUMapMode.READ);
  const gq = new Uint32Array(read.getMappedRange().slice(0, n * 4)); read.unmap();
  let gTotal = 0, diffL1 = 0, maxDiff = 0, maxAt = 0;
  for (let k = 0; k < n; k++) {
    gTotal += gq[k];
    const d = Math.abs(gq[k] / scale - cpuDst[k]);
    diffL1 += d; if (d > maxDiff) { maxDiff = d; maxAt = k; }
  }
  log(`GPU: ${gpuMs.toFixed(3)} мс на перенос в пакете из 100; одно отправление (с ожиданием) ${median(single).toFixed(3)} мс`);
  log(`  ускорение к CPU: ×${(cpuMs / gpuMs).toFixed(1)} в пакете, ×${(cpuMs / median(single)).toFixed(1)} поодиночке`);
  log(`  сумма в долях: было ${srcQTotal}, стало ${gTotal} — ${srcQTotal === gTotal ? 'точно' : 'РАСХОЖДЕНИЕ ' + (gTotal - srcQTotal)}`);
  log(`  отличие от CPU: суммарно ${(100 * diffL1 / total).toFixed(4)}% минерала; наибольшее в клетке ${maxDiff.toFixed(4)} (в ней CPU ${cpuDst[maxAt].toFixed(3)})`);
  Object.assign(results, { seed, cpuMs, gpuMs, gpuSingle: median(single), exact: srcQTotal === gTotal, diffPct: 100 * diffL1 / total, done: true });
}
main().catch((e) => { log('ОШИБКА: ' + (e instanceof Error ? e.message : String(e))); results.done = true; });
