/**
 * Файл мира: JSON с меткой формата, версией, параметрами, номером шага и
 * контрольной суммой. Карты, перегородки и положение света восстанавливаются
 * из параметров и номера шага, поэтому загруженный мир продолжает жить так же,
 * как исходный.
 */
import { makeParams, validateParams, type WorldParams } from './params.ts';
import { applyTerrain, createWorld, worldHash, type World } from './world.ts';
import { movement } from './terrain.ts';
import { funnelFromNumbers, funnelNumbers, volcanoFromNumbers, volcanoNumbers } from './mineral.ts';

export const WORLD_FILE_FORMAT = 'ecobugs-world';
/** Версия формата файла мира. Растёт при несовместимых изменениях. */
export const WORLD_FORMAT_VERSION = 18;

/** Прежние версии формата и почему они больше не читаются. */
const OLD_FORMATS: Record<number, string> = {
  1: 'тогда размер чашки был параметром, теперь чашка всегда 1600×1200',
  2: 'тогда планировка была параметром, теперь её выбирает сид',
  3: 'тогда в мире не было сноса',
  4: 'тогда в мире не было минерала',
  5: 'тогда извержения были мгновенными',
  6: 'тогда солнце было ровным',
  7: 'тогда длина течений зависела от их силы',
  8: 'тогда местность не менялась',
  9: 'тогда извержения были короткими',
  10: 'тогда скорость дрейфа света не была параметром',
  11: 'тогда не было залежей и вулканы работали по расписанию',
  12: 'тогда течения пересчитывались вдвое чаще',
  13: 'тогда минерал при сотворении лежал в среде, а извержения не были ограничены',
  14: 'тогда вулканы стояли на местах из сида, а извержение выбрасывало минерал в круг постоянного радиуса',
  15: 'тогда течения были лучами от пятен, с параметрами силы и длины',
  16: 'тогда минерал уходил в недра без воронок, а вулкан выбрасывал одним залпом',
  17: 'тогда размыв и оседание учитывали только солнечное течение, а растекание и стекание могли выносить минерал из отверстий воронок',
};

export interface MineralFile {
  depths: number;
  /** Порог давления недр и сколько извержений было. */
  threshold: number;
  eruptions: number;
  /** Идёт ли стартовая серия извержений (0/1). */
  genesis: number;
  /** Сколько раз выбирали следующий вулкан; вулканы — числа volcanoNumbers (номер, место, мощность, стадия, её начало и конец, впервые ли готовится, извержений, идущее извержение). */
  births: number;
  volcanoes: number[][];
  /** Воронки — числа funnelNumbers (номер, ядро, радиус ареола, сила, сгущается ли, клетки отверстия); сколько родилось. */
  funnels: number[][];
  funnelBirths: number;
  /** Растворённый минерал по клеткам: Float64, little-endian, base64. */
  field: string;
}

export interface TerrainFile {
  /** Коренной грунт и залежи по клеткам: Float64, base64. */
  ground: string;
  deposits: string;
  /** Снимок уровня, по которому собрана карта: Float32, base64. */
  applied: string;
  nextMove: number;
  nextMoveStep: number;
  nextQuake: number;
  nextQuakeStep: number;
  /** Идущие подвижки и толчки: номер, толчок ли (0/1), шаг начала. */
  active: [number, number, number][];
}

export interface WorldFile {
  format: typeof WORLD_FILE_FORMAT;
  version: number;
  /** Когда сохранён — только для человека, в контрольную сумму не входит. */
  savedAt?: string;
  params: WorldParams;
  step: number;
  /** Минерал — состояние мира, из сида его не восстановить. */
  mineral: MineralFile;
  /** Местность — тоже состояние мира. */
  terrain: TerrainFile;
  /** Контрольная сумма состояния, шестнадцатеричная. */
  checksum: string;
}

