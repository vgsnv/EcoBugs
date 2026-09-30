/**
 * Ядро неживой природы: чистые правила мира без DOM.
 * Спецификация — docs/spec/world.md.
 */

/** Версия формата файла мира. Растёт при несовместимых изменениях. */
export const WORLD_FORMAT_VERSION = 1;

export * from './prng.ts';
export * from './noise.ts';
export * from './params.ts';
export * from './constants.ts';
export * from './light.ts';
export * from './temperature.ts';
export * from './viscosity.ts';
export * from './world.ts';
