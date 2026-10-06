/**
 * Эволюционная лаборатория: маленькая карта с упрощёнными законами и автоматы
 * с простыми правилами. Вопрос — растёт ли что-то новое само.
 *
 * Мир — решётка мест; в месте не больше одного организма (ёмкость задана явно).
 * Законы: свет дрейфующих пятен; минерал сохраняется и ходит по кругу (среда →
 * тело → останки → среда); останки несут энергию и минерал, энергия в них
 * понемногу теряется. Организм — список правил «если сигнал (больше|меньше)
 * порога → действие»: за ход срабатывает первое выполнимое правило. Список
 * мутирует при делении: пороги, сигналы, действия, удвоение и выпадение правил.
 */

export const SENSORS = ['всегда', 'свет', 'запас', 'размер', 'пусто рядом', 'чужие рядом', 'свои рядом', 'связи', 'останки', 'минерал', 'светлее рядом', 'возраст', 'случай'] as const;
export const ACTIONS = ['фотосинтез', 'есть останки', 'напасть', 'двигаться', 'расти', 'делиться', 'делиться энергией', 'ждать'] as const;
export const ACTION_COUNT = ACTIONS.length;
const S_ALWAYS = 0, S_LIGHT = 1, S_ENERGY = 2, S_BODY = 3, S_EMPTY = 4, S_KIN = 6, S_BONDS = 7, S_REMAINS = 8, S_MINERAL = 9, S_BRIGHTER = 10, S_AGE = 11, S_RANDOM = 12;
export const A_PHOTO = 0, A_EAT = 1, A_ATTACK = 2, A_MOVE = 3, A_GROW = 4, A_DIVIDE = 5, A_SHARE = 6, A_WAIT = 7;

/** Правило: сигнал, сравнение (0 — больше, 1 — меньше), порог 0…1, действие, параметр 0…1 (направление, прилипание и т. п.). */
export interface Rule { s: number; lt: number; t: number; a: number; p: number }

export interface Genotype {
  id: number; parent: number; rules: Rule[];
  /** Метка родства — дрейфует с мутациями; «свои» — близкие по метке. */
  tag: number;
  count: number; maxCount: number; born: number; established: number;
  /** Сколько раз срабатывало каждое правило — какие правила живые, а какие балласт. */
  fired: Uint32Array;
}

export const LAWS = {
  photo: 0.06,          // энергии за ход фотосинтеза при свете 1
  upkeep: 0.004,        // содержание на единицу тела за ход
  ruleCost: 0.0008,     // содержание на правило за ход
  capacity: 2,          // запас энергии на единицу тела
  growStep: 0.25,       // прирост тела за ход роста
  growEnergy: 0.5,      // энергии на единицу прироста
  growMineral: 0.3,     // минерала на единицу прироста
  bodyEnergy: 0.4,      // энергии в единице тела (уходит в останки или едоку)
  divideBody: 2,        // делиться можно с такого тела
  eatRate: 0.08,        // энергии останков за ход еды
  attackGain: 0.7,      // доля энергии жертвы, которую получает нападающий
  attackCost: 0.05,     // цена неудачного нападения
  moveCost: 0.01,
  remainsLoss: 0.002,   // доля энергии останков, теряемая за ход
  dissolve: 0.002,      // доля минерала останков, уходящая в среду за ход
  mutation: 0.15,       // вероятность мутации при делении
  maxAge: 4000,
  maxRules: 12,
  /** Выключатели для опытов: нападение (1/0), скорость дрейфа пятен (×). */
  predation: 1,
  spotDrift: 1,
  /** 1 — фотосинтез идёт сам каждый ход и не занимает ход (правило «фотосинтез» тогда невыполнимо). */
  passivePhoto: 0,
};

