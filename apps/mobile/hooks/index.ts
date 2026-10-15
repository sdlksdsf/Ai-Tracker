import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';

/**
 * Small hooks shared across screens.
 *
 * These are deliberately framework-light — no third-party utility library — so
 * behaviour is obvious and each one can be tested in isolation.
 */

/** Debounce a rapidly changing value, e.g. a search field. */
export function useDebouncedValue<T>(value: T, delayMs = 350): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}

/** Debounce a callback, cancelling any pending invocation on unmount. */
export function useDebouncedCallback<A extends unknown[]>(fn: (...args: A) => void, delayMs = 350): (...args: A) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(fn);
  latest.current = fn;

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return useMemo(
    () => (...args: A) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => latest.current(...args), delayMs);
    },
    [delayMs],
  );
}

/**
 * Track whether a component is still mounted.
 *
 * Async work started in an effect (a scan poll, an upload) must not call
 * `setState` after unmount — React logs a warning and, on some navigation
 * patterns, throws.
 */
export function useIsMounted(): () => boolean {
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  return () => mounted.current;
}

/** Run a function once on mount, ignoring re-renders. */
export function useMountEffect(effect: () => void | (() => void), deps: unknown[] = []): void {
  const didRun = useRef(false);

  useEffect(() => {
    if (didRun.current) return;
    didRun.current = true;
    effect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** Previous value of a variable — used to detect transitions. */
export function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T | undefined>(undefined);

  useEffect(() => {
    ref.current = value;
  }, [value]);

  return ref.current;
}

/** Toggle with a setter that also accepts a function, like `useState`. */
export function useToggle(initial = false): [boolean, (next?: boolean) => void] {
  const [value, setValue] = useState(initial);

  const toggle = (next?: boolean): void => {
    setValue((current) => (typeof next === 'boolean' ? next : !current));
  };

  return [value, toggle];
}

/** Count down from `seconds`, returning the remaining time and a start fn. */
export function useCountdown(initialSeconds = 0): {
  remaining: number;
  isRunning: boolean;
  start: (seconds?: number) => void;
  reset: () => void;
} {
  const [remaining, setRemaining] = useState(initialSeconds);
  const interval = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = (): void => {
    if (interval.current) {
      clearInterval(interval.current);
      interval.current = null;
    }
  };

  useEffect(() => stop, []);

  const start = (seconds = initialSeconds): void => {
    stop();
    setRemaining(seconds);
    interval.current = setInterval(() => {
      setRemaining((current) => {
        if (current <= 1) {
          stop();
          return 0;
        }
        return current - 1;
      });
    }, 1000);
  };

  const reset = (): void => {
    stop();
    setRemaining(0);
  };

  return { remaining, isRunning: interval.current !== null, start, reset };
}

/**
 * Poll a value until a predicate is satisfied.
 *
 * Drives the scan screen: `GET /scan/status/:id` every 1.5 s until the status
 * leaves `queued`/`processing`, or until the timeout elapses. Stops on unmount so
 * navigating away cannot keep a request loop alive.
 */
export interface PollOptions<T> {
  /** Return null to skip this tick. */
  fetcher: () => Promise<T | null>;
  /** Stop polling when this returns true. */
  done: (value: T) => boolean;
  intervalMs?: number;
  timeoutMs?: number;
  enabled?: boolean;
  onTimeout?: () => void;
  onError?: (error: unknown) => void;
}

export interface PollState<T> {
  value: T | null;
  isPolling: boolean;
  didTimeout: boolean;
  error: unknown;
  attempts: number;
}

export function usePolling<T>(options: PollOptions<T>): PollState<T> {
  const { fetcher, done, intervalMs = 1500, timeoutMs = 90_000, enabled = true, onTimeout, onError } = options;

  const [state, setState] = useState<PollState<T>>({
    value: null,
    isPolling: false,
    didTimeout: false,
    error: null,
    attempts: 0,
  });

  const mounted = useIsMounted();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deadline = useRef(0);
  const attempts = useRef(0);

  // Keep the latest callbacks without restarting the loop.
  const fetcherRef = useRef(fetcher);
  const doneRef = useRef(done);
  const onTimeoutRef = useRef(onTimeout);
  const onErrorRef = useRef(onError);
  fetcherRef.current = fetcher;
  doneRef.current = done;
  onTimeoutRef.current = onTimeout;
  onErrorRef.current = onError;

  useEffect(() => {
    if (!enabled) {
      setState((current) => ({ ...current, isPolling: false }));
      return;
    }

    deadline.current = Date.now() + timeoutMs;
    attempts.current = 0;
    setState((current) => ({ ...current, isPolling: true, didTimeout: false }));

    const tick = async (): Promise<void> => {
      if (!mounted()) return;

      if (Date.now() > deadline.current) {
        setState((current) => ({ ...current, isPolling: false, didTimeout: true }));
        onTimeoutRef.current?.();
        return;
      }

      attempts.current += 1;

      try {
        const value = await fetcherRef.current();
        if (!mounted()) return;

        setState((current) => ({ ...current, value: value ?? current.value, attempts: attempts.current, error: null }));

        if (value !== null && doneRef.current(value)) {
          setState((current) => ({ ...current, isPolling: false }));
          return;
        }
      } catch (error) {
        if (!mounted()) return;
        setState((current) => ({ ...current, error, attempts: attempts.current }));
        onErrorRef.current?.(error);
      }

      timer.current = setTimeout(() => void tick(), intervalMs);
    };

    void tick();

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // The loop is intentionally started only when `enabled` or the timings change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs, timeoutMs]);

  return state;
}

/** Group a list by a key function, preserving encounter order. */
export function useGroupBy<T, K extends string>(items: T[] | undefined, keyOf: (item: T) => K): Array<[K, T[]]> {
  return useMemo(() => {
    const groups = new Map<K, T[]>();
    for (const item of items ?? []) {
      const key = keyOf(item);
      const bucket = groups.get(key);
      if (bucket) bucket.push(item);
      else groups.set(key, [item]);
    }
    return [...groups.entries()];
    // keyOf is expected to be a stable inline arrow; grouping is cheap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);
}

/** True when the app has moved to the background, used to refresh on return. */
export function useAppBackgrounded(): boolean {
  const [backgrounded, setBackgrounded] = useState(false);

  useEffect(() => {
    if (Platform.OS === 'web') return;

    let subscription: { remove(): void } | null = null;

    const attach = async (): Promise<void> => {
      const { AppState } = await import('react-native');
      subscription = AppState.addEventListener('change', (nextState) => {
        setBackgrounded(nextState !== 'active');
      });
    };

    void attach();

    return () => {
      subscription?.remove();
    };
  }, []);

  return backgrounded;
}
