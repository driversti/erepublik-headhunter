import { describe, expect, it, vi } from 'vitest';
import { ownerOnly } from '../middleware/owner.js';
import { activeHunterOnly } from '../middleware/active-hunter.js';

const buildCtx = (
  overrides: Partial<{
    fromId: number;
    isMessage: boolean;
    isCallback: boolean;
  }> = {},
): {
  ctx: {
    from?: { id: number };
    message?: object;
    callbackQuery?: object;
    reply: ReturnType<typeof vi.fn>;
    answerCallbackQuery: ReturnType<typeof vi.fn>;
  };
} => {
  const ctx: {
    from?: { id: number };
    message?: object;
    callbackQuery?: object;
    reply: ReturnType<typeof vi.fn>;
    answerCallbackQuery: ReturnType<typeof vi.fn>;
  } = {
    reply: vi.fn().mockResolvedValue(undefined),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
  };
  if (overrides.fromId !== undefined) ctx.from = { id: overrides.fromId };
  if (overrides.isMessage ?? true) ctx.message = {};
  if (overrides.isCallback) ctx.callbackQuery = {};
  return { ctx };
};

describe('ownerOnly', () => {
  const OWNER = 100n;

  it('lets the owner through', async () => {
    const next = vi.fn().mockResolvedValue(undefined);
    const { ctx } = buildCtx({ fromId: 100 });
    await ownerOnly(OWNER)(ctx as never, next as never);
    expect(next).toHaveBeenCalledOnce();
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it('blocks non-owners with "Unknown command." on a message', async () => {
    const next = vi.fn();
    const { ctx } = buildCtx({ fromId: 999 });
    await ownerOnly(OWNER)(ctx as never, next as never);
    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('Unknown command.');
  });

  it('blocks non-owners with answerCallbackQuery on a callback', async () => {
    const next = vi.fn();
    const { ctx } = buildCtx({ fromId: 999, isMessage: false, isCallback: true });
    await ownerOnly(OWNER)(ctx as never, next as never);
    expect(next).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
  });

  it('does nothing when ctx.from is missing', async () => {
    const next = vi.fn();
    const { ctx } = buildCtx({});
    await ownerOnly(OWNER)(ctx as never, next as never);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('activeHunterOnly', () => {
  const hunterService = (override: unknown = null) =>
    ({
      findByTelegramId: vi.fn().mockResolvedValue(override),
    }) as unknown as import('../../services/hunters.js').HunterService;

  it('lets active hunters through', async () => {
    const next = vi.fn().mockResolvedValue(undefined);
    const { ctx } = buildCtx({ fromId: 100 });
    const hunters = hunterService({
      telegram_id: '100',
      status: 'active',
    });
    await activeHunterOnly(hunters)(ctx as never, next as never);
    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects unknown hunters with /register hint', async () => {
    const next = vi.fn();
    const { ctx } = buildCtx({ fromId: 100 });
    await activeHunterOnly(hunterService(null))(ctx as never, next as never);
    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(
      'You are not registered. Send /register to request access.',
    );
  });

  it('rejects pending hunters with awaiting-approval message', async () => {
    const next = vi.fn();
    const { ctx } = buildCtx({ fromId: 100 });
    await activeHunterOnly(
      hunterService({ telegram_id: '100', status: 'pending' }),
    )(ctx as never, next as never);
    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('Your registration is still awaiting approval.');
  });

  it('rejects denied/revoked hunters with generic not-active message', async () => {
    const next = vi.fn();
    const { ctx } = buildCtx({ fromId: 100 });
    await activeHunterOnly(
      hunterService({ telegram_id: '100', status: 'revoked' }),
    )(ctx as never, next as never);
    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('Your account is not active.');
  });
});
