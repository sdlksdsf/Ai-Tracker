import { create } from 'zustand';
import * as Haptics from 'expo-haptics';
import { kv, StorageKeys } from '../lib/kv.js';

/**
 * Transient UI state.
 *
 * Toasts, bottom sheets and the haptics preference. Kept in a store rather than
 * component state because a toast is often raised from a mutation callback deep
 * inside a hook, with no component in scope to hold it.
 */

export type ToastTone = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
  id: string;
  message: string;
  tone: ToastTone;
  /** Optional action rendered as a trailing button. */
  action?: { label: string; onPress: () => void };
  durationMs: number;
}

export interface UiState {
  toasts: Toast[];
  /** Haptic feedback on taps and successes. Persisted so it survives a restart. */
  hapticsEnabled: boolean;
  /** Voice guidance during the cooking screen. */
  voiceEnabled: boolean;
  /** True while a full-screen operation (AI generation) is running. */
  busy: boolean;
  busyLabel: string | null;

  showToast(message: string, tone?: ToastTone, options?: { durationMs?: number; action?: Toast['action'] }): string;
  dismissToast(id: string): void;
  setHaptics(enabled: boolean): void;
  setVoice(enabled: boolean): void;
  setBusy(busy: boolean, label?: string | null): void;

  /** Fire haptic feedback if the user has not disabled it. */
  tap(): void;
  success(): void;
  warn(): void;
  error(): void;
}

let toastCounter = 0;

function nextToastId(): string {
  toastCounter += 1;
  return `toast-${Date.now()}-${toastCounter}`;
}

/**
 * Timers for auto-dismissal.
 *
 * Held outside the store: a timeout id is not serialisable state, and keeping it
 * here means dismissing a toast early can cancel its pending timer instead of
 * leaking one per toast.
 */
const toastTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleDismiss(id: string, durationMs: number, dismiss: (id: string) => void): void {
  const existing = toastTimers.get(id);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    toastTimers.delete(id);
    dismiss(id);
  }, durationMs);

  // Do not hold the JS thread open just to dismiss a toast.
  if (typeof timer === 'object' && 'unref' in timer) {
    (timer as { unref(): void }).unref();
  }

  toastTimers.set(id, timer);
}

/** Cancel every pending dismissal — used on sign-out and in tests. */
export function clearToastTimers(): void {
  for (const timer of toastTimers.values()) clearTimeout(timer);
  toastTimers.clear();
}

export const useUiStore = create<UiState>((set, get) => ({
  toasts: [],
  hapticsEnabled: kv.getBoolean(StorageKeys.theme) ?? true,
  voiceEnabled: true,
  busy: false,
  busyLabel: null,

  showToast(message, tone = 'info', options) {
    const id = nextToastId();
    const durationMs = options?.durationMs ?? (tone === 'error' ? 5000 : 3000);

    const toast: Toast = { id, message, tone, action: options?.action, durationMs };

    set((state) => ({
      // Cap the stack so a burst of failures cannot cover the whole screen;
      // the newest toast is the one worth reading.
      toasts: [...state.toasts.slice(-2), toast],
    }));

    if (tone === 'success') get().success();
    else if (tone === 'error') get().error();
    else if (tone === 'warning') get().warn();

    scheduleDismiss(id, durationMs, (toastId) => get().dismissToast(toastId));

    return id;
  },

  dismissToast(id) {
    const timer = toastTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      toastTimers.delete(id);
    }
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
  },

  setHaptics(enabled) {
    kv.setBoolean(StorageKeys.theme, enabled);
    set({ hapticsEnabled: enabled });
  },

  setVoice(enabled) {
    set({ voiceEnabled: enabled });
  },

  setBusy(busy, label = null) {
    set({ busy, busyLabel: busy ? label : null });
  },

  tap() {
    if (!get().hapticsEnabled) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
  },

  success() {
    if (!get().hapticsEnabled) return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
  },

  warn() {
    if (!get().hapticsEnabled) return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
  },

  error() {
    if (!get().hapticsEnabled) return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
  },
}));

/** Convenience for components that only need to raise a toast. */
export function toast(message: string, tone?: ToastTone, options?: { durationMs?: number; action?: Toast['action'] }): string {
  return useUiStore.getState().showToast(message, tone, options);
}

export default useUiStore;
