/**
 * Путь порции залпа (спецификация, «Движение выброшенного вещества»):
 * порция летит от жерла почти по прямой, тратит запас дальности тем быстрее,
 * чем вязче то, над чем летит (вода : отмель : суша = 1 : 3 : 9), течение
 * сносит её; о стенку или перегородку бьётся — поперечная составляющая
 * отражается и сильно гаснет (слабый отскок), продольная сохраняется, но
 * тоже убывает (трение, скольжение вдоль стены); запас дальности убывает
 * вместе со скоростью. В отверстии воронки порция останавливается.
 *
 * Упрощение (на будущее): бросок мгновенный — путь целиком считается в момент
 * залпа по течению этого момента, и масса сразу ложится туда, где порция
 * остановилась; «в полёте» вещество не бывает. Честнее — порции, летящие во
 * времени и сносимые меняющимся течением (тогда они — часть состояния мира).
 */
import { THROW_BOUNCE, THROW_FRICTION, THROW_SPEED } from './constants.ts';
import { multiplierForLevel } from './viscosity.ts';

export interface ThrowWorld {
  /** Сетка уровня местности (клетки `cell`). */
  readonly cols: number;
  readonly rows: number;
  readonly cell: number;
  readonly level: Float32Array;
  /** Занято ли место (стенка, перегородка, вне чашки). */
  readonly blocked: (x: number, y: number) => boolean;
  /** Отверстие воронки в точке (не обязательно). */
  readonly hole?: (x: number, y: number) => boolean;
  /** Течение в точке, единиц мира за шаг (не обязательно). */
  readonly flow?: (x: number, y: number, out: [number, number]) => void;
}

/** Не больше стольких шагов на путь — защита от застревания в углах. */
const MAX_STEPS = 800;
/** Запас меньше этой доли шага — порция остановилась. */
const STOP = 0.25;

/**
 * Где остановится порция, брошенная из (x, y) под углом `angle` с запасом
 * дальности `budget` (в «вязком» расстоянии). С `path` — точки пути (x, y подряд).
 */
export function traceThrow(w: ThrowWorld, x: number, y: number, angle: number, budget: number, path?: number[]): [number, number] {
  const step = w.cell * 0.5;
  let dx = Math.cos(angle), dy = Math.sin(angle);
  let left = budget;
  const v: [number, number] = [0, 0];
  path?.push(x, y);
  for (let n = 0; n < MAX_STEPS && left > step * STOP; n++) {
    const i = Math.min(w.cols - 1, Math.max(0, Math.floor(x / w.cell))), j = Math.min(w.rows - 1, Math.max(0, Math.floor(y / w.cell)));
    const mult = multiplierForLevel(w.level[j * w.cols + i]);
    const ds = Math.min(step, left / mult);
    // Снос течением — за время пролёта этого отрезка с собственной скоростью.
    if (w.flow) w.flow(x, y, v); else { v[0] = 0; v[1] = 0; }
    const dt = ds / THROW_SPEED;
    const nx = x + dx * ds + v[0] * dt, ny = y + dy * ds + v[1] * dt;
    if (w.blocked(nx, ny)) {
      // Удар: составляющая поперёк стены отражается и гаснет, вдоль — убывает от трения.
      // В углу (или при косом касании угла) гаснут обе.
      const wallX = w.blocked(x + dx * ds, y), wallY = w.blocked(x, y + dy * ds);
      let ex: number, ey: number;
      if (wallX === wallY) { ex = -THROW_BOUNCE * dx; ey = -THROW_BOUNCE * dy; }
      else if (wallX) { ex = -THROW_BOUNCE * dx; ey = THROW_FRICTION * dy; }
      else { ex = THROW_FRICTION * dx; ey = -THROW_BOUNCE * dy; }
      // Направление — единичное; запас дальности убывает вместе со скоростью.
      const speed = Math.hypot(ex, ey);
      if (speed < 1e-9) break;
      left *= speed;
      dx = ex / speed; dy = ey / speed;
      continue;
    }
    x = nx; y = ny;
    left -= ds * mult;
    path?.push(x, y);
    if (w.hole?.(x, y)) break;
  }
  return [x, y];
}
