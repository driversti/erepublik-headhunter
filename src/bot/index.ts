import { Bot } from 'grammy';
import type { Logger } from '../erep/logger.js';
import { SilentLogger } from '../erep/logger.js';
import type { HunterService } from '../services/hunters.js';
import type { VictimService } from '../services/victims.js';
import type { AuditRepo } from '../db/repos/audit.js';
import type { AuthManager } from '../erep/auth.js';
import { startHandlers } from './handlers/start.js';
import { victimHandlers } from './handlers/victims.js';
import { ownerHandlers } from './handlers/owner.js';
import { callbackHandlers } from './handlers/callbacks.js';

// Each handler factory returns Composer<never> (a deliberate narrowing so that
// the composers are self-contained and don't leak grammY's full Context into
// the handler signatures). When registering with a Bot<Context> we need to
// widen back to Context.
type AnyMiddleware = Parameters<Bot['use']>[0];
function asMiddleware(c: unknown): AnyMiddleware {
  return c as AnyMiddleware;
}

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
 * Handler order matters: callback queries are matched first (before commands),
 * then owner commands, then victim commands, then universal start/register/help.
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

  // Order matters: callbacks first, then owner commands, victim commands, start.
  // Each composer's own middleware (ownerOnly, activeHunterOnly) gates traffic.
  // asMiddleware() widens Composer<never> → Middleware<Context> for bot.use().
  bot.use(asMiddleware(callbackHandlers({ ownerTelegramId: deps.ownerTelegramId, hunters: deps.hunters })));
  bot.use(
    asMiddleware(ownerHandlers({
      ownerTelegramId: deps.ownerTelegramId,
      hunters: deps.hunters,
      victims: deps.victims,
      audit: deps.audit,
      auth: deps.auth,
    })),
  );
  bot.use(asMiddleware(victimHandlers({ hunters: deps.hunters, victims: deps.victims })));
  bot.use(
    asMiddleware(startHandlers({
      hunters: deps.hunters,
      ownerTelegramId: deps.ownerTelegramId,
      ...(deps.logger && { logger: deps.logger }),
    })),
  );

  return bot;
}
