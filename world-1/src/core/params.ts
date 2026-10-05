/**
 * Параметры мира (спецификация, раздел «Параметры»): генератор задаёт
 * стартовое содержимое, законы можно менять в живом мире. Значения по
 * умолчанию предварительные — их подбираем, глядя на мир в песочнице.
 */
import { DISH_AREA, MAX_SPOTS } from './constants.ts';

/** Заготовки планировки перегородок (данные — в partitions.ts). */

/** Доли чашки под каждой градацией вязкости; в сумме 1. */
export interface ViscosityShares {
  water: number;
  shallows: number;
  land: number;
}

/** Форма ритма солнца: плавная волна; «день и ночь» (плато и переход); несимметричная (рост и спад разной длины). */
export type RhythmShape = 'wave' | 'daynight' | 'skewed';

export interface WorldParams {
  /** Вся случайность мира. */
  seed: number;
  shape: 'rectangle' | 'circle';
  /** Ширина / высота; у круга всегда 1. */
  aspectRatio: number;
  /** Свет в тени и добавка света в пятне сверх тени, лм/см²: в пятне — их сумма. */
  lightShadow: number;
  lightExtra: number;
  /** Пятна света: сколько и какой площади (от–до, см²); размер каждого — случайный в диапазоне. */
  spotCount: number;
  spotAreaMin: number;
  spotAreaMax: number;
  /** Дрейф пятен: за сколько часов пересекают чашу; 0 — свет стоит. */
  driftCross: number;
  /** В среднем раз в сколько часов дрейф поворачивает в случайную сторону; 0 — не поворачивает. */
  driftTurn: number;
  /** Размах ритма солнца: свет ходит от (1 − размах) до (1 + размах) среднего, [0, 0.9]. */
  sunRhythm: number;
  /** Период ритма солнца, шагов. */
  sunPeriod: number;
  /** Форма ритма; для «дня и ночи» — доля периода на переход, для несимметричной — доля на рост. */
  rhythmShape: RhythmShape;
  rhythmTransition: number;
  rhythmRise: number;
  /** Температура на фоне — общий уровень мутаций; строго больше нуля. */
  baseTemperature: number;
  /** Насколько в пятне теплее, чем на фоне. */
  spotHeat: number;
  /** Генератор суши: массивы (сколько и какой площади, см²), изрезанность берега 0…1, внутренние моря (сколько и какую долю площади своего массива занимают), ширина отмели, см. */
  landCount: number;
  landAreaMin: number;
  landAreaMax: number;
  coastRoughness: number;
  seaCount: number;
  seaShare: number;
  shelfWidth: number;
  /** Запас минерала: общее количество в мире — в среднем на единицу свободной площади чашки. */
  mineralStock: number;
  /** Средний порог давления недр — доля запаса: выше — извержения реже и крупнее. */
  eruptionPressure: number;
  /** Для знатоков: отклик среды на свет (×1 — обычный), сопротивление отмели и суши (вода — 1), потеря света на 1000 г/м² раствора, неровность края пятна, полный цикл «дыхания» края, ч. */
  driftResponse: number;
  resistanceShallows: number;
  resistanceLand: number;
  turbidityLoss: number;
  spotWobble: number;
  spotBreath: number;
  /** Для знатоков — свойства дна: порог срыва грунта, мм/с (залежи размываются вдвое более быстрым течением); устойчивый склон, уровней на см; за сколько минут оседает половина минерала в стоячей воде. */
  groundThreshold: number;
  slopeLimit: number;
  settleHalf: number;
  /** Тектоника: сколько дна меняет уровень за час, см²; в каком диапазоне уровней (0 — стеклянное дно, 2 — суша) поднимаются и опускаются участки. */
  tectonicVolume: number;
  heightMin: number;
  heightMax: number;
}

export const DEFAULT_PARAMS: Readonly<WorldParams> = Object.freeze({
  seed: 1,
  shape: 'rectangle',
  aspectRatio: 4 / 3,
  lightShadow: 20,
  lightExtra: 80,
  spotCount: 8,
  spotAreaMin: 500,
  spotAreaMax: 1500,
  driftCross: 200,
  driftTurn: 24,
  sunRhythm: 0.4,
  sunPeriod: 150000,
  rhythmShape: 'wave',
  rhythmTransition: 0.15,
  rhythmRise: 0.5,
  baseTemperature: 1,
  spotHeat: 1,
  landCount: 12,
  landAreaMin: 100,
  landAreaMax: 500,
  coastRoughness: 0.35,
  seaCount: 0,
  seaShare: 0.25,
  shelfWidth: 5,
  mineralStock: 1,
  eruptionPressure: 0.15,
  driftResponse: 1,
  resistanceShallows: 3,
  resistanceLand: 9,
  turbidityLoss: 0.1,
  spotWobble: 0.15,
  spotBreath: 6,
  groundThreshold: 1.8,
  slopeLimit: 0.44,
  settleHalf: 29,
  tectonicVolume: 170,
  heightMin: 0.1,
  heightMax: 2.2,
});

/** Параметры по умолчанию с заданным сидом и частичными переопределениями. */
export function makeParams(overrides: Partial<WorldParams> = {}): WorldParams {
  return {
    ...DEFAULT_PARAMS,
    ...overrides,
    ...(overrides.shape === 'circle' ? { aspectRatio: 1 } : {}),
  };
}

