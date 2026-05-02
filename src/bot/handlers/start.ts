import { Composer as Comp } from 'grammy';
import type { HunterService } from '../../services/hunters.js';
import { approveDenyKeyboard } from '../keyboards.js';
import { type Logger, SilentLogger } from '../../erep/logger.js';
import { escapeHtml } from '../../util/escapeHtml.js';

export interface StartDeps {
  hunters: HunterService;
  ownerTelegramId: bigint;
  logger?: Logger;
}

export const HELP_TEXT = `Headhunter — air-round victim alerts.

Available commands:
/register — request access (the owner approves).
/add <citizen_id> [nickname] — add a victim to your list.
/remove <citizen_id> — remove a victim.
/list — show your victims.
/help — this message.`;

export const START_TEXT = `Welcome to Headhunter — a private bot that pings you when specific eRepublik citizens appear in air-round combat near round-end.

Send /register to request access. The owner will review.`;

/** Minimal context shape needed by the start handlers (allows testing without full grammY Context). */
export interface StartCtx {
  from?: { id: number; username?: string };
  reply: (text: string, opts?: object) => Promise<unknown>;
  api: { sendMessage: (chatId: number, text: string, opts?: object) => Promise<unknown> };
}

export async function handleStart(ctx: StartCtx): Promise<void> {
  await ctx.reply(START_TEXT);
}

export async function handleHelp(ctx: StartCtx): Promise<void> {
  await ctx.reply(HELP_TEXT);
}

export async function handleRegister(ctx: StartCtx, deps: StartDeps): Promise<void> {
  if (!ctx.from) return;
  const log = deps.logger ?? new SilentLogger();
  const row = await deps.hunters.register({
    telegramId: BigInt(ctx.from.id),
    username: ctx.from.username ?? null,
  });
  if (row.status === 'pending') {
    await ctx.reply('Registration request sent. The owner will review.');
    // DM the owner with Approve/Deny inline buttons.
    try {
      const usernamePart = ctx.from.username ? ` (@${escapeHtml(ctx.from.username)})` : '';
      await ctx.api.sendMessage(
        Number(deps.ownerTelegramId),
        `📥 Registration request from <code>${ctx.from.id}</code>${usernamePart}`,
        {
          parse_mode: 'HTML',
          reply_markup: approveDenyKeyboard(BigInt(ctx.from.id)),
        },
      );
    } catch (err) {
      log.warn('bot.register.dm_owner_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }
  if (row.status === 'denied') {
    await ctx.reply('Your previous request was not approved.');
    return;
  }
  if (row.status === 'active') {
    await ctx.reply('You are already approved.');
    return;
  }
  if (row.status === 'revoked') {
    await ctx.reply('Your access was revoked. Contact the owner.');
    return;
  }
}

export function startHandlers(deps: StartDeps): Comp<never> {
  const c = new Comp<never>();

  c.command('start', async (ctx) => {
    await handleStart(ctx);
  });

  c.command('help', async (ctx) => {
    await handleHelp(ctx);
  });

  c.command('register', async (ctx) => {
    await handleRegister(ctx, deps);
  });

  return c;
}
