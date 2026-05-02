import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createInitDataAuth } from '../auth.js';
import type { HunterRow } from '../../db/types.js';
import { buildInitData } from './_helpers.js';

const BOT_TOKEN = '123456:ABCDEF';
const NOW = 1_900_000_000;

const buildHunter = (overrides: Partial<HunterRow> = {}): HunterRow => ({
  telegram_id: '111',
  username: 'alice',
  status: 'active',
  registered_at: new Date(),
  decided_at: null,
  decided_by: null,
  ...overrides,
});

const runMiddleware = async (
  initData: string | undefined,
  hunter: HunterRow | null,
  opts?: { ttlSec?: number; nowFn?: () => number },
): Promise<{ status?: number; body?: unknown; nextCalled: boolean; req: Request }> => {
  const findByTelegramId = vi.fn().mockResolvedValue(hunter);
  const middleware = createInitDataAuth({
    botToken: BOT_TOKEN,
    hunters: { findByTelegramId },
    initDataTtlSec: opts?.ttlSec ?? 86400,
    now: opts?.nowFn ?? (() => NOW),
  });
  const req = { headers: initData ? { 'x-telegram-init-data': initData } : {} } as unknown as Request;
  let status: number | undefined;
  let body: unknown;
  const res = {
    status(s: number) {
      status = s;
      return this;
    },
    json(b: unknown) {
      body = b;
      return this;
    },
  } as unknown as Response;
  const next = vi.fn();
  await middleware(req, res, next);
  return {
    ...(status !== undefined && { status }),
    ...(body !== undefined && { body }),
    nextCalled: next.mock.calls.length > 0,
    req,
  };
};

describe('initData auth middleware', () => {
  it('returns 401 invalid_init_data when header missing', async () => {
    const r = await runMiddleware(undefined, buildHunter());
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ error: { code: 'invalid_init_data' } });
    expect(r.nextCalled).toBe(false);
  });

  it('returns 401 invalid_init_data when hash is tampered', async () => {
    const initData = buildInitData({ user: { id: 111 }, botToken: BOT_TOKEN, authDate: NOW, overrideHash: 'deadbeef' });
    const r = await runMiddleware(initData, buildHunter());
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ error: { code: 'invalid_init_data' } });
  });

  it('returns 401 expired_init_data when auth_date is older than ttl', async () => {
    const initData = buildInitData({ user: { id: 111 }, botToken: BOT_TOKEN, authDate: NOW - 86401 });
    const r = await runMiddleware(initData, buildHunter(), { ttlSec: 86400 });
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ error: { code: 'expired_init_data' } });
  });

  it('returns 403 not_active with details.status=null when hunter does not exist', async () => {
    const initData = buildInitData({ user: { id: 111 }, botToken: BOT_TOKEN, authDate: NOW });
    const r = await runMiddleware(initData, null);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: { code: 'not_active', details: { status: null } } });
  });

  it.each(['pending', 'revoked', 'denied'] as const)(
    'returns 403 not_active with details.status=%s for non-active hunters',
    async (status) => {
      const initData = buildInitData({ user: { id: 111 }, botToken: BOT_TOKEN, authDate: NOW });
      const r = await runMiddleware(initData, buildHunter({ status }));
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ error: { code: 'not_active', details: { status } } });
    },
  );

  it('calls next() and sets req.hunter when initData is valid and hunter is active', async () => {
    const hunter = buildHunter({ telegram_id: '111', status: 'active' });
    const initData = buildInitData({ user: { id: 111 }, botToken: BOT_TOKEN, authDate: NOW });
    const r = await runMiddleware(initData, hunter);
    expect(r.nextCalled).toBe(true);
    expect((r.req as unknown as { hunter: HunterRow }).hunter).toEqual(hunter);
  });

  it('returns 401 invalid_init_data when user JSON is missing', async () => {
    // Hand-craft an initData missing the `user` field.
    const usp = new URLSearchParams();
    usp.append('auth_date', String(NOW));
    usp.append('hash', 'whatever');
    const r = await runMiddleware(usp.toString(), buildHunter());
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ error: { code: 'invalid_init_data' } });
  });
});
