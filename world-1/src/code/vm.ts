/**
 * «Код как вещество» — по образцу Tierra, на карте. Суп — кольцо ячеек, в каждой
 * одна команда; на квадрат он уложен кривой Гильберта, поэтому соседние в памяти
 * ячейки соседствуют и на карте. Организм — участок супа и свой процессор
 * (регистры ax–dx, стек, указатель команды). Читать и исполнять можно любой код,
 * писать — только в себя и в свою дочь. Мёртвый код остаётся в супе.
 *
 * Свет — время процессора: организм на свету исполняет больше команд за ход.
 * Когда память заполнена, жнец убирает старых и ошибающихся. Мутации — ошибки
 * копирования и редкие случайные замены в супе. Ни одно умение, кроме
 * самокопирования предка, не задано.
 */

export const OPS = ['nop0', 'nop1', 'not0', 'shl', 'zero', 'ifz', 'subCAB', 'subAAC', 'incA', 'incB', 'decC', 'incC',
  'pushA', 'pushB', 'pushC', 'pushD', 'popA', 'popB', 'popC', 'popD', 'jmp', 'jmpb', 'call', 'ret', 'movDC', 'movBA',
  'movii', 'adr', 'adrb', 'adrf', 'mal', 'divide'] as const;
const op = Object.fromEntries(OPS.map((n, i) => [n, i])) as Record<typeof OPS[number], number>;
const NOP1 = 1;

export const LAWS = {
  /** Команд за ход на единицу света (свет 0…1). */
  slice: 40,
  /** Свет в тени. */
  shade: 0.08,
  /** Вероятность ошибки при копировании команды. */
  copyError: 1 / 1500,
  /** Случайных замен в супе за ход на всю память. */
  cosmic: 0.05,
  /** Жнец включается, когда свободно меньше этой доли памяти. */
  reapAt: 0.2,
  /** Вес ошибки в очереди жнеца (в ходах возраста). */
  errorWeight: 30,
  /** Пределы размера дочери и даль поиска метки. */
  minSize: 10, maxSize: 600, searchLimit: 1500,
};

export interface Genotype { key: string; size: number; count: number; maxCount: number; born: number; parent: string }

export interface Organism {
  id: number; start: number; size: number;
  ip: number; ax: number; bx: number; cx: number; dx: number; stack: Int32Array; sp: number;
  dStart: number; dSize: number;
  born: number; errors: number; births: number;
  /** Исполнено команд всего, из них — в чужом живом коде и в ничьём (мёртвом). */
  executed: number; foreign: number; junk: number;
  genotype: Genotype;
}

export interface Soup {
  side: number; size: number; tick: number;
  code: Uint8Array; owner: Int32Array;
  /** Ячейка супа → место на карте (кривая Гильберта) и обратно. */
  toMap: Int32Array; fromMap: Int32Array;
  light: Float32Array;
  orgs: Organism[]; byId: Map<number, Organism>; nextId: number; free: number;
  genotypes: Map<string, Genotype>;
  spots: { x: number; y: number; vx: number; vy: number; r: number }[];
  rand: () => number;
  stats: { births: number; deaths: number; executed: number; copyErrors: number };
}

export function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Предок (как 0080aaa в Tierra): находит свои начало и конец по меткам, выделяет память, копирует себя, отделяет дочь. */
const ANCESTOR_SOURCE = `
nop1 nop1 nop1 nop1
zero not0 shl shl movDC
adrb nop0 nop0 nop0 nop0
subAAC movBA
adrf nop0 nop0 nop0 nop1
incA subCAB
nop1 nop1 nop0 nop1
mal
call nop0 nop0 nop1 nop1
divide
jmpb nop0 nop0 nop1 nop0
ifz
nop1 nop1 nop0 nop0
pushA pushB pushC
nop1 nop0 nop1 nop0
movii decC ifz
jmp nop0 nop1 nop0 nop0
incA incB
jmpb nop0 nop1 nop0 nop1
ifz
nop1 nop0 nop1 nop1
popC popB popA ret
nop1 nop1 nop1 nop0
ifz`;
export const ANCESTOR = ANCESTOR_SOURCE.trim().split(/\s+/).map((n) => { const i = op[n as typeof OPS[number]]; if (i === undefined) throw Error(n); return i; });

/** Кривая Гильберта: номер вдоль кривой → (x, y) в квадрате side × side. */
function hilbert(side: number, d: number): [number, number] {
  let x = 0, y = 0, t = d;
  for (let s = 1; s < side; s *= 2) {
    const rx = 1 & (t >> 1), ry = 1 & (t ^ rx);
    if (ry === 0) { if (rx === 1) { x = s - 1 - x; y = s - 1 - y; } const tmp = x; x = y; y = tmp; }
    x += s * rx; y += s * ry; t >>= 2;
  }
  return [x, y];
}

