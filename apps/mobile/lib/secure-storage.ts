import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { kv } from './kv.js';

/**
 * Secret storage.
 *
 * Tokens live in the iOS Keychain / Android Keystore via expo-secure-store. That
 * module is native-only, so on web (and in tests) the tokens fall back to the
 * MMKV store. This is a deliberate, documented trade-off: the web build is a
 * preview target, not a place anyone signs in with a real account.
 *
 * Every call is async and never throws — a Keychain prompt the user dismisses
 * must not crash the app, it must just leave them signed out.
 */

const KEYS = {
  accessToken: 'platematch.access_token',
  refreshToken: 'platematch.refresh_token',
} as const;

const useNative = Platform.OS !== 'web';

async function read(key: string): Promise<string | null> {
  try {
    if (useNative) return await SecureStore.getItemAsync(key);
    return kv.get(key) ?? null;
  } catch {
    return null;
  }
}

async function write(key: string, value: string): Promise<void> {
  try {
    if (useNative) {
      await SecureStore.setItemAsync(key, value, {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
      return;
    }
    kv.set(key, value);
  } catch {
    // A rejected Keychain write leaves the user signed out; the caller shows the
    // auth screen rather than crashing.
  }
}

async function remove(key: string): Promise<void> {
  try {
    if (useNative) {
      await SecureStore.deleteItemAsync(key);
      return;
    }
    kv.delete(key);
  } catch {
    /* ignore */
  }
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export const secureStorage = {
  async getAccessToken(): Promise<string | null> {
    return read(KEYS.accessToken);
  },

  async getRefreshToken(): Promise<string | null> {
    return read(KEYS.refreshToken);
  },

  async getTokens(): Promise<TokenPair | null> {
    const [accessToken, refreshToken] = await Promise.all([read(KEYS.accessToken), read(KEYS.refreshToken)]);
    if (!accessToken || !refreshToken) return null;
    return { accessToken, refreshToken };
  },

  async setTokens(tokens: TokenPair): Promise<void> {
    await Promise.all([write(KEYS.accessToken, tokens.accessToken), write(KEYS.refreshToken, tokens.refreshToken)]);
  },

  /**
   * Rotate only the access token.
   *
   * The refresh endpoint returns a new pair; writing them one at a time would
   * leave a mismatched set if the app were killed in between.
   */
  async setAccessToken(accessToken: string): Promise<void> {
    await write(KEYS.accessToken, accessToken);
  },

  async clearTokens(): Promise<void> {
    await Promise.all([remove(KEYS.accessToken), remove(KEYS.refreshToken)]);
  },

  /** Generic secret slot, for anything that must not sit in MMKV on native. */
  setSecret: write,
  getSecret: read,
  deleteSecret: remove,
};

export default secureStorage;
