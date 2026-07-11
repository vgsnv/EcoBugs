/**
 * Сидированный PRNG (mulberry32) — фундамент детерминизма (см. CLAUDE.md, инвариант 1).
 * Один сид → побайтно идентичная история. На этом держатся перемотка и догон.
 *
 * ⛔ Нигде в core/src нельзя вызывать Math.random(). Вся случайность — отсюда.
 *
 * Состояние генератора — единственное число `s` (uint32). Поэтому снимок/восстановление
 * тривиальны: getState() возвращает `s`, fromState(s) поднимает генератор ровно с него.
 */
export class PRNG {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0;
  }

  /** Следующее псевдослучайное в [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Равномерно в [a, b). */
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }

  /** Стандартное нормальное (Box–Muller). Клампим u от нуля, чтобы log не улетел. */
  gaussian(): number {
    let u = this.next();
    if (u < 1e-12) u = 1e-12;
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
  }

  /** Текущее состояние — для сериализации. */
  getState(): number {
    return this.s;
  }

  /**
   * Восстановление из состояния. Т.к. всё состояние mulberry32 — это `s`,
   * поднять генератор = сконструировать его с этим же числом.
   */
  static fromState(state: number): PRNG {
    return new PRNG(state >>> 0);
  }
}
