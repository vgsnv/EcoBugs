/**
 * Отрисовка мира в разрешении экрана — как освещённая местность, с камерой:
 * масштаб и перемещение. Два холста одного размера. Нижний (WebGL2, render/field.ts)
 * — тень чашки, местность, свет, вода, минерал, свечения и отверстия воронок.
 * Верхний (Canvas 2D, прозрачный) — объекты: зёрна, жерла, крупинки, процессы,
 * стекло стен и перегородок, проба, линейки. Слои — в render/*.ts.
 */
import { CoordinateRulers } from './rulers.ts';
import { DRIFT_REFERENCE, insideDish, sunAt, type MineralProcesses, type World } from '../core/index.ts';
import { Camera } from './render/camera.ts';
import { FieldRenderer } from './render/field.ts';
import type { Frame } from './render/frame.ts';
import { LightLayer } from './render/light.ts';
import { MineralLayer } from './render/mineral.ts';
import { Minimap } from './render/minimap.ts';
import { lightTone, smoothstep } from './render/palette.ts';
import { ProcessesLayer } from './render/processes.ts';
import { SourcesLayer } from './render/sources.ts';
import { SuspensionLayer } from './render/suspension.ts';
import { TerrainLayer } from './render/terrain.ts';
import { WallsLayer } from './render/walls.ts';
import { WaterLayer, type StreamField, type StreamView } from './render/water.ts';

export class WorldRenderer {
  showProcesses = false;
  /** Что показывают штрихи течений на ускорении: течение воды или перенос минерала. */
  streamView: StreamView = 'water';
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
  private readonly field = new FieldRenderer();
  private readonly suspension = new SuspensionLayer();
  private probePoint: { x: number; y: number } | null = null;
  private world!: World;
  private frameKey = '';

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.camera = new Camera(canvas, (relative) => this.onZoomChange(relative));
    this.rulers = new CoordinateRulers(canvas);
    this.ctx = canvas.getContext('2d')!;
    // Нижний холст — под верхним: тот же размер и место, события мыши — верхнему.
    canvas.before(this.field.canvas);
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
    const fresh = this.terrain.refresh();
    if (fresh) this.water.buildSparkles(world, fresh.level, fresh.deposits);
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
      const style = this.field.canvas.style;
      style.left = `${this.canvas.offsetLeft}px`; style.top = `${this.canvas.offsetTop}px`;
      style.width = `${this.canvas.clientWidth}px`; style.height = `${this.canvas.clientHeight}px`;
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

  /** Подложка мини-карты ещё строится — следующие вызовы drawMinimap её доделают. */
  pendingWork(): boolean {
    return this.terrain.minimapPending;
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
    const key = `${animTime}:${flowStep}:${this.world.step}:${this.world.mineral.version}:${this.world.viscosity.version}:${camera.zoom}:${camera.cx}:${camera.cy}:${this.canvas.width}:${this.canvas.height}:${this.showProcesses}:${this.streamView}`;
    if (key === this.frameKey) return;
    this.frameKey = key;
    const w = this.world;
    const frame: Frame = {
      ctx: this.ctx, canvas: this.canvas, camera, world: w, animTime, flowStep,
      detail: smoothstep(1, 4, camera.zoom / camera.fitZoom()),
      lit: lightTone(sunAt(w.light, w.step)) / lightTone(1),
    };
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.field.ready) {
      this.frameKey = '';
      this.unsupported(this.field.supported ? 'Изображение мира восстанавливается…' : 'Для показа мира нужен браузер с WebGL2.');
      return;
    }
    const fresh = this.terrain.refresh();
    if (fresh) this.water.buildSparkles(w, fresh.level, fresh.deposits);

    // Нижний холст: поля.
    const light = this.light.update(frame);
    const flowTime = this.water.clock(frame);
    this.field.begin(frame, w.partitions.thickness);
    const mineral = this.mineral.field(w);
    this.field.fields({
      spots: light.spots,
      mineral,
      terrain: this.terrain.data(),
      ripple: this.water.ripple,
      foam: this.water.foam(w),
      ...light.strength,
      rippleMode: this.showProcesses ? 1 : 0,
      ...this.streams(frame),
    });
    this.water.drawSparkles(frame, this.field);
    const streams = this.showProcesses ? 0 : this.water.streakMix();
    this.suspension.draw(frame, flowTime, this.showProcesses ? 0 : 1 - streams, this.field);

    // Верхний холст: объекты; свечения и отверстия воронок копятся для нижнего.
    ctx.setTransform(...camera.view());
    this.mineral.draw(frame);
    this.sources.drawEruptions(frame, this.field);
    // Жерла — отверстия в недра: поверх течений, ничто не проходит сквозь них.
    this.sources.drawVents(frame, this.field);
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
    this.field.finish();
  }

  /**
   * Вид течений на ускорении: доля штрихов (от ×3), поле для них — мгновенное
   * или усреднённое (от ×300) течение воды либо перенос минерала (`streamView`).
   */
  private streams(frame: Frame): { streakMix: number; stream: StreamField | null; averageMix: number; view: StreamView } {
    const streakMix = this.showProcesses ? 0 : this.water.streakMix();
    const w = frame.world;
    // Мерило силы — сильное течение при текущем солнце, единиц мира в секунду модели.
    const ref = DRIFT_REFERENCE * 10 * Math.max(0.05, sunAt(w.light, w.step));
    return {
      streakMix,
      stream: streakMix > 0 ? this.water.streamField(frame, this.streamView, ref) : null,
      averageMix: this.water.averageMix(),
      view: this.streamView,
    };
  }

  /** Сообщение вместо мира, когда WebGL2 нет или контекст потерян. */
  private unsupported(text: string): void {
    const ctx = this.ctx;
    ctx.fillStyle = '#41505a';
    ctx.font = `${14 * this.camera.dpr}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(text, this.canvas.width / 2, this.canvas.height / 2);
    ctx.textAlign = 'start';
  }

  /** Дождаться, пока видеокарта дорисует кадр (для замеров). */
  syncGpu(): void {
    this.field.sync();
  }

  /** Кадр целиком (оба холста) — для проверки отрисовки; вызывать сразу после draw. */
  snapshot(): HTMLCanvasElement {
    const out = document.createElement('canvas');
    out.width = this.canvas.width; out.height = this.canvas.height;
    const c = out.getContext('2d')!;
    if (this.field.ready) c.drawImage(this.field.canvas, 0, 0);
    c.drawImage(this.canvas, 0, 0);
    return out;
  }

  /** Мини-карта в отдельной панели: вся чашка, пятна света, перегородки и рамка вида. */
  drawMinimap(mini: HTMLCanvasElement): void {
    // Скрытая карта не рисуется — и подложка для неё не строится.
    if (!this.world || !mini.clientWidth || !mini.clientHeight) return;
    this.minimap.draw(mini, {
      world: this.world, camera: this.camera, base: this.terrain.minimapBase(), parts: this.walls.parts,
    });
  }

  /** Точка мини-карты (координаты окна) → центр вида там. */
  centerFromMinimap(mini: HTMLCanvasElement, clientX: number, clientY: number): void {
    const [x, y] = Minimap.toWorld(mini, this.world, clientX, clientY);
    if (!insideDish(this.world.dish, x, y)) return;
    this.camera.setView(this.camera.zoom, x, y);
  }
}
