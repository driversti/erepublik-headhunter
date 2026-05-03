import { Composer } from 'grammy';
import type { HunterService } from '../../services/hunters.js';
import type { VictimService } from '../../services/victims.js';
import { ownerOnly } from '../middleware/owner.js';
import { parseCallbackData } from '../keyboards.js';
import { renderHunterVictimsBody } from './owner.js';

export interface CallbacksDeps {
  ownerTelegramId: bigint;
  hunters: HunterService;
  /** Optional — only used by the hvictims:* callback. The approve/deny/revoke
   *  flows don't need it; tests for those omit this dep. */
  victims?: Pick<VictimService, 'list'>;
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
  /** Replaces the source message (used by hvictims to swap the picker for
   *  the resulting list). Optional — approve/deny/revoke don't need it. */
  editMessageText?: (text: string, opts?: object) => Promise<unknown>;
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

/** Owner picked a hunter from the /hvictims keyboard — replace the picker
 *  message with the rendered victim list. */
export async function handleHvictimsPick(ctx: CallbackCtx, deps: CallbacksDeps): Promise<void> {
  const data = ctx.callbackQuery?.data ?? '';
  const targetId = parseCallbackData(data, 'hvictims');
  if (targetId === null) {
    await ctx.answerCallbackQuery({ text: 'Bad payload', show_alert: false });
    return;
  }
  const hunter = await deps.hunters.findByTelegramId(targetId);
  if (!hunter) {
    await ctx.answerCallbackQuery({ text: 'No such hunter', show_alert: true });
    return;
  }
  if (!deps.victims) {
    await ctx.answerCallbackQuery({ text: 'Victim service unavailable', show_alert: true });
    return;
  }
  const victims = await deps.victims.list(targetId);
  await ctx.answerCallbackQuery({ text: '' });
  const body = renderHunterVictimsBody(hunter, victims);
  if (ctx.editMessageText) {
    await ctx.editMessageText(body, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  }
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
  const gate = ownerOnly(deps.ownerTelegramId);

  c.callbackQuery(/^approve:[0-9]+$/, gate, async (ctx) => {
    await handleApprove(ctx as unknown as CallbackCtx, deps);
  });

  c.callbackQuery(/^deny:[0-9]+$/, gate, async (ctx) => {
    await handleDeny(ctx as unknown as CallbackCtx, deps);
  });

  c.callbackQuery(/^revoke:[0-9]+$/, gate, async (ctx) => {
    await handleRevoke(ctx as unknown as CallbackCtx, deps);
  });

  c.callbackQuery(/^unrevoke:[0-9]+$/, gate, async (ctx) => {
    await handleUnrevoke(ctx as unknown as CallbackCtx, deps);
  });

  c.callbackQuery(/^hvictims:[0-9]+$/, gate, async (ctx) => {
    await handleHvictimsPick(ctx as unknown as CallbackCtx, deps);
  });

  return c;
}
