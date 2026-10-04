/**
 * Минерал в среде: мутность (затемнение дна и задержка света), дымка по
 * плотности и зёрна там, где минерал движется.
 */
import { DRIFT_REFERENCE, MINERAL_LAYER, MINERAL_MOBILITY, MINERAL_PERIOD, flowAt, isBlocked, multiplierForLevel, sunAt, transparencyForDensity, type World } from '../../core/index.ts';
import type { Frame } from './frame.ts';
import type { LightMurk } from './light.ts';
import { MINERAL_COLOR, rgb, smoothstep, traceDish, type Rgb } from './palette.ts';

/**
 * Дымка: фон около средней плотности не виден, тонкий слой — едва заметный
 * налёт, густой — плотнее, но полупрозрачный и светлее залежей. С какой
 * плотности (от средней) виден, при какой — полный; наибольшая
 * непрозрачность; цвет густого.
 */
const MINERAL_DEEP: Rgb = [185, 131, 237];
const MINERAL_FROM = 0.15;
const MINERAL_FULL = 6;
const MINERAL_ALPHA = 0.46;
/** Как быстро растёт непрозрачность с плотностью (1 — ровно по логарифму; больше — тонкое прозрачнее). */
const MINERAL_GAMMA = 1;
/**
 * Зёрна минерала — только для показа: точки там, где минерал движется (гуще,
 * где больше количество × скорость — видно и тонкие реки), движутся так же,
 * как минерал в модели: по течению на прошедшие шаги, но густое и в вязком —
 * медленнее (течение уносит только слой). Сколько зёрен, жизнь (с), размер
 * (CSS px), с какого потока (плотность от средней × скорость от мерила)
 * рождаются и при каком — наверняка, наибольший сдвиг за кадр (CSS px), цвет и яркость.
 */
const GRAIN_COUNT = 1500;
const GRAIN_LIFE: readonly [number, number] = [2, 5];
const GRAIN_CSS = 1.1;
const GRAIN_FROM = 0.01;
const GRAIN_FULL = 0.3;
const GRAIN_MAX_HOP_CSS = 10;
const GRAIN_COLOR: Rgb = [236, 214, 255];
const GRAIN_ALPHA = 0.6;
/**
 * Мутность. Свет: минерал гасит пятна света ровно настолько, насколько модель
 * задерживает свет (доля 1 − прозрачность; MURK_LIGHT = 1 — как есть). Дно:
 * лёгкое затемнение там, где прозрачность ниже средней (насколько мягче модели).
 */
const MURK_LIGHT = 1;
const MURK_STRENGTH = 0.35;
/** Дымку минерала пересобирать не чаще, мс. */
const HAZE_REDRAW_MS = 250;
/** Во время извержения — чаще: видно, как выброс растекается. */
const HAZE_REDRAW_ERUPTING_MS = 60;
/** Попав в отверстие воронки, зерно зависает и тает за столько секунд. */
export const SINK_S = 1.5;

export class MineralLayer {
  /** Дымка минерала (клетка поля — пиксель) и версия поля, по которой она построена. */
  private readonly mineralCanvas = document.createElement('canvas');
  /** Затемнение от мутности (серый для умножения), той же сетки. */
  private readonly murkCanvas = document.createElement('canvas');
  /** Сколько света задерживает минерал (альфа = 1 − прозрачность), той же сетки — гасит маску пятен. */
  private readonly lightMurkCanvas = document.createElement('canvas');
  private mineralVersion = -1;
  private hazeDrawnAt = 0;
  private hazeScratch: { smooth: Float32Array; tmp: Float32Array; image: ImageData; dark: ImageData; held: ImageData } | null = null;
  /** Зёрна минерала: x, y, возраст, жизнь (по 4 числа); время анимации и шаг мира прошлого кадра. */
  private readonly grains = new Float32Array(GRAIN_COUNT * 4);
  private grainTime = -1;
  private grainStep = 0;

  /** Задержка света минералом — для слоя света. */
  get lightMurk(): LightMurk {
    return { canvas: this.lightMurkCanvas, drawnAt: this.hazeDrawnAt };
  }

  setWorld(world: World): void {
    this.mineralVersion = -1;
    this.hazeDrawnAt = -Infinity;
    this.grains.fill(0);
    this.grainTime = -1;
    this.grainStep = world.step;
  }

