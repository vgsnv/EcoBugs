/** Форма и геометрическая граница чашки; размеры фиксируются при создании. */
import { DISH_AREA } from './constants.ts';
import type { WorldParams } from './params.ts';

export interface Dish {
  readonly shape: 'rectangle' | 'circle';
  readonly width: number;
  readonly height: number;
  readonly area: number;
}

export function dishOf(params: Pick<WorldParams, 'shape' | 'aspectRatio'>): Dish {
  const width = params.shape === 'circle' ? 2 * Math.sqrt(DISH_AREA / Math.PI) : Math.sqrt(DISH_AREA * params.aspectRatio);
  return { shape: params.shape, width, height: params.shape === 'circle' ? width : DISH_AREA / width, area: DISH_AREA };
}

export function insideDish(dish: Dish, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= dish.width || y >= dish.height) return false;
  if (dish.shape === 'rectangle') return true;
  const r = dish.width / 2;
  return (x - r) ** 2 + (y - r) ** 2 < r * r;
}

/** Физическая клетка целиком внутри чашки; обрезанные клетки не хранят ресурс. */
export function cellInsideDish(dish: Dish, x: number, y: number, cell: number): boolean {
  if (x < 0 || y < 0 || x + cell > dish.width + 1e-9 || y + cell > dish.height + 1e-9) return false;
  if (dish.shape === 'rectangle') return true;
  const r = dish.width / 2;
  const dx = Math.max(Math.abs(x - r), Math.abs(x + cell - r));
  const dy = Math.max(Math.abs(y - r), Math.abs(y + cell - r));
  return dx * dx + dy * dy <= r * r;
}
