import Constants from 'expo-constants';
import { Platform } from 'react-native';

/**
 * Runtime configuration.
 *
 * The API base URL cannot be `localhost` on a device: `localhost` there means the
 * phone itself. Resolution order is
 *
 *   1. `EXPO_PUBLIC_API_URL` — an explicit override baked in at build time
 *   2. `extra.apiBaseUrl`    — set in app.json for an EAS profile
 *   3. the LAN IP of the dev machine, discovered from the Expo host URI
 *   4. `10.0.2.2` on the Android emulator (the host loopback)
 *   5. `localhost` on web and the iOS simulator
 *
 * so `npx expo start` works against a locally running API with no config at all.
 */

const API_PREFIX = '/api/v1';

type ExpoConfigExtra = {
  apiBaseUrl?: string;
  environment?: string;
};

function readExtra(): ExpoConfigExtra {
  const config = Constants.expoConfig as { extra?: ExpoConfigExtra } | undefined;
  return config?.extra ?? {};
}

/** Pull the dev machine's LAN IP out of the Expo host URI (`exp://192.168.1.7:8081`). */
function lanHostFromExpo(): string | null {
  const hostUri =
    (Constants.expoConfig?.hostUri as string | undefined) ??
    (Constants.manifest2?.extra?.expoGo?.debuggerHost as string | undefined) ??
    null;

  if (!hostUri) return null;
  const host = hostUri.split('/')[0]?.split(':')[0];
  return host && /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? host : null;
}

/**
 * The API *root*: no trailing slash and no `/api/v1` — the prefix is appended
 * below, and pasting the full API URL (a common slip) would otherwise produce
 * `/api/v1/api/v1/...` and a 404 on every request.
 */
function cleanBaseUrl(value: string): string {
  return value
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/api\/v1$/i, '');
}

function resolveApiBaseUrl(): string {
  // Must be read as the literal `process.env.EXPO_PUBLIC_API_URL`: Expo inlines
  // it into the bundle at build time (on Vercel, from the project's env vars).
  const override = process.env.EXPO_PUBLIC_API_URL;
  if (override?.trim()) return cleanBaseUrl(override);

  const fromExtra = readExtra().apiBaseUrl;
  if (fromExtra?.trim()) return cleanBaseUrl(fromExtra);

  const lan = lanHostFromExpo();
  if (lan) return `http://${lan}:4000`;

  if (Platform.OS === 'android') return 'http://10.0.2.2:4000';

  return 'http://localhost:4000';
}

export const config = {
  /** Root of the API, no trailing slash. */
  apiBaseUrl: resolveApiBaseUrl(),
  /** Versioned endpoint prefix. */
  apiPrefix: API_PREFIX,
  /** Full URL used by the HTTP client. */
  apiUrl: `${resolveApiBaseUrl().replace(/\/+$/, '')}${API_PREFIX}`,

  /** Request timeouts — AI endpoints get a longer budget. */
  timeoutMs: 20_000,
  aiTimeoutMs: 90_000,
  uploadTimeoutMs: 120_000,

  /** Scan polling cadence and give-up point. */
  scanPollIntervalMs: 1_500,
  scanPollTimeoutMs: 90_000,

  /** Deep-link scheme declared in app.json. */
  scheme: 'platematch',

  environment: readExtra().environment ?? (__DEV__ ? 'development' : 'production'),
  isDev: __DEV__,
} as const;

/** Absolute URL for a path relative to the API root. */
export function apiUrlFor(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${config.apiBaseUrl.replace(/\/+$/, '')}${normalized}`;
}

/** Absolute URL for a path under `/api/v1`. */
export function endpointUrl(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${config.apiUrl}${normalized}`;
}

export default config;
