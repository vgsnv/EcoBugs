/**
 * Стол, на котором стоит чашка, — в координатах мира (сдвигается и
 * масштабируется вместе с ней). Чаша — один стеклянный материал: стенки,
 * перегородки и дно; где грунта и залежей не осталось, стол виден сквозь
 * стеклянное дно (шейдер полей, terrainAt); недра не показываются. Стол —
 * светлый матовый лабораторный коврик с сеткой 1 см и 10 см (единица модели —
 * 1 мм), стекло чистое, с голубоватым оттенком.
 */

/** Оттенок стекла — множитель цвета того, что за ним. */
export const GLASS_TINT: readonly [number, number, number] = [0.9, 0.96, 1];

/**
 * Цвет стола в точке мира (GLSL, 0…1); `u_cam.x` — пикселей устройства на
 * единицу мира (тонкие линии — в пиксель).
 */
export const TABLE_GLSL = `

uint tableMix(uint x) {
  x += 0x9e3779b9u;
  x = (x ^ (x >> 16u)) * 0x85ebca6bu;
  x = (x ^ (x >> 13u)) * 0xc2b2ae35u;
  return x ^ (x >> 16u);
}
float tableHash(ivec2 p, uint salt) { return float(tableMix(uint(p.x) * 0x27d4eb2du ^ tableMix(uint(p.y) ^ salt))) / 4294967296.; }
/** Сглаженный шум по узлам целочисленной решётки. */
float tableNoise(vec2 p, uint salt) {
  ivec2 i = ivec2(floor(p));
  vec2 f = fract(p);
  f = f * f * (3. - 2. * f);
  float a = tableHash(i, salt), b = tableHash(i + ivec2(1, 0), salt);
  float c = tableHash(i + ivec2(0, 1), salt), d = tableHash(i + ivec2(1, 1), salt);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
/** Линия сетки шагом step (единиц мира) толщиной около пикселя; гаснет, когда линии гуще minPx пикселей. */
float gridLine(vec2 w, float step, float minPx) {
  float px = 1. / u_cam.x;
  vec2 d = abs(fract(w / step + .5) - .5) * step / px;
  float line = 1. - smoothstep(.4, 1.2, min(d.x, d.y));
  return line * smoothstep(minPx, minPx * 2., step * u_cam.x);
}

vec3 tableAt(vec2 w) {
  // Светлый матовый коврик, мелкое зерно, сетка 1 см и 10 см.
  vec3 c = vec3(222., 228., 224.) / 255.;
  c *= .985 + .03 * tableNoise(w / 1.7, 7u);
  c = mix(c, vec3(150., 168., 166.) / 255., .45 * gridLine(w, 10., 4.));
  c = mix(c, vec3(112., 134., 134.) / 255., .7 * gridLine(w, 100., 3.));
  return c;
}`;
