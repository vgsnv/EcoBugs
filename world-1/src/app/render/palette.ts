/** Цвета мира и общие функции отрисовки. Цвета местности и света нужны и легенде. */
import type { Dish } from '../../core/index.ts';

export type Rgb = readonly [number, number, number];

/** Вода: глубокая и над отмелью. */
export const DEEP_WATER: Rgb = [28, 101, 142];
export const SHALLOW_WATER: Rgb = [102, 180, 188];
/** Камень суши: средняя яркость, разброс пятнами и зерном, трещины. */
export const STONE_BASE = 61;
export const STONE_MOTTLE = 15;
export const STONE_GRAIN = 6;
export const STONE_CRACK = 12;
/** Размер плит камня между трещинами, единиц мира. */
export const STONE_SLAB = 14;
/** Камень под водой светлее: вода его подсвечивает. */
export const STONE_UNDERWATER_LIFT = 36;
/** Насколько вода над отмелью прозрачна (0 — не видно камня, 1 — только камень). */
export const SHALLOWS_CLARITY = 0.42;
/** Условная влажная кромка по уровню среды, без геометрической высоты и новых волн. */
export const WET_SHORE: Rgb = [31, 51, 55];
export const SHORE_LIGHT: Rgb = [151, 201, 194];
/**
 * Залежи минерала на дне: тёмно-фиолетовые, с мелкими светлыми кристаллами;
 * с какой густоты залежей (от средней плотности запаса) начинаются и с какой
 * сплошные, наибольшая укрывистость, доля и яркость кристаллов.
 */
export const DEPOSIT_COLOR: Rgb = [101, 57, 137];
export const DEPOSIT_FROM = 0.5;
export const DEPOSIT_FULL = 8;
export const DEPOSIT_MAX = 0.9;
export const CRYSTAL_SHARE = 0.06;
export const CRYSTAL_LIGHT = 70;
/** Образцы для легенды. */
export const STONE_SAMPLE: Rgb = [STONE_BASE + 6, STONE_BASE + 3, STONE_BASE];
export const SHALLOWS_SAMPLE: Rgb = mix(lift(STONE_SAMPLE, STONE_UNDERWATER_LIFT), SHALLOW_WATER, 1 - SHALLOWS_CLARITY);

/** Тень умножается на местность: темнее и холоднее. */
export const SHADE_COLOR: Rgb = [140, 150, 185];
/** Солнечный оттенок освещённых мест. */
export const SUN_COLOR: Rgb = [255, 232, 185];

/**
 * Минерал — вещество с градациями плотности (цвет не занят ни местностью, ни
 * светом, ни будущей жизнью), но не главное на картинке. Цвет тонкого слоя.
 */
export const MINERAL_COLOR: Rgb = [216, 165, 255];
/** Цвет густой дымки минерала. */
export const MINERAL_DEEP: Rgb = [185, 131, 237];

export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
export function lift(c: Rgb, d: number): Rgb {
  return [c[0] + d, c[1] + d, c[2] + d];
}

export const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
/** Плавная ступенька от a до b. */
export const smoothstep = (a: number, b: number, t: number) => { const u = clamp01((t - a) / (b - a)); return u * u * (3 - 2 * u); };

/** Свет → 0…1: экспоненциальное насыщение, одинаковое для всех миров. */
export function lightTone(light: number): number {
  return 1 - Math.exp(-1.1 * light);
}

export const rgb = (c: Rgb, alpha = 1) => `rgba(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}, ${alpha})`;

/** Контур чашки (для обрезки и обводки), в единицах мира. */
export function traceDish(ctx: CanvasRenderingContext2D, dish: Dish): void {
  if (dish.shape === 'circle') ctx.arc(dish.width / 2, dish.height / 2, dish.width / 2, 0, Math.PI * 2);
  else ctx.rect(0, 0, dish.width, dish.height);
}
