import { beforeEach, describe, expect, it } from 'vitest';
import { setupPg, truncateAll } from './_pg.js';
import { HunterRepo } from '../repos/hunters.js';

const ctx = setupPg();
const repo = (): HunterRepo => new HunterRepo(ctx.pool);

describe('HunterRepo', () => {
  beforeEach(() => truncateAll(ctx.pool));

  it('register() inserts a pending row', async () => {
    const row = await repo().register({ telegramId: 100n, username: 'alice' });
    expect(row.telegram_id).toBe('100');
    expect(row.username).toBe('alice');
    expect(row.status).toBe('pending');
    expect(row.registered_at).toBeInstanceOf(Date);
    expect(row.decided_at).toBeNull();
  });

  it('register() is idempotent — re-registering the same id keeps existing status and refreshes username', async () => {
    await repo().register({ telegramId: 100n, username: 'alice' });
    await repo().setStatus({ telegramId: 100n, status: 'active', decidedBy: 1n });

    const again = await repo().register({ telegramId: 100n, username: 'alice2' });
    expect(again.status).toBe('active'); // status preserved
    expect(again.username).toBe('alice2'); // username updated
  });

  it('findByTelegramId() returns null for missing', async () => {
    expect(await repo().findByTelegramId(404n)).toBeNull();
  });

  it('setStatus() updates status, decided_at, decided_by', async () => {
    await repo().register({ telegramId: 100n, username: 'alice' });
    const updated = await repo().setStatus({ telegramId: 100n, status: 'active', decidedBy: 7n });
    expect(updated?.status).toBe('active');
    expect(updated?.decided_by).toBe('7');
    expect(updated?.decided_at).toBeInstanceOf(Date);
  });

  it('setStatus() returns null for unknown hunter', async () => {
    expect(await repo().setStatus({ telegramId: 999n, status: 'active', decidedBy: 1n })).toBeNull();
  });

  it('listByStatus() returns rows in registered_at ASC order', async () => {
    await repo().register({ telegramId: 1n, username: 'a' });
    await new Promise((r) => setTimeout(r, 5)); // distinct timestamps
    await repo().register({ telegramId: 2n, username: 'b' });
    const rows = await repo().listByStatus('pending');
    expect(rows.map((r) => r.telegram_id)).toEqual(['1', '2']);
  });

  it('listAll() returns every hunter', async () => {
    await repo().register({ telegramId: 1n, username: 'a' });
    await repo().register({ telegramId: 2n, username: 'b' });
    const rows = await repo().listAll();
    expect(rows).toHaveLength(2);
  });
});
