/**
 * Вулканы и воронки — отверстия в недра: жерла по стадиям, вспышки залпов и
 * свечение по темпу выброса, приток вещества из жерла; отверстия воронок,
 * свечение недр, крупинки, стекающие в отверстие, и искры ушедших вниз.
 * Свечения, искры и отверстия воронок — на нижнем холсте (GlowSink), остальное — на верхнем.
 */
import { BURST_WIDTH, DRIFT_REFERENCE, ERUPTION_RADIUS, VOLCANO_BIRTH, VOLCANO_POWER, eruptionBursts, eruptionRate, flowAt, hash3, insideDish, isBlocked, ventPush, type Volcano, type World } from '../../core/index.ts';
import type { GlowSink } from './field.ts';
import type { Frame } from './frame.ts';
import { SINK_S } from './mineral.ts';
import { MINERAL_COLOR, mix, rgb, smoothstep, type Rgb } from './palette.ts';

/**
 * Извержение — показывается только то, что есть в модели: вспышка света у
 * жерла на каждый залп, свечение жерла по темпу выброса; само вещество и
 * толчок — дымка минерала, зёрна и линии течений (во время извержения дымка
 * обновляется чаще).
 */
const ERUPTION_LIGHT: Rgb = [244, 232, 255];
const ERUPTION_FLASH_S = 0.6;
/** Свечение жерла: радиус (доля радиуса выброса), не меньше стольких CSS px. */
const VENT_GLOW = 0.25;
const VENT_GLOW_MIN_CSS = 14;
/**
 * Жерло: радиус в единицах мира у слабого и сильного вулкана; на экране не
 * меньше (CSS px); цвет пепла потухшего; период мерцания созревшего, с.
 * Цвет «выходит» — тот же, что у полосы минерала.
 */
const VENT_SIZE: readonly [number, number] = [9, 15];
const VENT_MIN_CSS: readonly [number, number] = [6, 9];
const VENT_ASH: Rgb = [110, 108, 122];
const VENT_PULSE_S = 0.9;
/** Отверстие вулкана: белизна сердцевины в силе. */
const VENT_SPARK: Rgb = [250, 242, 255];
/** Кромка жерла отделяет его от дымки; у спящего вулкана остаётся матовой. */
const VENT_RIM: Rgb = [185, 153, 209];
/** Пульс созревшего вулкана: насколько диск вырастает на пике. */
const VENT_BEAT = 0.3;
/** Радиус точки на экране, CSS px: у спящего и только зародившегося — и перед самым взрывом. */
const VENT_DOT_CSS: readonly [number, number] = [2.5, 7];
/**
 * Размер жерла по мощности вулкана (множитель у слабого и сильного); у
 * извергающегося — радиус диска (CSS px) у малого и у большого извержения
 * (объём — по радиусу выброса, от такой его доли); к концу извержения диск
 * сжимается до 0,55 вместе с темпом.
 */
const VENT_POWER_SCALE: readonly [number, number] = [0.7, 1.3];
/** Темп хвоста сразу после залпа (доля начального) — от него тускнеет цвет жерла. */
const VENT_TAIL_RATE = 0.13;
/** Набухание перед повторным залпом: за такую долю времени извержения до залпа, на сколько растёт диск. */
const VENT_SWELL_TIME = 0.06;
const VENT_SWELL = 0.8;
/** Приток из жерла: сколько крупинок, размер (CSS px), докуда видны (в радиусах диска). */
const SPRING_COUNT = 70;
const SPRING_DOT_CSS = 1.8;
const SPRING_REACH = 2.2;
/** Наибольшая длина следа крупинки — в радиусах диска жерла. */
const STREAK_MAX = 0.6;
/** Воронка: цвет отверстия и его непрозрачность (край мягкий — от сглаживания сетки). */
const FUNNEL_COLOR: Rgb = [58, 30, 92];
/** Центр отверстия — глубина: тёмно-синий. */
const FUNNEL_DEEP: Rgb = [8, 14, 46];
const FUNNEL_ALPHA = 0.48;
/** Отверстия рисуются во столько раз детальнее сетки поля. */
const FUNNEL_RES = 3;
/** С такой силы воронка видна полностью; слабее — проявляется. */
const FUNNEL_SHOWN = 0.25;
/** Кромка отверстия: цвет и непрозрачность. */
const FUNNEL_RIM_COLOR: Rgb = [190, 150, 240];
const FUNNEL_RIM_ALPHA = 0.45;
/** Холодные крупинки стока отличаются от бело-сиреневого притока жерла. */
const FUNNEL_PARTICLE: Rgb = [184, 235, 246];
/** Стекающие крупинки: сколько на воронку и сколько живут, с. */
const FUNNEL_GRAINS = 40;
// На ×1 частица успевает пройти к отверстию, а не исчезает на подступах.
const FUNNEL_GRAIN_LIFE = 30;
/** Свечение недр из отверстия: цвет, размер (в радиусах отверстия), не меньше CSS px, яркость при полной силе. */
const FUNNEL_GLOW: Rgb = [110, 80, 220];
const FUNNEL_GLOW_SIZE = 2.2;
const FUNNEL_GLOW_MIN_CSS = 10;
const FUNNEL_GLOW_ALPHA = 0.22;
/** Искра ушедшей крупинки: сколько живёт, с, и размер, CSS px. */
const SPARK_S = 0.35;
const SPARK_CSS = 2.5;
/** Размер стекающей крупинки вдали от отверстия, CSS px (к отверстию — до точки). */
const FUNNEL_GRAIN_CSS = 2.4;
const VENT_ERUPT_CSS: readonly [number, number] = [5, 11];
const VENT_VOLUME_FROM = 0.35;
/** Показанное жерло догоняет модель за столько секунд (до e⁻¹). */
const VENT_EASE_S = 0.35;
/** Отверстие жерла: тёмная глубина, неровность края (доля радиуса). */
const VENT_HOLE: Rgb = [46, 24, 78];
const VENT_RAGGED = 0.16;
/** Волна залпа: сколько бежит, с; докуда (доля радиуса выброса); цвет. */
const RING_S = 1.4;
const RING_REACH = 0.7;
const RING_COLOR: Rgb = [238, 224, 255];
/** Шрам после извержения: сколько тает (шагов мира), размер (доля радиуса выброса), цвет, непрозрачность. */
const SCAR_STEPS = 150_000;
const SCAR_SIZE = 0.45;
const SCAR_COLOR: Rgb = [92, 52, 140];
const SCAR_ALPHA = 0.3;

