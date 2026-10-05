/**
 * Миникарта в углу карты. Видна, только когда карта приближена. В покое —
 * контур чашки и рамка вида (карта под ними почти не закрыта); под курсором —
 * полная картинка, клик и перетаскивание переводят вид. Угол выбирает сама —
 * где под ней меньше важного: в первую очередь стол за краем чашки, иначе
 * подальше от закреплённой точки, извержений, толчков и курсора; переезжает,
 * только когда камера стоит. Включена ли — удобство одного зрителя.
 */
import { insideDish, type World } from '../core/index.ts';
import type { WorldRenderer } from './render.ts';

/** Ширина в покое и под курсором, отступ от края карты, пикселей экрана (CSS). */
const SIZE = 132;
const SIZE_FULL = 200;
const INSET = 10;
/** Камера стоит столько, мс, — тогда можно пересесть в другой угол. */
const SETTLE_MS = 350;
/** Новый угол должен быть заметно лучше — иначе миникарта не дёргается. */
const STAY_BONUS = 0.2;
/** Через сколько мс после ухода курсора миникарта снова только контур. */
const LEAVE_MS = 500;
const STORE_KEY = 'world.minimap';

/** Места, которые не стоит закрывать: координаты мира. */
export type AvoidPoint = { x: number; y: number };

export class MinimapOverlay {
  readonly root = document.createElement('div');
  private readonly canvas = document.createElement('canvas');
  private readonly hideButton = document.createElement('button');
  private readonly stage: HTMLElement;
  private readonly renderer: WorldRenderer;
  private readonly onEnabled: (on: boolean) => void;
  enabled = true;
  private full = false;
  private dragging = false;
  private leaveTimer = 0;
  /** Угол: 0 — левый верхний, 1 — правый верхний, 2 — левый нижний, 3 — правый нижний. */
  private corner = 3;
  private viewKey = '';
  private viewSince = 0;
  private lastPick = 0;

