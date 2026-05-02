import { Composer } from 'grammy';
import type { HunterService } from '../../services/hunters.js';
import { ownerOnly } from '../middleware/owner.js';
import { parseCallbackData } from '../keyboards.js';

export interface CallbacksDeps {
  ownerTelegramId: bigint;
  hunters: HunterService;
}

/**
 * Minimal context shape needed by the callback handlers (allows testing
 * without full grammY Context).
 */
export interface CallbackCtx {
  from?: { id: number };
  callbackQuery?: { data?: string };
  answerCallbackQuery: (opts: { text: string; show_alert?: boolean }) => Promise<unknown>;
  editMessageReplyMarkup: (opts: { reply_markup: undefined }) => Promise<unknown>;
  api: { sendMessage: (chatId: number, text: string) => Promise<unknown> };
}

// ---------------------------------------------------------------------------
// Named handler functions (exported for direct invocation in tests)
// ---------------------------------------------------------------------------

export async function handleApprove(ctx: CallbackCtx, deps: CallbacksDeps): Promise<void> {
  await handleTransition(ctx, deps, 'approve', 'Your registration was approved. Send /list or /add to get started.');
}

export async function handleDeny(ctx: CallbackCtx, deps: CallbacksDeps): Promise<void> {
  await handleTransition(ctx, deps, 'deny', 'Your registration was not approved.');
}

export async function handleRevoke(ctx: CallbackCtx, deps: CallbacksDeps): Promise<void> {
  await handleTransition(ctx, deps, 'revoke', 'Your access has been revoked.');
}

export async function handleUnrevoke(ctx: CallbackCtx, deps: CallbacksDeps): Promise<void> {
  await handleTransition(ctx, deps, 'unrevoke', 'Your access has been restored.');
}

// ---------------------------------------------------------------------------
// Shared transition implementation
// ---------------------------------------------------------------------------

const LABELS: Record<string, string> = {
  approve: 'Approved',
  deny: 'Denied',
  revoke: 'Revoked',
  unrevoke: 'Unrevoked',
};

const SVC_METHODS = {
  approve: 'approve',
  deny: 'deny',
  revoke: 'revoke',
  unrevoke: 'unrevoke',
} as const;

type TransitionAction = keyof typeof SVC_METHODS;

async function handleTransition(
  ctx: CallbackCtx,
  deps: CallbacksDeps,
  action: TransitionAction,
  userMessage: string,
): Promise<void> {
  const data = ctx.callbackQuery?.data ?? '';
  const targetId = parseCallbackData(data, action);
  if (targetId === null) {
    await ctx.answerCallbackQuery({ text: 'Bad payload', show_alert: false });
    return;
  }
  const svcMethod = SVC_METHODS[action];
  const row = await deps.hunters[svcMethod]({
    ownerId: deps.ownerTelegramId,
    targetTelegramId: targetId,
  });
  if (!row) {
    await ctx.answerCallbackQuery({ text: 'No such hunter', show_alert: false });
    return;
  }
  await ctx.answerCallbackQuery({ text: LABELS[action]! });
  // Strip buttons from the source message so the action looks committed.
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: undefined });
  } catch {
    // Editing can fail if the message is too old or already edited; ignore.
  }
  // DM the affected hunter (best-effort).
  try {
    await ctx.api.sendMessage(Number(targetId), userMessage);
  } catch {
    // Hunter may have blocked the bot. The resilient sender is for
    // alert-loop traffic; here we just swallow.
  }
}

// ---------------------------------------------------------------------------
// Composer — registers all callback queries with the ownerOnly gate
// ---------------------------------------------------------------------------

/**
 * Inline callback queries: approve:<id>, deny:<id>, revoke:<id>, unrevoke:<id>.
 * All of these are owner-only (the messages they appear on were sent to the
 * owner). Each calls the corresponding HunterService method, edits the
 * source message to remove the buttons (acknowledging the action), and
 * answers the callback.
 */
export function callbackHandlers(deps: CallbacksDeps): Composer<never> {
  const c = new Composer<never>();
  c.use(ownerOnly(deps.ownerTelegramId));

  c.callbackQuery(/^approve:[0-9]+$/, async (ctx) => {
    await handleApprove(ctx as unknown as CallbackCtx, deps);
  });

  c.callbackQuery(/^deny:[0-9]+$/, async (ctx) => {
    await handleDeny(ctx as unknown as CallbackCtx, deps);
  });

  c.callbackQuery(/^revoke:[0-9]+$/, async (ctx) => {
    await handleRevoke(ctx as unknown as CallbackCtx, deps);
  });

  c.callbackQuery(/^unrevoke:[0-9]+$/, async (ctx) => {
    await handleUnrevoke(ctx as unknown as CallbackCtx, deps);
  });

  return c;
}
