import { Bot } from 'grammy';
import type { Logger } from '../erep/logger.js';
import { SilentLogger } from '../erep/logger.js';
import type { HunterService } from '../services/hunters.js';
import type { VictimService } from '../services/victims.js';
import type { AuditRepo } from '../db/repos/audit.js';
import type { AuthManager } from '../erep/auth.js';

export interface BotDeps {
  token: string;
  ownerTelegramId: bigint;
  miniappUrl: string;
  hunters: HunterService;
  victims: VictimService;
  audit: AuditRepo;
  /** AuthManager — used by /setcookie and the /status snapshot. */
  auth: AuthManager;
  logger?: Logger;
}

/**
 * Builds a fully-wired grammY Bot. Caller owns the lifecycle:
 *   const bot = createBot(deps);
 *   await bot.start();
 *
 * Handlers are registered in subsequent tasks; this skeleton just sets up
 * the global error handler and the owner middleware factory binding.
 */
export function createBot(deps: BotDeps): Bot {
  const log = deps.logger ?? new SilentLogger();
  const bot = new Bot(deps.token);

  bot.catch((err) => {
    log.error('bot.unhandled', {
      error: err.error instanceof Error ? err.error.message : String(err.error),
      updateId: err.ctx.update.update_id,
    });
  });

  // Handlers are registered by later tasks (Tasks 3, 4, 5).

  return bot;
}
