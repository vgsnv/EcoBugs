/// <reference types="@webgpu/types" />
/**
 * Неживой мир на видеокарте — движок (план: docs/plan/world-gpu-engine.md).
 *
 * Запасы (минерал в среде и залежах, грунт) хранятся 64-битными целыми долями:
 * пара u32 (младшие, старшие) со знаком в старших. Доля = количество × 2^e;
 * показатель e свой у минерала и у грунта и выбирается по их сумме в мире так,
 * чтобы любая сумма долей оставалась меньше 2^53 — тогда перевод из f64 и
 * обратно в JS точен, а сложение долей на видеокарте сохраняет сумму точно.
 */
import { groundTotal, mineralInDeposits, mineralInEruptions, mineralInMedium, type World } from '../core/index.ts';
import { GpuMineral } from './mineral.ts';

/** Запас 2^4 на рост сумм (подвижки меняют грунт) и на округление. */
const HEADROOM = 16;
const MAX_EXPONENT = 60;
const TWO32 = 2 ** 32;

export function shareExponent(total: number): number {
  if (!(total > 0)) return MAX_EXPONENT;
  return Math.min(MAX_EXPONENT, Math.floor(Math.log2(2 ** 53 / (total * HEADROOM))));
}

/** Количества f64 → 64-битные доли (пары u32). */
export function toShares(values: ArrayLike<number>, exponent: number, out: Uint32Array<ArrayBuffer> = new Uint32Array(values.length * 2)): Uint32Array<ArrayBuffer> {
  const scale = 2 ** exponent;
  for (let k = 0; k < values.length; k++) {
    const s = Math.round(values[k] * scale);
    const hi = Math.floor(s / TWO32);
    out[2 * k] = s - hi * TWO32;
    out[2 * k + 1] = hi >>> 0;
  }
  return out;
}

/** 64-битные доли → количества f64. */
export function fromShares(shares: Uint32Array, exponent: number, out: Float64Array): Float64Array {
  const inv = 2 ** -exponent;
  for (let k = 0; k < out.length; k++) out[k] = (shares[2 * k] + (shares[2 * k + 1] | 0) * TWO32) * inv;
  return out;
}

/** Сумма долей — точное целое, пока меньше 2^53. */
export function shareSum(shares: Uint32Array): number {
  let s = 0;
  for (let k = 0; k < shares.length; k += 2) s += shares[k] + (shares[k + 1] | 0) * TWO32;
  return s;
}

export function mineralTotal(world: World): number {
  const m = world.mineral;
  return m.depths + mineralInMedium(m) + mineralInDeposits(world.terrain) + mineralInEruptions(m);
}

/** Сверка «загрузка → снимок»: насколько состояние изменилось от перевода в доли. */
export interface RoundTrip {
  /** Время от загрузки до готового снимка, мс. */
  ms: number;
  /** Наибольшее отличие в клетке и сумма отличий — минерал (среда + залежи) и грунт. */
  mineralMax: number;
  mineralSum: number;
  groundMax: number;
  groundSum: number;
  /** Суммы долей до загрузки и после чтения равны. */
  exact: boolean;
}

/** Буферы состояния мира на видеокарте: на каждую клетку сетки минерала — пара u32. */
export class GpuWorld {
  readonly device: GPUDevice;
  private cells = 0;
  private world: World | null = null;
  mineralExponent = MAX_EXPONENT;
  groundExponent = MAX_EXPONENT;
  field!: GPUBuffer;
  deposits!: GPUBuffer;
  ground!: GPUBuffer;
  private staging: Uint32Array<ArrayBuffer>[] = [];
  private lost = false;
  private mineralStages: GpuMineral | null = null;

  /** Этапы обновления минерала: «среда» (перенос, растекание, оседание и размыв) и «стекание». */
  get mineral(): GpuMineral { return this.mineralStages ??= new GpuMineral(this.device); }

  private constructor(device: GPUDevice) {
    this.device = device;
    device.lost.then(() => { this.lost = true; });
  }