export class SourcesLayer {
  /** Крупинки притока из жерла по вулканам: угол, расстояние от центра, жива ли (−1 — нет); шаг мира прошлого кадра. */
  private springs = new Map<number, { p: Float32Array; step: number }>();
  /** Отверстия воронок: пиксели (в FUNNEL_RES раз детальнее клеток поля, цвет умножен на альфу) и версия для текстуры. */
  private funnelPixels = { data: new Uint8Array(0), width: 0, height: 0 };
  private funnelVersion = 0;
  /** Показанные воронки: место ядра, отверстие, ареол, проявленность 0…1, жива ли, крупинки (x, y, возраст; −1 — нет). */
  private funnelViews: { id: number; x: number; y: number; cells: Int32Array; reach: number; alpha: number; alive: boolean; grains: Float32Array }[] = [];
  private funnelTime = -1;
  /** Версия мира, по которой нарисованы отверстия воронок. */
  private funnelDrawn = -1;
  /** Искры крупинок, ушедших в недра: где и когда (время анимации). */
  private funnelSparks: { x: number; y: number; t: number }[] = [];
  private funnelStep = 0;
  /** Вспышки начала извержений: где, когда (время анимации), размах. */
  private shocks: { x: number; y: number; t: number; scale: number }[] = [];
  /** Сколько раз извергался каждый вулкан на прошлом кадре. */
  private seenBursts = new Map<string, number>();
  /** Показанные жерла: размер, свет из недр, белизна — догоняют модель плавно. */
  private vents = new Map<number, { size: number; light: number; hot: number }>();
  private ventTime = -1;
  private world!: World;

  setWorld(world: World): void {
    this.world = world;
    this.funnelDrawn = -1;
    this.shocks = [];
    this.seenBursts = new Map(world.mineral.volcanoes.filter((v) => v.stage === 'erupting')
      .map((v) => [`${v.id}:${v.k}`, eruptionBursts(world.params, v).filter((b) => b.at <= Math.max(0, (world.step - v.begin) / Math.max(1, v.until - v.begin))).length]));
    this.springs.clear();
    this.vents.clear();
    this.ventTime = -1;
    this.funnelViews = [];
    this.funnelSparks = [];
    this.funnelTime = -1;
    this.funnelStep = world.step;
  }

