import { Platform } from 'react-native';

/**
 * Key-value storage.
 *
 * `react-native-mmkv` is the fastest option on native (mmap-backed, synchronous,
 * no bridge), but it is a native module: it is unavailable on web and it breaks
 * any Jest run that has not mocked it. Everything therefore goes through this
 * module, which falls back to an in-memory store on those platforms.
 *
 * Secrets never come through here — see `lib/secure-storage.ts`, which uses
 * Keychain/Keystore via expo-secure-store.
 */

export interface KeyValueStore {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
  contains(key: string): boolean;
  getAllKeys(): string[];
  clearAll(): void;
}

class MemoryStore implements KeyValueStore {
  private readonly map = new Map<string, string>();

  getString(key: string): string | undefined {
    return this.map.get(key);
  }

  set(key: string, value: string): void {
    this.map.set(key, value);
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  contains(key: string): boolean {
    return this.map.has(key);
  }

  getAllKeys(): string[] {
    return [...this.map.keys()];
  }

  clearAll(): void {
    this.map.clear();
  }
}

function createNativeStore(): KeyValueStore | null {
  if (Platform.OS === 'web') return null;

  try {
    // Required dynamically so a missing native module fails here rather than at
    // import time, which would take the whole app down.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('react-native-mmkv') as { MMKV: new (options?: { id?: string }) => KeyValueStore };
    return new mod.MMKV({ id: 'platematch-store' });
  } catch {
    return null;
  }
}

const nativeStore = createNativeStore();
const fallback = new MemoryStore();

/** True when writes survive an app restart. False on web and in unit tests. */
export const isPersistent = nativeStore !== null;

const store: KeyValueStore = nativeStore ?? fallback;

// ---------------------------------------------------------------------------
// Typed helpers
// ---------------------------------------------------------------------------

export const kv = {
  get(key: string): string | undefined {
    try {
      return store.getString(key);
    } catch {
      return undefined;
    }
  },

  set(key: string, value: string): void {
    try {
      store.set(key, value);
    } catch {
      // A storage failure must never crash the app.
    }
  },

  delete(key: string): void {
    try {
      store.delete(key);
    } catch {
      /* ignore */
    }
  },

  contains(key: string): boolean {
    try {
      return store.contains(key);
    } catch {
      return false;
    }
  },

  allKeys(): string[] {
    try {
      return store.getAllKeys();
    } catch {
      return [];
    }
  },

  clear(): void {
    try {
      store.clearAll();
    } catch {
      /* ignore */
    }
  },

  // -- JSON ---------------------------------------------------------------

  getObject<T>(key: string): T | null {
    const raw = kv.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // A corrupt entry is worse than no entry — drop it so the next write wins.
      kv.delete(key);
      return null;
    }
  },

  setObject(key: string, value: unknown): void {
    try {
      kv.set(key, JSON.stringify(value));
    } catch {
      /* ignore circular / unserialisable values */
    }
  },

  // -- Scalars ------------------------------------------------------------

  getNumber(key: string): number | undefined {
    const raw = kv.get(key);
    if (raw === undefined) return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  },

  setNumber(key: string, value: number): void {
    kv.set(key, String(value));
  },

  getBoolean(key: string): boolean | undefined {
    const raw = kv.get(key);
    if (raw === undefined) return undefined;
    return raw === 'true';
  },

  setBoolean(key: string, value: boolean): void {
    kv.set(key, value ? 'true' : 'false');
  },
};

/** Namespaced keys, so a future `kv.clearNamespace('cache')` is possible. */
export const StorageKeys = {
  onboardingSeen: 'app:onboarding-seen',
  locale: 'app:locale',
  theme: 'app:theme',
  lastHomeRefresh: 'cache:home-refresh',
  pantryDraft: 'draft:pantry-item',
  groceryDraft: 'draft:grocery-item',
  scanHint: 'cache:scan-hint',
  pushToken: 'device:push-token',
  deviceId: 'device:id',
  cookingSession: (recipeId: string) => `session:cooking:${recipeId}`,
  recentSearches: 'cache:recent-searches',
  offlineQueue: 'queue:offline-writes',
} as const;

export default kv;
