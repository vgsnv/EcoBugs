/**
 * Местность: вязкость и фактура камня, залежи на дне, берег. Цвет каждой
 * точки считает шейдер полей (render/field.ts, `terrainAt`) — здесь данные
 * для него: сетки уровня и залежей (меняются с миром) и неизменные на мир
 * узоры (пятна камня, зерно, точки трещин). Плюс уменьшенная подложка для
 * мини-карты — тем же расчётом на CPU, по частям и только пока карта видна.
 */
import type { Calculation } from '../../core/task.ts';
import { hash3, insideDish, periodicFbm, smoothLevelAt, type World } from '../../core/index.ts';
import {
  CRYSTAL_LIGHT, CRYSTAL_SHARE, DEEP_WATER, FRESH_GROUND, FRESH_MAX, DEPOSIT_COLOR, DEPOSIT_FROM, DEPOSIT_FULL, DEPOSIT_MAX, SHALLOW_WATER, SHALLOWS_CLARITY,
  SHORE_LIGHT, STONE_BASE, STONE_CRACK, STONE_GRAIN, STONE_MOTTLE, STONE_SLAB, STONE_UNDERWATER_LIFT, WET_SHORE, mix, smoothstep,
} from './palette.ts';

/** Шаги сеток узоров камня, единиц мира: крупные пятна и мелкое зерно. */
const MOTTLE_STEP = 4;
const GRAIN_STEP = 1.25;
/** Подложка мини-карты — пикселей на единицу мира; бюджет её построения за вызов, мс. */
const MINIMAP_SCALE = 0.25;
const MINIMAP_BUDGET_MS = 2;
/** Блёстки и подложку мини-карты обновлять не чаще, мс. */
const REFRESH_MS = 1000;

/** Значения на сетке с шагом `step` единиц мира. */
export interface Grid<T extends Float32Array | Uint8Array = Float32Array> {
  readonly data: T;
  readonly cols: number;
  readonly rows: number;
  readonly step: number;
  readonly version: number;
}

/** Всё, что шейдеру нужно для местности. */
export interface TerrainData {
  /** Ключ неизменных на мир узоров: новый с каждым миром. */
  readonly world: object;
  readonly seed: number;
  /** Пятна камня и зерно — в узлах сетки; точки ячеек трещин — x, y на ячейку (с рамкой в ячейку). */
  readonly mottle: Grid;
  readonly grain: Grid;
  readonly cracks: Grid;
  /** Плавный уровень 0…2 (центры клеток карты вязкости), залежи в средних плотностях (центры клеток минерала). */
  readonly level: Grid;
  readonly deposits: Grid;
  /** Перегородки: 1 — занято (клетки раскладки). */
  readonly blocked: Grid<Uint8Array>;
}

/** Поле, посчитанное в узлах сетки с шагом `step` (шейдер читает его билинейно по узлам). */
function gridValues(width: number, height: number, step: number, f: (x: number, y: number) => number): { data: Float32Array; cols: number; rows: number } {
  const cols = Math.ceil(width / step) + 2;
  const rows = Math.ceil(height / step) + 2;
  const data = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) data[j * cols + i] = f(i * step, j * step);
  return { data, cols, rows };
}

/** Точки ячеек Вороного для трещин между плитами камня (координаты — в размерах плиты). */
function crackPoints(seed: number, cols: number, rows: number): Float32Array {
  const pts = new Float32Array((cols + 2) * (rows + 2) * 2);
  for (let j = -1; j <= rows; j++) {
    for (let i = -1; i <= cols; i++) {
      const h = hash3(seed, i, j);
      const k = ((j + 1) * (cols + 2) + i + 1) * 2;
      pts[k] = i + (h & 0xffff) / 65536;
      pts[k + 1] = j + (h >>> 16) / 65536;
    }
  }
  return pts;
}

/** Билинейное чтение сетки (узел (i, j) — в точке (i, j)·step). */
function sampleGrid(g: Grid, x: number, y: number): number {
  const fx = Math.min(g.cols - 1, Math.max(0, x / g.step)), fy = Math.min(g.rows - 1, Math.max(0, y / g.step));
  const i0 = Math.floor(fx), j0 = Math.floor(fy), i1 = Math.min(g.cols - 1, i0 + 1), j1 = Math.min(g.rows - 1, j0 + 1);
  const u = fx - i0, v = fy - j0;
  return (g.data[j0 * g.cols + i0] * (1 - u) + g.data[j0 * g.cols + i1] * u) * (1 - v) + (g.data[j1 * g.cols + i0] * (1 - u) + g.data[j1 * g.cols + i1] * u) * v;
}

