/**
 * Ядро симуляции. Чистый TS, без единого импорта из RN/Skia (см. план §3).
 * Фиксированный timestep, детерминизм от (seed + genesis + timeline).
 *
 * Травоядные, бесполое размножение. Поведение — NeatBrain (растущая NEAT-сеть);
 * движок про NEAT ничего не знает, дёргает brain.decide за интерфейсом Brain.
 */
import { PRNG } from './prng.ts';
import { Gene, randomGenome, mutate } from './genome.ts';
import type { Genome } from './genome.ts';
import { NeatBrain } from './brain.ts';
import type { Brain, Sensors } from './brain.ts';
import { NeatContext } from './neat.ts';
import { SpatialGrid } from './grid.ts';
import type { WorldGenesis, WorldConfig, TimelineEvent, Easing } from './types.ts';

/** Существо. Массивы-параллельные поля можно ввести позже ради перф; пока — объекты. */
export interface Creature {
  x: number;
  y: number;
  energy: number;
  age: number;
  genome: Genome;
  brain: Brain;
}

/** Снимок статистики за тик — для тестов и графиков. */
export interface Stats {
  tick: number;
  population: number;
  foodCount: number;
  meanSize: number;
  meanSpeed: number;
  meanVision: number;
  meanReproThreshold: number;
  meanMutationRate: number;
  meanEnergy: number;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

export class World {
  readonly genesis: WorldGenesis;
  config: WorldConfig;              // живой, тик читает каждый кадр
  private rng: PRNG;
  private grid: SpatialGrid;
  // Реестр инноваций NEAT — per-world (детерминизм: не глобальный модульный счётчик).
  neat: NeatContext;

  creatures: Creature[] = [];
  // Еда — параллельные массивы координат (дёшево и grid-friendly).
  foodX: Float32Array;
  foodY: Float32Array;
  foodCount = 0;

  tick = 0;
  private timeline: TimelineEvent[] = [];

  constructor(genesis: WorldGenesis, config: WorldConfig) {
    this.genesis = genesis;
    this.config = { ...config };
    this.rng = new PRNG(genesis.seed);
    this.grid = new SpatialGrid(genesis.width, genesis.height, genesis.cellSize);
    this.neat = new NeatContext();
    this.foodX = new Float32Array(genesis.maxFood);
    this.foodY = new Float32Array(genesis.maxFood);

    // Стартовая популяция.
    for (let i = 0; i < genesis.startPopulation; i++) {
      const g = randomGenome(this.rng);
      this.creatures.push({
        x: this.rng.range(0, genesis.width),
        y: this.rng.range(0, genesis.height),
        energy: g.body[Gene.ReproThreshold] * 0.5,
        age: 0,
        genome: g,
        brain: new NeatBrain(g.brain),
      });
    }
    // Немного стартовой еды, чтобы первое поколение не вымерло сразу.
    const seedFood = Math.min(genesis.maxFood, Math.floor(genesis.maxFood * 0.5));
    for (let i = 0; i < seedFood; i++) this.spawnFood();
  }

  /** Планирование события/катаклизма (см. план §5). */
  schedule(ev: TimelineEvent): void {
    this.timeline.push(ev);
  }

  /** Мгновенная реактивная правка «сейчас» = событие с нулевой длительностью. */
  setParamNow(param: keyof WorldConfig, value: number): void {
    this.schedule({
      startTick: this.tick,
      endTick: this.tick,
      param,
      fromValue: this.config[param],
      toValue: value,
      easing: 'linear',
    });
  }

  private ease(kind: Easing, t: number): number {
    return kind === 'smooth' ? smoothstep(t) : t;
  }

  /** Применяем все события таймлайна, активные на текущем тике. */
  private applyTimeline(): void {
    for (const ev of this.timeline) {
      if (this.tick < ev.startTick) continue;
      if (ev.startTick === ev.endTick) {
        if (this.tick === ev.startTick && !ev.applied) {
          (this.config[ev.param] as number) = ev.toValue;
          ev.applied = true;
        }
        continue;
      }
      if (this.tick > ev.endTick) {
        (this.config[ev.param] as number) = ev.toValue;
        continue;
      }
      const t = (this.tick - ev.startTick) / (ev.endTick - ev.startTick);
      const e = this.ease(ev.easing, t);
      (this.config[ev.param] as number) =
        ev.fromValue + (ev.toValue - ev.fromValue) * e;
    }
  }

  private spawnFood(): void {
    if (this.foodCount >= this.genesis.maxFood) return;
    this.foodX[this.foodCount] = this.rng.range(0, this.genesis.width);
    this.foodY[this.foodCount] = this.rng.range(0, this.genesis.height);
    this.foodCount++;
  }

  private removeFood(i: number): void {
    // swap-remove: детерминированно, т.к. порядок обработки фиксирован.
    this.foodCount--;
    this.foodX[i] = this.foodX[this.foodCount];
    this.foodY[i] = this.foodY[this.foodCount];
  }

  private wrap(v: number, max: number): number {
    if (v < 0) return v + max;
    if (v >= max) return v - max;
    return v;
  }

