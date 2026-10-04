/**
 * Отрисовка мира на холсте в разрешении экрана — как освещённая местность,
 * с камерой: масштаб и перемещение. Кадр собирается из слоёв (render/*.ts)
 * снизу вверх: тень чашки, местность, свет, вода, минерал, вулканы и
 * воронки, процессы, стекло стен и перегородок, проба, линейки.
 */
import { CoordinateRulers } from './rulers.ts';
import { insideDish, sunAt, type MineralProcesses, type World } from '../core/index.ts';
import { Camera } from './render/camera.ts';
import type { Frame } from './render/frame.ts';
import { LightLayer } from './render/light.ts';
import { MineralLayer } from './render/mineral.ts';
import { Minimap } from './render/minimap.ts';
import { lightTone, smoothstep, traceDish } from './render/palette.ts';
import { ProcessesLayer } from './render/processes.ts';
import { SourcesLayer } from './render/sources.ts';
import { TerrainLayer } from './render/terrain.ts';
import { WallsLayer } from './render/walls.ts';
import { WaterLayer } from './render/water.ts';

export class WorldRenderer {
  showProcesses = false;
  processes: MineralProcesses | null = null;
  /** Вызывается при смене масштаба (для подписи в панели). */
  onZoomChange: (relative: number) => void = () => {};

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly camera: Camera;
  private readonly rulers: CoordinateRulers;
  private readonly terrain = new TerrainLayer();
  private readonly light = new LightLayer();
  private readonly water = new WaterLayer();
  private readonly mineral = new MineralLayer();
  private readonly sources = new SourcesLayer();
  private readonly walls = new WallsLayer();
  private readonly processLayer = new ProcessesLayer();
  private readonly minimap = new Minimap();
  private probePoint: { x: number; y: number } | null = null;
  private world!: World;
  private frameKey = '';

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.camera = new Camera(canvas, (relative) => this.onZoomChange(relative));
    this.rulers = new CoordinateRulers(canvas);
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  setProbePoint(point: { x: number; y: number } | null): void { this.probePoint = point; this.frameKey = ''; }

  setRulers(enabled: boolean): void {
    this.frameKey = '';
    const wasFitted = this.camera.fitted;
    this.rulers.toggle(enabled);
    this.resizeKeepingView();
    if (wasFitted) this.fit();
  }

  setWorld(world: World): void {
    this.frameKey = '';
    this.minimap.reset();
    this.world = world;
    this.processes = null;
    this.processLayer.reset();
    this.light.reset();
    this.mineral.setWorld(world);
    this.sources.setWorld(world);
    this.water.resetFlow();
    this.camera.setWorld(world);
    this.terrain.setWorld(world);
    this.walls.setWorld(world);
    this.water.buildSparkles(world, this.terrain.drawnLevel, this.terrain.drawnDeposit);
    this.water.resetFoam();
    this.resize();
    this.fit();
  }

  /** Изменение компоновки сохраняет масштаб, левый край чашки или центр приближенного вида. */
  resizeKeepingView(): void { this.resize(); }

  /** Подогнать разрешение холстов под размер на экране и плотность пикселей. */
  private resize(): void {
    const dpr = this.camera.dpr;
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    const changed = w !== this.canvas.width || h !== this.canvas.height;
    if (changed) {
      this.canvas.width = w; this.canvas.height = h;
      // Мягкие световые эффекты — один пиксель на CSS-пиксель;
      // карта, линейки и штрихи остаются в полном разрешении устройства.
      const effectScale = Math.min(1, 1 / dpr);
      const ew = Math.max(1, Math.round(w * effectScale)), eh = Math.max(1, Math.round(h * effectScale));
      this.light.resize(ew, eh);
      this.water.resize(ew, eh);
    }
    if (!this.world || !changed) return;
    if (this.camera.fitted) this.fit();
    else this.camera.setView(this.camera.zoom, this.camera.cx, this.camera.cy);
  }

  // ── Камера ────────────────────────────────────────────────────────────

  /** Показать чашку целиком по центру области карты. */
  fit(): void {
    this.camera.fit();
  }

  /** Показать точку мира в центре при масштабе `relative` от вида «вся чашка». */
  lookAt(x: number, y: number, relative: number): void {
    this.camera.setView(this.camera.fitZoom() * relative, x, y);
  }

