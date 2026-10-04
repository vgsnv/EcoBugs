/**
 * Нижний холст WebGL2: тень чашки на столе, затем одним проходом местность,
 * свет, вода и минерал; поверх — отверстия воронок и свечения (режим «screen»
 * смешивается с тем, что под ним, поэтому свечения рисуются здесь, а не на
 * верхнем Canvas 2D). Верхний холст рисует объекты.
 */
import type { Dish } from '../../core/index.ts';
import type { Frame } from './frame.ts';
import { createProgram, Textures, type Program, type TextureSource } from './gl.ts';
import { MINERAL_COLOR, MINERAL_DEEP, SHADE_COLOR, SUN_COLOR, smoothstep, type Rgb } from './palette.ts';
import { SPOT_FS, SPOT_VS, type SpotShapes } from './light.ts';
import { TRAIL_DASH_FS, TRAIL_FADE_FS, TRAIL_SECONDS } from './trails.ts';
import type { StreamField, StreamView } from './water.ts';
import { TERRAIN_GLSL, type Grid, type TerrainData } from './terrain.ts';
import { TECTONICS_GLSL, type Tectonics } from './ground.ts';

/** Свечения и блёстки: копятся за кадр и рисуются после полей, в порядке вызовов. */
export interface GlowSink {
  /** Мягкое круглое пятно цвета `color` (спрайт свечения), режим «screen»; `clip` — только внутри чашки. */
  glow(color: Rgb, x: number, y: number, radius: number, alpha: number, clip: boolean): void;
  /** Четырёхлучевая звёздочка (блёстка), только в пятнах света и внутри чашки. */
  star(x: number, y: number, radius: number, alpha: number): void;
  /** Картинка поверх полей (обычное наложение), например отверстия воронок. */
  image(source: TextureSource, version: number, dx: number, dy: number, dw: number, dh: number, alpha: number): void;
}

/** Всё, что нужно проходу полей: источники текстур и их версии. */
export interface FieldInputs {
  /** Эллипсы пятен света. */
  readonly spots: SpotShapes;
  /** Минерал на сетке поля: R — затемнение дна, G — задержка света, B — густота цвета, A — непрозрачность дымки. */
  readonly mineral: { readonly image: TextureSource; readonly version: number; readonly width: number; readonly height: number };
  /** Местность: сетки для шейдера. */
  readonly terrain: TerrainData;
  /** Свежесть грунта (сетка минерала) и идущие подвижки и толчки. */
  readonly fresh: Grid;
  readonly tectonics: Tectonics;
  /** Узор ряби (альфа, бесшовный): равномерная рябь при «Процессах» и пена. */
  readonly ripple: HTMLCanvasElement;
  /** Пена у берега (альфа), на всю чашку. */
  readonly foam: { readonly canvas: HTMLCanvasElement; readonly version: number };
  /** Сила света: тёплый оттенок, высветление, блик яркого солнца; полутень, px устройства. */
  readonly warmth: number;
  readonly glow: number;
  readonly glare: number;
  readonly penumbra: number;
  /** Рябь: 0 — по течениям, 1 — две равномерные ряби (при «Процессах»). */
  readonly rippleMode: 0 | 1;
  /** Длина следов взвеси (0 — без следов, 1 — полные); частицы взвеси (SPRITE_FLOATS чисел на штуку); поле течений; доля усреднённого течения; что показывают. */
  readonly trailMix: number;
  readonly particles: Float32Array;
  readonly stream: StreamField | null;
  readonly averageMix: number;
  readonly view: StreamView;
}

const QUAD_VS = `#version 300 es
in vec2 a_pos;
uniform vec4 u_dst;
uniform vec4 u_src;
uniform vec3 u_view;
uniform vec2 u_size;
out vec2 v_uv;
void main() {
  vec2 w = u_dst.xy + a_pos * u_dst.zw;
  vec2 p = w * u_view.x + u_view.yz;
  gl_Position = vec4(p.x / u_size.x * 2. - 1., 1. - p.y / u_size.y * 2., 0., 1.);
  v_uv = u_src.xy + a_pos * u_src.zw;
}`;

const IMAGE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_alpha;
out vec4 o;
void main() { o = texture(u_tex, v_uv) * u_alpha; }`;

const FULL_VS = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos * 2. - 1., 0., 1.); }`;

