/**
 * Законы среды текущего мира — то, что задают параметры для знатоков:
 * сопротивление градаций и мутность. Их читают и ядро (снос, перенос
 * минерала), и показ, поэтому они хранятся здесь и выставляются из
 * параметров при сотворении и загрузке мира (setMediumLaws) — в каждом
 * потоке, где живёт мир. Один мир на поток.
 */
import type { WorldParams } from './params.ts';

/** Сопротивление воды, отмели и суши (вода — 1). */
export const resistance: [number, number, number] = [1, 3, 9];
/** Мутность: прозрачность = 1 / (1 + turbidity × плотность раствора в расчётных единицах). */
export const medium = { turbidity: 0.11 };

export function setMediumLaws(params: Pick<WorldParams, 'resistanceShallows' | 'resistanceLand' | 'turbidityLoss'>): void {
  resistance[1] = params.resistanceShallows;
  resistance[2] = params.resistanceLand;
  // Потеря света на 1000 г/м² раствора (доля) → коэффициент мутности.
  const loss = Math.min(0.95, Math.max(0, params.turbidityLoss));
  medium.turbidity = loss / (1 - loss);
}
