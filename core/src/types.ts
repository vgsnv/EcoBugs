/**
 * Два класса параметров мира (см. PLAN.md §5) + событие таймлайна.
 *
 *   WorldGenesis — параметры творения. Иммутабельны: меняются только пересозданием мира.
 *   WorldConfig  — живые параметры среды. Тик читает их каждый кадр.
 *   TimelineEvent — единый механизм и реактивных правок, и запланированных катаклизмов.
 */

/** Иммутабельные параметры творения. Задаются один раз при создании мира. */
export interface WorldGenesis {
  seed: number;          // сид PRNG — фундамент детерминизма
  width: number;         // ширина тороидального мира
  height: number;        // высота
  cellSize: number;      // размер ячейки пространственной сетки
  maxFood: number;       // потолок единиц еды
  startPopulation: number; // стартовое число существ
}

/** Живые параметры среды. Все — числовые, тик читает актуальные значения. */
export interface WorldConfig {
  sunlight: number;    // приток энергии в мир = скорость спавна еды (главный рычаг)
  foodEnergy: number;  // энергия одной единицы еды
  nutrition: number;   // множитель питательности
  baseCost: number;    // базовый расход энергии в покое
  moveCost: number;    // множитель расхода на движение (∝ speed²)
  temperature: number; // влияет на метаболизм
}

/** Тип интерполяции огибающей катаклизма. */
export type Easing = 'linear' | 'smooth';

/**
 * Событие таймлайна (см. PLAN.md §5). Огибающая, НЕ ступенька: параметр плавно
 * едет от fromValue к toValue за [startTick, endTick]. Событие в прошлом = правка
 * «сейчас»; событие в будущем = запланированный катаклизм.
 */
export interface TimelineEvent {
  startTick: number;
  endTick: number;
  param: keyof WorldConfig;
  fromValue: number;
  toValue: number;
  easing: Easing;
  applied?: boolean; // служебный флаг для мгновенных событий (startTick === endTick)
}
