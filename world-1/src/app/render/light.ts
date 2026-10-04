/**
 * Свет освещает местность пятнами: вне пятен тень (умножением), освещённые
 * места теплеют (нагрев усиливает) и чуть высветляются; мутность минерала
 * гасит пятна ровно настолько, насколько модель задерживает свет.
 */
import { spotOutlines, SPOT_EDGE } from '../../core/index.ts';
import type { Frame } from './frame.ts';
import { SHADE_COLOR, SUN_COLOR, rgb } from './palette.ts';

/** Сила солнечного оттенка при солнце 1 и добавка от нагрева (при нагреве 2). */
const SUN_WARMTH = 0.2;
const HEAT_WARMTH = 0.35;
/** Лёгкое высветление освещённых мест, чтобы свет читался и на тёмном камне. */
const SUN_GLOW = 0.07;
/** Высветление освещённых мест при солнце ярче 1. */
const GLARE_STRENGTH = 0.55;

/** Сколько света задерживает минерал: холст на сетке поля (альфа = 1 − прозрачность) и когда он построен. */
export interface LightMurk {
  readonly canvas: HTMLCanvasElement;
  readonly drawnAt: number;
}

export class LightLayer {
  /** Маска пятен света одним цветом, в пикселях экрана (не выше одного на CSS-пиксель). */
  readonly spots = document.createElement('canvas');
  private readonly sctx: CanvasRenderingContext2D;
  /** Слой тени с «дырами» пятен — накладывается умножением. */
  private readonly shade = document.createElement('canvas');
  private readonly hctx: CanvasRenderingContext2D;
  /** Маски света пересобираются при смене снимка, камеры или мутности. */
  private viewKey = '';
  /** Контуры пятен последнего кадра — для мини-карты. */
  lastSpots = new Path2D();

  constructor() {
    this.sctx = this.spots.getContext('2d')!;
    this.hctx = this.shade.getContext('2d')!;
  }

  reset(): void {
    this.viewKey = '';
  }

  resize(width: number, height: number): void {
    for (const c of [this.spots, this.shade]) { c.width = width; c.height = height; }
  }

  draw(frame: Frame, murk: LightMurk): void {
    const { ctx, canvas, camera, world: w, lit } = frame;
    const p = w.params;
    const z = camera.zoom;
    const penumbra = Math.min(3 * camera.dpr, Math.max(0.5, (p.spotSize * SPOT_EDGE * z) / 6));

    const lightKey = `${w.step}:${camera.zoom}:${camera.cx}:${camera.cy}:${canvas.width}:${canvas.height}:${murk.drawnAt}`;
    if (lightKey !== this.viewKey) {
      this.viewKey = lightKey;
      // Маска пятен: контуры одним цветом (перекрытия не складываются).
      const sctx = this.sctx;
      sctx.setTransform(1, 0, 0, 1, 0, 0);
      sctx.clearRect(0, 0, this.spots.width, this.spots.height);
      sctx.setTransform(...camera.viewOn(this.spots));
      const spotsPath = new Path2D();
      // Отрезков в контуре — столько, чтобы при любом масштабе край оставался гладким.
      const segments = Math.min(360, Math.max(48, Math.round(p.spotSize * z)));
      for (const poly of spotOutlines(w.light, w.step, w.dish.width, w.dish.height, segments)) {
        spotsPath.moveTo(poly[0], poly[1]);
        for (let i = 2; i < poly.length; i += 2) spotsPath.lineTo(poly[i], poly[i + 1]);
        spotsPath.closePath();
      }
      this.lastSpots = spotsPath;
      sctx.fillStyle = rgb(SUN_COLOR);
      sctx.fill(spotsPath, 'nonzero');
      // Мутность: минерал задерживает свет — пятна над ним тусклее (по модели).
      // От маски пятен зависят и тень, и тёплый оттенок, и высветление, и блики.
      const lm = murk.canvas;
      if (lm.width > 0) {
        sctx.globalCompositeOperation = 'destination-out';
        sctx.imageSmoothingEnabled = true;
        sctx.drawImage(lm, 0, 0, lm.width * w.mineral.cell, lm.height * w.mineral.cell);
        sctx.globalCompositeOperation = 'source-over';
      }

      // Тень: сплошной слой с «дырами» там, где светят пятна (при тусклом солнце
      // дыры неполные), накладывается на местность умножением.
      const hctx = this.hctx;
      hctx.globalCompositeOperation = 'source-over';
      hctx.filter = 'none';
      hctx.globalAlpha = 1;
      hctx.fillStyle = rgb(SHADE_COLOR);
      hctx.fillRect(0, 0, this.shade.width, this.shade.height);
      hctx.globalCompositeOperation = 'destination-out';
      hctx.filter = `blur(${(penumbra * this.spots.width / canvas.width).toFixed(1)}px)`;
      hctx.globalAlpha = Math.min(1, lit);
      hctx.drawImage(this.spots, 0, 0);
      hctx.globalCompositeOperation = 'source-over';
      hctx.filter = 'none';
      hctx.globalAlpha = 1;

    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(this.shade, 0, 0, canvas.width, canvas.height);
    // Свет — солнечный тёплый оттенок освещённых мест; нагрев его усиливает.
    const warmth = Math.min(0.95, SUN_WARMTH * Math.min(1, lit) + HEAT_WARMTH * Math.min(1, p.spotHeat / 2));
    ctx.globalAlpha = warmth;
    ctx.filter = `blur(${penumbra.toFixed(1)}px)`;
    ctx.drawImage(this.spots, 0, 0, canvas.width, canvas.height);
    // И чуть высветляет их, чтобы свет читался и на тёмной суше.
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = SUN_GLOW * Math.min(1, lit);
    ctx.drawImage(this.spots, 0, 0, canvas.width, canvas.height);
    // Яркое солнце высветляет освещённые места.
    if (lit > 1) {
      ctx.globalAlpha = Math.min(1, (lit - 1) * GLARE_STRENGTH);
      ctx.filter = `blur(${penumbra.toFixed(1)}px) grayscale(1) brightness(2)`;
      ctx.drawImage(this.spots, 0, 0, canvas.width, canvas.height);
    }
    ctx.filter = 'none';
  }
}
