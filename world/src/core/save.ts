/**
 * Файл мира: JSON с меткой формата, версией, параметрами, номером шага и
 * контрольной суммой. Карты, перегородки и положение света восстанавливаются
 * из параметров и номера шага, поэтому загруженный мир продолжает жить так же,
 * как исходный.
 */
import { makeParams, validateParams, type WorldParams } from './params.ts';
import { createWorld, worldHash, type World } from './world.ts';

export const WORLD_FILE_FORMAT = 'ecobugs-world';
/** Версия формата файла мира. Растёт при несовместимых изменениях. */
export const WORLD_FORMAT_VERSION = 6;

/** Прежние версии формата и почему они больше не читаются. */
const OLD_FORMATS: Record<number, string> = {
  1: 'тогда размер чашки был параметром, теперь чашка всегда 1600×1200',
  2: 'тогда планировка была параметром, теперь её выбирает сид',
  3: 'тогда в мире не было сноса',
  4: 'тогда в мире не было минерала',
  5: 'тогда извержения были мгновенными',
};

export interface MineralFile {
  depths: number;
  /** Для каждого вулкана: номер следующего извержения, его шаг; идёт ли извержение (0/1), до какого шага, выброс за шаг, сколько осталось. */
  volcanoes: [number, number, number, number, number, number][];
  /** Растворённый минерал по клеткам: Float64, little-endian, base64. */
  field: string;
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
      volcanoes: world.mineral.volcanoes.map((v) => [v.k, v.next, v.active ? 1 : 0, v.until, v.rate, v.left]),
      field: toBase64(new Uint8Array(world.mineral.field.buffer.slice(0))),
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
    backgroundLevel: raw.backgroundLevel as number,
    illumination: raw.illumination as number,
    spotSize: raw.spotSize as number,
    baseTemperature: raw.baseTemperature as number,
    spotHeat: raw.spotHeat as number,
    baseViscosity: raw.baseViscosity as number,
    viscosityShares: { water: shares.water as number, shallows: shares.shallows as number, land: shares.land as number },
    viscosityZoneSize: raw.viscosityZoneSize as number,
    driftStrength: raw.driftStrength as number,
    mineralStock: raw.mineralStock as number,
    volcanoCount: raw.volcanoCount as number,
    eruptionInterval: raw.eruptionInterval as number,
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
  const mineralProblems = restoreMineral(world, data.mineral);
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
  if (!Array.isArray(raw.volcanoes) || raw.volcanoes.length !== m.volcanoes.length) return [`Вулканы: ожидается ${m.volcanoes.length}`];
  if (typeof raw.field !== 'string') return ['Нет поля минерала'];
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(raw.field);
  } catch {
    return ['Поле минерала повреждено'];
  }
  if (bytes.length !== m.field.length * 8) return ['Поле минерала другого размера'];
  const field = new Float64Array(bytes.buffer, bytes.byteOffset, m.field.length).slice();
  for (const [i, entry] of (raw.volcanoes as unknown[]).entries()) {
    if (!Array.isArray(entry) || entry.length !== 6 || !entry.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0)
      || ![0, 1, 3].every((n) => Number.isSafeInteger(entry[n])) || (entry[2] !== 0 && entry[2] !== 1)) {
      return [`Вулкан ${i + 1}: ожидаются шесть неотрицательных чисел`];
    }
    const v = m.volcanoes[i];
    [v.k, v.next] = [entry[0] as number, entry[1] as number];
    v.active = entry[2] === 1;
    [v.until, v.rate, v.left] = [entry[3] as number, entry[4] as number, entry[5] as number];
  }
  m.field = field;
  m.depths = raw.depths;
  return [];
}

