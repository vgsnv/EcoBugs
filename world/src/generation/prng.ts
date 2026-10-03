/**
 * Детерминированная случайность. Вся случайность мира берётся из сида
 * (спецификация, раздел «Мир»), поэтому Math.random в ядре запрещён.
 */

/** Перемешивание 32-битного числа (splitmix32): хороший разброс даже для соседних входов. */
export function mix32(x: number): number {
  x = (x + 0x9e3779b9) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

/** FNV-1a по строке — для именованных потоков. */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Сид независимого потока случайности с именем `label`.
 * У каждой части мира свой поток: добавление новой части не сдвигает остальные.
 */
export function deriveSeed(seed: number, label: string): number {
  return mix32((seed >>> 0) ^ hashString(label));
}

/** Хеш целочисленных координат — для шума без таблиц. */
export function hash3(seed: number, a: number, b: number, c = 0): number {
  let h = mix32(seed ^ Math.imul(a | 0, 0x27d4eb2d));
  h = mix32(h ^ Math.imul(b | 0, 0x165667b1));
  return mix32(h ^ Math.imul(c | 0, 0x1b873593));
}

/** Генератор mulberry32: быстрый, 32 бита состояния, воспроизводимый. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Равномерно в [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Равномерно в [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Целое в [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Состояние для сохранения и восстановления. */
  getState(): number {
    return this.state >>> 0;
  }

  setState(state: number): void {
    this.state = state >>> 0;
  }
}