export class TerrainLayer {
  private world!: World;
  private worldKey = {};
  private mottle!: Grid;
  private grain!: Grid;
  private cracks!: Grid;
  private blocked!: Grid<Uint8Array>;
  private deposits = new Float32Array(0);
  private depositsVersion = 0;
  private depositsOf = -1;
  /** Когда и по каким версиям мира пересобраны блёстки. */
  private refreshedAt = -Infinity;
  private refreshedKey = '';
  /** Подложка мини-карты: готовая, строящаяся и по какому состоянию мира. */
  private minimap: HTMLCanvasElement | null = null;
  private minimapWork: { key: string; task: Calculation<HTMLCanvasElement> } | null = null;
  private minimapKey = '';
  private minimapAt = -Infinity;

  setWorld(world: World): void {
    this.world = world;
    this.worldKey = {};
    const { width, height } = world.dish;
    const seed = world.params.seed;
    // Фактура камня в единицах мира — узор только для глаза, на модель не влияет.
    const fbm = periodicFbm(seed ^ 0x51a7e, Math.ceil(width / 40), Math.ceil(height / 40), 4);
    this.mottle = { ...gridValues(width, height, MOTTLE_STEP, (x, y) => fbm(x / 40, y / 40)), step: MOTTLE_STEP, version: 0 };
    this.grain = { ...gridValues(width, height, GRAIN_STEP, (x, y) => hash3(seed ^ 0x6a41, Math.round(x * 0.8), Math.round(y * 0.8)) / 2147483648 - 1), step: GRAIN_STEP, version: 0 };
    const cc = Math.ceil(width / STONE_SLAB), cr = Math.ceil(height / STONE_SLAB);
    this.cracks = { data: crackPoints(seed ^ 0xc4ac, cc, cr), cols: cc + 2, rows: cr + 2, step: STONE_SLAB, version: 0 };
    const lay = world.partitions;
    this.blocked = { data: lay.blocked, cols: lay.cols, rows: lay.rows, step: lay.cell, version: 0 };
    this.depositsOf = -1;
    this.refreshedAt = -Infinity;
    this.refreshedKey = '';
    this.minimap = null;
    this.minimapWork = null;
    this.minimapKey = '';
    this.minimapAt = -Infinity;
  }

  /** Данные для шейдера; залежи пересчитываются, когда изменилось поле минерала. */
  data(): TerrainData {
    const w = this.world;
    const m = w.mineral;
    if (this.depositsOf !== m.version) {
      this.depositsOf = m.version;
      this.depositsVersion++;
      const per = m.cell * m.cell * w.params.mineralStock;
      if (this.deposits.length !== w.terrain.deposits.length) this.deposits = new Float32Array(w.terrain.deposits.length);
      for (let k = 0; k < this.deposits.length; k++) this.deposits[k] = w.terrain.deposits[k] / per;
    }
    const v = w.viscosity;
    return {
      world: this.worldKey, seed: w.params.seed,
      mottle: this.mottle, grain: this.grain, cracks: this.cracks, blocked: this.blocked,
      level: { data: v.smooth, cols: v.cols, rows: v.rows, step: v.cell, version: v.version },
      deposits: { data: this.deposits, cols: m.cols, rows: m.rows, step: m.cell, version: this.depositsVersion },
    };
  }

  /**
   * Пора ли пересобрать блёстки: местность или залежи изменились, но не чаще
   * REFRESH_MS. Возвращает уровень и залежи (в средних плотностях) на сетке минерала.
   */
  refresh(): { level: Float32Array; deposits: Float32Array } | null {
    const w = this.world;
    const key = `${w.viscosity.version}:${w.mineral.version}`;
    const now = performance.now();
    if (key === this.refreshedKey || now - this.refreshedAt < REFRESH_MS) return null;
    this.refreshedKey = key;
    this.refreshedAt = now;
    this.data();
    return { level: w.terrain.applied, deposits: this.deposits };
  }

  get minimapPending(): boolean {
    return this.minimapWork !== null;
  }

  /**
   * Подложка мини-карты: местность целиком без света. Пересобирается по
   * частям (не дольше MINIMAP_BUDGET_MS за вызов), когда изменились
   * местность или залежи, но не чаще REFRESH_MS; пока строится новая — старая.
   */
  minimapBase(): HTMLCanvasElement | null {
    const w = this.world;
    const key = `${w.viscosity.version}:${w.mineral.version}`;
    const now = performance.now();
    if (!this.minimapWork && key !== this.minimapKey && (this.minimap === null || now - this.minimapAt >= REFRESH_MS)) {
      this.data();
      this.minimapWork = { key, task: this.renderMinimap() };
    }
    if (this.minimapWork) {
      const deadline = now + MINIMAP_BUDGET_MS;
      let result = this.minimapWork.task.next();
      while (!result.done && performance.now() < deadline) result = this.minimapWork.task.next();
      if (result.done) {
        this.minimap = result.value;
        this.minimapKey = this.minimapWork.key;
        this.minimapAt = performance.now();
        this.minimapWork = null;
      }
    }
    return this.minimap;
  }

