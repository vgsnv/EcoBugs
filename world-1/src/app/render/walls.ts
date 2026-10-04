/** Стеклянный обод чашки и перегородки тем же стеклом (тень чашки на столе — в шейдере нижнего холста). */
import { cellInsideDish, type World } from '../../core/index.ts';
import type { Frame } from './frame.ts';
import { traceDish } from './palette.ts';

/** Стекло стен и перегородок: полупрозрачная заливка, светлая кромка, лёгкая тень. */
const GLASS_FILL = 'rgba(205, 230, 255, 0.5)';
const GLASS_GLOSS_FROM = 'rgba(244, 253, 255, 0.94)';
const GLASS_GLOSS_TO = 'rgba(128, 166, 180, 0.48)';
const GLASS_EDGE = 'rgba(255, 255, 255, 0.9)';
const GLASS_SHADOW = 'rgba(30, 55, 80, 0.65)';

export class WallsLayer {
  /** Перегородки одним путём (в единицах мира). */
  parts = new Path2D();
  /** Кромка стекла (в единицах мира) — строится один раз на мир. */
  private edges = new Path2D();
  private world!: World;

  setWorld(world: World): void {
    this.world = world;
    this.edges = this.buildEdges();
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
    gloss.addColorStop(0.22, 'rgba(211, 238, 244, 0.72)');
    gloss.addColorStop(0.65, GLASS_GLOSS_TO);
    gloss.addColorStop(1, 'rgba(188, 214, 224, 0.84)');
    ctx.fillStyle = gloss;
    ctx.fill(solid, 'evenodd');
    ctx.save(); ctx.beginPath(); traceDish(ctx, dish); ctx.clip();
    // Контактная тень перегородок лежит на среде, а стекло остаётся полупрозрачным.
    ctx.save(); ctx.translate(camera.px(1), camera.px(2));
    ctx.fillStyle = 'rgba(18, 48, 66, 0.28)'; ctx.fill(this.parts); ctx.restore();
    ctx.fillStyle = GLASS_FILL; ctx.fill(this.parts);
    ctx.clip(this.parts);
    for (const part of this.world.partitions.partitions) {
      for (let k = 1; k < part.points.length; k++) {
        const [ax, ay] = part.points[k - 1], [bx, by] = part.points[k];
        const x = Math.min(ax, bx) - W / 2, y = Math.min(ay, by) - W / 2;
        const horizontal = ay === by;
        const face = horizontal ? ctx.createLinearGradient(0, y, 0, y + W) : ctx.createLinearGradient(x, 0, x + W, 0);
        face.addColorStop(0, GLASS_GLOSS_FROM);
        face.addColorStop(0.24, 'rgba(211, 238, 244, 0.72)');
        face.addColorStop(0.7, GLASS_GLOSS_TO);
        face.addColorStop(1, 'rgba(188, 214, 224, 0.84)');
        ctx.fillStyle = face;
        ctx.fillRect(x, y, Math.abs(bx - ax) + W, Math.abs(by - ay) + W);
      }
    }
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
    // Внутренняя кромка: контактная тень и тонкий блик дают толщину стекла.
    ctx.save(); ctx.beginPath(); traceDish(ctx, dish); ctx.clip();
    ctx.strokeStyle = 'rgba(18, 48, 66, 0.55)'; ctx.lineWidth = camera.px(3);
    ctx.beginPath(); traceDish(ctx, dish); ctx.stroke();
    ctx.strokeStyle = 'rgba(237, 252, 255, 0.8)'; ctx.lineWidth = camera.px(0.8); ctx.stroke();
    ctx.restore();
    // Как у стекла: тёмный контур по краю (виден на светлом) и светлый блик
    // поверх него (виден на тёмном).
    ctx.strokeStyle = GLASS_SHADOW;
    ctx.lineWidth = camera.px(2);
    ctx.save(); ctx.beginPath(); traceDish(ctx, dish); ctx.clip(); ctx.stroke(this.edges); ctx.restore();
    ctx.strokeStyle = GLASS_EDGE;
    ctx.lineWidth = camera.px(0.75);
    ctx.save(); ctx.beginPath(); traceDish(ctx, dish); ctx.clip(); ctx.stroke(this.edges); ctx.restore();
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

  /**
   * Кромка стекла: граница между свободными ячейками чашки и занятыми (стена
   * или перегородка). Стыки перегородок со стеной и между собой поэтому не
   * обводятся.
   */
  private buildEdges(): Path2D {
    const lay = this.world.partitions;
    const { width, height } = this.world.dish;
    const c = lay.cell;
    const solid = (i: number, j: number) =>
      i < 0 || j < 0 || i >= lay.cols || j >= lay.rows || lay.blocked[j * lay.cols + i] === 1;
    const path = new Path2D();
    for (let j = 0; j < lay.rows; j++) {
      for (let i = 0; i < lay.cols; i++) {
        if (solid(i, j)) continue;
        const x = Math.min(i * c, width);
        const y = Math.min(j * c, height);
        const x1 = Math.min((i + 1) * c, width);
        const y1 = Math.min((j + 1) * c, height);
        if (solid(i - 1, j) && cellInsideDish(lay.dish, (i - 1) * c, j * c, c)) { path.moveTo(x, y); path.lineTo(x, y1); }
        if (solid(i + 1, j) && cellInsideDish(lay.dish, (i + 1) * c, j * c, c)) { path.moveTo(x1, y); path.lineTo(x1, y1); }
        if (solid(i, j - 1) && cellInsideDish(lay.dish, i * c, (j - 1) * c, c)) { path.moveTo(x, y); path.lineTo(x1, y); }
        if (solid(i, j + 1) && cellInsideDish(lay.dish, i * c, (j + 1) * c, c)) { path.moveTo(x, y1); path.lineTo(x1, y1); }
      }
    }
    return path;
  }
}
