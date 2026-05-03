import { pino, type Logger as PinoLogger } from 'pino';
import type { Logger } from './erep/logger.js';

export interface CreateLoggerOpts {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';
  pretty?: boolean;
}

/** Pino-backed logger adapting our minimal `Logger` interface from erep/logger.ts.
 *  Production: structured JSON to stdout. Dev: optional pretty-print. */
export function createLogger(opts: CreateLoggerOpts): Logger {
  const pinoLogger: PinoLogger = pino({
    level: opts.level,
    ...(opts.pretty && {
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard' },
      },
    }),
  });
  return adapt(pinoLogger);
}

function adapt(p: PinoLogger): Logger {
  return {
    info: (msg, ctx) => (ctx ? p.info(ctx, msg) : p.info(msg)),
    warn: (msg, ctx) => (ctx ? p.warn(ctx, msg) : p.warn(msg)),
    error: (msg, ctx) => (ctx ? p.error(ctx, msg) : p.error(msg)),
    debug: (msg, ctx) => (ctx ? p.debug(ctx, msg) : p.debug(msg)),
  };
}
