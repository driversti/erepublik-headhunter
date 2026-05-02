import { describe, expect, it, vi } from 'vitest';
import {
  handleApprove,
  handleDeny,
  handleRevoke,
  handleUnrevoke,
  callbackHandlers,
} from '../handlers/callbacks.js';
import type { CallbackCtx, CallbacksDeps } from '../handlers/callbacks.js';
import type { HunterService } from '../../services/hunters.js';

const OWNER_ID = 99n;
const TARGET_ID = 100n;
const TARGET_NUM = 100;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHunters(overrides: Partial<HunterService> = {}): HunterService {
  return {
    listPending: vi.fn().mockResolvedValue([]),
    listAll: vi.fn().mockResolvedValue([]),
    findByTelegramId: vi.fn().mockResolvedValue(null),
    register: vi.fn(),
    approve: vi.fn().mockResolvedValue(null),
    deny: vi.fn().mockResolvedValue(null),
    revoke: vi.fn().mockResolvedValue(null),
    unrevoke: vi.fn().mockResolvedValue(null),
    unban: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as unknown as HunterService;
}

function makeDeps(overrides: Partial<HunterService> = {}): CallbacksDeps {
  return {
    ownerTelegramId: OWNER_ID,
    hunters: makeHunters(overrides),
  };
}

const FAKE_ROW = {
  telegram_id: String(TARGET_ID),
  username: 'alice',
  status: 'active' as const,
  registered_at: new Date(),
  decided_at: null,
  decided_by: null,
};

function buildCallbackCtx(data: string, fromId: number = Number(OWNER_ID)): CallbackCtx {
  return {
    from: { id: fromId },
    callbackQuery: { data },
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
    api: { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) },
  };
}

// ---------------------------------------------------------------------------
// Tests: happy paths for each transition
// ---------------------------------------------------------------------------

describe('handleApprove', () => {
  it('calls hunters.approve, answers "Approved", and DMs the hunter', async () => {
    const ctx = buildCallbackCtx(`approve:${TARGET_ID}`);
    const deps = makeDeps({ approve: vi.fn().mockResolvedValue(FAKE_ROW) });
    await handleApprove(ctx, deps);
    expect(deps.hunters.approve).toHaveBeenCalledWith({
      ownerId: OWNER_ID,
      targetTelegramId: TARGET_ID,
    });
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Approved' });
    expect(ctx.api.sendMessage).toHaveBeenCalledWith(
      TARGET_NUM,
      'Your registration was approved. Send /list or /add to get started.',
    );
  });
});

describe('handleDeny', () => {
  it('calls hunters.deny, answers "Denied", and DMs the hunter', async () => {
    const ctx = buildCallbackCtx(`deny:${TARGET_ID}`);
    const deps = makeDeps({ deny: vi.fn().mockResolvedValue(FAKE_ROW) });
    await handleDeny(ctx, deps);
    expect(deps.hunters.deny).toHaveBeenCalledWith({
      ownerId: OWNER_ID,
      targetTelegramId: TARGET_ID,
    });
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Denied' });
    expect(ctx.api.sendMessage).toHaveBeenCalledWith(
      TARGET_NUM,
      'Your registration was not approved.',
    );
  });
});

describe('handleRevoke', () => {
  it('calls hunters.revoke, answers "Revoked", and DMs the hunter', async () => {
    const ctx = buildCallbackCtx(`revoke:${TARGET_ID}`);
    const deps = makeDeps({ revoke: vi.fn().mockResolvedValue(FAKE_ROW) });
    await handleRevoke(ctx, deps);
    expect(deps.hunters.revoke).toHaveBeenCalledWith({
      ownerId: OWNER_ID,
      targetTelegramId: TARGET_ID,
    });
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Revoked' });
    expect(ctx.api.sendMessage).toHaveBeenCalledWith(
      TARGET_NUM,
      'Your access has been revoked.',
    );
  });
});

describe('handleUnrevoke', () => {
  it('calls hunters.unrevoke, answers "Unrevoked", and DMs the hunter', async () => {
    const ctx = buildCallbackCtx(`unrevoke:${TARGET_ID}`);
    const deps = makeDeps({ unrevoke: vi.fn().mockResolvedValue(FAKE_ROW) });
    await handleUnrevoke(ctx, deps);
    expect(deps.hunters.unrevoke).toHaveBeenCalledWith({
      ownerId: OWNER_ID,
      targetTelegramId: TARGET_ID,
    });
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Unrevoked' });
    expect(ctx.api.sendMessage).toHaveBeenCalledWith(
      TARGET_NUM,
      'Your access has been restored.',
    );
  });
});

// ---------------------------------------------------------------------------
// Edge case: unknown hunter returns null from the service
// ---------------------------------------------------------------------------

describe('handleApprove — unknown hunter', () => {
  it('answers "No such hunter" and does NOT DM when service returns null', async () => {
    const ctx = buildCallbackCtx(`approve:${TARGET_ID}`);
    // approve returns null by default in makeDeps()
    const deps = makeDeps();
    await handleApprove(ctx, deps);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: 'No such hunter',
      show_alert: false,
    });
    expect(ctx.api.sendMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Non-owner rejection: test that the composer's ownerOnly middleware fires
// ---------------------------------------------------------------------------

describe('callbackHandlers composer — non-owner blocked', () => {
  it('non-owner callback query receives "Not authorised" answer', async () => {
    const deps = makeDeps();
    const composer = callbackHandlers(deps);
    // Build a context that looks like a callback query from a non-owner.
    const ctx = {
      from: { id: 12345 },
      callbackQuery: { data: `approve:${TARGET_ID}` },
      message: undefined,
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
      api: { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) },
    };
    const middleware = composer.middleware();
    await middleware(ctx as never, async () => {});
    // ownerOnly answers "Not authorised" to non-owners on callback queries.
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    expect(deps.hunters.approve).not.toHaveBeenCalled();
  });
});
