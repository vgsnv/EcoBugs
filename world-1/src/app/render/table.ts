/**
 * Стол, на котором стоит чашка, — в координатах мира (сдвигается и
 * масштабируется вместе с ней). Чаша — один стеклянный материал: стенки,
 * перегородки и дно; где грунта и залежей не осталось, стол виден сквозь
 * стеклянное дно (шейдер полей, terrainAt). Два варианта на выбор:
 * - «коврик» — светлый матовый лабораторный коврик с сеткой 1 см и 10 см
 *   (единица модели — 1 мм), стекло чистое, с голубоватым оттенком;
 * - «дерево» — светлые кленовые доски с волокнами, стекло зеленоватое, как оконное.
 */

export type TableKind = 'mat' | 'wood';

export const TABLE_KINDS: readonly TableKind[] = ['mat', 'wood'];
export const TABLE_NAMES: Record<TableKind, string> = { mat: 'коврик', wood: 'дерево' };

/** Оттенок стекла (множитель цвета того, что за ним) — для обоих вариантов. */
export const GLASS_TINT: Record<TableKind, readonly [number, number, number]> = {
  mat: [0.9, 0.96, 1],
  wood: [0.86, 0.97, 0.9],
};

/**
 * Цвет стола в точке мира (GLSL, 0…1). `u_table` — 0 коврик, 1 дерево;
 * `u_cam.x` — пикселей устройства на единицу мира (тонкие линии — в пиксель).
 */
export const TABLE_GLSL = `
uniform int u_table;

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
  if (u_table == 0) {
    // Коврик: светлый матовый, мелкое зерно, сетка 1 см и 10 см.
    vec3 c = vec3(222., 228., 224.) / 255.;
    c *= .985 + .03 * tableNoise(w / 1.7, 7u);
    c = mix(c, vec3(150., 168., 166.) / 255., .45 * gridLine(w, 10., 4.));
    c = mix(c, vec3(112., 134., 134.) / 255., .7 * gridLine(w, 100., 3.));
    return c;
  }
  // Дерево: доски поперёк по y шириной 140 мм, у каждой свой тон и сдвиг волокон.
  float plank = floor(w.y / 140.);
  float tone = tableHash(ivec2(int(plank), 3), 11u);
  vec2 p = vec2(w.x + tone * 900., w.y);
  float grain = tableNoise(vec2(p.x / 260., p.y / 7.), 21u) * .6 + tableNoise(vec2(p.x / 60., p.y / 2.2), 23u) * .4;
  float rings = .5 + .5 * sin((p.y + 40. * tableNoise(vec2(p.x / 400., p.y / 30.), 29u)) * .35);
  vec3 c = mix(vec3(222., 192., 148.) / 255., vec3(196., 158., 108.) / 255., .55 * grain + .25 * rings * grain);
  c *= .93 + .12 * tone;
  // Стык досок — тонкая тёмная линия.
  float seam = abs(fract(w.y / 140.) - .5) * 140. * u_cam.x;
  c *= 1. - .35 * (1. - smoothstep(.3, 1.4, 70. * u_cam.x - seam));
  return c;
}`;