/** Общие функции фрагментных шейдеров: пиксель экрана сверху вниз, точка мира, чашка. */
const COMMON = `
uniform vec2 u_size;
uniform vec3 u_cam;   // масштаб, центр вида x, y
uniform vec3 u_dish;  // ширина, высота, круг (1) или прямоугольник (0)
vec2 screenPx() { return vec2(gl_FragCoord.x, u_size.y - gl_FragCoord.y); }
vec2 worldAt(vec2 px) { return u_cam.yz + (px - u_size * .5) / u_cam.x; }
/** Насколько точка внутри чашки, со сглаженным краем в пиксель. */
float insideDish(vec2 w) {
  float d;
  if (u_dish.z > .5) d = u_dish.x * .5 - length(w - u_dish.xy * .5);
  else d = min(min(w.x, u_dish.x - w.x), min(w.y, u_dish.y - w.y));
  return clamp(d * u_cam.x + .5, 0., 1.);
}`;

const SHADOW_FS = `#version 300 es
precision highp float;
${COMMON}
uniform float u_wall;
uniform float u_dpr;
out vec4 o;
float erfApprox(float x) {
  float s = sign(x), a = abs(x);
  float t = 1. / (1. + .3275911 * a);
  float y = 1. - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - .284496736) * t + .254829592) * t * exp(-a * a);
  return s * y;
}
/** Доля фигуры (чашка со стенкой), размытой гауссом σ (px), в пикселе px со сдвигом вниз. */
float covered(vec2 px, float sigma, float drop) {
  vec2 w = worldAt(px - vec2(0., drop));
  float k = 1. / (sigma * 1.41421356);
  if (u_dish.z > .5) {
    float d = (u_dish.x * .5 + u_wall - length(w - u_dish.xy * .5)) * u_cam.x;
    return .5 + .5 * erfApprox(d * k);
  }
  vec2 lo = (vec2(-u_wall) - w) * u_cam.x, hi = (u_dish.xy + u_wall - w) * u_cam.x;
  vec2 c = .5 * (vec2(erfApprox(hi.x * k), erfApprox(hi.y * k)) - vec2(erfApprox(lo.x * k), erfApprox(lo.y * k)));
  return c.x * c.y;
}
void main() {
  vec2 px = screenPx();
  float shape = covered(px, .35, 0.);
  vec4 shadow = vec4(31., 53., 47., 255.) / 255.;
  float a1 = .32 * covered(px, 6. * u_dpr, 5. * u_dpr);
  float a2 = .25 * covered(px, 1.5 * u_dpr, 2. * u_dpr);
  vec4 c = vec4(shadow.rgb * a1, a1);
  c = vec4(shadow.rgb * a2, a2) + c * (1. - a2);
  vec4 fill = vec4(vec3(188., 206., 210.) / 255., 1.) * shape;
  o = fill + c * (1. - shape);
}`;

