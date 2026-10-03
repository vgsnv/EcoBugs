/** Масштаб модели. Состояние и файлы остаются в расчётных единицах. */
export const MILLIMETRES_PER_UNIT = 1;
export const MILLIGRAMS_PER_UNIT = 1;
export const SECONDS_PER_STEP = 0.1;
export const STEPS_PER_SECOND = 1 / SECONDS_PER_STEP;
export const secondsFromSteps = (steps: number): number => steps / STEPS_PER_SECOND;
export const stepsFromSeconds = (seconds: number): number => seconds * STEPS_PER_SECOND;
export const millimetresPerSecond = (perStep: number): number => perStep * MILLIMETRES_PER_UNIT * STEPS_PER_SECOND;
/** мг/мм² → г/м². */
export const gramsPerSquareMetre = (density: number): number => density * MILLIGRAMS_PER_UNIT / MILLIMETRES_PER_UNIT ** 2 * 1000;
