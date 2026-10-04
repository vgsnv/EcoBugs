/**
 * Штрихи течений — вид течений на ускорении (×10 и выше), когда перенос
 * ряби с настоящей скоростью уже не уследить. Метод IBFV (van Wijk, 2002):
 * каждый кадр прошлая картинка сдвигается вдоль течения и в неё подмешивается
 * мерцающий шум — шум вытягивается в штрихи по направлению течения и бежит
 * вниз по потоку. Направление — честное; скорость штрихов на экране от
 * скорости мира не зависит: она растёт с силой течения по логарифму и
 * ограничена (STREAK_PX). Яркость — тоже по силе.
 *
 * Картинка штрихов — в пикселях CSS (не устройства); при сдвиге и
 * масштабе камеры прошлый кадр читается в своей камере, поэтому штрихи
 * держатся за мир.
 */
import { TERRAIN_GLSL } from './terrain.ts';

/** Сдвиг штрихов за кадр (1/60 с), пикселей CSS: у слабого и у сильного течения. */
export const STREAK_PX: readonly [number, number] = [0.4, 3];
/** Доля свежего шума за кадр: меньше — длиннее штрихи. */
export const STREAK_FRESH = 0.05;
/** Мерцание шума, раз в секунду: каждая ячейка шума вспыхивает и гаснет со своей фазой. */
export const STREAK_PULSE = 1.4;
/** Ячейка шума, пикселей CSS: крупнее сдвига за кадр, иначе шум усредняется в ровный серый. */
export const STREAK_CELL = 3;
/** Доля времени, когда ячейка шума светится: меньше — штрихи реже. */
export const STREAK_DUTY = 0.25;
/** Рябь сменяется штрихами между этими множителями скорости мира. */
export const STREAKS_FROM = 3;
export const STREAKS_FULL = 10;
/**
 * Мгновенное течение в штрихах сменяется скользящим средним (окно —
 * AVERAGE_SECONDS реального времени) между этими множителями: на ×1000 и
 * выше течения меняются быстрее, чем за ними можно следить, и смысл имеет
 * только устойчивая картина — главные потоки, круговороты, заводи.
 */
export const AVERAGE_FROM = 300;
export const AVERAGE_FULL = 1000;
export const AVERAGE_SECONDS = 0.6;

/** Общий кусок: течение в точке мира по сетке вида и сила течения 0…1 (логарифм от мерила). */
export const FLOW_GLSL = `
uniform sampler2D u_flow;
uniform vec4 u_bounds;      // видимая часть мира для поля течений
uniform float u_flowScale;
uniform float u_hasFlow;
/** Скорость течения, единиц мира в секунду модели. */
vec2 flowAt(vec2 w) {
  if (u_hasFlow < .5) return vec2(0.);
  vec4 f = texture(u_flow, (w - u_bounds.xy) / (u_bounds.zw - u_bounds.xy));
  vec2 encoded = vec2(f.r * 65280. + f.g * 255., f.b * 65280. + f.a * 255.);
  return (encoded - 32768.) / 32767. * u_flowScale;
}
`;

export const STREAK_FS = `#version 300 es
precision highp float;
precision highp int;
uniform vec2 u_size;        // холст штрихов, пикселей
uniform vec2 u_device;      // основной холст, пикселей устройства
uniform float u_scale;      // пикселей штрихов на пиксель устройства
uniform vec3 u_cam;         // масштаб (пикселей устройства на единицу мира), центр x, y
uniform vec3 u_prevCam;     // то же в прошлом кадре
uniform vec2 u_prevDevice;
uniform float u_frames;     // сколько кадров по 1/60 с прошло
uniform float u_time;       // секунды анимации
uniform float u_fresh;
uniform vec2 u_px;          // сдвиг за кадр у слабого и сильного течения, пикселей штрихов
uniform sampler2D u_prev;
uniform sampler2D u_stream;      // поле штрихов: направление (x, y), сила
uniform vec3 u_streamGrid;       // столбцы, строки, клетка
${TERRAIN_GLSL}
out vec4 o;

float hash12(vec2 p) {
  uvec2 q = uvec2(ivec2(p)) * uvec2(1597334673u, 3812015801u);
  uint n = (q.x ^ q.y) * 1597334673u;
  return float(n) / 4294967296.;
}

void main() {
  // Пиксель штрихов (сверху вниз) → пиксель устройства → точка мира.
  vec2 q = vec2(gl_FragCoord.x, u_size.y - gl_FragCoord.y);
  vec2 device = q / u_scale;
  vec2 w = u_cam.yz + (device - u_device * .5) / u_cam.x;
  // Свежий шум: каждая точка мерцает со своей фазой (прямоугольный импульс).
  float fresh = fract(u_time * ${STREAK_PULSE.toFixed(2)} + hash12(floor(gl_FragCoord.xy / ${STREAK_CELL.toFixed(1)}))) < ${STREAK_DUTY.toFixed(2)} ? 1. : 0.;
  float water = waterAt(w);
  if (water <= 0.) { o = vec4(fresh, 0., 0., 1.); return; }
  vec4 f = texture(u_stream, w / u_streamGrid.z / u_streamGrid.xy);
  vec2 v = f.xy;
  float s = f.z;
  float speed = length(v);
  // Откуда пришла точка за прошедшие кадры: вверх по течению на сдвиг в пикселях штрихов.
  float shift = mix(u_px.x, u_px.y, s) * u_frames;
  vec2 from = speed > 0. ? w - v / speed * shift / (u_cam.x * u_scale) : w;
  vec2 prevDevice = (from - u_prevCam.yz) * u_prevCam.x + u_prevDevice * .5;
  vec2 pq = prevDevice * u_scale;
  vec2 uv = vec2(pq.x, u_size.y - pq.y) / u_size;
  float old = (uv.x < 0. || uv.y < 0. || uv.x > 1. || uv.y > 1.) ? fresh : texture(u_prev, uv).r;
  o = vec4(mix(old, fresh, u_fresh), s, 0., 1.);
}`;
