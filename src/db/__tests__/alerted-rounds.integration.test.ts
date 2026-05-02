import { beforeEach, describe, expect, it } from 'vitest';
import { setupPg, truncateAll } from './_pg.js';
import { AlertedRoundsRepo } from '../repos/alerted-rounds.js';

const ctx = setupPg();
const repo = (): AlertedRoundsRepo => new AlertedRoundsRepo(ctx.pool);

describe('AlertedRoundsRepo', () => {
  beforeEach(() => truncateAll(ctx.pool));

  it('record() inserts a new row and returns true', async () => {
    const inserted = await repo().record({
      hunterTelegramId: 100n,
      battleId: 869119n,
      zoneId: 7,
    });
    expect(inserted).toBe(true);
  });

  it('record() returns false when the (hunter, battle, zone) is already alerted', async () => {
    const input = { hunterTelegramId: 100n, battleId: 869119n, zoneId: 7 };
    expect(await repo().record(input)).toBe(true);
    expect(await repo().record(input)).toBe(false);
  });

  it('record() distinguishes different hunters / battles / zones', async () => {
    await repo().record({ hunterTelegramId: 100n, battleId: 1n, zoneId: 1 });
    expect(await repo().record({ hunterTelegramId: 200n, battleId: 1n, zoneId: 1 })).toBe(true);
    expect(await repo().record({ hunterTelegramId: 100n, battleId: 2n, zoneId: 1 })).toBe(true);
    expect(await repo().record({ hunterTelegramId: 100n, battleId: 1n, zoneId: 2 })).toBe(true);
  });

  it('loadAllKeys() returns the dedup set in "hunterId|battleId|zoneId" form', async () => {
    await repo().record({ hunterTelegramId: 100n, battleId: 1n, zoneId: 7 });
    await repo().record({ hunterTelegramId: 200n, battleId: 2n, zoneId: 8 });
    const keys = await repo().loadAllKeys();
    expect(new Set(keys)).toEqual(new Set(['100|1|7', '200|2|8']));
  });

  it('pruneOlderThan() deletes rows older than the cutoff and returns the count', async () => {
    await ctx.pool.query(
      `INSERT INTO alerted_rounds (hunter_telegram_id, battle_id, zone_id, alerted_at)
       VALUES ($1, $2, $3, NOW() - INTERVAL '72 hours')`,
      ['100', '1', 7],
    );
    await ctx.pool.query(
      `INSERT INTO alerted_rounds (hunter_telegram_id, battle_id, zone_id, alerted_at)
       VALUES ($1, $2, $3, NOW() - INTERVAL '1 hour')`,
      ['100', '2', 7],
    );
    const removed = await repo().pruneOlderThan({ olderThanHours: 48 });
    expect(removed).toBe(1);
    const keys = await repo().loadAllKeys();
    expect(keys).toEqual(['100|2|7']);
  });
});
