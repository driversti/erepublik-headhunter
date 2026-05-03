import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createHttpServer } from '../index.js';

describe('GET /healthz', () => {
  it('returns 200 + {ok:true} without auth', async () => {
    const http = createHttpServer({
      hunters: { findByTelegramId: vi.fn() } as never,
      victims: { list: vi.fn(), add: vi.fn(), remove: vi.fn() } as never,
      botToken: 'token',
    });
    const res = await request(http.app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
