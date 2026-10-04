/**
 * Мост «симуляция → рендер», headless-часть (см. CLAUDE.md, инвариант 4).
 *
 *   SimClock   — фиксированный timestep, ОТВЯЗАННЫЙ от FPS. Иначе на разных
 *                устройствах эволюция идёт с разной скоростью и мир невоспроизводим.
 *   RenderState — преаллоцированные буферы позиций/радиусов/цвета. Нулевые аллокации
 *                на кадр: RN-слой копирует их в Skia SharedValue без мусора для GC.
 *
 * Оба класса — чистый TS, без импортов RN/Skia: тестируются в Node за секунды.
 */
import { World } from './world.ts';
import { Gene } from './genome.ts';

export class SimClock {
  private stepMs: number;
  private acc = 0;
  private readonly maxStepsPerFrame = 12; // антизависание: не гоняем больше N тиков за кадр

  constructor(ticksPerSecond: number) {
    this.stepMs = 1000 / ticksPerSecond;
  }

  setSpeed(ticksPerSecond: number): void {
    this.stepMs = 1000 / ticksPerSecond;
  }

  /**
   * Продвинуть мир на прошедшие dtMs реального времени фиксированными шагами.
   * Возвращает число выполненных тиков. Накопитель гасится при переполнении,
   * чтобы после долгого лага не выстрелить лавиной шагов.
   */
  advance(world: World, dtMs: number): number {
    this.acc += Math.min(dtMs, 250);
    let steps = 0;
    while (this.acc >= this.stepMs && steps < this.maxStepsPerFrame) {
      world.step();
      this.acc -= this.stepMs;
      steps++;
    }
    if (this.acc > this.stepMs * this.maxStepsPerFrame) this.acc = 0;
    return steps;
  }
}

/**
 * Буферы для рендера. cap — потолок существ; за ним рой просто обрезается.
 * sync() переписывает буферы из состояния мира без единой аллокации.
 */
export class RenderState {
  readonly posX: Float32Array;
  readonly posY: Float32Array;
  readonly radius: Float32Array;
  readonly hue: Float32Array;
  count = 0;

  constructor(cap: number) {
    this.posX = new Float32Array(cap);
    this.posY = new Float32Array(cap);
    this.radius = new Float32Array(cap);
    this.hue = new Float32Array(cap);
  }

  sync(world: World): void {
    const cs = world.creatures;
    const cap = this.posX.length;
    const n = cs.length < cap ? cs.length : cap;
    for (let i = 0; i < n; i++) {
      const c = cs[i];
      this.posX[i] = c.x;
      this.posY[i] = c.y;
      this.radius[i] = 2 + c.genome.body[Gene.Size] * 3;
      this.hue[i] = c.genome.body[Gene.Hue];
    }
    this.count = n;
  }
}
