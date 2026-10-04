/**
 * Поведение существа — за интерфейсом Brain (см. план §3, пункт 8).
 * Движок дёргает brain.decide(sensors), не зная, что внутри.
 *
 *   RuleBrain — хардкод-правила Фазы 0 (оставлен как эталон/альтернатива).
 *   NeatBrain — Фаза 3+: растущая NEAT-сеть из brainGenome. Движок не менялся —
 *               смена мозга живёт целиком за этим интерфейсом.
 */
import { Network, NUM_INPUTS, Input, type NeatGenome } from './neat.ts';

/** Вход мозга: то, что существо «чувствует» в этот тик. */
export interface Sensors {
  hasFood: boolean;   // есть ли еда в радиусе зрения
  foodDx: number;     // единичный вектор к ближайшей еде (x)
  foodDy: number;     // единичный вектор к ближайшей еде (y)
  energy: number;     // своя энергия (нормализована 0..1 от reproThreshold)
}

/** Выход мозга: желаемое направление движения (единичный вектор). */
export interface Decision {
  dirX: number;
  dirY: number;
}

export interface Brain {
  decide(s: Sensors, rng: () => number): Decision;
}

/**
 * Простое правило: есть еда — плыви к ней; нет — блуждай (случайный дрейф).
 * Никакого обучения. Ровно то, что нужно в Фазе 0.
 */
export class RuleBrain implements Brain {
  // Текущее направление блуждания, чтобы движение было плавным, а не дёрганым.
  // ВАЖНО: это состояние влияет на будущее → должно сериализоваться (иначе
  // догон при resume разойдётся с непрерывной историей).
  wanderX = 0;
  wanderY = 0;

  decide(s: Sensors, rng: () => number): Decision {
    if (s.hasFood) {
      return { dirX: s.foodDx, dirY: s.foodDy };
    }
    // Блуждание: слегка поворачиваем текущее направление случайным образом.
    const angle = (rng() - 0.5) * 0.6;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    let nx = this.wanderX * cos - this.wanderY * sin;
    let ny = this.wanderX * sin + this.wanderY * cos;
    const len = Math.hypot(nx, ny);
    if (len < 1e-6) {
      // Инициализация направления при первом блуждании.
      const a = rng() * Math.PI * 2;
      nx = Math.cos(a);
      ny = Math.sin(a);
    } else {
      nx /= len;
      ny /= len;
    }
    this.wanderX = nx;
    this.wanderY = ny;
    return { dirX: nx, dirY: ny };
  }
}

/**
 * Мозг на NEAT-сети. Компилирует геном в сеть один раз (геном за жизнь особи не
 * меняется) и каждый тик считает направление по сенсорам + шуму.
 *
 * Шум (NoiseX/NoiseY) берётся из ЕДИНСТВЕННОГО источника случайности — сидированного
 * rng движка, ровно 2 выборки на тик. Так поведение остаётся детерминированным:
 * один сид → идентичная история (нужно для догона при resume).
 *
 * Состояния между тиками NeatBrain не хранит (feed-forward) → сериализовать нечего
 * кроме самого генома (в отличие от wander у RuleBrain).
 */
export class NeatBrain implements Brain {
  private readonly net: Network;
  private readonly inputs = new Float64Array(NUM_INPUTS);

  constructor(genome: NeatGenome) {
    this.net = new Network(genome);
  }

  decide(s: Sensors, rng: () => number): Decision {
    const inp = this.inputs;
    inp[Input.Bias] = 1;
    inp[Input.FoodDx] = s.hasFood ? s.foodDx : 0;
    inp[Input.FoodDy] = s.hasFood ? s.foodDy : 0;
    inp[Input.HasFood] = s.hasFood ? 1 : 0;
    inp[Input.Energy] = s.energy;
    inp[Input.NoiseX] = rng() * 2 - 1;
    inp[Input.NoiseY] = rng() * 2 - 1;

    const [ox, oy] = this.net.eval(inp);
    const len = Math.hypot(ox, oy);
    if (len < 1e-6) return { dirX: 0, dirY: 0 };
    return { dirX: ox / len, dirY: oy / len };
  }
}
