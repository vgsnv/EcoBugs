/**
 * Следы взвеси — вид течений на ускорении: частицы взвеси (suspension.ts)
 * рисуются в отдельную картинку следов, а прошлая картинка каждый кадр
 * гаснет (как на картах ветра и океанских течений): за частицей тянется
 * тающий хвост вдоль течения. На ×1 хвостов нет; от ×TRAILS_FROM до
 * ×TRAILS_FULL они вырастают до TRAIL_SECONDS. На ×AVERAGE_FROM…AVERAGE_FULL
 * частицы переходят с мгновенного течения на его скользящее среднее
 * (окно AVERAGE_SECONDS реального времени): на ×1000 и выше течения меняются
 * быстрее, чем за ними можно следить, и смысл имеет устойчивая картина —
 * главные потоки, круговороты, заводи.
 *
 * Картинка следов — в пикселях CSS; прошлый кадр читается в своей камере,
 * поэтому следы держатся за мир при сдвиге и масштабе.
 */

export const TRAILS_FROM = 3;
export const TRAILS_FULL = 10;
/** Время угасания следа (до e⁻¹), секунды реального времени, при полной длине. */
export const TRAIL_SECONDS = 1.2;
export const AVERAGE_FROM = 300;
export const AVERAGE_FULL = 1000;
export const AVERAGE_SECONDS = 0.6;

/** Угасание прошлого кадра следов с пересчётом под нынешнюю камеру. */
export const TRAIL_FADE_FS = `#version 300 es
precision highp float;
uniform vec2 u_size;        // холст следов, пикселей
uniform vec2 u_device;      // основной холст, пикселей устройства
uniform float u_scale;      // пикселей следов на пиксель устройства
uniform vec3 u_cam;         // масштаб (пикселей устройства на единицу мира), центр x, y
uniform vec3 u_prevCam;     // то же в прошлом кадре
uniform vec2 u_prevDevice;
uniform float u_keep;       // сколько остаётся от прошлого кадра
uniform float u_floor;      // и сколько ещё вычитается: в 8 битах слабый след иначе не гаснет (округление)
uniform sampler2D u_prev;
out vec4 o;
void main() {
  vec2 q = vec2(gl_FragCoord.x, u_size.y - gl_FragCoord.y);
  vec2 w = u_cam.yz + (q / u_scale - u_device * .5) / u_cam.x;
  vec2 pq = ((w - u_prevCam.yz) * u_prevCam.x + u_prevDevice * .5) * u_scale;
  vec2 uv = vec2(pq.x, u_size.y - pq.y) / u_size;
  vec4 old = (uv.x < 0. || uv.y < 0. || uv.x > 1. || uv.y > 1.) ? vec4(0.) : texture(u_prev, uv);
  o = max(old * u_keep - u_floor, 0.);
}`;

/** Частица в картинку следов: капсула вдоль течения, к голове ярче; яркость — в R (наложение «максимум»). */
export const TRAIL_DASH_FS = `#version 300 es
precision highp float;
uniform float u_zoom;       // пикселей устройства на единицу мира
in vec2 v_local;
in vec4 v_color;
in float v_alpha;
in float v_radiusPx;
in vec2 v_dash;
out vec4 o;
void main() {
  vec2 q = v_local * v_dash;
  float d = length(vec2(max(abs(q.x) - (v_dash.x - v_dash.y), 0.), q.y)) - v_dash.y;
  float a = clamp(.5 - d * u_zoom, 0., 1.) * mix(.35, 1., v_local.x * .5 + .5) * v_alpha;
  o = vec4(a, 0., 0., a);
}`;
