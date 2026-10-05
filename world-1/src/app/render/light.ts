/**
 * Свет освещает местность пятнами. Яркость места — свет, который туда
 * реально доходит: солнце × (пятно, фон или переход) × прозрачность среды,
 * по постоянной шкале (lightShade в palette.ts): пятно при солнце 1 — обычная
 * яркость, тень — по доле фона, но не темнее SHADE_COLOR. Освещённые места
 * теплеют (нагрев усиливает) и чуть высветляются; ярче солнца 1 — блик.
 * Маску света считает GPU тем же полем, что и модель (LIGHT_MASK_FS). Здесь — эллипсы пятен
 */
import { LIGHT_FIELD_GLSL, lightBackground, lightFieldUniforms, sunAt } from '../../core/index.ts';
import type { Frame } from './frame.ts';

/** Сила солнечного оттенка при солнце 1 и добавка от нагрева (при нагреве 2). */
const SUN_WARMTH = 0.2;
const HEAT_WARMTH = 0.35;
/** Лёгкое высветление освещённых мест, чтобы свет читался и на тёмном камне. */
const SUN_GLOW = 0.07;

export interface LightStrength {
  readonly warmth: number;
  readonly glow: number;
  /** Сила солнца сейчас и доля фона — для яркости места в шейдере полей. */
  readonly sunNow: number;
  readonly background: number;
}

/** Параметры светового поля для шейдера маски (LIGHT_FIELD_GLSL ядра). */
export type LightField = ReturnType<typeof lightFieldUniforms>;

export class LightLayer {
  reset(): void {}

  /** Поле света этого шага и сила света кадра. */
  update(frame: Frame): { field: LightField; strength: LightStrength } {
    const { world: w } = frame;
    const p = w.params;
    return {
      field: lightFieldUniforms(w.light, w.step),
      strength: {
        // Свет — солнечный тёплый оттенок освещённых мест; нагрев его усиливает
        // (в шейдере — ещё по тому, сколько света дошло).
        warmth: Math.min(0.95, SUN_WARMTH + HEAT_WARMTH * Math.min(1, p.spotHeat / 2)),
        // И чуть высветляет их, чтобы свет читался и на тёмной суше.
        glow: SUN_GLOW,
        sunNow: sunAt(w.light, w.step),
        background: lightBackground(w.light),
      },
    };
  }
}

/**
 * Маска света на GPU — то же поле, что в модели: G — свет пятен 0…1 (плавный
 * край), R — то же, но с краем в пару пикселей (для бликов ряби и блёсток),
 * B — налегание: свет сверх одного пятна в долях OVERLAP_MAX (перекрытия светлее).
 */
/** Сколько пятен сверх первого различает маска в местах налегания. */
export const OVERLAP_MAX = 3;
/** Во сколько раз маска света грубее холста по каждой оси. */
export const LIGHT_MASK_SCALE = 2;

export const LIGHT_MASK_FS = (common: string) => `#version 300 es
precision highp float;
precision highp int;
${common}
${LIGHT_FIELD_GLSL}
uniform vec2 u_maskSize;   // размер маски, px (меньше холста в LIGHT_MASK_SCALE раз)
uniform float u_maskScale;
out vec4 o;
void main() {
  // Поле плавное — маска в пониженном разрешении, на холст растягивается со сглаживанием.
  vec2 px = vec2(gl_FragCoord.x, u_maskSize.y - gl_FragCoord.y) * u_maskScale;
  float sum = lightField(worldAt(px));
  float l = min(1., sum);
  float sharp = smoothstep(.35, .65, l);
  o = vec4(sharp, l, clamp((sum - 1.) / ${OVERLAP_MAX.toFixed(1)}, 0., 1.), 1.);
}`;
