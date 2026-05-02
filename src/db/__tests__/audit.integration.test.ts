import { beforeEach, describe, expect, it } from 'vitest';
import { setupPg, truncateAll } from './_pg.js';
import { AuditRepo } from '../repos/audit.js';

const ctx = setupPg();
const repo = (): AuditRepo => new AuditRepo(ctx.pool);

describe('AuditRepo', () => {
  beforeEach(() => truncateAll(ctx.pool));

  it('append() persists action + actor + optional target ids and metadata', async () => {
    const row = await repo().append({
      actorTelegramId: 1n,
      action: 'approve',
      targetTelegramId: 100n,
      targetVictimId: null,
      metadata: { reason: 'looks legit' },
    });
    expect(row.action).toBe('approve');
    expect(row.actor_telegram_id).toBe('1');
    expect(row.target_telegram_id).toBe('100');
    expect(row.metadata).toEqual({ reason: 'looks legit' });
    expect(row.at).toBeInstanceOf(Date);
  });

  it('append() works with null metadata', async () => {
    const row = await repo().append({
      actorTelegramId: 1n,
      action: 'deny',
      targetTelegramId: 100n,
      targetVictimId: null,
      metadata: null,
    });
    expect(row.metadata).toBeNull();
  });

  it('listForHunter() returns target_telegram_id matches in at DESC order', async () => {
    await repo().append({
      actorTelegramId: 100n,
      action: 'victim_add',
      targetTelegramId: 100n,
      targetVictimId: 5n,
      metadata: { citizen_id: '9744640' },
    });
    await new Promise((r) => setTimeout(r, 5));
    await repo().append({
      actorTelegramId: 100n,
      action: 'victim_remove',
      targetTelegramId: 100n,
      targetVictimId: 5n,
      metadata: { citizen_id: '9744640' },
    });
    await repo().append({
      actorTelegramId: 1n,
      action: 'approve',
      targetTelegramId: 999n,
      targetVictimId: null,
      metadata: null,
    });

    const rows = await repo().listForHunter(100n);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.action).toBe('victim_remove'); // most recent first
    expect(rows[1]!.action).toBe('victim_add');
  });

  it('listForHunter() honors a limit', async () => {
    for (let i = 0; i < 5; i++) {
      await repo().append({
        actorTelegramId: 100n,
        action: 'victim_add',
        targetTelegramId: 100n,
        targetVictimId: BigInt(i),
        metadata: null,
      });
    }
    const rows = await repo().listForHunter(100n, 3);
    expect(rows).toHaveLength(3);
  });
});
