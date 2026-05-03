import { GrammyError, type Api } from 'grammy';
import { type Logger, SilentLogger } from '../erep/logger.js';
import type { HunterService } from '../services/hunters.js';
import type { SendFn } from '../services/matches.js';

export interface ResilientSenderDeps {
  api: Api;
  /** Used to auto-revoke hunters that block the bot (403). */
  hunters: Pick<HunterService, 'revoke'>;
  /** Owner's Telegram id — never auto-revoked, even on 403 (the owner isn't
   *  a hunter; auto-revoking them would be a no-op but the audit row would
   *  be misleading). */
  ownerTelegramId: bigint;
  logger?: Logger;
}

/**
 * Builds a `SendFn` that wraps `api.sendMessage` with the resilience policy
 * from SPEC §4.3:
 *   - 403 (bot blocked) → auto-revoke the hunter, swallow.
 *   - 429 (flood) → respect retry_after, swallow.
 *   - anything else → log error, swallow.
 *
 * The function never throws — any failure is observable only through the
 * logger. This matches the "the loop must not die" guarantee.
 */
export function makeResilientSender(deps: ResilientSenderDeps): SendFn {
  const log = deps.logger ?? new SilentLogger();

  return async (chatId, html) => {
    try {
      await deps.api.sendMessage(Number(chatId), html, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      if (err instanceof GrammyError) {
        if (err.error_code === 403) {
          log.warn('bot.send.blocked', { chatId: chatId.toString() });
          if (chatId !== deps.ownerTelegramId) {
            await deps.hunters.revoke({
              ownerId: deps.ownerTelegramId,
              targetTelegramId: chatId,
            });
          }
          return;
        }
        if (err.error_code === 429) {
          const retryAfter = err.parameters?.retry_after;
          log.warn('bot.send.flood', {
            chatId: chatId.toString(),
            retryAfter: retryAfter ?? null,
          });
          return;
        }
        log.error('bot.send.error', {
          chatId: chatId.toString(),
          code: err.error_code,
          description: err.description,
        });
        return;
      }
      log.error('bot.send.error', {
        chatId: chatId.toString(),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
