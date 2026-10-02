import { MILLIGRAMS_PER_UNIT, MILLIMETRES_PER_UNIT, secondsFromSteps, STEPS_PER_SECOND } from '../core/units.ts';
const number = new Intl.NumberFormat('ru', { maximumFractionDigits: 2 });
export const formatNumber = (value: number): string => number.format(value);
export const formatPercent = (fraction: number): string => `${formatNumber(fraction * 100)}%`;
export const formatMultiplier = (value: number): string => `×${formatNumber(value)}`;
export function formatLength(value: number): string {
  const mm = value * MILLIMETRES_PER_UNIT;
  return mm >= 1000 ? `${formatNumber(mm / 1000)} м` : mm >= 100 ? `${formatNumber(mm / 10)} см` : `${formatNumber(mm)} мм`;
}
export const formatArea = (value: number): string => `${formatNumber(value * MILLIMETRES_PER_UNIT ** 2 / 1e6)} м²`;
export function formatMass(value: number): string {
  const mg = value * MILLIGRAMS_PER_UNIT;
  return mg >= 1e6 ? `${formatNumber(mg / 1e6)} кг` : mg >= 1000 ? `${formatNumber(mg / 1000)} г` : `${formatNumber(mg)} мг`;
}
export function formatDuration(steps: number): string {
  const seconds = Math.max(0, secondsFromSteps(steps));
  return seconds >= 86400 ? `${formatNumber(seconds / 86400)} сут` : seconds >= 3600 ? `${formatNumber(seconds / 3600)} ч` : seconds >= 60 ? `${formatNumber(seconds / 60)} мин` : `${formatNumber(seconds)} с`;
}
/** Без накопления погрешности: часы всегда выводятся из целого номера шага. */
export function formatWorldAge(step: number): string {
  const whole = Math.floor(step / STEPS_PER_SECOND);
  const days = Math.floor(whole / 86400);
  const pad = (v: number) => String(v).padStart(2, '0');
  const clock = `${pad(Math.floor(whole / 3600) % 24)}:${pad(Math.floor(whole / 60) % 60)}:${pad(whole % 60)},${step % STEPS_PER_SECOND}`;
  return days ? `${days} д ${clock}` : clock;
}
