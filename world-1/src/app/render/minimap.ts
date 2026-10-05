/**
 * Мини-карта в углу карты: вся чашка, пятна света, перегородки и рамка вида.
 * В покое — только контур чашки и рамка (карта под ними видна), полная — по наведению.
 */
import { lightBackground, rasterizeSpotIntensity, sunAt, type World } from '../../core/index.ts';
import type { Camera } from './camera.ts';
import { SHADE_COLOR, lightShade, rgb, traceDish } from './palette.ts';

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
  /** Маска света (сетка поля) и освещённая подложка того же размера, что карта. */
  private readonly mask = document.createElement('canvas');
  private readonly lit = document.createElement('canvas');

  private remember(base: HTMLCanvasElement): number {
    this.bases.set(base, ++this.counter);
    return this.counter;
  }

  reset(): void {
    this.key = '';
  }

  draw(mini: HTMLCanvasElement, s: MinimapSources, full: boolean): void {
    const { world, camera } = s;
    if (!world || !mini.clientWidth || !mini.clientHeight) return;
    const { width, height } = world.dish;
    const dpr = camera.dpr;
    // Подложка ещё строится — пока только контур.
    const filled = full && s.base !== null;
    const key = `${filled}:${filled ? `${world.step}:${world.viscosity.version}:${this.bases.get(s.base!) ?? this.remember(s.base!)}` : ''}:${camera.zoom}:${camera.cx}:${camera.cy}:${mini.clientWidth}:${mini.clientHeight}:${dpr}`;
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
    if (!filled) { this.outline(m, world, camera, scale); return; }
    this.picture(m, s, w, h, scale, ox, oy);
  }

  /** Контур чашки и рамка вида: тёмная подводка под светлой линией читается на любом фоне. */
  private outline(m: CanvasRenderingContext2D, world: World, camera: Camera, scale: number): void {
    const { width, height } = world.dish;
    const [x0, y0, x1, y1] = camera.visible();
    const rect = [Math.max(0, x0), Math.max(0, y0), Math.min(width, x1) - Math.max(0, x0), Math.min(height, y1) - Math.max(0, y0)] as const;
    const line = (lw: number, style: string, path: () => void) => {
      m.lineWidth = lw * camera.dpr / scale; m.strokeStyle = style; m.beginPath(); path(); m.stroke();
    };
    const dish = () => traceDish(m, world.dish);
    const view = () => m.rect(...rect);
    line(3.5, 'rgba(20, 30, 45, 0.45)', dish); line(1.5, 'rgba(255, 255, 255, 0.9)', dish);
    line(4, 'rgba(20, 30, 45, 0.5)', view); line(2, '#ffffff', view);
  }

  private picture(m: CanvasRenderingContext2D, s: MinimapSources, w: number, h: number, scale: number, ox: number, oy: number): void {
    const { world, camera } = s;
    const { width, height } = world.dish;
    const dpr = camera.dpr;
    if (!s.base) return;
    m.save(); m.beginPath(); traceDish(m, world.dish); m.clip();
    m.globalCompositeOperation = 'source-over';
    m.drawImage(s.base, 0, 0, width, height);
    // Яркость — как на карте (lightShade): тень по доле фона, пятна — по солнцу; без мутности.
    const sun = sunAt(world.light, world.step);
    const shade = (light: number) => {
      m.globalCompositeOperation = 'multiply';
      m.fillStyle = rgb(SHADE_COLOR, lightShade(light).dark);
      m.fillRect(0, 0, width, height);
      m.globalCompositeOperation = 'source-over';
    };
    shade(sun * lightBackground(world.light));
    // Пятна света — по полю модели на грубой сетке: незатенённая местность сквозь маску света.
    const cols = 64, rows = Math.max(1, Math.round(64 * height / width));
    const light = rasterizeSpotIntensity(world.light, world.step, cols, rows, width / cols);
    if (this.mask.width !== cols || this.mask.height !== rows) { this.mask.width = cols; this.mask.height = rows; }
    const mc = this.mask.getContext('2d')!;
    const img = mc.createImageData(cols, rows);
    for (let k = 0; k < light.length; k++) img.data[k * 4 + 3] = 255 * light[k];
    mc.putImageData(img, 0, 0);
    if (this.lit.width !== w || this.lit.height !== h) { this.lit.width = w; this.lit.height = h; }
    const lc = this.lit.getContext('2d')!;
    lc.setTransform(1, 0, 0, 1, 0, 0); lc.clearRect(0, 0, w, h);
    lc.setTransform(scale, 0, 0, scale, ox, oy);
    lc.drawImage(s.base, 0, 0, width, height);
    lc.globalCompositeOperation = 'multiply';
    lc.fillStyle = rgb(SHADE_COLOR, lightShade(sun).dark);
    lc.fillRect(0, 0, width, height);
    lc.globalCompositeOperation = 'destination-in';
    lc.imageSmoothingEnabled = true;
    lc.drawImage(this.mask, 0, 0, width, height);
    lc.globalCompositeOperation = 'source-over';
    m.save();
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.drawImage(this.lit, 0, 0);
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
