/// <reference types="@webgpu/types" />
/**
 * Замер: решатель давления течений от света (сопряжённые градиенты с
 * многосеточным V-циклом) на CPU — функция ядра — и на видеокарте. Уровни сетки
 * и источник — из настоящего мира. На видеокарте сглаживание шахматное
 * (красные, затем чёрные клетки) вместо построчного Гаусса — Зейделя: тот же
 * метод, порядок обхода параллельный. Суммы и условие остановки считает сама
 * видеокарта: чтения на CPU внутри решения нет.
 *
 * Цена прохода на видеокарте почти не зависит от размера маленькой сетки,
 * поэтому проходов мало: грубые уровни V-цикла — одним проходом одной группы
 * из 1024 потоков, суммы — одним проходом, очистка слита с первым сглаживанием,
 * невязка — с переходом на грубую сетку.
 */
import {
  createWorld, DRIFT_COARSEST_SWEEPS, DRIFT_MAX_ITERATIONS, DRIFT_PERIOD, DRIFT_TOLERANCE, driftLevels, driftSystem, makeParams, solveDriftSystem, stepWorld,
  type Level,
} from '../core/index.ts';

const out = document.getElementById('out')!;
const log = (s: string) => { out.textContent += s + '\n'; };
const q = new URLSearchParams(location.search);
const seed = Number(q.get('seed') ?? 1), warm = Number(q.get('steps') ?? 20000);
const results: Record<string, unknown> = {};
(window as unknown as { driftBench: typeof results }).driftBench = results;
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const MAX_LEVELS = 8;