  /** Тот же цвет местности, что в шейдере, без мелких деталей (зерна, трещин, кристаллов) и берега. */
  private *renderMinimap(): Calculation<HTMLCanvasElement> {
    const w = this.world;
    const { width, height } = w.dish;
    const pw = Math.ceil(width * MINIMAP_SCALE), ph = Math.ceil(height * MINIMAP_SCALE);
    const c = document.createElement('canvas');
    c.width = pw; c.height = ph;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(pw, ph);
    const m = w.mineral;
    const deposits: Grid = { data: Float32Array.from(this.deposits), cols: m.cols, rows: m.rows, step: m.cell, version: 0 };
    for (let j = 0; j < ph; j++) {
      if ((j & 7) === 0) yield;
      for (let i = 0; i < pw; i++) {
        const x = (i + 0.5) / MINIMAP_SCALE, y = (j + 0.5) / MINIMAP_SCALE;
        if (!insideDish(w.dish, x, y)) continue;
        const L = smoothLevelAt(w.viscosity, x, y);
        const v = STONE_BASE + STONE_MOTTLE * sampleGrid(this.mottle, x, y);
        const shallow = smoothstep(0.2, 1.3, L), dry = smoothstep(1.35, 1.75, L);
        const stone = v + STONE_UNDERWATER_LIFT * (1 - dry);
        let r = stone + 6, g = stone + 3, b = stone;
        // Залежи — в центрах клеток минерала.
        const lode = Math.min(1, smoothstep(DEPOSIT_FROM, DEPOSIT_FULL, sampleGrid(deposits, x - m.cell / 2, y - m.cell / 2)));
        if (lode > 0) {
          const cover = lode * DEPOSIT_MAX;
          r += (DEPOSIT_COLOR[0] - r) * cover; g += (DEPOSIT_COLOR[1] - g) * cover; b += (DEPOSIT_COLOR[2] - b) * cover;
        }
        const water = mix(DEEP_WATER, SHALLOW_WATER, shallow);
        const cover = (1 - SHALLOWS_CLARITY * shallow) * (1 - dry) * (1 - 0.24 * lode);
        r += (water[0] - r) * cover; g += (water[1] - g) * cover; b += (water[2] - b) * cover;
        const k = (j * pw + i) * 4;
        img.data[k] = r; img.data[k + 1] = g; img.data[k + 2] = b; img.data[k + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }
}

const vec3 = (c: readonly number[]) => `vec3(${c.map((x) => x.toFixed(1)).join(', ')})`;

/**
 * Цвет местности в шейдере (GLSL): те же правила, что были на CPU. `w` —
 * точка мира; `u_detail` — проявленность мелких деталей (зерно, трещины, кристаллы).
 */
export const TERRAIN_GLSL = `
uniform sampler2D u_level;      uniform vec3 u_levelGrid;    // столбцы, строки, клетка
uniform sampler2D u_deposit;    uniform vec3 u_depositGrid;
uniform sampler2D u_fresh;      uniform vec3 u_freshGrid;    // свежесть грунта 0…1 (render/ground.ts)
uniform sampler2D u_mottle;     uniform vec3 u_mottleGrid;
uniform sampler2D u_grain;      uniform vec3 u_grainGrid;
uniform highp sampler2D u_cracks;
uniform sampler2D u_blocked;    uniform vec3 u_blockedGrid;
uniform uint u_seed;
uniform float u_detail;
uniform vec3 u_glassTint;       // оттенок стекла чашки

/** Значение в центрах клеток, билинейно (за краем — как у крайней клетки). */
float centered(sampler2D t, vec3 g, vec2 w) { return texture(t, w / g.z / g.xy).r; }
/** Значение в узлах сетки, билинейно. */
float cornered(sampler2D t, vec3 g, vec2 w) { return texture(t, (w / g.z + .5) / g.xy).r; }

uint mix32(uint x) {
  x += 0x9e3779b9u;
  x = (x ^ (x >> 16u)) * 0x85ebca6bu;
  x = (x ^ (x >> 13u)) * 0xc2b2ae35u;
  return x ^ (x >> 16u);
}
uint hash3(uint seed, int a, int b, int c) {
  uint h = mix32(seed ^ (uint(a) * 0x27d4eb2du));
  h = mix32(h ^ (uint(b) * 0x165667b1u));
  return mix32(h ^ (uint(c) * 0x1b873593u));
}

/** Трещины: расстояние до ближайшей границы ячеек Вороного (F2 − F1), координаты — в размерах плиты. */
float crackEdge(vec2 p) {
  ivec2 c = ivec2(floor(p));
  float f1 = 1e9, f2 = 1e9;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec2 q = texelFetch(u_cracks, c + ivec2(dx + 1, dy + 1), 0).rg;
      float d = dot(q - p, q - p);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
    }
  }
  return sqrt(f2) - sqrt(f1);
}

float levelAt(vec2 w) { return centered(u_level, u_levelGrid, w); }

/** Где вода для ряби: в воде 1, к отмели гаснет, на суше и перегородках 0. */
float waterAt(vec2 w) {
  if (texelFetch(u_blocked, ivec2(floor(w / u_blockedGrid.z)), 0).r > 0.) return 0.;
  return 1. - smoothstep(1.1, 1.65, levelAt(w));
}

vec3 terrainAt(vec2 w) {
  float L = levelAt(w);
  float crack = u_detail > 0. ? 1. - smoothstep(.02, .07, crackEdge(w / ${STONE_SLAB.toFixed(1)})) : 0.;
  float fine = u_detail > 0. ? ${STONE_GRAIN.toFixed(1)} * cornered(u_grain, u_grainGrid, w) - ${STONE_CRACK.toFixed(1)} * crack : 0.;
  float v = ${STONE_BASE.toFixed(1)} + ${STONE_MOTTLE.toFixed(1)} * cornered(u_mottle, u_mottleGrid, w) + fine * u_detail;
  // Вода мелеет к отмели и сходит на нет к суше; камень под ней светлее.
  float shallow = smoothstep(.2, 1.3, L);
  float dry = smoothstep(1.35, 1.75, L);
  float stone = v + ${STONE_UNDERWATER_LIFT.toFixed(1)} * (1. - dry);
  vec3 c = vec3(stone + 6., stone + 3., stone);
  // Голое стеклянное дно: грунта и залежей нет — сквозь стекло виден стол (render/table.ts).
  float bare = 1. - smoothstep(.02, .12, L);
  if (bare > 0.) c = mix(c, tableAt(w) * u_glassTint * 255., bare);
  // Залежи: тёмно-фиолетовый налёт на дне, по нему редкие светлые кристаллы.
  float lode = min(1., smoothstep(${DEPOSIT_FROM.toFixed(2)}, ${DEPOSIT_FULL.toFixed(2)}, centered(u_deposit, u_depositGrid, w)));
  if (lode > 0.) {
    float speck = u_detail > 0. ? float(hash3(u_seed ^ 0x3a7du, int(floor(w.x * 1.5 + .5)), int(floor(w.y * 1.5 + .5)), 0)) / 4294967296. : .5;
    float crystal = speck < ${CRYSTAL_SHARE.toFixed(3)} * lode ? ${CRYSTAL_LIGHT.toFixed(1)} * u_detail : 0.;
    float cover = lode * ${DEPOSIT_MAX.toFixed(3)} * (.94 + .12 * (speck - .5) * u_detail);
    c += (${vec3(DEPOSIT_COLOR)} + crystal * vec3(.9, .6, 1.) - c) * cover;
  }
  vec3 water = mix(${vec3(DEEP_WATER)}, ${vec3(SHALLOW_WATER)}, shallow);
  // Плотные залежи слегка просвечивают и в глубокой воде.
  float cover = (1. - ${SHALLOWS_CLARITY.toFixed(3)} * shallow) * (1. - dry) * (1. - .24 * lode) * (1. - .5 * bare);
  c += (water - c) * cover;
  // Свежий грунт светлее и чище; темнеет до старого со временем. Виден сквозь
  // воду — тем лучше, чем мельче (намывается он на отмели и у берегов).
  float fresh = centered(u_fresh, u_freshGrid, w);
  if (fresh > 0.) c += (${vec3(FRESH_GROUND)} - c) * ${FRESH_MAX.toFixed(2)} * smoothstep(.1, 1., fresh) * (.35 + .65 * shallow) * (1. - lode);
  // Светлое мелководье снаружи, мокрый камень внутри — тон берега.
  float shoreLight = smoothstep(1.08, 1.3, L) * (1. - smoothstep(1.3, 1.5, L)) * .22 * (1. - lode);
  float wet = smoothstep(1.35, 1.53, L) * (1. - smoothstep(1.58, 1.83, L)) * .42 * (1. - .65 * lode);
  c += (${vec3(SHORE_LIGHT)} - c) * shoreLight;
  c += (${vec3(WET_SHORE)} - c) * wet;
  return clamp(c / 255., 0., 1.);
}`;