  /** Остались недостроенные плитки или блоки местности — следующий кадр продолжит. */
  pendingWork(): boolean {
    return this.terrain.unfinished;
  }

  /** Приблизить (factor > 1) или отдалить так, чтобы точка экрана осталась на месте; без точки — центр. */
  zoomBy(factor: number, clientX?: number, clientY?: number): void {
    this.camera.zoomBy(factor, clientX, clientY);
  }

  /** Сдвинуть вид на столько пикселей экрана (CSS). */
  panBy(dx: number, dy: number): void {
    this.camera.panBy(dx, dy);
  }

  /** Координаты мира по точке экрана; вне чашки — null. */
  toWorld(clientX: number, clientY: number): [number, number] | null {
    const [x, y] = this.camera.clientToWorld(clientX, clientY);
    return insideDish(this.world.dish, x, y) ? [x, y] : null;
  }

  // ── Кадр ──────────────────────────────────────────────────────────────

  /** Кадр; `animTime` — секунды анимации бликов (стоит на паузе). */
  draw(animTime = 0, flowStep = this.world.step): void {
    const camera = this.camera;
    const key = `${animTime}:${flowStep}:${this.world.step}:${this.world.mineral.version}:${this.world.viscosity.version}:${camera.zoom}:${camera.cx}:${camera.cy}:${this.canvas.width}:${this.canvas.height}:${this.showProcesses}`;
    if (key === this.frameKey && !this.terrain.unfinished) return;
    this.frameKey = key;
    const w = this.world;
    const frame: Frame = {
      ctx: this.ctx, canvas: this.canvas, camera, world: w, animTime, flowStep,
      detail: smoothstep(1, 4, camera.zoom / camera.fitZoom()),
      lit: lightTone(sunAt(w.light, w.step)) / lightTone(1),
    };
    if (this.terrain.begin()) this.water.buildSparkles(w, this.terrain.drawnLevel, this.terrain.drawnDeposit);
    const ctx = this.ctx;
    const view = camera.view();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.walls.drawShadow(frame);
    ctx.save();
    ctx.beginPath();
    ctx.setTransform(...view);
    traceDish(ctx, w.dish);
    ctx.clip();
    this.terrain.draw(frame);
    this.light.draw(frame, this.mineral.lightMurk);
    this.water.drawGlints(frame, this.light.spots, this.terrain.waterMask, this.showProcesses);
    this.water.drawSparkles(frame, this.light.spots);
    this.water.drawFoam(frame);
    ctx.restore();

    ctx.setTransform(...view);
    this.mineral.draw(frame);
    this.sources.drawEruptions(frame);
    // Жерла — отверстия в недра: поверх течений, ничто не проходит сквозь них.
    this.sources.drawVents(frame);
    if (this.showProcesses) this.processLayer.draw(frame, this.processes);
    this.walls.draw(frame);
    if (this.probePoint) {
      const { x, y } = this.probePoint;
      ctx.save();
      ctx.beginPath(); ctx.arc(x, y, camera.px(7), 0, Math.PI * 2);
      ctx.strokeStyle = '#172b4d'; ctx.lineWidth = camera.px(4); ctx.stroke();
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = camera.px(2); ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, camera.px(2), 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
      ctx.restore();
    }
    this.rulers.draw(ctx, w.dish, camera.zoom, camera.cx, camera.cy, camera.dpr);
  }

  /** Мини-карта в отдельной панели: вся чашка, пятна света, перегородки и рамка вида. */
  drawMinimap(mini: HTMLCanvasElement): void {
    if (!this.world) return;
    this.minimap.draw(mini, {
      world: this.world, camera: this.camera, base: this.terrain.base, spots: this.light.lastSpots, parts: this.walls.parts, queued: this.terrain.queued,
    });
  }

  /** Точка мини-карты (координаты окна) → центр вида там. */
  centerFromMinimap(mini: HTMLCanvasElement, clientX: number, clientY: number): void {
    const [x, y] = Minimap.toWorld(mini, this.world, clientX, clientY);
    if (!insideDish(this.world.dish, x, y)) return;
    this.camera.setView(this.camera.zoom, x, y);
  }
}