export function createSoup(seed: number, side = 256): Soup {
  const size = side * side, rand = mulberry(seed);
  const soup: Soup = {
    side, size, tick: 0,
    code: new Uint8Array(size), owner: new Int32Array(size),
    toMap: new Int32Array(size), fromMap: new Int32Array(size), light: new Float32Array(size),
    orgs: [], byId: new Map(), nextId: 1, free: size,
    genotypes: new Map(), spots: [], rand,
    stats: { births: 0, deaths: 0, executed: 0, copyErrors: 0 },
  };
  for (let d = 0; d < size; d++) { const [x, y] = hilbert(side, d); soup.toMap[d] = y * side + x; soup.fromMap[y * side + x] = d; }
  for (let k = 0; k < 4; k++) {
    const a = rand() * Math.PI * 2, v = 0.02 + rand() * 0.03;
    soup.spots.push({ x: rand() * side, y: rand() * side, vx: Math.cos(a) * v, vy: Math.sin(a) * v, r: 30 + rand() * 30 });
  }
  updateLight(soup);
  // Пустой суп — случайный мусор не нужен: нули (nop0). Предок — в середине самого светлого пятна.
  const s = soup.spots[0], at = soup.fromMap[Math.floor(s.y) * side + Math.floor(s.x)];
  const start = Math.max(0, Math.min(size - ANCESTOR.length, at));
  for (let i = 0; i < ANCESTOR.length; i++) soup.code[start + i] = ANCESTOR[i];
  birth(soup, start, ANCESTOR.length, null);
  return soup;
}

function updateLight(soup: Soup): void {
  const { side, light, toMap } = soup;
  for (const s of soup.spots) {
    s.x += s.vx * 10; s.y += s.vy * 10;
    if (s.x < 0 || s.x > side) s.vx = -s.vx;
    if (s.y < 0 || s.y > side) s.vy = -s.vy;
  }
  const map = new Float32Array(side * side);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    let v = LAWS.shade;
    for (const s of soup.spots) { const d2 = ((x - s.x) ** 2 + (y - s.y) ** 2) / (s.r * s.r); if (d2 < 1) v += (1 - d2) * (1 - d2) * 1.5; }
    map[y * side + x] = Math.min(1, v);
  }
  for (let d = 0; d < soup.size; d++) light[d] = map[toMap[d]];
}

const wrap = (soup: Soup, a: number) => ((a % soup.size) + soup.size) % soup.size;

function genotypeOf(soup: Soup, start: number, size: number, parent: string): Genotype {
  let key = '';
  for (let i = 0; i < size; i++) key += String.fromCharCode(65 + soup.code[wrap(soup, start + i)]);
  let g = soup.genotypes.get(key);
  if (!g) { g = { key, size, count: 0, maxCount: 0, born: soup.tick, parent }; soup.genotypes.set(key, g); }
  return g;
}

function birth(soup: Soup, start: number, size: number, mother: Organism | null): Organism {
  const g = genotypeOf(soup, start, size, mother?.genotype.key ?? '');
  g.count++; g.maxCount = Math.max(g.maxCount, g.count);
  const o: Organism = {
    id: soup.nextId++, start, size, ip: start, ax: 0, bx: 0, cx: 0, dx: 0, stack: new Int32Array(10), sp: 0,
    dStart: -1, dSize: 0, born: soup.tick, errors: 0, births: 0, executed: 0, foreign: 0, junk: 0, genotype: g,
  };
  for (let i = 0; i < size; i++) soup.owner[wrap(soup, start + i)] = o.id;
  soup.free -= size;
  soup.orgs.push(o); soup.byId.set(o.id, o);
  return o;
}

function kill(soup: Soup, o: Organism): void {
  for (let i = 0; i < o.size; i++) { const a = wrap(soup, o.start + i); if (soup.owner[a] === o.id) soup.owner[a] = 0; }
  soup.free += o.size;
  freeDaughter(soup, o);
  o.genotype.count--;
  if (o.genotype.count === 0 && o.genotype.maxCount < 2) soup.genotypes.delete(o.genotype.key);
  soup.byId.delete(o.id);
  const k = soup.orgs.indexOf(o); soup.orgs[k] = soup.orgs[soup.orgs.length - 1]; soup.orgs.pop();
  soup.stats.deaths++;
}

function freeDaughter(soup: Soup, o: Organism): void {
  if (o.dStart < 0) return;
  for (let i = 0; i < o.dSize; i++) { const a = wrap(soup, o.dStart + i); if (soup.owner[a] === -o.id) soup.owner[a] = 0; }
  soup.free += o.dSize;
  o.dStart = -1; o.dSize = 0;
}

