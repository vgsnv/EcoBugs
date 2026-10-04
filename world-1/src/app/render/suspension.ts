/**
 * Взвесь — показ течений на небольших скоростях: светлые частицы плывут по
 * течению (как частицы со следами на картах ветра и океанских течений).
 * Каждая живёт несколько секунд, плавно проявляется и гаснет и рождается
 * заново в случайном месте воды; на отмели тускнеет, на сушу и в перегородки
 * не заходит. Направление — честное; скорость условная: течение ×
 * SUSPENSION_GAIN (настоящие несколько мм/с глазу не видны), соотношение
 * «где быстрее» — честное. Время частиц — часы ряби (не быстрее ×3 реального).
 * Чёрточка постоянного экранного размера, на сильном течении длиннее; на
 * ускорении за ней тянется тающий след (trails.ts). Скорость берётся из поля
 * течений (WaterLayer.streamField): на больших скоростях — усреднённого.
 * В виде «минерал» частицы рождаются там, где минерал переносится, и
 * видны настолько, насколько он переносится.
 */
import { insideDish, isBlocked, smoothLevelAt, type World } from '../../core/index.ts';
import { SPRITE_FLOATS } from './field.ts';
import type { Frame } from './frame.ts';
import type { StreamField, StreamView } from './water.ts';

/** Частиц на единицу площади мира (на всю чашку ~3700). */
const SUSPENSION_DENSITY = 1 / 520;
/** Во сколько раз частица движется быстрее течения. */
const SUSPENSION_GAIN = 20;
/** Жизнь частицы, секунды реального времени; доля жизни на проявление и угасание. */
const SUSPENSION_LIFE: readonly [number, number] = [3, 7];
const SUSPENSION_FADE = 0.25;
/** Чёрточка, пикселей CSS: полуширина; полудлина у неподвижной и наибольшая. */
const DASH_HALF_WIDTH = 0.6;
const DASH_HALF_LENGTH: readonly [number, number] = [0.7, 3];
/** Сколько экранных пикселей в секунду удлиняют чёрточку на пиксель. */
const DASH_PER_SPEED = 0.05;

export class SuspensionLayer {
  /** x, y, возраст, жизнь (с), скорость (единиц мира в секунду модели), направление x, y. */
  private particles = new Float32Array(0);
  private out = new Float32Array(0);
  private world: World | null = null;
  private lastTime: number | null = null;
  private stream: StreamField | null = null;
  private view: StreamView = 'water';

  setWorld(world: World): void {
    this.world = world;
    const count = Math.round(world.dish.width * world.dish.height * SUSPENSION_DENSITY);
    this.particles = new Float32Array(count * 7);
    this.out = new Float32Array(count * SPRITE_FLOATS);
    // Сразу разного возраста — без общей вспышки при старте.
    for (let n = 0; n < count; n++) this.spawn(n, Math.random());
    this.lastTime = null;
  }

  /** Доля воды в точке: в воде 1, к отмели гаснет, на суше и перегородках 0. */
  private water(x: number, y: number): number {
    const w = this.world!;
    if (!insideDish(w.dish, x, y) || isBlocked(w.partitions, x, y)) return 0;
    const L = smoothLevelAt(w.viscosity, x, y);
    return 1 - Math.min(1, Math.max(0, (L - 1.1) / 0.55));
  }

  /** Новая частица в случайном месте воды (у минерала — чаще там, где он переносится); `age` — доля уже прожитого. */
  private spawn(n: number, age = 0): void {
    const w = this.world!;
    const p = this.particles, o = n * 7;
    let x = 0, y = 0;
    for (let tries = 0; tries < 8; tries++) {
      x = Math.random() * w.dish.width; y = Math.random() * w.dish.height;
      if (this.water(x, y) <= 0.3) continue;
      if (!this.stream || this.view === 'water' || Math.random() < 0.05 + sample(this.stream, x, y, 2)) break;
    }
    const life = SUSPENSION_LIFE[0] + (SUSPENSION_LIFE[1] - SUSPENSION_LIFE[0]) * Math.random();
    p[o] = x; p[o + 1] = y; p[o + 2] = age * life; p[o + 3] = life; p[o + 4] = 0; p[o + 5] = 1; p[o + 6] = 0;
  }

