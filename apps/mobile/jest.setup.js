/**
 * Test bootstrap.
 *
 * Native modules that Jest cannot load are replaced with light stubs. Each stub
 * preserves the real API surface used by the app so a test that exercises a
 * component still goes through the same code path.
 */

/* eslint-disable no-undef */

jest.mock('react-native-mmkv', () => {
  const store = new Map();
  return {
    MMKV: jest.fn().mockImplementation(() => ({
      set: (key, value) => store.set(key, String(value)),
      getString: (key) => store.get(key),
      getNumber: (key) => {
        const raw = store.get(key);
        return raw === undefined ? undefined : Number(raw);
      },
      getBoolean: (key) => {
        const raw = store.get(key);
        return raw === undefined ? undefined : raw === 'true';
      },
      delete: (key) => store.delete(key),
      contains: (key) => store.has(key),
      getAllKeys: () => [...store.keys()],
      clearAll: () => store.clear(),
    })),
    useMMKVString: () => [undefined, jest.fn()],
  };
});

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn().mockResolvedValue(undefined),
  notificationAsync: jest.fn().mockResolvedValue(undefined),
  selectionAsync: jest.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));

jest.mock('expo-camera', () => ({
  CameraView: 'CameraView',
  useCameraPermissions: () => [{ granted: true, canAskAgain: true }, jest.fn().mockResolvedValue({ granted: true })],
  requestCameraPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
}));

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
  requestPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
  getExpoPushTokenAsync: jest.fn().mockResolvedValue({ data: 'ExponentPushToken[test]' }),
  setNotificationHandler: jest.fn(),
  scheduleNotificationAsync: jest.fn().mockResolvedValue('notification-id'),
  cancelAllScheduledNotificationsAsync: jest.fn().mockResolvedValue(undefined),
  AndroidImportance: { MAX: 5, HIGH: 4, DEFAULT: 3 },
}));

jest.mock('expo-localization', () => ({
  getLocales: () => [{ languageTag: 'en-US', languageCode: 'en', regionCode: 'US', textDirection: 'ltr' }],
  getCalendars: () => [{ calendar: 'gregorian', timeZone: 'UTC' }],
}));

jest.mock('expo-constants', () => ({
  default: { expoConfig: { extra: { apiBaseUrl: 'http://localhost:4000' } } },
}));

jest.mock('react-native/Libraries/Animated/NativeAnimatedHelper');

// Silence the act() warnings that come from react-query flushing microtasks.
const originalError = console.error;
console.error = (...args) => {
  if (typeof args[0] === 'string' && args[0].includes('not wrapped in act')) return;
  originalError(...args);
};
