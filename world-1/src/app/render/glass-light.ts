/**
 * Свет на стекле (скевоморфизм чаши — только там, где свет касается предмета):
 * где пятно упирается в стенку, кромка обода загорается тёплым бликом, а на
 * столе снаружи у этого места ложится слабый тёплый отсвет; где пятно
 * проходит над перегородкой, её стекло тоже теплеет. Сила — по свету пятна у
 * стекла (модель, spotIntensityAt) и силе солнца; фон бликов не даёт.
 */
import { spotIntensityAtPoints, sunAt, type World } from '../../core/index.ts';
import type { GlowSink } from './field.ts';
import type { Frame } from './frame.ts';
import type { Rgb } from './palette.ts';

/** Шаг выборки по ободу и перегородкам, единиц мира; на сколько внутрь от стенки берётся свет. */
const RIM_STEP = 10;
const PART_STEP = 10;
const INSET = 8;
/** Отсвет на столе: шаг, радиус, сила. */
const SPILL_EVERY = 2;
const SPILL_RADIUS = 42;
const SPILL_ALPHA = 0.16;
const GLINT: Rgb = [255, 226, 168];
/** Сколько уровней прозрачности у блика (отрезки собираются в пути по уровням). */
const LEVELS = 8;

interface Sample { x: number; y: number; nx: number; ny: number }

export class GlassLightLayer {
  private world: World | null = null;
  private rim: Sample[] = [];
  private parts: [number, number, number, number][] = [];
  private step = -1;
  private rimLight = new Float32Array(0);
  private partLight = new Float32Array(0);
  /** Точки, где берётся свет: у обода — чуть внутрь от стенки, у перегородок — середины отрезков. */
  private rimPoints = new Float64Array(0);
  private partPoints = new Float64Array(0);

  setWorld(world: World): void {
    this.world = world;
    this.step = -1;
    const { width, height, shape } = world.dish;
    this.rim = [];
    if (shape === 'circle') {
      const R = width / 2, n = Math.ceil((Math.PI * 2 * R) / RIM_STEP);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2, nx = Math.cos(a), ny = Math.sin(a);
        this.rim.push({ x: width / 2 + nx * R, y: height / 2 + ny * R, nx, ny });
      }
    } else {
      // Обход по часовой стрелке: верх, правая, низ, левая стенки.
      const edge = (x0: number, y0: number, x1: number, y1: number, nx: number, ny: number) => {
        const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / RIM_STEP);
        for (let i = 0; i < n; i++) this.rim.push({ x: x0 + ((x1 - x0) * i) / n, y: y0 + ((y1 - y0) * i) / n, nx, ny });
      };
      edge(0, 0, width, 0, 0, -1); edge(width, 0, width, height, 1, 0);
      edge(width, height, 0, height, 0, 1); edge(0, height, 0, 0, -1, 0);
    }
    this.parts = [];
    for (const part of world.partitions.partitions) {
      for (let k = 1; k < part.points.length; k++) {
        const [ax, ay] = part.points[k - 1], [bx, by] = part.points[k];
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / PART_STEP));
        for (let i = 0; i < n; i++) {
          this.parts.push([ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n, ax + ((bx - ax) * (i + 1)) / n, ay + ((by - ay) * (i + 1)) / n]);
        }
      }
    }
    this.rimLight = new Float32Array(this.rim.length);
    this.partLight = new Float32Array(this.parts.length);
    this.rimPoints = Float64Array.from(this.rim.flatMap((r) => [r.x - r.nx * INSET, r.y - r.ny * INSET]));
    this.partPoints = Float64Array.from(this.parts.flatMap(([x0, y0, x1, y1]) => [(x0 + x1) / 2, (y0 + y1) / 2]));
  }

  /** Свет пятен у стекла — пересчёт при смене шага. */
  private update(w: World): void {
    if (w.step === this.step) return;
    this.step = w.step;
    const sun = Math.min(1.4, sunAt(w.light, w.step));
    spotIntensityAtPoints(w.light, this.rimPoints, w.step, this.rimLight);
    spotIntensityAtPoints(w.light, this.partPoints, w.step, this.partLight);
    for (let i = 0; i < this.rimLight.length; i++) this.rimLight[i] *= sun;
    for (let i = 0; i < this.partLight.length; i++) this.partLight[i] *= sun;
  }

  /** Блики на кромке обода и перегородках (верхний холст) и отсвет на столе (нижний, через glows). */
  draw(frame: Frame, glows: GlowSink): void {
    const w = this.world;
    if (!w || this.rim.length === 0) return;
    this.update(w);
    const { ctx, camera } = frame;
    const W = w.partitions.thickness;
    const color = (a: number) => `rgba(${GLINT[0]}, ${GLINT[1]}, ${GLINT[2]}, ${a})`;
    const level = (v: number) => Math.min(LEVELS, Math.round(v * LEVELS));
    // Обод: отрезки между соседними точками, по середине толщины стекла.
    const rimPaths = Array.from({ length: LEVELS + 1 }, () => new Path2D());
    const n = this.rim.length;
    for (let i = 0; i < n; i++) {
      const a = this.rim[i], b = this.rim[(i + 1) % n];
      const v = (this.rimLight[i] + this.rimLight[(i + 1) % n]) / 2;
      const l = level(v);
      if (l === 0) continue;
      const off = W * 0.45;
      rimPaths[l].moveTo(a.x + a.nx * off, a.y + a.ny * off);
      rimPaths[l].lineTo(b.x + b.nx * off, b.y + b.ny * off);
      if (i % SPILL_EVERY === 0) {
        glows.glow(GLINT, a.x + a.nx * (W + SPILL_RADIUS * 0.45), a.y + a.ny * (W + SPILL_RADIUS * 0.45), SPILL_RADIUS, SPILL_ALPHA * v, false);
      }
    }
    // Перегородки: свет проходит над ними — стекло теплеет по всей толщине.
    const partPaths = Array.from({ length: LEVELS + 1 }, () => new Path2D());
    this.parts.forEach(([x0, y0, x1, y1], i) => {
      const l = level(this.partLight[i]);
      if (l === 0) return;
      partPaths[l].moveTo(x0, y0);
      partPaths[l].lineTo(x1, y1);
    });
    ctx.save();
    ctx.lineCap = 'round';
    for (let l = 1; l <= LEVELS; l++) {
      const v = l / LEVELS;
      ctx.lineWidth = Math.max(camera.px(1.5), W * 0.55);
      ctx.strokeStyle = color(0.55 * v);
      ctx.stroke(rimPaths[l]);
      ctx.lineWidth = Math.max(camera.px(1), W * 0.7);
      ctx.strokeStyle = color(0.32 * v);
      ctx.stroke(partPaths[l]);
    }
    ctx.restore();
  }
}