  /** Дымка минерала (сначала пересобрать, если поле изменилось) и зёрна. */
  draw(frame: Frame): void {
    const { ctx, world } = frame;
    const m = world.mineral;
    const stock = world.params.mineralStock;
    const nowMs = performance.now();
    const hazeEvery = m.volcanoes.some((v) => v.stage === 'erupting') ? HAZE_REDRAW_ERUPTING_MS : HAZE_REDRAW_MS;
    if ((m.version !== this.mineralVersion && nowMs - this.hazeDrawnAt >= hazeEvery) || this.mineralCanvas.width !== m.cols) {
      this.hazeDrawnAt = nowMs;
      this.mineralVersion = m.version;
      const c = this.mineralCanvas;
      if (c.width !== m.cols || c.height !== m.rows) { c.width = m.cols; c.height = m.rows; }
      const mctx = c.getContext('2d')!;
      if (!this.hazeScratch || this.hazeScratch.image.width !== m.cols || this.hazeScratch.image.height !== m.rows) {
        this.hazeScratch = { smooth: new Float32Array(m.field.length), tmp: new Float32Array(m.field.length),
          image: mctx.createImageData(m.cols, m.rows), dark: mctx.createImageData(m.cols, m.rows), held: mctx.createImageData(m.cols, m.rows) };
      }
      const { image: img, smooth, tmp, dark, held } = this.hazeScratch;
      const area = m.cell * m.cell;
      // Размытие (два прохода [1 2 1] по каждой оси) — скопления выглядят
      // округлыми, а не квадратами клеток, но край различим. Только для показа.
      smooth.set(m.field);
      for (let pass = 0; pass < 2; pass++) {
        for (let j = 0; j < m.rows; j++) {
          for (let i = 0; i < m.cols; i++) {
            const k = j * m.cols + i;
            const l = i > 0 ? smooth[k - 1] : smooth[k], r = i < m.cols - 1 ? smooth[k + 1] : smooth[k];
            tmp[k] = (l + 2 * smooth[k] + r) / 4;
          }
        }
        for (let j = 0; j < m.rows; j++) {
          for (let i = 0; i < m.cols; i++) {
            const k = j * m.cols + i;
            const u = j > 0 ? tmp[k - m.cols] : tmp[k], d = j < m.rows - 1 ? tmp[k + m.cols] : tmp[k];
            smooth[k] = (u + 2 * tmp[k] + d) / 4;
          }
        }
      }
      const murk = this.murkCanvas;
      if (murk.width !== m.cols || murk.height !== m.rows) { murk.width = m.cols; murk.height = m.rows; }
      const kctx = murk.getContext('2d')!;
      const meanT = transparencyForDensity(stock);
      for (let k = 0; k < m.field.length; k++) {
        // Мутность: темнее там, где прозрачность ниже, чем при средней плотности.
        const shade = Math.min(1, transparencyForDensity(smooth[k] / area) / meanT);
        const g = 255 * (1 - (1 - shade) * MURK_STRENGTH);
        dark.data[k * 4] = dark.data[k * 4 + 1] = dark.data[k * 4 + 2] = g;
        dark.data[k * 4 + 3] = 255;
      }
      kctx.putImageData(dark, 0, 0);
      const lm = this.lightMurkCanvas;
      if (lm.width !== m.cols || lm.height !== m.rows) { lm.width = m.cols; lm.height = m.rows; }
      const lctx = lm.getContext('2d')!;
      for (let k = 0; k < m.field.length; k++) {
        held.data[k * 4 + 3] = 255 * Math.min(1, (1 - transparencyForDensity(smooth[k] / area)) * MURK_LIGHT);
      }
      lctx.putImageData(held, 0, 0);
      for (let k = 0; k < m.field.length; k++) {
        // Градации: по логарифму плотности — видно и тонкий налёт, и густое ядро.
        const d = smooth[k] / area / stock;
        const t = d <= MINERAL_FROM ? 0 : Math.min(1, Math.log(d / MINERAL_FROM) / Math.log(MINERAL_FULL / MINERAL_FROM));
        const a = t ** MINERAL_GAMMA * MINERAL_ALPHA;
        const blend = smoothstep(0.4, 1, t);
        img.data[k * 4] = MINERAL_COLOR[0] + (MINERAL_DEEP[0] - MINERAL_COLOR[0]) * blend;
        img.data[k * 4 + 1] = MINERAL_COLOR[1] + (MINERAL_DEEP[1] - MINERAL_COLOR[1]) * blend;
        img.data[k * 4 + 2] = MINERAL_COLOR[2] + (MINERAL_DEEP[2] - MINERAL_COLOR[2]) * blend;
        img.data[k * 4 + 3] = a * 255;
      }
      mctx.putImageData(img, 0, 0);
    }
    ctx.save();
    ctx.beginPath();
    traceDish(ctx, world.dish);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(this.murkCanvas, 0, 0, m.cols * m.cell, m.rows * m.cell);
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(this.mineralCanvas, 0, 0, m.cols * m.cell, m.rows * m.cell);
    this.drawGrains(frame);
    ctx.restore();
  }