  /** Устройство или причина, почему видеокарты нет. */
  static async create(): Promise<GpuWorld | string> {
    const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
    if (!gpu) return 'WebGPU недоступен в этом браузере';
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return 'видеокарта не найдена';
    return new GpuWorld(await adapter.requestDevice());
  }

  get usable(): boolean { return !this.lost; }

  /** Буферы под сетку мира; показатели долей — по суммам мира. */
  attach(world: World): void {
    const n = world.mineral.cols * world.mineral.rows;
    this.mineralExponent = shareExponent(mineralTotal(world));
    this.groundExponent = shareExponent(groundTotal(world.terrain));
    if (n !== this.cells) {
      for (const b of [this.field, this.deposits, this.ground]) b?.destroy();
      const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
      const make = () => this.device.createBuffer({ size: n * 8, usage });
      this.field = make(); this.deposits = make(); this.ground = make();
      this.staging = [0, 1, 2].map(() => new Uint32Array(n * 2));
      this.cells = n;
    }
    this.world = world;
  }

  attached(world: World): boolean { return this.world === world && this.cells === world.mineral.cols * world.mineral.rows; }

  /** Состояние CPU-мира → буферы. Возвращает суммы долей (минерал, грунт). */
  upload(world: World): { mineral: number; ground: number } {
    const [f, d, g] = this.staging, m = world.mineral, t = world.terrain, q = this.device.queue;
    toShares(m.field, this.mineralExponent, f);
    toShares(t.deposits, this.mineralExponent, d);
    toShares(t.ground, this.groundExponent, g);
    q.writeBuffer(this.field, 0, f); q.writeBuffer(this.deposits, 0, d); q.writeBuffer(this.ground, 0, g);
    return { mineral: shareSum(f) + shareSum(d), ground: shareSum(g) };
  }

  /** Буферы → состояние CPU-мира (снимок). Возвращает суммы прочитанных долей. */
  async download(world: World): Promise<{ mineral: number; ground: number }> {
    const bytes = this.cells * 8, d = this.device;
    const read = d.createBuffer({ size: bytes * 3, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = d.createCommandEncoder();
    enc.copyBufferToBuffer(this.field, 0, read, 0, bytes);
    enc.copyBufferToBuffer(this.deposits, 0, read, bytes, bytes);
    enc.copyBufferToBuffer(this.ground, 0, read, 2 * bytes, bytes);
    d.queue.submit([enc.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const all = new Uint32Array(read.getMappedRange().slice(0));
    read.unmap(); read.destroy();
    const n2 = this.cells * 2;
    const f = all.subarray(0, n2), dep = all.subarray(n2, 2 * n2), g = all.subarray(2 * n2);
    fromShares(f, this.mineralExponent, world.mineral.field);
    fromShares(dep, this.mineralExponent, world.terrain.deposits);
    fromShares(g, this.groundExponent, world.terrain.ground);
    return { mineral: shareSum(f) + shareSum(dep), ground: shareSum(g) };
  }

  /** Загрузка и снимок обратно: проверка пути данных; мир получает свои же значения, округлённые до долей. */
  async roundTrip(world: World): Promise<RoundTrip> {
    const t0 = performance.now();
    if (!this.attached(world)) this.attach(world);
    const m = world.mineral, t = world.terrain;
    const before = { field: Float64Array.from(m.field), deposits: Float64Array.from(t.deposits), ground: Float64Array.from(t.ground) };
    const up = this.upload(world);
    const down = await this.download(world);
    let mineralMax = 0, mineralSum = 0, groundMax = 0, groundSum = 0;
    for (let k = 0; k < m.field.length; k++) {
      const a = m.field[k] - before.field[k] + t.deposits[k] - before.deposits[k], g = t.ground[k] - before.ground[k];
      mineralMax = Math.max(mineralMax, Math.abs(m.field[k] - before.field[k]), Math.abs(t.deposits[k] - before.deposits[k]));
      groundMax = Math.max(groundMax, Math.abs(g));
      mineralSum += a; groundSum += g;
    }
    return { ms: performance.now() - t0, mineralMax, mineralSum, groundMax, groundSum, exact: up.mineral === down.mineral && up.ground === down.ground };
  }
}
