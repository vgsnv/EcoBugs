/**
 * Свет освещает местность пятнами. Яркость места — свет, который туда
 * реально доходит: солнце × (пятно, фон или переход) × прозрачность среды,
 * по постоянной шкале (lightShade в palette.ts): пятно при солнце 1 — обычная
 * яркость, тень — по доле фона, но не темнее SHADE_COLOR. Освещённые места
 * теплеют (нагрев усиливает) и чуть высветляются; ярче солнца 1 — блик. Здесь — эллипсы пятен
 * (параметрами, из модели) и сила света; маску (форма края и мягкость)
 * строит GPU (SPOT_VS / SPOT_FS), смешивание — шейдер полей.
 */
import { SPOT_EDGE, SPOT_SHAPE_SIZE, spotShapes, sunAt } from '../../core/index.ts';
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
  /** Полутень: σ мягкого края, пикселей устройства. */
  readonly penumbra: number;
}

/** Эллипсы пятен для шейдера: по SPOT_SHAPE_SIZE чисел (см. spotShapes), их число и версия. */
export interface SpotShapes {
  readonly data: Float32Array;
  readonly count: number;
  readonly version: number;
}

export class LightLayer {
  private step = -1;
  private shapes: SpotShapes = { data: new Float32Array(0), count: 0, version: 0 };

  reset(): void {
    this.step = -1;
  }

  /** Эллипсы пятен этого шага (пересчёт — при смене шага) и сила света кадра. */
  update(frame: Frame): { spots: SpotShapes; strength: LightStrength } {
    const { camera, world: w } = frame;
    const p = w.params;
    if (w.step !== this.step) {
      this.step = w.step;
      const data = spotShapes(w.light, w.step, w.dish.width, w.dish.height);
      this.shapes = { data, count: data.length / SPOT_SHAPE_SIZE, version: this.shapes.version + 1 };
    }
    return {
      spots: this.shapes,
      strength: {
        // Свет — солнечный тёплый оттенок освещённых мест; нагрев его усиливает
        // (в шейдере — ещё по тому, сколько света дошло).
        warmth: Math.min(0.95, SUN_WARMTH + HEAT_WARMTH * Math.min(1, p.spotHeat / 2)),
        // И чуть высветляет их, чтобы свет читался и на тёмной суше.
        glow: SUN_GLOW,
        sunNow: sunAt(w.light, w.step),
        background: p.backgroundLevel,
        penumbra: Math.min(3 * camera.dpr, Math.max(0.5, (p.spotSize * SPOT_EDGE * camera.zoom) / 6)),
      },
    };
  }
}

/**
 * Маска пятен на GPU: каждый эллипс рисуется своим прямоугольником (до
 * «докуда светит» плюс запас на размытие) в текстуру с наложением «максимум» —
 * пиксель считает только покрывающие его пятна. R — резкий край (сглажен в
 * пиксель), G — край, размытый гауссом σ (px). Точка внутри эллипса, если её
 * радиус в его осях меньше волнистой границы; расстояние до границы — вдоль
 * луча из центра, в пикселях экрана.
 */
export const SPOT_VS = `#version 300 es
in vec2 a_pos;
in vec4 a_s0;   // центр x, y; докуда светит; r·k
in vec4 a_s1;   // r/k; cos, sin поворота; e3
in vec4 a_s2;   // e5; фазы волн 3 и 5; середина края
uniform vec3 u_view;
uniform vec2 u_size;
uniform float u_pad;   // запас на размытие, единиц мира
out vec2 v_d;
flat out vec4 v_s0;
flat out vec4 v_s1;
flat out vec4 v_s2;
void main() {
  float reach = a_s0.z + u_pad;
  vec2 d = (a_pos * 2. - 1.) * reach;
  vec2 p = (a_s0.xy + d) * u_view.x + u_view.yz;
  gl_Position = vec4(p.x / u_size.x * 2. - 1., 1. - p.y / u_size.y * 2., 0., 1.);
  v_d = d; v_s0 = a_s0; v_s1 = a_s1; v_s2 = a_s2;
}`;

export const SPOT_FS = `#version 300 es
precision highp float;
in vec2 v_d;
flat in vec4 v_s0;
flat in vec4 v_s1;
flat in vec4 v_s2;
uniform float u_zoom;
uniform float u_sigma;
out vec4 o;
float erfApprox(float x) {
  float s = sign(x), a = abs(x);
  float t = 1. / (1. + .3275911 * a);
  return s * (1. - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - .284496736) * t + .254829592) * t * exp(-a * a));
}
void main() {
  vec2 d = v_d;
  float u = (d.x * v_s1.y + d.y * v_s1.z) / v_s0.w;
  float v = (-d.x * v_s1.z + d.y * v_s1.y) / v_s1.x;
  float rho = max(length(vec2(u, v)), 1e-6);
  float phi = atan(v, u);
  float bound = (1. + v_s1.w * sin(3. * phi + v_s2.y) + v_s2.x * sin(5. * phi + v_s2.z)) * v_s2.w;
  float dist = length(d) * (1. - bound / rho) * u_zoom;
  float hard = clamp(.5 - dist, 0., 1.);
  float soft = u_sigma < .35 ? hard : .5 - .5 * erfApprox(dist / (u_sigma * 1.41421356));
  o = vec4(hard, soft, 0., 1.);
}`;
