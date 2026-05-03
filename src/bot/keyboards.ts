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

/** One row per hunter, label = "@username" or numeric id. Callback data:
 *  "hvictims:<telegram_id>". Used by the no-arg /hvictims flow so the owner
 *  doesn't need to memorize Telegram ids. */
export function huntersPickerKeyboard(
  hunters: Array<{ telegram_id: string; username: string | null }>,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const h of hunters) {
    const label = h.username ? `@${h.username}` : String(h.telegram_id);
    kb.text(label, `hvictims:${h.telegram_id}`).row();
  }
  return kb;
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
