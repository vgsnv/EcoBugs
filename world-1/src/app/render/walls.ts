/**
 * Стеклянный обод чашки и перегородки тем же стеклом, без кромки внутри чашки;
 * под стеклом виден стол (шейдер нижнего холста — и тень чашки на столе).
 */
import type { World } from '../../core/index.ts';
import type { Frame } from './frame.ts';
import { traceDish } from './palette.ts';

/** Стекло стен и перегородок: один блик на всю чашку; светлая кромка — только снаружи обода. */
const GLASS_MID = 'rgba(211, 238, 244, 0.72)';
const GLASS_GLOSS_TO = 'rgba(128, 166, 180, 0.48)';
const GLASS_END = 'rgba(188, 214, 224, 0.84)';
const GLASS_GLOSS_FROM = 'rgba(244, 253, 255, 0.94)';
const GLASS_EDGE = 'rgba(255, 255, 255, 0.9)';

export class WallsLayer {
  /** Перегородки одним путём (в единицах мира). */
  parts = new Path2D();
  private world!: World;

  setWorld(world: World): void {
    this.world = world;
    this.parts = this.buildParts();
  }

  /** Стеклянный обод чашки и перегородки (в единицах мира). */
  draw(frame: Frame): void {
    const { ctx, camera } = frame;
    const dish = this.world.dish;
    const { width, height } = dish;
    const W = this.world.partitions.thickness;
    const solid = new Path2D();
    // Обод чашки: внешний прямоугольник минус внутренний (правило even-odd),
    // стекло с бликом — светлее к углам.
    if (dish.shape === 'circle') {
      solid.arc(width / 2, height / 2, width / 2 + W, 0, Math.PI * 2);
      solid.moveTo(width, height / 2);
      solid.arc(width / 2, height / 2, width / 2, 0, Math.PI * 2);
    } else {
      solid.rect(-W, -W, width + 2 * W, height + 2 * W);
      solid.rect(0, 0, width, height);
    }
    const gloss = ctx.createLinearGradient(0, -W, 0, height + W);
    gloss.addColorStop(0, GLASS_GLOSS_FROM);
    gloss.addColorStop(0.22, GLASS_MID);
    gloss.addColorStop(0.65, GLASS_GLOSS_TO);
    gloss.addColorStop(1, GLASS_END);
    ctx.fillStyle = gloss;
    ctx.fill(solid, 'evenodd');
    // Перегородки — то же стекло, что обод: тот же блик на всю чашку, плоская
    // толщина без поперечного перелива; кромку дают общие с ободом линии ниже.
    ctx.save(); ctx.beginPath(); traceDish(ctx, dish); ctx.clip();
    ctx.fill(this.parts);
    ctx.restore();

    const half = camera.px(0.5);
    ctx.lineWidth = camera.px(1);
    ctx.strokeStyle = GLASS_EDGE;
    if (dish.shape === 'circle') {
      ctx.beginPath(); ctx.arc(width / 2, height / 2, width / 2 + W - half, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); traceDish(ctx, dish); ctx.stroke();
    } else ctx.strokeRect(-W + half, -W + half, width + 2 * W - 2 * half, height + 2 * W - 2 * half);
    // Короткие отражения лампы только на ободе, без бликов поверх среды.
    const reflection = ctx.createLinearGradient(0, 0, width * 0.65, 0);
    reflection.addColorStop(0, 'rgba(255,255,255,0.1)');
    reflection.addColorStop(0.35, 'rgba(255,255,255,0.95)');
    reflection.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.strokeStyle = reflection; ctx.lineWidth = Math.min(W * 0.35, camera.px(1.8));
    ctx.lineCap = 'round'; ctx.beginPath();
    if (dish.shape === 'circle') {
      ctx.arc(width / 2, height / 2, width / 2 + W * 0.55, Math.PI * 1.04, Math.PI * 1.78);
    } else {
      ctx.moveTo(width * 0.04, -W * 0.55); ctx.lineTo(width * 0.62, -W * 0.55);
    }
    ctx.stroke(); ctx.lineCap = 'butt';
  }

  /** Перегородки — прямоугольники-отрезки толщиной стенки с квадратными концами. */
  private buildParts(): Path2D {
    const W = this.world.partitions.thickness;
    const parts = new Path2D();
    for (const part of this.world.partitions.partitions) {
      for (let k = 1; k < part.points.length; k++) {
        const [ax, ay] = part.points[k - 1];
        const [bx, by] = part.points[k];
        parts.rect(Math.min(ax, bx) - W / 2, Math.min(ay, by) - W / 2, Math.abs(bx - ax) + W, Math.abs(by - ay) + W);
      }
    }
    return parts;
  }

}
