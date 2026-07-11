/**
 * NEAT — эволюционирующая нейросеть переменной топологии (PLAN.md §4а). Фаза 3+.
 *
 * Здесь рождаются НОВЫЕ гены: мутация «добавить узел» разбивает связь A→B узлом
 * A→N→B — это буквально ген, которого никто не задавал. Геном мозга растёт со
 * временем (принцип complexifying: старт без скрытых узлов, входы→выходы напрямую).
 *
 * ⛔ Детерминизм (CLAUDE.md инвариант 1, PLAN.md §4а п.9):
 *   - все мутационные выборы — из сидированного PRNG;
 *   - обход узлов/связей — по УПОРЯДОЧЕННЫМ массивам (сорт по id/innovation),
 *     никогда по порядку ключей объекта;
 *   - innovation- и node-счётчики живут per-world (NeatContext), а не глобально в
 *     модуле — иначе два мира с одним сидом разошлись бы. Счётчики детерминированы
 *     при фиксированном порядке рождений (существа и новорождённые обрабатываются
 *     строго по порядку в world.ts).
 *
 * Сеть — feed-forward (без циклов): add-connection отклоняет связь, создающую цикл.
 * Это позволяет вычислять сеть одним проходом в топологическом порядке.
 *
 * Кроссовер (для полового размножения, §4б) пока не реализован, но innovation-номера
 * уже проставляются — машинерия выравнивания встанет без смены формата.
 */
import { PRNG } from './prng.ts';

/** Входы сети (индексы = id входных узлов). */
export const Input = {
  Bias: 0, // всегда 1.0
  FoodDx: 1, // единичный вектор к еде, x (0 если еды нет)
  FoodDy: 2, // y
  HasFood: 3, // 1/0
  Energy: 4, // своя энергия, 0..1
  NoiseX: 5, // случайный шум [-1,1] (даёт эволюционируемое блуждание)
  NoiseY: 6,
} as const;
export const NUM_INPUTS = 7;
export const NUM_OUTPUTS = 2; // outX, outY → желаемое направление
export const OUT_X = NUM_INPUTS; // id 7
export const OUT_Y = NUM_INPUTS + 1; // id 8

export type NodeType = 'input' | 'output' | 'hidden';

export interface NodeGene {
  id: number;
  type: NodeType;
}

export interface ConnGene {
  inNode: number;
  outNode: number;
  weight: number;
  enabled: boolean;
  innovation: number;
}

export interface NeatGenome {
  nodes: NodeGene[]; // отсортированы по id
  connections: ConnGene[]; // отсортированы по innovation
}

/**
 * Per-world реестр инноваций и id узлов. Держит счётчики детерминированными в
 * пределах одного мира. Кэш инноваций текущего «пакета рождений» гарантирует, что
 * одинаковая структурная мутация получает один innovation-номер (нужно для будущего
 * кроссовера); кэш чистится владельцем между тиками не обязательно — для бесполого
 * достаточно монотонного счётчика.
 */
export class NeatContext {
  nextNodeId: number;
  nextInnovation: number;

  constructor(nextNodeId = NUM_INPUTS + NUM_OUTPUTS, nextInnovation = SEED_CONN_COUNT) {
    this.nextNodeId = nextNodeId;
    this.nextInnovation = nextInnovation;
  }

  newNodeId(): number {
    return this.nextNodeId++;
  }

  newInnovation(): number {
    return this.nextInnovation++;
  }
}

// Начальная топология: 4 сид-связи (см. seedGenome). Их innovation-номера 0..3
// одинаковы у всех стартовых существ (канонично: общая структура = общий innovation).
const SEED_CONN_COUNT = 4;

/**
 * Начальный геном мозга, сидированный под поведение RuleBrain, чтобы сбалансированная
 * экономика не рухнула при замене мозга:
 *   FoodDx→outX, FoodDy→outY (плыви к еде) + NoiseX→outX, NoiseY→outY (блуждай).
 * Веса получают небольшой гауссов джиттер на особь — начальное разнообразие.
 */
export function seedGenome(rng: PRNG): NeatGenome {
  const nodes: NodeGene[] = [];
  for (let i = 0; i < NUM_INPUTS; i++) nodes.push({ id: i, type: 'input' });
  nodes.push({ id: OUT_X, type: 'output' });
  nodes.push({ id: OUT_Y, type: 'output' });

  const jitter = () => rng.gaussian() * 0.15;
  const connections: ConnGene[] = [
    { inNode: Input.FoodDx, outNode: OUT_X, weight: 2.0 + jitter(), enabled: true, innovation: 0 },
    { inNode: Input.FoodDy, outNode: OUT_Y, weight: 2.0 + jitter(), enabled: true, innovation: 1 },
    { inNode: Input.NoiseX, outNode: OUT_X, weight: 0.6 + jitter(), enabled: true, innovation: 2 },
    { inNode: Input.NoiseY, outNode: OUT_Y, weight: 0.6 + jitter(), enabled: true, innovation: 3 },
  ];
  return { nodes, connections };
}