export class WorldFileError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Файл мира не загружен:\n${problems.join('\n')}`);
    this.problems = problems;
  }
}

export function worldToFile(world: World, savedAt?: Date): WorldFile {
  return {
    format: WORLD_FILE_FORMAT,
    version: WORLD_FORMAT_VERSION,
    ...(savedAt ? { savedAt: savedAt.toISOString() } : {}),
    params: structuredClone(world.params),
    step: world.step,
    mineral: {
      depths: world.mineral.depths,
      threshold: world.mineral.threshold,
      eruptions: world.mineral.eruptions,
      genesis: world.mineral.genesis ? 1 : 0,
      births: world.mineral.births,
      volcanoes: world.mineral.volcanoes.map(volcanoNumbers),
      funnels: world.mineral.funnels.map(funnelNumbers),
      funnelBirths: world.mineral.funnelBirths,
      field: toBase64(new Uint8Array(world.mineral.field.buffer.slice(0))),
    },
    terrain: {
      ground: toBase64(new Uint8Array(world.terrain.ground.buffer.slice(0))),
      deposits: toBase64(new Uint8Array(world.terrain.deposits.buffer.slice(0))),
      applied: toBase64(new Uint8Array(world.terrain.applied.buffer.slice(0))),
      nextMove: world.terrain.nextMove,
      nextMoveStep: world.terrain.nextMoveStep,
      nextQuake: world.terrain.nextQuake,
      nextQuakeStep: world.terrain.nextQuakeStep,
      active: world.terrain.active.map((m) => [m.n, m.quake ? 1 : 0, m.start]),
    },
    checksum: worldHash(world).toString(16).padStart(8, '0'),
  };
}

export function serializeWorld(world: World, savedAt?: Date): string {
  return `${JSON.stringify(worldToFile(world, savedAt), null, 2)}\n`;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Параметры из файла: берутся только известные поля, типы проверяются дальше. */
function readParams(raw: unknown, problems: string[]): WorldParams | null {
  if (!isObject(raw)) {
    problems.push('Нет параметров мира');
    return null;
  }
  const shares = isObject(raw.viscosityShares) ? raw.viscosityShares : {};
  const defaults = makeParams();
  const params: WorldParams = {
    seed: raw.seed as number,
    sun: raw.sun as number,
    lightDrift: raw.lightDrift as number,
    sunRhythm: raw.sunRhythm as number,
    sunPeriod: raw.sunPeriod as number,
    backgroundLevel: raw.backgroundLevel as number,
    illumination: raw.illumination as number,
    spotSize: raw.spotSize as number,
    baseTemperature: raw.baseTemperature as number,
    spotHeat: raw.spotHeat as number,
    viscosityShares: { water: shares.water as number, shallows: shares.shallows as number, land: shares.land as number },
    viscosityZoneSize: raw.viscosityZoneSize as number,
    mineralStock: raw.mineralStock as number,
    terrainSpeed: raw.terrainSpeed as number,
    quakeInterval: raw.quakeInterval as number,
  };
  for (const key of Object.keys(defaults) as (keyof WorldParams)[]) {
    if (!(key in raw)) problems.push(`Нет параметра «${key}»`);
  }
  return params;
}

/** Разбор файла мира. Бросает WorldFileError со списком причин отказа. */
export function parseWorldFile(text: string): World {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new WorldFileError(['Это не JSON — файл повреждён или не является файлом мира']);
  }
  if (!isObject(data) || data.format !== WORLD_FILE_FORMAT) {
    throw new WorldFileError(['Это не файл мира: нет метки формата «ecobugs-world»']);
  }
  if (typeof data.version !== 'number' || !Number.isInteger(data.version)) {
    throw new WorldFileError(['Не указана версия формата']);
  }
  if (data.version > WORLD_FORMAT_VERSION) {
    throw new WorldFileError([`Файл сохранён более новой версией (формат v${data.version}, поддерживается до v${WORLD_FORMAT_VERSION})`]);
  }
  if (data.version in OLD_FORMATS) {
    throw new WorldFileError([`Файл старого формата v${data.version}: ${OLD_FORMATS[data.version as number]}`]);
  }
  if (data.version < 1) {
    throw new WorldFileError([`Неизвестная версия формата v${data.version}`]);
  }

  const problems: string[] = [];
  const params = readParams(data.params, problems);
  if (params) problems.push(...validateParams(params));
  const step = data.step;
  if (typeof step !== 'number' || !Number.isSafeInteger(step) || step < 0) {
    problems.push('Номер шага: ожидается неотрицательное целое');
  }
  if (typeof data.checksum !== 'string' || !/^[0-9a-f]{1,8}$/.test(data.checksum)) {
    problems.push('Нет контрольной суммы');
  }
  if (problems.length > 0 || !params) throw new WorldFileError(problems);

  const world = createWorld(params);
  world.step = step as number;
  const mineralProblems = [...restoreMineral(world, data.mineral), ...restoreTerrain(world, data.terrain)];
  if (mineralProblems.length > 0) throw new WorldFileError(mineralProblems);
  if (worldHash(world) !== parseInt(data.checksum as string, 16)) {
    throw new WorldFileError(['Контрольная сумма не совпадает — файл повреждён или изменён вручную']);
  }
  return world;
}

/** Состояние минерала из файла; возвращает причины отказа. */
function restoreMineral(world: World, raw: unknown): string[] {
  if (!isObject(raw)) return ['Нет состояния минерала'];
  const m = world.mineral;
  if (typeof raw.depths !== 'number' || !Number.isFinite(raw.depths) || raw.depths < 0) return ['Минерал в недрах: ожидается неотрицательное число'];
  if (!Array.isArray(raw.volcanoes)) return ['Нет вулканов'];
  if (!Number.isSafeInteger(raw.births) || (raw.births as number) < 0) return ['Счётчик вулканов повреждён'];
  if (typeof raw.field !== 'string') return ['Нет поля минерала'];
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(raw.field);
  } catch {
    return ['Поле минерала повреждено'];
  }
  if (bytes.length !== m.field.length * 8) return ['Поле минерала другого размера'];
  const field = new Float64Array(bytes.buffer, bytes.byteOffset, m.field.length).slice();
  const volcanoes = [];
  for (const [i, entry] of (raw.volcanoes as unknown[]).entries()) {
    const v = volcanoFromNumbers(m, world.params, entry);
    if (!v) return [`Вулкан ${i + 1}: ожидаются 14 чисел (номер, место, мощность, стадия…)`];
    volcanoes.push(v);
  }
  m.volcanoes = volcanoes;
  m.births = raw.births as number;
  if (!Array.isArray(raw.funnels) || !Number.isSafeInteger(raw.funnelBirths) || (raw.funnelBirths as number) < 0) return ['Нет воронок'];
  const funnels = [];
  for (const [i, entry] of (raw.funnels as unknown[]).entries()) {
    const f = funnelFromNumbers(m, entry);
    if (!f) return [`Воронка ${i + 1}: числа повреждены`];
    funnels.push(f);
  }
  m.funnels = funnels;
  m.funnelBirths = raw.funnelBirths as number;
  m.field = field;
  m.depths = raw.depths;
  if (typeof raw.threshold !== 'number' || !(raw.threshold > 0) || !Number.isSafeInteger(raw.eruptions) || (raw.genesis !== 0 && raw.genesis !== 1)) return ['Давление недр повреждено'];
  m.threshold = raw.threshold;
  m.eruptions = raw.eruptions as number;
  m.genesis = raw.genesis === 1;
  return [];
}

/** Местность из файла; возвращает причины отказа. */
function restoreTerrain(world: World, raw: unknown): string[] {
  if (!isObject(raw)) return ['Нет состояния местности'];
  const t = world.terrain;
  const ints = [raw.nextMove, raw.nextMoveStep, raw.nextQuake, raw.nextQuakeStep];
  if (!ints.every((x) => Number.isSafeInteger(x) && (x as number) >= 0)) return ['Местность: расписание подвижек повреждено'];
  if (typeof raw.ground !== 'string' || typeof raw.deposits !== 'string' || typeof raw.applied !== 'string' || !Array.isArray(raw.active)) return ['Местность: нет грунта, залежей или снимка'];
  let ground: Uint8Array, deposits: Uint8Array, applied: Uint8Array;
  try {
    ground = fromBase64(raw.ground);
    deposits = fromBase64(raw.deposits);
    applied = fromBase64(raw.applied);
  } catch {
    return ['Местность повреждена'];
  }
  if (ground.length !== t.ground.length * 8 || deposits.length !== t.deposits.length * 8 || applied.length !== t.applied.length * 4) return ['Местность другого размера'];
  const active = [];
  for (const entry of raw.active as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 3 || !entry.every((x) => Number.isSafeInteger(x) && x >= 0)) return ['Местность: подвижка повреждена'];
    active.push(movement(world.params.seed, entry[1] === 1, entry[0] as number, entry[2] as number));
  }
  t.ground = new Float64Array(ground.buffer, ground.byteOffset, t.ground.length).slice();
  t.deposits = new Float64Array(deposits.buffer, deposits.byteOffset, t.deposits.length).slice();
  [t.nextMove, t.nextMoveStep, t.nextQuake, t.nextQuakeStep] = ints as number[];
  t.active = active;
  applyTerrain(world, new Float32Array(applied.buffer, applied.byteOffset, t.applied.length).slice());
  return [];
}