const FIELD_FS = `#version 300 es
precision highp float;
precision highp int;
${COMMON}
${TERRAIN_GLSL}
${TECTONICS_GLSL}
uniform sampler2D u_spotMask;    // R — пятна с резким краем, G — с мягким
uniform sampler2D u_mineral;
uniform sampler2D u_ripple;
uniform sampler2D u_foam;
uniform sampler2D u_trails;       // R — взвесь и её следы, G — песочная взвесь
uniform float u_trailMix;         // длина следов 0…1
uniform sampler2D u_stream;       // поле течений для взвеси: направление, сила
uniform vec3 u_streamGrid;
uniform float u_averageMix;       // доля усреднённого течения
uniform vec3 u_trailColor;
uniform vec2 u_grid;        // протяжённость сетки минерала в мире
uniform float u_lit;
uniform float u_warmth;
uniform float u_glow;
uniform float u_glare;
uniform int u_rippleMode;
uniform float u_time;       // секунды анимации
uniform vec3 u_shade;
uniform vec3 u_sun;
uniform vec3 u_mineralThin;
uniform vec3 u_mineralDeep;
out vec4 o;

float rippleAt(vec2 uv) { return texture(u_ripple, uv).a; }

vec3 screenOver(vec3 c, vec3 s) { return c + s * (1. - c); }

void main() {
  vec2 px = screenPx();
  vec2 w = worldAt(px);
  float inside = insideDish(w);
  if (inside <= 0.) { o = vec4(0.); return; }
  vec3 c = terrainAt(w);
  vec4 mineral = texture(u_mineral, w / u_grid);
  float held = mineral.g;
  float lit1 = min(1., u_lit);

  // Свет: тень вне пятен (умножением), тёплый оттенок, высветление, блик яркого солнца.
  vec2 sp = texture(u_spotMask, gl_FragCoord.xy / u_size).rg;
  float mb = sp.y * (1. - held);
  c *= mix(vec3(1.), u_shade, 1. - mb * lit1);
  c *= mix(vec3(1.), u_sun, u_warmth * mb);
  c = screenOver(c, u_sun * u_glow * mb);
  c = screenOver(c, vec3(u_glare * mb));

  // Подвижки и толчки — тонко, поверх света.
  c = tectonics(c, w, u_time);

  // Рябь на воде.
  float water = waterAt(w);
  float spots = sp.x * (1. - held);
  if (u_rippleMode == 0) {
    // Взвесь и её следы (suspension.ts, trails.ts): светлые, у минерала — сиреневые; в пятнах света ярче.
    vec2 tr = texture(u_trails, gl_FragCoord.xy / u_size).rg;
    c = screenOver(c, u_trailColor * tr.x * (.55 + .45 * sp.y) * water * .9);
    // Песок — своим цветом поверх воды (осветление выбелило бы его до цвета остальной взвеси).
    c = mix(c, vec3(.86, .7, .42) * (.8 + .25 * sp.y), min(1., tr.y * 1.2) * water * .75);
    // Устойчивая картина: где течение (перенос) сильное в среднем — мягкая подсветка.
    if (u_averageMix > 0.) {
      float strong = texture(u_stream, w / u_streamGrid.z / u_streamGrid.xy).z;
      c = screenOver(c, u_trailColor * strong * strong * water * u_averageMix * u_trailMix * .14);
    }
  } else {
    vec3 tone = vec3(1., 250. / 255., 230. / 255.);
    float a0 = rippleAt((w - vec2(5., 2.5) * u_time) / 130.);
    float a1 = rippleAt((w - vec2(-3.5, 4.) * u_time) / 210.);
    vec3 glint = min(vec3(1.), tone * (a0 + a1));
    c = screenOver(c, glint * water * spots * .15 * lit1);
  }

  // Пена у берега: бегущая рябь и ровная белизна по маске пены.
  float foam = texture(u_foam, w / u_dish.xy).a;
  if (foam > 0.) {
    float ra = rippleAt((w + vec2(6., -3.) * u_time) / 60.);
    vec3 tone = vec3(1., 250. / 255., 230. / 255.);
    c = screenOver(c, (.35 + .65 * tone * ra) * foam * .4);
  }

  // Минерал: мутность затемняет дно, дымка ложится поверх.
  c *= mineral.r;
  vec3 haze = mix(u_mineralThin, u_mineralDeep, mineral.b);
  c = c * (1. - mineral.a) + haze * mineral.a;

  o = vec4(c * inside, inside);
}`;

const SPRITE_VS = `#version 300 es
in vec2 a_pos;
in vec4 a_sprite;   // x, y, радиус (у чёрточки — полуширина), непрозрачность
in vec4 a_color;    // цвет, вид (0 — свечение, 1 — звёздочка, 2 — чёрточка)
in vec4 a_shape;    // направление (x, y), полудлина
uniform vec3 u_view;
uniform vec2 u_size;
out vec2 v_local;
out vec4 v_color;
out float v_alpha;
out float v_radiusPx;
out vec2 v_dash;    // полудлина и полуширина чёрточки, единиц мира
void main() {
  vec2 local = a_pos * 2. - 1.;
  vec2 dir = a_shape.xy, side = vec2(-dir.y, dir.x);
  vec2 w = a_sprite.xy + dir * local.x * a_shape.z + side * local.y * a_sprite.z;
  v_dash = vec2(a_shape.z, a_sprite.z);
  vec2 p = w * u_view.x + u_view.yz;
  gl_Position = vec4(p.x / u_size.x * 2. - 1., 1. - p.y / u_size.y * 2., 0., 1.);
  v_local = local;
  v_color = a_color;
  v_alpha = a_sprite.w;
  v_radiusPx = a_sprite.z * u_view.x;
}`;

