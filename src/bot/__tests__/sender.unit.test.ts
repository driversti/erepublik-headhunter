import { describe, expect, it, vi } from 'vitest';
import { GrammyError } from 'grammy';
import { MemoryLogger } from '../../erep/logger.js';
import { makeResilientSender } from '../sender.js';

const HUNTER = 100n;

function makeApi(impl: (chatId: number, text: string) => Promise<unknown>) {
  return { sendMessage: vi.fn(impl) } as unknown as {
    sendMessage: ReturnType<typeof vi.fn>;
  };
}

function makeHunters() {
  return { revoke: vi.fn().mockResolvedValue({ telegram_id: '100', status: 'revoked' }) } as unknown as {
    revoke: ReturnType<typeof vi.fn>;
  };
}

/**
 * Synthesizes a minimal GrammyError instance that passes instanceof checks.
 * The constructor signature is: (message, err: ApiError, method, payload)
 * where ApiError = { ok: false, error_code, description, parameters? }.
 * We pass parameters inside the err object so the constructor sets
 * this.parameters = err.parameters ?? {}.
 */
function grammyError(code: number, description: string, parameters?: { retry_after?: number }) {
  return new GrammyError(
    `Call to 'sendMessage' failed: ${description}`,
    { ok: false, error_code: code, description, ...(parameters ? { parameters } : {}) },
    'sendMessage',
    {},
  );
}

describe('makeResilientSender', () => {
  const OWNER = 1n;

  it('forwards a successful sendMessage', async () => {
    const api = makeApi(async () => ({ message_id: 42 }));
    const hunters = makeHunters();
    const send = makeResilientSender({
      api: api as never,
      hunters: hunters as never,
      ownerTelegramId: OWNER,
      logger: new MemoryLogger(),
    });
    await send(HUNTER, '<b>hi</b>');
    expect(api.sendMessage).toHaveBeenCalledWith(Number(HUNTER), '<b>hi</b>', { parse_mode: 'HTML' });
    expect(hunters.revoke).not.toHaveBeenCalled();
  });

  it('on 403 from a hunter: logs warn, auto-revokes the hunter, does NOT throw', async () => {
    const api = makeApi(async () => {
      throw grammyError(403, 'Forbidden: bot was blocked by the user');
    });
    const hunters = makeHunters();
    const logger = new MemoryLogger();
    const send = makeResilientSender({
      api: api as never,
      hunters: hunters as never,
      ownerTelegramId: OWNER,
      logger,
    });
    await expect(send(HUNTER, 'x')).resolves.toBeUndefined();
    expect(hunters.revoke).toHaveBeenCalledWith({
      ownerId: OWNER,
      targetTelegramId: HUNTER,
    });
    expect(logger.entries.some((e) => e.level === 'warn' && e.msg === 'bot.send.blocked')).toBe(true);
  });

  it('on 429: logs warn with retry_after, does NOT revoke, does NOT throw', async () => {
    const api = makeApi(async () => {
      throw grammyError(429, 'Too Many Requests: retry after 30', { retry_after: 30 });
    });
    const hunters = makeHunters();
    const logger = new MemoryLogger();
    const send = makeResilientSender({
      api: api as never,
      hunters: hunters as never,
      ownerTelegramId: OWNER,
      logger,
    });
    await expect(send(HUNTER, 'x')).resolves.toBeUndefined();
    expect(hunters.revoke).not.toHaveBeenCalled();
    const warn = logger.entries.find((e) => e.msg === 'bot.send.flood');
    expect(warn).toBeTruthy();
    expect(warn?.ctx?.['retryAfter']).toBe(30);
  });

  it('on a generic 5xx: logs error, does NOT throw, does NOT revoke', async () => {
    const api = makeApi(async () => {
      throw grammyError(500, 'Internal Server Error');
    });
    const hunters = makeHunters();
    const logger = new MemoryLogger();
    const send = makeResilientSender({
      api: api as never,
      hunters: hunters as never,
      ownerTelegramId: OWNER,
      logger,
    });
    await expect(send(HUNTER, 'x')).resolves.toBeUndefined();
    expect(hunters.revoke).not.toHaveBeenCalled();
    expect(logger.entries.some((e) => e.level === 'error' && e.msg === 'bot.send.error')).toBe(true);
  });

  it('on a non-grammy error (e.g. network): logs error, does NOT throw, does NOT revoke', async () => {
    const api = makeApi(async () => {
      throw new Error('fetch failed');
    });
    const hunters = makeHunters();
    const logger = new MemoryLogger();
    const send = makeResilientSender({
      api: api as never,
      hunters: hunters as never,
      ownerTelegramId: OWNER,
      logger,
    });
    await expect(send(HUNTER, 'x')).resolves.toBeUndefined();
    expect(hunters.revoke).not.toHaveBeenCalled();
    expect(logger.entries.some((e) => e.level === 'error')).toBe(true);
  });

  it('does NOT auto-revoke the owner on 403 (they are not a hunter)', async () => {
    const api = makeApi(async () => {
      throw grammyError(403, 'Forbidden: bot was blocked by the user');
    });
    const hunters = makeHunters();
    const send = makeResilientSender({
      api: api as never,
      hunters: hunters as never,
      ownerTelegramId: OWNER,
      logger: new MemoryLogger(),
    });
    await expect(send(OWNER, 'x')).resolves.toBeUndefined();
    expect(hunters.revoke).not.toHaveBeenCalled();
  });
});
