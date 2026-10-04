module.exports = {
  presets: ['module:@react-native/babel-preset'],
  // Reanimated 4 использует worklets-плагин; ОБЯЗАН быть последним в списке.
  plugins: ['react-native-worklets/plugin'],
};
