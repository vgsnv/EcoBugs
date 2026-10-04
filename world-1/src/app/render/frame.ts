import type { World } from '../../core/index.ts';
import type { Camera } from './camera.ts';

/** Всё, что слою нужно знать о текущем кадре. */
export interface Frame {
  readonly ctx: CanvasRenderingContext2D;
  readonly canvas: HTMLCanvasElement;
  readonly camera: Camera;
  readonly world: World;
  /** Секунды анимации (стоят на паузе) и шаг, до которого показаны течения. */
  readonly animTime: number;
  readonly flowStep: number;
  /** Детали эффектов проявляются плавно от всей чашки до ×4. */
  readonly detail: number;
  /** Сила света пятен в абсолютной шкале: 1 при солнце 1. */
  readonly lit: number;
}