  constructor(stage: HTMLElement, renderer: WorldRenderer, onEnabled: (on: boolean) => void) {
    this.stage = stage;
    this.renderer = renderer;
    this.onEnabled = onEnabled;
    try { this.enabled = localStorage.getItem(STORE_KEY) !== 'off'; } catch { /* Без хранилища — включена. */ }
    this.root.className = 'minimap-overlay';
    this.root.hidden = true;
    this.canvas.className = 'minimap';
    this.canvas.ariaLabel = 'Мини-карта чашки';
    this.canvas.title = 'Клик или перетаскивание — перевести вид';
    this.hideButton.type = 'button';
    this.hideButton.className = 'minimap-hide';
    this.hideButton.title = this.hideButton.ariaLabel = 'Скрыть миникарту (вернуть — кнопкой с картой в шапке)';
    this.hideButton.textContent = '×';
    this.hideButton.addEventListener('click', () => this.setEnabled(false));
    this.root.append(this.canvas, this.hideButton);
    stage.append(this.root);
    this.root.addEventListener('pointerenter', () => { clearTimeout(this.leaveTimer); this.setFull(true); });
    this.root.addEventListener('pointerleave', () => {
      clearTimeout(this.leaveTimer);
      this.leaveTimer = window.setTimeout(() => { if (!this.dragging) this.setFull(false); }, LEAVE_MS);
    });
    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this.dragging = true;
      this.canvas.setPointerCapture(e.pointerId);
      this.renderer.centerFromMinimap(this.canvas, e.clientX, e.clientY);
    });
    this.canvas.addEventListener('pointermove', (e) => { if (this.dragging) this.renderer.centerFromMinimap(this.canvas, e.clientX, e.clientY); });
    const end = () => { this.dragging = false; };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
    this.root.addEventListener('wheel', (e) => e.stopPropagation());
  }

  toggle(): void { this.setEnabled(!this.enabled); }

  private setEnabled(on: boolean): void {
    this.enabled = on;
    try { localStorage.setItem(STORE_KEY, on ? 'on' : 'off'); } catch { /* Необязательно. */ }
    this.onEnabled(on);
  }

  private setFull(on: boolean): void {
    if (this.full === on) return;
    this.full = on;
    this.root.classList.toggle('full', on);
    this.place();
  }

  /**
   * Кадр: показать или спрятать, при стоящей камере выбрать угол, нарисовать.
   * `avoid` — что не закрывать, `pointer` — курсор в координатах окна.
   */
  update(world: World, now: number, avoid: readonly AvoidPoint[], pointer: { clientX: number; clientY: number } | null): void {
    const visible = this.enabled && !this.renderer.fitted;
    this.renderer.setViewMargin(this.enabled ? SIZE + INSET : 0);
    if (this.root.hidden === visible) {
      this.root.hidden = !visible;
      if (visible) { this.lastPick = 0; this.pick(world, avoid, pointer, true); }
    }
    if (!visible) { this.full = false; this.root.classList.remove('full'); return; }
    const [x0, y0, x1, y1] = this.renderer.visibleWorld();
    const key = `${x0}:${y0}:${x1}:${y1}:${this.stage.clientWidth}:${this.stage.clientHeight}`;
    if (key !== this.viewKey) { this.viewKey = key; this.viewSince = now; this.place(); }
    // Пока камера движется или курсор над миникартой — угол не меняется.
    if (!this.full && !this.dragging && now - this.viewSince > SETTLE_MS && now - this.lastPick > SETTLE_MS) {
      this.lastPick = now;
      this.pick(world, avoid, pointer, false);
    }
    this.renderer.drawMinimap(this.canvas, this.full);
  }

  /** Размер миникарты сейчас, пикселей экрана (CSS): по пропорциям чашки. */
  private size(world?: World): [number, number] {
    const w = this.full ? SIZE_FULL : SIZE;
    const d = world?.dish;
    const ratio = d ? d.height / d.width : 0.75;
    return [w, Math.round(w * Math.min(1.2, ratio))];
  }

  private worldRef: World | null = null;

  /** Поставить в выбранный угол (плавно — переходом CSS). */
  private place(): void {
    const [w, h] = this.size(this.worldRef ?? undefined);
    const W = this.stage.clientWidth, H = this.stage.clientHeight;
    const left = this.corner % 2 === 0 ? INSET : W - w - INSET;
    const top = this.corner < 2 ? INSET : H - h - INSET;
    Object.assign(this.root.style, { left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${h}px` });
  }

  /** Выбрать угол, где под миникартой меньше важного. */
  private pick(world: World, avoid: readonly AvoidPoint[], pointer: { clientX: number; clientY: number } | null, force: boolean): void {
    this.worldRef = world;
    const [w, h] = this.size(world);
    const r = this.stage.getBoundingClientRect();
    let best = this.corner, bestScore = Infinity;
    for (let c = 0; c < 4; c++) {
      const left = r.left + (c % 2 === 0 ? INSET : r.width - w - INSET);
      const top = r.top + (c < 2 ? INSET : r.height - h - INSET);
      // Доля места под миникартой, занятая чашкой (стол за краем закрывать не жалко).
      let inside = 0, n = 0;
      for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) {
        const [x, y] = this.renderer.clientToWorld(left + (i + 0.5) * w / 5, top + (j + 0.5) * h / 5);
        n++; if (insideDish(world.dish, x, y)) inside++;
      }
      let score = inside / n;
      const pad = 16;
      for (const p of avoid) {
        const [sx, sy] = this.renderer.worldToClient(p.x, p.y);
        if (sx > left - pad && sx < left + w + pad && sy > top - pad && sy < top + h + pad) score += 2;
      }
      if (pointer && pointer.clientX > left - pad && pointer.clientX < left + w + pad && pointer.clientY > top - pad && pointer.clientY < top + h + pad) score += 0.5;
      // В полном экране вверху — метка времени и кнопки.
      if (c < 2 && this.stage.closest('.focus-mode')) score += 1;
      if (c === this.corner && !force) score -= STAY_BONUS;
      if (score < bestScore) { bestScore = score; best = c; }
    }
    if (force || best !== this.corner) {
      // Первое появление — сразу на месте, без перелёта.
      this.root.classList.toggle('instant', force);
      this.corner = best;
      this.place();
      if (force) requestAnimationFrame(() => this.root.classList.remove('instant'));
    }
  }
}
