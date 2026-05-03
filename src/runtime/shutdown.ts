import type { Logger } from '../erep/logger.js';

export interface ShutdownDeps {
  bot: { stop: () => Promise<void> };
  engine: { stop: () => void };
  http: { close: () => Promise<void> };
  pool: { end: () => Promise<void> };
  /** Optional — only set if keep-alive was started. */
  keepAlive?: { stop: () => void };
  logger?: Logger;
}

let alreadyShutDown = false;

/**
 * Ordered teardown: telegram polling → engine timers → http connections → pg
 * pool. Each step is wrapped in try/catch so a single hang/throw does not
 * block the rest from running. Idempotent — a second call is a no-op.
 */
export async function gracefulShutdown(deps: ShutdownDeps): Promise<void> {
  if (alreadyShutDown) return;
  alreadyShutDown = true;
  const log = deps.logger;
  log?.info('shutdown.starting');

  await safeAsync('shutdown.bot.stop', () => deps.bot.stop(), log);
  await safeSync('shutdown.engine.stop', () => deps.engine.stop(), log);
  if (deps.keepAlive) {
    await safeSync('shutdown.keep_alive.stop', () => deps.keepAlive!.stop(), log);
  }
  await safeAsync('shutdown.http.close', () => deps.http.close(), log);
  await safeAsync('shutdown.pool.end', () => deps.pool.end(), log);

  log?.info('shutdown.done');
}

/** Test-only: clears the idempotency latch. */
export function _resetShutdownForTests(): void {
  alreadyShutDown = false;
}

async function safeAsync(name: string, fn: () => Promise<unknown>, log?: Logger): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log?.warn(name + '.failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

async function safeSync(name: string, fn: () => unknown, log?: Logger): Promise<void> {
  try {
    fn();
  } catch (err) {
    log?.warn(name + '.failed', { error: err instanceof Error ? err.message : String(err) });
  }
}
