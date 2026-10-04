/**
 * Вулканы и воронки — отверстия в недра: жерла по стадиям, вспышки залпов и
 * свечение по темпу выброса, приток вещества из жерла; отверстия воронок,
 * свечение недр, крупинки, стекающие в отверстие, и искры ушедших вниз.
 */
import { BURST_WIDTH, DRIFT_REFERENCE, ERUPTION_RADIUS, VOLCANO_BIRTH, VOLCANO_POWER, eruptionBursts, eruptionRate, flowAt, hash3, insideDish, isBlocked, ventPush, type Volcano, type World } from '../../core/index.ts';
import type { Frame } from './frame.ts';
import { SINK_S } from './mineral.ts';
import { MINERAL_COLOR, mix, rgb, smoothstep, traceDish, type Rgb } from './palette.ts';

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
/** Отверстие вулкана: в силе — белое с оттенком минерала, без силы (спит) — тусклое. */
const VENT_SPARK: Rgb = [250, 242, 255];
const VENT_DIM: Rgb = [128, 106, 160];
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
const BAR_OUT: Rgb = [226, 200, 255];

/** Мягкое круглое пятно цвета `c` — спрайт свечения и фронта (кеш по цвету). */
const puffSprites = new Map<string, HTMLCanvasElement>();
function puffSprite(c: Rgb): HTMLCanvasElement {
  const key = c.join(',');
  let sprite = puffSprites.get(key);
  if (sprite) return sprite;
  const size = 64;
  sprite = document.createElement('canvas');
  sprite.width = sprite.height = size;
  const g = sprite.getContext('2d')!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, rgb(c, 1));
  grad.addColorStop(0.4, rgb(c, 0.55));
  grad.addColorStop(1, rgb(c, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  puffSprites.set(key, sprite);
  return sprite;
}

export class SourcesLayer {
  /** Крупинки притока из жерла по вулканам: угол, расстояние от центра, жива ли (−1 — нет); шаг мира прошлого кадра. */
  private springs = new Map<number, { p: Float32Array; step: number }>();
  /** Отверстия воронок (клетка поля — пиксель). */
  private readonly funnelCanvas = document.createElement('canvas');
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
  private world!: World;

  setWorld(world: World): void {
    this.world = world;
    this.funnelDrawn = -1;
    this.shocks = [];
    this.seenBursts = new Map(world.mineral.volcanoes.filter((v) => v.stage === 'erupting')
      .map((v) => [`${v.id}:${v.k}`, eruptionBursts(world.params, v).filter((b) => b.at <= Math.max(0, (world.step - v.begin) / Math.max(1, v.until - v.begin))).length]));
    this.springs.clear();
    this.funnelViews = [];
    this.funnelSparks = [];
    this.funnelTime = -1;
    this.funnelStep = world.step;
  }

  /**
   * Извержения: вспышка каждого залпа (во времени анимации — залп, прошедший
   * между кадрами, тоже её даёт) и свечение жерла по темпу выброса.
   */
  drawEruptions(frame: Frame): void {
    const { ctx, camera, world: w, animTime } = frame;
    const m = w.mineral;
    const light = puffSprite(ERUPTION_LIGHT);

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
    this.shocks = this.shocks.filter((s) => animTime - s.t < ERUPTION_FLASH_S);

    ctx.save();
    ctx.beginPath();
    traceDish(ctx, w.dish);
    ctx.clip();
    ctx.globalCompositeOperation = 'screen';

    // Свечение жерла — по темпу выброса; между залпами слабее.
    for (const v of m.volcanoes) {
      if (v.stage !== 'erupting') continue;
      const flicker = 0.8 + 0.12 * Math.sin(animTime * 11 + v.id * 1.7) + 0.08 * Math.sin(animTime * 23.3 + v.id);
      const r = Math.max(camera.px(VENT_GLOW_MIN_CSS), v.radius * VENT_GLOW) * (0.85 + 0.15 * flicker);
      ctx.globalAlpha = Math.min(1, (0.15 + 0.85 * this.ventStrength(v)) * flicker);
      ctx.drawImage(light, v.x - r, v.y - r, r * 2, r * 2);
    }

    // Вспышки залпов.
    for (const s of this.shocks) {
      const f = (animTime - s.t) / ERUPTION_FLASH_S;
      const r = Math.max(camera.px(VENT_GLOW_MIN_CSS * 2), ERUPTION_RADIUS * 0.4 * s.scale) * (0.6 + 0.6 * f);
      ctx.globalAlpha = (1 - f) ** 2;
      ctx.drawImage(light, s.x - r, s.y - r, r * 2, r * 2);
    }
    ctx.restore();
  }

  /**
   * Жерла по стадиям — плоские; само жерло — отверстие в недра, сплошной
   * непрозрачный диск (мягкий только ореол). Размер — по модели: сильный
   * вулкан крупнее во всех стадиях; извергающийся — по объёму извержения и
   * темпу выброса сейчас:
   * - готовится — маленькая белая точка с оттенком минерала и ореолом набирает
   *   силу (растёт и ярчает, к самому взрыву — заметно крупнее) по мере
   *   созревания и роста давления к порогу;
   *   созревший перед самым выбросом пульсирует размером, цветом и ореолом;
   * - извергается — белое отверстие со светлым ореолом, к концу сжимается;
   * - спит — угасшая искра: маленькое тусклое отверстие;
   * - потух — отверстие сереет и затягивается до исчезновения.
   * Затем воронки.
   */
  drawVents(frame: Frame): void {
    const { ctx, camera, world, animTime } = frame;
    const m = world.mineral;
    const step = world.step;
    const pressure = Math.max(0, Math.min(1, (m.depths / m.threshold - VOLCANO_BIRTH) / (1 - VOLCANO_BIRTH)));
    ctx.globalCompositeOperation = 'source-over';
    for (const v of m.volcanoes) {
      const power = (v.power - VOLCANO_POWER[0]) / (VOLCANO_POWER[1] - VOLCANO_POWER[0]);
      const r = Math.max(camera.px(VENT_MIN_CSS[0] + (VENT_MIN_CSS[1] - VENT_MIN_CSS[0]) * power), VENT_SIZE[0] + (VENT_SIZE[1] - VENT_SIZE[0]) * power);
      const phase = Math.max(0, Math.min(1, (step - v.stageAt) / Math.max(1, v.stageUntil - v.stageAt)));
      const pulse = (Math.sin((animTime * 2 * Math.PI) / VENT_PULSE_S + v.id) + 1) / 2;
      // Размер — по мощности вулкана: сильный крупнее во всех стадиях.
      const big = VENT_POWER_SCALE[0] + (VENT_POWER_SCALE[1] - VENT_POWER_SCALE[0]) * power;
      // Само жерло — отверстие в недра: сплошной непрозрачный диск; мягким
      // бывает только ореол вокруг.
      if (v.stage === 'preparing') {
        // Набирает силу: растёт и светлеет от тусклого к белому по мере
        // созревания и роста давления к порогу; к самому взрыву — заметно
        // крупнее; созревший перед выбросом мерцает. Новорождённый открывается из точки.
        const grown = v.fresh ? smoothstep(0, 1, phase) : 1;
        const force = grown * (0.3 + 0.7 * pressure);
        const ready = phase >= 1 ? smoothstep(0.85, 1, pressure) : 0;
        // Пульс созревшего — размером и цветом диска и ореолом; диск всегда непрозрачен.
        const beat = ready * pulse;
        const grow = force * force;
        const dot = Math.max(camera.px(VENT_DOT_CSS[0] + (VENT_DOT_CSS[1] - VENT_DOT_CSS[0]) * grow) * big, r * (0.2 + 0.7 * grow))
          * (v.fresh ? smoothstep(0, 0.3, phase) : 1) * (1 + VENT_BEAT * beat);
        this.softSpot(ctx, v.x, v.y, dot * (3.2 + 1.2 * beat), [[0, MINERAL_COLOR, (0.45 + 0.3 * beat) * force], [0.5, MINERAL_COLOR, (0.15 + 0.15 * beat) * force], [1, MINERAL_COLOR, 0]]);
        this.solidDot(ctx, v.x, v.y, dot, mix(mix(VENT_DIM, VENT_SPARK, force), MINERAL_COLOR, 0.45 * beat));
        this.ventRim(frame, v.x, v.y, dot, mix(VENT_RIM, VENT_SPARK, force), 0.35 + 0.4 * force);
      } else if (v.stage === 'erupting') {
        // Извергается: крупнее у большого извержения (по объёму) и сейчас, пока
        // выброс силён, — к концу диск сжимается вместе с темпом.
        const volume = Math.max(0, Math.min(1, (v.radius / ERUPTION_RADIUS - VENT_VOLUME_FROM) / (1 - VENT_VOLUME_FROM)));
        const now = VENT_ERUPT_CSS[0] + (VENT_ERUPT_CSS[1] - VENT_ERUPT_CSS[0]) * volume;
        const dot = Math.max(camera.px(now) * big, r * 0.7) * (0.55 + 0.45 * this.ventStrength(v)) * (1 + VENT_SWELL * this.burstState(v).swell);
        // Во время залпа — ярко-белое; между залпами идёт вещество — цвет
        // минерала; перед следующим залпом набухает — растёт и светлеет — и лопается.
        const { burst, swell } = this.burstState(v);
        const after = 1 - Math.max(burst, swell);
        const color = mix(VENT_SPARK, mix(MINERAL_COLOR, VENT_DIM, 0.4 * Math.max(0, 1 - this.ventStrength(v) / VENT_TAIL_RATE)), after);
        this.softSpot(ctx, v.x, v.y, dot * 2.3, [[0.3, mix(BAR_OUT, MINERAL_COLOR, after), 0.8 - 0.4 * after], [0.75, MINERAL_COLOR, 0.35 - 0.15 * after], [1, MINERAL_COLOR, 0]]);
        this.solidDot(ctx, v.x, v.y, dot, color);
        this.ventRim(frame, v.x, v.y, dot, mix(VENT_RIM, VENT_SPARK, Math.max(burst, swell)), 0.65 + 0.25 * burst);
        // Яркая сердцевина только у реального залпа; при истечении остаётся сиреневый диск.
        if (burst > 0) this.solidDot(ctx, v.x, v.y, dot * 0.45 * Math.sqrt(burst), VENT_SPARK);
        this.drawSpring(frame, v, dot, after);
      } else if (v.stage === 'dormant') {
        // Угасшая искра: маленькое тусклое отверстие, без ореола; может снова разгореться.
        const dot = Math.max(camera.px(VENT_DOT_CSS[0]) * big, r * 0.2);
        this.solidDot(ctx, v.x, v.y, dot, mix(VENT_DIM, FUNNEL_DEEP, 0.4));
        this.ventRim(frame, v.x, v.y, dot, VENT_RIM, 0.3);
      } else {
        // Потухший: отверстие сереет и затягивается до исчезновения.
        const dot = Math.max(camera.px(VENT_DOT_CSS[0]) * big, r * 0.2) * (1 - phase);
        this.solidDot(ctx, v.x, v.y, dot, mix(VENT_DIM, VENT_ASH, Math.min(1, phase * 3)));
        this.ventRim(frame, v.x, v.y, dot, VENT_ASH, 0.3 * (1 - phase));
      }
    }
    for (const id of this.springs.keys()) if (!m.volcanoes.some((v) => v.id === id && v.stage === 'erupting')) this.springs.delete(id);
    this.drawFunnels(frame);
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
    ctx.fillStyle = rgb(VENT_SPARK);
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
      const f = p[o + 1] / (disk * SPRING_REACH);
      if (f >= 1) { p[o + 2] = -1; continue; }
      ctx.globalAlpha = (1 - f) * (0.6 + 0.35 * after) * Math.min(1, 0.55 + strength * 3) * (0.55 + 0.45 * detail);
      // Рождается точкой в жерле и растёт, отходя от него.
      const sz = size * (0.15 + 0.85 * smoothstep(0, disk * 1.2, p[o + 1]));
      const x = v.x + Math.cos(p[o]) * p[o + 1], y = v.y + Math.sin(p[o]) * p[o + 1];
      if (!insideDish(w.dish, x, y) || isBlocked(w.partitions, x, y)) { p[o + 2] = -1; continue; }
      ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz);
    }
    ctx.globalAlpha = 1;
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
  private drawFunnels(frame: Frame): void {
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
    const c = this.funnelCanvas;
    const S = FUNNEL_RES;
    if (c.width !== m.cols * S) { c.width = m.cols * S; c.height = m.rows * S; this.funnelDrawn = -1; }
    if (this.funnelDrawn !== m.version) {
      this.funnelDrawn = m.version;
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
      const W = m.cols * S, H = m.rows * S;
      const fctx = c.getContext('2d')!;
      fctx.clearRect(0, 0, W, H);
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
        const img = fctx.getImageData(i0 * S, j0 * S, bw, bh);
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
            const o = (py * bw + px) * 4;
            img.data[o] = col[0];
            img.data[o + 1] = col[1];
            img.data[o + 2] = col[2];
            img.data[o + 3] = Math.max(img.data[o + 3], 255 * a);
          }
        }
        fctx.putImageData(img, i0 * S, j0 * S);
      }
    }
    ctx.globalAlpha = 0.6 + 0.4 * detail;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(c, 0, 0, m.cols * m.cell, m.rows * m.cell);
    ctx.globalAlpha = 1;
    // Свечение недр из отверстия — по силе воронки: рождающаяся тлеет, полная светится, тающая гаснет.
    const glow = puffSprite(FUNNEL_GLOW);
    ctx.globalCompositeOperation = 'screen';
    for (const e of this.funnelViews) {
      if (e.alpha <= 0) continue;
      let cx = 0, cy = 0;
      for (const k of e.cells) { const i = k % m.cols; cx += (i + 0.5) * m.cell; cy += ((k - i) / m.cols + 0.5) * m.cell; }
      cx /= e.cells.length; cy /= e.cells.length;
      const r = Math.max(camera.px(FUNNEL_GLOW_MIN_CSS), Math.sqrt((e.cells.length * m.cell * m.cell) / Math.PI) * FUNNEL_GLOW_SIZE);
      ctx.globalAlpha = FUNNEL_GLOW_ALPHA * e.alpha;
      ctx.drawImage(glow, cx - r, cy - r, r * 2, r * 2);
    }
    ctx.globalCompositeOperation = 'source-over';
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
    ctx.globalCompositeOperation = 'screen';
    const spark = puffSprite(FUNNEL_PARTICLE);
    for (const sp of this.funnelSparks) {
      const f = (animTime - sp.t) / SPARK_S;
      const r = camera.px(SPARK_CSS) * (0.6 + 0.8 * f);
      ctx.globalAlpha = 0.35 * (1 - f) ** 2 * (0.5 + 0.5 * detail);
      ctx.drawImage(spark, sp.x - r, sp.y - r, r * 2, r * 2);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  /** Тонкая кромка жерла; её радиус следует размеру диска, не фронту выброса. */
  private ventRim(frame: Frame, x: number, y: number, radius: number, color: Rgb, alpha: number): void {
    if (radius <= 0) return;
    const { ctx, camera } = frame;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = rgb(color); ctx.lineWidth = camera.px(1.2);
    ctx.beginPath(); ctx.arc(x, y, radius + camera.px(1.5), 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  /** Сплошной непрозрачный диск. */
  private solidDot(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, c: Rgb): void {
    if (radius <= 0) return;
    ctx.globalAlpha = 1;
    ctx.fillStyle = rgb(c);
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
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