const SPRITE_FS = `#version 300 es
precision highp float;
${COMMON}
uniform sampler2D u_spotMask;
uniform sampler2D u_mineral;
uniform vec2 u_grid;
uniform int u_clip;
in vec2 v_local;
in vec4 v_color;
in float v_alpha;
in float v_radiusPx;
out vec4 o;
void main() {
  vec2 px = screenPx();
  vec2 w = worldAt(px);
  float a;
  if (v_color.a < .5) {
    // Свечение: непрозрачность 1 → 0,55 к 0,4 радиуса → 0 у края.
    float r = length(v_local);
    if (r >= 1.) discard;
    a = r < .4 ? mix(1., .55, r / .4) : mix(.55, 0., (r - .4) / .6);
  } else {
    // Звёздочка: два ромба с полуосями 1 и 0,3; край сглажен в пиксель.
    vec2 q = abs(v_local);
    float d = min(q.x + q.y / .3, q.x / .3 + q.y) - 1.;
    a = clamp(.5 - d * v_radiusPx, 0., 1.);
    a *= texture(u_spotMask, gl_FragCoord.xy / u_size).r * (1. - texture(u_mineral, w / u_grid).g);
  }
  if (u_clip == 1) a *= insideDish(w);
  a *= v_alpha;
  o = vec4(v_color.rgb * a, a);
}`;

/** Чисел на спрайт: положение и размер, цвет и вид, направление и полудлина. */
export const SPRITE_FLOATS = 12;

/** Шаг экрана, после которого скопленные свечения и картинки рисуются по порядку. */
type Command =
  | { kind: 'image'; source: TextureSource; version: number; rect: readonly number[]; alpha: number }
  | { kind: 'sprites'; clip: boolean; data: number[] | Float32Array };

export class FieldRenderer implements GlowSink {
  readonly canvas = document.createElement('canvas');
  private gl: WebGL2RenderingContext | null = null;
  private textures!: Textures;
  private quad!: WebGLBuffer;
  private spriteBuffer!: WebGLBuffer;
  private imageProgram!: Program;
  private shadow!: Program;
  private field!: Program;
  private sprites!: Program;
  private spriteVao!: WebGLVertexArrayObject;
  private quadVao!: WebGLVertexArrayObject;
  private commands: Command[] = [];
  private frame: Frame | null = null;
  /** Ключи текстур, которые не меняются между кадрами. */
  private readonly mineralKey = {};
  private readonly streamKey = {};
  private readonly levelKey = {};
  private readonly depositKey = {};
  private readonly mottleKey = {};
  private readonly grainKey = {};
  private readonly cracksKey = {};
  private readonly blockedKey = {};
  private readonly freshKey = {};
  private terrainWorld: object | null = null;
  /** Следы взвеси: программы, два холста по очереди, какой из них текущий, время и камера прошлого шага. */
  private trailFade!: Program;
  private trailDash!: Program;
  private trailBuffers: { framebuffer: WebGLFramebuffer; texture: WebGLTexture }[] = [];
  private trailSize: [number, number] = [0, 0];
  private trailFront = 0;
  private trailTime: number | null = null;
  private trailCamera: { zoom: number; cx: number; cy: number; width: number; height: number } | null = null;
  private readonly foamKey = {};
  private mineralTexture: WebGLTexture | null = null;
  /** Маска пятен (вне экрана) и данные эллипсов для неё. */
  private spotMask: { framebuffer: WebGLFramebuffer; texture: WebGLTexture; width: number; height: number } | null = null;
  private spotProgram!: Program;
  private spotVao!: WebGLVertexArrayObject;
  private spotBuffer!: WebGLBuffer;
  private spotVersion = -1;
  private spotCount = 0;
  /** Есть ли WebGL2; потеря контекста временно выключает рисование. */
  readonly supported: boolean;
  private lost = false;

  constructor() {
    this.canvas.className = 'field-gl';
    this.canvas.addEventListener('webglcontextlost', (event) => { event.preventDefault(); this.lost = true; });
    this.canvas.addEventListener('webglcontextrestored', () => { this.lost = false; this.init(); });
    this.supported = this.init();
  }

