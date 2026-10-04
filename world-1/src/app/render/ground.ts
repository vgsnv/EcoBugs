/**
 * Показ грунта и тектоники (спецификация, «Показ местности и минерала»):
 * - свежий грунт — там, где течения и осыпание его положили, — светлее и
 *   чище старого и темнеет до его цвета за FRESH_STEPS шагов модели;
 * - сила переноса — где течения поднимают грунт (для песочной взвеси);
 * - идущие подвижки — участок слегка подкрашен (подъём тёплым, опускание
 *   холодным) и обведён тонкой медленно пульсирующей кромкой; толчок —
 *   короткая кольцевая волна по краю участка, не короче QUAKE_SHOW секунд
 *   реального времени (на ускорении толчок проходит быстрее кадра).
 * Изменения грунта приходят из физики накопленными между снимками
 * (takeGroundChanges), поэтому на ускорении картина сама усредняется.
 */
import { GROUND_PER_LEVEL, MINERAL_PERIOD, SAND_RATE, movement, type GroundChanges, type Movement, type World } from '../../core/index.ts';
import type { Grid } from './terrain.ts';

/** За сколько шагов модели свежий грунт темнеет до старого (до e⁻¹). */
const FRESH_STEPS = 400_000;
/** Сколько уровня нового грунта делает клетку полностью свежей. */
const FRESH_FULL = 0.12;
/** Окно усреднения силы переноса, шагов модели; её мерило — доля наибольшего переноса. */
const LIFT_STEPS = 20_000;
/** Окно усреднения изменений грунта для «Процессов», шагов модели: туда-обратно перекатывающийся грунт гасится. */
const RATE_STEPS = 20_000;
const LIFT_REFERENCE = 1;
/** Сколько секунд реального времени видна волна толчка; сколько волн и подвижек показывать сразу. */
const QUAKE_SHOW = 2.2;
export const MAX_MOVES = 12;
export const MAX_RINGS = 6;

/** Подвижки и волны толчков для шейдера полей. */
export interface Tectonics {
  /** Подвижки: по 8 чисел — x, y, размер, полуширина; угол, полоса (0/1), направление (±1), сила 0…1. */
  readonly moves: Float32Array;
  readonly moveCount: number;
  /** Волны: по 4 числа — x, y, радиус участка, ход волны 0…1 (направление — знаком радиуса). */
  readonly rings: Float32Array;
  readonly ringCount: number;
}

export class GroundLayer {
  private world: World | null = null;
  private fresh = new Float32Array(0);
  private lift = new Float32Array(0);
  private version = 0;
  /** Для «Процессов»: изменение грунта от течений и от тектоники, уровня за шаг, скользящее среднее за RATE_STEPS шагов. */
  readonly rates = { sand: new Float32Array(0), tectonic: new Float32Array(0), version: 0 };
  /** Последний учтённый толчок и идущие волны: подвижка и время начала показа. */
  private seenQuake = 0;
  private rings: { m: Movement; at: number }[] = [];
  private readonly moveData = new Float32Array(MAX_MOVES * 8);
  private readonly ringData = new Float32Array(MAX_RINGS * 4);

  setWorld(world: World): void {
    this.world = world;
    const n = world.mineral.field.length;
    this.fresh = new Float32Array(n);
    this.lift = new Float32Array(n);
    this.rates.sand = new Float32Array(n);
    this.rates.tectonic = new Float32Array(n);
    this.rates.version++;
    this.version++;
    this.seenQuake = world.terrain.nextQuake;
    this.rings = [];
  }

  /** Учесть изменения грунта из очередного снимка. */
  accept(changes: GroundChanges): void {
    const w = this.world;
    if (!w || changes.steps <= 0 || changes.net.length !== this.fresh.length) return;
    const m = w.mineral;
    const per = GROUND_PER_LEVEL * m.cell * m.cell;
    const fade = Math.exp(-changes.steps / FRESH_STEPS);
    const keep = Math.exp(-changes.steps / LIFT_STEPS);
    const average = Math.exp(-changes.steps / RATE_STEPS);
    // Мерило переноса (уровень за шаг) — около 95-го процентиля в чашке.
    const ref = LIFT_REFERENCE * SAND_RATE * Math.max(1e-6, w.params.terrainSpeed) / MINERAL_PERIOD;
    const { fresh, lift } = this;
    for (let k = 0; k < fresh.length; k++) {
      if (m.blocked[k]) continue;
      const gain = changes.net[k] / per;
      // Размыв убавляет свежесть: туда-обратно перекатывающийся грунт свежим не считается.
      fresh[k] = Math.min(1, Math.max(0, fresh[k] * fade + gain / FRESH_FULL));
      const rate = Math.min(1, changes.lift[k] / per / changes.steps / ref);
      lift[k] = lift[k] * keep + rate * (1 - keep);
      this.rates.sand[k] = this.rates.sand[k] * average + gain / changes.steps * (1 - average);
      this.rates.tectonic[k] = this.rates.tectonic[k] * average + changes.tectonic[k] / per / changes.steps * (1 - average);
    }
    this.version++;
    this.rates.version++;
  }

