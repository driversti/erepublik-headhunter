import { InlineKeyboard } from 'grammy';

/** "Approve" / "Deny" buttons targeting a specific Telegram user id. */
export function approveDenyKeyboard(targetTelegramId: bigint): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Approve', `approve:${targetTelegramId}`)
    .text('❌ Deny', `deny:${targetTelegramId}`);
}

/** "Revoke" / "Unrevoke" buttons targeting a specific Telegram user id. */
export function revokeKeyboard(targetTelegramId: bigint, isActive: boolean): InlineKeyboard {
  return isActive
    ? new InlineKeyboard().text('🚫 Revoke', `revoke:${targetTelegramId}`)
    : new InlineKeyboard().text('♻️ Unrevoke', `unrevoke:${targetTelegramId}`);
}

/** Parses callback data "<action>:<numeric-id>" into the bigint id, or null
 *  if the data doesn't match the expected action prefix. */
export function parseCallbackData(data: string, action: string): bigint | null {
  const prefix = `${action}:`;
  if (!data.startsWith(prefix)) return null;
  const tail = data.slice(prefix.length);
  if (!/^[0-9]+$/.test(tail)) return null;
  try {
    return BigInt(tail);
  } catch {
    return null;
  }
}
