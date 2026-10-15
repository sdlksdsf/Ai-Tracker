/**
 * Client logging.
 *
 * A thin level-filtered wrapper rather than raw `console.*`, so production
 * builds stay quiet without every call site needing an `__DEV__` guard, and so a
 * future crash reporter can be attached in one place.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Nothing below this level is emitted. Production shows warnings and errors. */
const minLevel: Level = __DEV__ ? 'debug' : 'warn';

function shouldLog(level: Level): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
}

function emit(level: Level, scope: string, message: string, extra?: unknown): void {
  if (!shouldLog(level)) return;

  const prefix = `[${scope}]`;
  const args: unknown[] = extra === undefined ? [prefix, message] : [prefix, message, extra];

  switch (level) {
    case 'debug':
      console.debug(...args);
      return;
    case 'info':
      console.info(...args);
      return;
    case 'warn':
      console.warn(...args);
      return;
    case 'error':
      console.error(...args);
      return;
    default:
      return;
  }
}

/**
 * Create a logger bound to a scope.
 *
 * `const log = createLogger('ScanScreen')` then `log.info('capture started')`.
 */
export function createLogger(scope: string) {
  return {
    debug: (message: string, extra?: unknown) => emit('debug', scope, message, extra),
    info: (message: string, extra?: unknown) => emit('info', scope, message, extra),
    warn: (message: string, extra?: unknown) => emit('warn', scope, message, extra),
    error: (message: string, extra?: unknown) => emit('error', scope, message, extra),
  };
}

/** Default logger for one-off calls outside a component. */
export const logger = createLogger('platematch');

/**
 * Normalise an unknown thrown value into something safe to log.
 *
 * `catch (err)` gives `unknown`; stringifying a React Native error directly can
 * throw again on circular structures.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export default logger;
