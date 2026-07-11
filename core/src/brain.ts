/**
 * Поведение существа — за интерфейсом Brain (см. план §3, пункт 8).
 * Движок дёргает brain.decide(sensors), не зная, что внутри.
 *
 *   RuleBrain — хардкод-правила, Фаза 0. Поведение ФИКСИРОВАНО, чтобы
 *               изолированно балансировать экономику энергии.
 *   NeatBrain — позже: растущая нейросеть из brainGenome. Не переписывая ядро.
 */

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