  /**
   * Извержения: вспышка каждого залпа (во времени анимации — залп, прошедший
   * между кадрами, тоже её даёт) и свечение жерла по темпу выброса.
   */
  drawEruptions(frame: Frame, glows: GlowSink): void {
    const { camera, world: w, animTime } = frame;
    const m = w.mineral;

    // Залпы, прошедшие с прошлого кадра, — вспышки (слабые залпы — меньше).
    const live = new Set<string>();
    for (const v of m.volcanoes) {
      if (v.stage !== 'erupting') continue;
      const key = `${v.id}:${v.k}`;
      live.add(key);
      const bursts = eruptionBursts(w.params, v);
      const phase = this.eruptionPhase(v);
      const passed = bursts.filter((b) => b.at <= phase).length;
      for (let q = this.seenBursts.get(key) ?? 0; q < passed; q++) {
        this.shocks.push({ x: v.x, y: v.y, t: animTime, scale: (v.radius / ERUPTION_RADIUS) * Math.sqrt(bursts[q].share / bursts[0].share) });
      }
      this.seenBursts.set(key, passed);
    }
    for (const key of this.seenBursts.keys()) if (!live.has(key)) this.seenBursts.delete(key);
    this.shocks = this.shocks.filter((s) => animTime - s.t < Math.max(ERUPTION_FLASH_S, RING_S));

    // Свечение жерла — по темпу выброса; между залпами слабее.
    for (const v of m.volcanoes) {
      if (v.stage !== 'erupting') continue;
      const flicker = 0.8 + 0.12 * Math.sin(animTime * 11 + v.id * 1.7) + 0.08 * Math.sin(animTime * 23.3 + v.id);
      const r = Math.max(camera.px(VENT_GLOW_MIN_CSS), v.radius * VENT_GLOW) * (0.85 + 0.15 * flicker);
      glows.glow(ERUPTION_LIGHT, v.x, v.y, r, Math.min(1, (0.15 + 0.85 * this.ventStrength(v)) * flicker), true);
    }

    // Вспышки залпов.
    for (const s of this.shocks) {
      const f = (animTime - s.t) / ERUPTION_FLASH_S;
      if (f >= 1) continue;
      const r = Math.max(camera.px(VENT_GLOW_MIN_CSS * 2), ERUPTION_RADIUS * 0.4 * s.scale) * (0.6 + 0.6 * f);
      glows.glow(ERUPTION_LIGHT, s.x, s.y, r, (1 - f) ** 2, true);
    }
  }

