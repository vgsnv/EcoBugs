module.exports = {
  preset: '@react-native/jest-preset',
  // Браузерные миры имеют отдельные раннеры проверок.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/world-1/', '<rootDir>/world-2/'],
};