function cloneGenome(g: NeatGenome): NeatGenome {
  return {
    nodes: g.nodes.map((n) => ({ ...n })),
    connections: g.connections.map((c) => ({ ...c })),
  };
}

const WEIGHT_PERTURB_RATE = 0.8; // доля связей, чей вес пробуется на возмущение
const ADD_CONN_RATE = 0.06;
const ADD_NODE_RATE = 0.03;
const WEIGHT_CAP = 8;

function clampW(w: number): number {
  return w < -WEIGHT_CAP ? -WEIGHT_CAP : w > WEIGHT_CAP ? WEIGHT_CAP : w;
}

/**
 * Мутация мозга при рождении. Возвращает НОВЫЙ геном (родитель не тронут).
 * `rate` — мета-ген mutationRate особи: чем выше, тем сильнее возмущаются веса.
 * Структурные мутации (связь/узел) — с фиксированными небольшими вероятностями,
 * чтобы сеть усложнялась медленно.
 */
export function mutateBrain(parent: NeatGenome, rate: number, rng: PRNG, ctx: NeatContext): NeatGenome {
  const g = cloneGenome(parent);

  // 1. Возмущение весов (эволюция значений).
  for (const c of g.connections) {
    if (rng.next() < WEIGHT_PERTURB_RATE) {
      c.weight = clampW(c.weight + rng.gaussian() * rate);
    }
  }

  // 2. Добавить связь между двумя пока несвязанными узлами (без цикла).
  if (rng.next() < ADD_CONN_RATE) {
    tryAddConnection(g, rng, ctx);
  }

  // 3. Добавить узел, разбив существующую включённую связь.
  if (rng.next() < ADD_NODE_RATE) {
    tryAddNode(g, rng, ctx);
  }

  return g;
}

/** Достижим ли `target` из `from` по включённым связям (для проверки цикла). */
function reaches(g: NeatGenome, from: number, target: number): boolean {
  const stack = [from];
  const seen = new Set<number>();
  while (stack.length) {
    const n = stack.pop()!;
    if (n === target) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const c of g.connections) {
      if (c.enabled && c.inNode === n) stack.push(c.outNode);
    }
  }
  return false;
}

function tryAddConnection(g: NeatGenome, rng: PRNG, ctx: NeatContext): void {
  // Кандидаты источника: любой узел, кроме выходов. Кандидаты приёмника: не входы.
  const sources = g.nodes.filter((n) => n.type !== 'output');
  const targets = g.nodes.filter((n) => n.type !== 'input');
  if (!sources.length || !targets.length) return;

  const a = sources[(rng.next() * sources.length) | 0];
  const b = targets[(rng.next() * targets.length) | 0];
  if (a.id === b.id) return;

  // Уже есть такая связь?
  for (const c of g.connections) {
    if (c.inNode === a.id && c.outNode === b.id) return;
  }
  // Не создаём цикл: b не должен достигать a.
  if (reaches(g, b.id, a.id)) return;

  g.connections.push({
    inNode: a.id,
    outNode: b.id,
    weight: rng.gaussian(),
    enabled: true,
    innovation: ctx.newInnovation(),
  });
  g.connections.sort((x, y) => x.innovation - y.innovation);
}

function tryAddNode(g: NeatGenome, rng: PRNG, ctx: NeatContext): void {
  const enabled = g.connections.filter((c) => c.enabled);
  if (!enabled.length) return;
  const conn = enabled[(rng.next() * enabled.length) | 0];
  conn.enabled = false;

  const newId = ctx.newNodeId();
  g.nodes.push({ id: newId, type: 'hidden' });
  g.nodes.sort((x, y) => x.id - y.id);

  // A→new (вес 1), new→B (старый вес) — эквивалентно исходной связи на старте.
  g.connections.push({ inNode: conn.inNode, outNode: newId, weight: 1, enabled: true, innovation: ctx.newInnovation() });
  g.connections.push({ inNode: newId, outNode: conn.outNode, weight: conn.weight, enabled: true, innovation: ctx.newInnovation() });
  g.connections.sort((x, y) => x.innovation - y.innovation);
}

