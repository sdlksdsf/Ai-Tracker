import pino, { type Logger, type LoggerOptions } from 'pino';
import { env } from '../config/env.js';

/**
 * Structured JSON logging (Pino).
 *
 * In development the output is piped through `pino-pretty` for readability;
 * in production raw NDJSON is emitted so Railway/Fly log aggregators and
 * Sentry can parse it.
 */
function buildOptions(): LoggerOptions {
  const base: LoggerOptions = {
    level: env.LOG_LEVEL,
    base: { service: 'platematch-api', env: env.NODE_ENV },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        '*.password',
        '*.passwordHash',
        '*.refresh_token',
        '*.access_token',
        '*.id_token',
        '*.identity_token',
        '*.token',
        '*.fcm_token',
        '*.apiKey',
        'config.*KEY*',
        'config.*SECRET*',
      ],
      censor: '[REDACTED]',
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
  };

  if (env.LOG_PRETTY || env.NODE_ENV === 'development') {
    return {
      ...base,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname,service',
          singleLine: false,
        },
      },
    };
  }

  return base;
}

export const logger: Logger = pino(buildOptions());

/** Create a child logger scoped to a feature/request. */
export function childLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}

export type { Logger };
