import { describe, expect, it, vi } from 'vitest';
import { handleStart, handleHelp, handleRegister } from '../handlers/start.js';
import { buildCtx } from './_helpers.js';

const OWNER = 1n;

function makeHunterService(register: { status: string; telegramId?: bigint } = { status: 'pending' }) {
  return {
    register: vi.fn().mockResolvedValue({
      telegram_id: '100',
      username: 'alice',
      status: register.status,
      registered_at: new Date(),
      decided_at: null,
      decided_by: null,
    }),
    findByTelegramId: vi.fn(),
  } as unknown as import('../../services/hunters.js').HunterService;
}

describe('startHandlers', () => {
  it('/start replies with the welcome message', async () => {
    const ctx = buildCtx({ fromId: 100, text: '/start' });
    await handleStart(ctx);
    expect(ctx.reply).toHaveBeenCalled();
    const reply = ctx.reply.mock.calls[0]![0] as string;
    expect(reply).toContain('Welcome to Headhunter');
  });

  it('/help replies with command list', async () => {
    const ctx = buildCtx({ fromId: 100, text: '/help' });
    await handleHelp(ctx);
    const reply = ctx.reply.mock.calls[0]![0] as string;
    expect(reply).toContain('/register');
    expect(reply).toContain('/add');
  });

  it('/register on a fresh user replies + DMs the owner with Approve/Deny buttons', async () => {
    const hunters = makeHunterService({ status: 'pending' });
    const ctx = buildCtx({ fromId: 100, username: 'alice', text: '/register' });
    await handleRegister(ctx, { hunters, ownerTelegramId: OWNER });

    expect(hunters.register).toHaveBeenCalledWith({ telegramId: 100n, username: 'alice' });
    expect(ctx.reply).toHaveBeenCalledWith('Registration request sent. The owner will review.');
    expect(ctx.api.sendMessage).toHaveBeenCalled();
    const [chatId, text, opts] = ctx.api.sendMessage.mock.calls[0]!;
    expect(chatId).toBe(Number(OWNER));
    expect(text).toContain('100');
    expect(text).toContain('@alice');
    expect((opts as { parse_mode?: string }).parse_mode).toBe('HTML');
    expect((opts as { reply_markup?: unknown }).reply_markup).toBeDefined();
  });

  it('/register for a denied user replies "not approved"', async () => {
    const ctx = buildCtx({ fromId: 100, text: '/register' });
    await handleRegister(ctx, {
      hunters: makeHunterService({ status: 'denied' }),
      ownerTelegramId: OWNER,
    });
    expect(ctx.reply).toHaveBeenCalledWith('Your previous request was not approved.');
  });

  it('/register for an active user replies "already approved"', async () => {
    const ctx = buildCtx({ fromId: 100, text: '/register' });
    await handleRegister(ctx, {
      hunters: makeHunterService({ status: 'active' }),
      ownerTelegramId: OWNER,
    });
    expect(ctx.reply).toHaveBeenCalledWith('You are already approved.');
  });
});
