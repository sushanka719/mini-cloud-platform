import pino, { type Logger, type LoggerOptions } from 'pino';
import { env, isProduction } from './env.js';

/** Keys scrubbed from every log line — see CLAUDE.md §8 (secrets never logged). */
const REDACT_PATHS = [
  'password',
  'passwordHash',
  'password_hash',
  'token',
  'apiKey',
  'api_key',
  'secret',
  'value_enc',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.secret',
];

const baseOptions: LoggerOptions = {
  level: env.LOG_LEVEL,
  redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  formatters: { level: (label) => ({ level: label }) },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
        },
      }),
};

export function createLogger(service: string, options: LoggerOptions = {}): Logger {
  return pino({ ...baseOptions, ...options, base: { service } });
}

export type { Logger };
export { baseOptions as basePinoOptions };
