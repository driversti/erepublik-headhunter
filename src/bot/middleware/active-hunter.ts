import type { Context, NextFunction } from 'grammy';
import type { HunterService } from '../../services/hunters.js';

/**
 * Middleware that admits only hunters with `status='active'`. Pending users
 * get a "your registration is awaiting approval" reply; denied/revoked users
 * get the same generic "not active" message (no information leak about which
 * state). Unknown users get a hint to /register.
 */
export function activeHunterOnly(hunters: HunterService) {
  return async (ctx: Context, next: NextFunction): Promise<void> => {
    const fromId = ctx.from?.id;
    if (fromId === undefined) {
      return; // ignore — no caller
    }
    const row = await hunters.findByTelegramId(BigInt(fromId));
    if (!row) {
      await ctx.reply('You are not registered. Send /register to request access.');
      return;
    }
    if (row.status === 'pending') {
      await ctx.reply('Your registration is still awaiting approval.');
      return;
    }
    if (row.status !== 'active') {
      await ctx.reply('Your account is not active.');
      return;
    }
    await next();
  };
}