  /**
   * Жерла по стадиям — плоские отверстия в недра со светом из глубины (drawVent).
   * Размер — по модели: сильный вулкан крупнее во всех стадиях; извергающийся —
   * по объёму извержения и темпу выброса сейчас. Показ догоняет модель плавно:
   * новый вулкан вырастает из точки, смены стадий без скачков.
   * - готовится — разгорается и растёт по мере созревания и роста давления;
   *   созревший перед выбросом пульсирует;
   * - извергается — свет из недр в полную силу, белая сердцевина у залпа, к концу сжимается;
   *   каждый залп пускает кольцо по воде;
   * - спит — маленькое тусклое отверстие; потух — сереет и затягивается;
   * - после извержения на дне медленно тает сиреневый шрам.
   * Затем воронки.
   */
  drawVents(frame: Frame, glows: GlowSink): void {
    const { ctx, camera, world, animTime } = frame;
    const m = world.mineral;
    const step = world.step;
    const pressure = Math.max(0, Math.min(1, (m.depths / m.threshold - VOLCANO_BIRTH) / (1 - VOLCANO_BIRTH)));
    ctx.globalCompositeOperation = 'source-over';
    // Шрамы недавних извержений — под жерлами.
    for (const v of m.volcanoes) {
      if ((v.stage !== 'dormant' && v.stage !== 'extinct') || v.k === 0) continue;
      const fade = 1 - (step - v.until) / SCAR_STEPS;
      if (fade <= 0) continue;
      this.softSpot(ctx, v.x, v.y, Math.max(camera.px(10), v.radius * SCAR_SIZE), [[0, SCAR_COLOR, SCAR_ALPHA * fade * fade], [0.6, SCAR_COLOR, 0.5 * SCAR_ALPHA * fade * fade], [1, SCAR_COLOR, 0]]);
    }
    // Волны залпов — кольца, бегущие от жерла.
    for (const s of this.shocks) {
      const f = (animTime - s.t) / RING_S;
      if (f >= 1) continue;
      const ease = 1 - (1 - f) ** 3;
      const radius = camera.px(4) + Math.max(camera.px(26), ERUPTION_RADIUS * RING_REACH * s.scale) * ease;
      ctx.globalAlpha = 0.75 * (1 - f) ** 2;
      ctx.strokeStyle = rgb(RING_COLOR);
      ctx.lineWidth = camera.px(0.6 + 1.6 * (1 - f));
      ctx.beginPath(); ctx.arc(s.x, s.y, radius, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const dt = this.ventTime < 0 ? 0 : Math.min(0.25, Math.max(0, animTime - this.ventTime));
    this.ventTime = animTime;
    const seen = new Set<number>();
    for (const v of m.volcanoes) {
      seen.add(v.id);
      const power = (v.power - VOLCANO_POWER[0]) / (VOLCANO_POWER[1] - VOLCANO_POWER[0]);
      const r = Math.max(camera.px(VENT_MIN_CSS[0] + (VENT_MIN_CSS[1] - VENT_MIN_CSS[0]) * power), VENT_SIZE[0] + (VENT_SIZE[1] - VENT_SIZE[0]) * power);
      const phase = Math.max(0, Math.min(1, (step - v.stageAt) / Math.max(1, v.stageUntil - v.stageAt)));
      const pulse = (Math.sin((animTime * 2 * Math.PI) / VENT_PULSE_S + v.id) + 1) / 2;
      const big = VENT_POWER_SCALE[0] + (VENT_POWER_SCALE[1] - VENT_POWER_SCALE[0]) * power;
      // Цель по модели: размер отверстия, свет из недр (0…1), белизна сердцевины, кромка.
      let size = 0, light = 0, hot = 0, ash = 0, beat = 0, after = 1;
      if (v.stage === 'preparing') {
        // Набирает силу: растёт и разгорается по мере созревания и давления; новорождённый — из точки.
        const grown = v.fresh ? smoothstep(0, 1, phase) : 1;
        const force = grown * (0.3 + 0.7 * pressure);
        beat = (phase >= 1 ? smoothstep(0.85, 1, pressure) : 0) * pulse;
        const grow = force * force;
        size = Math.max(camera.px(VENT_DOT_CSS[0] + (VENT_DOT_CSS[1] - VENT_DOT_CSS[0]) * grow) * big, r * (0.2 + 0.7 * grow))
          * (v.fresh ? smoothstep(0, 0.3, phase) : 1) * (1 + VENT_BEAT * beat);
        light = 0.25 + 0.75 * force;
        hot = 0.3 * force + 0.4 * beat;
      } else if (v.stage === 'erupting') {
        const volume = Math.max(0, Math.min(1, (v.radius / ERUPTION_RADIUS - VENT_VOLUME_FROM) / (1 - VENT_VOLUME_FROM)));
        const now = VENT_ERUPT_CSS[0] + (VENT_ERUPT_CSS[1] - VENT_ERUPT_CSS[0]) * volume;
        const { burst, swell } = this.burstState(v);
        size = Math.max(camera.px(now) * big, r * 0.7) * (0.55 + 0.45 * this.ventStrength(v)) * (1 + VENT_SWELL * swell);
        after = 1 - Math.max(burst, swell);
        light = 0.6 + 0.4 * Math.min(1, this.ventStrength(v) / VENT_TAIL_RATE);
        hot = Math.max(burst, swell, 0.35 * this.ventStrength(v));
      } else if (v.stage === 'dormant') {
        size = Math.max(camera.px(VENT_DOT_CSS[0]) * big, r * 0.2);
        light = 0.12;
      } else {
        size = Math.max(camera.px(VENT_DOT_CSS[0]) * big, r * 0.2) * (1 - phase);
        ash = Math.min(1, phase * 3);
      }
      // Показ догоняет модель плавно: новый вулкан вырастает из точки, смены стадий без скачков.
      let shown = this.vents.get(v.id);
      if (!shown) { shown = { size: 0, light: 0, hot: 0 }; this.vents.set(v.id, shown); }
      // На паузе и в первом кадре — сразу как в модели; на ходу — плавно (новое жерло — из точки).
      const k = dt > 0 ? 1 - Math.exp(-dt / VENT_EASE_S) : 1;
      shown.size += (size - shown.size) * k;
      shown.light += (light - shown.light) * k;
      shown.hot += (hot - shown.hot) * k;
      this.drawVent(frame, v.id, v.x, v.y, shown.size, shown.light, shown.hot, ash, beat);
      if (v.stage === 'erupting') this.drawSpring(frame, v, shown.size, after);
    }
    for (const id of this.vents.keys()) if (!seen.has(id)) this.vents.delete(id);
    for (const id of this.springs.keys()) if (!m.volcanoes.some((v) => v.id === id && v.stage === 'erupting')) this.springs.delete(id);
    this.drawFunnels(frame, glows);
    ctx.globalAlpha = 1;
  }

  /**
   * Приток вещества: по всей площади диска жерла появляются крупинки и уходят
   * от центра наружу так, как в модели расступается среда — скорость по
   * впрыснутому объёму (dA/dt ÷ 2πr), у центра быстрее; за краем диска тают.
   * Чем сильнее выброс, тем их больше. Движутся по шагам мира — на паузе стоят.
   */
  private drawSpring(frame: Frame, v: Volcano, disk: number, after: number): void {
    const { ctx, camera, world: w, detail } = frame;
    let st = this.springs.get(v.id);
    if (!st) {
      st = { p: new Float32Array(SPRING_COUNT * 3), step: w.step };
      for (let n = 0; n < SPRING_COUNT; n++) {
        st.p[n * 3] = hash3(v.id, v.k, n, 1) / 4294967296 * Math.PI * 2;
        st.p[n * 3 + 1] = disk * Math.sqrt(hash3(v.id, v.k, n, 2) / 4294967296);
        st.p[n * 3 + 2] = hash3(v.id, v.k, n, 3) / 4294967296 < 0.05 + 0.6 * this.ventStrength(v) ? 0 : -1;
      }
      this.springs.set(v.id, st);
    }
    const steps = Math.max(0, w.step - st.step);
    st.step = w.step;
    // Скорость расступания: сила толчка (площадь за шаг) ÷ 2πr.
    const u = this.eruptionPhase(v);
    const rate = ventPush(w.params, v, u);
    const strength = this.ventStrength(v);
    const size = camera.px(SPRING_DOT_CSS);
    const p = st.p;
    ctx.strokeStyle = rgb(VENT_SPARK);
    ctx.lineCap = 'round';
    for (let n = 0; n < SPRING_COUNT; n++) {
      const o = n * 3;
      if (p[o + 2] < 0) {
        // Новая — в случайной точке диска (равномерно по площади); живых тем больше, чем сильнее выброс.
        if (steps <= 0 || Math.random() > 0.05 + 0.6 * strength) continue;
        const a = Math.random() * Math.PI * 2, rr = disk * Math.sqrt(Math.random());
        p[o] = a; p[o + 1] = rr; p[o + 2] = 0;
      }
      const r = Math.max(p[o + 1], disk * 0.05);
      p[o + 1] = Math.sqrt(r * r + (rate * steps) / Math.PI);
      // След — от прошлого места, но не длиннее STREAK_MAX радиусов диска.
      const back = Math.max(r, p[o + 1] - disk * STREAK_MAX);
      const f = p[o + 1] / (disk * SPRING_REACH);
      if (f >= 1) { p[o + 2] = -1; continue; }
      ctx.globalAlpha = (1 - f) * (0.6 + 0.35 * after) * Math.min(1, 0.55 + strength * 3) * (0.55 + 0.45 * detail);
      // Рождается точкой в жерле и растёт, отходя от него.
      const sz = size * (0.15 + 0.85 * smoothstep(0, disk * 1.2, p[o + 1]));
      const x = v.x + Math.cos(p[o]) * p[o + 1], y = v.y + Math.sin(p[o]) * p[o + 1];
      if (!insideDish(w.dish, x, y) || isBlocked(w.partitions, x, y)) { p[o + 2] = -1; continue; }
      // Струйка: короткий тающий след вдоль пути от жерла.
      const bx = v.x + Math.cos(p[o]) * back, by = v.y + Math.sin(p[o]) * back;
      ctx.lineWidth = sz;
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(x + Math.cos(p[o]) * sz * 0.3, y + Math.sin(p[o]) * sz * 0.3); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.lineCap = 'butt';
  }

  /**
   * Воронки — отверстия в недра. Отверстие — мягкая кромка по краю и плавное
   * затемнение к центру —
   * плоско, без теней; свечение недр из него по силе воронки; ушедшая вниз
   * крупинка мелькает искрой. Сгущаются и тают по модели (проявленность — сила воронки).
   * Светлые крупинки в ареоле идут по сумме
   * течений — прямо или по спирали, если рядом течение; дойдя до отверстия,
   * зависают и тают (у жерла наоборот: рождаются точкой и растут).
   */
  private drawFunnels(frame: Frame, glows: GlowSink): void {
    const { ctx, camera, world: w, animTime, detail } = frame;
    const m = w.mineral;
    const dt = this.funnelTime < 0 ? 0 : Math.min(0.1, Math.max(0, animTime - this.funnelTime));
    this.funnelTime = animTime;
    const steps = Math.max(0, w.step - this.funnelStep);
    this.funnelStep = w.step;
    // Воронки модели — по номеру; проявленность — их сила (сгущаются и тают по модели).
    const views = new Map(this.funnelViews.map((e) => [e.id, e]));
    this.funnelViews = m.funnels.map((f) => {
      let e = views.get(f.id);
      if (!e) {
        e = { id: f.id, x: f.x, y: f.y, cells: f.cells, reach: f.reach, alpha: 0, alive: true, grains: new Float32Array(FUNNEL_GRAINS * 4).fill(-1) };
        // При загрузке на паузе частицы сразу видны; дальнейший пересев только при ходе времени.
        for (let q = 0; q < FUNNEL_GRAINS; q++) {
          if (hash3(f.id, q, 0) / 4294967296 > f.strength) continue;
          const a = hash3(f.id, q, 1) / 4294967296 * Math.PI * 2;
          const r = f.reach * (q % 3 === 0 ? 0.35 : 1) * Math.sqrt(hash3(f.id, q, 2) / 4294967296);
          e.grains[q * 4] = f.x + Math.cos(a) * r;
          e.grains[q * 4 + 1] = f.y + Math.sin(a) * r;
          e.grains[q * 4 + 2] = hash3(f.id, q, 3) / 4294967296 * FUNNEL_GRAIN_LIFE * 0.25;
        }
      }
      e.alpha = f.strength;
      e.alive = f.forming;
      return e;
    });
    if (this.funnelViews.length === 0) return;
    // Отверстия: форма (размытая), сила, глубина от края к центру — на сетке
    // поля; рисуются в FUNNEL_RES раз детальнее, только когда мир изменился.
    const n = m.field.length;
    const holes = new Uint8Array(n);
    for (const e of this.funnelViews) if (e.alpha > 0) for (const k of e.cells) holes[k] = 1;
    const S = FUNNEL_RES;
    if (this.funnelPixels.width !== m.cols * S || this.funnelPixels.height !== m.rows * S) {
      this.funnelPixels = { data: new Uint8Array(m.cols * S * m.rows * S * 4), width: m.cols * S, height: m.rows * S };
      this.funnelDrawn = -1;
    }
    const pixels = this.funnelPixels;
    if (this.funnelDrawn !== m.version) {
      this.funnelDrawn = m.version;
      this.funnelVersion++;
      const shape = new Float32Array(n), power = new Float32Array(n), depth = new Float32Array(n);
      for (const e of this.funnelViews) {
        // Глубина клетки отверстия — расстояние от её центра до края отверстия (в клетках), к центру — 1.
        const inHole = new Set<number>(Array.from(e.cells));
        const edges: number[] = [];
        for (const k of e.cells) {
          const i = k % m.cols, j = (k - i) / m.cols;
          for (const [di, dj] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
            const qi = i + di, qj = j + dj;
            if (qi < 0 || qj < 0 || qi >= m.cols || qj >= m.rows || !inHole.has(qj * m.cols + qi)) edges.push(i + di / 2, j + dj / 2);
          }
        }
        const dist = new Map<number, number>();
        for (const k of e.cells) {
          const i = k % m.cols, j = (k - i) / m.cols;
          let best = Infinity;
          for (let q = 0; q < edges.length; q += 2) best = Math.min(best, Math.hypot(edges[q] - i, edges[q + 1] - j));
          dist.set(k, best);
        }
        const deepest = Math.max(0.5, ...dist.values());
        for (const k of e.cells) {
          shape[k] = 1;
          power[k] = Math.max(power[k], e.alpha);
          depth[k] = Math.max(depth[k], (dist.get(k) ?? 0.5) / deepest);
        }
      }
      const blur = (a: Float32Array, passes: number) => {
        const tmp = new Float32Array(n);
        for (let pass = 0; pass < passes; pass++) {
          for (let k = 0; k < n; k++) {
            const i = k % m.cols;
            tmp[k] = ((i > 0 ? a[k - 1] : a[k]) + 2 * a[k] + (i < m.cols - 1 ? a[k + 1] : a[k])) / 4;
          }
          for (let k = 0; k < n; k++) a[k] = ((k >= m.cols ? tmp[k - m.cols] : tmp[k]) + 2 * tmp[k] + (k + m.cols < n ? tmp[k + m.cols] : tmp[k])) / 4;
        }
      };
      blur(shape, 1);
      blur(power, 2);
      blur(depth, 1);
      pixels.data.fill(0);
      const at = (a: Float32Array, fx: number, fy: number) => {
        const x = Math.min(m.cols - 1, Math.max(0, fx)), y = Math.min(m.rows - 1, Math.max(0, fy));
        const i0 = Math.floor(x), j0 = Math.floor(y), i1 = Math.min(m.cols - 1, i0 + 1), j1 = Math.min(m.rows - 1, j0 + 1);
        const u = x - i0, v = y - j0;
        return (a[j0 * m.cols + i0] * (1 - u) + a[j0 * m.cols + i1] * u) * (1 - v) + (a[j1 * m.cols + i0] * (1 - u) + a[j1 * m.cols + i1] * u) * v;
      };
      for (const e of this.funnelViews) {
        if (e.alpha <= 0) continue;
        let i0 = m.cols, i1 = 0, j0 = m.rows, j1 = 0;
        for (const k of e.cells) { const i = k % m.cols, j = (k - i) / m.cols; i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j); }
        i0 = Math.max(0, i0 - 2); j0 = Math.max(0, j0 - 2); i1 = Math.min(m.cols - 1, i1 + 2); j1 = Math.min(m.rows - 1, j1 + 2);
        const bw = (i1 - i0 + 1) * S, bh = (j1 - j0 + 1) * S;
        for (let py = 0; py < bh; py++) {
          for (let px = 0; px < bw; px++) {
            const fx = i0 + (px + 0.5) / S - 0.5, fy = j0 + (py + 0.5) / S - 0.5;
            const sh = at(shape, fx, fy);
            const st = at(power, fx, fy);
            if (sh <= 0.05 || st <= 0) continue;
            // Кромка мягкая, затемнение к центру непрерывное, без ступенчатых колец.
            const inside = smoothstep(0.35, 0.6, sh);
            const rim = Math.max(0, 1 - Math.abs(sh - 0.45) / 0.14);
            const d = at(depth, fx, fy) * inside;
            let col = mix(FUNNEL_COLOR, FUNNEL_DEEP, smoothstep(0, 1, d));
            col = mix(col, FUNNEL_RIM_COLOR, rim * 0.65);
            const a = Math.max(inside * FUNNEL_ALPHA, rim * FUNNEL_RIM_ALPHA) * smoothstep(0, FUNNEL_SHOWN, st);
            const o = ((j0 * S + py) * pixels.width + i0 * S + px) * 4;
            const alpha = Math.max(pixels.data[o + 3] / 255, a);
            pixels.data[o] = col[0] * alpha;
            pixels.data[o + 1] = col[1] * alpha;
            pixels.data[o + 2] = col[2] * alpha;
            pixels.data[o + 3] = 255 * alpha;
          }
        }
      }
    }
    glows.image(pixels, this.funnelVersion, 0, 0, m.cols * m.cell, m.rows * m.cell, 0.6 + 0.4 * detail);
    // Свечение недр из отверстия — по силе воронки: рождающаяся тлеет, полная светится, тающая гаснет.
    for (const e of this.funnelViews) {
      if (e.alpha <= 0) continue;
      let cx = 0, cy = 0;
      for (const k of e.cells) { const i = k % m.cols; cx += (i + 0.5) * m.cell; cy += ((k - i) / m.cols + 0.5) * m.cell; }
      cx /= e.cells.length; cy /= e.cells.length;
      const r = Math.max(camera.px(FUNNEL_GLOW_MIN_CSS), Math.sqrt((e.cells.length * m.cell * m.cell) / Math.PI) * FUNNEL_GLOW_SIZE);
      glows.glow(FUNNEL_GLOW, cx, cy, r, FUNNEL_GLOW_ALPHA * e.alpha, false);
    }
    // Крупинки стекают в отверстие по сумме течений.
    const v: [number, number] = [0, 0];
    const size = camera.px(FUNNEL_GRAIN_CSS);
    const maxHop = camera.px(10);
    ctx.fillStyle = rgb(FUNNEL_PARTICLE);
    ctx.strokeStyle = rgb(FUNNEL_PARTICLE);
    ctx.lineWidth = camera.px(0.85); ctx.lineCap = 'round';
    const allowed = (x: number, y: number) => insideDish(w.dish, x, y) && !isBlocked(w.partitions, x, y);
    for (const e of this.funnelViews) {
      const p = e.grains;
      const trails = new Path2D();
      for (let q = 0; q < FUNNEL_GRAINS; q++) {
        const o = q * 4;
        if (p[o + 2] < 0) {
          if (dt <= 0 || Math.random() > 0.15 * e.alpha) continue;
          const a = Math.random() * Math.PI * 2, r = e.reach * (q % 3 === 0 ? 0.35 : 1) * Math.sqrt(Math.random());
          p[o] = e.x + Math.cos(a) * r; p[o + 1] = e.y + Math.sin(a) * r; p[o + 2] = 0; p[o + 3] = -1;
        }
        p[o + 2] += dt;
        if (!allowed(p[o], p[o + 1])) { p[o + 2] = -1; continue; }
        const ci = Math.min(m.cols - 1, Math.max(0, Math.floor(p[o] / m.cell)));
        const cj = Math.min(m.rows - 1, Math.max(0, Math.floor(p[o + 1] / m.cell)));
        if (holes[cj * m.cols + ci]) {
          // В отверстии течение вещество не уносит: крупинка зависает и тает — уходит вниз.
          if (p[o + 3] < 0) p[o + 3] = 0;
          p[o + 3] += dt;
        } else if (steps > 0) {
          // По сумме течений: тяга внутрь + солнечное течение вбок — прямо или по спирали.
          flowAt(w, p[o], p[o + 1], v);
          let dx = v[0] * steps, dy = v[1] * steps;
          const hop = Math.hypot(dx, dy);
          if (hop > maxHop) { dx *= maxHop / hop; dy *= maxHop / hop; }
          if (!allowed(p[o] + dx / 2, p[o + 1] + dy / 2) || !allowed(p[o] + dx, p[o + 1] + dy)) { p[o + 2] = -1; continue; }
          p[o] += dx; p[o + 1] += dy;
        }
        const sinking = p[o + 3] < 0 ? 1 : 1 - p[o + 3] / SINK_S;
        if (sinking <= 0) {
          // Ушла вниз — на её месте мелькает искра.
          this.funnelSparks.push({ x: p[o], y: p[o + 1], t: animTime });
          p[o + 2] = -1;
          continue;
        }
        if (p[o + 2] > FUNNEL_GRAIN_LIFE) { p[o + 2] = -1; continue; }
        const sz = size * (0.1 + 0.9 * sinking);
        ctx.globalAlpha = e.alpha * Math.min(1, p[o + 2] * 3) * 0.9 * (0.5 + 0.5 * detail);
        // Короткий условный след назад по реальному полю, без придуманного вращения.
        if (p[o + 3] < 0) {
          flowAt(w, p[o], p[o + 1], v);
          const speed = Math.hypot(...v);
          const length = Math.min(m.cell / 2, camera.px(6) * speed / (speed + DRIFT_REFERENCE));
          if (speed > 1e-6 && length > camera.px(0.5)) {
            const tx = p[o] - v[0] / speed * length, ty = p[o + 1] - v[1] / speed * length;
            if (allowed(tx, ty) && allowed((tx + p[o]) / 2, (ty + p[o + 1]) / 2)) {
              trails.moveTo(tx, ty); trails.lineTo(p[o], p[o + 1]);
            }
          }
        }
        // Уходящая крупинка одновременно уменьшается и гаснет.
        ctx.globalAlpha *= Math.sqrt(Math.max(0, sinking));
        ctx.fillRect(p[o] - sz / 2, p[o + 1] - sz / 2, sz, sz);
      }
      ctx.globalAlpha = e.alpha * 0.45 * (0.5 + 0.5 * detail);
      ctx.stroke(trails);
    }
    // Искры — крупинки, ушедшие в недра: короткая вспышка, расширяется и гаснет.
    this.funnelSparks = this.funnelSparks.filter((sp) => animTime - sp.t < SPARK_S);
    for (const sp of this.funnelSparks) {
      const f = (animTime - sp.t) / SPARK_S;
      const r = camera.px(SPARK_CSS) * (0.6 + 0.8 * f);
      glows.glow(FUNNEL_PARTICLE, sp.x, sp.y, r, 0.35 * (1 - f) ** 2 * (0.5 + 0.5 * detail), false);
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Жерло — отверстие в недра, плоское: неровный край (форма постоянна для
   * вулкана), внутри темно, из глубины пробивается свет — тем ярче и шире, чем
   * больше `light`; `hot` — белая сердцевина (залп, набухание); кромка светится;
   * `ash` — потухшее сереет; `beat` — пульс созревшего.
   */
  private drawVent(frame: Frame, id: number, x: number, y: number, radius: number, light: number, hot: number, ash: number, beat: number): void {
    if (radius <= 0.01) return;
    const { ctx, camera } = frame;
    // Ореол вокруг — свет из недр на дне.
    this.softSpot(ctx, x, y, radius * (3 + 1.2 * beat), [[0, MINERAL_COLOR, (0.4 + 0.3 * beat) * light], [0.45, MINERAL_COLOR, 0.14 * light], [1, MINERAL_COLOR, 0]]);
    const path = new Path2D();
    const n = 28;
    for (let q = 0; q <= n; q++) {
      const a = (q / n) * Math.PI * 2;
      const wave = Math.sin(3 * a + (hash3(id, 7, 1) / 4294967296) * 6.28) * 0.6 + Math.sin(5 * a + (hash3(id, 7, 2) / 4294967296) * 6.28) * 0.4;
      const rr = radius * (1 + VENT_RAGGED * wave);
      if (q === 0) path.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); else path.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    path.closePath();
    const deep = mix(VENT_HOLE, VENT_ASH, ash);
    const core = mix(mix(MINERAL_COLOR, VENT_SPARK, hot), VENT_ASH, ash);
    const g = ctx.createRadialGradient(x, y, 0, x, y, radius * (1 + VENT_RAGGED));
    g.addColorStop(0, rgb(mix(deep, core, Math.min(1, light + hot))));
    g.addColorStop(Math.max(0.05, 0.25 + 0.45 * light + 0.2 * hot) * 0.9, rgb(mix(deep, MINERAL_COLOR, 0.55 * light)));
    g.addColorStop(1, rgb(deep));
    ctx.globalAlpha = 1;
    ctx.fillStyle = g;
    ctx.fill(path);
    // Светящаяся кромка — край отверстия, сквозь который виден свет.
    ctx.globalAlpha = Math.min(1, 0.25 + 0.6 * light + 0.3 * hot) * (1 - ash * 0.7);
    ctx.strokeStyle = rgb(mix(mix(VENT_RIM, VENT_SPARK, Math.max(hot, 0.4 * light)), VENT_ASH, ash));
    ctx.lineWidth = camera.px(1 + 0.6 * hot);
    ctx.stroke(path);
    ctx.globalAlpha = 1;
  }


  /** Мягкое круглое пятно: стопы — (доля радиуса, цвет, непрозрачность). */
  private softSpot(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, stops: [number, Rgb, number][]): void {
    if (radius <= 0) return;
    const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
    for (const [at, c, a] of stops) g.addColorStop(at, rgb(c, Math.max(0, Math.min(1, a))));
    ctx.globalAlpha = 1;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  /** Доля времени идущего извержения, 0…1 — плавно по шагам (темп в модели обновляется реже). */
  private eruptionPhase(v: Volcano): number {
    return Math.min(1, Math.max(0, (this.world.step - v.begin) / Math.max(1, v.until - v.begin)));
  }

  /** Сила выброса сейчас относительно начала извержения, 0…1 — как в модели. */
  private ventStrength(v: Volcano): number {
    return eruptionRate(this.world.params, v, this.eruptionPhase(v));
  }

  /** Залп сейчас (0…1) и набухание перед следующим залпом (0…1, растёт к самому залпу, с пульсом). */
  private burstState(v: Volcano): { burst: number; swell: number } {
    const u = this.eruptionPhase(v);
    let burst = 0, swell = 0;
    for (const b of eruptionBursts(this.world.params, v)) {
      if (u >= b.at && u < b.at + BURST_WIDTH) burst = Math.max(burst, 1 - (u - b.at) / BURST_WIDTH);
      if (b.at > 0 && u < b.at && u > b.at - VENT_SWELL_TIME) swell = Math.max(swell, smoothstep(b.at - VENT_SWELL_TIME, b.at, u));
    }
    return { burst, swell };
  }
}
