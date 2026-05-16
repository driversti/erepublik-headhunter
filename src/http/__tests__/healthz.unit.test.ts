import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createHttpServer } from '../index.js';

describe('GET /healthz', () => {
  it('returns 200 + {ok:true} without auth', async () => {
    const http = createHttpServer({
      hunters: { findByTelegramId: vi.fn() } as never,
      victims: { list: vi.fn(), add: vi.fn(), remove: vi.fn() } as never,
      botToken: 'token',
      ownerTelegramId: 1n,
    });
    const res = await request(http.app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('returns 200 + staleMs when liveness signal is fresh', async () => {
    const http = createHttpServer({
      hunters: { findByTelegramId: vi.fn() } as never,
      victims: { list: vi.fn(), add: vi.fn(), remove: vi.fn() } as never,
      botToken: 'token',
      ownerTelegramId: 1n,
      liveness: { staleMs: () => 5_000 },
      livenessUnhealthyMs: 60_000,
    });
    const res = await request(http.app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, staleMs: 5_000 });
  });

  it('returns 503 + poll_stale when liveness signal exceeds threshold', async () => {
    const http = createHttpServer({
      hunters: { findByTelegramId: vi.fn() } as never,
      victims: { list: vi.fn(), add: vi.fn(), remove: vi.fn() } as never,
      botToken: 'token',
      ownerTelegramId: 1n,
      liveness: { staleMs: () => 200_000 },
      livenessUnhealthyMs: 180_000,
    });
    const res = await request(http.app).get('/healthz');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, reason: 'poll_stale', staleMs: 200_000 });
  });
});
