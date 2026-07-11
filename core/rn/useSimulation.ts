/**
 * Мост «движок → React Native». Фазы 1–3.
 *
 * Архитектура (CLAUDE.md, инварианты 3–4):
 *  - World живёт в useRef, НЕ в React-стейте: setState на каждый тик убил бы перф.
 *  - Симуляция идёт фиксированным timestep через SimClock, отвязанно от FPS.
 *  - Позиции/цвет пишутся в Reanimated SharedValue-буферы → читаются на UI-потоке Skia.
 *  - `clock` инкрементируется каждый кадр: гарантированный триггер перерисовки Skia.
 *
 * Фаза 3 — фоновая жизнь мира:
 *  - при уходе в фон снимаем состояние в MMKV (persistence.ts);
 *  - при старте восстанавливаем и ДЕТЕРМИНИРОВАННО догоняем пропущенное «мировое
 *    время» (реальная пауза × 30 тиков/сек), но не больше капа.
 *  - Догон идёт ЧАНКАМИ по кадрам (видимый time-lapse с прогрессом), а не одним
 *    блоком: на устройстве тик недёшев, синхронный догон длинного простоя подвесил бы
 *    запуск (PLAN.md §6). Кап — честная механика и тюнингуемый рычаг (PLAN.md §8).
 *
 * Ядро (core/src) отсюда НЕ меняется — импортируем только публичный API.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { AppState } from 'react-native';
import { useSharedValue, type SharedValue } from 'react-native-reanimated';
import { World, SimClock, defaultGenesis, defaultConfig, Gene } from '../src/index.ts';
import type { WorldConfig } from '../src/index.ts';
import { saveWorld, loadWorld, clearWorld } from './persistence.ts';

const CAP = 3000; // потолок существ в буфере рендера
const HISTORY = 120; // длина истории популяции для спарклайна
const TICKS_PER_SEC = 30; // «мировое время»: 1 реальная секунда паузы = 30 тиков
const CATCHUP_CAP_TICKS = 9000; // предел досчитываемого простоя (~5 мин мира) — рычаг баланса
const CATCHUP_CHUNK = 100; // тиков за кадр во время догона (плавность time-lapse)

/** Снимок особи для инспектора (по тапу). */
export interface Inspected {
  size: number;
  speed: number;
  vision: number;
  metabolism: number;
  reproThreshold: number;
  mutationRate: number;
  hue: number;
  sexualTendency: number;
  energy: number;
  age: number;
}

export interface SimStats {
  population: number;
  tick: number;
  meanSize: number;
  meanSpeed: number;
  food: number;
  history: number[];
}

/** Сводка «пока тебя не было» (Фаза 3). */
export interface ResumeSummary {
  ticks: number; // сколько тиков досчитано
  awayMinutes: number; // реальная длительность отсутствия
  capped: boolean; // упёрлись ли в кап (мир «замерзал»)
  popBefore: number;
  popAfter: number;
  sizeBefore: number;
  sizeAfter: number;
}

interface CatchupPlan {
  remaining: number;
  total: number;
  awayMs: number;
  capped: boolean;
  before: { pop: number; size: number };
}

export interface SimHandle {
  posX: SharedValue<Float32Array>;
  posY: SharedValue<Float32Array>;
  radius: SharedValue<Float32Array>;
  hue: SharedValue<Float32Array>;
  count: SharedValue<number>;
  clock: SharedValue<number>;
  worldSize: number;
  setSunlight: (v: number) => void;
  setTemperature: (v: number) => void;
  scheduleIceAge: () => void;
  reset: () => void;
  togglePlay: () => void;
  inspectAt: (wx: number, wy: number) => Inspected | null;
  stats: SimStats;
  catchingUp: boolean;
  catchupPct: number;
  resumeSummary: ResumeSummary | null;
  dismissSummary: () => void;
}