  private init(): boolean {
    const gl = this.canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
    if (!gl) return false;
    this.gl = gl;
    this.textures = new Textures(gl);
    this.terrainWorld = null;
    this.imageProgram = createProgram(gl, QUAD_VS, IMAGE_FS);
    this.shadow = createProgram(gl, FULL_VS, SHADOW_FS);
    this.field = createProgram(gl, FULL_VS, FIELD_FS);
    this.sprites = createProgram(gl, SPRITE_VS, SPRITE_FS);
    this.quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    this.quadVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.quadVao);
    for (const p of [this.imageProgram, this.shadow, this.field]) {
      const at = gl.getAttribLocation(p.program, 'a_pos');
      if (at >= 0) { gl.enableVertexAttribArray(at); gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0); }
    }
    this.spriteBuffer = gl.createBuffer()!;
    this.spriteVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.spriteVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    const pos = gl.getAttribLocation(this.sprites.program, 'a_pos');
    gl.enableVertexAttribArray(pos); gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteBuffer);
    const sprite = gl.getAttribLocation(this.sprites.program, 'a_sprite');
    const color = gl.getAttribLocation(this.sprites.program, 'a_color');
    const shape = gl.getAttribLocation(this.sprites.program, 'a_shape');
    const stride = SPRITE_FLOATS * 4;
    gl.enableVertexAttribArray(sprite); gl.vertexAttribPointer(sprite, 4, gl.FLOAT, false, stride, 0); gl.vertexAttribDivisor(sprite, 1);
    gl.enableVertexAttribArray(color); gl.vertexAttribPointer(color, 4, gl.FLOAT, false, stride, 16); gl.vertexAttribDivisor(color, 1);
    gl.enableVertexAttribArray(shape); gl.vertexAttribPointer(shape, 4, gl.FLOAT, false, stride, 32); gl.vertexAttribDivisor(shape, 1);
    gl.bindVertexArray(null);
    this.mineralTexture = null;
    this.spotProgram = createProgram(gl, SPOT_VS, SPOT_FS);
    this.trailFade = createProgram(gl, FULL_VS, TRAIL_FADE_FS);
    this.trailDash = createProgram(gl, SPRITE_VS, TRAIL_DASH_FS);
    this.trailBuffers = [];
    this.trailSize = [0, 0];
    this.trailTime = null;
    this.spotBuffer = gl.createBuffer()!;
    this.spotVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.spotVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.spotBuffer);
    for (let n = 0; n < 3; n++) {
      const at = gl.getAttribLocation(this.spotProgram.program, `a_s${n}`);
      gl.enableVertexAttribArray(at); gl.vertexAttribPointer(at, 4, gl.FLOAT, false, 48, n * 16); gl.vertexAttribDivisor(at, 1);
    }
    gl.bindVertexArray(null);
    this.spotMask = null;
    this.spotVersion = -1;
    return true;
  }

  get ready(): boolean {
    return !!this.gl && !this.lost && !this.gl.isContextLost();
  }

  /** Начало кадра: размер холста, очистка, тень чашки на столе. */
  begin(frame: Frame, wall: number): void {
    const gl = this.gl!;
    this.frame = frame;
    this.commands = [];
    const { width, height } = frame.canvas;
    if (this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height; }
    gl.viewport(0, 0, width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.shadow.program);
    this.common(this.shadow, frame.world.dish);
    gl.uniform1f(this.shadow.uniform('u_wall'), wall);
    gl.uniform1f(this.shadow.uniform('u_dpr'), frame.camera.dpr);
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private drawImage(texture: WebGLTexture, src: readonly number[], dst: readonly number[], alpha: number): void {
    const gl = this.gl!;
    const frame = this.frame!;
    gl.useProgram(this.imageProgram.program);
    const view = frame.camera.view();
    gl.uniform3f(this.imageProgram.uniform('u_view'), view[0], view[4], view[5]);
    gl.uniform2f(this.imageProgram.uniform('u_size'), this.canvas.width, this.canvas.height);
    gl.uniform4f(this.imageProgram.uniform('u_src'), src[0], src[1], src[2], src[3]);
    gl.uniform4f(this.imageProgram.uniform('u_dst'), dst[0], dst[1], dst[2], dst[3]);
    gl.uniform1f(this.imageProgram.uniform('u_alpha'), alpha);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(this.imageProgram.uniform('u_tex'), 0);
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private common(p: Program, dish: Dish): void {
    const gl = this.gl!;
    const { camera } = this.frame!;
    gl.uniform2f(p.uniform('u_size'), this.canvas.width, this.canvas.height);
    gl.uniform3f(p.uniform('u_cam'), camera.zoom, camera.cx, camera.cy);
    gl.uniform3f(p.uniform('u_dish'), dish.width, dish.height, dish.shape === 'circle' ? 1 : 0);
  }

  /** Маска пятен: эллипсы прямоугольниками в текстуру, наложение «максимум». */
  private drawSpotMask(spots: SpotShapes, penumbra: number): void {
    const gl = this.gl!;
    const frame = this.frame!;
    const { width, height } = this.canvas;
    let mask = this.spotMask;
    if (!mask || mask.width !== width || mask.height !== height) {
      if (mask) { gl.deleteFramebuffer(mask.framebuffer); gl.deleteTexture(mask.texture); }
      const texture = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      const framebuffer = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      mask = this.spotMask = { framebuffer, texture, width, height };
    }
    if (spots.version !== this.spotVersion) {
      this.spotVersion = spots.version;
      this.spotCount = spots.count;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.spotBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, spots.data, gl.DYNAMIC_DRAW);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, mask.framebuffer);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (this.spotCount > 0) {
      const p = this.spotProgram;
      gl.useProgram(p.program);
      const view = frame.camera.view();
      gl.uniform3f(p.uniform('u_view'), view[0], view[4], view[5]);
      gl.uniform2f(p.uniform('u_size'), width, height);
      gl.uniform1f(p.uniform('u_pad'), 3 * penumbra / frame.camera.zoom);
      gl.uniform1f(p.uniform('u_zoom'), frame.camera.zoom);
      gl.uniform1f(p.uniform('u_sigma'), penumbra);
      gl.blendEquation(gl.MAX);
      gl.bindVertexArray(this.spotVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.spotCount);
      gl.blendEquation(gl.FUNC_ADD);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private bind(p: Program, unit: number, name: string, texture: WebGLTexture | null): void {
    const gl = this.gl!;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(p.uniform(name), unit);
  }

  /** Сетка местности (ключ — постоянный на вид данных; загружается при смене версии) и её размеры. */
  private bindGrid(p: Program, unit: number, name: string, key: object, g: Grid | Grid<Uint8Array>, format: 'r16f' | 'rg32f' | 'r8'): void {
    this.bind(p, unit, name, this.textures.get(key, { data: g.data, width: g.cols, height: g.rows }, g.version, { format, nearest: format !== 'r16f' }));
    this.gl!.uniform3f(p.uniform(`${name}Grid`), g.cols, g.rows, g.step);
  }

  /** Поле течений для взвеси (сетка минерала, по 4 числа на клетку). */
  private bindStream(p: Program, unit: number, stream: StreamField): void {
    this.bind(p, unit, 'u_stream', this.textures.get(this.streamKey, { data: stream.data, width: stream.cols, height: stream.rows }, stream.version, { format: 'rgba16f' }));
    this.gl!.uniform3f(p.uniform('u_streamGrid'), stream.cols, stream.rows, stream.step);
  }

  /** Холсты следов (прошлый и новый кадр) в пикселях CSS; создаются под размер. */
  private trailTargets(): { framebuffer: WebGLFramebuffer; texture: WebGLTexture }[] {
    const gl = this.gl!;
    const width = Math.max(1, Math.round(this.canvas.width / this.frame!.camera.dpr));
    const height = Math.max(1, Math.round(this.canvas.height / this.frame!.camera.dpr));
    if (this.trailSize[0] !== width || this.trailSize[1] !== height) {
      for (const t of this.trailBuffers) { gl.deleteFramebuffer(t.framebuffer); gl.deleteTexture(t.texture); }
      this.trailBuffers = [0, 1].map(() => {
        const texture = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
        const framebuffer = gl.createFramebuffer()!;
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        return { framebuffer, texture };
      });
      this.trailSize = [width, height];
      this.trailCamera = null;
    }
    return this.trailBuffers;
  }

  /**
   * Шаг следов (trails.ts): прошлый кадр следов, пересчитанный под нынешнюю
   * камеру, гаснет (на паузе — нет), и поверх рисуются частицы взвеси.
   */
  private drawTrails(input: FieldInputs): WebGLTexture {
    const gl = this.gl!;
    const frame = this.frame!;
    const { camera } = frame;
    const buffers = this.trailTargets();
    const real = this.trailTime === null ? 0 : Math.max(0, Math.min(0.25, frame.animTime - this.trailTime));
    const seconds = TRAIL_SECONDS * input.trailMix;
    // Сколько остаётся от прошлого кадра: на паузе всё, без следов — ничего.
    const keep = real === 0 ? (this.trailTime === null ? 0 : 1) : seconds > 0.01 ? Math.exp(-real / seconds) : 0;
    const [prev, next] = [buffers[this.trailFront], buffers[1 - this.trailFront]];
    const scale = this.trailSize[0] / this.canvas.width;
    gl.bindFramebuffer(gl.FRAMEBUFFER, next.framebuffer);
    gl.viewport(0, 0, this.trailSize[0], this.trailSize[1]);
    gl.disable(gl.BLEND);
    const f = this.trailFade;
    gl.useProgram(f.program);
    const cam = this.trailCamera ?? { zoom: camera.zoom, cx: camera.cx, cy: camera.cy, width: this.canvas.width, height: this.canvas.height };
    gl.uniform2f(f.uniform('u_size'), this.trailSize[0], this.trailSize[1]);
    gl.uniform2f(f.uniform('u_device'), this.canvas.width, this.canvas.height);
    gl.uniform1f(f.uniform('u_scale'), scale);
    gl.uniform3f(f.uniform('u_cam'), camera.zoom, camera.cx, camera.cy);
    gl.uniform3f(f.uniform('u_prevCam'), cam.zoom, cam.cx, cam.cy);
    gl.uniform2f(f.uniform('u_prevDevice'), cam.width, cam.height);
    gl.uniform1f(f.uniform('u_keep'), keep);
    gl.uniform1f(f.uniform('u_floor'), keep < 1 ? 1.5 / 255 : 0);
    this.bind(f, 0, 'u_prev', prev.texture);
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // Частицы — поверх, наложение «максимум» (голова не ярче себя самой).
    const count = input.particles.length / SPRITE_FLOATS;
    if (count > 0) {
      const d = this.trailDash;
      gl.useProgram(d.program);
      const view = camera.view();
      gl.uniform3f(d.uniform('u_view'), view[0], view[4], view[5]);
      gl.uniform2f(d.uniform('u_size'), this.canvas.width, this.canvas.height);
      gl.uniform1f(d.uniform('u_zoom'), camera.zoom * scale);
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.MAX);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, input.particles, gl.STREAM_DRAW);
      gl.bindVertexArray(this.spriteVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
      gl.blendEquation(gl.FUNC_ADD);
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.trailFront = 1 - this.trailFront;
    this.trailTime = frame.animTime;
    this.trailCamera = { zoom: camera.zoom, cx: camera.cx, cy: camera.cy, width: this.canvas.width, height: this.canvas.height };
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    return buffers[this.trailFront].texture;
  }

  /** Поля поверх местности: свет, вода, минерал — в основной холст. */
  fields(input: FieldInputs): void {
    const gl = this.gl!;
    const frame = this.frame!;
    const { world } = frame;
    const m = world.mineral;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const p = this.field;
    const t = input.terrain;
    if (t.world !== this.terrainWorld) {
      // Новый мир — сетки местности загрузить заново.
      for (const key of [this.levelKey, this.depositKey, this.freshKey, this.mottleKey, this.grainKey, this.cracksKey, this.blockedKey]) this.textures.release(key);
      this.terrainWorld = t.world;
    }
    // Загрузка текстур и проходы вне экрана — до выбора программы полей.
    this.drawSpotMask(input.spots, input.penumbra);
    this.mineralTexture = this.textures.get(this.mineralKey, input.mineral.image, input.mineral.version);
    const ripple = this.textures.get(input.ripple, input.ripple, 0, { repeat: true });
    const foam = this.textures.get(this.foamKey, input.foam.canvas, input.foam.version);
    const trails = this.drawTrails(input);
    gl.useProgram(p.program);
    this.common(p, world.dish);
    this.bind(p, 1, 'u_spotMask', this.spotMask!.texture);
    this.bind(p, 2, 'u_mineral', this.mineralTexture);
    this.bind(p, 3, 'u_trails', trails);
    this.bind(p, 4, 'u_ripple', ripple);
    if (input.stream) this.bindStream(p, 13, input.stream);
    this.bind(p, 6, 'u_foam', foam);
    this.bindGrid(p, 7, 'u_level', this.levelKey, t.level, 'r16f');
    this.bindGrid(p, 8, 'u_deposit', this.depositKey, t.deposits, 'r16f');
    this.bindGrid(p, 9, 'u_mottle', this.mottleKey, t.mottle, 'r16f');
    this.bindGrid(p, 10, 'u_grain', this.grainKey, t.grain, 'r16f');
    this.bindGrid(p, 11, 'u_cracks', this.cracksKey, t.cracks, 'rg32f');
    this.bindGrid(p, 12, 'u_blocked', this.blockedKey, t.blocked, 'r8');
    this.bindGrid(p, 14, 'u_fresh', this.freshKey, input.fresh, 'r16f');
    const tec = input.tectonics;
    gl.uniform4fv(p.uniform('u_moveA'), tec.moves.filter((_, i) => i % 8 < 4));
    gl.uniform4fv(p.uniform('u_moveB'), tec.moves.filter((_, i) => i % 8 >= 4));
    gl.uniform1i(p.uniform('u_moveCount'), tec.moveCount);
    gl.uniform4fv(p.uniform('u_ring'), tec.rings);
    gl.uniform1i(p.uniform('u_ringCount'), tec.ringCount);
    gl.uniform1ui(p.uniform('u_seed'), t.seed >>> 0);
    // Мелкие детали камня проявляются с приближением, как прежде у плиток местности.
    gl.uniform1f(p.uniform('u_detail'), smoothstep(0.5, 4, frame.camera.zoom));
    gl.uniform2f(p.uniform('u_grid'), m.cols * m.cell, m.rows * m.cell);
    gl.uniform1f(p.uniform('u_lit'), frame.lit);
    gl.uniform1f(p.uniform('u_warmth'), input.warmth);
    gl.uniform1f(p.uniform('u_glow'), input.glow);
    gl.uniform1f(p.uniform('u_glare'), input.glare);
    gl.uniform1i(p.uniform('u_rippleMode'), input.rippleMode);
    gl.uniform1f(p.uniform('u_trailMix'), input.trailMix);
    gl.uniform1f(p.uniform('u_averageMix'), input.averageMix);
    // Вода — светлая взвесь; минерал — его цветом.
    const tone = input.view === 'water' ? [0.86, 0.95, 0.97] : [0.9, 0.72, 1];
    gl.uniform3f(p.uniform('u_trailColor'), tone[0], tone[1], tone[2]);
    gl.uniform1f(p.uniform('u_time'), frame.animTime);
    const unit = (c: Rgb) => [c[0] / 255, c[1] / 255, c[2] / 255] as const;
    gl.uniform3f(p.uniform('u_shade'), ...unit(SHADE_COLOR));
    gl.uniform3f(p.uniform('u_sun'), ...unit(SUN_COLOR));
    gl.uniform3f(p.uniform('u_mineralThin'), ...unit(MINERAL_COLOR));
    gl.uniform3f(p.uniform('u_mineralDeep'), ...unit(MINERAL_DEEP));
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  glow(color: Rgb, x: number, y: number, radius: number, alpha: number, clip: boolean): void {
    this.sprite(clip, [x, y, radius, alpha, color[0] / 255, color[1] / 255, color[2] / 255, 0, 1, 0, radius, 0]);
  }

  star(x: number, y: number, radius: number, alpha: number): void {
    this.sprite(true, [x, y, radius, alpha, 245 / 255, 230 / 255, 1, 1, 1, 0, radius, 0]);
  }

  private sprite(clip: boolean, values: number[]): void {
    const last = this.commands[this.commands.length - 1];
    if (last && last.kind === 'sprites' && last.clip === clip && Array.isArray(last.data)) last.data.push(...values);
    else this.commands.push({ kind: 'sprites', clip, data: values });
  }

  image(source: TextureSource, version: number, dx: number, dy: number, dw: number, dh: number, alpha: number): void {
    this.commands.push({ kind: 'image', source, version, rect: [dx, dy, dw, dh], alpha });
  }

  /** Дождаться, пока видеокарта дорисует кадр (для замеров): чтение одного пикселя ждёт всю очередь. */
  sync(): void {
    if (this.gl) this.gl.readPixels(0, 0, 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, new Uint8Array(4));
  }

  /** Нарисовать скопленные за кадр картинки и свечения — в порядке вызовов. */
  finish(): void {
    const gl = this.gl!;
    const frame = this.frame!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    for (const command of this.commands) {
      if (command.kind === 'image') {
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        // Холсты умножаются на альфу при загрузке; готовые пиксели уже умножены.
        const texture = this.textures.get(command.source as object, command.source, command.version, { premultiply: !('data' in command.source) });
        this.drawImage(texture, [0, 0, 1, 1], command.rect, command.alpha);
        continue;
      }
      // «Screen»: результат = свет + фон × (1 − свет).
      gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_COLOR, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      const p = this.sprites;
      gl.useProgram(p.program);
      this.common(p, frame.world.dish);
      const view = frame.camera.view();
      gl.uniform3f(p.uniform('u_view'), view[0], view[4], view[5]);
      gl.uniform1i(p.uniform('u_clip'), command.clip ? 1 : 0);
      gl.uniform2f(p.uniform('u_grid'), frame.world.mineral.cols * frame.world.mineral.cell, frame.world.mineral.rows * frame.world.mineral.cell);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.spotMask!.texture); gl.uniform1i(p.uniform('u_spotMask'), 1);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.mineralTexture); gl.uniform1i(p.uniform('u_mineral'), 2);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, command.data instanceof Float32Array ? command.data : new Float32Array(command.data), gl.STREAM_DRAW);
      gl.bindVertexArray(this.spriteVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, command.data.length / SPRITE_FLOATS);
    }
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(null);
    this.commands = [];
  }
}