  /**
   * Сдвинуть частицы на `dt` секунд модели (часы показа) по полю течений и
   * вернуть чёрточки для картинки следов: по SPRITE_FLOATS чисел — x, y,
   * полуширина, яркость; …; направление (x, y), полудлина.
   */
  update(frame: Frame, dt: number, stream: StreamField, view: StreamView): Float32Array {
    const w = frame.world;
    if (w !== this.world) this.setWorld(w);
    this.stream = stream;
    this.view = view;
    const real = this.lastTime === null ? 0 : Math.max(0, Math.min(0.25, frame.animTime - this.lastTime));
    this.lastTime = frame.animTime;
    const { camera } = frame;
    const p = this.particles, out = this.out;
    const count = p.length / 7;
    const [x0, y0, x1, y1] = camera.visible();
    const halfWidth = camera.px(DASH_HALF_WIDTH);
    const pxPerUnit = camera.zoom / camera.dpr;
    let shown = 0;
    for (let n = 0; n < count; n++) {
      const o = n * 7;
      p[o + 2] += real;
      if (p[o + 2] >= p[o + 3]) { this.spawn(n); continue; }
      const vx = sample(stream, p[o], p[o + 1], 0), vy = sample(stream, p[o], p[o + 1], 1);
      const speed = Math.hypot(vx, vy);
      if (dt > 0) {
        const nx = p[o] + vx * SUSPENSION_GAIN * dt, ny = p[o + 1] + vy * SUSPENSION_GAIN * dt;
        if (this.water(nx, ny) <= 0) { this.spawn(n); continue; }
        p[o] = nx; p[o + 1] = ny;
      }
      p[o + 4] = speed;
      if (speed > 1e-6) { p[o + 5] = vx / speed; p[o + 6] = vy / speed; }
      const x = p[o], y = p[o + 1];
      if (x < x0 - 10 || x > x1 + 10 || y < y0 - 10 || y > y1 + 10) continue;
      const f = p[o + 2] / p[o + 3];
      const life = Math.min(1, f / SUSPENSION_FADE, (1 - f) / SUSPENSION_FADE);
      const strength = sample(stream, x, y, 2);
      const alpha = life * this.water(x, y) * (view === 'water' ? 0.4 + 0.6 * strength : strength) * 0.8;
      if (alpha <= 0.01) continue;
      // Длина — по экранной скорости частицы.
      const screenSpeed = speed * SUSPENSION_GAIN * pxPerUnit;
      const halfLength = camera.px(Math.min(DASH_HALF_LENGTH[1], DASH_HALF_LENGTH[0] + DASH_PER_SPEED * screenSpeed));
      const q = shown++ * SPRITE_FLOATS;
      out[q] = x; out[q + 1] = y; out[q + 2] = halfWidth; out[q + 3] = alpha;
      out[q + 4] = out[q + 5] = out[q + 6] = 1; out[q + 7] = 2;
      out[q + 8] = p[o + 5]; out[q + 9] = p[o + 6]; out[q + 10] = Math.max(halfLength, halfWidth); out[q + 11] = 0;
    }
    return out.subarray(0, shown * SPRITE_FLOATS);
  }
}

/** Значение `c` (0 — скорость x, 1 — y, 2 — сила) поля течений в точке, билинейно по центрам клеток. */
function sample(s: StreamField, x: number, y: number, c: number): number {
  const fx = Math.min(s.cols - 1, Math.max(0, x / s.step - 0.5)), fy = Math.min(s.rows - 1, Math.max(0, y / s.step - 0.5));
  const i0 = Math.floor(fx), j0 = Math.floor(fy), i1 = Math.min(s.cols - 1, i0 + 1), j1 = Math.min(s.rows - 1, j0 + 1);
  const u = fx - i0, v = fy - j0, d = s.data;
  const at = (i: number, j: number) => d[(j * s.cols + i) * 4 + c];
  return (at(i0, j0) * (1 - u) + at(i1, j0) * u) * (1 - v) + (at(i0, j1) * (1 - u) + at(i1, j1) * u) * v;
}
