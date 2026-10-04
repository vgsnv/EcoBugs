/** Мини-карта в отдельной панели: вся чашка, пятна света, перегородки и рамка вида. */
import { spotOutlines, type World } from '../../core/index.ts';
import type { Camera } from './camera.ts';
import { SHADE_COLOR, rgb, traceDish } from './palette.ts';

export interface MinimapSources {
  readonly world: World;
  readonly camera: Camera;
  /** Местность целиком (подложка; пока не готова — null) и перегородки. */
  readonly base: HTMLCanvasElement | null;
  readonly parts: Path2D;
}

export class Minimap {
  private key = '';
  /** Номер подложки: новая подложка — перерисовать карту. */
  private readonly bases = new WeakMap<HTMLCanvasElement, number>();
  private counter = 0;

  private remember(base: HTMLCanvasElement): number {
    this.bases.set(base, ++this.counter);
    return this.counter;
  }

  reset(): void {
    this.key = '';
  }

  draw(mini: HTMLCanvasElement, s: MinimapSources): void {
    const { world, camera } = s;
    if (!world || !mini.clientWidth || !mini.clientHeight) return;
    const { width, height } = world.dish;
    const dpr = camera.dpr;
    if (!s.base) return;
    const key = `${world.step}:${world.viscosity.version}:${camera.zoom}:${camera.cx}:${camera.cy}:${mini.clientWidth}:${mini.clientHeight}:${dpr}:${this.bases.get(s.base) ?? this.remember(s.base)}`;
    if (key === this.key) return;
    this.key = key;
    const w = Math.round(mini.clientWidth * dpr);
    const h = Math.round(mini.clientHeight * dpr);
    if (mini.width !== w || mini.height !== h) { mini.width = w; mini.height = h; }
    const m = mini.getContext('2d')!;
    const scale = Math.min(w / width, h / height);
    const ox = (w - scale * width) / 2, oy = (h - scale * height) / 2;
    m.setTransform(1, 0, 0, 1, 0, 0); m.clearRect(0, 0, w, h);
    m.setTransform(scale, 0, 0, scale, ox, oy);
    m.save(); m.beginPath(); traceDish(m, world.dish); m.clip();
    m.globalCompositeOperation = 'source-over';
    m.drawImage(s.base, 0, 0, width, height);
    m.globalCompositeOperation = 'multiply';
    m.fillStyle = rgb(SHADE_COLOR);
    m.fillRect(0, 0, width, height);
    m.globalCompositeOperation = 'source-over';
    // Пятна света — контурами по модели.
    const spots = new Path2D();
    for (const poly of spotOutlines(world.light, world.step, width, height, 48)) {
      spots.moveTo(poly[0], poly[1]);
      for (let i = 2; i < poly.length; i += 2) spots.lineTo(poly[i], poly[i + 1]);
      spots.closePath();
    }
    m.save();
    m.clip(spots);
    m.drawImage(s.base, 0, 0, width, height);
    m.restore();
    m.fillStyle = 'rgba(214, 230, 245, 0.9)';
    m.fill(s.parts);
    const [x0, y0, x1, y1] = camera.visible();
    m.lineWidth = 2 * dpr / scale;
    m.strokeStyle = '#ffffff';
    m.strokeRect(Math.max(0, x0), Math.max(0, y0), Math.min(width, x1) - Math.max(0, x0), Math.min(height, y1) - Math.max(0, y0));
    m.restore();
  }

  /** Точка мини-карты (координаты окна) → точка мира; вне карты — без изменений. */
  static toWorld(mini: HTMLCanvasElement, world: World, clientX: number, clientY: number): [number, number] {
    const { width, height } = world.dish;
    const r = mini.getBoundingClientRect();
    const s = Math.min(r.width / width, r.height / height);
    return [(clientX - r.left - (r.width - s * width) / 2) / s, (clientY - r.top - (r.height - s * height) / 2) / s];
  }
}
