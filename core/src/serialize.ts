/**
 * Сериализация полного состояния мира (см. план §3, пункт 7; §6 — догон).
 * Заложено в Фазе 0, хотя реально используется в Фазе 3, чтобы формат уже
 * умел писать ОБА поля генома (body + brain) и не переделывался под NEAT.
 *
 * Детерминизм догона держится на том, что мы сохраняем ВСЁ, что влияет на
 * будущее: состояние PRNG, тик, конфиг, таймлайн, все существа и еду.
 */
import { World } from './world.ts';
import type { Creature } from './world.ts';
import type { WorldGenesis, WorldConfig, TimelineEvent } from './types.ts';
import { emptyBrainGenome } from './genome.ts';
import { RuleBrain } from './brain.ts';
import { PRNG } from './prng.ts';

export interface CreatureSnapshot {
  x: number;
  y: number;
  energy: number;
  age: number;
  body: number[];
  brain: { nodes: number; connections: number }; // brainGenome — пуст в Ф0
  wander: [number, number];                       // состояние RuleBrain
}

export interface WorldSnapshot {
  version: 1;
  genesis: WorldGenesis;
  config: WorldConfig;
  tick: number;
  rngState: number;
  timeline: TimelineEvent[];
  creatures: CreatureSnapshot[];
  food: { x: number; y: number }[];
}

/** World → простой JSON-совместимый объект (для MMKV). */
export function snapshot(w: World): WorldSnapshot {
  const creatures: CreatureSnapshot[] = w.creatures.map((c) => {
    const rb = c.brain as RuleBrain;
    return {
      x: c.x, y: c.y, energy: c.energy, age: c.age,
      body: Array.from(c.genome.body),
      brain: { nodes: c.genome.brain.nodes, connections: c.genome.brain.connections },
      wander: [rb.wanderX ?? 0, rb.wanderY ?? 0] as [number, number],
    };
  });
  const food: { x: number; y: number }[] = [];
  for (let i = 0; i < w.foodCount; i++) food.push({ x: w.foodX[i], y: w.foodY[i] });

  return {
    version: 1,
    genesis: w.genesis,
    config: { ...w.config },
    tick: w.tick,
    rngState: (w as any).rng.getState(),
    timeline: (w as any).timeline.map((e: TimelineEvent) => ({ ...e })),
    creatures,
    food,
  };
}

/** Обратно: снимок → живой World, готовый продолжать/догонять. */
export function restore(snap: WorldSnapshot): World {
  const w = new World(snap.genesis, snap.config);
  // Перезаписываем всё, что конструктор сгенерировал заново.
  (w as any).rng = PRNG.fromState(snap.rngState);
  w.tick = snap.tick;
  (w as any).timeline = snap.timeline.map((e) => ({ ...e }));

  w.creatures = snap.creatures.map((cs): Creature => {
    const brain = new RuleBrain();
    brain.wanderX = cs.wander[0];
    brain.wanderY = cs.wander[1];
    return {
      x: cs.x, y: cs.y, energy: cs.energy, age: cs.age,
      genome: { body: Float32Array.from(cs.body), brain: emptyBrainGenome() },
      brain,
    };
  });

  w.foodCount = snap.food.length;
  for (let i = 0; i < snap.food.length; i++) {
    w.foodX[i] = snap.food[i].x;
    w.foodY[i] = snap.food[i].y;
  }
  return w;
}