  /** Зёрна минерала: рождаются по массе, движутся как минерал в модели, гаснут. */
  private drawGrains(frame: Frame): void {
    const { ctx, camera, world: w, animTime, detail } = frame;
    const m = w.mineral;
    const dt = this.grainTime < 0 ? 0 : Math.min(0.1, Math.max(0, animTime - this.grainTime));
    this.grainTime = animTime;
    const steps = Math.max(0, w.step - this.grainStep);
    this.grainStep = w.step;
    const perMean = m.cell * m.cell * w.params.mineralStock;
    const density = (x: number, y: number) => {
      const i = Math.min(m.cols - 1, Math.max(0, Math.floor(x / m.cell)));
      const j = Math.min(m.rows - 1, Math.max(0, Math.floor(y / m.cell)));
      return m.field[j * m.cols + i];
    };
    const g = this.grains;
    const v: [number, number] = [0, 0];
    const maxHop = camera.px(GRAIN_MAX_HOP_CSS);
    const layer = MINERAL_LAYER * MINERAL_MOBILITY * MINERAL_PERIOD * m.cell * m.cell;
    const size = camera.px(GRAIN_CSS);
    const ref = DRIFT_REFERENCE * Math.max(1e-9, sunAt(w.light, w.step));
    /** Доля минерала клетки, которую течение уносит за обновление (тоньше слой в вязком). */
    const moving = (x: number, y: number, speed: number) => {
      const i = Math.min(m.cols - 1, Math.max(0, Math.floor(x / m.cell)));
      const j = Math.min(m.rows - 1, Math.max(0, Math.floor(y / m.cell)));
      const amount = m.field[j * m.cols + i];
      const mob = multiplierForLevel(w.terrain.applied[j * m.cols + i]);
      return amount > 0 ? Math.min(1, (layer * speed) / (mob * mob) / amount) : 1;
    };
    /** Поток минерала в точке: плотность (от средней) × скорость его движения (от мерила). */
    const flux = (x: number, y: number) => {
      flowAt(w, x, y, v);
      const sp = Math.hypot(v[0], v[1]);
      return (density(x, y) / perMean) * (sp * moving(x, y, sp)) / ref;
    };
    const holes = new Uint8Array(m.field.length);
    for (const f of m.funnels) for (const k of f.cells) holes[k] = 1;
    ctx.fillStyle = rgb(GRAIN_COLOR);
    for (let n = 0; n < GRAIN_COUNT; n++) {
      const o = n * 4;
      g[o + 2] += dt;
      if (g[o + 3] === 0 || g[o + 2] >= g[o + 3]) {
        // Новое зерно — в случайной клетке, тем вероятнее, чем больше там
        // минерала движется (количество × скорость): видно и тонкие реки.
        // Не прижилось — попробует в следующем кадре.
        const x = Math.random() * w.dish.width, y = Math.random() * w.dish.height;
        g[o + 3] = 1;
        g[o + 2] = 1;
        const f = flux(x, y);
        if (f <= GRAIN_FROM || Math.random() >= (f - GRAIN_FROM) / (GRAIN_FULL - GRAIN_FROM)) continue;
        g[o] = x;
        g[o + 1] = y;
        g[o + 2] = 0;
        g[o + 3] = GRAIN_LIFE[0] + (GRAIN_LIFE[1] - GRAIN_LIFE[0]) * Math.random();
      }
      // Сдвиг, как у минерала: по течению на прошедшие шаги; из густой клетки
      // за обновление уходит лишь слой (тоньше в вязком) — во столько же раз медленнее.
      if (steps > 0) {
        flowAt(w, g[o], g[o + 1], v);
        const share = moving(g[o], g[o + 1], Math.hypot(v[0], v[1]));
        let dx = v[0] * steps * share, dy = v[1] * steps * share;
        const hop = Math.hypot(dx, dy);
        if (hop > maxHop) { dx *= maxHop / hop; dy *= maxHop / hop; }
        if (isBlocked(w.partitions, g[o] + dx, g[o + 1] + dy)) { g[o + 2] = g[o + 3]; continue; }
        // В отверстии воронки зерно не уносится: зависает и тает (уходит вниз).
        const hi = Math.min(m.cols - 1, Math.max(0, Math.floor(g[o] / m.cell)));
        const hj = Math.min(m.rows - 1, Math.max(0, Math.floor(g[o + 1] / m.cell)));
        if (!holes[hj * m.cols + hi]) {
          g[o] += dx;
          g[o + 1] += dy;
        }
      }
      const ci = Math.min(m.cols - 1, Math.max(0, Math.floor(g[o] / m.cell)));
      const cj = Math.min(m.rows - 1, Math.max(0, Math.floor(g[o + 1] / m.cell)));
      let sz = size;
      if (holes[cj * m.cols + ci]) {
        g[o + 3] = Math.min(g[o + 3], g[o + 2] + SINK_S);
        sz = size * Math.max(0.1, (g[o + 3] - g[o + 2]) / SINK_S);
      }
      const f = g[o + 2] / g[o + 3];
      ctx.globalAlpha = Math.min(1, f * 6, (1 - f) * 3) * GRAIN_ALPHA * (0.25 + 0.75 * detail);
      ctx.fillRect(g[o] - sz / 2, g[o + 1] - sz / 2, sz, sz);
    }
    ctx.globalAlpha = 1;
  }
}
