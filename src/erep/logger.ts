/**
 * Minimal logger interface so any backend (pino, winston, console) plugs in
 * without API changes. Pino's logger already conforms.
 */
export interface Logger {
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  debug(msg: string, ctx?: Record<string, unknown>): void;
}

/** No-op logger — the default. Keeps unit tests quiet. */
export class SilentLogger implements Logger {
  info(): void {}
  warn(): void {}
  error(): void {}
  debug(): void {}
}

/** Structured single-line console logger. Level prefix + message + flat ctx. */
export class ConsoleLogger implements Logger {
  constructor(private readonly minLevel: 'debug' | 'info' | 'warn' | 'error' = 'info') {}

  private static readonly LEVEL_RANK: Record<string, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
  };

  private write(level: 'debug' | 'info' | 'warn' | 'error', msg: string, ctx?: Record<string, unknown>): void {
    if (ConsoleLogger.LEVEL_RANK[level]! < ConsoleLogger.LEVEL_RANK[this.minLevel]!) return;
    const ctxStr = ctx ? ' ' + Object.entries(ctx).map(([k, v]) => `${k}=${formatValue(v)}`).join(' ') : '';
    const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    stream.write(`[${level.toUpperCase()}] ${msg}${ctxStr}\n`);
  }

  debug(msg: string, ctx?: Record<string, unknown>): void { this.write('debug', msg, ctx); }
  info(msg: string, ctx?: Record<string, unknown>): void { this.write('info', msg, ctx); }
  warn(msg: string, ctx?: Record<string, unknown>): void { this.write('warn', msg, ctx); }
  error(msg: string, ctx?: Record<string, unknown>): void { this.write('error', msg, ctx); }
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'string') return /\s/.test(v) ? JSON.stringify(v) : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Error) return JSON.stringify({ name: v.name, message: v.message });
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Memory logger for tests — records calls and lets assertions inspect them. */
export class MemoryLogger implements Logger {
  readonly entries: Array<{ level: string; msg: string; ctx?: Record<string, unknown> }> = [];

  info(msg: string, ctx?: Record<string, unknown>): void { this.entries.push({ level: 'info', msg, ...(ctx && { ctx }) }); }
  warn(msg: string, ctx?: Record<string, unknown>): void { this.entries.push({ level: 'warn', msg, ...(ctx && { ctx }) }); }
  error(msg: string, ctx?: Record<string, unknown>): void { this.entries.push({ level: 'error', msg, ...(ctx && { ctx }) }); }
  debug(msg: string, ctx?: Record<string, unknown>): void { this.entries.push({ level: 'debug', msg, ...(ctx && { ctx }) }); }
}