const WGSL = /* wgsl */`
// lev[d] = (столбцов, строк, смещение, клеток); d — уровень прохода, count — уровней
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

fn nb(L: vec4u, k: u32) -> vec4u {
  let i = k % L.x; let o = L.z;
  return vec4u(select(k, k - 1u, i > 0u), select(k, k + 1u, i + 1u < L.x), select(k, k - L.x, k >= L.x), select(k, k + L.x, k + L.x < L.w)) + vec4u(o);
}
fn colorOf(L: vec4u, k: u32) -> u32 { return ((k % L.x) + (k / L.x)) & 1u; }
// Гаусс — Зейдель в клетке: x = (b + Σ грань × x соседа) / Σ граней.
fn relax(L: vec4u, k: u32) {
  let o = L.z + k; let f = faces[o]; let m = nb(L, k);
  X[o] = (B[o] + f.x * X[m.x] + f.y * X[m.y] + f.z * X[m.z] + f.w * X[m.w]) * inv[o];
}
// Невязка b − A·x в клетке.
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

// ---- тонкие уровни: проход на всю сетку ----
// Первое сглаживание с нуля: красные — b/диаг, чёрные — 0 (заодно очистка).
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

// ---- грубые уровни от u.d вниз и обратно: одна группа, барьеры между шагами ----
var<workgroup> act: u32;
fn sync() { storageBarrier(); workgroupBarrier(); }
fn halfSweep(L: vec4u, c: u32, t: u32) {
  for (var k = t; k < L.w; k += WG) { if (colorOf(L, k) == c && inv[L.z + k] != 0.0) { relax(L, k); } }
  sync();
}
override WG: u32 = 1024u;
// Спуск с уровня u.d до предпоследнего: сглаживание, невязка на грубую сетку.
@compute @workgroup_size(WG) fn vdown(@builtin(local_invocation_id) l: vec3u) {
  if (l.x == 0u) { act = select(0u, 1u, running()); }
  if (workgroupUniformLoad(&act) == 0u) { return; }
  let t = l.x; let last = u.count - 1u;
  for (var d = u.d; d < last; d++) {
    let L = u.lev[d];
    for (var k = t; k < L.w; k += WG) { X[L.z + k] = select(0.0, B[L.z + k] * inv[L.z + k], colorOf(L, k) == 0u); }
    sync();
    halfSweep(L, 1u, t);
    let C = u.lev[d + 1u];
    for (var K = t; K < C.w; K += WG) { restrictCell(L, C, K); }
    sync();
  }
}
// Самая грубая сетка: оператор ядра (40 симметричных проходов Гаусса — Зейделя с нуля) — линейный,
// поэтому заранее записан матрицей M; здесь x = M·b — группа на строку, сумма внутри группы.
@group(0) @binding(11) var<storage, read> M: array<f32>;
var<workgroup> row: array<f32, 128>;
@compute @workgroup_size(128) fn coarse(@builtin(workgroup_id) w: vec3u, @builtin(local_invocation_id) l: vec3u) {
  let Z = u.lev[u.count - 1u]; let i = w.x;
  var s = 0.0;
  for (var j = l.x; j < Z.w; j += 128u) { s += M[i * Z.w + j] * B[Z.z + j]; }
  row[l.x] = s; workgroupBarrier();
  for (var o = 64u; o > 0u; o >>= 1u) { if (l.x < o) { row[l.x] += row[l.x + o]; } workgroupBarrier(); }
  if (l.x == 0u && running()) { X[Z.z + i] = row[0]; }
}
// Подъём от предпоследнего уровня до u.d: поправка с грубой сетки, сглаживание в обратном порядке.
@compute @workgroup_size(WG) fn vup(@builtin(local_invocation_id) l: vec3u) {
  if (l.x == 0u) { act = select(0u, 1u, running()); }
  if (workgroupUniformLoad(&act) == 0u) { return; }
  let t = l.x; let last = u.count - 1u;
  for (var d = last; d > u.d; d--) {
    let F = u.lev[d - 1u]; let C = u.lev[d];
    for (var k = t; k < F.w; k += WG) { prolongCell(F, C, k); }
    sync();
    halfSweep(F, 1u, t);
    halfSweep(F, 0u, t);
  }
}

// ---- сопряжённые градиенты на тонкой сетке (смещение 0) ----
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
// Новые p, r; r сразу в правую часть V-цикла.
@compute @workgroup_size(256) fn updatePR(@builtin(global_invocation_id) g: vec3u) {
  let k = g.x; if (k >= u.lev[0].w || !running()) { return; }
  let a = scal[5]; P[k] += a * D[k]; let r = Rv[k] - a * Q[k]; Rv[k] = r; B[k] = r;
}
@compute @workgroup_size(256) fn updateD(@builtin(global_invocation_id) g: vec3u) {
  let k = g.x; if (k >= u.lev[0].w || !running()) { return; }
  D[k] = X[k] + scal[6] * D[k];
}
// Суммы — одной группой из 1024 потоков.
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
  if (l.x == 0u && scal[4] != 0.0) { scal[2] = s; if (sqrt(s) <= scal[3]) { scal[4] = 0.0; } else { scal[7] += 1.0; } }
}
@compute @workgroup_size(1024) fn dq(@builtin(local_invocation_id) l: vec3u) {
  let s = dotDQ(l.x); if (l.x == 0u && scal[4] != 0.0) { scal[1] = s; scal[5] = scal[0] / s; }
}
@compute @workgroup_size(1024) fn rzNext(@builtin(local_invocation_id) l: vec3u) {
  let s = dotRZ(l.x); if (l.x == 0u && scal[4] != 0.0) { scal[6] = s / scal[0]; scal[0] = s; }
}
`;