  /** Свежесть грунта 0…1 по центрам клеток минерала. */
  freshGrid(): Grid {
    const m = this.world!.mineral;
    return { data: this.fresh, cols: m.cols, rows: m.rows, step: m.cell, version: this.version };
  }

  /** Сила переноса грунта 0…1 в точке (по клетке минерала). */
  liftAt(x: number, y: number): number {
    const m = this.world!.mineral;
    const i = Math.floor(x / m.cell), j = Math.floor(y / m.cell);
    if (i < 0 || j < 0 || i >= m.cols || j >= m.rows) return 0;
    return this.lift[j * m.cols + i];
  }

  /** Идущие подвижки (не толчки) — для подписей в «Процессах». */
  movements(): readonly Movement[] {
    return this.world ? this.world.terrain.active.filter((m) => !m.quake) : [];
  }

  /** Идущие подвижки и волны толчков к кадру (`animTime` — секунды реального времени показа). */
  tectonics(animTime: number): Tectonics {
    const w = this.world!;
    const t = w.terrain;
    // Толчки, начавшиеся с прошлого кадра, — даже если уже закончились.
    for (; this.seenQuake < t.nextQuake; this.seenQuake++) {
      this.rings.push({ m: movement(w.params, true, this.seenQuake, 0), at: animTime });
    }
    this.rings = this.rings.filter((r) => animTime - r.at < QUAKE_SHOW).slice(-MAX_RINGS);
    let rings = 0;
    for (const r of this.rings) {
      const o = rings++ * 4;
      this.ringData[o] = r.m.x; this.ringData[o + 1] = r.m.y;
      this.ringData[o + 2] = r.m.size * Math.sign(r.m.amp);
      this.ringData[o + 3] = Math.max(0, animTime - r.at) / QUAKE_SHOW;
    }
    let moves = 0;
    for (const m of t.active) {
      if (m.quake || moves >= MAX_MOVES) continue;
      const u = Math.min(1, Math.max(0, (w.step - m.start) / m.duration));
      const o = moves++ * 8;
      const d = this.moveData;
      d[o] = m.x; d[o + 1] = m.y; d[o + 2] = m.size; d[o + 3] = m.width;
      d[o + 4] = m.angle; d[o + 5] = m.band ? 1 : 0; d[o + 6] = Math.sign(m.amp);
      // Сильнее всего в разгаре подвижки (там она быстрее всего), заметна и в начале и в конце.
      d[o + 7] = 0.35 + 0.65 * Math.sin(Math.PI * u);
    }
    return { moves: this.moveData, moveCount: moves, rings: this.ringData, ringCount: rings };
  }
}

/** Подкраска подвижек, их кромка и волны толчков в шейдере полей (GLSL). */
export const TECTONICS_GLSL = `
uniform vec4 u_moveA[${MAX_MOVES}];  // x, y, размер, полуширина
uniform vec4 u_moveB[${MAX_MOVES}];  // угол, полоса, направление, сила
uniform int u_moveCount;
uniform vec4 u_ring[${MAX_RINGS}];   // x, y, ±радиус, ход волны
uniform int u_ringCount;

/** Расстояние до середины подвижки в долях её края (1 — край), как movementWeight в ядре. */
float moveDistance(vec4 a, vec4 b, vec2 w) {
  vec2 d = w - a.xy;
  if (b.y > .5) {
    float c = cos(b.x), s = sin(b.x);
    float along = d.x * c + d.y * s, across = -d.x * s + d.y * c;
    return length(vec2(max(0., abs(along) - a.z * .6) / (a.z * .4), abs(across) / a.w));
  }
  return length(d) / a.z;
}

vec3 tectonics(vec3 c, vec2 w, float time) {
  for (int n = 0; n < ${MAX_MOVES}; n++) {
    if (n >= u_moveCount) break;
    vec4 a = u_moveA[n], b = u_moveB[n];
    float d = moveDistance(a, b, w);
    vec3 tint = b.z > 0. ? vec3(1., .72, .42) : vec3(.45, .62, 1.);
    if (d < 1.) {
      float t = 1. - d;
      c = mix(c, c * .6 + tint * .45, .3 * b.w * t * t * (3. - 2. * t));
    }
    // Кромка шириной в пиксель; пульсирует медленно, у каждой подвижки — своя фаза.
    float px = fwidth(d);
    float edge = 1. - smoothstep(.5, 1.5, abs(d - 1.) / max(px, 1e-6));
    if (edge > 0.) c = mix(c, tint, edge * (.25 + .2 * sin(time * 1.4 + float(n) * 2.1)) * (.5 + .5 * b.w));
  }
  for (int n = 0; n < ${MAX_RINGS}; n++) {
    if (n >= u_ringCount) break;
    vec4 r = u_ring[n];
    float radius = abs(r.z) * (.55 + .5 * r.w);
    float dist = abs(length(w - r.xy) - radius) * u_cam.x;
    float ring = (1. - smoothstep(1., 3.5, dist)) * (1. - r.w) * (1. - r.w);
    vec3 tint = r.z > 0. ? vec3(1., .85, .6) : vec3(.7, .82, 1.);
    c = mix(c, tint, ring * .7);
  }
  return c;
}`;
