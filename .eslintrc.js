module.exports = {
  root: true,
  extends: '@react-native',
  // world/ — отдельный браузерный пакет, линтится своими средствами.
  ignorePatterns: ['world/'],
};