  /** Один шаг симуляции. Фиксированный timestep. */
  step(): void {
    this.applyTimeline();
    const cfg = this.config;
    const { width, height } = this.genesis;

    // 1. Спавн еды по «солнцу». Дробную часть добираем вероятностно.
    let spawn = cfg.sunlight;
    while (spawn >= 1) {
      this.spawnFood();
      spawn -= 1;
    }
    if (this.rng.next() < spawn) this.spawnFood();

    // 2. Индексируем еду в grid для поиска ближайшей.
    this.grid.clear();
    for (let i = 0; i < this.foodCount; i++) {
      this.grid.insert(i, this.foodX[i], this.foodY[i]);
    }

    // 3. Обработка существ. Новорождённые копятся отдельно и добавляются в конце
    //    — стабильный детерминированный порядок.
    const newborns: Creature[] = [];
    let alive = 0;

    for (let ci = 0; ci < this.creatures.length; ci++) {
      const c = this.creatures[ci];
      const size = c.genome.body[Gene.Size];
      const speed = c.genome.body[Gene.Speed];
      const vision = c.genome.body[Gene.VisionRadius];
      const metab = c.genome.body[Gene.Metabolism];
      const reproT = c.genome.body[Gene.ReproThreshold];

      // Сенсоры: ближайшая еда.
      const nf = this.grid.nearest(c.x, c.y, vision, this.foodX, this.foodY);
      let sensors: Sensors;
      if (nf >= 0) {
        let dx = this.foodX[nf] - c.x;
        let dy = this.foodY[nf] - c.y;
        // Тороидальная коррекция направления.
        if (dx > width * 0.5) dx -= width;
        else if (dx < -width * 0.5) dx += width;
        if (dy > height * 0.5) dy -= height;
        else if (dy < -height * 0.5) dy += height;
        const len = Math.hypot(dx, dy) || 1;
        sensors = { hasFood: true, foodDx: dx / len, foodDy: dy / len, energy: c.energy / reproT };
      } else {
        sensors = { hasFood: false, foodDx: 0, foodDy: 0, energy: c.energy / reproT };
      }

      // Решение мозга.
      const d = c.brain.decide(sensors, () => this.rng.next());

      // Движение: шаг = speed. Крупные плывут так же быстро, но дороже (ниже).
      const step = speed;
      c.x = this.wrap(c.x + d.dirX * step, width);
      c.y = this.wrap(c.y + d.dirY * step, height);

      // Расход энергии: базовый (∝ size·metab·temp) + движение (∝ speed²·size).
      const restCost = cfg.baseCost * size * metab * cfg.temperature;
      const moveCost = cfg.moveCost * speed * speed * size;
      c.energy -= restCost + moveCost;
      c.age++;

      // Еда: если дошёл до ближайшей — съедает.
      if (nf >= 0) {
        const eatDist = size * 3 + 2;
        let dx = this.foodX[nf] - c.x;
        let dy = this.foodY[nf] - c.y;
        if (dx > width * 0.5) dx -= width; else if (dx < -width * 0.5) dx += width;
        if (dy > height * 0.5) dy -= height; else if (dy < -height * 0.5) dy += height;
        if (dx * dx + dy * dy <= eatDist * eatDist) {
          c.energy += cfg.foodEnergy * cfg.nutrition;
          this.removeFood(nf);
        }
      }

      // Смерть.
      if (c.energy <= 0) {
        continue; // не переносим в живые
      }

      // Размножение (бесполое): накопил порог → делится пополам с мутацией.
      if (c.energy >= reproT) {
        const childEnergy = c.energy * 0.5;
        c.energy -= childEnergy;
        const childGenome = mutate(c.genome, this.rng, this.neat);
        newborns.push({
          x: this.wrap(c.x + this.rng.range(-2, 2), width),
          y: this.wrap(c.y + this.rng.range(-2, 2), height),
          energy: childEnergy,
          age: 0,
          genome: childGenome,
          brain: new NeatBrain(childGenome.brain),
        });
      }

      // Компакция живых на месте.
      this.creatures[alive++] = c;
    }

    this.creatures.length = alive;
    for (let i = 0; i < newborns.length; i++) this.creatures.push(newborns[i]);

    this.tick++;
  }

  /** Снимок статистики (для тестов и графиков). */
  stats(): Stats {
    const n = this.creatures.length;
    let sSize = 0, sSpeed = 0, sVision = 0, sRepro = 0, sMut = 0, sEnergy = 0;
    for (const c of this.creatures) {
      sSize += c.genome.body[Gene.Size];
      sSpeed += c.genome.body[Gene.Speed];
      sVision += c.genome.body[Gene.VisionRadius];
      sRepro += c.genome.body[Gene.ReproThreshold];
      sMut += c.genome.body[Gene.MutationRate];
      sEnergy += c.energy;
    }
    const d = n || 1;
    return {
      tick: this.tick,
      population: n,
      foodCount: this.foodCount,
      meanSize: sSize / d,
      meanSpeed: sSpeed / d,
      meanVision: sVision / d,
      meanReproThreshold: sRepro / d,
      meanMutationRate: sMut / d,
      meanEnergy: sEnergy / d,
    };
  }

  /** Хэш состояния для теста детерминизма (побайтно идентичная история). */
  hash(): number {
    let h = 2166136261 >>> 0; // FNV-1a
    const mix = (x: number) => {
      // Квантуем float, чтобы хэш был устойчив, но чувствителен к расхождениям.
      const q = Math.round(x * 1000);
      h ^= q & 0xffffffff;
      h = Math.imul(h, 16777619) >>> 0;
    };
    mix(this.tick);
    mix(this.creatures.length);
    mix(this.foodCount);
    for (const c of this.creatures) {
      mix(c.x); mix(c.y); mix(c.energy);
      for (let i = 0; i < c.genome.body.length; i++) mix(c.genome.body[i]);
      // Мозг тоже влияет на будущее → в хэш (иначе тест детерминизма его не покрывает).
      const br = c.genome.brain;
      mix(br.nodes.length);
      for (const conn of br.connections) {
        mix(conn.inNode); mix(conn.outNode); mix(conn.weight);
        mix(conn.enabled ? 1 : 0); mix(conn.innovation);
      }
    }
    return h >>> 0;
  }
}
