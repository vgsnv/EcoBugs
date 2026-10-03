const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
/**
 * Ядро (core/src, core/sim) написано под нативный TS-раннер Node, который требует
 * ЯВНЫХ расширений в импортах (`./world.ts`). Metro по умолчанию их так не резолвит,
 * поэтому для относительных импортов срезаем хвост `.ts`/`.tsx` перед резолвом —
 * тогда один и тот же core собирается и в Node (headless-тесты), и в RN.
 */
const config = {
  resolver: {
    // world-1/ и world-2/ — отдельные браузерные пакеты; RN-сборке они не нужны.
    blockList: [/\/world-[12]\/.*/],
    resolveRequest: (context, moduleName, platform) => {
      const stripped = moduleName.startsWith('.')
        ? moduleName.replace(/\.(ts|tsx)$/, '')
        : moduleName;
      return context.resolveRequest(context, stripped, platform);
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