export interface Sim {
  w: number; h: number; tick: number;
  light: Float32Array; mineral: Float32Array; remE: Float32Array; remM: Float32Array;
  /** Организмы по местам: жив ли, энергия, тело, минерал в теле, возраст, связи (биты 0–3), генотип, последнее действие. */
  alive: Uint8Array; energy: Float32Array; body: Float32Array; bodyMin: Float32Array; age: Uint32Array; bonds: Uint8Array;
  geno: (Genotype | null)[]; last: Int8Array;
  genotypes: Map<number, Genotype>; nextGeno: number;
  spots: { x: number; y: number; vx: number; vy: number; r: number }[];
  rand: () => number;
  /** Счётчики за всё время и за окно наблюдения. */
  stats: { actions: Float64Array; kills: number; births: number; deaths: number; newEstablished: number };
}

const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];

export function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export const ANCESTOR: Rule[] = [
  { s: S_ENERGY, lt: 0, t: 0.7, a: A_DIVIDE, p: 0 },
  { s: S_ENERGY, lt: 0, t: 0.5, a: A_GROW, p: 0 },
  { s: S_ALWAYS, lt: 0, t: 0, a: A_PHOTO, p: 0 },
];

export function createSim(seed: number, w = 160, h = 120, start = 200): Sim {
  const n = w * h, rand = mulberry(seed);
  const sim: Sim = {
    w, h, tick: 0,
    light: new Float32Array(n), mineral: new Float32Array(n), remE: new Float32Array(n), remM: new Float32Array(n),
    alive: new Uint8Array(n), energy: new Float32Array(n), body: new Float32Array(n), bodyMin: new Float32Array(n), age: new Uint32Array(n), bonds: new Uint8Array(n),
    geno: new Array(n).fill(null), last: new Int8Array(n).fill(-1),
    genotypes: new Map(), nextGeno: 1,
    spots: [], rand,
    stats: { actions: new Float64Array(ACTION_COUNT), kills: 0, births: 0, deaths: 0, newEstablished: 0 },
  };
  for (let k = 0; k < 4; k++) {
    const a = rand() * Math.PI * 2, v = 0.01 + rand() * 0.02;
    sim.spots.push({ x: rand() * w, y: rand() * h, vx: Math.cos(a) * v, vy: Math.sin(a) * v, r: 14 + rand() * 12 });
  }
  // Минерал: ровный слой и несколько богатых мест; дальше только перетекает.
  for (let i = 0; i < n; i++) sim.mineral[i] = 0.5;
  for (let k = 0; k < 5; k++) {
    const cx = rand() * w, cy = rand() * h, r = 6 + rand() * 8;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const d = Math.hypot(x - cx, y - cy); if (d < r) sim.mineral[y * w + x] += 3 * (1 - d / r); }
  }
  updateLight(sim);
  const root = newGenotype(sim, ANCESTOR, 0, 0.5);
  for (let k = 0; k < start; k++) {
    const p = Math.floor(rand() * n);
    if (sim.alive[p]) continue;
    place(sim, p, root, 1, 1, 0);
  }
  return sim;
}

function newGenotype(sim: Sim, rules: Rule[], parent: number, tag: number): Genotype {
  const g: Genotype = { id: sim.nextGeno++, parent, rules, tag, count: 0, maxCount: 0, born: sim.tick, established: -1, fired: new Uint32Array(rules.length) };
  sim.genotypes.set(g.id, g);
  return g;
}

/** Генотип закрепился, когда в нём хоть раз было столько организмов. */
export const ESTABLISHED = 20;

function place(sim: Sim, p: number, g: Genotype, body: number, energy: number, min: number): void {
  sim.alive[p] = 1; sim.energy[p] = energy; sim.body[p] = body; sim.bodyMin[p] = min; sim.age[p] = 0; sim.bonds[p] = 0;
  sim.geno[p] = g; sim.last[p] = -1;
  g.count++;
  if (g.count > g.maxCount) {
    g.maxCount = g.count;
    if (g.maxCount === ESTABLISHED) { g.established = sim.tick; sim.stats.newEstablished++; }
  }
}

function remove(sim: Sim, p: number): void {
  const g = sim.geno[p]!;
  g.count--;
  if (g.count === 0) sim.genotypes.delete(g.id);
  // Связи рвутся у соседей.
  for (let d = 0; d < 4; d++) if (sim.bonds[p] & (1 << d)) { const q = neighbour(sim, p, d); if (q >= 0) sim.bonds[q] &= ~(1 << ((d + 2) % 4)); }
  sim.alive[p] = 0; sim.geno[p] = null; sim.bonds[p] = 0; sim.last[p] = -1;
}