/** Названия параметров для сообщений об ошибках. */
export const PARAM_LABELS: Readonly<Record<string, string>> = {
  'seed': 'Сид',
  'shape': 'Форма чашки',
  'aspectRatio': 'Пропорции чашки',
  'lightShadow': 'Свет в тени',
  'lightExtra': 'Пятно ярче тени на',
  'spotCount': 'Число пятен',
  'spotAreaMin': 'Площадь пятен от',
  'spotAreaMax': 'Площадь пятен до',
  'driftCross': 'Дрейф пятен',
  'driftTurn': 'Смена направления дрейфа',
  'rhythmShape': 'Форма ритма солнца',
  'rhythmTransition': 'Переход дня и ночи',
  'rhythmRise': 'Доля роста ритма',
  'baseTemperature': 'Базовая температура',
  'spotHeat': 'Нагрев в пятнах',
  'landCount': 'Массивы суши',
  'landAreaMin': 'Площадь массивов от',
  'landAreaMax': 'Площадь массивов до',
  'coastRoughness': 'Изрезанность берега',
  'seaCount': 'Внутренние моря',
  'seaShare': 'Размер внутренних морей',
  'shelfWidth': 'Ширина отмели',
  'sunRhythm': 'Размах ритма солнца',
  'sunPeriod': 'Период ритма солнца',
  'mineralStock': 'Запас минерала',
  'eruptionPressure': 'Давление извержения',
  'driftResponse': 'Отклик среды на свет',
  'resistanceShallows': 'Сопротивление отмели',
  'resistanceLand': 'Сопротивление суши',
  'turbidityLoss': 'Мутность',
  'spotWobble': 'Неровность края пятна',
  'spotBreath': 'Дыхание края пятна',
  'groundThreshold': 'Порог срыва грунта',
  'slopeLimit': 'Устойчивый склон',
  'settleHalf': 'Оседание минерала',
  'tectonicVolume': 'Тектоника: объём',
  'heightMin': 'Тектоника: высоты от',
  'heightMax': 'Тектоника: высоты до',
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
  if (p.shape !== 'rectangle' && p.shape !== 'circle') errors.push('Форма чашки: ожидается прямоугольник или круг');
  inRange('aspectRatio', p.aspectRatio, 0.25, 4);
  if (p.shape === 'circle' && p.aspectRatio !== 1) errors.push('Пропорции круглой чашки: ожидается 1:1');
  inRange('lightShadow', p.lightShadow, 0, 10000);
  inRange('lightExtra', p.lightExtra, 0, 10000);
  if (p.lightShadow + p.lightExtra <= 0) errors.push('Свет: в пятне должен быть хоть какой-то свет');
  if (!Number.isInteger(p.spotCount) || p.spotCount < 0 || p.spotCount > MAX_SPOTS) errors.push(`Число пятен: ожидается целое от 0 до ${MAX_SPOTS}`);
  inRange('spotAreaMin', p.spotAreaMin, 1, DISH_AREA / 100);
  inRange('spotAreaMax', p.spotAreaMax, 1, DISH_AREA / 100);
  if (p.spotAreaMax < p.spotAreaMin) errors.push('Площадь пятен: «до» меньше, чем «от»');
  inRange('driftCross', p.driftCross, 0, 100000);
  inRange('driftTurn', p.driftTurn, 0, 100000);
  if (p.rhythmShape !== 'wave' && p.rhythmShape !== 'daynight' && p.rhythmShape !== 'skewed') errors.push('Форма ритма солнца: ожидается волна, день и ночь или несимметричная');
  inRange('rhythmTransition', p.rhythmTransition, 0.01, 0.5);
  inRange('rhythmRise', p.rhythmRise, 0.05, 0.95);
  // Строго больше нуля: сила мутаций «не до нуля» даже на фоне.
  inRange('baseTemperature', p.baseTemperature, 0, 100, true);
  inRange('spotHeat', p.spotHeat, 0, 100);
  if (!Number.isInteger(p.landCount) || p.landCount < 0 || p.landCount > 200) errors.push('Массивы суши: ожидается целое от 0 до 200');
  inRange('landAreaMin', p.landAreaMin, 1, DISH_AREA / 100);
  inRange('landAreaMax', p.landAreaMax, 1, DISH_AREA / 100);
  if (p.landAreaMax < p.landAreaMin) errors.push('Площадь массивов: «до» меньше, чем «от»');
  inRange('coastRoughness', p.coastRoughness, 0, 1);
  if (!Number.isInteger(p.seaCount) || p.seaCount < 0 || p.seaCount > 50) errors.push('Внутренние моря: ожидается целое от 0 до 50');
  inRange('seaShare', p.seaShare, 0, 0.9);
  inRange('shelfWidth', p.shelfWidth, 0, 100);
  inRange('sunRhythm', p.sunRhythm, 0, 0.9);
  inRange('sunPeriod', p.sunPeriod, 1000, 100_000_000);
  inRange('mineralStock', p.mineralStock, 0, 100, true);
  inRange('eruptionPressure', p.eruptionPressure, 0.01, 0.9);
  inRange('driftResponse', p.driftResponse, 0, 100);
  inRange('resistanceShallows', p.resistanceShallows, 0.1, 100);
  inRange('resistanceLand', p.resistanceLand, 0.1, 100);
  inRange('turbidityLoss', p.turbidityLoss, 0, 0.95);
  inRange('spotWobble', p.spotWobble, 0, 0.35);
  inRange('spotBreath', p.spotBreath, 0.1, 1000);
  inRange('groundThreshold', p.groundThreshold, 0.01, 1000);
  inRange('slopeLimit', p.slopeLimit, 0.01, 100);
  inRange('settleHalf', p.settleHalf, 0.1, 100000);
  inRange('tectonicVolume', p.tectonicVolume, 0, 1e6);
  inRange('heightMin', p.heightMin, 0, 5);
  inRange('heightMax', p.heightMax, 0, 5);
  if (p.heightMax < p.heightMin) errors.push('Тектоника: высоты «до» ниже, чем «от»');

  return errors;
}