async function main(): Promise<void> {
  const world = createWorld(makeParams({ seed }));
  while (world.step < warm) stepWorld(world);
  const t = Math.ceil(world.step / DRIFT_PERIOD) * DRIFT_PERIOD;
  const sys = driftSystem(world, t);
  if (!sys) { log('солнца нет — течений нет'); return; }
  const levels = driftLevels(sys.fine);
  const lastL = levels[levels.length - 1];
  if (lastL.cols * lastL.rows > 1024) { log('самая грубая сетка больше 1024 клеток — не помещается в память группы'); return; }
  log(`сид ${seed}, шаг ${t}: уровни ${levels.map((l) => `${l.cols}×${l.rows}`).join(' → ')}`);

  // ---- CPU: решатель ядра ----
  let cpu = solveDriftSystem(sys);
  const cpuTimes: number[] = [];
  for (let i = 0; i < 9; i++) { const s = performance.now(); cpu = solveDriftSystem(sys); cpuTimes.push(performance.now() - s); }
  const cpuMs = median(cpuTimes);
  log(`CPU (решатель ядра, f64): ${cpuMs.toFixed(2)} мс, шагов сопряжённых градиентов ${cpu.iterations}`);

  // ---- видеокарта ----
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) { log('WebGPU недоступен'); return; }
  const device = await adapter.requestDevice({ requiredLimits: { maxComputeInvocationsPerWorkgroup: 1024, maxComputeWorkgroupSizeX: 1024, maxComputeWorkgroupStorageSize: 32768 } });
  device.addEventListener('uncapturederror', (e) => log('ОШИБКА GPU: ' + (e as GPUUncapturedErrorEvent).error.message));
  const offs: number[] = []; let total = 0;
  for (const l of levels) { offs.push(total); total += l.cols * l.rows; }
  const faces = new Float32Array(total * 4), inv = new Float32Array(total);
  levels.forEach((l: Level, d) => {
    for (let k = 0; k < l.cols * l.rows; k++) {
      faces.set([l.west[k], l.east[k], l.north[k], l.south[k]], (offs[d] + k) * 4);
      inv[offs[d] + k] = l.inverse[k];
    }
  });
  const n0 = sys.cols * sys.rows;
  // Оператор самой грубой сетки ядра матрицей: столбец j — результат проходов для b = e_j.
  const Zl = levels[levels.length - 1], nz = Zl.cols * Zl.rows;
  const tm = performance.now();
  const Mx = new Float32Array(nz * nz), x = new Float64Array(nz), bz = new Float64Array(nz);
  const gs = (k: number) => {
    if (Zl.inverse[k] === 0) return;
    const i = k % Zl.cols;
    x[k] = (bz[k] + (i > 0 ? Zl.west[k] * x[k - 1] : 0) + (i + 1 < Zl.cols ? Zl.east[k] * x[k + 1] : 0)
      + (k >= Zl.cols ? Zl.north[k] * x[k - Zl.cols] : 0) + (k + Zl.cols < nz ? Zl.south[k] * x[k + Zl.cols] : 0)) * Zl.inverse[k];
  };
  for (let j = 0; j < nz; j++) {
    bz.fill(0); bz[j] = 1; x.fill(0);
    for (let s = 0; s < DRIFT_COARSEST_SWEEPS; s++) { for (let k = 0; k < nz; k++) gs(k); for (let k = nz - 1; k >= 0; k--) gs(k); }
    for (let i = 0; i < nz; i++) Mx[i * nz + j] = x[i];
  }
  log(`матрица самой грубой сетки ${nz}×${nz} построена за ${(performance.now() - tm).toFixed(0)} мс (нужна заново только при смене местности)`);
  const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
  const mk = (bytes: number) => device.createBuffer({ size: Math.ceil(bytes / 16) * 16, usage: S });
  const up = (data: Float32Array) => { const b = mk(data.byteLength); device.queue.writeBuffer(b, 0, data); return b; };
  const buf = [null, up(faces), up(inv), mk(total * 4), mk(total * 4), mk(n0 * 4), mk(n0 * 4), mk(n0 * 4), mk(n0 * 4), mk(64), up(Float32Array.from(sys.source)), up(Mx)];
  const P = buf[5]!, scal = buf[9]!;
  // uniform на уровень и цвет: все уровни, номер уровня прохода, цвет, число уровней
  const uni = levels.map((_, d) => [0, 1].map((color) => {
    const a = new Uint32Array(MAX_LEVELS * 4 + 4);
    levels.forEach((l, e) => a.set([l.cols, l.rows, offs[e], l.cols * l.rows], e * 4));
    a.set([d, color, levels.length, 0], MAX_LEVELS * 4);
    const b = device.createBuffer({ size: a.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(b, 0, a);
    return b;
  }));
  const module = device.createShaderModule({ code: WGSL });
  for (const msg of (await module.getCompilationInfo()).messages) if (msg.type === 'error') { log(`WGSL ${msg.lineNum}:${msg.linePos} ${msg.message}`); return; }
  // Привязки каждого прохода — те, что использует его точка входа (раскладка 'auto' берёт только их).
  const used = {
    sweepFirst: [0, 2, 3, 4, 9], sweep: [0, 1, 2, 3, 4, 9], restrictTo: [0, 1, 3, 4, 9], prolong: [0, 2, 3, 9], vdown: [0, 1, 2, 3, 4, 9], coarse: [0, 3, 4, 9, 11], vup: [0, 1, 2, 3, 4, 9],
    cgInit: [0, 2, 4, 5, 6, 10], zToD: [0, 3, 7], applyD: [0, 1, 7, 8, 9], updatePR: [0, 4, 5, 6, 7, 8, 9], updateD: [0, 3, 7, 9],
    stopInit: [0, 6, 9], rzInit: [0, 3, 6, 9], rrCheck: [0, 6, 9], dq: [0, 7, 8, 9], rzNext: [0, 3, 6, 9],
  } as const;
  type Name = keyof typeof used;
  const pipes = {} as Record<Name, GPUComputePipeline>;
  // Размер группы для грубых уровней (адрес: lwg).
  const lwg = Number(q.get('lwg') ?? 1024);
  for (const e of Object.keys(used) as Name[]) {
    const constants = e === 'vdown' || e === 'vup' ? { WG: lwg } : undefined;
    pipes[e] = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: e, ...(constants ? { constants } : {}) } });
  }
  const groups = new Map<string, GPUBindGroup>();
  const group = (name: Name, d: number, color: number) => {
    const key = `${name}/${d}/${color}`;
    let g = groups.get(key);
    if (!g) {
      g = device.createBindGroup({ layout: pipes[name].getBindGroupLayout(0), entries: used[name].map((b) => ({ binding: b, resource: { buffer: b === 0 ? uni[d][color] : buf[b]! } })) });
      groups.set(key, g);
    }
    return g;
  };
  let passes = 0;
  const run = (pass: GPUComputePassEncoder, name: Name, count: number, d = 0, color = 0) => {
    pass.setPipeline(pipes[name]); pass.setBindGroup(0, group(name, d, color)); pass.dispatchWorkgroups(count); passes++;
  };
  const wg = (d: number) => Math.ceil(levels[d].cols * levels[d].rows / 256);
  // Тонкий уровень — проходами на всю сетку, остальные — одной группой.
  // С какого уровня грубые считаются одной группой (адрес: low=1 или 2).
  const low = Math.min(levels.length - 1, Number(q.get('low') ?? 2));
  const down = (pass: GPUComputePassEncoder, d: number) => {
    if (d === low) { run(pass, 'vdown', 1, d); run(pass, 'coarse', nz, d); run(pass, 'vup', 1, d); return; }
    run(pass, 'sweepFirst', wg(d), d);
    run(pass, 'sweep', wg(d), d, 1);
    run(pass, 'restrictTo', wg(d + 1), d);
    down(pass, d + 1);
    run(pass, 'prolong', wg(d), d);
    run(pass, 'sweep', wg(d), d, 1);
    run(pass, 'sweep', wg(d), d, 0);
  };
  const vcycle = (pass: GPUComputePassEncoder) => down(pass, 0);
  const W0 = wg(0);
  const encodeSolve = (enc: GPUCommandEncoder, iterations: number) => {
    const pass = enc.beginComputePass();
    run(pass, 'cgInit', W0);
    run(pass, 'stopInit', 1);
    vcycle(pass);
    run(pass, 'zToD', W0); run(pass, 'rzInit', 1);
    for (let it = 0; it < iterations; it++) {
      run(pass, 'rrCheck', 1);
      run(pass, 'applyD', W0); run(pass, 'dq', 1);
      run(pass, 'updatePR', W0);
      vcycle(pass);
      run(pass, 'rzNext', 1);
      run(pass, 'updateD', W0);
    }
    pass.end();
  };
  const timeSolve = async (iterations: number, batch: number) => {
    const enc = device.createCommandEncoder();
    passes = 0;
    for (let i = 0; i < batch; i++) encodeSolve(enc, iterations);
    const s = performance.now(); device.queue.submit([enc.finish()]); await device.queue.onSubmittedWorkDone();
    return { ms: (performance.now() - s) / batch, passes: passes / batch };
  };
  const readF = async (b: GPUBuffer, count: number) => {
    const r = device.createBuffer({ size: Math.ceil(count * 4 / 16) * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = device.createCommandEncoder(); enc.copyBufferToBuffer(b, 0, r, 0, r.size); device.queue.submit([enc.finish()]);
    await r.mapAsync(GPUMapMode.READ); const v = new Float32Array(r.getMappedRange().slice(0, count * 4)); r.unmap(); r.destroy(); return v;
  };

  // Сходимость: сколько шагов нужно видеокарте при том же допуске.
  await timeSolve(DRIFT_MAX_ITERATIONS, 1);
  const sc = await readF(scal, 8);
  const gpuIters = sc[7];
  log(`GPU (f32, шахматное сглаживание): сошлось за ${gpuIters} шагов (предел ${DRIFT_MAX_ITERATIONS}), невязка ${Math.sqrt(sc[2]).toExponential(2)} при допуске ${sc[3].toExponential(2)}`);
  const pg = await readF(P, n0);
  // Сравнение потоков через грани: от них зависят течения.
  const { east, south } = sys.fine, cols = sys.cols;
  let num = 0, den = 0;
  for (let k = 0; k < n0; k++) {
    if (east[k]) { const c = east[k] * (cpu.p[k] - cpu.p[k + 1]), g = east[k] * (pg[k] - pg[k + 1]); num += (c - g) ** 2; den += c * c; }
    if (south[k]) { const c = south[k] * (cpu.p[k] - cpu.p[k + cols]), g = south[k] * (pg[k] - pg[k + cols]); num += (c - g) ** 2; den += c * c; }
  }
  const diff = Math.sqrt(num / den);
  log(`  отличие потоков через грани от CPU: ${(100 * diff).toFixed(3)}% (допуск решателя — течения точнее 0,5%)`);

  const fit = Math.max(1, Math.ceil(gpuIters) + 1);
  const res: Record<string, unknown> = {};
  for (const [label, iters] of [[`столько шагов, сколько нужно (${fit})`, fit], [`предел ${DRIFT_MAX_ITERATIONS} шагов (лишние — пустые проходы)`, DRIFT_MAX_ITERATIONS]] as const) {
    await timeSolve(iters, 1);
    const single: number[] = [], batched: number[] = []; let ps = 0;
    for (let i = 0; i < 7; i++) single.push((await timeSolve(iters, 1)).ms);
    for (let i = 0; i < 3; i++) { const r = await timeSolve(iters, 10); batched.push(r.ms); ps = r.passes; }
    const b = median(batched), s1 = median(single);
    log(`  ${label}: ${ps} проходов; ${b.toFixed(2)} мс в пакете из 10 (×${(cpuMs / b).toFixed(1)} к CPU), одно решение с ожиданием ${s1.toFixed(2)} мс (×${(cpuMs / s1).toFixed(1)})`);
    res[String(iters)] = { batched: b, single: s1, passes: ps };
  }
  // Разбор: цена каждого вида прохода (50 подряд в одном pass), решение уже сошлось — включаем «идёт» обратно.
  device.queue.writeBuffer(scal, 16, new Float32Array([1]));
  const parts: string[] = [];
  for (const [name, count, d, color] of [['sweep', W0, 0, 1], ['restrictTo', wg(1), 0, 0], ['prolong', W0, 0, 0], ['applyD', W0, 0, 0], ['updatePR', W0, 0, 0], ['dq', 1, 0, 0], ['vdown', 1, low, 0], ['coarse', nz, low, 0], ['vup', 1, low, 0]] as const) {
    const once = async () => {
      const enc = device.createCommandEncoder(); const pass = enc.beginComputePass();
      for (let i = 0; i < 50; i++) run(pass, name, count, d, color);
      pass.end(); const s0 = performance.now(); device.queue.submit([enc.finish()]); await device.queue.onSubmittedWorkDone(); return (performance.now() - s0) / 50;
    };
    await once(); const ts = [await once(), await once(), await once()];
    parts.push(`${name} ${(median(ts) * 1000).toFixed(0)} мкс`);
  }
  log(`  грубые уровни одной группой — с ${levels[low].cols}×${levels[low].rows}, группа ${lwg}, самая грубая — матрицей ${nz}×${nz}; цена прохода: ${parts.join(', ')}`);
  Object.assign(results, { seed, cpuMs, cpuIters: cpu.iterations, gpuIters, diff, res, done: true });
}
main().catch((e) => { log('ОШИБКА: ' + (e instanceof Error ? e.message : String(e))); results.done = true; });