/** Смерть: тело и запас — в останки; минерал тела — в останки целиком. */
function die(sim: Sim, p: number): void {
  sim.remE[p] += Math.max(0, sim.energy[p]) + sim.body[p] * LAWS.bodyEnergy;
  sim.remM[p] += sim.bodyMin[p];
  sim.stats.deaths++;
  remove(sim, p);
}

function neighbour(sim: Sim, p: number, d: number): number {
  const x = (p % sim.w) + DX[d], y = Math.floor(p / sim.w) + DY[d];
  return x < 0 || y < 0 || x >= sim.w || y >= sim.h ? -1 : y * sim.w + x;
}

function updateLight(sim: Sim): void {
  const { w, h, light } = sim;
  for (const s of sim.spots) {
    s.x += s.vx * 10 * LAWS.spotDrift; s.y += s.vy * 10 * LAWS.spotDrift;
    if (s.x < 0 || s.x > w) s.vx = -s.vx;
    if (s.y < 0 || s.y > h) s.vy = -s.vy;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 0.08;
    for (const s of sim.spots) { const d2 = ((x - s.x) ** 2 + (y - s.y) ** 2) / (s.r * s.r); if (d2 < 1) v += 0.9 * (1 - d2) * (1 - d2) * 2; }
    light[y * w + x] = Math.min(1, v);
  }
}

/** Минерал растекается; останки теряют энергию и отдают минерал в среду. */
function updateMedium(sim: Sim, steps: number): void {
  const { w, h, mineral, remE, remM } = sim, n = w * h;
  const loss = Math.pow(1 - LAWS.remainsLoss, steps), dis = 1 - Math.pow(1 - LAWS.dissolve, steps);
  for (let i = 0; i < n; i++) { remE[i] *= loss; const m = remM[i] * dis; remM[i] -= m; mineral[i] += m; }
  const flow = 0.05;
  for (let y = 0; y < h; y++) for (let x = 0; x < w - 1; x++) { const i = y * w + x, d = (mineral[i] - mineral[i + 1]) * flow; mineral[i] -= d; mineral[i + 1] += d; }
  for (let y = 0; y < h - 1; y++) for (let x = 0; x < w; x++) { const i = y * w + x, d = (mineral[i] - mineral[i + w]) * flow; mineral[i] -= d; mineral[i + w] += d; }
}

const kin = (a: Genotype, b: Genotype) => Math.abs(a.tag - b.tag) < 0.06;

function sense(sim: Sim, p: number, s: number): number {
  switch (s) {
    case S_ALWAYS: return 1;
    case S_LIGHT: return sim.light[p];
    case S_ENERGY: return sim.energy[p] / (sim.body[p] * LAWS.capacity);
    case S_BODY: return Math.min(1, sim.body[p] / 8);
    case S_RANDOM: return sim.rand();
    case S_AGE: return Math.min(1, sim.age[p] / LAWS.maxAge);
    case S_REMAINS: return Math.min(1, sim.remE[p] / 2);
    case S_MINERAL: return Math.min(1, sim.mineral[p] / 2);
    case S_BONDS: { let b = 0; for (let d = 0; d < 4; d++) if (sim.bonds[p] & (1 << d)) b++; return b / 4; }
    case S_BRIGHTER: { let best = 0; for (let d = 0; d < 4; d++) { const q = neighbour(sim, p, d); if (q >= 0) best = Math.max(best, sim.light[q] - sim.light[p]); } return Math.min(1, best * 10); }
    default: {
      const g = sim.geno[p]!;
      let c = 0;
      for (let d = 0; d < 4; d++) {
        const q = neighbour(sim, p, d);
        if (q < 0) continue;
        if (s === S_EMPTY) { if (!sim.alive[q]) c++; }
        else if (sim.alive[q]) { const k = kin(g, sim.geno[q]!); if ((s === S_KIN) === k) c++; }   // «чужие рядом» (5) — не свои
      }
      return c / 4;
    }
  }
}