/** Жнец: убрать организм с самым большим «возраст + вес × ошибки». */
function reap(soup: Soup, spare: Organism): boolean {
  let worst: Organism | null = null, score = -Infinity;
  for (const o of soup.orgs) {
    if (o === spare) continue;
    const s = soup.tick - o.born + LAWS.errorWeight * o.errors;
    if (s > score) { score = s; worst = o; }
  }
  if (!worst) return false;
  kill(soup, worst);
  return true;
}

/** Метка — подряд идущие nop после команды (не длиннее 8). */
function templateAt(soup: Soup, a: number): number[] {
  const t: number[] = [];
  for (let i = 0; i < 8; i++) { const c = soup.code[wrap(soup, a + i)]; if (c > NOP1) break; t.push(c); }
  return t;
}
function matchesComplement(soup: Soup, a: number, t: number[]): boolean {
  for (let i = 0; i < t.length; i++) if (soup.code[wrap(soup, a + i)] !== 1 - t[i]) return false;
  return true;
}
/** Найти дополнительную метку: dir +1 — вперёд, −1 — назад, 0 — в обе стороны поочерёдно. Возвращает адрес начала найденной метки или −1. */
function findComplement(soup: Soup, from: number, back: number, t: number[], dir: number): number {
  for (let d = 0; d < LAWS.searchLimit; d++) {
    if (dir >= 0 && matchesComplement(soup, from + d, t)) return wrap(soup, from + d);
    if (dir <= 0 && matchesComplement(soup, back - d - t.length + 1, t)) return wrap(soup, back - d - t.length + 1);
  }
  return -1;
}

const canWrite = (soup: Soup, o: Organism, a: number) => soup.owner[a] === o.id || soup.owner[a] === -o.id;

function push(o: Organism, v: number): void { o.stack[o.sp] = v; o.sp = (o.sp + 1) % o.stack.length; }
function pop(o: Organism): number { o.sp = (o.sp + o.stack.length - 1) % o.stack.length; return o.stack[o.sp]; }

function randomOp(soup: Soup): number { return Math.floor(soup.rand() * OPS.length); }

/** Исполнить одну команду организма. */
function execute(soup: Soup, o: Organism): void {
  const ip = wrap(soup, o.ip), c = soup.code[ip], own = soup.owner[ip];
  o.executed++; soup.stats.executed++;
  if (own === 0) o.junk++;
  else if (own !== o.id && own !== -o.id) o.foreign++;
  let next = ip + 1;
  const fail = () => { o.errors++; };
  switch (c) {
    case op.nop0: case op.nop1: break;
    case op.not0: o.cx ^= 1; break;
    case op.shl: o.cx = (o.cx << 1) & 0xffff; break;
    case op.zero: o.cx = 0; break;
    case op.ifz: if (o.cx !== 0) next = ip + 2; break;
    case op.subCAB: o.cx = o.ax - o.bx; break;
    case op.subAAC: o.ax = o.ax - o.cx; break;
    case op.incA: o.ax++; break;
    case op.incB: o.bx++; break;
    case op.decC: o.cx--; break;
    case op.incC: o.cx++; break;
    case op.pushA: push(o, o.ax); break;
    case op.pushB: push(o, o.bx); break;
    case op.pushC: push(o, o.cx); break;
    case op.pushD: push(o, o.dx); break;
    case op.popA: o.ax = pop(o); break;
    case op.popB: o.bx = pop(o); break;
    case op.popC: o.cx = pop(o); break;
    case op.popD: o.dx = pop(o); break;
    case op.jmp: case op.jmpb: case op.call: {
      const t = templateAt(soup, ip + 1);
      next = ip + 1 + t.length;
      if (!t.length) break;
      const found = findComplement(soup, ip + 1 + t.length, ip - 1, t, c === op.jmpb ? -1 : 0);
      if (found < 0) { fail(); break; }
      if (c === op.call) push(o, ip + 1 + t.length);
      next = found + t.length;
      break;
    }
    case op.ret: next = pop(o); break;
    case op.movDC: o.dx = o.cx; break;
    case op.movBA: o.bx = o.ax; break;
    case op.movii: {
      const to = wrap(soup, o.ax), from = wrap(soup, o.bx);
      if (!canWrite(soup, o, to)) { fail(); break; }
      let v = soup.code[from];
      if (soup.rand() < LAWS.copyError) { v = soup.rand() < 0.5 ? v ^ (1 << Math.floor(soup.rand() * 5)) : randomOp(soup); soup.stats.copyErrors++; }
      soup.code[to] = v & 31;
      break;
    }
    case op.adr: case op.adrb: case op.adrf: {
      const t = templateAt(soup, ip + 1);
      next = ip + 1 + t.length;
      if (!t.length) break;
      const found = findComplement(soup, ip + 1 + t.length, ip - 1, t, c === op.adrb ? -1 : c === op.adrf ? 1 : 0);
      if (found < 0) { fail(); break; }
      o.ax = found + t.length; o.cx = t.length;
      break;
    }
    case op.mal: {
      const size = o.cx;
      if (size < LAWS.minSize || size > LAWS.maxSize) { fail(); break; }
      freeDaughter(soup, o);
      while (soup.free - size < soup.size * LAWS.reapAt) if (!reap(soup, o)) break;
      const at = findFree(soup, o.start + o.size, size);
      if (at < 0) { fail(); break; }
      for (let i = 0; i < size; i++) soup.owner[wrap(soup, at + i)] = -o.id;
      soup.free -= size;
      o.dStart = at; o.dSize = size; o.ax = at;
      break;
    }
    case op.divide: {
      if (o.dStart < 0) { fail(); break; }
      const start = o.dStart, size = o.dSize;
      o.dStart = -1; o.dSize = 0; soup.free += size;   // birth снова вычтет
      birth(soup, start, size, o);
      o.births++; soup.stats.births++;
      break;
    }
  }
  o.ip = wrap(soup, next);
}

