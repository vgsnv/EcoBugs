/**
 * Мост «движок → React Native». Фазы 1–2.
 *
 * Архитектура (CLAUDE.md, инварианты 3–4):
 *  - World живёт в useRef, НЕ в React-стейте: setState на каждый тик убил бы перф.
 *  - Симуляция идёт фиксированным timestep через SimClock, отвязанно от FPS.
 *  - Позиции/цвет пишутся в Reanimated SharedValue-буферы → читаются на UI-потоке Skia.
 *  - `clock` инкрементируется каждый кадр: гарантированный триггер перерисовки Skia,
 *    даже когда ссылка на Float32Array-буфер не меняется.
 *
 * Ядро (core/src) отсюда НЕ меняется — импортируем только публичный API.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { useSharedValue, type SharedValue } from 'react-native-reanimated';
import { World, SimClock, defaultGenesis, defaultConfig, Gene } from '../src/index.ts';
import type { WorldConfig } from '../src/index.ts';

const CAP = 3000; // потолок существ в буфере рендера (миры устаканиваются < 2000)
const HISTORY = 120; // длина истории популяции для спарклайна

/** Снимок особи для инспектора (по тапу). */
export interface Inspected {
  size: number;
  speed: number;
  vision: number;
  metabolism: number;
  reproThreshold: number;
  mutationRate: number;
  hue: number;
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
}

export function useSimulation(): SimHandle {
  const worldRef = useRef<World | null>(null);
  const clockRef = useRef(new SimClock(30));
  const playingRef = useRef(true);
  const rafRef = useRef<number | null>(null);
  const lastRef = useRef(0);
  const frameRef = useRef(0);
  const historyRef = useRef<number[]>([]);
  const statAccum = useRef(0);

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

  if (worldRef.current === null) {
    worldRef.current = new World(defaultGenesis(newSeed()), defaultConfig());
  }

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
    clock.value = frameRef.current++; // форсируем перерисовку Skia
  }, [posX, posY, radius, hue, count, clock]);

  useEffect(() => {
    const loop = (now: number) => {
      const dt = lastRef.current ? Math.min(now - lastRef.current, 250) : 16;
      lastRef.current = now;
      const w = worldRef.current!;
      if (playingRef.current) clockRef.current.advance(w, dt);
      pushToBuffers();

      statAccum.current += dt;
      if (statAccum.current > 250) {
        statAccum.current = 0;
        const cs = w.creatures;
        const n = cs.length || 1;
        let s = 0,
          sp = 0;
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
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [pushToBuffers]);

  const setParam = (k: keyof WorldConfig, v: number) => {
    worldRef.current!.config[k] = v;
  };

  const inspectAt = useCallback((wx: number, wy: number): Inspected | null => {
    const w = worldRef.current!;
    const { width, height } = w.genesis;
    let best = -1;
    let bd2 = 30 * 30; // радиус попадания в мировых единицах
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
      worldRef.current = new World(defaultGenesis(newSeed()), defaultConfig());
      historyRef.current = [];
    },
    togglePlay: () => {
      playingRef.current = !playingRef.current;
    },
    inspectAt,
    stats,
  };
}

/** Сид для нового мира. Math.random() допустим ЗДЕСЬ (rn-слой, не ядро). */
function newSeed(): number {
  return (Math.random() * 1e9) | 0;
}
