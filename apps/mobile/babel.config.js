module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      // Reanimated's worklet transform must stay LAST in the plugin list.
      'react-native-reanimated/plugin',
    ],
  };
};
