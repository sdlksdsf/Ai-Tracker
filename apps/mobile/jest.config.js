module.exports = {
  preset: 'jest-expo',
  testEnvironment: 'node',
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@sentry/react-native|native-base|react-native-svg|@tanstack/.*|moti|zustand|i18next|react-i18next)',
  ],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    '^@platematch/shared$': '<rootDir>/../../packages/shared/src/index.ts',
    '^@platematch/shared/(.*)$': '<rootDir>/../../packages/shared/src/$1',
  },
  collectCoverageFrom: [
    'components/**/*.{ts,tsx}',
    'lib/**/*.{ts,tsx}',
    'stores/**/*.{ts,tsx}',
    'theme/**/*.{ts,tsx}',
    '!**/*.d.ts',
  ],
  testPathIgnorePatterns: ['/node_modules/', '/android/', '/ios/', '/.expo/'],
};
