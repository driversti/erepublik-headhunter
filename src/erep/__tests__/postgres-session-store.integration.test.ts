import { beforeEach, describe, expect, it } from 'vitest';
import { setupPg, truncateAll } from '../../db/__tests__/_pg.js';
import { PostgresSessionStore } from '../postgres-session-store.js';
import type { SessionRecord } from '../session-store.js';

const ctx = setupPg();
const make = (): PostgresSessionStore => new PostgresSessionStore(ctx.pool);

const sample = (): SessionRecord => ({
  cookies: { erpk: 'abc', erpk_rm: 'rm', erpk_mid: 'mid' },
  email: 'bot@example.com',
  savedAt: new Date('2026-05-01T10:00:00Z').toISOString(),
  lastValidatedAt: new Date('2026-05-01T10:05:00Z').toISOString(),
});

describe('PostgresSessionStore', () => {
  beforeEach(() => truncateAll(ctx.pool));

  it('returns null when no session is stored', async () => {
    expect(await make().load()).toBeNull();
  });

  it('save() then load() round-trips a SessionRecord', async () => {
    const rec = sample();
    await make().save(rec);
    const loaded = await make().load();
    expect(loaded).toEqual(rec);
  });

  it('save() upserts (single-row table)', async () => {
    const store = make();
    await store.save(sample());
    await store.save({ ...sample(), email: 'rotated@example.com' });
    const loaded = await store.load();
    expect(loaded?.email).toBe('rotated@example.com');
    const { rows } = await ctx.pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM bot_session`);
    expect(rows[0]!.count).toBe('1');
  });

  it('clear() removes the row', async () => {
    const store = make();
    await store.save(sample());
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it('clear() is a no-op on an empty store', async () => {
    await expect(make().clear()).resolves.toBeUndefined();
  });

  it('load() returns null when the stored row is missing erpk (cache-miss policy from FileSessionStore)', async () => {
    await ctx.pool.query(
      `INSERT INTO bot_session (id, email, cookies, saved_at, last_validated_at)
       VALUES (1, 'bot@example.com', '{"erpk_mid": "x"}'::jsonb, NOW(), NULL)`,
    );
    expect(await make().load()).toBeNull();
  });
});