/** Свободный участок длиной size, ищется от `from` вперёд по кольцу. */
function findFree(soup: Soup, from: number, size: number): number {
  let run = 0;
  for (let k = 0; k < soup.size + size; k++) {
    const a = wrap(soup, from + k);
    if (soup.owner[a] === 0) { run++; if (run === size) return wrap(soup, a - size + 1); }
    else run = 0;
  }
  return -1;
}

/** Один ход: каждый организм исполняет столько команд, сколько даёт свет над ним. */
export function step(soup: Soup): void {
  if (soup.tick % 50 === 0) updateLight(soup);
  // Космические лучи: случайные замены в супе.
  let rays = LAWS.cosmic;
  while (rays > 0) { if (soup.rand() < rays) soup.code[Math.floor(soup.rand() * soup.size)] = randomOp(soup); rays -= 1; }
  // Порядок — случайный сдвиг, чтобы никто не ходил всегда первым.
  const list = soup.orgs.slice(), n = list.length, shift = Math.floor(soup.rand() * Math.max(1, n));
  for (let k = 0; k < n; k++) {
    const o = list[(k + shift) % n];
    if (!soup.byId.has(o.id)) continue;
    const l = soup.light[wrap(soup, o.start + (o.size >> 1))];
    let budget = l * LAWS.slice;
    budget = Math.floor(budget) + (soup.rand() < budget % 1 ? 1 : 0);
    for (let i = 0; i < budget && soup.byId.has(o.id); i++) execute(soup, o);
  }
  soup.tick++;
}

export interface SoupSnapshot {
  tick: number; population: number; genotypes: number; meanSize: number; fill: number;
  /** Доля организмов, исполняющих в основном чужой код (паразиты) и ничей. */
  foreignShare: number; junkShare: number;
  /** Размеры: самые частые классы размера (размер → число организмов). */
  sizes: [number, number][];
  births: number; deaths: number; executed: number;
}

export function snapshot(soup: Soup): SoupSnapshot {
  const n = soup.orgs.length, bySize = new Map<number, number>();
  let size = 0, foreign = 0, junk = 0;
  for (const o of soup.orgs) {
    size += o.size; bySize.set(o.size, (bySize.get(o.size) ?? 0) + 1);
    if (o.executed > 50 && o.foreign / o.executed > 0.3) foreign++;
    if (o.executed > 50 && o.junk / o.executed > 0.3) junk++;
  }
  let genotypes = 0;
  for (const g of soup.genotypes.values()) if (g.count > 0) genotypes++;
  return {
    tick: soup.tick, population: n, genotypes, meanSize: n ? size / n : 0, fill: 1 - soup.free / soup.size,
    foreignShare: n ? foreign / n : 0, junkShare: n ? junk / n : 0,
    sizes: [...bySize].sort((a, b) => b[1] - a[1]).slice(0, 6),
    births: soup.stats.births, deaths: soup.stats.deaths, executed: soup.stats.executed,
  };
}

export function resetWindow(soup: Soup): void { soup.stats.births = 0; soup.stats.deaths = 0; soup.stats.executed = 0; soup.stats.copyErrors = 0; }

/** Код организма словами команд. */
export function disassemble(soup: Soup, start: number, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < size; i++) out.push(OPS[soup.code[wrap(soup, start + i)]]);
  return out;
}