/** Выбрать соседнее место по параметру: 0…0,5 — направление, дальше — к свету, наугад. */
function pickDirection(sim: Sim, p: number, param: number, want: (q: number) => boolean): number {
  if (param < 0.5) {
    const d = Math.floor(param * 8) % 4, q = neighbour(sim, p, d);
    return q >= 0 && want(q) ? q : -1;
  }
  const start = Math.floor(sim.rand() * 4);
  let best = -1, bestLight = -1;
  for (let k = 0; k < 4; k++) {
    const q = neighbour(sim, p, (start + k) % 4);
    if (q < 0 || !want(q)) continue;
    if (param < 0.75) { if (sim.light[q] > bestLight) { bestLight = sim.light[q]; best = q; } }
    else return q;
  }
  return best;
}

/** Сила места против нападения: тело, минерал как панцирь, и тела связанных соседей. */
function defence(sim: Sim, q: number): number {
  let v = sim.body[q] + 2 * sim.bodyMin[q];
  for (let d = 0; d < 4; d++) if (sim.bonds[q] & (1 << d)) { const r = neighbour(sim, q, d); if (r >= 0 && sim.alive[r]) v += sim.body[r] * 0.5; }
  return v;
}

/** Выполнить действие; false — невыполнимо (тогда пробуется следующее правило). */
function act(sim: Sim, p: number, a: number, param: number): boolean {
  const L = LAWS;
  switch (a) {
    case A_PHOTO: if (L.passivePhoto) return false; sim.energy[p] += sim.light[p] * L.photo; return true;
    case A_EAT: {
      if (sim.remE[p] <= 0.01) return false;
      const take = Math.min(L.eatRate, sim.remE[p]), f = take / sim.remE[p];
      sim.energy[p] += take; sim.remE[p] -= take;
      const m = sim.remM[p] * f; sim.remM[p] -= m; sim.mineral[p] += m;
      return true;
    }
    case A_ATTACK: {
      if (!LAWS.predation) return false;
      const g = sim.geno[p]!;
      const q = pickDirection(sim, p, param, (q) => sim.alive[q] === 1 && !kin(g, sim.geno[q]!));
      if (q < 0) return false;
      if (sim.body[p] * (0.5 + sim.rand()) > defence(sim, q)) {
        sim.energy[p] += (Math.max(0, sim.energy[q]) + sim.body[q] * L.bodyEnergy) * L.attackGain;
        sim.mineral[q] += sim.bodyMin[q];
        sim.stats.kills++; sim.stats.deaths++;
        remove(sim, q);
      } else sim.energy[p] -= L.attackCost;
      return true;
    }
    case A_MOVE: {
      if (sim.bonds[p]) return false;
      const q = pickDirection(sim, p, param, (q) => !sim.alive[q]);
      if (q < 0) return false;
      sim.alive[q] = 1; sim.energy[q] = sim.energy[p] - L.moveCost; sim.body[q] = sim.body[p]; sim.bodyMin[q] = sim.bodyMin[p];
      sim.age[q] = sim.age[p]; sim.bonds[q] = 0; sim.geno[q] = sim.geno[p]; sim.last[q] = A_MOVE;
      sim.alive[p] = 0; sim.geno[p] = null; sim.last[p] = -1;
      movedTo = q;
      return true;
    }
    case A_GROW: {
      const need = L.growStep * L.growMineral, cost = L.growStep * L.growEnergy;
      if (sim.energy[p] < cost || sim.mineral[p] < need || sim.body[p] >= 8) return false;
      sim.energy[p] -= cost; sim.mineral[p] -= need; sim.bodyMin[p] += need; sim.body[p] += L.growStep;
      return true;
    }
    case A_DIVIDE: {
      if (sim.body[p] < L.divideBody) return false;
      const q = pickDirection(sim, p, param < 0.5 ? 0.6 : 0.9, (q) => !sim.alive[q]);
      if (q < 0) return false;
      const g = sim.geno[p]!, child = sim.rand() < L.mutation ? mutate(sim, g) : g;
      const half = sim.body[p] / 2, e = sim.energy[p] / 2, m = sim.bodyMin[p] / 2;
      sim.body[p] = half; sim.energy[p] = e; sim.bodyMin[p] = m;
      place(sim, q, child, half, e, m);
      sim.last[q] = -1;
      sim.stats.births++;
      // Параметр ≥ 0,5 — дочь остаётся связанной.
      if (param >= 0.5) for (let d = 0; d < 4; d++) if (neighbour(sim, p, d) === q) { sim.bonds[p] |= 1 << d; sim.bonds[q] |= 1 << ((d + 2) % 4); }
      return true;
    }
    case A_SHARE: {
      if (!sim.bonds[p]) return false;
      for (let d = 0; d < 4; d++) {
        if (!(sim.bonds[p] & (1 << d))) continue;
        const q = neighbour(sim, p, d);
        if (q < 0 || !sim.alive[q] || sim.energy[q] >= sim.energy[p]) continue;
        const give = (sim.energy[p] - sim.energy[q]) * 0.25;
        sim.energy[p] -= give; sim.energy[q] += give;
      }
      return true;
    }
    default: return true;
  }
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function randomRule(sim: Sim): Rule {
  const r = sim.rand;
  return { s: Math.floor(r() * SENSORS.length), lt: r() < 0.5 ? 1 : 0, t: r(), a: Math.floor(r() * ACTION_COUNT), p: r() };
}

function mutate(sim: Sim, g: Genotype): Genotype {
  const r = sim.rand, rules = g.rules.map((x) => ({ ...x }));
  const k = Math.floor(r() * rules.length), kind = r();
  if (kind < 0.35 && rules.length) rules[k].t = clamp01(rules[k].t + (r() - 0.5) * 0.3);
  else if (kind < 0.45 && rules.length) rules[k].p = clamp01(rules[k].p + (r() - 0.5) * 0.5);
  else if (kind < 0.55 && rules.length) rules[k].s = Math.floor(r() * SENSORS.length);
  else if (kind < 0.62 && rules.length) rules[k].a = Math.floor(r() * ACTION_COUNT);
  else if (kind < 0.67 && rules.length) rules[k].lt = 1 - rules[k].lt;
  else if (kind < 0.77 && rules.length && rules.length < LAWS.maxRules) rules.splice(k, 0, { ...rules[k] });
  else if (kind < 0.85 && rules.length > 1) rules.splice(k, 1);
  else if (kind < 0.93 && rules.length < LAWS.maxRules) rules.splice(Math.floor(r() * (rules.length + 1)), 0, randomRule(sim));
  else if (rules.length > 1) { const j = Math.floor(r() * rules.length); [rules[k], rules[j]] = [rules[j], rules[k]]; }
  const tag = ((g.tag + (r() - 0.5) * 0.04) % 1 + 1) % 1;
  return newGenotype(sim, rules, g.id, tag);
}

let order = new Int32Array(0);
/** Куда переехал организм на этом ходу (действие «двигаться»). */
let movedTo = -1;

/** Один ход мира. */
export function step(sim: Sim): void {
  const n = sim.w * sim.h, L = LAWS;
  if (sim.tick % 10 === 0) { updateLight(sim); updateMedium(sim, 10); }
  if (order.length !== n) { order = new Int32Array(n); for (let i = 0; i < n; i++) order[i] = i; }
  // Порядок обхода — перемешан частично каждый ход (без перекоса в пользу левого верхнего угла).
  for (let k = 0; k < 2000; k++) { const i = Math.floor(sim.rand() * n), j = Math.floor(sim.rand() * n), t = order[i]; order[i] = order[j]; order[j] = t; }
  const moved = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const p = order[k];
    if (!sim.alive[p] || moved[p]) continue;
    const g = sim.geno[p]!;
    sim.age[p]++;
    sim.energy[p] -= sim.body[p] * L.upkeep + g.rules.length * L.ruleCost;
    if (L.passivePhoto) sim.energy[p] += sim.light[p] * L.photo;
    let done = -1;
    for (let r = 0; r < g.rules.length; r++) {
      const rule = g.rules[r];
      const v = sense(sim, p, rule.s);
      if (rule.lt ? v >= rule.t : v <= rule.t) continue;
      if (act(sim, p, rule.a, rule.p)) { done = rule.a; g.fired[r]++; break; }
    }
    if (done === A_MOVE) {
      // Организм переехал — не ходит второй раз за ход.
      moved[movedTo] = 1; finish(sim, movedTo);
      sim.stats.actions[A_MOVE]++;
      continue;
    }
    if (done >= 0) sim.stats.actions[done]++;
    sim.last[p] = done;
    if (sim.alive[p]) finish(sim, p);
  }
  sim.tick++;
}

