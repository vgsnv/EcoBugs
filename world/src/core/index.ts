/**
 * Ядро неживой природы: чистые правила мира без DOM.
 * Спецификация — docs/spec/world.md.
 */

/** Версия формата файла мира. Растёт при несовместимых изменениях. */
export const WORLD_FORMAT_VERSION = 1;

export * from './prng.ts';
export * from './noise.ts';
export * from './params.ts';
export * from './world.ts';
