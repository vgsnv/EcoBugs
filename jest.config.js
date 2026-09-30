module.exports = {
  preset: '@react-native/jest-preset',
  // world/ — отдельный браузерный пакет со своим раннером (node --test).
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/world/'],
};