export function useSimulation(): SimHandle {
  const worldRef = useRef<World | null>(null);
  const catchupRef = useRef<CatchupPlan | null>(null);
  const clockRef = useRef(new SimClock(TICKS_PER_SEC));
  const playingRef = useRef(true);
  const rafRef = useRef<number | null>(null);
  const lastRef = useRef(0);
  const frameRef = useRef(0);
  const historyRef = useRef<number[]>([]);
  const statAccum = useRef(0);

  // Ленивая инициализация мира: сначала пробуем восстановить сохранённый.
  if (worldRef.current === null) {
    const saved = loadWorld();
    if (saved) {
      worldRef.current = saved.world;
      const awayMs = Math.max(0, Date.now() - saved.savedAt);
      const rawTicks = Math.floor((awayMs / 1000) * TICKS_PER_SEC);
      const ticks = Math.min(rawTicks, CATCHUP_CAP_TICKS);
      if (ticks > 0) {
        const st = saved.world.stats();
        catchupRef.current = {
          remaining: ticks,
          total: ticks,
          awayMs,
          capped: rawTicks > CATCHUP_CAP_TICKS,
          before: { pop: st.population, size: st.meanSize },
        };
      }
    } else {
      worldRef.current = new World(defaultGenesis(newSeed()), defaultConfig());
    }
  }

  const posX = useSharedValue<Float32Array>(new Float32Array(CAP));
  const posY = useSharedValue<Float32Array>(new Float32Array(CAP));
  const radius = useSharedValue<Float32Array>(new Float32Array(CAP));
  const hue = useSharedValue<Float32Array>(new Float32Array(CAP));
  const count = useSharedValue(0);
  const clock = useSharedValue(0);

  const [stats, setStats] = useState<SimStats>({
    population: 0,
    tick: 0,
    meanSize: 0,
    meanSpeed: 0,
    food: 0,
    history: [],
  });
  const [catchingUp, setCatchingUp] = useState<boolean>(() => catchupRef.current !== null);
  const [catchupPct, setCatchupPct] = useState(0);
  const [resumeSummary, setResumeSummary] = useState<ResumeSummary | null>(null);

  const pushToBuffers = useCallback(() => {
    const w = worldRef.current!;
    const cs = w.creatures;
    const n = Math.min(cs.length, CAP);
    const bx = posX.value,
      by = posY.value,
      br = radius.value,
      bh = hue.value;
    for (let i = 0; i < n; i++) {
      const c = cs[i];
      bx[i] = c.x;
      by[i] = c.y;
      br[i] = 2 + c.genome.body[Gene.Size] * 3;
      bh[i] = c.genome.body[Gene.Hue];
    }
    posX.value = bx;
    posY.value = by;
    radius.value = br;
    hue.value = bh;
    count.value = n;
    clock.value = frameRef.current++;
  }, [posX, posY, radius, hue, count, clock]);

  const publishStats = useCallback(() => {
    const w = worldRef.current!;
    const cs = w.creatures;
    const n = cs.length || 1;
    let s = 0;
    let sp = 0;
    for (const c of cs) {
      s += c.genome.body[Gene.Size];
      sp += c.genome.body[Gene.Speed];
    }
    const hist = historyRef.current;
    hist.push(cs.length);
    if (hist.length > HISTORY) hist.shift();
    setStats({
      population: cs.length,
      tick: w.tick,
      meanSize: s / n,
      meanSpeed: sp / n,
      food: w.foodCount,
      history: hist.slice(),
    });
  }, []);

  useEffect(() => {
    const loop = (now: number) => {
      const w = worldRef.current!;
      const plan = catchupRef.current;

      if (plan) {
        // Догон: гоним чанк тиков без привязки к реальному dt.
        const chunk = Math.min(CATCHUP_CHUNK, plan.remaining);
        for (let i = 0; i < chunk; i++) w.step();
        plan.remaining -= chunk;
        pushToBuffers();
        setCatchupPct(Math.round((1 - plan.remaining / plan.total) * 100));
        if (plan.remaining <= 0) {
          const st = w.stats();
          setResumeSummary({
            ticks: plan.total,
            awayMinutes: plan.awayMs / 60000,
            capped: plan.capped,
            popBefore: plan.before.pop,
            popAfter: st.population,
            sizeBefore: plan.before.size,
            sizeAfter: st.meanSize,
          });
          catchupRef.current = null;
          setCatchingUp(false);
          lastRef.current = 0; // сброс dt, чтобы SimClock не выстрелил лавиной после догона
          publishStats();
        }
        rafRef.current = requestAnimationFrame(loop);
        return;
      }

      const dt = lastRef.current ? Math.min(now - lastRef.current, 250) : 16;
      lastRef.current = now;
      if (playingRef.current) clockRef.current.advance(w, dt);
      pushToBuffers();

      statAccum.current += dt;
      if (statAccum.current > 250) {
        statAccum.current = 0;
        publishStats();
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [pushToBuffers, publishStats]);

  // Сохранение при уходе в фон: снимок + метка реального времени.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if ((s === 'background' || s === 'inactive') && worldRef.current) {
        saveWorld(worldRef.current, Date.now());
      }
    });
    return () => sub.remove();
  }, []);

  const setParam = (k: keyof WorldConfig, v: number) => {
    worldRef.current!.config[k] = v;
  };

  const inspectAt = useCallback((wx: number, wy: number): Inspected | null => {
    const w = worldRef.current!;
    const { width, height } = w.genesis;
    let best = -1;
    let bd2 = 30 * 30;
    for (let i = 0; i < w.creatures.length; i++) {
      const c = w.creatures[i];
      let dx = Math.abs(c.x - wx);
      let dy = Math.abs(c.y - wy);
      if (dx > width * 0.5) dx = width - dx;
      if (dy > height * 0.5) dy = height - dy;
      const d2 = dx * dx + dy * dy;
      if (d2 < bd2) {
        bd2 = d2;
        best = i;
      }
    }
    if (best < 0) return null;
    const c = w.creatures[best];
    const g = c.genome.body;
    return {
      size: g[Gene.Size],
      speed: g[Gene.Speed],
      vision: g[Gene.VisionRadius],
      metabolism: g[Gene.Metabolism],
      reproThreshold: g[Gene.ReproThreshold],
      mutationRate: g[Gene.MutationRate],
      hue: g[Gene.Hue],
      sexualTendency: g[Gene.SexualTendency],
      energy: c.energy,
      age: c.age,
    };
  }, []);

  return {
    posX,
    posY,
    radius,
    hue,
    count,
    clock,
    worldSize: worldRef.current.genesis.width,
    setSunlight: (v) => setParam('sunlight', v),
    setTemperature: (v) => setParam('temperature', v),
    scheduleIceAge: () => {
      const w = worldRef.current!;
      const base = w.config.sunlight;
      const t = w.tick;
      w.schedule({ startTick: t, endTick: t + 400, param: 'sunlight', fromValue: base, toValue: base * 0.12, easing: 'smooth' });
      w.schedule({ startTick: t + 900, endTick: t + 1400, param: 'sunlight', fromValue: base * 0.12, toValue: base, easing: 'smooth' });
    },
    reset: () => {
      clearWorld();
      catchupRef.current = null;
      setCatchingUp(false);
      setResumeSummary(null);
      worldRef.current = new World(defaultGenesis(newSeed()), defaultConfig());
      historyRef.current = [];
    },
    togglePlay: () => {
      playingRef.current = !playingRef.current;
    },
    inspectAt,
    stats,
    catchingUp,
    catchupPct,
    resumeSummary,
    dismissSummary: () => setResumeSummary(null),
  };
}

/** Сид для нового мира. Math.random() допустим ЗДЕСЬ (rn-слой, не ядро). */
function newSeed(): number {
  return (Math.random() * 1e9) | 0;
}