function finish(sim: Sim, p: number): void {
  const cap = sim.body[p] * LAWS.capacity;
  if (sim.energy[p] > cap) sim.energy[p] = cap;
  if (sim.energy[p] <= 0 || sim.age[p] > LAWS.maxAge) die(sim, p);
}

/** Сводка состояния — для графиков и выводов. */
export interface Snapshot {
  tick: number; population: number; genotypes: number; established: number; meanRules: number; maxRules: number;
  /** Сколько правил генома реально работает (срабатывает хотя бы в 0,1% ходов генотипа: деление редкое, но нужное) — среднее по организмам. */
  meanLiving: number;
  meanBody: number; bonded: number; actions: number[]; kills: number; births: number; usedActions: number;
  mineralTotal: number;
}

export function snapshot(sim: Sim): Snapshot {
  const n = sim.w * sim.h;
  let pop = 0, rules = 0, maxRules = 0, body = 0, bonded = 0, mineralTotal = 0;
  for (let i = 0; i < n; i++) {
    mineralTotal += sim.mineral[i] + sim.remM[i] + (sim.alive[i] ? sim.bodyMin[i] : 0);
    if (!sim.alive[i]) continue;
    pop++; const l = sim.geno[i]!.rules.length; rules += l; maxRules = Math.max(maxRules, l); body += sim.body[i];
    if (sim.bonds[i]) bonded++;
  }
  let established = 0, living = 0;
  for (const g of sim.genotypes.values()) {
    if (g.count >= ESTABLISHED) established++;
    const total = g.fired.reduce((a, b) => a + b, 0);
    if (total > 0) living += g.count * g.fired.filter((f) => f / total >= 0.001).length;
  }
  const total = sim.stats.actions.reduce((a, b) => a + b, 0) || 1;
  const actions = Array.from(sim.stats.actions, (v) => v / total);
  return {
    tick: sim.tick, population: pop, genotypes: sim.genotypes.size, established, meanRules: pop ? rules / pop : 0, maxRules, meanLiving: pop ? living / pop : 0,
    meanBody: pop ? body / pop : 0, bonded: pop ? bonded / pop : 0, actions, kills: sim.stats.kills, births: sim.stats.births,
    usedActions: actions.filter((v) => v > 0.02).length, mineralTotal,
  };
}

/** Сбросить счётчики окна наблюдения. */
export function resetWindow(sim: Sim): void { sim.stats.actions.fill(0); sim.stats.kills = 0; sim.stats.births = 0; sim.stats.deaths = 0; sim.stats.newEstablished = 0; }

export function describeRule(r: Rule): string {
  const dir = r.a === A_ATTACK || r.a === A_MOVE ? (r.p < 0.5 ? ` ${['→', '↓', '←', '↑'][Math.floor(r.p * 8) % 4]}` : r.p < 0.75 ? ' к свету' : ' наугад') : r.a === A_DIVIDE && r.p >= 0.5 ? ' (прилипнуть)' : '';
  const cond = r.s === S_ALWAYS ? 'всегда' : `${SENSORS[r.s]} ${r.lt ? '<' : '>'} ${r.t.toFixed(2)}`;
  return `${cond} → ${ACTIONS[r.a]}${dir}`;
}
