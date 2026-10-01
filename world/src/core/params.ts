/**
 * Параметры мира (спецификация, раздел «Параметры»). Задаются при сотворении
 * и больше не меняются. Значения по умолчанию предварительные — их подбираем,
 * глядя на мир в песочнице.
 */

/** Заготовки планировки перегородок (данные — в partitions.ts). */

/** Доли чашки под каждой градацией вязкости; в сумме 1. */
export interface ViscosityShares {
  water: number;
  shallows: number;
  land: number;
}

export interface WorldParams {
  /** Вся случайность мира. */
  seed: number;
  /** Яркость света в пятнах. */
  sun: number;
  /** Скорость дрейфа света: множитель общего сдвига карты и собственного дрейфа пятен; 0 — свет стоит. */
  lightDrift: number;
  /** Размах ритма солнца: сила солнца ходит от (1 − размах) до (1 + размах) от параметра «Солнце», [0, 0.9]. */
  sunRhythm: number;
  /** Период ритма солнца, шагов. */
  sunPeriod: number;
  /** Свет фона как доля от света в пятнах, (0, 1). */
  backgroundLevel: number;
  /** Средняя доля карты света, занятая пятнами, (0, 1). */
  illumination: number;
  /** Средний радиус пятна света в единицах мира. */
  spotSize: number;
  /** Температура на фоне — общий уровень мутаций; строго больше нуля. */
  baseTemperature: number;
  /** Насколько в пятне теплее, чем на фоне. */
  spotHeat: number;
  /** Какую часть чашки занимают вода, отмель и суша. */
  viscosityShares: ViscosityShares;
  /** Средний размер зон вязкости в единицах мира. */
  viscosityZoneSize: number;
  /** Запас минерала: общее количество в мире — в среднем на единицу свободной площади чашки. */
  mineralStock: number;
  /** Скорость местности: множитель намыва, размыва, подвижек и толчков; 0 — местность неподвижна. */
  terrainSpeed: number;
  /** Средний промежуток между толчками, шагов. */
  quakeInterval: number;
}

export const DEFAULT_PARAMS: Readonly<WorldParams> = Object.freeze({
  seed: 1,
  sun: 1,
  lightDrift: 1,
  sunRhythm: 0.4,
  sunPeriod: 150000,
  backgroundLevel: 0.2,
  illumination: 0.3,
  spotSize: 60,
  baseTemperature: 1,
  spotHeat: 1,
  viscosityShares: Object.freeze({ water: 0.6, shallows: 0.25, land: 0.15 }),
  viscosityZoneSize: 120,
  mineralStock: 1,
  terrainSpeed: 1,
  quakeInterval: 400000,
});

/** Параметры по умолчанию с заданным сидом и частичными переопределениями. */
export function makeParams(overrides: Partial<WorldParams> = {}): WorldParams {
  return {
    ...DEFAULT_PARAMS,
    ...overrides,
    viscosityShares: { ...DEFAULT_PARAMS.viscosityShares, ...overrides.viscosityShares },
  };
}

/** Названия параметров для сообщений об ошибках. */
export const PARAM_LABELS: Readonly<Record<string, string>> = {
  'seed': 'Сид',
  'sun': 'Солнце',
  'backgroundLevel': 'Яркость фона',
  'illumination': 'Освещённость',
  'spotSize': 'Размер пятен',
  'baseTemperature': 'Базовая температура',
  'spotHeat': 'Нагрев в пятнах',
  'viscosityZoneSize': 'Размер зон вязкости',
  'lightDrift': 'Скорость дрейфа света',
  'sunRhythm': 'Размах ритма солнца',
  'sunPeriod': 'Период ритма солнца',
  'mineralStock': 'Запас минерала',
  'terrainSpeed': 'Скорость местности',
  'quakeInterval': 'Промежуток между толчками',
  'viscosityShares': 'Доли вязкости',
  'viscosityShares.water': 'Доля воды',
  'viscosityShares.shallows': 'Доля отмели',
  'viscosityShares.land': 'Доля суши',
};

/**
 * Проверка параметров. Возвращает список ошибок на русском; пустой — всё верно.
 * Используется и при создании мира, и при загрузке файла.
 */
export function validateParams(p: WorldParams): string[] {
  const errors: string[] = [];
  const finite = (name: string, v: unknown): v is number => {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      errors.push(`${PARAM_LABELS[name] ?? name}: ожидается число`);
      return false;
    }
    return true;
  };
  const inRange = (name: string, v: unknown, min: number, max: number, open = false) => {
    if (!finite(name, v)) return;
    const ok = open ? v > min && v < max : v >= min && v <= max;
    if (!ok) errors.push(`${PARAM_LABELS[name] ?? name}: ${v} вне ${open ? '(' : '['}${min}, ${max}${open ? ')' : ']'}`);
  };

  if (!Number.isInteger(p.seed) || p.seed < 0 || p.seed > 0xffffffff) {
    errors.push(`Сид: ожидается целое от 0 до ${0xffffffff}`);
  }
  inRange('sun', p.sun, 0, 100, true);
  inRange('backgroundLevel', p.backgroundLevel, 0, 1, true);
  inRange('illumination', p.illumination, 0, 1, true);
  inRange('spotSize', p.spotSize, 1, 10000);
  // Строго больше нуля: сила мутаций «не до нуля» даже на фоне.
  inRange('baseTemperature', p.baseTemperature, 0, 100, true);
  inRange('spotHeat', p.spotHeat, 0, 100);
  inRange('viscosityZoneSize', p.viscosityZoneSize, 1, 10000);
  inRange('lightDrift', p.lightDrift, 0, 100);
  inRange('sunRhythm', p.sunRhythm, 0, 0.9);
  inRange('sunPeriod', p.sunPeriod, 1000, 100_000_000);
  inRange('mineralStock', p.mineralStock, 0, 100, true);
  inRange('terrainSpeed', p.terrainSpeed, 0, 100);
  inRange('quakeInterval', p.quakeInterval, 1000, 1e9);

  const s = p.viscosityShares;
  if (typeof s !== 'object' || s === null) {
    errors.push('Доли вязкости: ожидается объект');
  } else {
    inRange('viscosityShares.water', s.water, 0, 1);
    inRange('viscosityShares.shallows', s.shallows, 0, 1);
    inRange('viscosityShares.land', s.land, 0, 1);
    const sum = s.water + s.shallows + s.land;
    if (Math.abs(sum - 1) > 1e-6) errors.push(`Доли вязкости: сумма долей ${sum}, а должна быть 1`);
    if (s.land > 0 && !(s.shallows > 0)) errors.push('Доли вязкости: суша без отмели невозможна — суша отделена от воды отмелью');
  }
  return errors;
}
