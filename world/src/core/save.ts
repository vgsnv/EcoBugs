/**
 * Файл мира: JSON с меткой формата, версией, параметрами, номером шага и
 * контрольной суммой. Карты, перегородки и положение света восстанавливаются
 * из параметров и номера шага, поэтому загруженный мир продолжает жить так же,
 * как исходный.
 */
import { makeParams, validateParams, type LayoutId, type WorldParams } from './params.ts';
import { createWorld, worldHash, type World } from './world.ts';

export const WORLD_FILE_FORMAT = 'ecobugs-world';
/** Версия формата файла мира. Растёт при несовместимых изменениях. */
export const WORLD_FORMAT_VERSION = 2;

export interface WorldFile {
  format: typeof WORLD_FILE_FORMAT;
  version: number;
  /** Когда сохранён — только для человека, в контрольную сумму не входит. */
  savedAt?: string;
  params: WorldParams;
  step: number;
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
    checksum: worldHash(world).toString(16).padStart(8, '0'),
  };
}

export function serializeWorld(world: World, savedAt?: Date): string {
  return `${JSON.stringify(worldToFile(world, savedAt), null, 2)}\n`;
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
    layout: raw.layout as LayoutId,
    sun: raw.sun as number,
    backgroundLevel: raw.backgroundLevel as number,
    illumination: raw.illumination as number,
    spotSize: raw.spotSize as number,
    baseTemperature: raw.baseTemperature as number,
    spotHeat: raw.spotHeat as number,
    baseViscosity: raw.baseViscosity as number,
    viscosityShares: { water: shares.water as number, shallows: shares.shallows as number, land: shares.land as number },
    viscosityZoneSize: raw.viscosityZoneSize as number,
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
  if (data.version === 1) {
    throw new WorldFileError(['Файл старого формата v1: тогда размер чашки был параметром, теперь чашка всегда 1600×1200']);
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
  if (worldHash(world) !== parseInt(data.checksum as string, 16)) {
    throw new WorldFileError(['Контрольная сумма не совпадает — файл повреждён или изменён вручную']);
  }
  return world;
}
