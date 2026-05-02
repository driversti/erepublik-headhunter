import type { Context, NextFunction } from 'grammy';

/**
 * Middleware that only lets the configured owner pass. Anyone else gets a
 * polite refusal and the chain stops. Use as a sub-composer on owner-only
 * commands.
 *
 *   bot.use(ownerOnly(ownerId).filter()).command('users', handler);
 *   // or directly:
 *   bot.command('users', ownerOnly(ownerId), handler);
 */
export function ownerOnly(ownerTelegramId: bigint) {
  return async (ctx: Context, next: NextFunction): Promise<void> => {
    if (ctx.from?.id !== undefined && BigInt(ctx.from.id) === ownerTelegramId) {
      await next();
      return;
    }
    // Silent for non-owners on owner commands — no information leak.
    if (ctx.message) {
      await ctx.reply('Unknown command.');
    } else if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: 'Not authorised', show_alert: false });
    }
  };
}