/**
 * Кроссовер мозгов (§4б). Здесь innovation-номера наконец нужны: гены с общей
 * инновацией — «те же самые», выравниваются и вес берётся случайно от одного из
 * родителей. Расходящиеся/избыточные гены (есть только у одного) берём от инициатора
 * `a` — эмерджентный отбор без функции приспособленности не даёт критерия «от кого
 * брать лишнее», поэтому топология наследуется от инициатора (валидна и ацикличка),
 * а половое перемешивание живёт в весах общих генов.
 */
export function crossoverBrain(a: NeatGenome, b: NeatGenome, rng: PRNG): NeatGenome {
  const bByInnov = new Map<number, ConnGene>();
  for (const c of b.connections) bByInnov.set(c.innovation, c);

  const nodes = a.nodes.map((n): NodeGene => ({ id: n.id, type: n.type }));
  const connections = a.connections.map((c): ConnGene => {
    const match = bByInnov.get(c.innovation);
    const from = match && rng.next() < 0.5 ? match : c;
    // Отключённый ген у любого родителя иногда остаётся отключённым.
    const enabled = c.enabled && (match ? match.enabled : true) ? true : rng.next() < 0.5;
    return {
      inNode: c.inNode,
      outNode: c.outNode,
      weight: from.weight,
      enabled,
      innovation: c.innovation,
    };
  });
  return { nodes, connections };
}

function tanh(x: number): number {
  // Math.tanh есть в среде, но оставляем явную устойчивую форму на всякий случай.
  if (x > 20) return 1;
  if (x < -20) return -1;
  const e = Math.exp(2 * x);
  return (e - 1) / (e + 1);
}

/**
 * Скомпилированный фенотип — сеть, готовая считать выход по входам одним проходом.
 * Топологический порядок вычисляется один раз (геном за жизнь особи не меняется).
 */
export class Network {
  private readonly order: number[]; // порядок вычисления не-входных узлов
  private readonly incoming: Map<number, { from: number; w: number }[]>;
  private readonly values: Map<number, number>;

  constructor(g: NeatGenome) {
    this.incoming = new Map();
    this.values = new Map();
    for (const n of g.nodes) {
      this.incoming.set(n.id, []);
      this.values.set(n.id, 0);
    }
    for (const c of g.connections) {
      if (!c.enabled) continue;
      const list = this.incoming.get(c.outNode);
      if (list) list.push({ from: c.inNode, w: c.weight });
    }
    this.order = topoOrder(g);
  }

  /** Вычислить (outX, outY) по входным значениям (массив длины NUM_INPUTS). */
  eval(inputs: Float64Array): [number, number] {
    for (let i = 0; i < NUM_INPUTS; i++) this.values.set(i, inputs[i]);
    for (const id of this.order) {
      const inc = this.incoming.get(id)!;
      let sum = 0;
      for (const e of inc) sum += this.values.get(e.from)! * e.w;
      this.values.set(id, tanh(sum));
    }
    return [this.values.get(OUT_X) ?? 0, this.values.get(OUT_Y) ?? 0];
  }
}

/** Топологический порядок не-входных узлов (Kahn). Детерминирован: узлы по id. */
function topoOrder(g: NeatGenome): number[] {
  const ids = g.nodes.map((n) => n.id).sort((a, b) => a - b);
  const indeg = new Map<number, number>();
  const outAdj = new Map<number, number[]>();
  for (const id of ids) {
    indeg.set(id, 0);
    outAdj.set(id, []);
  }
  for (const c of g.connections) {
    if (!c.enabled) continue;
    outAdj.get(c.inNode)!.push(c.outNode);
    indeg.set(c.outNode, (indeg.get(c.outNode) ?? 0) + 1);
  }
  // Очередь стартует с узлов без входящих (входы и «сироты»), в порядке id.
  const queue = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
  const order: number[] = [];
  const isInput = (id: number) => id < NUM_INPUTS;
  while (queue.length) {
    const id = queue.shift()!;
    if (!isInput(id)) order.push(id);
    for (const nxt of outAdj.get(id)!.slice().sort((a, b) => a - b)) {
      indeg.set(nxt, (indeg.get(nxt) ?? 0) - 1);
      if ((indeg.get(nxt) ?? 0) === 0) queue.push(nxt);
    }
  }
  return order;
}

/** Размер генома для теста усложнения (узлы + включённые связи). */
export function brainComplexity(g: NeatGenome): { nodes: number; connections: number } {
  return { nodes: g.nodes.length, connections: g.connections.filter((c) => c.enabled).length };
}
