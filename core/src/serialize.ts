/**
 * Сериализация полного состояния мира (PLAN.md §3 п.7, §6 — догон при resume).
 *
 * Детерминизм догона держится на том, что сохраняем ВСЁ, что влияет на будущее:
 * состояние PRNG, тик, конфиг, таймлайн, существа с ПОЛНЫМ геномом мозга (NEAT-сеть)
 * и счётчики NeatContext (следующие id узла/инновации). Без счётчиков мутации после
 * restore проставляли бы другие innovation-номера и мир разошёлся бы.
 *
 * NeatBrain состояния между тиками не хранит (feed-forward) — сериализовать нужно
 * только сам геном, в отличие от wander у прежнего RuleBrain.
 */
import { World } from './world.ts';
import type { Creature } from './world.ts';
import type { WorldGenesis, WorldConfig, TimelineEvent } from './types.ts';
import type { BrainGenome } from './genome.ts';
import { NeatBrain } from './brain.ts';
import { NeatContext, type NodeGene, type ConnGene } from './neat.ts';
import { PRNG } from './prng.ts';

export interface CreatureSnapshot {
  x: number;
  y: number;
  energy: number;
  age: number;
  body: number[];
  brain: BrainGenome; // полная NEAT-сеть (nodes[] + connections[])
}

export interface WorldSnapshot {
  version: 3;
  genesis: WorldGenesis;
  config: WorldConfig;
  tick: number;
  rngState: number;
  neat: { nextNodeId: number; nextInnovation: number };
  timeline: TimelineEvent[];
  creatures: CreatureSnapshot[];
  food: { x: number; y: number }[];
}

function cloneBrain(b: BrainGenome): BrainGenome {
  return {
    nodes: b.nodes.map((n): NodeGene => ({ id: n.id, type: n.type })),
    connections: b.connections.map(
      (c): ConnGene => ({
        inNode: c.inNode,
        outNode: c.outNode,
        weight: c.weight,
        enabled: c.enabled,
        innovation: c.innovation,
      }),
    ),
  };
}

/** World → простой JSON-совместимый объект (для MMKV). */
export function snapshot(w: World): WorldSnapshot {
  const creatures: CreatureSnapshot[] = w.creatures.map((c) => ({
    x: c.x,
    y: c.y,
    energy: c.energy,
    age: c.age,
    body: Array.from(c.genome.body),
    brain: cloneBrain(c.genome.brain),
  }));
  const food: { x: number; y: number }[] = [];
  for (let i = 0; i < w.foodCount; i++) food.push({ x: w.foodX[i], y: w.foodY[i] });

  return {
    version: 3,
    genesis: w.genesis,
    config: { ...w.config },
    tick: w.tick,
    rngState: (w as any).rng.getState(),
    neat: { nextNodeId: w.neat.nextNodeId, nextInnovation: w.neat.nextInnovation },
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
  w.neat = new NeatContext(snap.neat.nextNodeId, snap.neat.nextInnovation);
  w.tick = snap.tick;
  (w as any).timeline = snap.timeline.map((e) => ({ ...e }));
  // Продолжаем счётчик id катаклизмов с максимума в таймлайне — чтобы новые
  // события планировщика не столкнулись по id с восстановленными.
  let maxId = 0;
  for (const e of snap.timeline) if (e.id && e.id > maxId) maxId = e.id;
  w.nextEventId = maxId + 1;

  w.creatures = snap.creatures.map((cs): Creature => {
    const brain = cloneBrain(cs.brain);
    return {
      x: cs.x,
      y: cs.y,
      energy: cs.energy,
      age: cs.age,
      genome: { body: Float32Array.from(cs.body), brain },
      brain: new NeatBrain(brain),
    };
  });

  w.foodCount = snap.food.length;
  for (let i = 0; i < snap.food.length; i++) {
    w.foodX[i] = snap.food[i].x;
    w.foodY[i] = snap.food[i].y;
  }
  return w;
}
